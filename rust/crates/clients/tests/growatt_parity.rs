//! Parity of the Growatt port (`tcroof_clients::growatt`) with `backend/solar_core/growatt/`.
//!
//! The fixtures are what Python answered (`tests/fixtures/growatt_gen.py`, run from the repo root
//! with `PYTHONPATH=backend uv run python rust/crates/clients/tests/fixtures/growatt_gen.py`):
//! - `growatt_scalars.json`: the helpers (`_f`, `_text`, `_nonzero_int`, time parsing, `round`,
//!   `_snippet`, `growatt_error_text`, `date.fromisoformat`);
//! - `growatt_parsers.json`: every parser on realistic records and edge cases;
//! - `growatt_client.json`: client methods run against a scripted fake HTTP session. Here the
//!   same replies are served by a local HTTP stub (tokio `TcpListener`), and the requests the
//!   Rust client sends (method, path, query, form body, `token` header) must equal the ones
//!   Python sent, and the results / errors must equal Python's.
//!
//! Floats compare to 1e-6. A non-finite float Python returned (`{"__float": "nan"}`) must be
//! `null` after serde (serde_json writes NaN / ±inf as null).

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{NaiveDate, NaiveDateTime};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tcroof_clients::growatt::py::{self, PyValue, TimeFormat};
use tcroof_clients::growatt::{self as g, GrowattClient, GrowattClientOptions, GrowattError};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/");

fn load<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let text =
        std::fs::read_to_string(format!("{FIX}{name}")).unwrap_or_else(|e| panic!("{name}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"))
}

// --------------------------------------------------------------------------- comparison

fn special_float(v: &Value) -> Option<f64> {
    let o = v.as_object()?;
    if o.len() != 1 {
        return None;
    }
    match o.get("__float")?.as_str()? {
        "nan" => Some(f64::NAN),
        "inf" => Some(f64::INFINITY),
        "-inf" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-6 * a.abs().max(b.abs()).max(1.0)
}

fn assert_json(expected: &Value, actual: &Value, ctx: &str) {
    if special_float(expected).is_some() {
        assert!(
            actual.is_null(),
            "{ctx}: expected non-finite float (null after serde), got {actual}"
        );
        return;
    }
    match (expected, actual) {
        (Value::Number(a), Value::Number(b)) => {
            assert!(
                close(a.as_f64().unwrap(), b.as_f64().unwrap()),
                "{ctx}: {a} != {b}"
            );
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(
                a.len(),
                b.len(),
                "{ctx}: length\nexpected {expected}\nactual   {actual}"
            );
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                assert_json(x, y, &format!("{ctx}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            let ka: Vec<_> = a.keys().collect();
            let kb: Vec<_> = b.keys().collect();
            assert_eq!(
                ka, kb,
                "{ctx}: keys\nexpected {expected}\nactual   {actual}"
            );
            for (k, x) in a {
                assert_json(x, &b[k], &format!("{ctx}.{k}"));
            }
        }
        _ => assert_eq!(expected, actual, "{ctx}"),
    }
}

fn assert_float(expected: &Value, actual: Option<f64>, ctx: &str) {
    match (special_float(expected), expected.as_f64(), actual) {
        (Some(e), _, Some(a)) if e.is_nan() => assert!(a.is_nan(), "{ctx}: expected nan, got {a}"),
        (Some(e), _, Some(a)) => assert_eq!(e, a, "{ctx}"),
        (None, Some(e), Some(a)) => {
            assert!(close(e, a), "{ctx}: {e} != {a}");
            assert_eq!(
                e.is_sign_negative(),
                a.is_sign_negative(),
                "{ctx}: sign of {e} vs {a}"
            );
        }
        (None, None, None) if expected.is_null() => {}
        _ => panic!("{ctx}: expected {expected}, got {actual:?}"),
    }
}

fn iso(dt: Option<NaiveDateTime>) -> Value {
    dt.map_or(Value::Null, |d| {
        Value::String(d.format("%Y-%m-%dT%H:%M:%S").to_string())
    })
}

/// The `ok` value of a Python result, or `None` when Python raised.
fn ok(out: &Value) -> Option<&Value> {
    out.get("ok")
}

// --------------------------------------------------------------------------- scalars

#[derive(Deserialize)]
struct ScalarCase {
    #[serde(rename = "in")]
    input: PyValue,
    out: Value,
    n: Option<usize>,
}

#[test]
fn scalars_match_python() {
    let groups: BTreeMap<String, Vec<ScalarCase>> = load("growatt_scalars.json");
    let mut checked = 0;
    for (group, cases) in &groups {
        for (i, c) in cases.iter().enumerate() {
            let ctx = format!("{group}[{i}] in={:?}", c.input);
            let v = Value::from(&c.input);
            match group.as_str() {
                "f" => assert_float(ok(&c.out).unwrap(), g::f(&v), &ctx),
                "text" => assert_json(ok(&c.out).unwrap(), &json!(g::text(&v)), &ctx),
                "nonzero_int" => match (ok(&c.out), g::nonzero_int(&v)) {
                    (Some(e), Ok(a)) => assert_json(e, &json!(a), &ctx),
                    (None, Err(_)) => {}
                    // a code beyond 64 bits: Python's int is unbounded, the port refuses it
                    (Some(e), Err(err)) if e.as_f64().is_some_and(|f| f.abs() >= 9.2e18) => {
                        assert!(err.0.contains("beyond 64 bits"), "{ctx}: {err}");
                    }
                    (e, a) => panic!("{ctx}: python {e:?} rust {a:?}"),
                },
                "env_time" | "record_time" => {
                    let key = if group == "env_time" {
                        "timeText"
                    } else {
                        "time"
                    };
                    let mut r = Map::new();
                    if c.input != PyValue::Str("__missing__".into()) {
                        r.insert(key.into(), v.clone());
                    }
                    let got = if group == "env_time" {
                        g::env_time(&r)
                    } else {
                        g::record_time(&r)
                    };
                    assert_json(ok(&c.out).unwrap(), &iso(got), &ctx);
                }
                "strptime_hm" => {
                    let got = py::strptime(v.as_str().unwrap(), TimeFormat::Minutes);
                    match ok(&c.out) {
                        Some(e) => assert_json(e, &iso(got), &ctx),
                        None => assert!(got.is_none(), "{ctx}: python raised, rust {got:?}"),
                    }
                }
                "fromisoformat" => {
                    let s = v.as_str().unwrap();
                    let got = py::date_fromisoformat(py::head(s, 10));
                    match ok(&c.out) {
                        Some(e) => assert_json(e, &json!(got.map(|d| d.to_string())), &ctx),
                        None => assert!(
                            got.is_none(),
                            "{ctx}: python raised {}, rust {got:?}",
                            c.out
                        ),
                    }
                }
                "round" => {
                    let got = py::round(v.as_f64().unwrap(), c.n.unwrap());
                    assert_eq!(c.out.as_f64().unwrap(), got, "{ctx} n={:?}", c.n);
                }
                "round_h" => assert_float(ok(&c.out).unwrap(), g::round_h(g::f(&v)), &ctx),
                "snippet" => assert_json(ok(&c.out).unwrap(), &json!(g::snippet(&c.input)), &ctx),
                "error_text" => {
                    let PyValue::Dict(items) = &c.input else {
                        panic!("{ctx}: not a dict")
                    };
                    assert_json(
                        ok(&c.out).unwrap(),
                        &json!(g::growatt_error_text(items)),
                        &ctx,
                    );
                }
                other => panic!("unknown scalar group {other}"),
            }
            checked += 1;
        }
    }
    assert!(checked > 500, "only {checked} scalar cases");
}

// --------------------------------------------------------------------------- parsers

#[derive(Deserialize)]
struct ParserCase {
    args: Map<String, Value>,
    out: Value,
}

fn run_parser(name: &str, a: &Map<String, Value>) -> Result<Value, String> {
    let s = |k: &str| a[k].as_str().unwrap().to_owned();
    let recs = || a["records"].as_array().unwrap().clone();
    let obj = |k: &str| a[k].as_object().unwrap().clone();
    let u = |k: &str, d: u32| a.get(k).and_then(Value::as_u64).map_or(d, |v| v as u32);
    let to = |r: Result<Value, py::PyError>| r.map_err(|e| e.0);
    match name {
        "parse_env_records" => {
            to(
                g::parse_env_records(&s("datalogger_sn"), a["address"].as_i64().unwrap(), &recs())
                    .map(|r| json!(r)),
            )
        }
        "parse_meter_records" => to(g::parse_meter_records(
            &s("datalogger_sn"),
            a["address"].as_i64().unwrap(),
            &recs(),
        )
        .map(|r| json!(r))),
        "parse_max_info" => to(g::parse_max_info(&obj("m")).map(|r| json!(r))),
        "parse_max_grid" => Ok(json!(g::parse_max_grid(&obj("r")))),
        "parse_max_diagnostics" => to(g::parse_max_diagnostics(&obj("r")).map(|r| json!(r))),
        "parse_max_mppt_energy" => Ok(json!(g::parse_max_mppt_energy(
            &obj("r"),
            u("max_mppts", 16)
        ))),
        "parse_max_raw" => to(g::parse_max_raw(&s("device_sn"), &recs()).map(|r| json!(r))),
        "parse_max_records" => to(g::parse_max_records(
            &s("device_sn"),
            &recs(),
            u("max_strings", 32),
            u("max_mppts", 16),
        )
        .map(|r| json!(r))),
        other => panic!("unknown parser {other}"),
    }
}

#[test]
fn parsers_match_python() {
    let groups: BTreeMap<String, Vec<ParserCase>> = load("growatt_parsers.json");
    let mut checked = 0;
    for (name, cases) in &groups {
        for (i, c) in cases.iter().enumerate() {
            let ctx = format!("{name}[{i}]");
            match (ok(&c.out), run_parser(name, &c.args)) {
                (Some(e), Ok(a)) => assert_json(e, &a, &ctx),
                (None, Err(_)) => {}
                (e, a) => panic!(
                    "{ctx}: python {:?} / {e:?}, rust {a:?}",
                    c.out.get("message")
                ),
            }
            checked += 1;
        }
    }
    assert!(checked >= 50, "only {checked} parser cases");
}

// --------------------------------------------------------------------------- HTTP stub

/// One scripted reply, written as Python's JSON text (key order kept: it shows in error texts).
struct Reply {
    status: u16,
    body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
struct Seen {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    form: Option<Vec<(String, String)>>,
    token: Option<String>,
}

fn json_text(v: &PyValue) -> String {
    match v {
        PyValue::Null => "null".into(),
        PyValue::Bool(b) => b.to_string(),
        PyValue::Int(i) => i.to_string(),
        PyValue::UInt(u) => u.to_string(),
        PyValue::Float(f) => serde_json::to_string(f).unwrap(),
        PyValue::Str(s) => serde_json::to_string(s).unwrap(),
        PyValue::List(a) => format!(
            "[{}]",
            a.iter().map(json_text).collect::<Vec<_>>().join(",")
        ),
        PyValue::Dict(d) => format!(
            "{{{}}}",
            d.iter()
                .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), json_text(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap();
                out.push(u8::from_str_radix(hex, 16).unwrap());
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8(out).unwrap()
}

fn pairs(s: &str) -> Vec<(String, String)> {
    s.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect()
}

struct Stub {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    left: Arc<Mutex<VecDeque<Reply>>>,
}

async fn stub(replies: Vec<Reply>) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let left = Arc::new(Mutex::new(VecDeque::from(replies)));
    let (seen2, left2) = (seen.clone(), left.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let (seen, left) = (seen2.clone(), left2.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.split("\r\n");
                let mut first = lines.next().unwrap().split(' ');
                let method = first.next().unwrap().to_owned();
                let target = first.next().unwrap().to_owned();
                let mut headers = BTreeMap::new();
                for l in lines.filter(|l| !l.is_empty()) {
                    let (k, v) = l.split_once(':').unwrap();
                    headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
                }
                let len: usize = headers
                    .get("content-length")
                    .map_or(0, |v| v.parse().unwrap());
                while buf.len() < head_end + len {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body = String::from_utf8_lossy(&buf[head_end..head_end + len]).to_string();
                let (path, query) = target.split_once('?').unwrap_or((&target, ""));
                let form = headers
                    .get("content-type")
                    .filter(|c| c.starts_with("application/x-www-form-urlencoded"))
                    .map(|_| pairs(&body));
                seen.lock().unwrap().push(Seen {
                    method,
                    path: path.strip_prefix("/v1/").unwrap_or(path).to_owned(),
                    query: pairs(query),
                    form,
                    token: headers.get("token").cloned(),
                });
                let reply = left.lock().unwrap().pop_front().unwrap_or(Reply {
                    status: 599,
                    body: b"{}".to_vec(),
                });
                let head = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.status,
                    reply.body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&reply.body).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    Stub {
        base: format!("http://{addr}/v1/"),
        seen,
        left,
    }
}

// --------------------------------------------------------------------------- client cases

#[derive(Deserialize)]
struct ClientFile {
    cases: Vec<ClientCase>,
}

#[derive(Deserialize)]
struct ClientCase {
    name: String,
    opts: Map<String, Value>,
    replies: Vec<ReplySpec>,
    calls: Vec<Call>,
    requests: Vec<Value>,
}

#[derive(Deserialize)]
struct ReplySpec {
    status: Option<u16>,
    body: Option<PyValue>,
    raw: Option<String>,
}

#[derive(Deserialize)]
struct Call {
    method: String,
    args: Vec<Value>,
    kwargs: Map<String, Value>,
    result: Value,
}

fn date(v: &Value) -> NaiveDate {
    NaiveDate::parse_from_str(v.as_str().unwrap(), "%Y-%m-%d").unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

async fn dispatch(c: &GrowattClient, call: &Call) -> Result<Value, GrowattError> {
    let a = &call.args;
    let kw = &call.kwargs;
    let s = |i: usize| a[i].as_str().unwrap().to_owned();
    let i = |i: usize| a[i].as_i64().unwrap();
    let refresh = kw.get("refresh").and_then(Value::as_bool).unwrap_or(false);
    let kwu = |k: &str, d: u32| kw.get(k).and_then(Value::as_u64).map_or(d, |v| v as u32);
    let stop = kw
        .get("stop_before")
        .and_then(Value::as_str)
        .map(|t| NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S").unwrap());
    let v = |r: Result<_, GrowattError>| r.map(|x: Value| x);
    macro_rules! j {
        ($e:expr) => {
            $e.await.map(|r| json!(r))
        };
    }
    v(match call.method.as_str() {
        "list_plants" => j!(c.list_plants(refresh)),
        "plant_data" => j!(c.plant_data(i(0))),
        "list_devices" => j!(c.list_devices(i(0), refresh)),
        "list_inverters" => j!(c.list_inverters(i(0), refresh)),
        "max_info" => j!(c.max_info(&s(0))),
        "read_power" => j!(c.read_power(&s(0))),
        "device_info" => j!(c.device_info(&s(0))),
        "device_last_record" => j!(c.device_last_record(&s(0))),
        "account_create_times" => j!(c.account_create_times(kwu("max_pages", 20))),
        "device_info_param" => j!(c.device_info_param(&s(0))),
        "plant_energy_days" => j!(c.plant_energy_days(i(0), date(&a[1]), date(&a[2]))),
        "plant_power_day" => j!(c.plant_power_day(i(0), date(&a[1]))),
        "inverter_day_energy" => j!(c.inverter_day_energy(&s(0), date(&a[1]))),
        "plant_details" => j!(c.plant_details(i(0))),
        "maxs_latest" => j!(c.maxs_latest(&strings(&a[0]), kwu("max_pages", 10))),
        "max_history" => j!(c.max_history(&s(0), date(&a[1]), date(&a[2]), stop)),
        "newest_max_records" => {
            j!(g::newest_max_records(
                c,
                &s(0),
                date(&a[1]),
                kw.get("n").and_then(Value::as_u64).unwrap_or(1) as usize
            ))
        }
        "max_history_batch" => j!(c.max_history_batch(&strings(&a[0]), date(&a[1]))),
        "max_history_day" => j!(c.max_history_day(&s(0), date(&a[1]))),
        "max_last_record" => j!(c.max_last_record(&s(0))),
        "device_datalogger" => j!(c.device_datalogger(&s(0))),
        "list_dataloggers" => j!(c.list_dataloggers(i(0))),
        "devices_create_time" => j!(c.devices_create_time(&strings(&a[0]), kwu("max_pages", 10))),
        "list_env_sensors" => j!(c.list_env_sensors(&s(0), refresh)),
        "env_history" => j!(c.env_history(&s(0), i(1), date(&a[2]), date(&a[3]), stop)),
        "env_latest" => j!(c.env_latest(&s(0), i(1))),
        "list_meters" => j!(c.list_meters(&s(0), refresh)),
        "meter_latest" => j!(c.meter_latest(&s(0), i(1))),
        "meter_history" => j!(c.meter_history(&s(0), i(1), date(&a[2]), date(&a[3]), stop)),
        "max_alarms" => j!(c.max_alarms(
            &s(0),
            date(&a[1]),
            kwu("perpage", 100),
            kwu("max_pages", 10)
        )),
        other => panic!("unknown client method {other}"),
    })
}

fn check_error(ctx: &str, py: &Value, rust: &GrowattError) {
    let kind = py["error"].as_str().unwrap();
    let msg = py["message"].as_str().unwrap();
    match kind {
        "GrowattAPIError" => {
            let GrowattError::Api(e) = rust else {
                panic!("{ctx}: python GrowattAPIError {msg:?}, rust {rust:?}")
            };
            if let Some((head, _)) = msg
                .split_once(" failed: ")
                .filter(|_| msg.starts_with("Growatt request "))
            {
                // transport / HTTP / JSON failures: the library's own text after the prefix
                assert!(
                    e.message.starts_with(&format!("{head} failed: ")),
                    "{ctx}: {:?} vs {msg:?}",
                    e.message
                );
            } else {
                assert_eq!(e.message, msg, "{ctx}");
            }
            assert_eq!(
                e.error_code.clone().unwrap_or(Value::Null),
                py["error_code"],
                "{ctx}: error_code"
            );
        }
        "ValueError" if msg.contains("must not exceed") => {
            assert_eq!(
                rust,
                &GrowattError::InvalidArgument(msg.to_owned()),
                "{ctx}"
            );
        }
        _ => assert!(
            matches!(rust, GrowattError::Unexpected(_)),
            "{ctx}: python {kind} {msg:?}, rust {rust:?}"
        ),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_matches_python_against_http_stub() {
    let file: ClientFile = load("growatt_client.json");
    assert!(
        file.cases.len() >= 50,
        "only {} client cases",
        file.cases.len()
    );
    for case in &file.cases {
        let replies = case
            .replies
            .iter()
            .map(|r| Reply {
                status: r.status.unwrap_or(200),
                body: match (&r.raw, &r.body) {
                    (Some(raw), _) => raw.clone().into_bytes(),
                    (None, Some(b)) => json_text(b).into_bytes(),
                    (None, None) => b"null".to_vec(),
                },
            })
            .collect();
        let stub = stub(replies).await;
        let opts = GrowattClientOptions {
            base_url: stub.base.clone(),
            timeout: Duration::from_secs(5),
            cache_ttl: Duration::from_secs_f64(
                case.opts
                    .get("cache_ttl_s")
                    .and_then(Value::as_f64)
                    .unwrap_or(300.0),
            ),
            blocked_plant_ids: case
                .opts
                .get("blocked_plant_ids")
                .map(|v| {
                    v.as_array()
                        .unwrap()
                        .iter()
                        .map(|i| i.as_i64().unwrap())
                        .collect()
                })
                .unwrap_or_default(),
        };
        let client = GrowattClient::new("tok-secret", opts).unwrap();
        for (k, call) in case.calls.iter().enumerate() {
            let ctx = format!(
                "{} call {k} {}({:?}, {:?})",
                case.name, call.method, call.args, call.kwargs
            );
            let got = dispatch(&client, call).await;
            match (ok(&call.result), &got) {
                (Some(e), Ok(a)) => assert_json(e, a, &ctx),
                (None, Err(err)) => check_error(&ctx, &call.result, err),
                (e, a) => panic!("{ctx}: python {} / {e:?}, rust {a:?}", call.result),
            }
        }
        let seen = stub.seen.lock().unwrap().clone();
        let expected: Vec<Seen> = case
            .requests
            .iter()
            .map(|r| {
                let pv = |v: &Value| -> Vec<(String, String)> {
                    v.as_array()
                        .unwrap()
                        .iter()
                        .map(|p| {
                            (
                                p[0].as_str().unwrap().to_owned(),
                                p[1].as_str().unwrap().to_owned(),
                            )
                        })
                        .collect()
                };
                Seen {
                    method: r["method"].as_str().unwrap().to_owned(),
                    path: r["path"].as_str().unwrap().to_owned(),
                    query: pv(&r["query"]),
                    form: (!r["form"].is_null()).then(|| pv(&r["form"])),
                    token: Some("tok-secret".into()),
                }
            })
            .collect();
        assert_eq!(seen, expected, "{}: requests", case.name);
        assert!(
            stub.left.lock().unwrap().is_empty(),
            "{}: replies left over",
            case.name
        );
    }
}

// --------------------------------------------------------------------------- client unit checks

#[test]
fn empty_token_is_refused_and_debug_hides_the_token() {
    let err = GrowattClient::new("", GrowattClientOptions::default()).unwrap_err();
    assert_eq!(
        err.to_string(),
        "Growatt API token is not configured (set GROWATT_API_TOKEN in .env)."
    );
    let c = GrowattClient::new("super-secret-token", GrowattClientOptions::default()).unwrap();
    assert!(!format!("{c:?}").contains("super-secret-token"));
    assert_eq!(c.base_url(), "https://openapi.growatt.com/v1/");
    let c = GrowattClient::new(
        "t",
        GrowattClientOptions {
            base_url: "http://x/v1".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(c.base_url(), "http://x/v1/");
}

#[tokio::test]
async fn rate_limit_code_is_exposed() {
    let stub = stub(vec![Reply {
        status: 200,
        body: br#"{"error_code":10012,"error_msg":"error_frequently_access"}"#.to_vec(),
    }])
    .await;
    let c = GrowattClient::new(
        "t",
        GrowattClientOptions {
            base_url: stub.base.clone(),
            ..Default::default()
        },
    )
    .unwrap();
    let err = c.list_plants(true).await.unwrap_err();
    assert!(err.is_rate_limited());
    assert_eq!(err.api().unwrap().code(), Some(10012));
    assert_eq!(
        err.to_string(),
        "Growatt plant/list error 10012: error_frequently_access"
    );
}

#[tokio::test]
async fn unreachable_host_is_a_request_failure() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let c = GrowattClient::new(
        "t",
        GrowattClientOptions {
            base_url: format!("http://{addr}/v1/"),
            ..Default::default()
        },
    )
    .unwrap();
    let err = c.plant_data(1).await.unwrap_err();
    let api = err.api().unwrap();
    assert!(
        api.message
            .starts_with("Growatt request plant/data failed: "),
        "{}",
        api.message
    );
    assert_eq!(api.error_code, None);
}
