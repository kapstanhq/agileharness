// O LOTE DO CONDUTOR — as regras PURAS (fase 7, decisões 5–9 do dono).
//
// História (novidade) roda SEMPRE sozinha. Correções e manutenções da MESMA funcionalidade podem ir num lote numa
// sessão só — o condutor escolhe quais (`claim_batch`). Teto do lote: US$ 10 por item, no máximo US$ 30 (o teto de uma
// história), nunca acima do que o board permite por card. «Outros» e grupos `self` nunca formam lote.
//
// Aqui moram só as réguas PURAS: quem pode entrar ({@link validateBatch}), o teto ({@link batchCapUSD}), a marca do
// lote no card, e a leitura dos trailers `Card: <id>` dos commits (um commit por item — a submissão recusa o código de
// um item que saiu do lote, e o `done` do train dá a cada item o seu `commitRange`). O IO (claims, fila, cards, sessão)
// mora em conductor-batch-ops.ts; a produção em conductor-batch-deps.ts.

import { conductorFromStatuses, isConducted } from "../driver";
import { kindOf } from "../kanban-features";
import type { FeatureKey } from "../feature-key";
import type { Card, CardBatchMark, CommitRange } from "../types";
import { CARD_SPEND_CEILING_USD, cardCapUSD, effectiveCardBudgetUSD } from "./card-budget";
import type { ConductorQueueEntry } from "./conductor";

type BudgetFields = Partial<Pick<Card, "mode" | "storyType" | "bugReport">>;

/** O item pode entrar num lote? Só correção (bug, modo `fix`) e manutenção (chore); história, técnica e spike não. PURA. */
export function batchable(card: Pick<Card, "storyType" | "mode">): boolean {
  return kindOf(card) !== "Novidade";
}

/**
 * O teto do LOTE (US$), com o líder contado em `items`: US$ 10 por item (decisão 8 do dono — também numa manutenção,
 * cujo teto sozinho seria o de história), limitado pelo teto do board por card (`cardCapUSD`), e no máximo o teto de
 * uma história (US$ 30). `null` quando o board desligou o teto por card (o lote segue o board) ou sem itens. Aumentos
 * aprovados entram depois, por `effectiveCardBudgetUSD(batchCap, lead)`. PURA.
 */
export function batchCapUSD(settingsCap: number | null | undefined, items: readonly BudgetFields[]): number | null {
  const perItem = cardCapUSD(settingsCap, { storyType: "bug" });
  if (perItem == null || !items.length) return null;
  return Math.min(perItem * items.length, CARD_SPEND_CEILING_USD.story);
}

/** Por que um item não entra no lote (a classe estável — o texto vai em `detail`). */
export type BatchRefusalReason =
  | "other-board"
  | "other-feature"
  | "no-shared-feature"
  | "not-batchable"
  | "not-conducted"
  | "not-queued"
  | "deferred"
  | "reopen-pending"
  | "out-of-scope"
  | "solo"
  | "dropped"
  | "claimed"
  | "item-over-cap"
  | "batch-over-cap"
  | "closed";

export interface BatchRefusal {
  /** o item recusado (o líder, quando a recusa é do lote inteiro — `closed`, `batch-over-cap`). */
  cardId: string;
  reason: BatchRefusalReason;
  /** a frase para o condutor, em português simples. */
  detail: string;
}

/** O que {@link validateBatch} precisa saber além dos cards — tudo injetado (o validador é PURO). */
export interface BatchValidationCtx {
  /** o board do lote (o do líder). */
  board: string;
  /** o board de cada item como foi lido (item de outro board ⇒ `other-board`). */
  boardOf(cardId: string): string | undefined;
  /** a chave da funcionalidade (feature-key.ts `featureKeyOf`, com o contexto do board). */
  featureKeyOf(card: Card): FeatureKey;
  /** a fila do condutor (o item tem de estar nela — ou ser órfão em `fromStatus`). */
  queue: readonly ConductorQueueEntry[];
  /** o(s) status em que o condutor adota órfãos (`conductor.fromStatus`); null = sem adoção. */
  fromStatus: string | readonly string[] | null;
  /** o recorte do board admite o card (a mesma régua do despacho). */
  admittedByScope(card: Card): boolean;
  /** os itens que ESTA sessão já tirou do lote (nunca voltam). */
  droppedBySession: ReadonlySet<string>;
  /** quem segura um claim vivo no card, se não for a própria sessão; null = livre. */
  foreignClaimHolder(cardId: string): string | null;
  /** o teto do board por card (`autorun.cardBudgetUSD`), para `cardCapUSD`. */
  settingsCapUSD: number | null | undefined;
  /** o gasto já registrado de cada card (ledger). */
  ledgerUSD(cardId: string): number;
  /** o custo da sessão do condutor até agora. */
  sessionCostUSD: number;
  /** o plano do lote já foi submetido (`AgentSession.batch.closed`) — nenhum item novo entra. */
  closed: boolean;
  /** os itens que a sessão JÁ tem no lote (entram na conta do teto, não são revalidados). */
  existingItems?: readonly Card[];
}

export type BatchVerdict =
  | { ok: true; capUSD: number | null; cardIds: string[] }
  | { ok: false; refusals: BatchRefusal[] };

/**
 * A chave forma lote / ocupa a funcionalidade? «Outros (fora do PRD)» e o card que é a própria funcionalidade (`self`,
 * sem pai no modo mapa) não têm funcionalidade em comum com ninguém: nunca formam lote e nunca seguram outro condutor.
 * PURA.
 */
export function sharesFeature(key: Pick<FeatureKey, "source" | "self"> | null | undefined): boolean {
  return !!key && key.source !== "outros" && !key.self;
}

/**
 * A admissão de um lote: `items` (sem o líder) juntam-se ao `lead`? Todas as condições do plano §5 — mesmo board e
 * mesma funcionalidade, todos loteáveis, conduzidos e na fila (ou órfãos no `fromStatus`, ou itens do lote ANTERIOR do
 * mesmo líder, que a retomada depois do train re-pega), sem adiamento nem reabertura pendente, admitidos pelo recorte,
 * não `solo` nem já tirados por esta sessão, sem claim de outro, dentro do teto (por item e do lote) e com o lote ainda
 * aberto. Tudo ou nada: qualquer recusa recusa o lote. PURA.
 */
export function validateBatch(lead: Card, items: readonly Card[], ctx: BatchValidationCtx): BatchVerdict {
  const refusals: BatchRefusal[] = [];
  const refuse = (cardId: string, reason: BatchRefusalReason, detail: string) => refusals.push({ cardId, reason, detail });
  if (ctx.closed) {
    refuse(lead.id, "closed", "o plano do lote já foi submetido — nenhum item novo entra neste lote; o item espera a vez dele na fila");
  }
  const leadKey = ctx.featureKeyOf(lead);
  if (!batchable(lead)) refuse(lead.id, "not-batchable", "o líder é uma história (novidade) — história roda sempre sozinha");
  if (!sharesFeature(leadKey)) {
    refuse(lead.id, "no-shared-feature", `o líder está em «${leadKey.title}», que não é uma funcionalidade comum — sem lote`);
  }
  const fromStatuses = new Set(conductorFromStatuses(ctx.fromStatus as string | string[] | null));
  const fresh: Card[] = [];
  const seen = new Set<string>([lead.id]);
  for (const item of items) {
    if (seen.has(item.id)) continue; // repetido (ou o próprio líder): nada a julgar
    seen.add(item.id);
    fresh.push(item);
    if (ctx.boardOf(item.id) !== ctx.board) {
      refuse(item.id, "other-board", `o item ${item.id} não é do board ${ctx.board}`);
      continue;
    }
    if (!batchable(item)) {
      refuse(item.id, "not-batchable", `o item ${item.id} é uma história (novidade) — história roda sempre sozinha`);
      continue;
    }
    const key = ctx.featureKeyOf(item);
    if (!sharesFeature(key)) {
      refuse(item.id, "no-shared-feature", `o item ${item.id} está em «${key.title}», que não é uma funcionalidade comum`);
      continue;
    }
    if (key.id !== leadKey.id) {
      refuse(item.id, "other-feature", `o item ${item.id} é de outra funcionalidade («${key.title}», o líder é de «${leadKey.title}»)`);
      continue;
    }
    if (!isConducted(item)) {
      refuse(item.id, "not-conducted", `o item ${item.id} não está com o condutor (sem routing.driver: conductor)`);
      continue;
    }
    const entry = ctx.queue.find((e) => e.board === ctx.board && e.cardId === item.id);
    const resume = item.batch?.lead === lead.id; // do lote anterior deste líder (a retomada depois do train)
    const orphan = !!item.status && fromStatuses.has(item.status);
    if (!entry && !resume && !orphan) {
      refuse(item.id, "not-queued", `o item ${item.id} não está na fila do condutor`);
      continue;
    }
    if (entry?.solo) {
      refuse(item.id, "solo", `o item ${item.id} já saiu de um lote — ele roda sozinho`);
      continue;
    }
    if (ctx.droppedBySession.has(item.id)) {
      refuse(item.id, "dropped", `o item ${item.id} já saiu deste lote — não volta`);
      continue;
    }
    if (item.deferred) {
      refuse(item.id, "deferred", `o item ${item.id} foi adiado (não agora)`);
      continue;
    }
    if (item.reopenPending) {
      refuse(item.id, "reopen-pending", `o item ${item.id} tem uma reabertura pendente — a skill dela roda antes`);
      continue;
    }
    if (!ctx.admittedByScope(item)) {
      refuse(item.id, "out-of-scope", `o board não está começando este tipo de item agora (${item.id})`);
      continue;
    }
    const holder = ctx.foreignClaimHolder(item.id);
    if (holder) {
      refuse(item.id, "claimed", `o item ${item.id} já tem dono (${holder})`);
      continue;
    }
    const itemCap = cardCapUSD(ctx.settingsCapUSD, item);
    const spent = ctx.ledgerUSD(item.id);
    if (itemCap != null && spent >= effectiveCardBudgetUSD(itemCap, item)!) {
      refuse(item.id, "item-over-cap", `o item ${item.id} já gastou US$ ${spent.toFixed(2)} — chegou ao teto dele`);
    }
  }
  const members = [lead, ...(ctx.existingItems ?? []).filter((c) => !seen.has(c.id)), ...fresh];
  const cap = batchCapUSD(ctx.settingsCapUSD, members);
  const capInForce = effectiveCardBudgetUSD(cap, lead);
  if (capInForce != null) {
    const spent = ctx.sessionCostUSD + members.reduce((acc, c) => acc + ctx.ledgerUSD(c.id), 0);
    if (spent >= capInForce) {
      refuse(
        lead.id,
        "batch-over-cap",
        `o lote com ${members.length} item(ns) teria teto de US$ ${capInForce} e já gastou US$ ${spent.toFixed(2)} — pegue menos itens`,
      );
    }
  }
  if (refusals.length) return { ok: false, refusals };
  return { ok: true, capUSD: capInForce, cardIds: fresh.map((c) => c.id) };
}

/** O id do lote de uma sessão (um lote por sessão de condutor; a retomada abre outro). PURA. */
export function batchIdFor(sessionId: string): string {
  return `lote-${sessionId.slice(0, 8)}`;
}

/** A marca do lote para um card que entra nele agora. PURA. */
export function batchMark(input: { id: string; lead: string; sessionId: string; at: string; planHash?: string }): CardBatchMark {
  return { id: input.id, lead: input.lead, sessionId: input.sessionId, at: input.at, ...(input.planHash ? { planHash: input.planHash } : {}) };
}

/** A frase curta das recusas (para a tool e o log). PURA. */
export function batchRefusalText(refusals: readonly BatchRefusal[]): string {
  return refusals.map((r) => `${r.cardId}: ${r.detail}`).join("; ");
}

// ── os commits do lote: um por item, com o trailer `Card: <id>` ─────────────────────────────────────────────────

/** O trailer que diz de qual item é o commit. */
export const CARD_TRAILER = "Card";
/** O trailer do commit que DESFAZ o commit de um item que saiu do lote (`Card-Revert: <sha>`). */
export const CARD_REVERT_TRAILER = "Card-Revert";

/** Um commit como `git log` o devolve (o mais antigo primeiro). */
export interface BatchCommit {
  sha: string;
  /** o primeiro pai (a base do intervalo do item); ausente num commit raiz. */
  parent?: string;
  message: string;
}

const TRAILER_LINE = /^(Card|Card-Revert):[ \t]*(\S+)[ \t]*$/gim;
const GIT_REVERT_LINE = /^This reverts commit ([0-9a-f]{7,40})\b/gim;

/** Os trailers de uma mensagem de commit: os itens (`Card:`) e os shas desfeitos (`Card-Revert:` ou `git revert`). PURA. */
export function commitTrailers(message: string): { cards: string[]; reverts: string[] } {
  const cards: string[] = [];
  const reverts: string[] = [];
  for (const m of message.matchAll(TRAILER_LINE)) {
    if (m[1].toLowerCase() === CARD_TRAILER.toLowerCase()) cards.push(m[2]);
    else reverts.push(m[2].toLowerCase());
  }
  for (const m of message.matchAll(GIT_REVERT_LINE)) reverts.push(m[1].toLowerCase());
  return { cards, reverts };
}

const shaMatches = (full: string, ref: string) => ref.length >= 7 && full.toLowerCase().startsWith(ref);

/** Os shas do intervalo desfeitos por um commit posterior dele. PURA. */
function revertedShas(commits: readonly BatchCommit[]): Set<string> {
  const out = new Set<string>();
  commits.forEach((c, i) => {
    for (const ref of commitTrailers(c.message).reverts) {
      const hit = commits.slice(0, i).find((x) => shaMatches(x.sha, ref));
      if (hit) {
        out.add(hit.sha);
        out.add(c.sha); // o par se anula: o revert também não é código de ninguém
      }
    }
  });
  return out;
}

/**
 * Os commits de itens que SAÍRAM do lote e continuam no intervalo da submissão (sem um `Card-Revert:`/`git revert`
 * depois deles). A submissão é recusada com eles: o código de um item que falhou não vai ao train com os outros. PURA.
 */
export function unrevertedDroppedCommits(commits: readonly BatchCommit[], dropped: readonly string[]): Array<{ cardId: string; sha: string }> {
  if (!dropped.length) return [];
  const gone = new Set(dropped);
  const reverted = revertedShas(commits);
  const out: Array<{ cardId: string; sha: string }> = [];
  for (const c of commits) {
    if (reverted.has(c.sha)) continue;
    for (const id of commitTrailers(c.message).cards) if (gone.has(id)) out.push({ cardId: id, sha: c.sha });
  }
  return out;
}

/**
 * O `commitRange` de cada item, pelos trailers do intervalo integrado (o mais antigo primeiro): do pai do primeiro
 * commit do item ao último commit dele. Commits desfeitos não contam. Um item sem commit no intervalo fica de fora. PURA.
 */
export function itemCommitRanges(commits: readonly BatchCommit[], cardIds: readonly string[]): Record<string, CommitRange> {
  const wanted = new Set(cardIds);
  const reverted = revertedShas(commits);
  const out: Record<string, CommitRange> = {};
  for (const c of commits) {
    if (reverted.has(c.sha)) continue;
    for (const id of commitTrailers(c.message).cards) {
      if (!wanted.has(id)) continue;
      const prev = out[id];
      if (prev) prev.head = c.sha;
      else if (c.parent) out[id] = { base: c.parent, head: c.sha };
    }
  }
  return out;
}
