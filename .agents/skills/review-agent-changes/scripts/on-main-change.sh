#!/usr/bin/env bash
# Triggered by .git/hooks/post-commit, .git/hooks/post-merge, or .claude/settings.json PostToolUse hook.
# Runs the `review-agent-changes` skill on `main` (check.sh + Gemini / agy CLI deep architectural review)
# in the background so git commands return immediately.
#
# Usage:
#   .agents/skills/review-agent-changes/scripts/on-main-change.sh [event_name] [--sync]
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
LOCK_DIR="/tmp/tcroof_audit_locks"
mkdir -p "$LOCK_DIR"
STAMP_FILE="${LOCK_DIR}/audited_${COMMIT_SHA}.stamp"

# Avoid duplicate audits of the exact same main commit
if [ -f "$STAMP_FILE" ] && [ "$SYNC_MODE" -eq 0 ]; then
  exit 0
fi
touch "$STAMP_FILE"

LOG_DIR="${REPO_ROOT}/.agents/skills/review-agent-changes/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/audit-${COMMIT_SHA}-$(date +%Y%m%d-%H%M%S).log"

run_audit() {
  {
    echo "=================================================================="
    echo "[$(date -Iseconds)] Starting review-agent-changes audit on main (${COMMIT_SHA})"
    echo "Trigger event: ${EVENT}"
    echo "=================================================================="

    # Step 1: Run deterministic automated check.sh (creates GitHub issue automatically on [FAIL])
    "$REPO_ROOT/.agents/skills/review-agent-changes/scripts/check.sh" HEAD~1
    CHECK_EXIT=$?

    # Step 2: Invoke Gemini (via Antigravity CLI `agy` or `gemini` CLI) to perform deep skill review of the diff
    AGY_BIN="$(command -v agy || echo "$HOME/.local/bin/agy")"
    GEMINI_BIN="$(command -v gemini || true)"

    PROMPT="Use the review-agent-changes skill (.agents/skills/review-agent-changes/SKILL.md) to review commit ${COMMIT_SHA} on main (git diff HEAD~1..HEAD). Note: check.sh has already been executed with exit code ${CHECK_EXIT}. Inspect the git diff against all rules in CLAUDE.md, backend/CLAUDE.md, and frontend/CLAUDE.md. If you find any architectural or domain rule violation not already reported by check.sh, create or update the GitHub Issue for (${COMMIT_SHA}) using gh issue create / gh issue comment."

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
  echo "[review-agent-changes] Running audit synchronously on main (${COMMIT_SHA})... Log: ${LOG_FILE}"
  run_audit
  cat "$LOG_FILE"
else
  echo "[review-agent-changes] Triggered background Gemini audit for main (${COMMIT_SHA}) -> ${LOG_FILE}"
  nohup bash -c '
    REPO_ROOT="'"$REPO_ROOT"'"
    EVENT="'"$EVENT"'"
    "'"$REPO_ROOT"'/.agents/skills/review-agent-changes/scripts/on-main-change.sh" "$EVENT" --sync >/dev/null 2>&1
  ' >/dev/null 2>&1 &
fi
