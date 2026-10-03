// Shared test helper for the real-git integration suites (release.test.ts, split-integration.test.ts).
//
// WHY this exists — the worktree-fragility these suites hit in the merge train's integration gate:
// the gate runs `vitest run` INSIDE a `git worktree add` staging tree (makeDefaultGateRunner in
// merge-queue.ts). Two things differ from the main checkout there, and BOTH made these suites
// false-fail (freezing every code-change card's merge-back):
//
//  1) runnerStateDir() is ABSENT. release.ts / merge-queue.ts's split path write their patch files to
//     runnerStateDir() = <findRepoRoot()>/storymap/.runner (a host path, resolved from the vitest
//     process cwd — NOT the test's temp repo). In production the runner boot (journal.persist) creates
//     that dir before any merge/release runs; the main checkout also has it because the live storymap
//     service created it. A fresh gate worktree has neither → the `git diff … > patchfile` redirect
//     can't create the file → `git apply` sees a missing patch → release reports "não aplicou limpo"
//     and the split returns "conflict". So the suite must ensure the dir exists, exactly as the
//     production runner boot does (ensureRunnerStateDir below).
//
//  2) The host/outer git context can LEAK into the temp repo's git ops. The temp repo is `git init`ed
//     under os.tmpdir(), but git still reads the user's global/system config and — worse — could resolve
//     an unexpected toplevel by walking up the directory tree. isolatedGitExec injects a fully clean,
//     self-contained git env (no global/system config, a throwaway HOME, ceiling dirs so discovery can
//     never escape the temp tree) and a generous maxBuffer, so the suite behaves identically whether
//     vitest's cwd is the main checkout or a nested worktree.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { ExecFn } from "./worktree";

/**
 * Ensure the runner state dir (where release/split write their patch files) exists — the one piece of
 * production-boot setup these direct-drive integration tests would otherwise skip. Idempotent. Returns
 * the path so a test can also clean it up if it wants. See reason (1) in the file header.
 */
export async function ensureRunnerStateDir(): Promise<string> {
  const dir = runnerStateDir();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Wrap a base ExecFn so every git command the production code drives runs in a fully ISOLATED git
 * environment — independent of the user's global/system config and of any OUTER worktree the vitest
 * process happens to sit inside. See reason (2) in the file header.
 *
 * - GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM = os.devNull + GIT_CONFIG_NOSYSTEM=1 → ignore host config.
 * - HOME = a throwaway dir → no `~/.gitconfig`, no credential helpers.
 * - GIT_CEILING_DIRECTORIES = the temp repo's PARENT → repo discovery can never walk up past it into
 *   the host checkout's / outer worktree's `.git`.
 * - maxBuffer is raised so a large `git diff` (the split/release patch capture) never trips ENOBUFS.
 *
 * The returned fn preserves the `{ cwd, timeout }` the product passes through and merges the isolated
 * env on top of process.env. `ceilingDir` should be the temp root that contains the test's repo.
 */
export function isolatedGitExec(base: ExecFn, ceilingDir: string): ExecFn {
  const isolatedHome = path.join(ceilingDir, ".gitenv-home");
  const env = {
    ...process.env,
    HOME: isolatedHome,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: ceilingDir,
    GIT_TERMINAL_PROMPT: "0",
  };
  return ((command, opts) =>
    // base is promisify(exec); the extra { env, maxBuffer } ride through to child_process.exec.
    (base as unknown as (c: string, o: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>)(
      command,
      { ...opts, env, maxBuffer: 64 * 1024 * 1024 },
    )) as ExecFn;
}
