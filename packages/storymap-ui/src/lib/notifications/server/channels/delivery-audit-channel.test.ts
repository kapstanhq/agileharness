// O canal que observa as CHEGADAS a um status de entrega e, por amostra, carimba a auditoria do dono. Com fakes: o
// board, o card, o ledger de transições e o escritor único (que re-julga sob o lock).

import { describe, expect, it, vi } from "vitest";
import { auditDeliveryArrival, createDeliveryAuditChannel, type DeliveryAuditDeps } from "./delivery-audit-channel";
import { auditDraw } from "@/lib/storymap/autonomy";
import { deliveryAuditKey } from "@/lib/storymap/delivery-audit";
import type { Transition } from "@/lib/storymap/runner/transitions";
import type { AgileHarnessEvent } from "../../event";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const config = (mode: "ultra" | "human" = "ultra"): BoardConfig => ({
  id: "b",
  name: "B",
  statuses: [
    { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed", autorun: false },
    { id: "merge", name: "Integrar", autorun: true },
    { id: "concluida", name: "No ar", terminal: true, delivered: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  autonomy: { mode },
});

const ids = Array.from({ length: 200 }, (_, i) => `story-${i}`);
const SAMPLED = ids.find((id) => auditDraw(deliveryAuditKey("b", id)) < 0.2)!;
const UNSAMPLED = ids.find((id) => auditDraw(deliveryAuditKey("b", id)) >= 0.2)!;

function world(cardId: string, opts: { mode?: "ultra" | "human"; transitions?: Partial<Transition>[] } = {}) {
  const state = { card: { id: cardId, type: "story", title: "T", status: "concluida", findings: [] } as unknown as Card };
  const deps: DeliveryAuditDeps = {
    readBoardConfig: vi.fn(async () => config(opts.mode)),
    readCard: vi.fn(async () => state.card),
    readTransitions: vi.fn(async () => (opts.transitions ?? []) as Transition[]),
    updateCardOnDisk: vi.fn(async (_b: string, _id: string, mutate: (c: Card) => Card | null) => {
      const next = mutate(state.card);
      if (next) state.card = next;
      return next;
    }),
    today: () => "2026-09-25",
    log: () => {},
  };
  return { state, deps };
}

const moved = (cardId: string, toStatus = "concluida"): AgileHarnessEvent => ({ id: "1", type: "card.moved", boardId: "b", cardId, toStatus, at: 0 });

describe("auditDeliveryArrival", () => {
  it("chegada a 'No ar' de uma story ultra, autônoma e amostrada ⇒ auditoria pendente no card", async () => {
    const { state, deps } = world(SAMPLED, { transitions: [{ at: "2026-09-25T00:00:00Z", from: "revisao", actor: "run:orch" }] });
    expect(await auditDeliveryArrival(deps, moved(SAMPLED))).toBe(true);
    expect(state.card.deliveryAudit).toEqual({ sampledAt: "2026-09-25", deliveredIn: "concluida" });
  });

  it("uma segunda entrega do mesmo evento (o watcher reentregou) não carimba de novo", async () => {
    const { state, deps } = world(SAMPLED);
    await auditDeliveryArrival(deps, moved(SAMPLED));
    const first = state.card.deliveryAudit;
    expect(await auditDeliveryArrival(deps, moved(SAMPLED))).toBe(false);
    expect(state.card.deliveryAudit).toBe(first);
  });

  it("fora da amostra, modo human, ou o dono aprovou ⇒ nada escrito", async () => {
    for (const w of [
      world(UNSAMPLED),
      world(SAMPLED, { mode: "human" }),
      world(SAMPLED, { transitions: [{ at: "2026-09-25T00:00:00Z", from: "revisao", actor: "human" }] }),
    ]) {
      expect(await auditDeliveryArrival(w.deps, moved(w.state.card.id))).toBe(false);
      expect(w.deps.updateCardOnDisk).not.toHaveBeenCalled();
      expect(w.state.card.deliveryAudit).toBeUndefined();
    }
  });

  it("chegada a um status que NÃO é de entrega nem lê o card (o caso comum sai barato); outros eventos são ignorados", async () => {
    const { deps } = world(SAMPLED);
    expect(await auditDeliveryArrival(deps, moved(SAMPLED, "merge"))).toBe(false);
    expect(await auditDeliveryArrival(deps, { ...moved(SAMPLED), type: "card.updated" })).toBe(false);
    expect(deps.readCard).not.toHaveBeenCalled();
  });

  it("o escritor RE-JULGA sob o lock: um card que saiu de 'No ar' no meio do caminho não é carimbado", async () => {
    const { state, deps } = world(SAMPLED);
    deps.updateCardOnDisk = vi.fn(async (_b, _id, mutate) => mutate({ ...state.card, status: "revisao" }));
    expect(await auditDeliveryArrival(deps, moved(SAMPLED))).toBe(false);
  });

  it("o canal nunca lança (um board ilegível não derruba o dispatcher)", async () => {
    const { deps } = world(SAMPLED);
    deps.readBoardConfig = async () => {
      throw new Error("yaml");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(createDeliveryAuditChannel(deps).notify(moved(SAMPLED))).resolves.toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });
});
