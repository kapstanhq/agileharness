// O ESTADO ATUAL DA APLICAÇÃO, derivado do próprio board. Puro, zero IO, zero LLM, zero MCP.
//
// Priorizar sem saber o que o produto JÁ FAZ produz duas patologias: repropõe o que existe, e afunda o
// card que destrava algo já construído. O material para evitar isso já está no board e ninguém lia: as
// stories em status ENTREGUE são, coletivamente, a especificação do que está no ar — foi o próprio
// Operador quem apontou ("podemos usar os títulos dos cards existentes, que são as specs").
//
// Por que uma faceta NOVA e não `terminalStatusIds` (views.ts): terminal ≠ entregue. Terminal inclui
// `arquivados`/`duplicado`/`cancelado`/`capturado` — apresentar um card CANCELADO como capacidade viva
// é pior que não apresentar nada. Além disso `terminalStatusIds` tem fallback posicional ("última
// coluna") para boards antigos; um fallback aqui inventaria capacidades. Daí a regra:
//
//   FAIL-CLOSED — sem `delivered: true` declarado no board.yaml, o índice sai VAZIO e a seção some do
//   prompt. Um sinal que pode mentir sobre entrega é estritamente pior que sinal nenhum.
//
// O agrupamento reusa `anchorOfCard` (smart-capture/architecture-tree) — a MESMA definição de "onde um
// card mora no mapa" que a árvore da proposta usa (`serves` vence `parent`), para o retrato do produto
// e o retrato da captura nunca divergirem.

import { anchorOfCard } from "./smart-capture/architecture-tree";
import type { BoardConfig, Card } from "./types";

/** Os status que significam ENTREGUE (no ar), estritamente declarados. Vazio ⇒ o board não declarou. */
export function deliveredStatusIds(config: BoardConfig): Set<string> {
  return new Set(config.statuses.filter((s) => s.delivered === true).map((s) => s.id));
}

/** True quando o card está num status declarado como entregue. */
export function isDelivered(card: Card, delivered: Set<string>): boolean {
  return card.type === "story" && !!card.status && delivered.has(card.status);
}

export interface DeliveredIndex {
  /** o texto pronto para o prompt (vazio quando o board não declarou a faceta) */
  text: string;
  /** quantas stories entregues entraram — o denominador honesto do "estado atual" */
  count: number;
  /** quantas âncoras (nós do mapa) agruparam essas stories */
  anchors: number;
}

/**
 * O índice de capacidades ENTREGUES, agrupado por nó do mapa, pronto para injetar num prompt.
 *
 * Medido nos boards reais: acme 67 entregues → 23 âncoras → ~1.2k tokens; storymap 126 → 33 → ~3.8k
 * tokens, em dezenas de milissegundos. Cabe folgado no orçamento de UMA chamada, e diz o que o produto
 * FAZ — que é mais útil para priorizar do que saber quais arquivos existem.
 */
export function deliveredIndex(cards: Card[], config: BoardConfig): DeliveredIndex {
  const live = deliveredStatusIds(config);
  if (live.size === 0) return { text: "", count: 0, anchors: 0 }; // FAIL-CLOSED

  const titleOf = new Map(cards.map((c) => [c.id, c.title]));
  const byAnchor = new Map<string, string[]>();
  let count = 0;

  for (const c of cards) {
    if (!isDelivered(c, live)) continue;
    count++;
    const key = anchorOfCard(c) ?? "__solto__";
    const sys = c.systems?.length ? ` [${c.systems.join(",")}]` : "";
    const list = byAnchor.get(key);
    if (list) list.push(`- ${c.title}${sys}`);
    else byAnchor.set(key, [`- ${c.title}${sys}`]);
  }

  if (count === 0) return { text: "", count: 0, anchors: 0 };

  const blocks: string[] = [];
  for (const [anchor, items] of byAnchor) {
    const heading = anchor === "__solto__" ? "Sem lugar no mapa" : titleOf.get(anchor) ?? anchor;
    blocks.push(`### ${heading}\n${items.join("\n")}`);
  }
  return { text: blocks.join("\n"), count, anchors: byAnchor.size };
}
