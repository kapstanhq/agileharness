#!/usr/bin/env bash
# Install repo git hooks into .git/hooks/. Idempotent — safe to re-run.
#
# Why a custom installer instead of `core.hooksPath`:
#   - `core.hooksPath` is global per-clone (doesn't survive `git config --unset`).
#   - Existing hooks (post-commit FileTimelineTracker) must NOT be overwritten.
#   - We chain our hooks into existing scripts when present.
#
# Run: bash scripts/git-hooks/install.sh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SRC_DIR="$REPO_ROOT/scripts/git-hooks"

if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "❌ not a git repo — nothing to install into (run this from inside a checkout)"
  exit 1
fi

# ASK GIT WHERE THE HOOKS LIVE; do not assume "$REPO_ROOT/.git/hooks". Inside a git WORKTREE `.git`
# is a FILE pointing at the real gitdir, so that path does not exist — and the installer used to bail
# with "are you inside a git repo?" while standing in one.
HOOKS_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-path hooks)"
case "$HOOKS_DIR" in /*) ;; *) HOOKS_DIR="$REPO_ROOT/$HOOKS_DIR" ;; esac

# AND THEN REFUSE, from a worktree — deliberately, because hooks are shared per REPOSITORY while
# $SRC_DIR is per-WORKTREE. Installing here would write the ephemeral worktree's path into the hook
# every checkout shares, and the main one would call a script that vanishes when the worktree is
# discarded: a dangling hook in the live tree, produced by a command that printed a checkmark. The
# old bail was the right OUTCOME reached by the wrong reasoning ("not a repo"); this one says what
# is true and where to go.
MAIN_ROOT="$(cd "$REPO_ROOT" && git rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="${MAIN_ROOT%/.git}"
if [[ "$REPO_ROOT" != "$MAIN_ROOT" ]]; then
  echo "❌ this is a worktree, and git shares hooks per REPOSITORY — installing from here would point"
  echo "   the shared hook at this worktree's copy, which disappears when the worktree is discarded."
  echo "   Install from the main checkout instead:  cd $MAIN_ROOT && bash scripts/git-hooks/install.sh"
  if [[ -f "$HOOKS_DIR/pre-commit" ]]; then
    echo "   (it already has a pre-commit hook installed — this worktree is covered by it.)"
  fi
  exit 1
fi
mkdir -p "$HOOKS_DIR"

install_hook() {
  local hook_name="$1"
  local src_script="$2"
  local target="$HOOKS_DIR/$hook_name"
  local marker="# managed-by agileharness-git-hooks/install.sh"

  if [[ -f "$target" ]] && ! grep -q "$marker" "$target"; then
    # Existing user-managed hook: chain our script as a prefix.
    echo "↪  Chaining $hook_name (existing user hook preserved)"
    local backup="$target.user-$(date +%s)"
    mv "$target" "$backup"
    cat > "$target" <<EOF
#!/usr/bin/env bash
$marker
# Calls the repo-managed hook first, then the prior user hook (preserved at $backup).
bash "$src_script" "\$@"
status=\$?
if [[ \$status -ne 0 ]]; then
  exit \$status
fi
if [[ -x "$backup" ]]; then
  bash "$backup" "\$@"
fi
EOF
    chmod +x "$target"
    return
  fi

  cat > "$target" <<EOF
#!/usr/bin/env bash
$marker
bash "$src_script" "\$@"
EOF
  chmod +x "$target"
  echo "✓ $hook_name → $src_script"
}

# Dispatcher runs the pre-commit checks that EXIST in this checkout (secrets scan,
# anti-defasagem, anti-revert, typecheck, bun-lockfile, test-evidence). It chains each
# sub-script under `[[ -f ]]`, so a checkout carrying only some of them degrades on its own.
install_hook "pre-commit" "$SRC_DIR/pre-commit.sh"

# WHAT ACTUALLY GOT WIRED — measured, not recited. Because the dispatcher degrades silently, a
# checkout with one sub-script and a banner naming five is a promise of protection that is not
# there. The OSS artifact ships ONLY the secret scan: telling whoever cloned the public repo that
# "typecheck" is installed is the illusion-of-coverage this project treats as worse than no
# coverage at all. Same list, same order as the dispatcher; a new check belongs in both.
WIRED=()
[[ -f "$SRC_DIR/scan-secrets.mjs" ]]                        && WIRED+=("secrets scan")
[[ -f "$SRC_DIR/pre-commit-anti-defasagem.sh" ]]            && WIRED+=("anti-defasagem")
[[ -f "$SRC_DIR/pre-commit-anti-revert.sh" ]]               && WIRED+=("anti-revert")
[[ -f "$SRC_DIR/pre-commit-typecheck.sh" ]]                 && WIRED+=("typecheck")
[[ -f "$SRC_DIR/check-bun-lockfile.mjs" ]]                  && WIRED+=("bun-lockfile")
[[ -f "$REPO_ROOT/scripts/agent/record-test-evidence.mjs" ]] && WIRED+=("test-evidence")

echo ""
if [[ ${#WIRED[@]} -eq 0 ]]; then
  echo "⚠️  Hook installed, but NO check exists in this checkout — it will not block anything."
  echo "   Expected at least $SRC_DIR/scan-secrets.mjs"
  exit 1
fi
LISTA="$(printf '%s + ' "${WIRED[@]}")"
echo "✅ Hooks installed (${LISTA% + })."
echo "   Bypass one commit: SKIP_PRECOMMIT=1 git commit ..."
echo "   Granular: SKIP_SECRET_SCAN=1 / ALLOW_STALE=1 / ALLOW_REVERT=1 / SKIP_TEST_GATE=1"
echo "   Uninstall: rm $HOOKS_DIR/pre-commit"
