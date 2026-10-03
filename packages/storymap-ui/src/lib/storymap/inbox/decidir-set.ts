// O CONJUNTO «Decidir» de um board, do jeito que o Kanban o lê — a raia do dono, a pílula do card e o botão do rodapé.
//
// O PROBLEMA (medido no ar): três modelos respondiam «precisa de você». A raia `voce` juntava status fixos
// (com-design, ready, revisao, release) com o modelo legado `cardDemands`; a pílula usava `cardInboxSignal`; o rodapé
// usava `dominantDemand`. A raia tinha mais cards do que o Decidir — o dono abria «Precisa de você» e achava
// card que o sistema estava integrando, e não achava a publicação que só ele podia destravar.
//
// A REGRA: a raia do dono É o Decidir do Inbox. Este módulo transforma as entradas de Decidir (as MESMAS do coletor do
// Inbox — `collectBoardInbox` no servidor, `getInboxSummaryAction` no cliente) no conjunto por card, na ordem do Inbox.
// PURO e isomórfico: o servidor (decidir-ids.ts) e o hook do cliente chamam a MESMA função, então a página e a
// atualização ao vivo nunca discordam.

import { optionAsQuickAction, type QuickAction } from "../quick-actions";
import { inboxSections, type InboxEntry } from "./entries";
import { primaryOption, type DecisionOption, type ItemDecision } from "./decision";

/** A decisão que um card carrega em Decidir — o que o Kanban desenha nele. */
export interface OwnerCardDecision {
  cardId: string;
  /** o item que lidera o card (o mais urgente dele) — a pílula abre ESTE item no Inbox. */
  itemId: string;
  /** a decisão, em uma frase (o «<what>» de «Precisa de você: <what>»). */
  what: string;
  /** a posição do card na ordem do Inbox (0 = o mais urgente) — a raia do dono segue esta ordem. */
  rank: number;
  /** quantas OUTRAS decisões deste card estão em Decidir (um pedido de agente não dobra com o item do card). */
  more: number;
  /** a opção principal do Inbox como botão compacto — só quando o card a executa com segurança; null = a pílula basta. */
  primary: QuickAction | null;
}

/** O Decidir de um board, por card. */
export interface OwnerDecisions {
  boardId: string;
  /** quantas entradas o Inbox mostra em Decidir neste board — o número que o dono lê no Inbox. */
  total: number;
  /** um por card, na ordem do Inbox. As entradas sem card (proposta de PRD, pedido solto) só contam em `total`. */
  cards: OwnerCardDecision[];
}

/** Invokes que não mudam o desfecho: ler, conversar, abrir. Um botão desses no card seria «resolver» de mentira. */
const NOT_AN_OUTCOME: ReadonlySet<DecisionOption["invoke"]["kind"]> = new Set(["howto", "escalate", "link", "show-publish-status"]);

/** Descartar o trabalho de uma integração — perde o que não entrou. Nunca é o botão solto de um card fechado. */
const isAbort = (invoke: DecisionOption["invoke"]): boolean =>
  (invoke.kind === "resolve-merge" && invoke.action === "aborted") || (invoke.kind === "resolve-gate" && invoke.action === "abort");

/**
 * O botão do card fechado: a opção PRINCIPAL do Inbox (`primaryOption`, a mesma régua do InboxItemCard) quando o card
 * consegue executá-la sozinho e com segurança — senão null, e a pílula leva ao Inbox, onde a decisão inteira está. PURA.
 *
 * Nunca cai para OUTRA opção. O defeito que a revisão achou: a régua antiga tirava conversa e leitura e pegava
 * «a primeira que sobra». No conflito de integração a principal do Inbox é «Pedir ao Jido para integrar»; sobrava
 * «Descartar este trabalho», e o único botão do card fechado perdia o trabalho de vez. Na triagem com o «Aceitar»
 * recusado, sobrava o «Descartar» para a lixeira. Por isso:
 *   • a principal declarada (tom primary) recusada agora não é trocada pela alternativa que o primaryOption acharia —
 *     o Inbox mostra o porquê e o que a libera, o card não tem onde;
 *   • conversa, leitura e passo a passo não são botão de resolver; nem o que pede texto/escolha no corpo do item;
 *   • nada vermelho ou destrutivo é o botão ÚNICO de um card: o dono descarta olhando a decisão inteira, no Inbox;
 *   • o botão de um card age NESTE card: a decisão de uma causa que mora em outro card (a publicação parada pelo código
 *     do card âncora) tem o botão no card âncora — o botão exibido num card-vítima chegou a mover o
 *     card âncora, que era outro.
 */
function cardButtonOption(decision: Pick<ItemDecision, "options">, cardId: string): DecisionOption | null {
  const main = primaryOption(decision);
  if (!main || main.disabled || main.requires) return null;
  const target = (main.invoke as { cardId?: string }).cardId;
  if (target && target !== cardId) return null;
  if (main.tone !== "primary" && decision.options.some((o) => o.tone === "primary" && o.disabled)) return null;
  if (main.auditCls === "read" || NOT_AN_OUTCOME.has(main.invoke.kind)) return null;
  if (main.tone === "danger" || main.auditCls === "destructive" || isAbort(main.invoke)) return null;
  return main;
}

/**
 * O Decidir de UM board, por card, a partir das entradas do Inbox (as de qualquer seção — só Decidir conta; a faixa do
 * host não). PURA. A ordem é a do Inbox (inboxSections: o mais urgente primeiro); um card com duas decisões aparece uma
 * vez, liderado pela primeira, com `more` contando as outras.
 */
export function ownerDecisionsFromEntries(entries: readonly InboxEntry[], boardId: string): OwnerDecisions {
  const { decidir } = inboxSections(entries.filter((e) => e.boardId === boardId));
  const byCard = new Map<string, OwnerCardDecision>();
  for (const e of decidir) {
    if (!e.cardId) continue;
    const seen = byCard.get(e.cardId);
    if (seen) {
      seen.more += 1;
      continue;
    }
    byCard.set(e.cardId, {
      cardId: e.cardId,
      itemId: e.itemId,
      what: e.decision.ask,
      rank: byCard.size,
      more: 0,
      primary: optionAsQuickAction(cardButtonOption(e.decision, e.cardId)),
    });
  }
  return { boardId, total: decidir.length, cards: [...byCard.values()] };
}

/** Os ids dos cards em Decidir, na ordem do Inbox. PURA. */
export function decidirCardIds(d: Pick<OwnerDecisions, "cards">): string[] {
  return d.cards.map((c) => c.cardId);
}
