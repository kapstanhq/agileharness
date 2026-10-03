// Git branch + dirty state for a tmux session's cwd — the bar's "⎇ <branch> ●" affordance.
//
// Modelled on lib/terminal/tmux.ts: execFile (shell:false), a short timeout, and it NEVER throws —
// an arbitrary cwd (a worktree, a non-repo dir, a deleted path) must degrade to "unknown", never an
// exception on the request path. Server-only (node:child_process). The cwd comes from tmux
// (pane_current_path), so the client never names an arbitrary path to run git in.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface GitState {
  /** current branch, or null when detached HEAD / not a git repo */
  branch: string | null;
  /** uncommitted changes present? null when unknown (not a repo / git failed) */
  dirty: boolean | null;
}

/**
 * Branch + dirty for `cwd`, best-effort. A non-repo or a git failure returns `{branch:null,
 * dirty:null}`; a detached HEAD returns `{branch:null, dirty:<computed>}` (it IS a repo).
 */
export async function branchAndDirty(cwd: string): Promise<GitState> {
  if (!cwd) return { branch: null, dirty: null };
  let branch: string | null = null;
  try {
    const { stdout } = await pexec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 5_000,
    });
    const b = stdout.trim();
    // "HEAD" = detached: it's a repo, but there's no branch name to show.
    branch = b && b !== "HEAD" ? b : null;
  } catch {
    // rev-parse fails ⇒ not a git repo (or git unavailable) ⇒ nothing to say about dirtiness either.
    return { branch: null, dirty: null };
  }
  let dirty: boolean | null = null;
  try {
    const { stdout } = await pexec("git", ["-C", cwd, "status", "--porcelain"], {
      timeout: 5_000,
      maxBuffer: 4_000_000,
    });
    dirty = stdout.trim().length > 0;
  } catch {
    dirty = null; // in a repo but status failed → unknown, not "clean"
  }
  return { branch, dirty };
}
