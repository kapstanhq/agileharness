import { describe, expect, it } from "vitest";
import { withKeyedLock } from "./serialize";

// A keyed FIFO mutex underpins the card write-lock: same-key jobs never overlap (so a
// read-modify-write can't interleave), different keys run concurrently, and a rejected
// job never wedges the queue.
describe("withKeyedLock — per-key FIFO mutex", () => {
  const tracer = (events: string[]) => (id: string, ms: number) => async () => {
    events.push(`${id}:start`);
    await new Promise((r) => setTimeout(r, ms));
    events.push(`${id}:end`);
  };

  it("serializes same-key jobs with no overlap, in FIFO order", async () => {
    const events: string[] = [];
    const job = tracer(events);
    // `a` is slow, `b` is fast — but `b` must still wait for `a` to fully finish.
    const p1 = withKeyedLock("same", job("a", 30));
    const p2 = withKeyedLock("same", job("b", 1));
    await Promise.all([p1, p2]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs different keys concurrently (they interleave)", async () => {
    const events: string[] = [];
    const job = tracer(events);
    await Promise.all([withKeyedLock("k1", job("a", 25)), withKeyedLock("k2", job("b", 1))]);
    // Both start before either ends; the fast one (b) finishes first → truly concurrent.
    expect(events.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
    expect(events.indexOf("b:end")).toBeLessThan(events.indexOf("a:end"));
  });

  it("returns the job's value and propagates its throw to the caller", async () => {
    await expect(withKeyedLock("ret", async () => 42)).resolves.toBe(42);
    await expect(
      withKeyedLock("ret", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("a rejected job does not wedge later jobs on the same key", async () => {
    await withKeyedLock("resilient", async () => {
      throw new Error("x");
    }).catch(() => {});
    await expect(withKeyedLock("resilient", async () => "ok")).resolves.toBe("ok");
  });
});
