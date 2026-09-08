// Per-key async mutex — serializes operations that share a key (e.g. every write to
// ONE card file) so an in-process read-modify-write can't interleave with a concurrent
// writer (a second server action, or the fs-watcher's cascade forward).
//
// Process-global (survives Next dev HMR via a Symbol store) so the autorun forward,
// the smart-capture commit and the server actions — loaded as separate modules —
// share ONE chain per card. Pure (no fs); the queue is strict FIFO and a rejected job
// never wedges the chain for that key.
//
// SCOPE: harness-* skills run as SEPARATE `claude` processes and edit the .md directly, so
// this lock does NOT serialize dev-server-vs-agent writes. The atomic rename in
// write.ts is what protects readers from a torn file across processes; this lock plus
// updateCardOnDisk's fresh re-read close the in-process window.

const KEY = Symbol.for("storymap.serialize.tails");
const store = globalThis as unknown as { [KEY]?: Map<string, Promise<unknown>> };

function tails(): Map<string, Promise<unknown>> {
  return (store[KEY] ??= new Map());
}

/**
 * Run `fn` after every previously-queued job for `key` has settled, and before any
 * later one — a FIFO mutex keyed by an arbitrary string. Returns fn's resolved value
 * (or propagates its throw) to the caller; a rejected job is swallowed by the internal
 * chain so it never blocks the next job on the same key.
 */
export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const map = tails();
  const prev = map.get(key) ?? Promise.resolve();
  // Run regardless of the prior job's outcome (both handlers → fn), so one failure
  // doesn't break the whole queue.
  const run = prev.then(fn, fn);
  // The tail the next caller chains onto — never rejects (errors surface only to the
  // job's own caller via `run`).
  const tail = run.then(
    () => {},
    () => {},
  );
  map.set(key, tail);
  // Best-effort GC: once this is the live tail and it settles, drop the entry so the
  // map can't grow unbounded across thousands of distinct card keys.
  void tail.then(() => {
    if (map.get(key) === tail) map.delete(key);
  });
  return run;
}
