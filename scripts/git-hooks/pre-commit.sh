#!/usr/bin/env bash
# Pre-commit dispatcher — runs all repo pre-commit checks in sequence.
# Installed into .git/hooks/pre-commit by install.sh.
#
# Order: cheapest/most-critical first. Any non-zero check aborts the commit.
#   1. scan-secrets    — block hardcoded secrets / .env / key files (enforce > instruct)
#   2. anti-defasagem  — block packages/** commits from a checkout behind origin/main
#                        (anti-clobber; multi-checkout staleness — see CLAUDE.md)
#   3. anti-revert     — block packages/** commits that revert code already on `stage`
#                        (anti lost-impl; stamps a backup ref when approved)
#   4. typecheck       — typecheck packages with staged TS changes
#   5. bun-lockfile    — block stale bun.lock when a package.json is staged (host-side
#                        frozen check; the Cloud Run Dockerfiles dropped frozen for
#                        bun's cross-platform bug — oven-sh/bun#25543)
#   6. test-evidence   — require fresh passing unit-test evidence for app-source commits
#
# Each check is run only if present, so the dispatcher is robust across partial
# installs / future additions.
#
# Bypass everything for one commit: SKIP_PRECOMMIT=1 git commit ...
# Granular bypass: SKIP_SECRET_SCAN=1 / ALLOW_STALE=1 / ALLOW_REVERT=1 / SKIP_TEST_GATE=1

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

if [[ -f "$HOOK_DIR/pre-commit-anti-defasagem.sh" ]]; then
  bash "$HOOK_DIR/pre-commit-anti-defasagem.sh" "$@" || exit $?
fi

if [[ -f "$HOOK_DIR/pre-commit-anti-revert.sh" ]]; then
  bash "$HOOK_DIR/pre-commit-anti-revert.sh" "$@" || exit $?
fi

if [[ -f "$HOOK_DIR/pre-commit-typecheck.sh" ]]; then
  bash "$HOOK_DIR/pre-commit-typecheck.sh" "$@" || exit $?
fi

if [[ -f "$HOOK_DIR/check-bun-lockfile.mjs" ]]; then
  node "$HOOK_DIR/check-bun-lockfile.mjs" || exit $?
fi

if [[ -f "$REPO_ROOT/scripts/agent/record-test-evidence.mjs" ]]; then
  node "$REPO_ROOT/scripts/agent/record-test-evidence.mjs" --verify || exit $?
fi

exit 0
