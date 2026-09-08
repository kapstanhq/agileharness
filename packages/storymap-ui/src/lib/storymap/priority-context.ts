// O CONTEXTO de um julgamento de prioridade — montado UMA vez, em código puro, e usado pelas DUAS
// superfícies que pontuam (a skill headless `harness-prioritize` via MCP, e as server actions da tela).
//
// Existe uma implementação só de propósito. A divergência entre superfícies foi um defeito REAL desta
// base: a SKILL.md mandava ler as personas do board, e a server action que fazia "o mesmo" nunca as
// lia. Duas descrições da mesma tarefa apodrecem em ritmos diferentes; um builder só, não.
//
// ── Por que ÂNCORAS ───────────────────────────────────────────────────────────────────────────────
// Pontuar um card isolado só produz ordem comparável se a régua for ABSOLUTA. Escala fechada (FIB) dá
// metade disso; a outra metade são as ÂNCORAS — um punhado de cards JÁ pontuados, cobrindo a faixa, que
// viajam em todo prompt como exemplares calibrados (as *reference stories* do SAFe). Sem elas o modelo
// deriva: um "8" de janeiro deixa de significar o mesmo que um "8" de junho, e a ordem que emerge dos
// scores vira ficção. É o único ponto onde a pontuação incremental falha em SILÊNCIO — daí o cuidado.
//
// A seleção é DETERMINÍSTICA (nada de amostra aleatória): o mesmo board produz o mesmo conjunto-âncora,
// então re-pontuar um card sem mudar nada não muda o resultado.

import { cardSignal, type CardSignalCtx } from "./card-signal";
import { deliveredIndex, deliveredStatusIds, isDelivered } from "./delivered";
import { anchorOfCard } from "./smart-capture/architecture-tree";
import { terminalStatusIds } from "./views";
import { cardWsjf, wsjfRatio, type WsjfCall } from "./wsjf";
import type { BoardConfig, Card } from "./types";

/** Quantos exemplares calibrados viajam no prompt. Quatro cobrem topo/alto/médio/base sem inchar. */
export const ANCHOR_COUNT = 4;

/** As stories que DISPUTAM prioridade: nem terminais (entregues, canceladas, duplicadas), nem sem status. */
export function rankableCards(cards: Card[], config: BoardConfig): Card[] {
  const terminal = terminalStatusIds(config);
  return cards.filter((c) => c.type === "story" && !!c.status && !terminal.has(c.status));
}

/**
 * Os cards-ÂNCORA: já pontuados, escolhidos para COBRIR a faixa de score em vez de amostrá-la.
 * Pega o topo, a base e dois cortes internos por posição (≈⅓ e ≈⅔) — assim o modelo vê o que este
 * board considera "grande e urgente" e o que considera "pode esperar", e calibra contra os dois
 * extremos, não contra a média.
 */
export function anchorSet(cards: Card[], k: number = ANCHOR_COUNT): Card[] {
  const scored = cards
    .filter((c) => cardWsjf(c) != null)
    .sort((a, b) => {
      const d = (cardWsjf(b) as number) - (cardWsjf(a) as number);
      return d !== 0 ? d : a.id.localeCompare(b.id); // ordem TOTAL — sem isto o conjunto oscila
    });
  if (scored.length <= k) return scored;
  const picks = new Map<string, Card>();
  for (let i = 0; i < k; i++) {
    // posições espalhadas incluindo as duas pontas: i/(k-1) → 0, ⅓, ⅔, 1
    const idx = Math.round((i / (k - 1)) * (scored.length - 1));
    const c = scored[idx];
    if (c) picks.set(c.id, c);
  }
  return [...picks.values()];
}

/** Uma âncora renderizada: os ordinais + o porquê, para o modelo ver a régua APLICADA, não descrita. */
function anchorLine(c: Card): string {
  const w = c.priorityCall?.wsjf as WsjfCall | undefined;
  const score = wsjfRatio(w);
  if (!w || score == null) return `- ${c.title}`;
  return [
    `- ${c.title}`,
    `  valor ${w.value} · urgência ${w.urgency} · destrava ${w.unlock} · tamanho ${w.size} ⇒ WSJF ${score.toFixed(1)}`,
    c.priorityCall?.rationale ? `  porquê: ${c.priorityCall.rationale}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * True quando o board DECLAROU norte — priorizar sem ele produz ruído confiante.
 *
 * O norte deixou de ser lido aqui: ele vem do PRD, destilado por `prdDigest` e resolvido pela casca
 * (`boardStrategy`, que toca disco). Este módulo continua PURO e recebe o texto já pronto — foi o
 * que permitiu trocar a fonte da estratégia sem tornar assíncrono nada que depende dele.
 */
export function hasStrategy(strategy: string): boolean {
  return strategy.trim().length > 0;
}

export interface PriorityContext {
  strategy: string;
  /** os cards a pontuar nesta rodada (1 no incremental, N no semeio) */
  targets: Card[];
  /** o texto dos alvos, já em forma de sinal */
  targetsText: string;
  /** exemplares calibrados; vazio no cold start */
  anchors: Card[];
  anchorsText: string;
  /** o resto da fila, em uma linha cada — vizinhança, não régua */
  queueText: string;
  /** o que o produto JÁ FAZ (vazio quando o board não declara a faceta `delivered`) */
  deliveredText: string;
  deliveredCount: number;
  /** quantos cards disputavam prioridade quando este julgamento foi feito */
  cohortSize: number;
  /** os sinais reais por card-alvo — viram `wsjf.basis` */
  basisById: Map<string, string[]>;
}

/**
 * Monta o contexto. `targetIds` vazio ⇒ SEMEIO: todos os ranqueáveis ainda sem score (o caso do PRD que
 * despeja dezenas de cards de uma vez). Com ids ⇒ INCREMENTAL: pontua só aqueles, contra as âncoras.
 */
export function buildPriorityContext(input: {
  config: BoardConfig;
  cards: Card[];
  /** O norte do board (o digest do PRD), resolvido pelo chamador — ver `boardStrategy`. */
  strategy: string;
  targetIds?: string[];
  hasPlan?: Set<string>;
}): PriorityContext {
  const { config, cards } = input;
  const rankable = rankableCards(cards, config);
  const titleOf = new Map(cards.map((c) => [c.id, c.title]));

  const wanted = new Set(input.targetIds ?? []);
  const targets = wanted.size
    ? rankable.filter((c) => wanted.has(c.id))
    : rankable.filter((c) => cardWsjf(c) == null);

  const anchors = anchorSet(rankable).filter((a) => !targets.some((t) => t.id === a.id));

  const sigCtx: CardSignalCtx = { config, hasPlan: input.hasPlan };
  const basisById = new Map<string, string[]>();
  const targetBlocks: string[] = [];
  for (const c of targets) {
    const anchorId = anchorOfCard(c);
    const sig = cardSignal(c, { ...sigCtx, anchorTitle: anchorId ? titleOf.get(anchorId) ?? null : null });
    basisById.set(c.id, sig.basis);
    targetBlocks.push(sig.text);
  }

  // A vizinhança: o que mais está na fila, com o score de quem já tem. Uma linha por card — é
  // contexto de "contra o que estou competindo", não material de re-julgamento.
  const targetIdSet = new Set(targets.map((t) => t.id));
  const anchorIdSet = new Set(anchors.map((a) => a.id));
  const queueLines = rankable
    .filter((c) => !targetIdSet.has(c.id) && !anchorIdSet.has(c.id))
    .map((c) => {
      const s = cardWsjf(c);
      return `- ${c.title}${s != null ? ` (WSJF ${s.toFixed(1)})` : " (sem avaliação)"}`;
    });

  const delivered = deliveredIndex(cards, config);

  return {
    strategy: input.strategy,
    targets,
    targetsText: targetBlocks.join("\n\n"),
    anchors,
    anchorsText: anchors.map(anchorLine).join("\n"),
    queueText: queueLines.join("\n"),
    deliveredText: delivered.text,
    deliveredCount: delivered.count,
    cohortSize: rankable.length,
    basisById,
  };
}

/** Quantos ranqueáveis ainda não têm score — o número que a tela mostra e o botão de semeio usa. */
export function unscoredCount(cards: Card[], config: BoardConfig): number {
  return rankableCards(cards, config).filter((c) => cardWsjf(c) == null).length;
}

/** Reexport de conveniência para consumidores que só querem a régua de entregue. */
export { deliveredStatusIds, isDelivered };
