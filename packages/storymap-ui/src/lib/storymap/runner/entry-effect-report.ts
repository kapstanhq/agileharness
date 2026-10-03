// O RELATÓRIO de um efeito de entrada que roda depois do clique.
//
// moveCardAction/updateCardAction/republishCardAction e a cascata disparam o efeito do passo (promote-stage /
// deploy-board / promote-and-deploy) e seguem: o efeito roda solto. Antes, uma recusa ou um erro dele morriam no
// log do serviço — o dono lia «ok» e o card ficava parado sem nada vermelho. Aqui o efeito é
// embrulhado: o que ele devolve (ou lança) vira um FATO durável no card — o finding `entry-effect-failed`, com o
// motivo em português — e a próxima vez que ele roda limpo o resolve. O que projeta o fato no Inbox é o item
// `effect-failed` (demands.ts).
//
// SERVER-ONLY (escreve o card). Best-effort: o relatório nunca derruba o efeito nem quem o chamou — e o erro do
// efeito SEGUE para quem chamou (a recuperação de boot conta com ele para manter o efeito pendente).

import { updateCardOnDisk } from "@/lib/storymap/write";
import { readBoardConfig } from "@/lib/storymap/repo";
import {
  buildEntryEffectFailedFinding,
  entryEffectRefusal,
  withEntryEffectFailure,
  withEntryEffectResolved,
} from "@/lib/storymap/entry-effect-failure";
import type { BoardConfig, Card, EntryEffect } from "@/lib/storymap/types";

export interface EntryEffectReportDeps {
  readConfig(board: string): Promise<BoardConfig | null>;
  write(board: string, cardId: string, mutate: (card: Card) => Card | null): Promise<unknown>;
  /** YYYY-MM-DD */
  today(): string;
}

const defaultDeps: EntryEffectReportDeps = {
  readConfig: (board) => readBoardConfig(board).catch(() => null),
  write: (board, cardId, mutate) => updateCardOnDisk(board, cardId, mutate),
  today: () => new Date().toISOString().slice(0, 10),
};

/**
 * Roda `run` (o efeito `effect` do card `cardId`) e reporta: recusa ou erro ⇒ finding aberto com o motivo; rodou
 * limpo ⇒ resolve a falha anterior (se houver). Devolve o resultado do efeito; RE-LANÇA o erro dele.
 */
export async function runReportedEntryEffect(
  effect: EntryEffect,
  boardId: string,
  cardId: string | undefined,
  run: () => Promise<unknown>,
  deps: EntryEffectReportDeps = defaultDeps,
): Promise<unknown> {
  let result: unknown;
  try {
    result = await run();
  } catch (err) {
    if (cardId) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportFailure(effect, boardId, cardId, `erro inesperado — ${msg}`, deps);
    }
    throw err;
  }
  if (!cardId) return result;
  const refusal = entryEffectRefusal(effect, result);
  if (refusal) await reportFailure(effect, boardId, cardId, refusal, deps);
  else await reportSuccess(boardId, cardId, deps);
  return result;
}

async function reportFailure(effect: EntryEffect, boardId: string, cardId: string, reason: string, deps: EntryEffectReportDeps): Promise<void> {
  try {
    const config = await deps.readConfig(boardId);
    await deps.write(boardId, cardId, (card) => {
      const stepName =
        config?.statuses.find((s) => s.id === card.status)?.name ?? config?.statuses.find((s) => s.onEnter === effect)?.name ?? card.status ?? "?";
      const next = withEntryEffectFailure(card.findings ?? [], buildEntryEffectFailedFinding(effect, stepName, reason));
      return next ? { ...card, findings: next } : null;
    });
    console.error(`[entry-effect ${boardId}/${cardId}] ${effect} NÃO rodou: ${reason}`);
  } catch (err) {
    console.error(`[entry-effect ${boardId}/${cardId}] relatório da falha de ${effect} não gravou:`, err instanceof Error ? err.message : err);
  }
}

async function reportSuccess(boardId: string, cardId: string, deps: EntryEffectReportDeps): Promise<void> {
  try {
    await deps.write(boardId, cardId, (card) => {
      const next = withEntryEffectResolved(card.findings ?? [], "system:efeito-rodou", deps.today());
      return next ? { ...card, findings: next } : null;
    });
  } catch (err) {
    console.error(`[entry-effect ${boardId}/${cardId}] resolver a falha anterior não gravou:`, err instanceof Error ? err.message : err);
  }
}
