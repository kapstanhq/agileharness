// A FUNCIONALIDADE DE UM CARD — a fonte ÚNICA da chave de agrupamento, para o Kanban (kanban-features.ts), a página da
// funcionalidade e o despacho do condutor (lotes e «nunca dois condutores na mesma funcionalidade»). PURO e isomórfico.
//
// Dois modos (fase 7):
//   • PRD — o board tem funcionalidades no PRD (doc/prd-features.ts): a chave é `card.feature` quando ela existe no
//     PRD; senão a do card que ele `serves` (um salto); senão «Outros (fora do PRD)». PONTE do lançamento: até a
//     primeira passada da âncora terminar no board (`anchoredOnce`), o card sem funcionalidade cai no modo mapa em vez
//     de «Outros» — o Kanban não vira um único card «Outros» no dia da release.
//   • MAPA (fallback) — board sem funcionalidades no PRD: o passo do mapa que o card serve ({@link featureOf}).
//
// SEM CICLO: este módulo nunca importa kanban-features.ts; é kanban-features que importa e reexporta `featureOf`.
// Esqueleto do commit de interfaces: a Trilha A fecha `featureKeyOf` e os testes.

import type { Card } from "./types";

export interface FeatureRef {
  /** o id do nó que representa a funcionalidade (o próprio card quando ele não tem pai). */
  id: string;
  title: string;
  /** o card É a funcionalidade (sem pai): o item some, para o título não se repetir. */
  self: boolean;
}

/** De onde veio a chave: a funcionalidade do PRD, o passo do mapa (fallback/ponte) ou o grupo «Outros». */
export type FeatureSource = "prd" | "map" | "outros";

/** A chave de agrupamento de um card. */
export type FeatureKey = FeatureRef & { source: FeatureSource };

/** O grupo dos itens que não cabem em nenhuma funcionalidade do PRD (nunca forma lote nem ocupa a funcionalidade). */
export const OUTROS_FEATURE: Readonly<FeatureRef> = Object.freeze({ id: "outros", title: "Outros (fora do PRD)", self: false });

/** Uma funcionalidade do PRD como a chave a vê (id + nome). */
export interface FeatureNameRef {
  id: string;
  name: string;
}

/** O que {@link featureKeyOf} precisa saber do board. */
export interface FeatureCtx {
  /** todos os cards do board pelo id (o `serves`/`parent` resolvem por aqui). */
  byId: ReadonlyMap<string, Card>;
  /** as funcionalidades do PRD pelo id. VAZIO ⇒ modo mapa (board sem funcionalidades no PRD). */
  features: ReadonlyMap<string, FeatureNameRef>;
  /** a primeira passada da âncora já terminou neste board (`.runner/feature-anchor.json`) — desliga a ponte. */
  anchoredOnce: boolean;
}

/** Monta o {@link FeatureCtx} (as funcionalidades do PRD em lista, como `prdFeatureEntries` as devolve). PURA. */
export function featureCtx(byId: ReadonlyMap<string, Card>, features: readonly FeatureNameRef[], anchoredOnce: boolean): FeatureCtx {
  return { byId, features: new Map(features.map((f) => [f.id, { id: f.id, name: f.name }] as const)), anchoredOnce };
}

/** O board está no modo PRD (tem funcionalidades no PRD)? PURA. */
export function hasPrdFeatures(ctx: Pick<FeatureCtx, "features">): boolean {
  return ctx.features.size > 0;
}

/** Quantos saltos de `serves`/`parent` a busca da funcionalidade segue (story → story → passo), com folga. */
const MAX_HOPS = 4;

/**
 * A FUNCIONALIDADE de um card no MODO MAPA. PURA. O passo do mapa (a tarefa do usuário) que ele serve:
 *   • um ticket de entrega que `serves` uma story herda a funcionalidade DESSA story;
 *   • `serves` (ou `parent`) apontando um passo/atividade = esse nó;
 *   • sem pai legível, o próprio card é a funcionalidade.
 */
export function featureOf(card: Pick<Card, "id" | "title" | "parent" | "serves">, byId: ReadonlyMap<string, Card>): FeatureRef {
  const seen = new Set<string>([card.id]);
  let cur: Pick<Card, "id" | "title" | "parent" | "serves"> = card;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    // `serves` primeiro; um `serves` que não resolve (alvo apagado, de outro board, ou um nó que não é story/passo)
    // cai no `parent` — o pai do card continua valendo (a mesma régua de `servesTarget = serves ?? parent`).
    let next: Card | undefined;
    for (const id of [cur.serves, cur.parent]) {
      if (!id || seen.has(id)) continue;
      const n = byId.get(id);
      if (n && (n.type === "step" || n.type === "activity" || n.type === "story")) {
        next = n;
        break;
      }
    }
    if (!next) break;
    seen.add(next.id);
    if (next.type === "step" || next.type === "activity") return { id: next.id, title: next.title, self: false };
    cur = next;
  }
  return cur.id === card.id ? { id: card.id, title: card.title, self: true } : { id: cur.id, title: cur.title, self: false };
}

/**
 * A CHAVE de agrupamento de um card (ver o cabeçalho). PURA.
 * PRD: `card.feature` válida → ela; senão a do alvo de `serves` (um salto); senão a ponte (sem `anchoredOnce` ⇒ mapa)
 * ou «Outros». Mapa: {@link featureOf}.
 */
export function featureKeyOf(card: Pick<Card, "id" | "title" | "parent" | "serves" | "feature">, ctx: FeatureCtx): FeatureKey {
  if (!hasPrdFeatures(ctx)) return { ...featureOf(card, ctx.byId), source: "map" };
  const direct = card.feature ? ctx.features.get(card.feature) : undefined;
  if (direct) return { id: direct.id, title: direct.name, self: false, source: "prd" };
  const target = card.serves ? ctx.byId.get(card.serves) : undefined;
  const inherited = target?.feature ? ctx.features.get(target.feature) : undefined;
  if (inherited) return { id: inherited.id, title: inherited.name, self: false, source: "prd" };
  if (!ctx.anchoredOnce) return { ...featureOf(card, ctx.byId), source: "map" };
  return { ...OUTROS_FEATURE, source: "outros" };
}
