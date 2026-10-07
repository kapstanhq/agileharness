// O CONTEXTO de uma conversa com o Jido aberta a partir de um ITEM — o que o chip "Sobre <…>" diz e o que viaja
// no texto enviado. PURO (sem React, sem "use client"): o compositor, o painel e os testes leem daqui.
//
// Uma FUNCIONALIDADE do PRD (a página da funcionalidade, «Pedir item novo») vai pelo mesmo caminho do card, marcada
// `feature`: o chip diz o nome dela e o texto diz «Sobre a funcionalidade «…» (feature: <id>)».
//
// Dois caminhos de contexto, e a diferença é de origem:
//   • o CARD (openJidoChat, um clique no Kanban): a pessoa vê o chip "Sobre <card>" e o pedido escrito. O que vai
//     ao Jido é o próprio texto, com o card nomeado na frente — o id viaja junto para ele abrir o card pelas tools,
//     e a bolha da pessoa mostra exatamente o que foi dito (nada escondido no prompt).
//   • a ESCALAÇÃO (`?copilot=<ref>`): o item já tem um bloco próprio DENTRO do <contexto> (copilotItemContextAction,
//     injetado pelo painel a cada turno). Aqui só se diz o NOME curto do item, para o chip.

import type { EscalationRef } from "@/lib/storymap/copilot/escalation";

/**
 * O item em contexto numa conversa aberta pelo barramento: um CARD ou, com `feature: true`, uma FUNCIONALIDADE do PRD
 * (fase 7 — «Pedir item novo» na página da funcionalidade; o `id` é o da funcionalidade).
 */
export interface JidoCardContext {
  id: string;
  title?: string;
  feature?: true;
}

/** Uma funcionalidade do PRD em contexto. */
export interface JidoFeatureContext {
  id: string;
  title: string;
}

/** O contexto do chip para uma funcionalidade (o mesmo estado do card no compositor, marcado `feature`). Puro. */
export function featureChipContext(feature: JidoFeatureContext): JidoCardContext {
  return { id: feature.id, title: feature.title, feature: true };
}

/** O rótulo do chip "Sobre <…>" de um card: o título quando existe, senão o id (nunca vazio). */
export function cardChipLabel(card: JidoCardContext): string {
  const t = card.title?.trim();
  return t ? t : card.id;
}

/**
 * O texto que vai ao Jido com uma FUNCIONALIDADE em contexto: o nome dela na frente, com o id — é ele que o
 * `create_card` grava em `feature` no item novo. Sem texto, não há o que enviar (devolve ""). Puro.
 */
export function withFeatureContext(feature: JidoFeatureContext | null, text: string): string {
  const body = text.trim();
  if (!body) return "";
  if (!feature) return body;
  const t = feature.title.trim();
  return t ? `Sobre a funcionalidade «${t}» (feature: ${feature.id}): ${body}` : `Sobre a funcionalidade (feature: ${feature.id}): ${body}`;
}

/**
 * O texto que vai ao Jido com um card em contexto: o card nomeado na frente, com o id (é por ele que as tools
 * acham o card). Uma funcionalidade em contexto ({@link JidoCardContext.feature}) vai por {@link withFeatureContext}.
 * Sem texto, não há o que enviar (devolve ""). Puro.
 */
export function withCardContext(card: JidoCardContext | null, text: string): string {
  const body = text.trim();
  if (!body) return "";
  if (!card) return body;
  if (card.feature) return withFeatureContext({ id: card.id, title: card.title ?? "" }, body);
  const t = card.title?.trim();
  return t ? `Sobre o card «${t}» (${card.id}): ${body}` : `Sobre o card ${card.id}: ${body}`;
}

/**
 * O nome curto de um item escalado — a saudação ("Item escalado: **…**") e o chip "Sobre <…>". Só os ids inócuos
 * da ref (o título rico depende do card, que carrega no servidor).
 */
export function escalationRefLabel(ref: EscalationRef): string {
  switch (ref.kind) {
    case "merge":
      return `merge do run ${ref.runId}`;
    case "run":
      return `run do card ${ref.cardId}`;
    case "deploy":
      return `deploy do card ${ref.cardId}`;
    case "finding":
      return `bloqueio ${ref.findingId}`;
    case "question":
      return `pergunta do card ${ref.cardId}`;
    case "branch":
      return `branch ${ref.branch}`;
    case "process":
      return `sessão ${ref.session}`;
    case "approval":
      return `aprovação ${ref.approvalId}`;
    case "governance":
      return `draft ${ref.draftId}`;
    case "move-blocked":
      return `move para ${ref.target}`;
    case "sentinel":
      return `diagnóstico da Sentinela ${ref.causeId}`;
    default:
      return `card ${ref.cardId}`;
  }
}
