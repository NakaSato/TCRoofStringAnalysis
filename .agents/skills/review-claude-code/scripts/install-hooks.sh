#!/usr/bin/env bash
# Install Git hooks (post-commit, post-merge, post-rewrite) in .git/hooks/
# so every commit or merge on `main` triggers the `review-claude-code` skill via Gemini (agy).
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

HOOKS_DIR="${REPO_ROOT}/.git/hooks"
mkdir -p "$HOOKS_DIR"

for hook in post-commit post-merge; do
  HOOK_PATH="${HOOKS_DIR}/${hook}"
  cat > "$HOOK_PATH" <<'EOF'
#!/usr/bin/env bash
# Auto-installed by .agents/skills/review-claude-code/scripts/install-hooks.sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [ -x "$REPO_ROOT/.agents/skills/review-claude-code/scripts/on-main-change.sh" ]; then
  "$REPO_ROOT/.agents/skills/review-claude-code/scripts/on-main-change.sh" "$(basename "$0")"
fi
EOF
  chmod +x "$HOOK_PATH"
  echo "Installed ${HOOK_PATH}"
done
