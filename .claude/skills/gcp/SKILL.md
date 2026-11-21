---
name: gcp
description: 'Check and operate TC Roof Solar''s production on GCP (project tcroof-string-analysis): status and cost vs deploy/gcp.config, the ฿1,000 budget and cost guard, deploys (backend, frontend, upsize, monitoring, costguard), backups and cleanup. Use for "check GCP", "GCP cost", "deploy", "is the cost guard working", snapshots, or changing the budget / sizing.'
---

# GCP operations: TC Roof Solar

Production runs in project `tcroof-string-analysis` (us-central1). **`deploy/gcp.config` is the source of truth** for sizing and cost settings; `deploy/gcp.sh` applies it. Costs, sizing and the reasons behind them: `docs/plans/gcp-production.md`. The architecture summary is in the root `CLAUDE.md` (Deploy section).

## 1. Status / cost check (read-only, always safe)

```bash
.claude/skills/gcp/status.sh
```

It compares the live VM, disk, Cloud Run, budget and cost guard with `gcp.config` (prints `MISMATCH` when they differ), lists backups, unattached disks, alerts, app health, and the month's spend.

How to read it:
- **Spend** comes from the budget messages the cost guard logs (`jsonPayload.cost`). There is no BigQuery billing export, so this is the only spend figure on the CLI; it lags several hours. A per-service breakdown is in Console → Billing → Reports.
- Guard log entries with budget `TEST*` are hand-sent test messages, not spend.
- `MANUAL` snapshots and unattached disks are never cleaned up automatically. They cost money until deleted.
- `MISMATCH` means the config was changed but not applied (or changed by hand in the console). Fix with the matching command below; don't edit resources in the console.

Report the result as a short table (item | config | live | status), then the spend against the budget and the guard's trip point.

## 2. Commands (`deploy/gcp.sh <cmd>`, from the repo root)

| Command | What it does | Downtime / risk |
|---|---|---|
| `backend` | Cloud Build image, updates VM `.env` (Postgres memory for the machine type) and restarts Postgres + worker, deploys Cloud Run | Worker restarts (~20 s); an interrupted job is retried |
| `frontend` | `bun` build, Firebase Hosting | none |
| `all` | backend + frontend | as above |
| `costguard` | budget `tcroof-monthly` = `BUDGET_AMOUNT`, Pub/Sub, function `tcroof-cost-guard` (CAP_PCT, DRY_RUN) | none; takes ~3 min |
| `monitoring` | email channel, uptime checks, 3 alert policies, Ops Agent | none; existing policies are skipped (delete one in the console to change it) |
| `upsize` | VM to `MACHINE_TYPE`, disk to `DISK_TYPE` (snapshot → new disk → swap) | **VM stopped ~15 min.** Run in 21:30–23:00 Bangkok. Leaves the old disk and an `upsize` snapshot to delete after a week |
| `snapshots` | weekly snapshot policy `tcroof-db-weekly` (Sun 02:00 Bangkok, kept 28 days) | none |
| `ip` | promotes the VM's external IP to static | none |

Long commands (`backend`, `costguard`, `upsize`) exceed 2 min: run them in the background and wait for the notification. `backend` and `upsize` restart production; `upsize`, deletes and budget changes need the user's go-ahead in the current conversation.

After any deploy, run `status.sh` again and confirm `/api/health` and `/api/health/worker` return 200.

## 3. Changing cost or sizing

1. Edit `deploy/gcp.config` (keep its comments' ฿ figures right) and the matching text in `docs/plans/gcp-production.md` (cost table, §4 thresholds) and root `CLAUDE.md`.
2. Apply: budget / cap → `costguard`; Cloud Run min instances → `backend`; machine or disk → `upsize` then `backend`.
3. Check: `status.sh` shows no `MISMATCH`.
4. Commit on a branch, PR, merge (the user merges to `main` and deletes the branch).

Keep planned monthly spend at least ~฿150 below the trip point (`BUDGET × COST_CAP_PCT`). Billing data arrives about a day late, so a plan that equals the budget gets cut off near the end of the month. Current plan: budget ฿1,000, trip ฿960, planned ≈ ฿2,566 (Cloud Run min 0). The plan is over the trip point on purpose (user decision 2026-11-21): expect the guard to disable billing partway through each month.

## 4. Backups and cleanup

- Manual snapshot before risky work:
  `gcloud compute disks snapshot <boot disk> --zone us-central1-a --project tcroof-string-analysis --snapshot-names tcroof-db-manual-$(date -u +%Y%m%d%H%M) --storage-location us-central1`
  (the boot disk name changes after an upsize; `status.sh` prints it).
- Delete a manual snapshot once a newer weekly one exists. Delete an old disk only after checking that it has no `users` (unattached).
- Restore steps are in the comment above `cmd_snapshots` in `deploy/gcp.sh`.

## 5. If the cost guard tripped

Billing is unlinked: everything stops; disks and snapshots are kept. With the user's approval:
```bash
gcloud billing projects link tcroof-string-analysis --billing-account 01713D-DBF4DB-A25EDB
gcloud compute instances start tcroof-db --zone us-central1-a --project tcroof-string-analysis
```
Then find out why spend ran over (Billing → Reports) before the next month.

## 6. Things to know

- Billing account is self-serve (pay-as-you-go), THB. Whether it is still on the Free Trial isn't visible from the CLI (Console → Billing → Overview); a trial stops resources when its credit ends.
- The budget counts cost after credits (`INCLUDE_ALL_CREDITS`).
- Google Weather has its own quotas inside the app (`GOOGLE_WEATHER_*` in `.env`), not in this budget's control.
- Firestore is on the free Spark quota; writes are capped by `PUBLISH_DAILY_WRITE_BUDGET`.
