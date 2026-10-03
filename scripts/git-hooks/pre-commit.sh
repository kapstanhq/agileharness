#!/usr/bin/env bash
# Pre-commit dispatcher — runs all repo pre-commit checks in sequence.
# Installed into .git/hooks/pre-commit by install.sh.
#
# Order: cheapest/most-critical first. Any non-zero check aborts the commit.
#   1. scan-secrets    — block hardcoded secrets / .env / key files (enforce > instruct)
#   2. extra checks    — any `pre-commit-*.sh` script a checkout adds next to this one
#
# Each check is run only if present, so the dispatcher is robust across partial
# installs / future additions.
#
# Bypass everything for one commit: SKIP_PRECOMMIT=1 git commit ...
# Granular bypass: SKIP_SECRET_SCAN=1 (secrets scan); optional checks document their own switches

set -euo pipefail

# Bun lives in ~/.bun/bin, absent from PATH for hooks launched by GUI git
# clients / IDEs / agents (non-login shells). Prepend it once here so every
# chained check (typecheck's `bun run`, test-evidence's `bun x turbo`) finds it.
if [[ -d "$HOME/.bun/bin" ]] && [[ ":$PATH:" != *":$HOME/.bun/bin:"* ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [[ "${HUSKY_SKIP_HOOKS:-0}" == "1" ]] || [[ "${SKIP_PRECOMMIT:-0}" == "1" ]]; then
  echo "⏭  pre-commit checks skipped (SKIP_PRECOMMIT/HUSKY_SKIP_HOOKS set)"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HOOK_DIR="$REPO_ROOT/scripts/git-hooks"

if [[ -f "$HOOK_DIR/scan-secrets.mjs" ]]; then
  node "$HOOK_DIR/scan-secrets.mjs" --staged || exit $?
fi

# Optional extra checks: any `pre-commit-*.sh` script a checkout adds next to this one runs after the
# secret scan, in name order. A checkout without any simply skips this loop.
for extra in "$HOOK_DIR"/pre-commit-*.sh; do
  [[ -f "$extra" ]] || continue
  bash "$extra" "$@" || exit $?
done

exit 0
