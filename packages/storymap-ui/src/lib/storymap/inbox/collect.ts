// O COLETOR do Inbox — a única leitura de disco do modelo de item. Server-only: lê o board (o mesmo coletor do
// cockpit, `collectBoardCockpit`) e os FATOS que o contrato julga (contract.ts — o livro de causas de publicação, o
// disjuntor, o registro de ações), e entrega as entradas decididas (entries.ts). Toda superfície — a lista, a página do
// item, a home, o chip da barra, a raia do dono no Kanban, a aba do celular e a fala do Jido — lê daqui, então nenhuma
// delas pode discordar das outras sobre o que é seu.
//
// O coletor só LÊ fatos já medidos (C9 do ciclo de conserto): nunca roda o plano de publicação nem o git. As causas de
// publicação vêm do livro que a varredura mantém (runner/deploy-blocks.ts); um aviso antigo, anterior às causas, ganha
// a causa reconstruída pelo título — a mesma régua de quando a varredura o completar.

import { promises as fsp } from "node:fs";
import { collectBoardCockpit } from "@/lib/storymap/cockpit-collect";
import { listBoards } from "@/lib/storymap/repo";
import { readSystemDecisions } from "@/lib/storymap/runner/decision-log";
import { readInboxReceipts } from "@/lib/storymap/runner/receipts-log";
import { readAgentActions } from "@/lib/storymap/runner/agent-actions";
import { backfillDeployCause, deployBlocksFile, openDeployFailure, parseDeployBlocks, type DeployBlockRow } from "@/lib/storymap/runner/deploy-blocks";
import { tryGetPublishBreaker } from "@/lib/storymap/runner/publish-breaker";
import { followUpItems, type SystemDecision } from "@/lib/storymap/system-decisions";
import type { ApprovalRequest } from "@/lib/storymap/approvals";
import type { CockpitItem } from "@/lib/storymap/demands";
import type { BoardConfig, Card, DeployCause, GovernanceDraft } from "@/lib/storymap/types";
import { deployAnchors, emptyFacts, type ExecutedAction, type InboxFacts } from "./contract";
import { foldByCause, inboxSummary, settleItems, type InboxEntry, type RetiredItem } from "./entries";
import { expiredFacts, RESOLVED_WINDOW_MS, resolvedToday, type InboxReceiptRecord, type ResolvedEntry } from "./receipts";
import { followUpInWindow, isOwnerReview, systemDecisionEntry } from "./system-entries";

/** O Inbox de UM board. */
export interface BoardInbox {
  boardId: string;
  boardName: string;
  config: BoardConfig;
  cards: Card[];
  /** as entradas dobradas por causa — o que a lista mostra. */
  entries: InboxEntry[];
  /** as entradas SEM a dobra (e as decisões do sistema que moram só no registro) — a página de um item abre a dele. */
  all: InboxEntry[];
  /** «Resolvido hoje»: o que saiu do Inbox deste board nas últimas 24 horas — pelo dono, pelo sistema ou por um prazo. */
  resolved: ResolvedEntry[];
  /** os recibos e as decisões do sistema do board — a página de um item que sumiu acha o desfecho dele aqui. */
  receipts: InboxReceiptRecord[];
  decisions: SystemDecision[];
}

/**
 * O Inbox de um board, ou null quando o board não existe: os itens vivos (decididos e dobrados por causa) mais as
 * decisões do sistema que o dono combinou rever (Acompanhar, com o porquê e o «Desfazer»).
 */
export async function collectBoardInbox(
  boardId: string,
  now: number = Date.now(),
  /** os recibos já lidos (o Inbox de todos os boards lê o ledger uma vez só). */
  preloaded?: { receipts?: readonly InboxReceiptRecord[] },
): Promise<BoardInbox | null> {
  const [cockpit, decisions, receipts] = await Promise.all([
    collectBoardCockpit(boardId),
    readSystemDecisions({ board: boardId }).catch(() => []),
    preloaded?.receipts ? Promise.resolve(preloaded.receipts.filter((r) => r.board === boardId)) : readInboxReceipts({ board: boardId }).catch(() => []),
  ]);
  const { items, cards, config, approvals, governanceDrafts } = cockpit;
  if (!config) return null;
  const facts = await readInboxFacts({ boardId, config, cards, items, approvals, lastTransitionAt: cockpit.lastTransitionAt, stepEnteredAt: cockpit.stepEnteredAt, now });
  const built = boardEntries({ boardId, config, cards, items, decisions, now, facts });
  return {
    boardId,
    boardName: config.name,
    config,
    cards,
    entries: built.entries,
    all: built.all,
    resolved: boardResolved({ boardId, config, cards, receipts, decisions, approvals, drafts: governanceDrafts, retired: built.retired, now }),
    receipts,
    decisions,
  };
}

// ── os fatos (IO na borda; a montagem é pura) ────────────────────────────────────────────────────────────

/**
 * A causa de publicação de cada card com o aviso de publicação aberto: a gravada pela varredura (`deployCause`), senão a
 * reconstruída do título do aviso antigo, sem plano (deploy-blocks.ts `backfillDeployCause` — fail-closed: do dono, com
 * a classe que o título nomeou). PURA.
 */
export function cardDeployCauses(cards: readonly Card[], boardId: string, config: BoardConfig): Map<string, DeployCause> {
  const out = new Map<string, DeployCause>();
  for (const card of cards) {
    const f = openDeployFailure(card);
    if (!f) continue;
    out.set(card.id, f.deployCause ?? backfillDeployCause(f, { board: boardId, cardId: card.id, deployTargets: card.deployTargets, config, lastPlan: null }));
  }
  return out;
}

/** Os fatos do board, montados do que o disco deu. PURA. */
export function inboxFactsOf(input: {
  boardId: string;
  config: BoardConfig;
  cards: readonly Card[];
  /** as linhas do livro de causas de TODOS os boards; null = sem livro que se possa julgar (ausente ou ilegível). */
  ledger: readonly DeployBlockRow[] | null;
  /** os itens do board como o coletor os entregou (o item de aprovação de cada card, com o recuo do Jido). */
  items?: readonly CockpitItem[];
  publishRetryAt?: ReadonlyMap<string, number>;
  lastTransitionAt?: ReadonlyMap<string, string>;
  stepEnteredAt?: ReadonlyMap<string, string>;
  actions?: readonly ExecutedAction[];
}): InboxFacts {
  const base = emptyFacts(input.cards);
  const deployCauseOf = cardDeployCauses(input.cards, input.boardId, input.config);
  const rows = input.ledger?.filter((r) => r.board === input.boardId) ?? null;
  return {
    ...base,
    deployCauseOf,
    deployLedger: rows ? new Set(rows.map((r) => r.causeKey)) : null,
    deployAnchor: deployAnchors(deployCauseOf.values(), new Map((rows ?? []).map((r) => [r.causeKey, r.attributedCard])), base.cardsById, input.config),
    deployApprovals: new Map((rows ?? []).filter((r) => r.decider === "owner" && r.approvals?.length).map((r) => [r.causeKey, r.approvals ?? []])),
    gateOf: new Map((input.items ?? []).filter((i) => i.kind === "gate" && i.cardId).map((i) => [i.cardId, i])),
    publishRetryAt: input.publishRetryAt ?? new Map(),
    lastTransitionAt: input.lastTransitionAt ?? new Map(),
    stepEnteredAt: input.stepEnteredAt ?? new Map(),
    actions: input.actions ?? [],
  };
}

/** Os kinds cujo contrato lê o registro de ações: o pedido pendente (já aconteceu?) e o travado que se repete. */
const needsActions = (items: readonly CockpitItem[]) =>
  items.some((i) => (i.kind === "approval" && i.cardId) || (i.kind === "stuck" && ["no-op", "budget-cut"].includes(i.reason ?? i.outcome ?? "")));

/**
 * Lê os fatos que o contrato julga — só os que algum item do board precisa (o livro de causas e o disjuntor quando há
 * publicação parada; o registro de ações quando há pedido pendente ou travado repetido). Toda leitura que falha cai no
 * «não sei» do contrato (o item fica como o card o mostra). Nunca lança.
 */
async function readInboxFacts(input: {
  boardId: string;
  config: BoardConfig;
  cards: readonly Card[];
  items: readonly CockpitItem[];
  approvals: readonly ApprovalRequest[];
  lastTransitionAt: ReadonlyMap<string, string>;
  stepEnteredAt: ReadonlyMap<string, string>;
  now: number;
}): Promise<InboxFacts> {
  const deploys = input.items.filter((i) => i.kind === "deploy-failed").map((i) => i.cardId);
  const [ledger, publishRetryAt, actions] = await Promise.all([
    deploys.length ? readDeployLedger(undefined, input.boardId) : Promise.resolve(null),
    deploys.length ? readRetries(input.boardId, deploys, input.now) : Promise.resolve(new Map<string, number>()),
    needsActions(input.items) ? readAgentActions({ board: input.boardId, since: input.now - 14 * 86_400_000 }).catch(() => []) : Promise.resolve([]),
  ]);
  return inboxFactsOf({ ...input, ledger, publishRetryAt, actions });
}

/**
 * O livro de causas, ou null quando ele não pode ser JULGADO: ausente (antes da primeira varredura) ou ilegível (JSON
 * cortado, versão desconhecida, `rows` que não é lista, uma linha que não se lê). «Sem livro» não é «livro vazio»: o livro
 * vazio retira toda causa gravada com um recibo «o sistema publica de novo». Caso da revisão: o leitor tolerante
 * do livro (`readDeployBlocks`, o do escritor) devolve [] para um arquivo de versão mais nova — a ferramenta voltou de versão
 * depois de uma mais nova gravá-lo — e a causa pendente do dono sumia do Inbox. Fail-closed. Nunca lança.
 * Um livro RECOMEÇADO depois de não se ler só fala pelo `board` que a varredura já re-sincronizou (deploy-blocks.ts).
 */
export async function readDeployLedger(file?: string, board?: string): Promise<DeployBlockRow[] | null> {
  try {
    return parseDeployBlocks(await fsp.readFile(file ?? deployBlocksFile(), "utf8"), board);
  } catch {
    return null;
  }
}

/** Quando o disjuntor tenta publicar de novo cada card (só as tentativas ainda por vir). */
async function readRetries(boardId: string, cardIds: readonly string[], now: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const breaker = tryGetPublishBreaker();
  if (!breaker) return out;
  for (const id of new Set(cardIds)) {
    const at = await breaker.retryAt(boardId, id, now).catch(() => null);
    if (at != null) out.set(id, at);
  }
  return out;
}

// ── as entradas e o «Resolvido hoje» (puros) ─────────────────────────────────────────────────────────────

/** «Resolvido hoje» de um board a partir do que o disco deu — com os itens que o contrato retirou. PURA. */
export function boardResolved(input: {
  boardId: string;
  config: Pick<BoardConfig, "name">;
  cards: readonly Card[];
  receipts: readonly InboxReceiptRecord[];
  decisions: readonly SystemDecision[];
  approvals: readonly ApprovalRequest[];
  drafts: readonly GovernanceDraft[];
  /** os itens cuja causa deixou de ser verdade nesta leitura (entries.ts `settleItems`). */
  retired?: readonly RetiredItem[];
  now: number;
}): ResolvedEntry[] {
  const titles = new Map(input.cards.map((c) => [c.id, c.title]));
  const today = resolvedToday({
    receipts: input.receipts,
    decisions: followUpItems(input.decisions, { board: input.boardId }),
    expired: expiredFacts({ boardId: input.boardId, approvals: input.approvals, drafts: input.drafts, cardTitle: (id) => titles.get(id), now: input.now }),
    boardName: () => input.config.name,
    now: input.now,
  });
  const since = new Date(input.now - RESOLVED_WINDOW_MS).toISOString();
  const until = new Date(input.now).toISOString();
  const retired: ResolvedEntry[] = (input.retired ?? [])
    .filter((r) => r.liveness.at >= since && r.liveness.at <= until)
    .map((r) => ({
      key: `x:${r.item.id}`,
      boardId: input.boardId,
      boardName: input.config.name,
      at: r.liveness.at,
      who: r.liveness.who,
      whoLabel: r.liveness.who === "prazo" ? "Prazo" : "Sistema",
      what: r.liveness.why,
      itemId: r.item.id,
      ...(r.item.cardId ? { cardId: r.item.cardId } : {}),
    }));
  return [...today, ...retired].sort((a, z) => z.at.localeCompare(a.at));
}

/**
 * As entradas de um board a partir do que o disco deu: os itens vivos assentados pelo contrato e, das decisões do
 * sistema na janela, só as que o dono combinou rever (com o «Desfazer» que funciona) — o resto mora no registro
 * (/board/<b>/acompanhar), e na página do item (`all`). Dobradas por causa. PURA — o coletor acima é a única IO.
 */
export function boardEntries(input: {
  boardId: string;
  config: BoardConfig;
  cards: readonly Card[];
  items: readonly CockpitItem[];
  decisions: readonly SystemDecision[];
  now: number;
  /** os fatos do board (contract.ts); ausentes ⇒ os itens decidem só pelo card. */
  facts?: InboxFacts;
}): { entries: InboxEntry[]; all: InboxEntry[]; retired: RetiredItem[] } {
  const { boardId, config, now } = input;
  const cardsById = input.facts?.cardsById ?? new Map(input.cards.map((c) => [c.id, c]));
  const { entries: live, retired } = settleItems(input.items, { boardId, boardName: config.name, config, cardsById, now, ...(input.facts ? { facts: input.facts } : {}) });
  const system = followUpInWindow(followUpItems(input.decisions, { board: boardId }), now).map((d) => {
    const card = d.cardId ? cardsById.get(d.cardId) : undefined;
    return { entry: systemDecisionEntry(d, { boardId, boardName: config.name, config, card }), review: isOwnerReview(d, { config, card }) };
  });
  const listed = [...live, ...system.filter((s) => s.review).map((s) => s.entry)];
  return { entries: foldByCause(listed), all: [...live, ...system.map((s) => s.entry)], retired };
}

// ── O Inbox de TODOS os boards (decisão 2 do dono) ─────────────────────────────────────────────────────

/** O que a tela precisa de cada board para desenhar o corpo de um item (a árvore da proposta lê os cards). */
export interface InboxBoardData {
  config: BoardConfig;
  /** só os cards que os itens do board citam — ou todos, quando há uma proposta pronta (ela ancora em qualquer card). */
  cards: Card[];
}

/** Um Inbox só, para todos os boards. */
export interface InboxSnapshot {
  /** cada board com as contagens dele — o filtro da tela e o seletor de boards leem daqui. */
  boards: Array<{ id: string; name: string; decidir: number; acompanhar: number; stalled: number }>;
  /** as entradas de todos os boards, dobradas por causa (cada board dobra as suas). */
  entries: InboxEntry[];
  contexts: Record<string, InboxBoardData>;
  /** «Resolvido hoje» de todos os boards, o mais novo primeiro. */
  resolved: ResolvedEntry[];
}

/** Os cards que a tela precisa de um board. PURA. */
export function cardsForScreen(entries: readonly InboxEntry[], cards: readonly Card[]): Card[] {
  if (entries.some((e) => e.kind === "proposal" && e.item?.kind === "proposal" && e.item.items.length > 0)) return [...cards];
  const cited = new Set(entries.flatMap((e) => [e.cardId, ...e.facets.map((f) => f.cardId ?? "")]).filter(Boolean));
  return cards.filter((c) => cited.has(c.id));
}

/** O Inbox de todos os boards. Um board ilegível não derruba os outros (fica de fora, com o erro no log). */
export async function collectInbox(now: number = Date.now()): Promise<InboxSnapshot> {
  const [list, receipts] = await Promise.all([listBoards(), readInboxReceipts().catch(() => [])]);
  const per = await Promise.all(
    list.map((b) =>
      collectBoardInbox(b.id, now, { receipts }).catch((err) => {
        console.warn(`[inbox] o board ${b.id} não pôde ser lido:`, err instanceof Error ? err.message : err);
        return null;
      }),
    ),
  );
  const snapshot: InboxSnapshot = { boards: [], entries: [], contexts: {}, resolved: [] };
  for (const inbox of per) {
    if (!inbox) continue;
    snapshot.boards.push({ id: inbox.boardId, name: inbox.boardName, ...inboxSummary(inbox.entries) });
    snapshot.entries.push(...inbox.entries);
    snapshot.contexts[inbox.boardId] = { config: inbox.config, cards: cardsForScreen(inbox.entries, inbox.cards) };
    snapshot.resolved.push(...inbox.resolved);
  }
  snapshot.resolved.sort((a, z) => z.at.localeCompare(a.at));
  return snapshot;
}
