// A BUSCA do Kanban — o recorte que a barra do topo aplica sobre as stories do board. Puro (sem React, sem
// window): o componente só guarda o estado e chama estas funções, e cada regra de casamento tem teste.
//
// O que se procura é o que o operador VÊ no card ou sabe de cabeça: o id (inteiro ou um pedaço — ninguém
// digita o prefixo `story-`), o título, o tipo (o id técnico E o rótulo em português que o card mostra) e o
// passo/atividade onde a story mora. Sem linguagem de consulta: palavras soltas, todas precisam aparecer.

import { DISPOSITION_BY_ID, STORY_TYPE_BY_ID, STORY_TYPE_IDS, type StoryType } from "./frameworks";
import { foldText } from "./vocab";
import type { Card } from "./types";

export interface KanbanFilter {
  /** texto livre, como foi digitado (o casamento normaliza) */
  q: string;
  /** chips de tipo ligados — OU entre eles; vazio = todos os tipos */
  types: StoryType[];
}

export const EMPTY_KANBAN_FILTER: KanbanFilter = { q: "", types: [] };

/** Os parâmetros da URL. `tipo` em português, como o resto da interface; os valores são os ids dos tipos. */
export const KANBAN_QUERY_PARAM = "q";
export const KANBAN_TYPE_PARAM = "tipo";

export interface KanbanFilterContext {
  /** todos os cards do board por id — resolve o passo e a atividade de uma story. Ausente ⇒ só o card conta. */
  cardsById?: ReadonlyMap<string, Card>;
}

/**
 * O rótulo de TIPO que o card mostra no topo. Um `mode` de execução ativo vence o storyType (fix→Bug,
 * refine→Refino, retire→a disposição); fora dele, o nome do storyType. Mora aqui, e não só no KanbanCard,
 * porque a busca promete achar o card pelo que está escrito nele — duas cópias desta regra divergiriam.
 */
export function cardTypeLabel(card: Pick<Card, "storyType" | "mode" | "retirement">): { text: string; title?: string } {
  if (card.mode === "fix") return { text: "Bug" };
  if (card.mode === "refine") return { text: "Refino" };
  if (card.mode === "retire") {
    return { text: card.retirement ? (DISPOSITION_BY_ID[card.retirement.disposition]?.name ?? "Arquivar") : "Arquivar" };
  }
  const def = STORY_TYPE_BY_ID[card.storyType ?? "user"];
  return { text: def.name, title: def.short };
}

/**
 * Os tipos sob os quais um card aparece nos chips: o storyType (ausente ⇒ `user`, que é como o card se
 * apresenta) e, em modo fix, também `bug` — o card diz "Bug" no topo, então o chip Bug precisa trazê-lo.
 */
export function cardTypeKeys(card: Pick<Card, "storyType" | "mode">): StoryType[] {
  const own = card.storyType ?? "user";
  return card.mode === "fix" && own !== "bug" ? [own, "bug"] : [own];
}

/** Quantos níveis de parent a busca sobe (story → passo → atividade), com folga para um board mais fundo. */
const MAX_ANCESTORS = 4;

/** O texto onde a consulta procura, já normalizado (sem acento, minúsculo). */
function searchText(card: Card, ctx?: KanbanFilterContext): string {
  const parts: string[] = [card.id, card.title, cardTypeLabel(card).text];
  for (const t of cardTypeKeys(card)) parts.push(t, STORY_TYPE_BY_ID[t].name);
  const byId = ctx?.cardsById;
  if (byId) {
    const seen = new Set<string>([card.id]);
    // o nó que um ticket de entrega SERVE aparece no card como breadcrumb — também é procurável
    const refs = [card.serves ?? null, card.parent];
    for (const start of refs) {
      let id = start;
      for (let depth = 0; id && depth < MAX_ANCESTORS && !seen.has(id); depth++) {
        seen.add(id);
        const node = byId.get(id);
        if (!node) break;
        parts.push(node.title);
        id = node.parent;
      }
    }
  }
  return foldText(parts.join(" "));
}

function queryTokens(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean);
}

/** Texto livre: sem acento, sem caixa, várias palavras = E. Consulta vazia casa tudo. */
export function matchesCardQuery(card: Card, query: string, ctx?: KanbanFilterContext): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;
  const text = searchText(card, ctx);
  return tokens.every((t) => text.includes(t));
}

export function isKanbanFilterActive(filter: KanbanFilter): boolean {
  return filter.q.trim().length > 0 || filter.types.length > 0;
}

function matchesTypes(card: Card, types: readonly StoryType[]): boolean {
  return types.length === 0 || cardTypeKeys(card).some((t) => types.includes(t));
}

/** O filtro inteiro: texto E (qualquer um dos chips ligados). */
export function matchesKanbanFilter(card: Card, filter: KanbanFilter, ctx?: KanbanFilterContext): boolean {
  return matchesTypes(card, filter.types) && matchesCardQuery(card, filter.q, ctx);
}

export interface KanbanTypeFacet {
  type: StoryType;
  label: string;
  /** quantos cards deste tipo passam no TEXTO atual (os chips não se recortam entre si) */
  count: number;
}

/**
 * Os chips de tipo: só os tipos presentes no board (um chip que nunca acha nada é ruído), na ordem canônica.
 * A contagem aplica o texto mas não a seleção de chips — o chip diz quanto ele traria. Um tipo que o texto
 * zerou continua na fileira (com 0): a barra não pula enquanto se digita. Um tipo LIGADO (`selected`) fica
 * na fileira mesmo sem card no board — senão um `?tipo=` de link velho recortaria tudo sem chip para desligar.
 */
export function kanbanTypeFacets(
  stories: readonly Card[],
  query: string,
  ctx?: KanbanFilterContext,
  selected: readonly StoryType[] = [],
): KanbanTypeFacet[] {
  const present = new Set<StoryType>(selected);
  const counts = new Map<StoryType, number>();
  for (const c of stories) {
    const keys = cardTypeKeys(c);
    for (const t of keys) present.add(t);
    if (!matchesCardQuery(c, query, ctx)) continue;
    for (const t of keys) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return STORY_TYPE_IDS.filter((t) => present.has(t)).map((t) => ({
    type: t,
    label: STORY_TYPE_BY_ID[t].name,
    count: counts.get(t) ?? 0,
  }));
}

/**
 * Recorta cada coluna/raia SEM remover a chave: uma coluna que o filtro esvaziou continua existindo (e mostra
 * "nenhum card"), em vez de sumir e fazer o board pular. Devolve um mapa novo; o original fica intacto — o
 * arrasto calcula a ordem de destino sobre a coluna inteira, não sobre o recorte.
 */
export function filterCardGroups<K>(groups: ReadonlyMap<K, Card[]>, keep: (card: Card) => boolean): Map<K, Card[]> {
  const out = new Map<K, Card[]>();
  for (const [key, list] of groups) out.set(key, list.filter(keep));
  return out;
}

/** Lê o filtro da URL. Tipo desconhecido é descartado em silêncio (link velho abre a tela, nunca quebra). */
export function readKanbanFilter(params: { get(name: string): string | null }): KanbanFilter {
  const q = params.get(KANBAN_QUERY_PARAM) ?? "";
  const raw = (params.get(KANBAN_TYPE_PARAM) ?? "").split(",").map((s) => s.trim());
  return { q, types: STORY_TYPE_IDS.filter((t) => raw.includes(t)) };
}

/**
 * Escreve o filtro sobre a query string ATUAL (com ou sem o `?`), preservando todo outro parâmetro da tela
 * (`?focus=`, `?copilot=`…). Filtro vazio remove os próprios parâmetros. Devolve a query sem o `?`.
 */
export function writeKanbanFilter(search: string, filter: KanbanFilter): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (filter.q.trim()) params.set(KANBAN_QUERY_PARAM, filter.q);
  else params.delete(KANBAN_QUERY_PARAM);
  const types = STORY_TYPE_IDS.filter((t) => filter.types.includes(t));
  if (types.length) params.set(KANBAN_TYPE_PARAM, types.join(","));
  else params.delete(KANBAN_TYPE_PARAM);
  return params.toString();
}
