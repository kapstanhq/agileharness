// O canal que observa as CHEGADAS a um status de entrega e, por amostra, carimba a auditoria do dono. Com fakes: o
// board, o card, o ledger de transições e o escritor único (que re-julga sob o lock).

import { describe, expect, it, vi } from "vitest";
import { auditDeliveryArrival, createDeliveryAuditChannel, type DeliveryAuditDeps } from "./delivery-audit-channel";
import { auditDraw } from "@/lib/storymap/autonomy";
import { deliveryAuditKey, technicalAuditKey } from "@/lib/storymap/delivery-audit";
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

// Toda entrega que chega ao ar SEM o dono aprovar (só-negócio, caminho autônomo) entra no
// registro de decisões do sistema, amostrada ou não, com o «Desfazer» (reabrir).
describe("auditDeliveryArrival — o registro da entrega sem aprovação do dono", () => {
  it("autônoma em ultra ⇒ registrada (amostrada ou não); aprovada pelo dono ou human ⇒ não", async () => {
    for (const id of [SAMPLED, UNSAMPLED]) {
      const { deps } = world(id);
      const recordDecision = vi.fn(async () => {});
      await auditDeliveryArrival({ ...deps, recordDecision }, moved(id));
      expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ kind: "delivery-skip", cardId: id, undo: { kind: "reopen-card", cardId: id, deliveredIn: "concluida" } }));
    }
    const owner = world(UNSAMPLED, { transitions: [{ at: "2026-09-25T00:00:00Z", from: "revisao", actor: "human" }] });
    const r1 = vi.fn(async () => {});
    await auditDeliveryArrival({ ...owner.deps, recordDecision: r1 }, moved(UNSAMPLED));
    expect(r1).not.toHaveBeenCalled();
    const human = world(UNSAMPLED, { mode: "human" });
    const r2 = vi.fn(async () => {});
    await auditDeliveryArrival({ ...human.deps, recordDecision: r2 }, moved(UNSAMPLED));
    expect(r2).not.toHaveBeenCalled();
  });

  // Fase 6 (6D): «verificador» só quando o verificador lançado pelo serviço rodou e aprovou ESTA mudança.
  it("sem o veredito do verificador a entrega é «auto-certificada»; com ele, «verifier»", async () => {
    const { deps } = world(UNSAMPLED);
    const self = vi.fn(async () => {});
    await auditDeliveryArrival({ ...deps, recordDecision: self, verifiedDelivery: async () => null }, moved(UNSAMPLED));
    expect(self).toHaveBeenCalledWith(expect.objectContaining({ kind: "delivery-skip", agent: "auto-certificada", what: expect.stringMatching(/auto-certificada/) }));
    const noDep = vi.fn(async () => {});
    await auditDeliveryArrival({ ...deps, recordDecision: noDep }, moved(UNSAMPLED));
    expect(noDep).toHaveBeenCalledWith(expect.objectContaining({ agent: "auto-certificada" }));
    const verified = vi.fn(async () => {});
    await auditDeliveryArrival({ ...deps, recordDecision: verified, verifiedDelivery: async () => ({ runId: "r-v", model: "sonnet" }) }, moved(UNSAMPLED));
    expect(verified).toHaveBeenCalledWith(expect.objectContaining({ kind: "delivery-skip", agent: "verifier", why: expect.stringMatching(/verificador independente/) }));
  });
});

describe("a entrega TÉCNICA sorteada vai ao auditor independente, nunca ao dono (grill 2, D)", () => {
  it("entra na fila do auditor com a mudança do card; nada é carimbado", async () => {
    const id = ids.find((x) => auditDraw(technicalAuditKey("b", x)) < 0.2)!;
    const { state, deps } = world(id);
    const range = { base: "a".repeat(40), head: "b".repeat(40) };
    state.card = { ...state.card, storyType: "technical", commitRange: range } as Card;
    const startTechnicalAudit = vi.fn(async () => ({}));
    expect(await auditDeliveryArrival({ ...deps, startTechnicalAudit }, moved(id))).toBe(false);
    expect(startTechnicalAudit).toHaveBeenCalledWith(expect.objectContaining({ board: "b", cardId: id, range }));
    expect(state.card.deliveryAudit).toBeUndefined();
    expect(deps.updateCardOnDisk).not.toHaveBeenCalled();
  });
});
