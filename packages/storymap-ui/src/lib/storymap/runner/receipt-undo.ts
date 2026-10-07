// O «DESFAZER» de um recibo do Inbox (onda 2, passo 5) — núcleo DI da ação de servidor `undoInboxReceiptAction` (as
// deps de produção moram na ação). A mesma ordem do desfazer de uma decisão do sistema (decision-undo.ts):
//   1. acha o recibo no ledger (deste board; nunca uma linha de desfazer) e vê se já foi desfeito;
//   2. confere a pré-condição no card FRESCO, SOB o lock — um card que andou depois do clique não é atropelado;
//   3. aplica (no card, na lixeira ou no arquivo) — um movimento de volta NÃO dispara a automação de entrada: é o
//      estado de antes, não uma entrada nova (a mesma regra do `isUndo` de moveCardAction);
//   4. registra o próprio desfazer no ledger (`undoOf`), e a transição quando o status mudou.

import { applyReceiptUndoToCard, receiptUndoRefusal, undoneText, type InboxReceiptRecord } from "@/lib/storymap/inbox/receipts";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { newInboxReceiptId } from "./receipts-log";

export interface ReceiptUndoDeps {
  readReceipts(board: string): Promise<InboxReceiptRecord[]>;
  readBoardConfig(board: string): Promise<BoardConfig>;
  readCard(board: string, cardId: string): Promise<Card | null>;
  /** o escritor único: `fn` recebe o card FRESCO sob o lock; null = não escreve. */
  updateCard(board: string, cardId: string, fn: (fresh: Card) => Card | null): Promise<Card | null>;
  restoreCard(board: string, cardId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  reviveCard(board: string, cardId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  appendReceipt(r: InboxReceiptRecord): Promise<void>;
  appendTransition?(t: { board: string; cardId: string; from: string | null; to: string; actor: "human"; note: string }): Promise<void>;
  /** depois de uma mudança de status: a fila do train (best-effort) — nunca a automação de entrada. */
  afterStatusChange?(board: string, cardId: string): Promise<void>;
  /**
   * Fase 6 (6D) — depois de voltar um MOVIMENTO (`move-back`): desfaz só o que aquele movimento (`forward`) disparou — o
   * run que nasceu com ele, o despacho do condutor que ainda não virou sessão — e avisa o condutor vivo
   * (card-intents-deps.ts `undoForwardMoveEffects`). Best-effort.
   */
  undoMoveEffects?(board: string, card: Card, forward: { from: string; to: string }): Promise<unknown>;
  now?(): number;
}

export type ReceiptUndoResult = { ok: true; text: string } | { ok: false; error: string };

/** Desfaz o recibo `receiptId` do board. Nunca lança — toda recusa volta com o motivo em português. */
export async function undoInboxReceipt(deps: ReceiptUndoDeps, input: { board: string; receiptId: string }): Promise<ReceiptUndoResult> {
  try {
    const records = await deps.readReceipts(input.board);
    const receipt = records.find((r) => r.id === input.receiptId && r.board === input.board && !r.undoOf);
    if (!receipt) return { ok: false, error: "não achei este recibo neste board" };
    const u = receipt.undo;
    if (!u) return { ok: false, error: "esta ação não tem como desfazer" };
    const undone = records.some((r) => r.undoOf === receipt.id);
    const config = await deps.readBoardConfig(input.board);
    const nowMs = (deps.now ?? Date.now)();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const record = (text: string) =>
      deps.appendReceipt({
        v: 1,
        id: newInboxReceiptId(),
        at: new Date(nowMs).toISOString(),
        board: input.board,
        itemId: receipt.itemId,
        ...(receipt.cardId ? { cardId: receipt.cardId } : {}),
        kind: receipt.kind,
        ask: receipt.ask,
        text,
        undoOf: receipt.id,
      });

    const early = receiptUndoRefusal(u, { config, card: u.kind === "restore-card" ? null : await deps.readCard(input.board, u.cardId), undone });
    if (early) return { ok: false, error: early };

    if (u.kind === "restore-card" || u.kind === "revive-card") {
      const r = u.kind === "restore-card" ? await deps.restoreCard(input.board, u.cardId) : await deps.reviveCard(input.board, u.cardId);
      if (!r.ok) return r;
      const text = undoneText(u, await deps.readCard(input.board, u.cardId).catch(() => null), config);
      await record(text);
      return { ok: true, text };
    }

    let refused: string | null = null;
    let from: string | null = null;
    const written = await deps.updateCard(input.board, u.cardId, (fresh) => {
      refused = receiptUndoRefusal(u, { config, card: fresh, undone });
      if (refused) return null;
      from = fresh.status ?? null;
      return applyReceiptUndoToCard(u, fresh, { today });
    });
    if (refused) return { ok: false, error: refused };
    if (!written) return { ok: false, error: "o card não existe mais neste board" };
    if (written.status && written.status !== from) {
      await deps.appendTransition?.({ board: input.board, cardId: u.cardId, from, to: written.status, actor: "human", note: "undo:inbox" }).catch(() => {});
      if (u.kind === "move-back") await deps.undoMoveEffects?.(input.board, written, { from: u.to, to: u.from })?.catch(() => {});
      await deps.afterStatusChange?.(input.board, u.cardId).catch(() => {});
    }
    const text = undoneText(u, written, config);
    await record(text);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
