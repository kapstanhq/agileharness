// «ARQUIVAR OS ANTIGOS» (onda 2, passo 6) — a parte PURA. O Inbox de 30+ dias vira ruído: um item parado há meses
// ainda empurra o que chegou hoje para baixo. O dono arquiva os antigos de uma vez — com confirmação, e REVERSÍVEL:
// cada card vai para o arquivo como ADIADO (o mesmo «Descontinuar → postergado» do card: nada é apagado, nenhum código
// sai), com um recibo e o «Desfazer: tirar do arquivo» dele. A ação de servidor (app/actions.ts) re-coleta o Inbox e
// arquiva só o que ESTA régua ainda aceita — a tela pode estar velha.

import { archivableStale, type InboxEntry } from "./entries";
import { quoted } from "./copy";

/** O que a tela pediu para arquivar. */
export interface StaleArchiveRequest {
  boardId: string;
  cardId: string;
}

/** Quantos itens um clique arquiva, no máximo (o botão nunca chega perto; o servidor não confia na tela). */
export const STALE_ARCHIVE_MAX = 200;

/**
 * O plano: dos pedidos, os que o Inbox ATUAL ainda dá como parados e arquiváveis — e o porquê de cada recusa. PURA.
 */
export function staleArchivePlan(
  requested: readonly StaleArchiveRequest[],
  current: readonly InboxEntry[],
): { archive: InboxEntry[]; refused: Array<StaleArchiveRequest & { reason: string }> } {
  const byCard = new Map(archivableStale(current).map((e) => [`${e.boardId}|${e.cardId}`, e]));
  const archive: InboxEntry[] = [];
  const refused: Array<StaleArchiveRequest & { reason: string }> = [];
  const seen = new Set<string>();
  for (const r of requested.slice(0, STALE_ARCHIVE_MAX)) {
    const k = `${r.boardId}|${r.cardId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const hit = byCard.get(k);
    if (hit) archive.push(hit);
    else refused.push({ ...r, reason: "não está mais parado no Inbox (alguém já decidiu, ou ele andou)" });
  }
  return { archive, refused };
}

/** O motivo que fica no card arquivado — o que o card mostra quando alguém o abre no arquivo. PURA. */
export function staleArchiveBrief(days: number): string {
  return `Arquivado pelo dono no Inbox («Arquivar os antigos»): estava parado há ${days} dias esperando uma decisão. Adiado, não descartado — dá para trazer de volta.`;
}

/** O recibo de um card arquivado. PURA. */
export function staleArchiveReceiptText(e: Pick<InboxEntry, "cardTitle">, days: number): string {
  return `${quoted(e.cardTitle)} foi para o arquivo (estava parado há ${days} dias).`;
}

/** O que o botão e a confirmação dizem. PURA. */
export function staleArchiveCopy(n: number): { line: string; button: string; title: string; body: string; done: string } {
  const itens = n === 1 ? "1 item" : `${n} itens`;
  return {
    line: `${n === 1 ? "1 item parado" : `${n} itens parados`} há mais de 30 dias`,
    button: "Arquivar os antigos",
    title: `Arquivar ${itens} parado${n === 1 ? "" : "s"}?`,
    body:
      `${n === 1 ? "O card sai" : "Os cards saem"} do Inbox e ${n === 1 ? "vai" : "vão"} para o arquivo como adiado${n === 1 ? "" : "s"} — nada é apagado. ` +
      "Dá para desfazer logo depois, em «Resolvido hoje», ou trazer cada um de volta pelo arquivo do board.",
    done: `${itens} ${n === 1 ? "foi" : "foram"} para o arquivo.`,
  };
}
