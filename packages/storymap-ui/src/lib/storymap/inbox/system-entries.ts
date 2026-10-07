// As decisões do SISTEMA como entradas do Inbox (política só-negócio): o que o sistema decidiu em nome do dono entra em
// Acompanhar com o quê, quem, por quê e o «Desfazer». PURO; lido pelo coletor (collect.ts) — fica fora de entries.ts
// porque o registro (system-decisions.ts) arrasta módulos de servidor que a tela do Inbox não precisa carregar.
//
// A POLÍTICA DE ACOMPANHAR (C8 do ciclo de conserto). Acompanhar chegou a acumular dezenas de linhas: decisões do sistema sobre cards
// já no ar, «Desfazer» que o servidor recusaria no clique, a mesma entrega contada duas vezes. Acompanhar não é
// log: mostra o que o dono COMBINOU rever — o aceite da triagem de uma história de usuário (o veto prometido a ele) —
// com um «Desfazer» que ainda funciona; e o trabalho do sistema em andamento (os itens vivos). Todo o resto é REGISTRO:
// a página «Acompanhar» do board (/board/<b>/acompanhar), onde cada decisão segue com o porquê e o «Desfazer».

import { agentLabel, undoLabel, undoRefusal, type FollowUpItem } from "../system-decisions";
import { cardHref } from "../deep-links";
import type { BoardConfig, Card } from "../types";
import type { DecisionOption } from "./decision";
import { clip, REOPEN_DEFAULT_NOTE } from "./copy";
import type { InboxEntry } from "./entries";

/** O que a entrada de uma decisão precisa ver: o board e o card FRESCO (a pré-condição do «Desfazer» lê o card). */
export interface SystemEntryCtx {
  boardId: string;
  boardName: string;
  config: BoardConfig;
  card?: Card | null;
}

// o motivo PADRÃO de reabrir uma entrega pelo «Desfazer» mora em copy.ts (puro: o UndoControl do cliente também o usa)
export { REOPEN_DEFAULT_NOTE } from "./copy";

/**
 * Por que o «Desfazer» desta decisão seria recusado AGORA — a MESMA régua do servidor (system-decisions `undoRefusal`),
 * antes do clique. O motivo escrito pelo dono (reabrir uma entrega) só existe no clique: a régua confere o resto. PURA.
 */
export function undoRefusalNow(d: FollowUpItem, ctx: Pick<SystemEntryCtx, "config" | "card">): string | null {
  return undoRefusal(d, { config: ctx.config, card: ctx.card ?? null, undone: Boolean(d.undoneAt), note: d.undo?.kind === "reopen-card" ? "(o motivo vem no clique)" : null });
}

/**
 * Uma decisão do SISTEMA vira entrada de Acompanhar: o quê, quem e por quê, e o «Desfazer» — o mesmo handle e a
 * mesma pré-condição do servidor (undoSystemDecisionAction ↔ system-decisions `undoRefusal`): recusado agora ⇒ o botão
 * vem bloqueado com a frase do servidor (P5 do contrato). PURA.
 */
export function systemDecisionEntry(d: FollowUpItem, ctx: SystemEntryCtx): InboxEntry {
  const refusal = d.undoable && d.undo ? undoRefusalNow(d, ctx) : null;
  const options: DecisionOption[] =
    d.undoable && d.undo
      ? [
          {
            id: "undo-system-decision",
            label: undoLabel(d.undo),
            consequence: "Volta atrás desta decisão do sistema; se o card já andou, o botão diz por que não dá.",
            tone: "neutral",
            ...(refusal ? { disabled: { reason: refusal } } : {}),
            auditCls: "write-board",
            // reabrir uma entrega pede um motivo: o clique roda com o motivo padrão (um clique, sem formulário antes)
            invoke: { kind: "undo-system-decision", boardId: ctx.boardId, decisionId: d.id, ...(d.undo.kind === "reopen-card" ? { note: REOPEN_DEFAULT_NOTE } : {}) },
            done: "Desfeito.",
          },
        ]
      : [];
  const who = agentLabel(d.agent);
  return {
    key: `${ctx.boardId}/sd:${d.id}`,
    boardId: ctx.boardId,
    boardName: ctx.boardName,
    itemId: `sd:${d.id}`,
    cardId: d.cardId ?? "",
    cardTitle: ctx.card?.title ?? "",
    kind: "system-decision",
    causeKey: `sd:${d.id}`,
    decision: {
      bucket: "acompanhar",
      askVerb: null,
      ask: clip(d.what, 140),
      // quem decidiu foi o próprio dono (uma mudança de board pela tela): «Você decidiu», nunca «Você decidiu por você»
      happened: `${who} decidiu${d.agent === "human" ? "" : " por você"}${d.why ? `: ${clip(d.why, 200)}` : "."}`,
      options,
      ifIgnored: d.undoneAt ? "Você já desfez esta decisão." : "A decisão fica valendo.",
      more: d.cardId
        ? [{ id: "more:open-card", label: "Abrir card", consequence: "Abre o card inteiro. Não decide nada.", tone: "neutral", auditCls: "read", invoke: { kind: "link", href: cardHref(ctx.boardId, d.cardId) }, done: "Aberto." }]
        : [],
      details: [
        { label: "Quem decidiu", value: who },
        ...(d.what.length > 140 ? [{ label: "O que decidiu", value: d.what }] : []),
        ...(d.alternatives?.length ? [{ label: "Opções que havia", value: d.alternatives.join(" · ") }] : []),
      ],
      since: d.at,
      next: { who: "sistema", label: `${who} decidiu` },
      verdict: { decider: "system", ownerClass: null, reason: d.why },
      dot: "grey",
    },
    facets: [],
  };
}

/**
 * A decisão do sistema é do que o dono COMBINOU rever? Só o aceite da triagem de uma história de usuário (a promessa de
 * veto), e só enquanto o «Desfazer» dela funciona: depois que o card andou, desfazer atropelaria o trabalho — a decisão
 * já é fato, e o fato mora no registro. PURA.
 */
export function isOwnerReview(d: FollowUpItem, ctx: Pick<SystemEntryCtx, "config" | "card">): boolean {
  if (d.kind !== "triage-accept" || ctx.card?.storyType !== "user") return false;
  return Boolean(d.undoable && d.undo) && undoRefusalNow(d, ctx) === null;
}

/** A janela das decisões do sistema em Acompanhar: do último dia (as de hoje estão em «Resolvido hoje») até 7 dias. */
export const SYSTEM_DECISION_WINDOW_DAYS = 7;

/** As decisões do sistema que moram em Acompanhar: entre 24 h e 7 dias, e ainda não desfeitas. PURA. */
export function followUpInWindow(items: readonly FollowUpItem[], now: number): FollowUpItem[] {
  const dayAgo = now - 86_400_000;
  const weekAgo = now - SYSTEM_DECISION_WINDOW_DAYS * 86_400_000;
  return items.filter((d) => {
    const t = Date.parse(d.at);
    return Number.isFinite(t) && t < dayAgo && t >= weekAgo && !d.undoneAt;
  });
}
