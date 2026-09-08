// Shared git/exec helpers for the autorun runner — the single home for the small PURE git plumbing
// that was copy-pasted across worktree.ts / merge-queue.ts / release.ts. B6 / the dedup pass.
// Behavior-neutral: each helper is byte-identical to the copies it replaces. Pure (zero imports) so
// anything can use it without pulling node:child_process.
//
// NOTE: `defaultExec` lives next to its `ExecFn` type in worktree.ts (one cast, one place) — the
// `GitExec` param of `makeGit` below is the structural shape of that same surface, kept local so this
// file stays import-free. `quote`/`execErrorDetail` are the two string helpers; `makeGit` (B6) is the
// `git(args)` wrapper factory that unifies merge-queue's `gitAt`/`git` and release's `git`.

/**
 * Quote a shell token (a path / branch / pathspec) by wrapping it in double quotes. The inputs here
 * are controlled (repo-relative paths, branch names, SHAs), so always-quote is sufficient. This is
 * the ALWAYS-quote variant shared by worktree/merge-queue/release; engine.ts keeps its own
 * `quoteArg` (conditional `/\s/`-based) which is a deliberately different policy.
 */
export function quote(token: string): string {
  return `"${token}"`;
}

/**
 * Best-effort human-readable detail from a failed exec/child-process error: prefer stderr, then
 * stdout, then message, then the stringified error itself, capped to `cap` chars. Callers keep their
 * own trailing fallback (`|| \`exit ${code}\``, `|| "secret-scan falhou"`, …) for the empty case.
 */
export function execErrorDetail(err: unknown, cap = 300): string {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return String(e?.stderr || e?.stdout || e?.message || err || "").slice(0, cap);
}

/** Result of one git invocation, with the exit code CAPTURED rather than thrown: a non-zero exit
 *  comes back as `ok:false` (code/stderr populated) instead of a reject. Shared by the merge train
 *  (merge-queue.ts) and the release promotion (release.ts). */
export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The minimal async exec surface {@link makeGit} drives — STRUCTURALLY an `ExecFn` (worktree.ts),
 *  declared locally so git.ts stays import-free. The default `ExecFn` is assignable to it. */
export type GitExec = (
  command: string,
  opts: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** A bound git runner: `git(args)` runs `git <args>` in the factory's default cwd; pass a 2nd arg to
 *  run in ANOTHER working tree (the Fase 4a split operates on the stage worktree too). NEVER throws —
 *  the exit comes back as a {@link GitResult}. */
export type GitRunner = (args: string, cwd?: string) => Promise<GitResult>;

/**
 * Build a {@link GitRunner} over an injected exec — THE single home for the `git <args>` wrapper that
 * was copy-pasted as release.ts's `git` and merge-queue.ts's `gitAt`/`git`. One try/catch maps a
 * thrown child-process error to a `GitResult`: `code` from `err.code`, `stdout`/`stderr` from the
 * error (falling back to `err.message`). Behavior-neutral — byte-identical to the merge-queue body
 * it replaces (release's copy lacked the always-unused `code`, a harmless superset here).
 */
export function makeGit(exec: GitExec, opts: { cwd: string; timeoutMs: number }): GitRunner {
  return async (args, cwd = opts.cwd) => {
    try {
      const { stdout, stderr } = await exec(`git ${args}`, { cwd, timeout: opts.timeoutMs });
      return { ok: true, code: 0, stdout, stderr };
    } catch (e: unknown) {
      const err = e as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
      return {
        ok: false,
        code: typeof err?.code === "number" ? err.code : null,
        stdout: typeof err?.stdout === "string" ? err.stdout : "",
        stderr: String(err?.stderr ?? err?.message ?? ""),
      };
    }
  };
}

/**
 * The robust, FAIL-OPEN `git push origin HEAD` shared by EVERY checkout writer that lands commits on a
 * shared branch (the merge train's `pushToOrigin`, the release promotion, and — story-apz8sa FIX 1 —
 * the engine's no-worktree board-data settle). Extracted here (B6 dedup) so the three callers can never
 * drift in their reconciliation behavior.
 *
 * Behavior — byte-identical to the merge-queue `pushToOrigin`/`reconcileWithOrigin` it replaces:
 *   1. `git push origin HEAD` (CUMULATIVE — carries every unpushed local commit, so a single failure is
 *      recovered by the NEXT successful push; the caller must treat a `false` as non-fatal).
 *   2. On a NON-fast-forward rejection (origin advanced — another checkout / a manual push landed commits
 *      this checkout lacks), RECONCILE: `git fetch origin <branch>` + `git merge --no-edit FETCH_HEAD`
 *      (MERGE, not rebase, so local commit SHAs — and any diff snapshots taken against them — stay valid),
 *      then retry the push ONCE. board data (main) and code (stage) touch DISJOINT paths across checkouts,
 *      so the merge auto-resolves clean in the common case. On any conflict/error during reconcile, ABORT
 *      (`git merge --abort`) to leave the tree pristine and DON'T retry — the cumulative next push recovers.
 *
 * NEVER throws and NEVER mutates the tree destructively on failure: the worst case is `{ pushed: false }`
 * with origin left behind by exactly this checkout's local commits, which the next push will carry.
 * `branch` (for the reconcile fetch) is read from `rev-parse --abbrev-ref HEAD`, defaulting to `main`.
 */
export async function pushHeadToOrigin(git: GitRunner): Promise<{ pushed: boolean; detail?: string }> {
  let pushed = await git(`push origin HEAD`);
  if (!pushed.ok) {
    const branch = (await git(`rev-parse --abbrev-ref HEAD`)).stdout.trim() || "main";
    const fetched = await git(`fetch origin ${quote(branch)}`);
    if (fetched.ok) {
      const merged = await git(`merge --no-edit FETCH_HEAD`);
      if (merged.ok) {
        pushed = await git(`push origin HEAD`); // retry after pulling origin's advance in
      } else {
        await git(`merge --abort`); // conflict/error → restore the pre-merge tip; origin reconciled by hand
      }
    }
  }
  if (pushed.ok) return { pushed: true };
  return { pushed: false, detail: (pushed.stderr || `exit ${pushed.code}`).slice(0, 200) };
}
