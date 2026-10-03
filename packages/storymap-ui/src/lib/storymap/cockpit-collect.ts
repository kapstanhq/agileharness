import { getBoard, readBoardConfig } from "@/lib/storymap/repo";
import { conductedCardIds } from "@/lib/storymap/driver";
import { AUTONOMO_DOCTRINE_VERSION, copilotTier } from "@/lib/storymap/copilot/tier";
import {
  boardCockpitItems,
  compareCockpitItems,
  conflictItemsFromSnapshot,
  mergeFailedItemsFromSnapshot,
  dedupeCaptureLanes,
  designItemsFromWireframes,
  foldLastDeploy,
  foldRunDiagnostics,
  governanceItemsFromDrafts,
  isCopilotActionable,
  meterStallItem,
  proposalItemsFromContainers,
  stuckItemsFromFailures,
  type CockpitItem,
  type CockpitItemKind,
  type MeterStall,
} from "@/lib/storymap/demands";
import { isBusinessOnly } from "@/lib/storymap/decision-class";
import { governanceConflicts } from "@/lib/storymap/governance";
import { checkGovernanceApproval } from "@/lib/storymap/governance-check";
import { listGovernanceDrafts, readProposal, readWireframe } from "@/lib/storymap/sidecars";
import { listApprovalRequests, type ApprovalRequest } from "@/lib/storymap/approvals";
import { approvalRequesterText } from "@/lib/storymap/approval-requester";
import type { BoardConfig, Card, GovernanceDraft, WireframeDoc } from "@/lib/storymap/types";
import type { ProposalDoc } from "@/lib/storymap/smart-capture/types";
import { getTelemetryStore, type CardMetrics } from "@/lib/storymap/runner/telemetry";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { getProductDeploy } from "@/lib/storymap/runner/product-deploy";
import { readTransitions } from "@/lib/storymap/runner/transitions";
import { PER_ITEM_NOOP_MAX, readOrchestratorState, type NoopStreak } from "@/lib/storymap/runner/orchestrator-state";

// collectBoardCockpitItems — the SINGLE source of truth for "what needs you" on ONE board.
// Folds typed CockpitItems from five sources and re-sorts by lane urgency then age, EXACTLY as the
// /board/[boardId]/inbox page does. Both the Inbox page (the cockpit) AND the top-nav demand
// badge (getBoardDemandsAction) call this so they can NEVER diverge — the badge counts proposal/design
// just like the page shows them.
//
//  1. boardCockpitItems(cards, config)  — question/blocker/approval/review (live card fields)
//  2. stuckItemsFromFailures(telemetry) — stuck runs from the DURABLE telemetry ledger (survives
//     server restarts, unlike the registry's in-memory failures map). The most-recent failed record
//     per card (status error|exit|timeout|oom-killed|no-op) → one stuck item.
//  3. conflictItemsFromSnapshot(mergeQueue) — conflict/gate-failed entries from the in-memory
//     merge-queue snapshot (the only source; the registry is the single point of truth for the train).
//  4. proposalItemsFromContainers(sidecars) — capture containers in a non-terminal status (a captured
//     proposal awaiting accept/refine).
//  5. designItemsFromWireframes(sidecars) — cards at the "approve design" stop (gate hasWireframe).
//  6. governanceItemsFromDrafts(sidecars) — pending GovernanceDraft sidecars (owner:human board
//     fields proposed by agents; lane "aprovar", before/after visible in the Inbox cockpit).
//
// All projections are orphan-guarded (skip items whose card isn't in the board).

// 'cancelled' is DELIBERATELY excluded (story-ex0139) — a deliberate operator cancel (forceRelease /
// cancel_run) is NOT a failure, so a card whose latest telemetry run is 'cancelled' must NOT surface as
// a stuck cockpit item on Inbox. Only genuine failure outcomes belong here.
// "budget-cut" (the per-run $ breaker cut a run that did NOT advance its card) IS a failure: the card is
// parked with a finding asking to slice/re-plan it — a stuck item the operator (or copiloto) must act on.
const FAILED_STATUSES = new Set(["error", "exit", "timeout", "oom-killed", "no-op", "budget-cut"]);

// story-ex0105 — um card é TRAVADO pelo telemetry SÓ SE o run mais recente terminou num outcome de
// FALHA **E não avançou**. Um sucesso-com-aviso (`lastAdvanced:true` — saiu sujo mas o card avançou de
// coluna, entregando o trabalho) NÃO é travado: entra no lane errado (TRAVADO/vermelho) e gera ruído de
// investigação manual. Sem `lastAdvanced` (registros antigos) ⇒ tratado como não-avançado = travado
// (idêntico ao comportamento anterior, retrocompatível). Pura — testada em cockpit-collect.test.ts.
export function isStuckCardMetric(m: Pick<CardMetrics, "lastStatus" | "lastAdvanced">): boolean {
  return !!m.lastStatus && FAILED_STATUSES.has(m.lastStatus) && !m.lastAdvanced;
}

/**
 * Collect every CockpitItem for a board (the cockpit / Inbox screen). Returns [] when the board does
 * not exist (so the badge degrades to 0 instead of throwing). Performs IO (telemetry ledger + sidecar
 * reads) — server-only.
 */
export async function collectBoardCockpitItems(boardId: string): Promise<CockpitItem[]> {
  return (await collectBoardCockpit(boardId)).items;
}

/** What {@link collectBoardCockpit} read: the items, the board, and the approval/governance sidecars behind them (the
 *  Inbox's «Resolvido hoje» tells what a TIME LIMIT decided from the same read — inbox/receipts.ts expiredFacts). */
export interface BoardCockpit {
  items: CockpitItem[];
  cards: Card[];
  config: BoardConfig | null;
  approvals: ApprovalRequest[];
  governanceDrafts: GovernanceDraft[];
  /** WP3 — what the transitions ledger said (read once, here): the LAST status change of each card and when it entered
   *  its current status. The Inbox contract reads them as facts (inbox/contract.ts): a pending agent request whose card
   *  moved since is stale; a «Tentar de novo» counts only the retries of the current step. */
  lastTransitionAt: ReadonlyMap<string, string>;
  stepEnteredAt: ReadonlyMap<string, string>;
}

/** {@link collectBoardCockpitItems} + the board it read (config and cards) — for a caller that must judge items BY
 *  their card (the tick's conducted-card guard, the Inbox's decision per item) without a second board read that could
 *  disagree with the first. `config` is null when the board does not exist. */
export async function collectBoardCockpit(boardId: string): Promise<BoardCockpit> {
  const board = await getBoard(boardId);
  if (!board) return { items: [], cards: [], config: null, approvals: [], governanceDrafts: [], lastTransitionAt: new Map(), stepEnteredAt: new Map() };

  const { config, cards } = board;

  // cardsById: the orphan guard used by stuckItemsFromFailures + conflictItemsFromSnapshot
  const cardsById = new Map(cards.map((c) => [c.id, c]));

  // F9/B14 + B7 — o ledger de transições, lido UMA vez: quando cada card entrou no status atual (o `since` dos itens de
  // campo do card) e a última mudança de status (o travado cuja coluna o card deixou resolve).
  const ledger = await transitionFacts(boardId, cards);

  // (1) Card-level items (question/blocker/approval/review). B3 — o watchdog de publicação sem `held` recebe o
  //     estado do último deploy dos alvos do card (o registry do serviço): terminado ⇒ o Inbox oferece re-publicar.
  const productDeploy = getProductDeploy();
  const cardItems: CockpitItem[] = foldLastDeploy(
    boardCockpitItems(cards, config, boardId, { stepEnteredAt: ledger.stepEnteredAt }),
    cardsById,
    (target) => productDeploy.get(target),
  );

  // (2) Stuck items — from the DURABLE telemetry ledger (all runs, persisted across restarts).
  const telemetrySummary = await getTelemetryStore().boardSummary(boardId);
  const telemetryFailures = telemetrySummary.cards
    .filter((m) => isStuckCardMetric(m)) // story-ex0105: sucesso-com-aviso (lastAdvanced) sai do lane travado
    .map((m) => ({
      board: boardId,
      cardId: m.cardId,
      reason: (m.lastStatus ?? "exit") as "error" | "exit" | "timeout" | "oom-killed" | "no-op" | "budget-cut",
      detail: m.lastStatus ?? undefined,
      // B7 — o FIM do run (o `since` exato do item) e a etapa que rodou.
      at: m.lastEndedAt ?? m.lastRunAt ?? 0,
      ...(m.lastTrigger ? { trigger: m.lastTrigger } : {}),
    }));
  // B7 — a última transição de status de cada card: um card que mudou de coluna DEPOIS que o run morreu deixa o
  // travado para trás (o run era da coluna que ele deixou). Fail-open: sem ledger, a regra de sempre.
  const stuckItems: CockpitItem[] = stuckItemsFromFailures(telemetryFailures, cardsById, config, boardId, {
    lastTransitionAt: ledger.lastTransitionAt,
  });

  // (3) Conflict items — from the in-memory merge-queue snapshot (ephemeral but only source).
  const mergeQueueSnap = getRunnerRegistry().mergeQueueSnapshot();
  const conflictItems: CockpitItem[] = conflictItemsFromSnapshot(mergeQueueSnap, cardsById, config, boardId);
  // (3b) WS-5 — merge-failed items: the card's LATEST train entry ended `failed` (REUSES the snapshot read above).
  const mergeFailedItems: CockpitItem[] = mergeFailedItemsFromSnapshot(mergeQueueSnap, cardsById, config, boardId);

  // (4) Proposal items — capture containers (capture:true) in a non-terminal status; read each proposal
  //     sidecar so the renderer shows the proposed cards (or a "generating" state while `capturando`).
  const captureCards = cards.filter(
    (c) => c.capture && !config.statuses.find((s) => s.id === c.status)?.terminal,
  );
  const proposalsByCardId = new Map<string, ProposalDoc>();
  await Promise.all(
    captureCards.map(async (c) => {
      const doc = await readProposal(boardId, c.id);
      if (doc) proposalsByCardId.set(c.id, doc);
    }),
  );
  const proposalItemsRaw = proposalItemsFromContainers(cards, proposalsByCardId, config, boardId);
  // De-dupe the two capture lanes: a container whose run FAILED must not show BOTH a stuck item
  // (travado) and a "Gerando proposta…" placeholder (aprovar). The set of containers WITH a real
  // proposal sidecar decides who wins each lane (see dedupeCaptureLanes).
  const { stuck: stuckLive, proposal: proposalItems } = dedupeCaptureLanes(
    stuckItems,
    proposalItemsRaw,
    new Set(proposalsByCardId.keys()),
  );

  // (5) Design items — cards at the "approve design" stop (gate hasWireframe); read each wireframe sidecar.
  const designCards = cards.filter(
    (c) => config.statuses.find((s) => s.id === c.status)?.gate === "hasWireframe",
  );
  const wireframesByCardId = new Map<string, WireframeDoc>();
  await Promise.all(
    designCards.map(async (c) => {
      const doc = await readWireframe(boardId, c.id);
      if (doc) wireframesByCardId.set(c.id, doc);
    }),
  );
  const designItems: CockpitItem[] = designItemsFromWireframes(cards, wireframesByCardId, config, boardId);

  // (6) Governance items — pending governance drafts awaiting operator approval. B8: o conflito vem da MESMA
  //     checagem que a ação de aprovar faz (config E documento — governance-check.ts); antes só o de config, e
  //     um rascunho do PRD em conflito com o documento mostrava «Aprovar» habilitado e falhava depois do clique.
  const governanceDrafts = await listGovernanceDrafts(boardId);
  const conflictsByDraftId = new Map<string, string[]>();
  const refusalByDraftId = new Map<string, string>();
  for (const d of governanceDrafts) {
    if (d.status !== "pending") continue;
    const check = await checkGovernanceApproval(boardId, d, config).catch(() => null);
    conflictsByDraftId.set(d.id, check?.conflicts ?? governanceConflicts(d, config));
    if (check?.refusal) refusalByDraftId.set(d.id, check.refusal);
  }
  const governanceItems: CockpitItem[] = governanceItemsFromDrafts(governanceDrafts, conflictsByDraftId, boardId, Date.now(), refusalByDraftId);

  // (7) F5.4 — pending ApprovalRequests: the autonomous copiloto asked the human to OK an `ask`-disposition
  // action (e.g. move a card into a run column). Surfaces in the "aprovar" lane so it shows on Inbox AND
  // in the chat context. Encoded as kind "approval" with the request id in the item id (`apr:<id>`) so a
  // future approve/reject UI (5.8) can wire it; orphan-safe (cardId falls back to "" like governance).
  const cardTitleById = new Map(board.cards.map((c) => [c.id, c.title]));
  const approvals = await listApprovalRequests(boardId);
  const approvalItems: CockpitItem[] = approvals
    .filter((a) => a.status === "pending")
    .map((a) => ({
      id: `apr:${a.id}`,
      kind: "approval" as const,
      boardId,
      cardId: a.cardId ?? "",
      cardTitle: a.cardId ? cardTitleById.get(a.cardId) ?? a.cardId : "(board)",
      status: null,
      lane: "aprovar" as const,
      severity: a.riskClass === "deploy" || a.riskClass === "destructive" ? "high" : "medium",
      since: a.requestedAt,
      // B4 — quem pede DE VERDADE, em palavras (era «Jido pede» para qualquer agente).
      gateLabel: `${approvalRequesterText(a.requestedBy)} pede: ${a.tool}`,
      requestedBy: a.requestedBy,
      ...(a.reason ? { reason: a.reason } : {}),
      // WS-3 §3.5 (D12) — mirror the ApprovalRequest sidecar onto the item so the Inbox shows the
      // FULL canonical args (fim da aprovação às cegas), not just the derived gateLabel.
      tool: a.tool,
      args: a.args,
      riskClass: a.riskClass,
      requestedAt: a.requestedAt,
      expiresAt: a.expiresAt,
      ...(a.note ? { note: a.note } : {}),
    }));

  // (7b) v0.9 — o MEDIDOR de cota parado: um fato do HOST (o governador de capacidade retém TODA automação), o
  //      mesmo item em todo board enquanto durar. Leitura defensiva: o campo `meterStall` do snapshot é do
  //      governador (capacity-governor/-service), e qualquer falha de leitura só significa "sem item".
  const meterItems: CockpitItem[] = await readMeterStall()
    .then((stall) => {
      const item = meterStallItem(stall, boardId);
      return item ? [item] : [];
    })
    .catch(() => []);

  // (8) WS-12.2 (D16) — stamp the items the autonomous copiloto GAVE UP on (per-item anti-noop backoff), so the
  //     cockpit can show the chip that makes the hand-off explicit ("this one is yours now"). Read-only over the
  //     durable orchestrator state; fail-open (an unreadable state just means no chips).
  const backoff = await readOrchestratorState(boardId)
    .then((s) => s.noopByItem ?? {})
    .catch(() => ({} as Record<string, NoopStreak>));

  // Merge all items and re-sort: lane urgency (travado<pergunta<aprovar) then age (oldest-first).
  const items0 = [
    ...cardItems,
    ...stuckLive,
    ...conflictItems,
    ...mergeFailedItems,
    ...proposalItems,
    ...designItems,
    ...governanceItems,
    ...approvalItems,
    ...meterItems,
  ];
  // B6 — o aviso de sistema sobre a morte de um run vira EVIDÊNCIA do travado do mesmo card (um fato, um item).
  const folded = foldRunDiagnostics(items0, cardsById);
  // «Adiado — não agora» (deferral.ts): o que o dono guardou de propósito não vira item do Inbox nem decisão dele.
  const deferredIds = new Set(cards.filter((c) => c.deferred).map((c) => c.id));
  const items = folded
    .filter((item) => !item.cardId || !deferredIds.has(item.cardId))
    .map((item) => {
      // WS-4.5: the chip tells the truth — an item given up on under a REVOKED doctrine is not "yours now",
      // it is about to come back to the tick on its own (itemsInNoopBackoff filters by the live doctrine).
      // Showing the hand-off chip for it would invite the operator to do work the tick is already picking up.
      const entry = backoff[item.id];
      return entry && entry.streak >= PER_ITEM_NOOP_MAX && entry.doctrine === AUTONOMO_DOCTRINE_VERSION
        ? { ...item, copilotBackoff: { streak: entry.streak } }
        : item;
    })
    .sort(compareCockpitItems);
  return { items, cards, config, approvals, governanceDrafts, lastTransitionAt: ledger.lastTransitionAt, stepEnteredAt: ledger.stepEnteredAt };
}

/**
 * O que o ledger de transições diz de cada card do board: a ÚLTIMA transição (B7) e a última ENTRADA no status atual
 * (F9/B14). Fail-open: ledger ilegível ⇒ mapas vazios (os itens caem na criação do card; o travado, na regra de sempre).
 */
async function transitionFacts(
  boardId: string,
  cards: readonly Pick<Card, "id" | "status">[],
): Promise<{ lastTransitionAt: Map<string, string>; stepEnteredAt: Map<string, string> }> {
  const lastTransitionAt = new Map<string, string>();
  const stepEnteredAt = new Map<string, string>();
  const statusOf = new Map(cards.map((c) => [c.id, c.status]));
  for (const t of await readTransitions({ board: boardId }).catch(() => [])) {
    const cur = lastTransitionAt.get(t.cardId);
    if (!cur || t.at > cur) lastTransitionAt.set(t.cardId, t.at);
    if (t.to === statusOf.get(t.cardId)) {
      const entered = stepEnteredAt.get(t.cardId);
      if (!entered || t.at > entered) stepEnteredAt.set(t.cardId, t.at);
    }
  }
  return { lastTransitionAt, stepEnteredAt };
}

/**
 * O `meterStall` do snapshot do governador — ou null. Import dinâmico (o governador arrasta o laço de capacidade, e
 * este coletor roda em toda leitura do Inbox) e leitura ESTRUTURAL: o campo pertence ao governador, e um snapshot
 * sem ele (ou com outra forma) é simplesmente "medidor vivo".
 */
async function readMeterStall(): Promise<MeterStall | null> {
  const { getCapacityGovernor } = await import("@/lib/storymap/runner/capacity-service");
  const snap = getCapacityGovernor().snapshot() as unknown as { meterStall?: unknown };
  const s = snap.meterStall as Partial<MeterStall> | null | undefined;
  if (!s || typeof s.since !== "number" || !Number.isFinite(s.since)) return null;
  return {
    since: s.since,
    detectedAt: typeof s.detectedAt === "number" ? s.detectedAt : s.since,
    detail: typeof s.detail === "string" ? s.detail : "",
  };
}

/**
 * 6.4 — the ACTIONABLE-by-the-copiloto subset of a board's cockpit + a stable signature, for the disciplined
 * autonomous tick. Reuses collectBoardCockpitItems (so the tick sees EXACTLY what the cockpit shows), then keeps
 * only the kinds the copiloto can act on AT THIS BOARD'S TIER ({@link isCopilotActionable}) — a pending human
 * question no longer counts as "work", and an Autônomo board (which decides produto/UX e publica sozinho) wakes
 * for quase tudo que um humano pegaria no Inbox, enquanto o Copiloto mantém os 5 sinais da F8.
 *
 * O TIER é derivado AQUI, da MESMA policy que o guard por chamada lê (copilotTier ⇒ dispositionFor), em vez de
 * ser um parâmetro: um caller que passasse o tier errado criaria uma segunda verdade sobre "o que ele pode" —
 * exatamente o que a projeção do tier existe para impedir. Board sem policy/ilegível ⇒ `chat` ⇒ o conjunto
 * conservador (fail-safe: nunca alarga o acionável por erro de leitura).
 *
 * `sig` is the sorted actionable ids joined: stable across renders, changes iff the actionable
 * set changes, so the tick can back off when consecutive spawns leave it unchanged (no progress). WS-5.4 —
 * `ids` is the SORTED list of actionable item ids so the tick can keep a PER-ITEM anti-noop streak (noopByItem):
 * an item that got N spawns without ITS OWN progress leaves the actionable set even when the rest of the board
 * churns (which resets the global `sig`). WS-4.2 (parallel-work) — `itemCards` maps each actionable item id to
 * the CARD it belongs to, so the tick can skip items whose card another actor already holds (a claim): the item
 * id alone (`apr:<id>`, etc.) does not carry the card. Empty cardId (a board-level item like a governance draft)
 * is preserved as-is — it is claimable by nobody. Server-only.
 */
export async function collectActionableCockpit(
  boardId: string,
): Promise<{ count: number; sig: string; ids: string[]; itemCards: Array<{ id: string; cardId: string; kind: CockpitItemKind }>; businessOnly: boolean }> {
  const config = await readBoardConfig(boardId).catch(() => null);
  const tier = copilotTier(config?.orchestrator ?? null);
  // SÓ-NEGÓCIO (política só-negócio): num board em que o dono só decide negócio, o Jido acorda SÓ pela recuperação
  // técnica (demands.ts `isBusinessRecoveryItem`) — nunca pelo gate genérico, pela pergunta ou pela triagem.
  const businessOnly = isBusinessOnly(null, config);
  const { items: all, cards } = await collectBoardCockpit(boardId);
  // A card a CONDUCTOR drives (`routing.driver: conductor`) is not the tick's: its conductor session owns its work
  // AND its placement, and the operator owns it when that session dies (a copiloto answering its question,
  // re-driving it or pushing it through a gate would race the conductor — or overrule the operator). Filtered HERE,
  // at the one source of the tick's work set, so `hasWork`, the per-item noop attribution and the steward's item
  // map all agree that these items are not work. They stay on the Inbox for the human (collectBoardCockpitItems).
  const conducted = conductedCardIds(cards);
  const items = all.filter((i) => isCopilotActionable(i, tier, { businessOnly }) && !(i.cardId && conducted.has(i.cardId)));
  const ids = items.map((i) => i.id).sort();
  return { count: items.length, sig: ids.join("|"), ids, itemCards: items.map((i) => ({ id: i.id, cardId: i.cardId, kind: i.kind })), businessOnly };
}
