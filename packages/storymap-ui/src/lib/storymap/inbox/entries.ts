// As ENTRADAS do Inbox — o que a lista mostra, já decidido (decision.ts), promovido pelo prazo, marcado como parado e
// dobrado por CAUSA. PURO: o coletor (collect.ts) lê o disco e entrega aqui; a tela só desenha.
//
// Duas fontes viram entrada:
//   • um item vivo do board (CockpitItem) — Decidir ou Acompanhar, pela decisão dele (aqui);
//   • uma decisão que o SISTEMA tomou em nome do dono (o registro system-decisions.jsonl) — Acompanhar, com o porquê e
//     o «Desfazer» (system-entries.ts, lido só pelo coletor: o registro arrasta módulos que a tela não precisa).
//
// UMA ENTRADA POR CAUSA em cada seção (contract.ts, regra D). Era «um item por card» (F2 da auditoria de UX: o card com
// um deploy falho E um gate E um aviso mostrava três conselhos) — mas uma publicação parada é do PACOTE: num caso real o
// mesmo código segurava vários cards e virava vários itens, cada um com o nome de um card-vítima. Agora a causa é a
// chave (`KIND_CONTRACT[kind].causeKey`): o padrão segue sendo o card; a publicação parada é a causa dela; a causa do
// dono mora no card que a decide. Fica a entrada de maior precedência (a do próprio card âncora primeiro); as outras
// viram facetas, cada uma alcançável pela página própria.
//
// E as que a causa já não sustenta (contract.ts, regra E) saem da lista com um recibo — o coletor as põe em «Resolvido
// hoje» ({@link settleItems} `retired`).

import type { BoardConfig, Card } from "../types";
import type { CockpitItem, CockpitItemKind } from "../demands";
import { copilotTier } from "../copilot/tier";
import { reviewLensesOf, type TargetProfile } from "../target-profile";
import { REOPEN_KINDS } from "../reopen";
import { decideItem, promote, type ItemDecision } from "./decision";
import { foldsIntoPublishHold, isInboxItem, itemCauseKey, itemLiveness, type InboxFacts, type Liveness } from "./contract";
import { quoted, staleDays } from "./copy";

/** Uma faceta dobrada dentro da entrada da sua causa. */
export interface InboxFacet {
  itemId: string;
  kind: CockpitItemKind;
  ask: string;
  /** o card da faceta — numa causa de vários cards, a tela lista os cards afetados pelo nome. */
  cardId?: string;
  cardTitle?: string;
}

/** Uma linha do Inbox — um item vivo ou uma decisão do sistema. */
export interface InboxEntry {
  /** `<board>/<itemId>` — única entre boards. */
  key: string;
  boardId: string;
  boardName: string;
  /** o id do item do board (`<card>:q:<id>`, `gov:<id>`…) ou `sd:<id>` para uma decisão do sistema. */
  itemId: string;
  cardId: string;
  cardTitle: string;
  kind: CockpitItemKind | "system-decision";
  decision: ItemDecision;
  /** a causa (contract.ts) — duas entradas da mesma causa na mesma seção viram UMA. `sd:<id>` numa decisão do sistema. */
  causeKey: string;
  /** as outras entradas da mesma causa na mesma seção (a dobra). */
  facets: InboxFacet[];
  /** parado há mais de 30 dias: há quantos, e se «Arquivar os antigos» o alcança. */
  stale?: { days: number; archivable: boolean };
  /** o item cru — o corpo do kind (o formulário da pergunta, a árvore da proposta, o canvas) lê daqui. */
  item?: CockpitItem;
}

/**
 * A PRECEDÊNCIA da dobra por card — quem fica por cima quando um card tem mais de uma coisa (F2 do ux-report:
 * publicação falha > publicação sem confirmação > conflito/integração falha > execução parada > bloqueio > pergunta >
 * aprovação > aviso), com os kinds que vieram depois encaixados. EXAUSTIVA (o teste confere cada kind uma vez).
 */
export const INBOX_PRECEDENCE: readonly CockpitItemKind[] = [
  "deploy-failed",
  "effect-failed",
  "stalled",
  "deploy-unsettled",
  "conflict",
  "merge-failed",
  "stuck",
  "data-deletion",
  "locked-exec",
  "blocker",
  "question",
  "review",
  "design",
  "gate",
  "release-aging",
  "finding",
  "proposal",
  "proxy-audit",
  "delivery-audit",
  "approval",
  "governance",
  "meter-stalled",
];

/** «Arquivar os antigos» alcança o item parado cujo card é uma história esperando o dono decidir se ainda a quer. */
const ARCHIVABLE: ReadonlySet<CockpitItemKind> = new Set<CockpitItemKind>(["review", "gate", "question", "design", "blocker", "finding", "release-aging"]);

/** Para onde «Arquivar os antigos» manda o card: o arquivo dos adiados (o mesmo do «Descontinuar → postergado»). */
export const STALE_ARCHIVE_STATUS = REOPEN_KINDS.retire.noOpStatus ?? "arquivados";

/** O card pode ir para o arquivo por «Arquivar os antigos»? Uma história viva, fora da captura, num board que TEM o
 *  arquivo — e o arquivo é reversível (reviver devolve o card para onde estava). PURA. */
function archivableCard(card: Card | undefined, config: BoardConfig): boolean {
  if (!card || card.type !== "story" || card.capture || card.mode === "retire") return false;
  if (config.statuses.find((s) => s.id === card.status)?.terminal === true) return false;
  return config.statuses.some((s) => s.id === STALE_ARCHIVE_STATUS);
}

const rank = (k: InboxEntry["kind"]) => (k === "system-decision" ? INBOX_PRECEDENCE.length : INBOX_PRECEDENCE.indexOf(k));

/** O card que uma causa nomeia (`card:<id>`) — a âncora: as entradas DELE lideram a dobra. */
const anchorOf = (causeKey: string): string | null => (causeKey.startsWith("card:") ? causeKey.slice(5) : null);

/**
 * Dobra por CAUSA, dentro de cada seção: fica a entrada do card âncora da causa (quando a causa nomeia um card) e, entre
 * elas, a de maior precedência; as outras viram facetas. Uma decisão do sistema nunca dobra (a causa dela é ela). PURA.
 */
export function foldByCause(entries: readonly InboxEntry[]): InboxEntry[] {
  const out: InboxEntry[] = [];
  const lead = new Map<string, number>();
  const anchored = (e: InboxEntry) => (anchorOf(e.causeKey) === e.cardId ? 0 : 1);
  const sorted = [...entries].sort((a, z) => anchored(a) - anchored(z) || rank(a.kind) - rank(z.kind));
  for (const e of sorted) {
    if (e.kind === "system-decision") {
      out.push(e);
      continue;
    }
    const k = `${e.decision.bucket}|${e.boardId}|${e.causeKey}`;
    const at = lead.get(k);
    if (at === undefined) {
      lead.set(k, out.length);
      out.push({ ...e, facets: [...e.facets] });
      continue;
    }
    const facet: InboxFacet = { itemId: e.itemId, kind: e.kind as CockpitItemKind, ask: e.decision.ask, ...(e.cardId ? { cardId: e.cardId, cardTitle: e.cardTitle } : {}) };
    out[at] = { ...out[at], facets: [...out[at].facets, facet, ...e.facets] };
  }
  // ENTRE seções: a aprovação de um card em Decidir e, em Acompanhar, a publicação parada que espera exatamente essa
  // decisão (mesma causa) eram o mesmo assunto em dois lugares. A decisão é a ação: a publicação parada vira faceta dela.
  const decideLead = new Map<string, number>();
  out.forEach((e, i) => {
    if (e.kind !== "system-decision" && e.decision.bucket === "decidir") decideLead.set(`${e.boardId}|${e.causeKey}`, i);
  });
  const absorbed = new Set<number>();
  out.forEach((e, i) => {
    // só a publicação parada que ESPERA essa decisão — outros acompanhamentos do mesmo card (auditoria de entrega, o
    // procurador que respondeu) são outro assunto e seguem sozinhos.
    if (e.kind !== "deploy-failed" || e.decision.bucket !== "acompanhar") return;
    const at = decideLead.get(`${e.boardId}|${e.causeKey}`);
    if (at === undefined) return;
    const facet: InboxFacet = { itemId: e.itemId, kind: e.kind as CockpitItemKind, ask: e.decision.ask, ...(e.cardId ? { cardId: e.cardId, cardTitle: e.cardTitle } : {}) };
    out[at] = { ...out[at], facets: [...out[at].facets, facet, ...e.facets] };
    absorbed.add(i);
  });
  const kept = out.filter((_, i) => !absorbed.has(i));
  // A ordem de volta à da coleta (a precedência só escolhe quem lidera cada causa).
  const order = new Map(entries.map((e, i) => [e.key, i]));
  return kept.sort((a, z) => (order.get(a.key) ?? 0) - (order.get(z.key) ?? 0));
}

/** O nome antigo da dobra (testes de outros módulos o chamam): a dobra é por causa, e a causa padrão é o card. */
export const foldByCard = foldByCause;

/** O contexto de um board para montar as entradas. */
export interface BoardEntriesCtx {
  boardId: string;
  boardName: string;
  config: BoardConfig;
  cardsById: ReadonlyMap<string, Card>;
  now: number;
  /** os fatos pré-computados do board (contract.ts) — o coletor os dá; o sinal de um card sozinho, não. */
  facts?: InboxFacts;
  /**
   * O nome humano de cada lente de revisão (`id → name`, de {@link lensNamesOf}). Vem do SERVIDOR: o settings não
   * atravessa para o cliente, então quem monta o Inbox a partir do disco o preenche e quem decide só pelo card (a pílula
   * do Kanban) não — e então o item mostra o id da lente, como sempre.
   */
  lensNames?: Readonly<Record<string, string>>;
}

/**
 * O mapa `id → nome` das lentes de revisão EFETIVAS do alvo (as embutidas, com a sobrescrita dele, e as que ele declarou).
 * Sem perfil, só as embutidas. É o que o Inbox e o documento do card passam ao rótulo da lente. PURA.
 */
export function lensNamesOf(target: TargetProfile | null | undefined): Record<string, string> {
  return Object.fromEntries(reviewLensesOf(target).map((l) => [l.id, l.name]));
}

/** Um item que saiu do Inbox porque a causa dele deixou de ser verdade — o recibo que «Resolvido hoje» mostra. */
export interface RetiredItem {
  item: CockpitItem;
  liveness: Exclude<Liveness, { alive: true }>;
}

/**
 * Os itens vivos de UM board, assentados pelo contrato: os que não moram no Inbox saem (o aviso que é dívida do card),
 * os que a causa não sustenta mais saem com recibo (`retired`), e o resto vira entrada — decidida, promovida pelo
 * prazo, com a causa e o «parado». Sem a dobra. PURA.
 */
export function settleItems(items: readonly CockpitItem[], ctx: BoardEntriesCtx): { entries: InboxEntry[]; retired: RetiredItem[] } {
  const tier = copilotTier(ctx.config.orchestrator ?? null);
  const entries: InboxEntry[] = [];
  const retired: RetiredItem[] = [];
  for (const item of items) {
    const liveness = itemLiveness(item, ctx.facts, ctx.now);
    if (!liveness.alive) {
      retired.push({ item, liveness });
      continue;
    }
    const card = item.cardId ? ctx.cardsById.get(item.cardId) : undefined;
    const decision = promote(decideItem(item, { config: ctx.config, card, now: ctx.now, tier, ...(ctx.facts ? { facts: ctx.facts } : {}), ...(ctx.lensNames ? { lensNames: ctx.lensNames } : {}) }), ctx.now);
    if (!isInboxItem(item, decision.verdict)) continue;
    const days = decision.banner ? null : staleDays(item.since, ctx.now);
    entries.push({
      key: `${ctx.boardId}/${item.id}`,
      boardId: ctx.boardId,
      boardName: ctx.boardName,
      itemId: item.id,
      cardId: item.cardId,
      cardTitle: item.cardTitle,
      kind: item.kind,
      decision,
      causeKey: itemCauseKey(item, ctx.facts),
      facets: [],
      ...(days != null
        ? { stale: { days, archivable: ARCHIVABLE.has(item.kind) && archivableCard(card, ctx.config) } }
        : {}),
      item,
    });
  }
  return { entries: foldPublishHolds(entries), retired };
}

/**
 * A publicação parada de um card é UMA coisa: o item do passo de publicação dele cujo botão publica (contract.ts
 * `foldsIntoPublishHold`) passa a ser o aviso de publicação vivo do MESMO card — a mesma causa e a mesma decisão, com a
 * idade dele. Assim ele dobra na entrada da causa, na mesma seção, e nunca oferece publicar o que a causa vai parar de
 * novo. O aviso que a causa já não sustenta saiu antes daqui (retirado): sem ele, o item volta a ser o que o card diz.
 * PURA.
 */
function foldPublishHolds(entries: InboxEntry[]): InboxEntry[] {
  const holds = new Map(entries.filter((e) => e.kind === "deploy-failed" && e.cardId).map((e) => [e.cardId, e]));
  if (holds.size === 0) return entries;
  return entries.map((e) => {
    const hold = holds.get(e.cardId);
    if (!hold || hold === e || e.kind === "system-decision" || !foldsIntoPublishHold(e.kind, e.decision.options)) return e;
    return { ...e, causeKey: hold.causeKey, decision: { ...hold.decision, since: e.decision.since } };
  });
}

/** As entradas dos itens vivos de UM board (as de {@link settleItems}, sem os recibos). Sem a dobra. PURA. */
export function itemEntries(items: readonly CockpitItem[], ctx: BoardEntriesCtx): InboxEntry[] {
  return settleItems(items, ctx).entries;
}

/** As seções, na ordem de ler: Decidir (o mais urgente primeiro) e Acompanhar (o mais novo primeiro). PURA. */
export function inboxSections(entries: readonly InboxEntry[]): { decidir: InboxEntry[]; acompanhar: InboxEntry[]; banners: InboxEntry[] } {
  const banners: InboxEntry[] = [];
  const seenBanner = new Set<string>();
  const decidir: InboxEntry[] = [];
  const acompanhar: InboxEntry[] = [];
  for (const e of entries) {
    if (e.decision.banner) {
      // O aviso do host se repete em todo board — uma faixa só.
      if (!seenBanner.has(e.itemId)) banners.push(e);
      seenBanner.add(e.itemId);
      continue;
    }
    (e.decision.bucket === "decidir" ? decidir : acompanhar).push(e);
  }
  const urgency = { red: 0, amber: 1, green: 2, grey: 3 } as const;
  const since = (e: InboxEntry) => e.decision.since ?? "9999";
  decidir.sort((a, z) => Number(!!a.stale) - Number(!!z.stale) || urgency[a.decision.dot] - urgency[z.decision.dot] || since(a).localeCompare(since(z)));
  acompanhar.sort((a, z) => since(z).localeCompare(since(a)));
  return { decidir, acompanhar, banners };
}

/**
 * O que «Arquivar os antigos» leva: os itens de DECIDIR parados há mais de 30 dias cujo card é uma história que pode ir
 * para o arquivo — um por card (a dobra já garante), nunca um de Acompanhar (ali o sistema ainda está trabalhando).
 * A MESMA régua na tela (o número do botão) e no servidor (que re-coleta antes de arquivar). PURA.
 */
export function archivableStale(entries: readonly InboxEntry[]): InboxEntry[] {
  const seen = new Set<string>();
  const out: InboxEntry[] = [];
  for (const e of entries) {
    if (e.decision.bucket !== "decidir" || !e.stale?.archivable || !e.cardId) continue;
    const k = `${e.boardId}|${e.cardId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** O que as contagens dizem: quantos para DECIDIR (o único número do badge), quantos em Acompanhar e quantos deles
 *  ninguém vai pegar sozinho. Conta as entradas JÁ dobradas por card; a faixa do host não conta. PURA. */
export function inboxSummary(entries: readonly InboxEntry[]): { decidir: number; acompanhar: number; stalled: number } {
  const { decidir, acompanhar } = inboxSections(entries);
  return { decidir: decidir.length, acompanhar: acompanhar.length, stalled: acompanhar.filter((e) => e.decision.next.stalled).length };
}

/** «3 para decidir · 2 acompanhando · 1 sem ninguém cuidando» — o que ninguém cuida só aparece quando há. PURA. */
export function summaryLine(s: { decidir: number; acompanhar: number; stalled: number }): string {
  const parts = [`${s.decidir} para decidir`, `${s.acompanhar} acompanhando`];
  if (s.stalled > 0) parts.push(`${s.stalled} sem ninguém cuidando`);
  return parts.join(" · ");
}

/** «Nada para você decidir. Livraria tem 3 em Acompanhar; Atendimento, 1.» — onde está o resto. PURA. */
export function emptyDecidirText(boards: ReadonlyArray<{ id: string; name: string; acompanhar: number }>, filter: string | null): string {
  const scope = filter ? boards.filter((b) => b.id === filter) : boards;
  const withFollow = scope.filter((b) => b.acompanhar > 0);
  if (withFollow.length === 0) return "Nada para você decidir. Os agentes seguem sozinhos.";
  const [first, ...rest] = withFollow;
  const tail = rest.map((b) => `${b.name}, ${b.acompanhar}`).join("; ");
  return `Nada para você decidir. ${first.name} tem ${first.acompanhar} em Acompanhar${tail ? `; ${tail}` : ""}.`;
}

/** A frase curta de um item para uma linha estreita (o popover da barra, o push): a decisão, sem o sufixo. PURA. */
export function entryHeadline(e: Pick<InboxEntry, "decision" | "cardTitle">): string {
  return e.decision.ask || quoted(e.cardTitle);
}
