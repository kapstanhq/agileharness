// Validador e serializador puro do grafo de links tipados — sem I/O.
// Recebe board+cards já lidos; reutilizável pelo painel (story-emcit7) e pelos lints.
//
// Seam de extensão: resolveNodeKind resolve os tipos de CARD (activity/step/story/idea) +
// personas/releases. Os NodeKinds de artefato AINDA não-card (desiredOutcome/inputMetric/canvas)
// resultam em "ponta não resolve" (dangling) até as stories de artefato pousarem a fonte. A
// `idea` JÁ é um card (type:"idea") — por isso resolve, habilitando o edge `addresses`
// (story→idea) gravado pela captura e pelo set_card_links a validar corretamente.

import type { BoardConfig, Card, CardLink, NodeKind } from "./types";

// ── contexto de resolução de nó ───────────────────────────────────────────────

export interface NodeResolveCtx {
  cardsById: Map<string, Card>;
  personaIds: Set<string>;
  releaseIds: Set<string>;
}

/** Constrói o contexto de resolução a partir do board resolvido + lista de cards. */
export function makeCtx(board: BoardConfig, cards: Card[]): NodeResolveCtx {
  return {
    cardsById: new Map(cards.map((c) => [c.id, c])),
    personaIds: new Set(board.personas.map((p) => p.id)),
    releaseIds: new Set(board.releases.map((r) => r.id)),
  };
}

/**
 * Resolve o NodeKind de um id a partir do contexto.
 * Retorna null para ids desconhecidos (dangling) ou kinds de artefato ainda não implementados.
 */
export function resolveNodeKind(id: string, ctx: NodeResolveCtx): NodeKind | null {
  const card = ctx.cardsById.get(id);
  if (card) {
    const t = card.type;
    if (t === "activity" || t === "step" || t === "story" || t === "idea") return t;
  }
  if (ctx.personaIds.has(id)) return "persona";
  if (ctx.releaseIds.has(id)) return "release";
  return null;
}

// ── validação de um único link ────────────────────────────────────────────────

/**
 * Valida um link de `originId` para `link.to` no contexto do board.
 * Retorna `null` (ok) ou uma mensagem de erro PT-BR descrevendo a violação.
 */
export function validateLink(
  originId: string,
  link: CardLink,
  board: BoardConfig,
  ctx: NodeResolveCtx,
): string | null {
  const lt = board.linkTypes.find((t) => t.id === link.rel);
  if (!lt) {
    return `tipo de relação desconhecido: "${link.rel}"`;
  }

  const destId = link.to;
  const destKind = resolveNodeKind(destId, ctx);
  if (destKind === null) {
    return `destino "${destId}" não encontrado no board`;
  }

  // Sem restrições declaradas (legado) → aceita
  if (!lt.from && !lt.to) return null;

  const originKind = resolveNodeKind(originId, ctx);
  if (originKind === null) {
    return `origem "${originId}" não encontrada no board`;
  }

  if (lt.from && lt.from.length > 0 && !lt.from.includes(originKind)) {
    const permitidos = lt.from.join(", ");
    return `aresta "${link.rel}" exige origem ∈ {${permitidos}} — recebeu origem=${originKind}`;
  }

  if (lt.to && lt.to.length > 0 && !lt.to.includes(destKind)) {
    const permitidos = lt.to.join(", ");
    return `aresta "${link.rel}" exige destino ∈ {${permitidos}} — recebeu destino=${destKind}`;
  }

  return null;
}

// ── validação de todos os links do board ──────────────────────────────────────

export interface LinkViolation {
  card: string;
  rel: string;
  to: string;
  message: string;
}

/** Varre todos os cards×links e acumula violações. Consumido pelo lint de board-integrity. */
export function validateBoardLinks(board: BoardConfig, cards: Card[]): LinkViolation[] {
  if (!board.linkTypes || board.linkTypes.length === 0) return [];
  const ctx = makeCtx(board, cards);
  const violations: LinkViolation[] = [];

  for (const card of cards) {
    for (const link of card.links ?? []) {
      const msg = validateLink(card.id, link, board, ctx);
      if (msg) {
        violations.push({ card: card.id, rel: link.rel, to: link.to, message: msg });
      }
    }
  }

  return violations;
}

// ── serialização do grafo (aceite #3) ────────────────────────────────────────

export interface GraphEdge {
  rel: string;
  from: string;
  to: string;
  fromKind: NodeKind;
  toKind: NodeKind;
}

/**
 * Retorna APENAS as arestas válidas do grafo.
 * Nenhuma relação implícita: `parent` NÃO vira edge aqui — `contains` continua sendo o `parent`.
 * O painel (story-emcit7) serializa este resultado; não há inferência de relações.
 */
export function buildLinkGraph(board: BoardConfig, cards: Card[]): GraphEdge[] {
  if (!board.linkTypes || board.linkTypes.length === 0) return [];
  const ctx = makeCtx(board, cards);
  const edges: GraphEdge[] = [];

  for (const card of cards) {
    for (const link of card.links ?? []) {
      const msg = validateLink(card.id, link, board, ctx);
      if (msg) continue; // link inválido → não emite aresta

      const fromKind = resolveNodeKind(card.id, ctx)!;
      const toKind = resolveNodeKind(link.to, ctx)!;
      edges.push({ rel: link.rel, from: card.id, to: link.to, fromKind, toKind });
    }
  }

  return edges;
}

/** The typed-link rel that expresses "this card can't start until the target finishes". */
export const DEPENDS_ON_REL = "depends-on";

/** One scheduling edge in the `board/cardId -> board/cardId` shape enqueue_batch consumes: `from` must
 *  COMPLETE before `to` starts. */
export interface DepEdge {
  from: string;
  to: string;
}

/**
 * WS7 (F6) — derive the scheduling deps[] from the cards' `depends-on` links, closing the gap "links never
 * fed scheduling". A `depends-on` link on card A pointing at B means A waits for B -> edge {from: B, to: A}
 * (B completes first). Keys are `board/cardId` (enqueue_batch's shape) so the result drops straight into a
 * batch. Only edges BETWEEN cards in the given set are kept (an external dep can't be scheduled here). Pure —
 * consumed by the copiloto (WS8) + the batch-assembly UI; never touches the kernel. Board-agnostic.
 */
export function depsFromLinks(board: string, cards: Card[]): DepEdge[] {
  const ids = new Set(cards.map((c) => c.id));
  const key = (id: string) => `${board}/${id}`;
  const edges: DepEdge[] = [];
  const seen = new Set<string>();
  for (const c of cards) {
    for (const l of c.links ?? []) {
      if (l.rel !== DEPENDS_ON_REL || !ids.has(l.to) || l.to === c.id) continue;
      const from = key(l.to);
      const to = key(c.id);
      const sig = `${from} ${to}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      edges.push({ from, to });
    }
  }
  return edges;
}
