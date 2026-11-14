# Plan & Spec: GCP production sizing and the ฿3,000/month cost cap

Status: **Test month from 2026-11-13** (scenario A: API always on, hard stop at 96 %) · Created 2026-11-13 · Owner: Chanthawat

Settings: `deploy/gcp.config` (sourced by `deploy/gcp.sh`).

Move production from the free-tier setup (< $10/month) to the sized setup in the cost table below.
Total spend must stay **under ฿3,000/month** (planned ≈ ฿2,566 ≈ $75.5). The billing account bills in **THB**.

---

## 1. Target cost table

| Item | ฿/month | ฿/year | Type | GCP resource | $/month |
|---|---:|---:|---|---|---:|
| Database server | 1,663 | 19,959 | fixed | VM `tcroof-db` **e2-standard-2** (2 vCPU, 8 GB), us-central1-a | 48.92 |
| 100 GB storage | 340 | 4,080 | fixed | boot disk **pd-balanced** 100 GB | 10.00 |
| Backups | 104 | 1,244 | fixed | weekly disk snapshot, kept 4 weeks; no daily backup (§3.3) | 3.05 |
| Server IP address | 124 | 1,489 | fixed | static external IPv4 on the VM | 3.65 |
| Web and API | 60 | 715 | usage | Cloud Run `tcroof-api`, **min 0** / max 1 instance, 1 vCPU / 1 GiB; use by 10 people, 8 h/day, 22 days/month (min 1 would add the idle instance, ฿447) | 1.76 |
| Internet data transfer | 64 | 771 | usage | egress ≈ 12 GB/month (Firebase Hosting + Cloud Run) | 1.89 |
| Monitoring and alerts | 170 | 2,040 | fixed (maximum) | Cloud Monitoring uptime checks, alert policies, Ops Agent | 5.00 |
| Secrets and program images | 7 | 90 | fixed | Secret Manager + Artifact Registry | 0.22 |
| Company domain | 34 | 408 | fixed | domain (≈ $12/year) on Firebase Hosting, free HTTPS | 1.00 |
| Other free services | 0 | 0 | — | Firestore, Google Weather, Sheets, Cloud Build, Logging: inside free quotas, capped by the app | 0.00 |
| **Total** | **2,566** | **30,797** | | | **75.49** |

All prices are us-central1 list prices, converted at the rate the table uses (≈ 34 THB/USD).
**E2 machines get no sustained-use discount**, so the VM is billed at the full on-demand price for every hour it runs.

### 1.1 BOQ (bill of quantities)

Quantity × unit rate per item, for one month (730 h). Rates are us-central1 list prices in USD; ฿ at 34 THB/USD. Amounts match §1.

| No. | Item | Spec | Qty | Unit | Unit rate (USD) | USD/month | ฿/month |
|---:|---|---|---:|---|---:|---:|---:|
| 1 | Compute VM `tcroof-db` | e2-standard-2 (2 vCPU ≈ $0.02181/h each + 8 GB ≈ $0.00292/GB-h), on demand | 730 | VM-hour | 0.06701 | 48.92 | 1,663 |
| 2 | Boot disk | pd-balanced, us-central1-a | 100 | GB-month | 0.100 | 10.00 | 340 |
| 3 | Disk snapshots | weekly, 4 kept, incremental (ceiling) | 61 | GB-month | 0.050 | 3.05 | 104 |
| 4 | Static external IPv4 | `tcroof-db-ext`, attached to a running VM | 730 | IP-hour | 0.005 | 3.65 | 124 |
| 5 | Cloud Run `tcroof-api` | 1 vCPU / 1 GiB, min 0 / max 1; 10 users × 8 h × 22 days, after the free tier | 1 | lot (usage) | 1.76 | 1.76 | 60 |
| 6 | Internet egress | Firebase Hosting + Cloud Run, gzipped | 12 | GB | ≈ 0.1575 (blended) | 1.89 | 64 |
| 7 | Monitoring and alerts | uptime checks, alert policies, Ops Agent (ceiling) | 1 | lot (max) | 5.00 | 5.00 | 170 |
| 8 | Secret Manager + Artifact Registry | ~10 secrets, 3 newest images kept | 1 | lot | 0.22 | 0.22 | 7 |
| 9 | Company domain | ≈ $12/year, Firebase Hosting, free HTTPS | 1 | month | 1.00 | 1.00 | 34 |
| 10 | Free services | Firestore, Google Weather, Sheets, Cloud Build, Logging, Redis (on the VM), cost-guard function | 1 | lot | 0.00 | 0.00 | 0 |
| | **Total** | | | | | **75.49** | **2,566** |

- **Fixed** (items 1–4, 8, 9): $66.84 ≈ ฿2,272. **Usage / ceiling** (items 5–7): $8.65 ≈ ฿294.
- "lot" lines are estimates, not metered quantities: item 5 depends on how long the instance is busy serving requests, item 7 is the alerting upper bound (§3.5).
- Per year: ≈ $906 ≈ ฿30,797.

## 2. Current state (2026-11-13)

| | Now | Target |
|---|---|---|
| VM | `e2-micro` (free tier), Debian 12 | `e2-standard-2` |
| Disk | 100 GB `pd-standard` | 100 GB `pd-balanced` |
| External IP | ephemeral `35.225.232.58` (premium tier) | the same address promoted to static |
| Snapshots | policy `tcroof-db-daily`, kept 7 days | weekly only, kept 4 weeks (§3.3) |
| Postgres | tuned for 1 GB RAM (`shared_buffers=128MB`) | tuned for 8 GB (§3.2) |
| Cloud Run | `--min-instances 0 --max-instances 1`, 1 vCPU / 1 GiB | unchanged (min 0 keeps the budget under ฿3,000) |
| Monitoring | none (budget email only) | uptime, worker freshness, disk (§3.5) |
| Domain | `tcroof-string-analysis.web.app` | company domain (to be chosen) |
| Budget | ฿500, email only | ฿3,000 with an automatic cap at 96 % = ฿2,880 (§4) |

## 3. Spec per item

### 3.1 VM: e2-standard-2 and pd-balanced
- Change the machine type: stop the VM, run `set-machine-type e2-standard-2`, start it. The disk, the internal IP `tcroof-db-ip` and the external IP stay the same.
- Change the disk type. A Persistent Disk can't change type in place, so:
  1. Take a snapshot.
  2. Create a `pd-balanced` disk from it.
  3. Swap the boot disk while the VM is stopped.
  4. Keep the old disk for 7 days, then delete it.
- **Do both in one maintenance window: 21:30–23:00 Bangkok.** Alarm syncs end at 21:00 and `publish_today` runs at 19:30. Nothing else runs before `alarms_yesterday` at 00:30 and `backfill` at 02:00.
  - The UI keeps working during the window; DB pages answer 5xx for about 15 min.
  - A run cut off by the stop is retried after the restart (#11).
- `deploy/gcp.sh` changes:
  - New variables `MACHINE_TYPE` (default `e2-standard-2`) and `DISK_TYPE` (`pd-balanced`) for new VMs.
  - New command `deploy/gcp.sh upsize` for the steps above. It is idempotent and runs only when the type differs.
  - Drop the "free tier" comments.

### 3.2 Postgres for 8 GB RAM (`deploy/vm/compose.yml`)
```
shared_buffers=2GB  effective_cache_size=5GB  work_mem=16MB
maintenance_work_mem=512MB  max_connections=60  random_page_cost=1.1
```
- The worker keeps about 1 GB. The rest is OS page cache, which is what makes chart and history pages fast.
- `random_page_cost=1.1` suits SSD-backed `pd-balanced`.

### 3.3 Backups
**Weekly only, no daily backup:** one snapshot schedule, every Sunday at 02:00 Bangkok (the current slot, no PV output), kept 4 weeks (28 days). The snapshot is crash-consistent, so it is safe while `backfill` writes: Postgres recovers from its WAL on restore.

- A disk accepts only one snapshot schedule, and one weekly policy fits that.
- Replace policy `tcroof-db-daily` with `tcroof-db-weekly`:
  1. Create the weekly policy.
  2. Detach the daily one from the disk, attach the weekly one, then delete the daily policy.
  3. The existing daily snapshots expire within 7 days; the policy keeps them (`keep-auto-snapshots`).
- `deploy/gcp.sh`: `SNAPSHOT_POLICY=tcroof-db-weekly`, `SNAPSHOT_KEEP_DAYS=28`, `SNAPSHOT_DAY=SUNDAY`; `cmd_snapshots` uses `--weekly-schedule`.
- Cost: at most 4 incremental snapshots, ≤ ฿104/month (the table), likely less.
- **What a weekly backup means for a lost disk:** a restore can be up to 7 days old. Most of the gap can be refilled from Growatt:
  - `max_data` / `env_data` history: `growatt_sync --start … --end …`.
  - The alarm log: the `alarms` job re-reads past days.
  - Google Weather hours older than 24 h can't be fetched again, so up to 6 days of those would be lost. The daily summaries already published to Firestore keep each day's Google weather fields.
  - Users, assignments and string layouts changed since the snapshot are lost.
- Restore steps stay above `cmd_snapshots`. Test one restore to a scratch disk after the move.

### 3.4 Static external IP
- Promote the VM's address in place (`gcloud compute addresses create tcroof-db-ext --addresses 35.225.232.58 --region us-central1`). The address doesn't change, and the cost is the same as an ephemeral IP in use (฿124).
- Why: the worker reaches Growatt and Google from this address. A fixed address can be allow-listed and survives the stop/start in §3.1.
- Cloud Run keeps `--vpc-egress private-ranges-only` and needs no address of its own.

### 3.5 Monitoring and alerts (email within 5 min)

| Alert | How | Fires when |
|---|---|---|
| System down | uptime check `https://<domain>/api/health`, every 5 min from 3 regions | 2 failed checks in a row |
| Data sync failing | uptime check on a new open endpoint `/api/health/worker`: 200 while the last `history` run that ended `ok`/`partial` finished less than 120 min ago (a run takes up to ~1 h), else 503. It returns only `{ok, last_history_at}`, no plant data. | 503 for 10 min |
| Disk almost full | Ops Agent on the VM, `disk/percent_used` for `/` | > 85 % |
| Budget | §4 | 50 / 90 / 100 % |

- One email notification channel; recipients are listed in §6.
- With `min-instances 0` an uptime check can hit a cold start; the check timeout covers it.
- Uptime checks are free (well under 1 M executions/month), and Ops Agent metrics for one VM fit the free ingestion allowance. The table's ฿170 is the upper bound for alerting.

### 3.6 Cloud Run
- `--min-instances 0 --max-instances 1`, `--cpu 1 --memory 1Gi`, CPU allocated only during requests (the default). `API_MIN_INSTANCES=1` would keep one instance warm at the idle rate: 1 vCPU + 1 GiB ≈ $13.1 ≈ ฿447/month, which doesn't fit a ฿3,000 budget.
- `--max-instances 1` is also a cost limit: Cloud Run compute can never exceed one instance.

### 3.7 Domain
- Register the domain (Cloud Domains or the company's registrar, ≈ $12/year) and add it to Firebase Hosting. The certificate is free and renews automatically.
- `/api/**` keeps going to Cloud Run through the `firebase.json` rewrite.
- Add `https://<domain>` to `CORS_ORIGINS` in `cmd_backend`.

### 3.8 Free services stay free (already enforced in code)
- Firestore: `PUBLISH_DAILY_WRITE_BUDGET` (writes stay under the 20k/day free quota).
- Google Weather: `GOOGLE_WEATHER_MONTHLY_BUDGET` (10,000 calls, the whole free tier).
- Artifact Registry: keep only the 3 newest images (cleanup policy).
- Logging: default 30-day retention, far under 50 GiB/month.
- Redis (added 2026-11-13): a container on the existing VM (256 MB of its 8 GB, no persistence), not Memorystore (≈ $36 ≈ ฿1,200/month for the smallest instance, which would pass the cost guard's trip point). Extra cost ฿0; Cloud Run reaches it over the same Direct VPC egress as Postgres.

## 4. Cost cap: never more than ฿3,013/month

A GCP budget **only sends alerts; it does not stop spending by itself**, and billing data arrives with a delay of several hours. The cap therefore has three layers.

### 4.1 Layer 1: limits built into the design
- **Fixed items** (VM, disk, IP, snapshots, idle Cloud Run, domain) are known in advance: about ฿2,890/month.
- **Usage items have ceilings**:
  - Cloud Run `max-instances 1`.
  - The Google Weather budget, the Firestore write budget, the Sheets free quota and the Artifact Registry cleanup policy.
  - Egress is gzipped (#10).

### 4.2 Layer 2: budget and alerts
- Budget `tcroof-monthly` of **฿3,000** on project `tcroof-string-analysis` (2026-11-13; the guard trips at ฿2,880). It replaces the ฿500 budget.
- Email at **50 %, 90 % and 100 %** of actual spend, and at **100 % of forecast spend**.
- The budget also publishes to Pub/Sub topic `tcroof-budget`, which drives layer 3.
- `deploy/gcp.sh` change: `BUDGET_AMOUNT` defaults to `3000THB` and `setup` updates the budget in place.

### 4.3 Layer 3: automatic stop (Cloud Run function `tcroof-cost-guard`)
The function listens to `tcroof-budget` and acts on `costAmount` against the budget amount:

| Spend | Action | Effect |
|---|---|---|
| ≥ 90 % (฿2,700) | Email only (layer 2). | none |
| ≥ **96 % (฿2,880)** | **Disable billing on the project** (Cloud Billing API `updateBillingInfo` with an empty billing account). It triggers at 96 %, not 100 %, so the billing delay (≈ 1 day ≈ ฿100) keeps the month under the ฿3,000 budget. | Everything stops: VM, Cloud Run, Hosting. Disks and snapshots are kept. |

- The function's service account gets `roles/billing.projectManager` on the project, and nothing else.
- To restore after a stop, an admin re-links the billing account (console or `gcloud billing projects link`) and starts the VM. Data is kept.
- The function runs only when a budget message arrives (a few times a day), well inside the free tier.

**Decision (2026-11-13): budget ฿3,000 and Cloud Run `min-instances 0`.** Scaling the API to zero saves the ฿447 idle instance, so planned spend is about ฿2,566 (+ requests while in use), with ≈ ฿310 of headroom under the ฿2,880 trigger. Cost: a cold start of a few seconds on the first request after an idle spell.

**Trade-off (with `min-instances 1` and a ฿3,013 budget):** the fixed items alone are ฿2,889, which is 96 % of the cap. With the table's own totals (฿3,013), spend reaches the ฿2,892 trigger around **day 29**, and the guard **turns the whole system off for the last 1–2 days of the month**. A hard cap at ฿3,013 therefore needs headroom of at least ฿150/month. Pick one or more:
1. Cloud Run `min-instances 1` only from 07:00 to 19:00 (Cloud Scheduler switches it); saves about ฿220/month, with a cold start for the first visit at night.
2. A 1-year committed-use discount on the VM (about −37 %, ≈ −฿600/month). This is a commitment to pay for the year.
3. Weekly-only backups and monitoring will likely cost less than their table maximums (฿104, ฿170), but don't count on it.

## 5. Rollout

1. **PR 1, scripts and config:**
   - `MACHINE_TYPE`, `DISK_TYPE`, `upsize`, Postgres tuning, `--min-instances 1`, the static IP and the weekly snapshot policy.
   - The budget ฿3,013, Pub/Sub, and `tcroof-cost-guard` (new command `deploy/gcp.sh costguard`).
   - Update CLAUDE.md (the "< $10/month" text, VM size, the "Why not Cloud SQL" line).
2. **PR 2, app:** `/api/health/worker`, with tests.
3. **Cost guard first**, before anything costs more, then a dry run with a test Pub/Sub message at 96 % against a scratch project.
4. **Maintenance window** (21:30–23:00): `upsize`, then `deploy/gcp.sh backend`. Check the worker log, `sync_runs`, and the UI.
5. `deploy/gcp.sh monitoring`: uptime checks, Ops Agent and alert policies. Trigger one test alert.
6. Domain: DNS, Firebase Hosting custom domain, CORS.
7. After 7 days, delete the old pd-standard disk. After the first month, compare the bill with §1 per item.

## 6. Open questions
- Company domain name, and who manages its DNS?
- Who receives alert and budget emails?
- **Cost guard: OK that hitting ฿2,892 turns the whole system off until someone re-enables billing?** If not, use the softer option: at 96 % set Cloud Run to `min-instances 0` and email. Spend is then not hard-capped.
- Region: users are in Thailand. Moving to asia-southeast1 (Singapore) cuts about 200 ms per request but costs about 20–25 % more for the VM and is a full migration. This plan keeps us-central1.
