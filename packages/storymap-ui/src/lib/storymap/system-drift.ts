// System drift detection (story system-resync) — the cheap, deterministic signal behind the Inbox
// "🔄 sistemas mudaram" panel. A system (SystemDef) is now authored as a PROMPT derived from real code
// and anchored to that code via `paths` (globs) + `syncedCommit` (the SHA it was derived from). This
// module answers ONE question per system: did its code change since `syncedCommit`? — by running
// `git log <syncedCommit>..HEAD -- <paths>`. If there are commits, the prompt may be stale and the
// panel offers a one-click re-sync (spawn the sincronizar agent → diff → approve → re-stamp).
//
// PURE over an injected `GitRunner` (DI, like the runner's `exec`/`spawn`) → unit-testable with a fake,
// no real repo. The server action (assisted-edit-actions.ts) wires a real `git` via execFile (shell:false).

import type { SystemDef } from "./types";

/** A SHA is operator-authored in board.yaml + interpolated into a git ref (`<sha>..HEAD`). Even with
 *  execFile (shell:false) a hostile value could be a weird refspec — gate it to a hex sha so only a
 *  real commit id is ever fed to git. A non-conforming syncedCommit is treated as "unsynced" (skipped). */
export const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** One commit that touched a system's code since its last sync — surfaced as the WHY in the panel. */
export interface DriftCommit {
  sha: string;
  subject: string;
}

/** A system whose code changed since `syncedCommit` (or whose base SHA is invalid → needs re-sync). */
export interface SystemDrift {
  systemId: string;
  name: string;
  /** the current prompt (the `before` of the re-sync diff); may be empty. */
  prompt: string;
  paths: string[];
  /** commits touching `paths` since `syncedCommit`, newest first (empty + reason set ⇒ invalid base). */
  commits: DriftCommit[];
  /** set when the base SHA no longer resolves (history rewrite) — re-sync from HEAD instead of a range. */
  baseInvalid?: boolean;
}

/** stdout of `git <args>` run in `cwd`; rejects on a non-zero exit (so the caller can catch a bad base). */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** Parse `git log --oneline` output into commits (sha + subject), newest first. PURE. */
export function parseOnelineLog(stdout: string): DriftCommit[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sp = l.indexOf(" ");
      return sp > 0 ? { sha: l.slice(0, sp), subject: l.slice(sp + 1) } : { sha: l, subject: "" };
    });
}

/**
 * Detect which systems are STALE (their code changed since the prompt was last synced). Returns the
 * current HEAD (the SHA an approval re-stamps) + the drift list. A system is CONSIDERED only if it is
 * ANCHORED (has both `paths` and a valid `syncedCommit`) — an unanchored/never-synced system is skipped
 * (it shows up in the bench, not as drift). PURE over `git`.
 */
export async function detectSystemDrift(
  repoRoot: string,
  systems: SystemDef[],
  git: GitRunner,
): Promise<{ head: string; drift: SystemDrift[] }> {
  const head = (await git(["rev-parse", "HEAD"], repoRoot)).trim();
  const drift: SystemDrift[] = [];
  for (const s of systems) {
    const paths = s.paths ?? [];
    if (paths.length === 0 || !s.syncedCommit || !SHA_RE.test(s.syncedCommit)) continue; // unanchored → skip
    if (s.syncedCommit === head) continue; // already at HEAD → can't have drifted
    let stdout: string;
    try {
      stdout = await git(["log", "--oneline", `${s.syncedCommit}..HEAD`, "--", ...paths], repoRoot);
    } catch {
      // The base SHA no longer resolves (history rewrite / pruned) → flag for a fresh re-sync from HEAD.
      drift.push({ systemId: s.id, name: s.name, prompt: s.prompt ?? "", paths, commits: [], baseInvalid: true });
      continue;
    }
    const commits = parseOnelineLog(stdout);
    if (commits.length > 0) {
      drift.push({ systemId: s.id, name: s.name, prompt: s.prompt ?? "", paths, commits });
    }
  }
  return { head, drift };
}
