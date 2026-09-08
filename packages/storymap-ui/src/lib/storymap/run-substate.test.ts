import { describe, expect, it } from "vitest";
import { DONE_TTL_MS, REDRIVING_TTL_MS, RUN_SUBSTATE_VIEW, resolveRunSubstate, type RunSubstateKind } from "./run-substate";
import type { MergeQueueSnapshot, RunnerSnapshot } from "./runner/types";

const NOW = 1_700_000_000_000;
const B = "storymap";
const C = "story-x";

const emptySnap: RunnerSnapshot = { running: [], failures: [] };

function run(extra: Partial<RunnerSnapshot["running"][number]> = {}): RunnerSnapshot["running"][number] {
  return { board: B, cardId: C, trigger: "harness-do", startedAt: NOW - 3000, sessionId: "s1", ...extra };
}
function entry(status: MergeQueueSnapshot["entries"][number]["status"], extra: Partial<MergeQueueSnapshot["entries"][number]> = {}) {
  return { runId: "r1", board: B, cardId: C, branch: "run/s1", status, enqueuedAt: NOW - 5000, ...extra } as MergeQueueSnapshot["entries"][number];
}

describe("resolveRunSubstate", () => {
  it("returns null when nothing is live", () => {
    expect(resolveRunSubstate(B, C, emptySnap, null, NOW)).toBeNull();
    expect(resolveRunSubstate(B, C, null, null, NOW)).toBeNull();
  });

  it("running wins over everything", () => {
    const snap: RunnerSnapshot = { running: [run()], failures: [{ board: B, cardId: C, trigger: "harness-do", reason: "exit", at: NOW }] };
    const mq: MergeQueueSnapshot = { entries: [entry("merging")], processing: true };
    const s = resolveRunSubstate(B, C, snap, mq, NOW);
    expect(s?.kind).toBe("running");
    expect(s?.since).toBe(NOW - 3000);
  });

  it("merging when a merge-queue entry is merging", () => {
    const mq: MergeQueueSnapshot = { entries: [entry("merging", { mergeStartedAt: NOW - 1000 })], processing: true };
    const s = resolveRunSubstate(B, C, emptySnap, mq, NOW);
    expect(s?.kind).toBe("merging");
    expect(s?.since).toBe(NOW - 1000);
  });

  it("conflict for both conflict and gate-failed", () => {
    const c1 = resolveRunSubstate(B, C, emptySnap, { entries: [entry("conflict")], processing: false }, NOW);
    expect(c1?.kind).toBe("conflict");
    const c2 = resolveRunSubstate(B, C, emptySnap, { entries: [entry("gate-failed")], processing: false }, NOW);
    expect(c2?.kind).toBe("conflict");
    expect(c2?.detail).toBe("gate falhou");
  });

  it("waiting with queue position", () => {
    const mq: MergeQueueSnapshot = {
      entries: [
        { runId: "other", board: B, cardId: "z", branch: "run/o", status: "waiting", enqueuedAt: NOW - 9000 },
        entry("waiting", { enqueuedAt: NOW - 5000 }),
      ],
      processing: false,
    };
    const s = resolveRunSubstate(B, C, emptySnap, mq, NOW);
    expect(s?.kind).toBe("waiting");
    expect(s?.detail).toBe("#2 na fila");
  });

  it("error (snapshot.failures) ranks above merge-queue failed", () => {
    const snap: RunnerSnapshot = { running: [], failures: [{ board: B, cardId: C, trigger: "harness-do", reason: "timeout", at: NOW - 2000, detail: "timeout" }] };
    const mq: MergeQueueSnapshot = { entries: [entry("failed")], processing: false };
    const s = resolveRunSubstate(B, C, snap, mq, NOW);
    expect(s?.kind).toBe("error");
    expect(s?.detail).toBe("timeout");
  });

  it("failed when a merge-queue entry failed", () => {
    const s = resolveRunSubstate(B, C, emptySnap, { entries: [entry("failed", { failureReason: "branch sumiu" })], processing: false }, NOW);
    expect(s?.kind).toBe("failed");
    expect(s?.detail).toBe("branch sumiu");
  });

  it("failed only while recent (within TTL) — an old merge failure stops painting the badge", () => {
    const recent = resolveRunSubstate(B, C, emptySnap, { entries: [entry("failed", { mergeEndedAt: NOW - 1000 })], processing: false }, NOW);
    expect(recent?.kind).toBe("failed");
    const stale = resolveRunSubstate(B, C, emptySnap, { entries: [entry("failed", { mergeEndedAt: NOW - DONE_TTL_MS - 1 })], processing: false }, NOW);
    expect(stale).toBeNull();
  });

  it("done only while recent (within TTL)", () => {
    const recent = resolveRunSubstate(B, C, emptySnap, { entries: [entry("done", { mergeEndedAt: NOW - 1000 })], processing: false }, NOW);
    expect(recent?.kind).toBe("done");
    const stale = resolveRunSubstate(B, C, emptySnap, { entries: [entry("done", { mergeEndedAt: NOW - DONE_TTL_MS - 1 })], processing: false }, NOW);
    expect(stale).toBeNull();
  });

  it("ignores entries for other cards/boards", () => {
    const mq: MergeQueueSnapshot = { entries: [entry("merging", { cardId: "other" })], processing: true };
    expect(resolveRunSubstate(B, C, emptySnap, mq, NOW)).toBeNull();
  });

  // 2026-07-16: "Integrando · 325m" sobre um re-drive que NUNCA spawnou, com a fila de merge vazia. Os dois
  // estavam certos — `re-driving` é TERMINAL na fila, e o badge o dobrava em "merging" apostando que o frame
  // `running` do re-run assumiria "numa janela BREVE". O frame nunca veio e nada mais corrigiria o badge.
  describe("re-driving — o TTL que faltava (o badge não pode contar para sempre)", () => {
    const redriving = (ageMs: number) => ({
      entries: [entry("re-driving", { mergeStartedAt: NOW - ageMs })],
      processing: false,
    }) as MergeQueueSnapshot;

    it("dentro da janela ainda lê como Integrando (a suposição do fold segue válida no caso normal)", () => {
      const s = resolveRunSubstate(B, C, emptySnap, redriving(REDRIVING_TTL_MS - 1_000), NOW);
      expect(s?.kind).toBe("merging");
      expect(s?.label).toBe("Integrando");
    });

    it("PASSADO o TTL vira Travou e NOMEIA o que houve — em vez de contar para sempre", () => {
      const s = resolveRunSubstate(B, C, emptySnap, redriving(REDRIVING_TTL_MS + 1_000), NOW);
      expect(s?.kind).toBe("error");
      expect(s?.detail).toContain("re-drive não apareceu");
      expect(s?.since).toBe(NOW - (REDRIVING_TTL_MS + 1_000)); // o relógio segue contando desde a origem real
    });

    it("o frame `running` do re-drive VENCE o TTL (é a prioridade 1: chegou, logo não encalhou)", () => {
      const snap: RunnerSnapshot = { running: [run()], failures: [] };
      const s = resolveRunSubstate(B, C, snap, redriving(REDRIVING_TTL_MS + 60_000), NOW);
      expect(s?.kind).toBe("running"); // o desfecho normal, mesmo com a entry velha
    });

    it("um `merging` DE VERDADE nunca expira: é entry VIVA que o train segura agora", () => {
      const mq = { entries: [entry("merging", { mergeStartedAt: NOW - (REDRIVING_TTL_MS + 60_000) })], processing: true } as MergeQueueSnapshot;
      expect(resolveRunSubstate(B, C, emptySnap, mq, NOW)?.kind).toBe("merging");
    });
  });

  it("every kind has a label, colour, rail and icon", () => {
    const kinds: RunSubstateKind[] = ["running", "merging", "conflict", "waiting", "error", "failed", "done"];
    for (const k of kinds) {
      const v = RUN_SUBSTATE_VIEW[k];
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.colorCls).toMatch(/text-/);
      expect(v.railCls).toMatch(/bg-/);
      expect(v.iconName.length).toBeGreaterThan(0);
    }
  });
});
