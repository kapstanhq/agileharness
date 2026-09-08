import { beforeEach, describe, expect, it } from "vitest";
import { clearSerializerState, serialCommit, type CommitSerializer } from "./commit-serializer";

// The store is process-global → clear it between tests so a pending chain never leaks.
beforeEach(() => clearSerializerState());

// A controllable async task: it records when it STARTS and exposes a resolver so a test can
// hold it open and prove the next same-cwd commit waited (didn't start) until this one settled.
function deferred(label: string, log: string[]) {
  let resolveFn!: (v?: unknown) => void;
  let rejectFn!: (e: unknown) => void;
  const gate = new Promise((res, rej) => {
    resolveFn = res as (v?: unknown) => void;
    rejectFn = rej;
  });
  const fn = () => {
    log.push(`start:${label}`);
    return gate.then(() => {
      log.push(`end:${label}`);
      return label;
    });
  };
  return { fn, resolve: () => resolveFn(), reject: (e: unknown) => rejectFn(e) };
}

describe("serialCommit — same-cwd serialization (AC1)", () => {
  it("runs commits on the SAME cwd one at a time, in call order (the 2nd never starts until the 1st settles)", async () => {
    const log: string[] = [];
    const a = deferred("a", log);
    const b = deferred("b", log);

    const pa = serialCommit("/repo", a.fn);
    const pb = serialCommit("/repo", b.fn);

    // Let microtasks run: only `a` may have started — `b` is queued behind it.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["start:a"]); // b has NOT started — serialized behind a

    a.resolve();
    await pa;
    // Let the chain's `.catch().then()` hops schedule b before asserting it started.
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toContain("start:b"); // a settled → b now runs

    b.resolve();
    await pb;
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]); // strictly serial, in order
  });

  it("preserves FIFO across three same-cwd commits", async () => {
    const order: string[] = [];
    const mk = (label: string) => () =>
      new Promise<string>((res) => setTimeout(() => res(label), 0)).then((l) => {
        order.push(l);
        return l;
      });
    await Promise.all([serialCommit("/repo", mk("1")), serialCommit("/repo", mk("2")), serialCommit("/repo", mk("3"))]);
    expect(order).toEqual(["1", "2", "3"]);
  });
});

describe("serialCommit — distinct-cwd parallelism (AC2)", () => {
  it("does NOT serialize commits on DIFFERENT cwds — they overlap", async () => {
    const log: string[] = [];
    const a = deferred("a", log);
    const b = deferred("b", log);

    // Different cwds (the main tree vs. a run worktree) → independent chains.
    serialCommit("/repo", a.fn);
    serialCommit("/repo/.worktrees/run-x", b.fn);

    await Promise.resolve();
    await Promise.resolve();
    // BOTH started despite `a` still being open — no cross-cwd serialization.
    expect(log).toContain("start:a");
    expect(log).toContain("start:b");

    a.resolve();
    b.resolve();
  });
});

describe("serialCommit — failure handling", () => {
  it("propagates fn's rejection to the caller (so the caller knows its own commit failed)", async () => {
    await expect(serialCommit("/repo", async () => Promise.reject(new Error("index.lock")))).rejects.toThrow(
      "index.lock",
    );
  });

  it("ADVANCES the chain past a rejected commit — a later same-cwd commit still runs (never wedged)", async () => {
    const failing = serialCommit("/repo", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    // The chain must not be stuck on the rejection: the next commit on the SAME cwd still resolves.
    const after = await serialCommit("/repo", async () => "ok");
    expect(after).toBe("ok");
  });
});

describe("clearSerializerState — test isolation", () => {
  it("a cleared state starts a fresh chain (no leftover predecessor blocks a new commit)", async () => {
    // Leave a never-resolving commit pending on /repo, then clear → a new commit must not wait on it.
    void serialCommit("/repo", () => new Promise(() => {}));
    clearSerializerState();
    const result = await serialCommit("/repo", async () => "fresh");
    expect(result).toBe("fresh");
  });
});

describe("CommitSerializer — type is satisfied by serialCommit (DI contract)", () => {
  it("serialCommit is assignable to the injectable CommitSerializer shape", async () => {
    const injected: CommitSerializer = serialCommit;
    expect(await injected("/repo", async () => 42)).toBe(42);
  });
});
