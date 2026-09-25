// v0.9 — resolveDeliveryAuditAction, pelo escritor único (updateCardOnDisk): só uma auditoria de entrega PENDENTE
// fecha; Confirmar mantém; Reabrir pede o motivo e devolve a story pelo refino (com o finding e os efeitos de
// uma reabertura de verdade: o salto no ledger e a cascata).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card } from "@/lib/storymap/types";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { state, appendTransition, evaluateAutorunOnEntry } = vi.hoisted(() => ({
  state: { card: null as unknown as Card },
  appendTransition: vi.fn(async () => {}),
  evaluateAutorunOnEntry: vi.fn(async () => {}),
}));

const config: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do", autorun: true },
    { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed", autorun: false },
    { id: "concluida", name: "No ar", terminal: true, delivered: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  autonomy: { mode: "ultra" },
};

vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/repo")>()),
  readCard: async () => state.card,
  readBoardConfig: async () => config,
}));
vi.mock("@/lib/storymap/write", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/write")>()),
  updateCardOnDisk: async (_b: string, _id: string, mutate: (c: Card) => Card | null) => {
    const next = mutate(state.card);
    if (next) state.card = next;
    return next;
  },
}));
vi.mock("@/lib/storymap/runner/transitions", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/runner/transitions")>()),
  appendTransition,
}));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry }));
vi.mock("@/lib/storymap/runner/merge-queue", () => ({ getMergeQueue: () => ({ reconcileCardMergeEntries: async () => {} }) }));

import { resolveDeliveryAuditAction } from "./actions";
import { coerceCard } from "@/lib/storymap/repo";

beforeEach(() => {
  appendTransition.mockClear();
  evaluateAutorunOnEntry.mockClear();
  state.card = coerceCard("story-x", { type: "story", status: "concluida", title: "X", deliveryAudit: { sampledAt: "2026-09-25", deliveredIn: "concluida" } }, "");
});

describe("resolveDeliveryAuditAction", () => {
  it("Confirmar fecha a auditoria; confirmar de novo é recusado (já fechada)", async () => {
    const r = await resolveDeliveryAuditAction({ boardId: "b", cardId: "story-x", outcome: "confirmed" });
    expect(r.ok).toBe(true);
    expect(state.card.deliveryAudit).toMatchObject({ outcome: "confirmed" });
    expect(state.card.status).toBe("concluida");
    expect(appendTransition).not.toHaveBeenCalled();
    expect((await resolveDeliveryAuditAction({ boardId: "b", cardId: "story-x", outcome: "confirmed" })).ok).toBe(false);
  });

  it("Reabrir sem motivo é recusado e não escreve nada", async () => {
    const before = state.card;
    const r = await resolveDeliveryAuditAction({ boardId: "b", cardId: "story-x", outcome: "reopened", note: "" });
    expect(r.ok).toBe(false);
    expect(state.card).toBe(before);
  });

  it("Reabrir com motivo: a story volta pelo refino com o finding, e a reabertura é um salto real (ledger + cascata)", async () => {
    const r = await resolveDeliveryAuditAction({ boardId: "b", cardId: "story-x", outcome: "reopened", note: "o filtro some" });
    expect(r.ok).toBe(true);
    expect(state.card).toMatchObject({ status: "desenvolver", mode: "refine", reopenPending: true });
    expect(state.card.findings?.[0]).toMatchObject({ id: "delivery-audit", status: "open", detail: "o filtro some" });
    expect(appendTransition).toHaveBeenCalledWith(expect.objectContaining({ from: "concluida", to: "desenvolver", actor: "human", note: "reopen:delivery-audit" }));
    expect(evaluateAutorunOnEntry).toHaveBeenCalledWith("b", "story-x");
  });
});
