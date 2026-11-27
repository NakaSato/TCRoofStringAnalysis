---
name: review-agent-changes
description: >-
  Audit and verify code changes made by Claude Code in the TC Roof Solar repository
  against project rules in CLAUDE.md, backend/CLAUDE.md, and frontend/CLAUDE.md, and
  automatically create/update a GitHub Issue when failures are detected.
  Use this skill when the user asks to "ตรวจงาน Claude Code", "เช็คงาน claude",
  "review claude code", "audit changes", or verify recent edits/commits.
---

# Review Claude Code Changes (TC Roof Solar)

Use this skill to systematically audit work performed by Claude Code (uncommitted changes, staged changes, or recent commits) against TC Roof Solar's architecture, data rules, test suite, and documentation requirements, and automatically report failures to GitHub Issues.

## 1. Run the Automated Audit Script

Always start by running the verification script from the repository root. By default, if any `[FAIL]` check is triggered, `check.sh` will automatically create (or update an existing open) GitHub Issue on `NakaSato/TCRoofStringAnalysis` via `gh issue create`:

```bash
# Smart check (static checks + pyright + scoped pytest / bun test / bun lint / bun build / cargo clippy / cargo test based on changed paths)
# Automatically creates/updates a GitHub Issue if any [FAIL] occurs
.agents/skills/review-agent-changes/scripts/check.sh

# Force full backend pytest + frontend build + rust clippy / tests regardless of which paths changed
.agents/skills/review-agent-changes/scripts/check.sh --full

# Compare against a specific commit or branch range (e.g. HEAD~1..HEAD or main..HEAD)
.agents/skills/review-agent-changes/scripts/check.sh HEAD~1

# Fast check (skips pytest, vite build and cargo test; runs git/rule checks + pyright + bun lint + bun test + cargo clippy)
.agents/skills/review-agent-changes/scripts/check.sh --fast

# Also open a GitHub Issue even when there are only [WARN] items (0 failures)
.agents/skills/review-agent-changes/scripts/check.sh --issue-on-warn

# Dry run / no GitHub Issue creation
.agents/skills/review-agent-changes/scripts/check.sh --no-issue
```

### How Automatic GitHub Issue Creation Works
1. **Script-level (`check.sh`)**:
   - When `FAILURES > 0` (or `WARNINGS > 0` with `--issue-on-warn`), `check.sh` builds a structured Markdown report containing the branch, commit SHA, checklist of `[FAIL]` / `[WARN]` items, and a collapsible `<details>` block with the full audit log.
   - Deduplication: It searches open issues matching `[Claude Code Audit] (<commit_sha>) in:title`. If an open issue already exists for that commit, it appends a comment (`gh issue comment`) instead of creating duplicate issues; otherwise it creates a new issue (`gh issue create --label bug`) and prints the issue URL.
2. **Agent-level (Manual / Architectural Findings)**:
   - If `check.sh` passes (`0` failures) **but** your manual diff inspection in Step 2 uncovers an architectural or domain rule violation (e.g., writing live values to SQL, missing `require_plant_read`, invented fallback numbers), create a GitHub Issue directly using `gh issue create`:
     ```bash
     gh issue create \
       --title "[Claude Code Audit] <short summary> ($(git rev-parse --short HEAD))" \
       --label "bug" \
       --body "<markdown checklist of findings with file:line references>"
     ```

## 2. Inspect the Diff Against Domain & Architecture Rules

Read the full diff of the target work (`git diff HEAD` if uncommitted, or `git show HEAD` / `git diff <base>..HEAD` if already committed) and verify every changed file against the rules in [`CLAUDE.md`](../../../CLAUDE.md), [`backend/CLAUDE.md`](../../../backend/CLAUDE.md), and [`frontend/CLAUDE.md`](../../../frontend/CLAUDE.md):

### A. Data Integrity & Growatt Rules (Critical)
1. **Live and persisted data never mix**:
   - `/growatt/live/*` (`services/growatt_live.py`, `services/live_store.py`) must remain in memory / Redis mirror only (JSON, never pickle, every key has TTL). Never write live values to SQL or Firestore.
   - `/growatt/plants*`, `/growatt/sensors`, `/growatt/alarms`, and `/assistant/*` tools must read from the DB only (`meta.source = "db"` where applicable) and never call Growatt directly.
   - When Redis is enabled (`REDIS_URL`), live caches and cooldowns must use `time.time`, not `time.monotonic`.
2. **Never invent numbers**:
   - Missing measurements must be `None` / `null` and rendered in the UI as `"—"` (using `fmt()` / `fmtInt()`).
   - Never substitute plausible defaults (`|| 98.1`, `?? 229.8`, `capacity * 0.72`, etc.) or add unmeasured fields (grid import, load).
   - Modelled data (Google Weather, clear-sky curve, I-V curve, peer-relative PR) must be explicitly labelled as `modelled`.
3. **Firestore write budget**:
   - Firestore (`tcroof-string-analysis`, Spark free tier) holds only daily summaries and static registry (`plants/`, `inverters/`, `config/*`), capped by `PUBLISH_DAILY_WRITE_BUDGET`.
4. **Energy & Yield calculations**:
   - Integrate energy with `_integrate_kwh` (respecting mixed 1–5 min intervals and `MAX_GAP_H = 10 min`), never `sum × 5 min`.
   - Daily yield comes from `eac_today` of the day's **last** record, never `MAX(eac_today)` (midnight carry-over).

### B. Backend Rules (`backend/`)
1. **Layer separation**:
   - `solar_core/` is a pure Pandas/NumPy engine — no FastAPI, SQLAlchemy, or `app.*` imports.
   - Route handlers in `app/api/routes/*` stay thin and delegate business logic to `app/services/*`.
   - Every router is mounted twice (`/api` and `/`).
2. **Auth & Plant Scoping**:
   - Plant routes (`/growatt/.../plants/{plant_id}/...`) must use `require_plant_read` / `require_plant_write` and return **404** (not 403) when a plant is unassigned to an `engineer`.
   - List endpoints and AI Assistant tools must filter by `allowed_plant_ids`.
   - Shadow issues (`shadow = true`) must never be visible or mutable by `engineer` role (404).
   - Admin-only routes must depend on `require_admin`.
3. **Database & Portability**:
   - Queries must run on both SQLite and Postgres (use SQLAlchemy expressions; no `strftime` or `date()` inside raw `text()`).
   - Growatt reading timestamps are naive plant-local (Bangkok); bookkeeping columns (`sync_runs`, `published_docs`, `synced_at`) are UTC.
   - Schema changes in `backend/app/db/models.py` must be added to `_ADDED_COLUMNS` in `backend/app/db/session.py` AND have a chained migration in `backend/alembic/versions/`.
4. **Dependencies & Logging**:
   - Any new Python dependency must be added to **both** root `pyproject.toml` and `backend/pyproject.toml`.
   - Use `logging.getLogger(__name__)`, never `logging.basicConfig`. Never log secrets or live measurements.
   - Never run worker jobs inside API requests (API only queues `status = queued`).
5. **Tests**:
   - New backend behavior must have pytest coverage in `backend/tests/`.
   - Tests must use isolated `tmp_path` SQLite DBs and fake clients (`get_live_service`, `set_client`), never hitting the network.

### C. Frontend Rules (`frontend/`)
1. **Tooling & API Client**:
   - Use **Bun** only (`bun.lock`). Never add `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`.
   - All REST calls go through `src/api/client.ts` (types in `src/api/types/*`). The only allowed direct `fetch` outside `client.ts` is SSE streaming in `src/api/assistant.ts` (and authenticated CSV downloads).
2. **State & Routing**:
   - Selected plant and page filters belong in the URL (`plantPath`, `useUrlState`), validated with `pick` / `pickDay` / `pickTime`. Do not wipe URL query parameters in a mount `useEffect`.
   - Route data requirements are declared in `src/context/routes.ts` (`routeData(pathname)`).
   - Polling must pause when `document.hidden` is true and follow `refresh_in_s`.
3. **UI & Charts**:
   - Use shadcn/ui primitives (`@/components/ui/*`) and shared components in `src/components/ui.tsx` (`LoadingState`, `Spinner` with `data-icon="inline-start"`). No hand-rolled `animate-spin` or bare `"Loading…"` text.
   - Charts must use D3 (`PanelChart.tsx`, `D3Charts.tsx`) with `chartTheme.ts` tokens — no Plotly, no dual Y-axes (use stacked panels instead), and nulls rendered as gaps (never 0).
   - Never enable Workbox `runtimeCaching` for `/api/**`.

### D. Documentation Sync
- Check whether new routes, jobs, env vars, or UI flows require updates in `CLAUDE.md`, `backend/CLAUDE.md`, `frontend/CLAUDE.md`, or `.env.example`.

## 3. Automatic Trigger on Merge or Commit to `main`

Git hooks (`post-commit` and `post-merge` in `.git/hooks/`) automatically invoke [`scripts/on-main-change.sh`](./scripts/on-main-change.sh) in the background whenever a commit or merge lands on `main`:

0. Audits run **one at a time** (a `mkdir` lock in `/tmp/tcroof_audit_locks/run.lock`, taken over when its holder is gone): `check.sh` runs `pytest` and `bun run build` in this working tree, and parallel builds share `frontend/dist`. A run that gets the lock waits until `HEAD` has been quiet for 15 s, then audits **from the last audited commit (`/tmp/tcroof_audit_locks/last_audited`) to `HEAD`**, so commits pushed together get one audit of their combined diff; a `HEAD` already audited is skipped (no log).
1. Runs `scripts/check.sh <last audited>..HEAD` (`HEAD~1..HEAD` when there is no record; static/architecture checks, `pyright`, path-scoped `pytest`, `bun run lint`, `bun test`, `bun run build`, `cargo clippy --all-targets -- -D warnings` and `cargo test` (when `rust/` changed; a `[WARN]` if `cargo` is missing), and opens/updates a GitHub Issue on `[FAIL]`).
2. Calls **Gemini** via the Antigravity CLI (`agy --print --dangerously-skip-permissions`) with this skill (`review-agent-changes`) to inspect `git diff <last audited>..HEAD` for deeper domain/architectural violations and post any additional findings to GitHub Issues.
3. Writes execution logs to `.agents/skills/review-agent-changes/logs/audit-<sha>-<timestamp>.log` (gitignored).

To install or re-install the Git hooks on a clone:
```bash
.agents/skills/review-agent-changes/scripts/install-hooks.sh
```

## 4. Report Format

Present the review findings to the user in a concise, structured summary:

1. **Automated Checks**: Pass/Fail table for `pyright`, `pytest`, `bun run lint`, `bun run build`, `cargo clippy` / `cargo test`, and static rule checks.
2. **Code & Architecture Review**:
   - Critical issues / rule violations (with clickable file and line links).
   - Edge cases, missing tests, or unupdated docs/migrations (`CLAUDE.md`, `.env.example`, Alembic).
3. **GitHub Issue**: Link to the automatically created/updated GitHub Issue (if any failures or violations were found).
4. **Verdict**: Ready to commit/deploy, or list of exact fixes required.
