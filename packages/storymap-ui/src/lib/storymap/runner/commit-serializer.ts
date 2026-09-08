// Commit serializer — the per-cwd mutex shared by BOTH board-commit boundaries of the
// autorun pipeline (story-ms5rmt, finding f-concurrency-indexlock).
//
// Two independent code paths commit onto the SAME main working tree:
//   - boundary 1 (engine.ts): the HEAD=estado board commit a run does on `main` BEFORE
//     creating its worktree, so the fresh checkout is born from the live board state;
//   - boundary 2 (merge-queue.ts): the `commitAllPending` the merge train runs on `main`
//     BEFORE a `git merge --no-ff`, so a dirty tree never falsely aborts the merge.
//
// Each commit is `git add -A` + `git commit` on the shared `.git/index`, so a run STARTING
// while the train is MERGING can collide on `.git/index.lock` (`fatal: Unable to create
// '.git/index.lock'`). The engine's old `boardCommitChain` serialized only start-vs-start
// (one engine instance's field) — it could not see the merge queue. This module PROMOTES the
// primitive to a process-global store keyed by absolute cwd, so both boundaries enqueue onto
// the SAME chain when they target the SAME tree (cwd === repoRoot) and stay PARALLEL when they
// target distinct worktrees (separate index → no contention).
//
// SERVER-ONLY (it only orders git I/O). Process-global, mirroring the singletons in
// engine.ts / merge-queue.ts / registry.ts (survives Next dev HMR).

// Map<absCwd, Promise<unknown>> — the tail of each cwd's serial chain. The stored value is a
// SETTLED-or-pending predecessor promise; resolving it lets the next caller's commit run. The
// value is GC'd once it resolves. Both boundaries only ever commit the MAIN tree (cwd === repoRoot)
// — per-worktree commits never route through here — so in practice the keyspace is a single entry
// (the distinct repoRoots in the process), and the Map never grows unbounded.
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` (a commit on `cwd`'s tree) AFTER every previously-enqueued commit on the SAME `cwd`
 * has settled — serializing access to that tree's `.git/index`. Commits on DISTINCT cwds never
 * wait on each other (distinct chains), preserving the parallelism worktree isolation exists to
 * give. The returned promise REJECTS if `fn` rejects (the caller must learn its own commit failed
 * — the engine aborts the run, the merge queue logs and proceeds); the chain still ADVANCES past a
 * rejection (the stored predecessor swallows it), so one failed commit never wedges the cwd.
 */
export function serialCommit<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(cwd) ?? Promise.resolve();
  // Wait for the predecessor (ignoring its outcome) before running ours.
  const next = prev.catch(() => {}).then(() => fn());
  // The successor waits on a SWALLOWED copy so a rejection here never blocks the next caller.
  chains.set(cwd, next.catch(() => {}));
  return next;
}

/**
 * Clear all serial chains. Test-isolation utility ONLY — production never calls it (the store is a
 * process-global). Use it in `beforeEach` so one test's pending chain can't leak into the next.
 */
export function clearSerializerState(): void {
  chains.clear();
}

/** The injectable shape of {@link serialCommit} (DI — engine + merge-queue accept a fake in tests). */
export type CommitSerializer = <T>(cwd: string, fn: () => Promise<T>) => Promise<T>;
