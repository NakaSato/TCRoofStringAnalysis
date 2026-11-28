//! `tcroof-worker`: backend/app/worker.py `main`. One worker process only (several would each
//! run the schedule and multiply Growatt calls); never alongside the Python worker on the same
//! Growatt tokens.
//!
//!     tcroof-worker                 # run the schedule forever
//!     tcroof-worker --once retention   (also: tcroof-worker run retention)
//!     tcroof-worker --list          # schedule + last runs
//!
//! Reads the repo's `.env` like the API (real environment variables win).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tcroof_api::logging::{init_tracing_stderr, DbLog};
use tcroof_api::Settings;
use tcroof_services::sync_status::{run_out, JOBS};
use tcroof_worker::schedule::{default_schedule, tick, TICK_S};
use tcroof_worker::{runs, Ctx, WorkerSettings};

enum Mode {
    Loop,
    Once(String),
    List,
}

fn usage() -> ! {
    eprintln!("usage: tcroof-worker [--once JOB | run JOB | --list]");
    std::process::exit(2);
}

fn parse_args() -> Mode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => Mode::Loop,
        ["--list"] => Mode::List,
        ["--once", job] | ["run", job] => {
            if !JOBS.contains(job) {
                // argparse's `choices` message
                let mut choices: Vec<&str> = JOBS.to_vec();
                choices.sort_unstable();
                eprintln!(
                    "tcroof-worker: error: argument --once: invalid choice: '{job}' (choose from {})",
                    choices.iter().map(|c| format!("'{c}'")).collect::<Vec<_>>().join(", ")
                );
                std::process::exit(2);
            }
            Mode::Once((*job).to_owned())
        }
        [one] if one.starts_with("--once=") => {
            let job = &one["--once=".len()..];
            if !JOBS.contains(&job) {
                usage();
            }
            Mode::Once(job.to_owned())
        }
        _ => usage(),
    }
}

/// Python `str(timedelta)` for the whole-minute intervals of the schedule (`0:10:00`)
fn td(d: chrono::Duration) -> String {
    let s = d.num_seconds();
    format!("{}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
}

/// Python `str(aware datetime)` (`2026-11-27 03:00:00.123456+00:00`)
fn py_dt(t: Option<DateTime<Utc>>) -> String {
    match t {
        None => "None".into(),
        Some(t) if t.timestamp_subsec_micros() == 0 => t.format("%Y-%m-%d %H:%M:%S+00:00").to_string(),
        Some(t) => t.format("%Y-%m-%d %H:%M:%S%.6f+00:00").to_string(),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mode = parse_args();
    for p in [".env", "../.env"] {
        if dotenvy::from_filename(p).is_ok() {
            break;
        }
    }
    let settings = Settings::from_env()?;
    let worker = WorkerSettings::from_env()?;
    let pool = tcroof_db::connect(&settings.database_url, 10).await.map_err(anyhow::Error::msg)?;
    // Python `setup_logging("worker")`: console + app_logs (the schema is Python's: no ensure_schema)
    let logs = DbLog::from_settings("worker", &settings, pool.clone());
    init_tracing_stderr(logs.clone());
    let flusher = logs.as_ref().map(|l| l.spawn_flusher(Duration::from_secs_f64(settings.log_flush_interval_s.max(0.1))));

    // Python `main`: `remove_blocked_plants` here, so a newly blocked plant leaves the registry
    // now, not at the next `fleet` run
    tcroof_services::growatt_sync::remove_blocked_plants(&pool, &settings.blocked_plant_ids())
        .await
        .map_err(|e| anyhow::anyhow!("{}", tcroof_worker::JobError::from(e)))?;
    let ctx = Ctx::new(pool.clone(), settings.clone(), worker.clone());
    let schedule = default_schedule(&worker);

    let code = match mode {
        Mode::List => {
            for s in &schedule {
                let when = match (s.every, s.at) {
                    (Some(e), _) => format!("every {}", td(e)),
                    (None, Some(at)) => {
                        let days = match &s.weekdays {
                            None => "daily".to_owned(),
                            Some(d) => d
                                .iter()
                                .map(|&i| ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i as usize])
                                .collect::<Vec<_>>()
                                .join(","),
                        };
                        format!("{days} {}", at.format("%H:%M"))
                    }
                    (None, None) => String::new(),
                };
                println!("{:18} {:22} last start: {}", s.job, when, py_dt(runs::last_started(&pool, s.job).await?));
            }
            0
        }
        Mode::Once(job) => match runs::run_job(&ctx, &job, "cli").await {
            Ok(run) => {
                println!("{}", run_out(&run));
                if run.status == "ok" {
                    0
                } else {
                    1
                }
            }
            Err(e) => {
                tracing::error!(target: "worker", "{job}: {e}");
                1
            }
        },
        Mode::Loop => {
            let stop = Arc::new(AtomicBool::new(false));
            {
                let stop = stop.clone();
                tokio::spawn(async move {
                    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => {}
                        _ = async { match term.as_mut() { Some(t) => { t.recv().await; } None => std::future::pending::<()>().await } } => {}
                    }
                    stop.store(true, Ordering::SeqCst);
                });
            }
            tracing::info!(target: "worker", "worker started; publish sink={}", settings.publish_sink);
            let abandoned = runs::fail_abandoned(&pool, None).await?;
            if !abandoned.is_empty() {
                tracing::warn!(target: "worker", "marked runs {:?} abandoned (left running by the previous worker)", abandoned);
            }
            while !stop.load(Ordering::SeqCst) {
                tick(&ctx, &schedule, Utc::now()).await?;
                for _ in 0..TICK_S {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
            tracing::info!(target: "worker", "worker stopped");
            0
        }
    };
    // Python's atexit flush: one last flush, even inside the pause after a failure. It runs before
    // the background flusher is stopped: a flush it started (an ERROR wakes it) has already taken
    // its records from the buffer, and aborting it mid-insert lost them; the final flush waits for
    // it (flush lock), then writes the rest.
    if let Some(l) = &logs {
        l.flush(true).await;
    }
    if let Some(f) = flusher {
        f.abort();
    }
    std::process::exit(code);
}
