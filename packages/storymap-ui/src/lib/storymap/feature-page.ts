// A PÁGINA DA FUNCIONALIDADE — a parte pura (fase 7). O título do card do Kanban abre esta página: a descrição da
// funcionalidade (do PRD) em cima e, embaixo, os itens dela por estado — o que está sendo feito em destaque («Agora»),
// o que precisa do dono, o que vem a seguir e, recolhido, o que já foi feito, cada um com a sua Prova da entrega.
//
// Aqui mora o que a página decide sem React: QUAIS itens são da funcionalidade (a MESMA chave do Kanban —
// feature-key.ts) e em que seção cada um cai. A página não reordena nada: dentro de uma seção a ordem é a do quadro
// (a raia, da esquerda para a direita, e a posição na coluna). PURO e isomórfico.

import { featureKeyOf, OUTROS_FEATURE, type FeatureCtx, type FeatureSource } from "./feature-key";
import { offBoardTerminals, type FlowState } from "./kanban-features";
import { isContainerCard } from "./unplaced";
import type { BoardConfig, Card } from "./types";

/** A frase da página «Outros (fora do PRD)». */
export const OUTROS_LINE = "Itens que não cabem em nenhuma funcionalidade do PRD";

/** O topo da página: de onde vem a funcionalidade, o nome e a descrição (markdown, só leitura). */
export interface FeatureHead {
  id: string;
  title: string;
  /** `prd` = um `###` das Funcionalidades do PRD; `outros` = o grupo fora do PRD; `map` = o passo do mapa (board sem
   *  funcionalidades no PRD, ou o card ainda não ligado antes da 1ª passada da âncora). */
  source: FeatureSource;
  /** o texto do PRD (ou o corpo do passo do mapa); null = nada escrito. */
  description: string | null;
}

/**
 * O topo da página para o id da URL. PURA. A funcionalidade do PRD vence; «outros» só existe num board COM
 * funcionalidades no PRD; senão o id é um nó do mapa (passo, atividade, ou a story que é a própria funcionalidade).
 * null = nada com esse id (a página responde 404).
 */
export function featureHead(
  featureId: string,
  features: readonly { id: string; name: string; markdown?: string }[],
  byId: ReadonlyMap<string, Pick<Card, "id" | "title" | "body">>,
): FeatureHead | null {
  const prd = features.find((f) => f.id === featureId);
  if (prd) return { id: prd.id, title: prd.name, source: "prd", description: prd.markdown?.trim() || null };
  if (featureId === OUTROS_FEATURE.id && features.length > 0) return { id: OUTROS_FEATURE.id, title: OUTROS_FEATURE.title, source: "outros", description: OUTROS_LINE };
  const node = byId.get(featureId);
  if (node) return { id: node.id, title: node.title, source: "map", description: node.body?.trim() || null };
  return null;
}

/**
 * Os itens (stories) de uma funcionalidade — TODOS, inclusive os já arquivados (o «Feito» os mostra), pela mesma
 * chave do Kanban. Containers de captura ficam fora. PURA.
 */
export function featureItems(cards: readonly Card[], featureId: string, ctx: FeatureCtx): Card[] {
  return cards.filter((c) => c.type === "story" && !isContainerCard(c) && featureKeyOf(c, ctx).id === featureId);
}

export interface FeaturePageItem {
  card: Card;
  state: FlowState;
  /** guardado para depois pelo dono («Adiar»): fica no fim do «Próximo». */
  deferred: boolean;
}

export interface FeatureDoneItem {
  card: Card;
  /** a seção `## Prova da entrega` do card (já cortada), ou null quando o card não tem. */
  proof: string | null;
}

export interface FeatureSections {
  agora: FeaturePageItem[];
  precisaDeVoce: FeaturePageItem[];
  proximo: FeaturePageItem[];
  feito: FeatureDoneItem[];
}

export interface SectionsInput {
  /** o estado do desenho de cada item aberto (a MESMA régua do Kanban). */
  stateOf: (id: string) => FlowState;
  config: Pick<BoardConfig, "statuses">;
  /** a Prova da entrega de um card (delivery-audit `deliveryProofOf`, lida no servidor). */
  proofOf: (id: string) => string | null;
  /** a ordem do quadro: o índice da raia de um card (-1 = fora do quadro). Ausente ⇒ a ordem do pipeline. */
  laneOf?: (card: Card) => number;
  /** quando cada card chegou ao ar (epoch ms, do ledger) — o «Feito» vem do mais novo ao mais velho. */
  arrivedAt?: (id: string) => number | undefined;
}

/**
 * Os itens da funcionalidade nas quatro seções da página. PURA.
 *   • «Precisa de você»: decisão do dono ou erro;
 *   • «Agora»: rodando, ou o sistema entregando;
 *   • «Próximo»: o resto do que está aberto (na fila, esperando condutor, pausado, esquecido) — o adiado no fim;
 *   • «Feito»: o que chegou ao fim do fluxo (o status de entrega; sem nenhum marcado, todo terminal) e o arquivado
 *     que tem Prova da entrega. Cancelado, duplicado e o arquivado sem prova ficam fora: não foram feitos.
 * Dentro de cada seção aberta a ordem é a do quadro (raia, posição na coluna, id); o «Feito», do mais novo ao mais
 * velho pela chegada ao ar (sem chegada lida, pela última escrita).
 */
export function featurePageSections(items: readonly Card[], input: SectionsInput): FeatureSections {
  const { stateOf, config, proofOf, laneOf, arrivedAt } = input;
  const terminal = new Set(config.statuses.filter((s) => s.terminal === true).map((s) => s.id));
  const off = offBoardTerminals(config);
  const pipeline = new Map(config.statuses.map((s, i) => [s.id, i] as const));
  const laneKey = laneOf ?? ((c: Card) => (c.status != null ? (pipeline.get(c.status) ?? -1) : -1));
  const out: FeatureSections = { agora: [], precisaDeVoce: [], proximo: [], feito: [] };
  for (const card of items) {
    if (card.status != null && terminal.has(card.status)) {
      const proof = proofOf(card.id);
      if (!off.has(card.status) || proof) out.feito.push({ card, proof });
      continue;
    }
    const state = stateOf(card.id);
    const item: FeaturePageItem = { card, state, deferred: !!card.deferred };
    if (state === "attention" || state === "error") out.precisaDeVoce.push(item);
    else if ((state === "running" || state === "delivering") && !item.deferred) out.agora.push(item);
    else out.proximo.push(item);
  }
  const boardOrder = (a: FeaturePageItem, b: FeaturePageItem) =>
    Number(a.deferred) - Number(b.deferred) ||
    laneKey(a.card) - laneKey(b.card) ||
    (a.card.order ?? 0) - (b.card.order ?? 0) ||
    a.card.id.localeCompare(b.card.id);
  out.agora.sort(boardOrder);
  out.precisaDeVoce.sort(boardOrder);
  out.proximo.sort(boardOrder);
  const doneAt = (c: Card) => arrivedAt?.(c.id) ?? c.updatedMs ?? 0;
  out.feito.sort((a, b) => doneAt(b.card) - doneAt(a.card) || a.card.id.localeCompare(b.card.id));
  return out;
}

/** «2 agora · 1 precisa de você · 3 próximos · 5 feitos» — o resumo sob o título (só o que tem item). PURA. */
export function sectionsSummary(s: FeatureSections): string {
  const parts = [
    s.agora.length ? `${s.agora.length} agora` : "",
    s.precisaDeVoce.length ? `${s.precisaDeVoce.length} ${s.precisaDeVoce.length === 1 ? "precisa" : "precisam"} de você` : "",
    s.proximo.length ? `${s.proximo.length} ${s.proximo.length === 1 ? "próximo" : "próximos"}` : "",
    s.feito.length ? `${s.feito.length} ${s.feito.length === 1 ? "feito" : "feitos"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nenhum item ainda";
}

/** O rascunho que «Pedir item novo» escreve no chat do Jido (nunca enviado sozinho). PURA. */
export function newItemDraft(title: string): string {
  return `Quero um item novo em «${title}»: `;
}
