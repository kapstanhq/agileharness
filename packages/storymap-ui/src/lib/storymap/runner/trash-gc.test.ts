import { describe, expect, it } from "vitest";
import { runTrashGc, TRASH_GC_AFTER_DAYS } from "./trash-gc";
import type { TrashManifest } from "@/lib/storymap/types";

// autonomo-liberdade-humana M2 — the GC prunes ONLY entries past the 7-day window, and never sooner. Fully
// injected (no filesystem): the ageing decision is real (trashAgeDays), the IO is fakes.

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-07-18T00:00:00Z");
const mk = (id: string, ageDays: number): TrashManifest => ({ kind: "card", id, by: "agent", at: new Date(now - ageDays * day).toISOString() });

describe("runTrashGc (M2)", () => {
  it("coleta SÓ o que passou da janela de 7 dias; preserva o resto", async () => {
    const removed: string[] = [];
    const entries = [mk("old-8", 8), mk("edge-7", 7), mk("fresh-1", 1)];
    const harvested = await runTrashGc({
      now,
      boards: async () => [{ id: "acme" }],
      list: async () => entries,
      remove: async (_b, m) => void removed.push(m.id),
      journal: async () => {},
    });
    expect(harvested).toBe(2); // old-8 e edge-7 (>= 7); fresh-1 fica
    expect(removed.sort()).toEqual(["edge-7", "old-8"]);
  });

  it("board sem lixeira ⇒ 0, sem crash", async () => {
    const harvested = await runTrashGc({ now, boards: async () => [{ id: "vazio" }], list: async () => [], remove: async () => {}, journal: async () => {} });
    expect(harvested).toBe(0);
  });

  it("uma falha de remoção não derruba o GC (best-effort por entrada)", async () => {
    let calls = 0;
    const harvested = await runTrashGc({
      now,
      boards: async () => [{ id: "acme" }],
      list: async () => [mk("a", 10), mk("b", 10)],
      remove: async () => {
        calls += 1;
        if (calls === 1) throw new Error("fs hiccup");
      },
      journal: async () => {},
    });
    expect(harvested).toBe(1); // a segunda ainda foi coletada
  });

  it("a janela é 7 dias (o mesmo horizonte do branch-gc)", () => {
    expect(TRASH_GC_AFTER_DAYS).toBe(7);
  });
});
