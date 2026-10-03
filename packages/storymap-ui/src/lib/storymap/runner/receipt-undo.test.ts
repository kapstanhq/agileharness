// O «Desfazer» de um recibo do Inbox (onda 2, passo 5) — o núcleo DI da ação de servidor, contra fakes: acha o
// recibo, confere a pré-condição no card FRESCO (sob o lock), aplica sem disparar a automação de entrada, e registra o
// próprio desfazer no ledger.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import type { InboxReceiptRecord } from "@/lib/storymap/inbox/receipts";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { parseInboxReceiptLines, serializeInboxReceipt } from "./receipts-log";
import { undoInboxReceipt, type ReceiptUndoDeps } from "./receipt-undo";

const config = {
  id: "b",
  name: "B",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "interview", name: "Entrevista", autorun: true },
    { id: "enriquecer", name: "Especificar" },
  ],
} as unknown as BoardConfig;

const cardA = coerceCard("story-a", { type: "story", title: "Busca por autor", status: "interview" }, "");
const accepted = (over: Partial<InboxReceiptRecord> = {}): InboxReceiptRecord => ({
  v: 1,
  id: "rc-1",
  at: "2026-09-28T19:00:00Z",
  board: "b",
  itemId: "story-a:review",
  cardId: "story-a",
  kind: "review",
  ask: "Aceitar «Busca por autor» como trabalho?",
  text: "«Busca por autor» foi para «Entrevista».",
  undo: { kind: "move-back", boardId: "b", cardId: "story-a", from: "interview", to: "triage", toStaging: true },
  ...over,
});

function world(receipts: InboxReceiptRecord[], cards: Card[]) {
  const state = { cards: cards.map((c) => ({ ...c })), log: [...receipts] };
  const transitions: Array<Record<string, unknown>> = [];
  const afterStatusChange = vi.fn(async () => {});
  const deps: ReceiptUndoDeps = {
    readReceipts: async () => state.log,
    readBoardConfig: async () => config,
    readCard: async (_b, id) => state.cards.find((c) => c.id === id) ?? null,
    updateCard: async (_b, id, fn) => {
      const i = state.cards.findIndex((c) => c.id === id);
      if (i < 0) return null;
      const next = fn(state.cards[i]);
      if (!next) return null;
      state.cards[i] = next;
      return next;
    },
    restoreCard: vi.fn(async () => ({ ok: true as const })),
    reviveCard: vi.fn(async () => ({ ok: true as const })),
    appendReceipt: async (r) => {
      state.log.push(r);
    },
    appendTransition: async (t) => {
      transitions.push(t);
    },
    afterStatusChange,
    now: () => Date.parse("2026-09-28T19:10:00Z"),
  };
  return { deps, state, transitions, afterStatusChange };
}

describe("undoInboxReceipt", () => {
  it("volta o card para onde estava, de volta ao dono, e registra o desfazer e a transição", async () => {
    const w = world([accepted()], [cardA]);
    const r = await undoInboxReceipt(w.deps, { board: "b", receiptId: "rc-1" });
    expect(r).toEqual({ ok: true, text: "«Busca por autor» voltou para «Triagem»." });
    expect(w.state.cards[0]).toMatchObject({ status: "triage", needsHumanReview: true });
    expect(w.state.log.at(-1)).toMatchObject({ undoOf: "rc-1", board: "b", itemId: "story-a:review", text: "«Busca por autor» voltou para «Triagem»." });
    expect(w.transitions).toEqual([expect.objectContaining({ from: "interview", to: "triage", actor: "human", note: "undo:inbox" })]);
    expect(w.afterStatusChange).toHaveBeenCalledOnce();
  });

  it("recusa no card FRESCO: o card andou depois do clique ⇒ nada muda, nada é registrado", async () => {
    const w = world([accepted()], [{ ...cardA, status: "enriquecer" }]);
    const r = await undoInboxReceipt(w.deps, { board: "b", receiptId: "rc-1" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/já andou/) });
    expect(w.state.log).toHaveLength(1);
    expect(w.state.cards[0].status).toBe("enriquecer");
  });

  it("desfazer duas vezes é recusado", async () => {
    const w = world([accepted()], [cardA]);
    await undoInboxReceipt(w.deps, { board: "b", receiptId: "rc-1" });
    w.state.cards[0] = { ...w.state.cards[0], status: "interview" };
    const again = await undoInboxReceipt(w.deps, { board: "b", receiptId: "rc-1" });
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/já foi desfeito/) });
  });

  it("o recibo de OUTRO board não é achado; o recibo sem desfazer diz isso", async () => {
    const w = world([accepted({ board: "outro" }), accepted({ id: "rc-2", undo: undefined })], [cardA]);
    expect(await undoInboxReceipt(w.deps, { board: "b", receiptId: "rc-1" })).toMatchObject({ ok: false, error: expect.stringMatching(/não achei/) });
    expect(await undoInboxReceipt(w.deps, { board: "b", receiptId: "rc-2" })).toMatchObject({ ok: false, error: expect.stringMatching(/não tem como desfazer/) });
  });

  it("o descarte volta da lixeira pela restauração da lixeira", async () => {
    const w = world([accepted({ undo: { kind: "restore-card", boardId: "b", cardId: "story-a" } })], [cardA]);
    const r = await undoInboxReceipt(w.deps, { board: "b", receiptId: "rc-1" });
    expect(r).toEqual({ ok: true, text: "«Busca por autor» voltou da lixeira." });
    expect(w.deps.restoreCard).toHaveBeenCalledWith("b", "story-a");
  });

  it("o aviso triado volta a ficar aberto", async () => {
    const withFinding = { ...cardA, findings: [{ id: "f1", lens: "general", severity: "low", status: "acknowledged", title: "t", detail: "d" }] } as Card;
    const w = world([accepted({ undo: { kind: "reopen-finding", boardId: "b", cardId: "story-a", findingId: "f1" } })], [withFinding]);
    const r = await undoInboxReceipt(w.deps, { board: "b", receiptId: "rc-1" });
    expect(r.ok).toBe(true);
    expect(w.state.cards[0].findings[0]).toMatchObject({ status: "open", statusBy: "human" });
    expect(w.transitions).toEqual([]);
  });
});

describe("o ledger dos recibos", () => {
  it("uma linha por recibo, e a leitura pula linha torta e filtra por board", () => {
    const raw = [serializeInboxReceipt(accepted()), "{torto\n", serializeInboxReceipt(accepted({ id: "rc-2", board: "outro" }))].join("");
    expect(parseInboxReceiptLines(raw).map((r) => r.id)).toEqual(["rc-1", "rc-2"]);
    expect(parseInboxReceiptLines(raw, { board: "b" }).map((r) => r.id)).toEqual(["rc-1"]);
  });
});
