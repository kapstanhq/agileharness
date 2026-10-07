// O RECIBO do que o dono fez pelo Inbox, e o «RESOLVIDO HOJE» (decisão do operador). PURO (zero IO; o ledger em
// disco mora em runner/receipts-log.ts).
//
// Antes, o clique respondia «Aceitar: ok» e o item sumia; reabrindo o link, a página dizia «pode já ter sido resolvido
// — ou o link pode estar quebrado». Agora cada ação do dono pelo Inbox deixa um recibo durável: o que foi decidido, o
// que aconteceu, e — quando a ação volta atrás — como desfazer. O «Resolvido hoje» junta os três jeitos de um item sair
// do Inbox nas últimas 24 horas, para um item que sumiu SEMPRE ter um desfecho à vista:
//   • o que o DONO fez (os recibos, com «Desfazer» quando reversível);
//   • o que o SISTEMA decidiu hoje (o registro system-decisions.jsonl — com o «Desfazer» dele);
//   • o que um PRAZO decidiu (o pedido de um agente que venceu, a proposta de PRD que venceu).

import type { BoardConfig, Card, GovernanceDraft } from "../types";
import type { ApprovalRequest } from "../approvals";
import { GOVERNANCE_DRAFT_TTL_DAYS, isGovernanceDraftStale } from "../governance";
import { agentLabel, undoLabel, type FollowUpItem } from "../system-decisions";
import type { ReceiptUndo } from "./decision";
import { clip, quoted } from "./copy";

/** Uma linha do ledger dos recibos. `undoOf` marca a linha que DESFEZ outra. */
export interface InboxReceiptRecord {
  v: 1;
  id: string;
  /** ISO — quando. */
  at: string;
  board: string;
  /** o item do Inbox que a ação resolveu. */
  itemId: string;
  cardId?: string;
  /** o kind do item (para a página de um item ausente dizer do que se tratava). */
  kind: string;
  /** a decisão como o dono a leu («Aceitar «X» como trabalho?»). */
  ask: string;
  /** o que aconteceu (««X» foi para «Entrevista»; o agente começou.»). */
  text: string;
  /** como desfazer — só nas ações reversíveis. */
  undo?: ReceiptUndo;
  /** numa linha de desfazer: o recibo que ela desfez. */
  undoOf?: string;
}

/** O que a pré-condição de um «Desfazer» precisa ver: o card FRESCO e o board. */
export interface ReceiptUndoContext {
  config: Pick<BoardConfig, "statuses">;
  card: Card | null | undefined;
  undone: boolean;
}

/** Por que este «Desfazer» não pode rodar agora — ou null. A MESMA régua do botão e do servidor. PURA. */
export function receiptUndoRefusal(undo: ReceiptUndo, ctx: ReceiptUndoContext): string | null {
  if (ctx.undone) return "isto já foi desfeito";
  if (undo.kind === "restore-card") return null; // a lixeira tem a própria recusa (restaurado, vencido)
  const card = ctx.card;
  if (!card) return "o card não existe mais neste board";
  const where = ctx.config.statuses.find((s) => s.id === card.status)?.name ?? card.status ?? "—";
  switch (undo.kind) {
    case "move-back":
      if (!ctx.config.statuses.some((s) => s.id === undo.to)) return "a etapa de antes não existe mais no board";
      return card.status === undo.from ? null : `o card já andou depois disso (está em «${where}») — desfazer agora atropelaria o trabalho`;
    case "reopen-finding": {
      const f = card.findings?.find((x) => x.id === undo.findingId);
      if (!f) return "o aviso não existe mais no card";
      return f.status === "open" ? "o aviso já está aberto" : null;
    }
    case "revive-card":
      return card.mode === "retire" && card.retirement?.disposition === "postergado" ? null : "o card não está mais arquivado";
  }
}

/** O que um «Desfazer» de recibo faz NO CARD (as variantes que mexem nele; lixeira e arquivo são IO da ação). Chame
 *  {@link receiptUndoRefusal} antes, sobre o mesmo card. PURA. */
export function applyReceiptUndoToCard(
  undo: Extract<ReceiptUndo, { kind: "move-back" } | { kind: "reopen-finding" }>,
  card: Card,
  opts: { today: string },
): Card {
  if (undo.kind === "reopen-finding") {
    return { ...card, findings: card.findings.map((f) => (f.id === undo.findingId ? { ...f, status: "open" as const, statusBy: "human", statusAt: opts.today } : f)) };
  }
  if (!undo.toStaging) return { ...card, status: undo.to };
  // de volta à Triagem: o card é do dono de novo — `hold` impede o juiz de re-aceitar por cima do desfazer.
  return { ...card, status: undo.to, needsHumanReview: true, triageDecision: { verdict: "hold", reason: "você desfez o aceite no Inbox", by: "human", at: opts.today } };
}

/** O que o recibo do desfazer diz. PURA. */
export function undoneText(undo: ReceiptUndo, card: Pick<Card, "title"> | null | undefined, config: Pick<BoardConfig, "statuses">): string {
  const title = card?.title ? quoted(card.title) : "O card";
  switch (undo.kind) {
    case "move-back":
      return `${title} voltou para «${config.statuses.find((s) => s.id === undo.to)?.name ?? undo.to}».`;
    case "restore-card":
      // um descarte em grupo volta inteiro: o card e o que tinha ido junto com ele
      return `${title} voltou da lixeira${undo.group ? ", com o que tinha ido junto" : ""}.`;
    case "reopen-finding":
      return `O aviso de ${title} foi reaberto.`;
    case "revive-card":
      return `${title} saiu do arquivo.`;
  }
}

const RECEIPT_UNDO_KINDS = new Set<ReceiptUndo["kind"]>(["move-back", "restore-card", "reopen-finding", "revive-card"]);
const idOk = (s: unknown, max = 200): s is string => typeof s === "string" && s.length > 0 && s.length <= max && !/[\n\r]/.test(s);

/**
 * O pedido de gravar um recibo, validado: vem do navegador, então nada entra no ledger sem forma — o «Desfazer» de um
 * recibo é executado pelo servidor depois, e só pode apontar para o MESMO board. PURA. `null` = recusado.
 */
export function receiptFromInput(
  input: { boardId: string; itemId: string; cardId?: string | null; kind: string; ask: string; text: string; undo?: ReceiptUndo | null },
  meta: { id: string; at: string },
): InboxReceiptRecord | null {
  if (!idOk(input.boardId, 100) || !idOk(input.itemId, 400) || !idOk(input.kind, 60)) return null;
  if (typeof input.ask !== "string" || typeof input.text !== "string" || !input.text.trim()) return null;
  if (input.cardId != null && !idOk(input.cardId)) return null;
  const u = input.undo ?? null;
  if (u) {
    if (!RECEIPT_UNDO_KINDS.has(u.kind) || u.boardId !== input.boardId || !idOk(u.cardId)) return null;
    if (u.kind === "move-back" && (!idOk(u.from) || !idOk(u.to))) return null;
    if (u.kind === "reopen-finding" && !idOk(u.findingId)) return null;
  }
  const undo: ReceiptUndo | null = !u
    ? null
    : u.kind === "move-back"
      ? { kind: "move-back", boardId: u.boardId, cardId: u.cardId, from: u.from, to: u.to, ...(u.toStaging ? { toStaging: true } : {}) }
      : u.kind === "reopen-finding"
        ? { kind: "reopen-finding", boardId: u.boardId, cardId: u.cardId, findingId: u.findingId }
        : u.kind === "restore-card"
          ? { kind: "restore-card", boardId: u.boardId, cardId: u.cardId, ...(u.group === true ? { group: true } : {}) }
          : { kind: u.kind, boardId: u.boardId, cardId: u.cardId };
  return {
    v: 1,
    id: meta.id,
    at: meta.at,
    board: input.boardId,
    itemId: input.itemId,
    ...(input.cardId ? { cardId: input.cardId } : {}),
    kind: input.kind,
    ask: clip(input.ask, 300),
    text: clip(input.text, 400),
    ...(undo ? { undo } : {}),
  };
}

/** O rótulo do «Desfazer» de um recibo — diz o que ele faz. PURA. */
export function receiptUndoLabel(undo: ReceiptUndo): string {
  switch (undo.kind) {
    case "move-back":
      return undo.toStaging ? "Desfazer: voltar à Triagem" : "Desfazer: voltar para onde estava";
    case "restore-card":
      return undo.group ? "Desfazer: restaurar todos da lixeira" : "Desfazer: restaurar da lixeira";
    case "reopen-finding":
      return "Desfazer: reabrir o aviso";
    case "revive-card":
      return "Desfazer: tirar do arquivo";
  }
}

/** Os ids dos recibos já desfeitos, com quando. PURA. */
export function undoneReceipts(records: readonly InboxReceiptRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records) if (r.undoOf) out.set(r.undoOf, r.at);
  return out;
}

/** O recibo mais novo de um item (não o de desfazer) — o desfecho que a página de um item ausente mostra. PURA. */
export function latestReceiptFor(records: readonly InboxReceiptRecord[], board: string, itemId: string): InboxReceiptRecord | null {
  let best: InboxReceiptRecord | null = null;
  for (const r of records) {
    if (r.undoOf || r.board !== board || r.itemId !== itemId) continue;
    if (!best || r.at > best.at) best = r;
  }
  return best;
}

/** Um desfecho do dia — uma linha de «Resolvido hoje». */
export interface ResolvedEntry {
  key: string;
  boardId: string;
  boardName: string;
  /** ISO — quando. */
  at: string;
  /** quem resolveu: você, o sistema (e qual agente), ou um prazo. */
  who: "voce" | "sistema" | "prazo";
  /** «Você», «Juiz da triagem», «Prazo». */
  whoLabel: string;
  /** o que aconteceu, numa frase. */
  what: string;
  /** a decisão que ele resolveu, quando se sabe. */
  ask?: string;
  itemId?: string;
  cardId?: string;
  /** o «Desfazer» — o recibo do dono ou a decisão do sistema. */
  /** `reopens` = reabrir uma entrega: o «Desfazer» roda já com o motivo padrão (REOPEN_DEFAULT_NOTE), um clique como no item. */
  undo?: { source: "receipt" | "system"; id: string; label: string; reopens?: boolean };
  /** quando foi desfeito (o desfecho segue na lista, dizendo que voltou atrás). */
  undoneAt?: string;
}

/** Um pedido de agente ou uma proposta de PRD que venceu — o que um PRAZO decidiu. */
export interface ExpiredFact {
  boardId: string;
  /** ISO — quando venceu. */
  at: string;
  itemId: string;
  cardId?: string;
  what: string;
}

/** A janela de «Resolvido hoje». */
export const RESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * O que um PRAZO decidiu num board: o pedido de um agente que venceu sem resposta (24 horas) e a proposta de PRD que
 * venceu (14 dias). Os dois saem do Inbox sozinhos — sem esta linha, sumiriam sem desfecho. PURA.
 */
export function expiredFacts(input: {
  boardId: string;
  approvals: readonly Pick<ApprovalRequest, "id" | "status" | "cardId" | "expiresAt" | "decidedAt">[];
  drafts: readonly Pick<GovernanceDraft, "id" | "status" | "createdAt" | "origin">[];
  cardTitle: (cardId: string) => string | undefined;
  now: number;
}): ExpiredFact[] {
  const out: ExpiredFact[] = [];
  for (const a of input.approvals) {
    // vencido SEM resposta: um pedido autorizado que venceu sem uso não é desfecho do prazo (o dono já disse sim)
    if (a.status !== "expired" || a.decidedAt || !a.expiresAt) continue;
    const title = a.cardId ? input.cardTitle(a.cardId) : undefined;
    out.push({
      boardId: input.boardId,
      at: a.expiresAt,
      itemId: `apr:${a.id}`,
      ...(a.cardId ? { cardId: a.cardId } : {}),
      what: `O pedido de um agente${title ? ` sobre ${quoted(title)}` : ""} venceu sem resposta — o agente seguiu sem fazer.`,
    });
  }
  for (const d of input.drafts) {
    if (!isGovernanceDraftStale(d, input.now)) continue;
    const born = Date.parse(`${d.createdAt}T00:00:00Z`);
    out.push({
      boardId: input.boardId,
      at: new Date(born + GOVERNANCE_DRAFT_TTL_DAYS * RESOLVED_WINDOW_MS).toISOString(),
      itemId: `gov:${d.id}`,
      ...(d.origin?.cardId ? { cardId: d.origin.cardId } : {}),
      what: `Uma proposta de mudança no PRD e nas metas venceu depois de ${GOVERNANCE_DRAFT_TTL_DAYS} dias sem resposta — nada mudou.`,
    });
  }
  return out;
}

/**
 * «Resolvido hoje»: os desfechos das últimas 24 horas — os recibos do dono, as decisões do sistema de hoje e o que um
 * prazo decidiu —, o mais novo primeiro. PURA.
 */
export function resolvedToday(input: {
  receipts: readonly InboxReceiptRecord[];
  /** as decisões do sistema de cada board (followUpItems — já com o que foi desfeito). */
  decisions: readonly FollowUpItem[];
  expired: readonly ExpiredFact[];
  boardName: (boardId: string) => string;
  now: number;
}): ResolvedEntry[] {
  const since = new Date(input.now - RESOLVED_WINDOW_MS).toISOString();
  const undone = undoneReceipts(input.receipts);
  const out: ResolvedEntry[] = [];
  for (const r of input.receipts) {
    if (r.undoOf || r.at < since) continue;
    const undoneAt = undone.get(r.id);
    out.push({
      key: `r:${r.id}`,
      boardId: r.board,
      boardName: input.boardName(r.board),
      at: r.at,
      who: "voce",
      whoLabel: "Você",
      what: r.text,
      ask: r.ask,
      itemId: r.itemId,
      ...(r.cardId ? { cardId: r.cardId } : {}),
      ...(r.undo && !undoneAt ? { undo: { source: "receipt" as const, id: r.id, label: receiptUndoLabel(r.undo) } } : {}),
      ...(undoneAt ? { undoneAt } : {}),
    });
  }
  for (const d of input.decisions) {
    if (d.at < since) continue;
    out.push({
      key: `s:${d.id}`,
      boardId: d.board,
      boardName: input.boardName(d.board),
      at: d.at,
      who: "sistema",
      whoLabel: agentLabel(d.agent),
      what: d.why ? `${d.what} — por quê: ${d.why}` : d.what,
      ...(d.cardId ? { cardId: d.cardId } : {}),
      ...(d.undoable && d.undo ? { undo: { source: "system" as const, id: d.id, label: undoLabel(d.undo), ...(d.undo.kind === "reopen-card" ? { reopens: true } : {}) } } : {}),
      ...(d.undoneAt ? { undoneAt: d.undoneAt } : {}),
    });
  }
  for (const x of input.expired) {
    if (x.at < since || x.at > new Date(input.now).toISOString()) continue;
    out.push({ key: `p:${x.itemId}`, boardId: x.boardId, boardName: input.boardName(x.boardId), at: x.at, who: "prazo", whoLabel: "Prazo", what: x.what, itemId: x.itemId, ...(x.cardId ? { cardId: x.cardId } : {}) });
  }
  return out.sort((a, z) => z.at.localeCompare(a.at));
}
