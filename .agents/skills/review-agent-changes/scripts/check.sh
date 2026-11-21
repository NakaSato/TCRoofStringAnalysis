#!/usr/bin/env bash
# Read-only review & verification script for TC Roof Solar (audits Claude Code changes).
# Can automatically open/update a GitHub Issue when failures (or warnings) are found.
#
# Usage (from repo root):
#   .agents/skills/review-agent-changes/scripts/check.sh                       # full check + auto-create GitHub issue on FAIL
#   .agents/skills/review-agent-changes/scripts/check.sh --fast                # skip pytest & vite build
#   .agents/skills/review-agent-changes/scripts/check.sh --no-issue            # run checks only, never create GitHub issue
#   .agents/skills/review-agent-changes/scripts/check.sh --issue-on-warn       # also create GitHub issue if warnings > 0
#   .agents/skills/review-agent-changes/scripts/check.sh HEAD~1                # compare against specific ref
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

FAST=0
AUTO_ISSUE=1
ISSUE_ON_WARN=0
BASE_REF=""

for arg in "$@"; do
  case "$arg" in
    --fast)          FAST=1 ;;
    --no-issue)      AUTO_ISSUE=0 ;;
    --issue)         AUTO_ISSUE=1 ;;
    --issue-on-warn) ISSUE_ON_WARN=1; AUTO_ISSUE=1 ;;
    *)               BASE_REF="$arg" ;;
  esac
done

FAILURES=0
WARNINGS=0
FAIL_ITEMS=()
WARN_ITEMS=()
REPORT_FILE="$(mktemp -t tcroof_audit_report.XXXXXX)"
trap 'rm -f "$REPORT_FILE"' EXIT

log() {
  printf '%s\n' "$1" | tee -a "$REPORT_FILE"
}
h() {
  printf '\n== %s\n' "$1" | tee -a "$REPORT_FILE"
}
pass() {
  printf '  [PASS] %s\n' "$1" | tee -a "$REPORT_FILE"
}
warn() {
  printf '  [WARN] %s\n' "$1" | tee -a "$REPORT_FILE"
  WARNINGS=$((WARNINGS + 1))
  WARN_ITEMS+=("$1")
}
fail() {
  printf '  [FAIL] %s\n' "$1" | tee -a "$REPORT_FILE"
  FAILURES=$((FAILURES + 1))
  FAIL_ITEMS+=("$1")
}

COMMIT_SHA="$(git rev-parse --short HEAD)"
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"

# Determine diff target
if [ -n "$BASE_REF" ]; then
  DIFF_CMD=(git diff "$BASE_REF")
  CHANGED_FILES="$(git diff --name-only --diff-filter=d "$BASE_REF")"
  DIFF_LABEL="git diff $BASE_REF"
elif [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  DIFF_CMD=(git diff HEAD)
  CHANGED_FILES="$(git diff --name-only --diff-filter=d HEAD)"
  DIFF_LABEL="uncommitted tracked changes vs HEAD ($COMMIT_SHA)"
else
  DIFF_CMD=(git diff HEAD~1..HEAD)
  CHANGED_FILES="$(git diff --name-only --diff-filter=d HEAD~1..HEAD)"
  DIFF_LABEL="latest commit ($COMMIT_SHA)"
fi

h "1. Git Scope ($DIFF_LABEL)"
git status -sb | tee -a "$REPORT_FILE"
log "Changed tracked files ($DIFF_LABEL):"
if [ -n "$CHANGED_FILES" ]; then
  echo "$CHANGED_FILES" | head -n 40 | sed 's/^/  /' | tee -a "$REPORT_FILE"
  total_changed="$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')"
  [ "$total_changed" -gt 40 ] && log "  ... and $((total_changed - 40)) more"
else
  log "  (none)"
fi

h "2. Dependency & Lockfile Consistency"
# 2a. Forbidden package manager lockfiles
for bad_lock in frontend/package-lock.json frontend/yarn.lock frontend/pnpm-lock.yaml package-lock.json yarn.lock pnpm-lock.yaml; do
  if [ -e "$bad_lock" ]; then
    fail "Forbidden lockfile present: \`$bad_lock\` (use Bun only in \`frontend/\` per \`frontend/CLAUDE.md\`)"
  fi
done

# 2b. Compare pyproject.toml vs backend/pyproject.toml dependencies
dep_check="$(uv run python -c '
import tomllib, re
def norm(p):
    with open(p, "rb") as f:
        deps = tomllib.load(f)["project"]["dependencies"]
    return {re.split(r"[><=~!\[]", d)[0].strip().lower(): d for d in deps}
root = norm("pyproject.toml")
back = norm("backend/pyproject.toml")
allowed_back_only = {"psycopg", "tzdata"}
only_root = sorted(set(root) - set(back))
only_back = sorted(set(back) - set(root) - allowed_back_only)
mismatch = sorted(k for k in (set(root) & set(back)) if root[k] != back[k])
if only_root or only_back or mismatch:
    if only_root: print("ONLY_ROOT:" + ",".join(only_root))
    if only_back: print("ONLY_BACK:" + ",".join(only_back))
    if mismatch:  print("VERSION_MISMATCH:" + ",".join(f"{k}({root[k]} vs {back[k]})" for k in mismatch))
else:
    print("OK")
' 2>&1)"

if [ "$dep_check" = "OK" ]; then
  pass "pyproject.toml and backend/pyproject.toml dependencies are in sync"
else
  fail "Dependency mismatch between \`pyproject.toml\` and \`backend/pyproject.toml\`: \`$dep_check\`"
fi

h "3. Architecture & Domain Invariants"
# 3a. solar_core must remain pure (no FastAPI / SQLAlchemy / app imports)
bad_core="$(grep -rnE '^\s*(from|import)\s+(fastapi|sqlalchemy|app)\b' backend/solar_core/ 2>/dev/null || true)"
if [ -z "$bad_core" ]; then
  pass "solar_core/ is pure (no FastAPI/SQLAlchemy/app imports)"
else
  fail "\`solar_core/\` imports FastAPI, SQLAlchemy, or \`app\`"
  echo "$bad_core" | sed 's/^/    /' | tee -a "$REPORT_FILE"
fi

# 3b. No logging.basicConfig in backend
bad_log="$(grep -rn 'basicConfig' backend/app/ backend/solar_core/ 2>/dev/null || true)"
if [ -z "$bad_log" ]; then
  pass "No logging.basicConfig usage in backend/"
else
  fail "Found \`logging.basicConfig\` in \`backend/\` (must use \`logging.getLogger(__name__)\`)"
  echo "$bad_log" | sed 's/^/    /' | tee -a "$REPORT_FILE"
fi

# 3c. SQL portability: no raw strftime or date() inside text()
bad_sql="$(grep -rnE 'text\([^)]*(strftime|datetime\()' backend/app/ 2>/dev/null || true)"
if [ -z "$bad_sql" ]; then
  pass "No SQLite-only strftime/datetime inside SQLAlchemy text()"
else
  fail "Found SQLite-specific date functions inside SQL \`text()\`"
  echo "$bad_sql" | sed 's/^/    /' | tee -a "$REPORT_FILE"
fi

# 3d. Frontend fetch() restriction (only client.ts and assistant.ts allowed)
bad_fetch="$(grep -rnE '\bfetch\s*\(' frontend/src/ \
  --exclude='client.ts' --exclude='assistant.ts' 2>/dev/null || true)"
if [ -z "$bad_fetch" ]; then
  pass "Frontend only calls fetch() inside src/api/client.ts and src/api/assistant.ts"
else
  warn "Found \`fetch()\` outside \`src/api/client.ts\` or \`assistant.ts\` (verify it is not an untyped API call)"
  echo "$bad_fetch" | sed 's/^/    /' | tee -a "$REPORT_FILE"
fi

# 3e. Frontend Plotly ban (D3 only)
bad_plotly="$(grep -rnE 'plotly|react-plotly' frontend/src/ 2>/dev/null || true)"
if [ -z "$bad_plotly" ]; then
  pass "Frontend uses D3 only (no Plotly imports in frontend/src)"
else
  fail "Found Plotly in \`frontend/src\` (D3 only per \`frontend/CLAUDE.md\`)"
  echo "$bad_plotly" | sed 's/^/    /' | tee -a "$REPORT_FILE"
fi

# 3f. Frontend runtime caching of /api ban in vite.config.ts
bad_pwa="$(grep -rnE 'runtimeCaching\s*:\s*\[\s*\{' frontend/vite.config.ts 2>/dev/null || true)"
if [ -z "$bad_pwa" ]; then
  pass "No non-empty PWA runtimeCaching in frontend/vite.config.ts"
else
  fail "Found non-empty \`runtimeCaching\` in \`frontend/vite.config.ts\` (never cache \`/api\` responses)"
fi

# 3g. Inspect diff for risky patterns (plausible numeric fallbacks, live store writes, etc.)
DIFF_ADDED="$("${DIFF_CMD[@]}" 2>/dev/null | grep -E '^\+[^+]' || true)"
if [ -n "$DIFF_ADDED" ]; then
  fe_fallbacks="$("${DIFF_CMD[@]}" -- 'frontend/src/*.ts' 'frontend/src/*.tsx' 2>/dev/null \
    | grep -E '^\+[^+]' \
    | grep -E '(\?\?|\|\|)\s*[0-9]+(\.[0-9]+)?' || true)"
  if [ -n "$fe_fallbacks" ]; then
    warn "Added numeric fallback (\`??\` or \`|| <number>\`) in frontend diff — verify it does not invent missing measurements"
    echo "$fe_fallbacks" | sed 's/^/    /' | tee -a "$REPORT_FILE"
  else
    pass "No suspicious numeric fallbacks in frontend diff"
  fi
fi

h "4. Schema, Config & Documentation Sync"
if echo "$CHANGED_FILES" | grep -qE '^backend/app/db/models(\.py|/.*\.py)$'; then
  if echo "$CHANGED_FILES" | grep -q '^backend/alembic/versions/'; then
    pass "db models changed and an Alembic migration was updated/added"
  else
    warn "\`backend/app/db/models/\` changed without a migration in \`backend/alembic/versions/\` (check \`_ADDED_COLUMNS\` in \`db/session.py\` + Alembic revision)"
  fi
else
  pass "No ORM model changes requiring migration check"
fi

if echo "$CHANGED_FILES" | grep -q '^backend/app/config.py$'; then
  if echo "$CHANGED_FILES" | grep -q '^\.env\.example$'; then
    pass "config.py changed and .env.example was updated"
  else
    warn "\`backend/app/config.py\` changed without updating \`.env.example\` (or \`CLAUDE.md\`)"
  fi
fi

h "5. Type Checking, Linting & Tests"
if command -v pyright >/dev/null 2>&1; then
  changed_py="$(echo "$CHANGED_FILES" | grep -E '^backend/(app|solar_core)/.*\.py$' || true)"
  if [ -n "$changed_py" ]; then
    # shellcheck disable=SC2086
    if pyright --pythonpath .venv/bin/python $changed_py >/tmp/tcroof_pyright.log 2>&1; then
      pass "pyright on changed Python files"
    else
      fail "pyright failed on changed Python files"
      head -n 35 /tmp/tcroof_pyright.log | sed 's/^/    /' | tee -a "$REPORT_FILE"
    fi
  else
    pass "No changed Python files in backend/app or backend/solar_core to run pyright on"
  fi
else
  warn "pyright not found on PATH"
fi

if (cd frontend && bun run lint) >/tmp/tcroof_bun_lint.log 2>&1; then
  pass "frontend: bun run lint (tsc --noEmit)"
else
  fail "frontend: \`bun run lint\` (\`tsc --noEmit\`) failed"
  head -n 35 /tmp/tcroof_bun_lint.log | sed 's/^/    /' | tee -a "$REPORT_FILE"
fi

if [ "$FAST" -eq 0 ]; then
  if uv run pytest -q >/tmp/tcroof_pytest.log 2>&1; then
    pass "backend: uv run pytest -q ($(tail -n 1 /tmp/tcroof_pytest.log))"
  else
    fail "backend: \`uv run pytest -q\` failed"
    tail -n 40 /tmp/tcroof_pytest.log | sed 's/^/    /' | tee -a "$REPORT_FILE"
  fi

  if (cd frontend && bun run build) >/tmp/tcroof_bun_build.log 2>&1; then
    pass "frontend: bun run build"
  else
    fail "frontend: \`bun run build\` failed"
    tail -n 30 /tmp/tcroof_bun_build.log | sed 's/^/    /' | tee -a "$REPORT_FILE"
  fi
else
  log "  [SKIP] pytest and bun run build (--fast mode)"
fi

h "Summary"
log "  Failures: $FAILURES   Warnings: $WARNINGS"

# ---------------------------------------------------------------------------
# 6. Auto-create / update GitHub Issue when checks fail (or warn if requested)
# ---------------------------------------------------------------------------
SHOULD_CREATE_ISSUE=0
if [ "$AUTO_ISSUE" -eq 1 ]; then
  if [ "$FAILURES" -gt 0 ]; then
    SHOULD_CREATE_ISSUE=1
  elif [ "$ISSUE_ON_WARN" -eq 1 ] && [ "$WARNINGS" -gt 0 ]; then
    SHOULD_CREATE_ISSUE=1
  fi
fi

if [ "$SHOULD_CREATE_ISSUE" -eq 1 ]; then
  h "6. GitHub Issue Reporting"
  if ! command -v gh >/dev/null 2>&1; then
    echo "  [WARN] gh CLI not installed; skipping GitHub issue creation."
  elif ! gh auth status >/dev/null 2>&1; then
    echo "  [WARN] gh CLI not authenticated; skipping GitHub issue creation."
  else
    ISSUE_TITLE="[Claude Code Audit] ${FAILURES} failure(s), ${WARNINGS} warning(s) on ${BRANCH_NAME} (${COMMIT_SHA})"

    # Build Markdown body
    BODY_FILE="$(mktemp -t tcroof_issue_body.XXXXXX)"
    {
      echo "## Automated Claude Code Audit Report"
      echo ""
      echo "- **Branch / Commit**: \`${BRANCH_NAME}\` (\`${COMMIT_SHA}\`)"
      echo "- **Scope**: ${DIFF_LABEL}"
      echo "- **Failures**: **${FAILURES}**"
      echo "- **Warnings**: **${WARNINGS}**"
      echo ""
      if [ "${#FAIL_ITEMS[@]}" -gt 0 ]; then
        echo "### Failures (\`[FAIL]\`)"
        for item in "${FAIL_ITEMS[@]}"; do
          echo "- [ ] ${item}"
        done
        echo ""
      fi
      if [ "${#WARN_ITEMS[@]}" -gt 0 ]; then
        echo "### Warnings (\`[WARN]\`)"
        for item in "${WARN_ITEMS[@]}"; do
          echo "- [ ] ${item}"
        done
        echo ""
      fi
      echo "<details>"
      echo "<summary>Full Audit Output (<code>check.sh</code>)</summary>"
      echo ""
      echo '```text'
      cat "$REPORT_FILE"
      echo '```'
      echo "</details>"
    } > "$BODY_FILE"

    # Check if an open audit issue for this commit already exists to avoid duplicates
    EXISTING_ISSUE="$(gh issue list --state open --search "[Claude Code Audit] (${COMMIT_SHA}) in:title" --json number,url --jq '.[0].number // empty' 2>/dev/null || true)"

    if [ -n "$EXISTING_ISSUE" ]; then
      gh issue comment "$EXISTING_ISSUE" --body-file "$BODY_FILE" >/dev/null
      ISSUE_URL="$(gh issue view "$EXISTING_ISSUE" --json url --jq .url)"
      echo "  [INFO] Updated existing open GitHub Issue #${EXISTING_ISSUE}: ${ISSUE_URL}"
    else
      ISSUE_URL="$(gh issue create --title "$ISSUE_TITLE" --body-file "$BODY_FILE" --label "bug" 2>&1)"
      echo "  [INFO] Created GitHub Issue: ${ISSUE_URL}"
    fi
    rm -f "$BODY_FILE"
  fi
fi

exit "$FAILURES"
