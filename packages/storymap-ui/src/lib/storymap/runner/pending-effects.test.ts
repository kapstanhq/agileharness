import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PendingEffects,
  diskPendingEffectStore,
  recoverPendingEffects,
  type PendingEffectEntry,
  type PendingEffectStore,
} from "./pending-effects";
import type { EntryEffect } from "@/lib/storymap/types";

// story-harness-adk A5: the forward↔onEnter transactional ledger. Tested at three layers — the
// in-memory record/resolve logic, the atomic disk store, and the boot re-fire decision.

const entry = (o: Partial<PendingEffectEntry> = {}): PendingEffectEntry => ({
  board: "storymap",
  cardId: "c1",
  effect: "promote-stage" as EntryEffect,
  status: "release",
  recordedAt: 1,
  ...o,
});

function memStore(initial: PendingEffectEntry[] = []): PendingEffectStore & { dump: () => PendingEffectEntry[] } {
  let data = [...initial];
  return {
    load: async () => [...data],
    persist: async (entries) => {
      data = [...entries];
    },
    dump: () => [...data],
  };
}

describe("PendingEffects — record / resolve lifecycle", () => {
  it("record makes the effect pending AND persists it", async () => {
    const store = memStore();
    const pe = new PendingEffects(store);
    await pe.record(entry());
    await pe.flush();
    expect(await pe.loadPending()).toHaveLength(1);
    expect(store.dump()).toHaveLength(1);
  });

  it("resolve drops it (and is a no-op when already gone)", async () => {
    const pe = new PendingEffects(memStore());
    await pe.record(entry());
    await pe.resolve("storymap", "c1", "promote-stage" as EntryEffect);
    await pe.flush();
    expect(await pe.loadPending()).toHaveLength(0);
    await expect(pe.resolve("storymap", "c1", "promote-stage" as EntryEffect)).resolves.toBeUndefined();
  });

  it("keys by board/card/effect — same key upserts, a different effect is a distinct entry", async () => {
    const pe = new PendingEffects(memStore());
    await pe.record(entry({ recordedAt: 1 }));
    await pe.record(entry({ recordedAt: 2 })); // same key → upsert
    await pe.record(entry({ effect: "deploy-board" as EntryEffect })); // different effect → new entry
    const pending = await pe.loadPending();
    expect(pending).toHaveLength(2);
    expect(pending.find((e) => e.effect === "promote-stage")?.recordedAt).toBe(2);
  });

  it("merges a record that lands during the initial load (never clobbers it)", async () => {
    const store = memStore([entry({ cardId: "fromDisk" })]);
    const pe = new PendingEffects(store);
    await pe.record(entry({ cardId: "fresh" }));
    expect((await pe.loadPending()).map((e) => e.cardId).sort()).toEqual(["fresh", "fromDisk"]);
  });
});

describe("diskPendingEffectStore — atomic, versioned, tolerant", () => {
  let dir: string;
  const file = () => path.join(dir, "pending-effects.json");
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "pendfx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persist → load round-trips the entries", async () => {
    const store = diskPendingEffectStore(dir);
    await store.persist([entry(), entry({ cardId: "c2", effect: "deploy-board" as EntryEffect })]);
    expect(await store.load()).toHaveLength(2);
  });

  it("absent / unreadable file loads clean (never throws)", async () => {
    expect(await diskPendingEffectStore(dir).load()).toEqual([]);
  });

  it("drops a foreign version wholesale (never feeds an unknown schema to a re-fire)", async () => {
    writeFileSync(file(), JSON.stringify({ version: 999, entries: [entry()] }), "utf8");
    expect(await diskPendingEffectStore(dir).load()).toEqual([]);
  });

  it("drops a structurally-malformed entry but keeps the valid siblings", async () => {
    writeFileSync(
      file(),
      JSON.stringify({ version: 1, entries: [entry(), { board: "x" /* missing fields */ }] }),
      "utf8",
    );
    expect(await diskPendingEffectStore(dir).load()).toHaveLength(1);
  });

  it("persisted file carries the version envelope", async () => {
    await diskPendingEffectStore(dir).persist([entry()]);
    expect(JSON.parse(readFileSync(file(), "utf8")).version).toBe(1);
  });
});

describe("recoverPendingEffects — one-shot boot re-fire", () => {
  const deps = (over: Partial<Parameters<typeof recoverPendingEffects>[0]> = {}) => {
    const runEffect = vi.fn(async () => {});
    const resolve = vi.fn(async () => {});
    return {
      runEffect,
      resolve,
      base: {
        enabled: true,
        loadPending: async () => [entry()],
        cardExists: async () => true,
        runEffect,
        resolve,
        ...over,
      },
    };
  };

  it("re-fires the effect (THREADING the cardId) and resolves it when the card still exists", async () => {
    const { base, runEffect, resolve } = deps();
    const summary = await recoverPendingEffects(base);
    expect(summary).toMatchObject({ pending: 1, refired: 1, dropped: 0, skipped: 0 });
    // the cardId rides along so a deploy re-fired on boot can still revert THAT card on failure (G3)
    expect(runEffect).toHaveBeenCalledWith("promote-stage", "storymap", "c1");
    expect(resolve).toHaveBeenCalledWith("storymap", "c1", "promote-stage");
  });

  it("drops (without re-firing) but still resolves when the card is gone", async () => {
    const { base, runEffect, resolve } = deps({ cardExists: async () => false });
    const summary = await recoverPendingEffects(base);
    expect(summary).toMatchObject({ pending: 1, refired: 0, dropped: 1 });
    expect(runEffect).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledOnce(); // one-shot: cleared even when not re-fired
  });

  it("when autorun/resume is OFF it skips everything — never fires, never clears", async () => {
    const { base, runEffect, resolve } = deps({ enabled: false });
    const summary = await recoverPendingEffects(base);
    expect(summary).toMatchObject({ pending: 1, refired: 0, skipped: 1 });
    expect(runEffect).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("no pending → a clean no-op summary", async () => {
    const { base } = deps({ loadPending: async () => [] });
    expect(await recoverPendingEffects(base)).toMatchObject({ pending: 0, refired: 0, dropped: 0, skipped: 0, deferred: 0 });
  });

  it("DEFERS (no re-fire) a NOT-boot-safe product deploy but still clears it one-shot", async () => {
    const { base, runEffect, resolve } = deps({
      loadPending: async () => [entry({ board: "acme", effect: "promote-and-deploy" as EntryEffect })],
      // acme's deploy is a production orch-deploy → not boot-safe.
      isBootSafe: async () => false,
    });
    const summary = await recoverPendingEffects(base);
    expect(summary).toMatchObject({ pending: 1, refired: 0, dropped: 0, deferred: 1 });
    expect(runEffect).not.toHaveBeenCalled(); // production deploy NEVER auto-fires on boot
    expect(resolve).toHaveBeenCalledOnce(); // one-shot: cleared so it doesn't re-log every boot
  });

  it("still re-fires a boot-safe effect when isBootSafe returns true", async () => {
    const { base, runEffect } = deps({ isBootSafe: async () => true });
    const summary = await recoverPendingEffects(base);
    expect(summary).toMatchObject({ refired: 1, deferred: 0 });
    expect(runEffect).toHaveBeenCalledOnce();
  });

  // WS1.4 — a re-fire that THROWS is no longer swallowed: it's counted (failed) and reported via
  // onRefireFailure (a finding on the card), while still resolved one-shot (never re-deploy every boot).
  it("re-fire that THROWS → failed++, onRefireFailure called with the error, still resolved one-shot", async () => {
    const boom = new Error("deploy exploded");
    const onRefireFailure = vi.fn(async () => {});
    const { base, resolve } = deps({
      runEffect: vi.fn(async () => {
        throw boom;
      }),
      onRefireFailure,
    });
    const summary = await recoverPendingEffects(base);
    expect(summary).toMatchObject({ pending: 1, refired: 0, failed: 1 });
    expect(onRefireFailure).toHaveBeenCalledWith("promote-stage", "storymap", "c1", boom);
    expect(resolve).toHaveBeenCalledOnce(); // one-shot: cleared even on failure (never loop a re-deploy)
  });

  it("re-fire that throws with NO onRefireFailure dep → still counts failed, never crashes (legacy silent)", async () => {
    const { base, resolve } = deps({
      runEffect: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    const summary = await recoverPendingEffects(base);
    expect(summary).toMatchObject({ failed: 1, refired: 0 });
    expect(resolve).toHaveBeenCalledOnce();
  });
});
