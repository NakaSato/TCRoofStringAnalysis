#!/usr/bin/env bash
# Triggered by .git/hooks/post-commit, .git/hooks/post-merge, or .claude/settings.json PostToolUse hook.
# Runs the `review-agent-changes` skill on `main` (check.sh + Gemini / agy CLI deep architectural review)
# in the background so git commands return immediately.
#
# Usage:
#   .agents/skills/review-agent-changes/scripts/on-main-change.sh [event_name] [--sync]
#
# Audits run one at a time (a mkdir lock; macOS has no flock): check.sh runs pytest and
# `bun run build` in this working tree, and parallel builds share frontend/dist. A run that gets
# the lock audits everything from the last audited commit up to the current HEAD, so commits
# pushed together get one audit of their combined diff (after HEAD has been quiet for 15 s), and
# a HEAD already audited is skipped.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

EVENT="${1:-git-hook}"
SYNC_MODE=0
for arg in "$@"; do
  [ "$arg" = "--sync" ] && SYNC_MODE=1
done

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [ "$BRANCH" != "main" ]; then
  # Only audit commits/merges that land on main
  exit 0
fi

COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
LOCK_DIR="${TCROOF_AUDIT_LOCK_DIR:-/tmp/tcroof_audit_locks}"
mkdir -p "$LOCK_DIR"
STAMP_FILE="${LOCK_DIR}/audited_${COMMIT_SHA}.stamp"

# Avoid duplicate audits of the exact same main commit
if [ -f "$STAMP_FILE" ] && [ "$SYNC_MODE" -eq 0 ]; then
  exit 0
fi
touch "$STAMP_FILE"

LOG_DIR="${REPO_ROOT}/.agents/skills/review-agent-changes/logs"
mkdir -p "$LOG_DIR"
RUN_LOCK="${LOCK_DIR}/run.lock"
LAST_FILE="${LOCK_DIR}/last_audited"
LOCK_WAIT_MAX_S=3600

# One audit at a time. A lock whose holder is gone (crash, reboot) is taken over.
acquire_run_lock() {
  local waited=0 pid
  while ! mkdir "$RUN_LOCK" 2>/dev/null; do
    pid="$(cat "$RUN_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$RUN_LOCK"
      continue
    fi
    if [ "$waited" -ge "$LOCK_WAIT_MAX_S" ]; then
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  echo $$ >"$RUN_LOCK/pid"
  trap 'rm -rf "$RUN_LOCK"' EXIT
}

run_audit() {
  {
    echo "=================================================================="
    echo "[$(date -Iseconds)] Starting review-agent-changes audit on main (${COMMIT_SHA})"
    echo "Trigger event: ${EVENT}"
    echo "=================================================================="

    echo "Range: ${BASE_REF}..${COMMIT_SHA} ($(git rev-list --count "${BASE_REF}..HEAD") commit(s))"

    # Step 1: Run deterministic automated check.sh (creates GitHub issue automatically on [FAIL])
    "$REPO_ROOT/.agents/skills/review-agent-changes/scripts/check.sh" "$BASE_REF"
    CHECK_EXIT=$?

    # Step 2: Invoke Gemini (via Antigravity CLI `agy` or `gemini` CLI) to perform deep skill review of the diff
    AGY_BIN="$(command -v agy || echo "$HOME/.local/bin/agy")"
    GEMINI_BIN="$(command -v gemini || true)"

    PROMPT="Use the review-agent-changes skill (.agents/skills/review-agent-changes/SKILL.md) to review commit(s) ${BASE_REF}..${COMMIT_SHA} on main (git diff ${BASE_REF}..HEAD). Note: check.sh has already been executed with exit code ${CHECK_EXIT}. Inspect the git diff against all rules in CLAUDE.md, backend/CLAUDE.md, and frontend/CLAUDE.md. If you find any architectural or domain rule violation not already reported by check.sh, create or update the GitHub Issue for (${COMMIT_SHA}) using gh issue create / gh issue comment."

    if [ -x "$AGY_BIN" ]; then
      echo ""
      echo "== Invoking Gemini via agy CLI (review-agent-changes skill) =="
      "$AGY_BIN" --dangerously-skip-permissions --print="$PROMPT" || true
    elif [ -n "$GEMINI_BIN" ] && [ -x "$GEMINI_BIN" ]; then
      echo ""
      echo "== Invoking Gemini CLI (review-agent-changes skill) =="
      "$GEMINI_BIN" -p "$PROMPT" --yolo || true
    else
      echo "  [WARN] Neither agy nor gemini CLI found on PATH; skipped LLM review step."
    fi

    echo ""
    echo "[$(date -Iseconds)] Audit finished for ${COMMIT_SHA}."
  } >> "$LOG_FILE" 2>&1
}

if [ "$SYNC_MODE" -eq 1 ]; then
  if ! acquire_run_lock; then
    echo "[review-agent-changes] Another audit held the lock for over ${LOCK_WAIT_MAX_S}s; not auditing ${COMMIT_SHA}." >&2
    exit 1
  fi
  # commits made together (several commits pushed at once, a rebase) land within seconds of each
  # other: wait until HEAD has been quiet for SETTLE_S, then audit up to it in one run
  SETTLE_S="${TCROOF_AUDIT_SETTLE_S:-15}"
  PREV=""
  while [ "$(git rev-parse HEAD)" != "$PREV" ]; do
    PREV="$(git rev-parse HEAD)"
    sleep "$SETTLE_S"
  done
  HEAD_FULL="$PREV"
  COMMIT_SHA="$(git rev-parse --short HEAD)"
  LAST="$(cat "$LAST_FILE" 2>/dev/null || true)"
  if [ "$LAST" = "$HEAD_FULL" ]; then
    echo "[review-agent-changes] ${COMMIT_SHA} was already audited by an earlier run; skipped."
    exit 0
  fi
  if [ -n "$LAST" ] && git merge-base --is-ancestor "$LAST" HEAD 2>/dev/null; then
    BASE_REF="$LAST"
  else
    BASE_REF="$(git rev-parse HEAD~1)"
  fi
  BASE_REF="$(git rev-parse --short "$BASE_REF")"
  LOG_FILE="${LOG_DIR}/audit-${COMMIT_SHA}-$(date +%Y%m%d-%H%M%S).log"
  echo "[review-agent-changes] Running audit on main (${BASE_REF}..${COMMIT_SHA})... Log: ${LOG_FILE}"
  run_audit
  echo "$HEAD_FULL" >"$LAST_FILE"
  cat "$LOG_FILE"
else
  echo "[review-agent-changes] Queued background audit for main (${COMMIT_SHA}); audits run one at a time -> ${LOG_DIR}/"
  nohup bash -c '
    REPO_ROOT="'"$REPO_ROOT"'"
    EVENT="'"$EVENT"'"
    "'"$REPO_ROOT"'/.agents/skills/review-agent-changes/scripts/on-main-change.sh" "$EVENT" --sync >/dev/null 2>&1
  ' >/dev/null 2>&1 &
fi
