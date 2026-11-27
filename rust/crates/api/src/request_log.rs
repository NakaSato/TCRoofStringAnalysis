//! Request middleware for System → Logs (backend/app/api/request_log.py `install.request_log`).
//!
//! Sets a request id (task-local `REQUEST_ID` + `X-Request-ID` header), logs only what matters
//! (an unhandled error as ERROR, other 5xx as WARNING, requests slower than `LOG_SLOW_REQUEST_MS`
//! as WARNING, `/growatt/live/*` as INFO) under the logger `app.api.request`, and flushes the DB log
//! buffer before the response is returned. Ordinary 2xx / 4xx requests are not logged.

use std::time::Instant;

use axum::extract::{MatchedPath, Request, State};
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;

use crate::auth::token_hex;
use crate::error::Unhandled;
use crate::logging::REQUEST_ID;
use crate::AppState;

/// Python `UPSTREAM_PREFIXES`: realtime routes whose slowness is the upstream's
const UPSTREAM_PREFIXES: &[&str] = &["/growatt/live/"];

/// The matched route template, carried from `capture_route` (inside the router) to `request_log`.
#[derive(Clone)]
struct RouteTemplate(String);

/// `route_layer` on the routes: copies the template (`/api/users/{user_id}`) to the response,
/// as Python reads `request.scope["route"].path` (no ids in the log text).
pub async fn capture_route(req: Request, next: Next) -> Response {
    let tpl = req.extensions().get::<MatchedPath>().map(|m| m.as_str().to_owned());
    let mut res = next.run(req).await;
    if let Some(t) = tpl {
        res.extensions_mut().insert(RouteTemplate(t));
    }
    res
}

pub async fn request_log(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let rid = token_hex(8); // Python uuid4().hex[:16]
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let slow_ms = st.settings.log_slow_request_ms as f64;
    let t0 = Instant::now();
    let mut res = REQUEST_ID
        .scope(rid.clone(), async move {
            let res = next.run(req).await;
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            let route = res.extensions().get::<RouteTemplate>().map(|r| r.0.clone()).unwrap_or(path);
            let status = res.status().as_u16();
            if let Some(Unhandled(e)) = res.extensions().get::<Unhandled>() {
                tracing::error!(target: "app.api.request", exc_text = %e, "{method} {route} failed: unhandled exception");
            } else if status >= 500 {
                tracing::warn!(target: "app.api.request", "{method} {route} answered {status} in {ms:.0} ms");
            } else if ms > slow_ms {
                if UPSTREAM_PREFIXES.iter().any(|p| route.starts_with(p)) {
                    tracing::info!(target: "app.api.request",
                        "{method} {route} slow: {ms:.0} ms (status {status}) · waited on Growatt / Google (live cache refresh)");
                } else {
                    tracing::warn!(target: "app.api.request", "{method} {route} slow: {ms:.0} ms (status {status})");
                }
            }
            res
        })
        .await;
    // Python's header is set on every answered response (an unhandled exception never gets one;
    // here that is a 500 the handler answered, so it does)
    if let Ok(v) = HeaderValue::from_str(&rid) {
        res.headers_mut().insert("x-request-id", v);
    }
    if let Some(sink) = &st.logs {
        if sink.pending() > 0 && !sink.waiting() {
            sink.flush(false).await;
        }
    }
    res
}
