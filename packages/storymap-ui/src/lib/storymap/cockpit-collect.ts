import { getBoard, readBoardConfig } from "@/lib/storymap/repo";
import { AUTONOMO_DOCTRINE_VERSION, copilotTier } from "@/lib/storymap/copilot/tier";
import {
  boardCockpitItems,
  conflictItemsFromSnapshot,
  mergeFailedItemsFromSnapshot,
  dedupeCaptureLanes,
  designItemsFromWireframes,
  governanceItemsFromDrafts,
  isCopilotActionable,
  proposalItemsFromContainers,
  stuckItemsFromFailures,
  type CockpitItem,
} from "@/lib/storymap/demands";
import { governanceConflicts } from "@/lib/storymap/governance";
import {
  pruneSeen,
  readInboxSeen,
  sameSeenState,
  seenIdsAmong,
  writeInboxSeen,
} from "@/lib/storymap/inbox-seen";
import { listGovernanceDrafts, readProposal, readWireframe } from "@/lib/storymap/sidecars";
import { listApprovalRequests } from "@/lib/storymap/approvals";
import type { WireframeDoc } from "@/lib/storymap/types";
import type { ProposalDoc } from "@/lib/storymap/smart-capture/types";
import { getTelemetryStore, type CardMetrics } from "@/lib/storymap/runner/telemetry";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
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

const LANE_RANK: Record<string, number> = { travado: 0, pergunta: 1, aprovar: 2 };
// 'cancelled' is DELIBERATELY excluded (story-vbkazs) — a deliberate operator cancel (forceRelease /
// cancel_run) is NOT a failure, so a card whose latest telemetry run is 'cancelled' must NOT surface as
// a stuck cockpit item on Inbox. Only genuine failure outcomes belong here.
const FAILED_STATUSES = new Set(["error", "exit", "timeout", "oom-killed", "no-op"]);

// story-mzpzb0 — um card é TRAVADO pelo telemetry SÓ SE o run mais recente terminou num outcome de
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
  const board = await getBoard(boardId);
  if (!board) return [];

  const { config, cards } = board;

  // cardsById: the orphan guard used by stuckItemsFromFailures + conflictItemsFromSnapshot
  const cardsById = new Map(cards.map((c) => [c.id, c]));

  // (1) Card-level items (question/blocker/approval/review)
  const cardItems: CockpitItem[] = boardCockpitItems(cards, config, boardId);

  // (2) Stuck items — from the DURABLE telemetry ledger (all runs, persisted across restarts).
  const telemetrySummary = await getTelemetryStore().boardSummary(boardId);
  const telemetryFailures = telemetrySummary.cards
    .filter((m) => isStuckCardMetric(m)) // story-mzpzb0: sucesso-com-aviso (lastAdvanced) sai do lane travado
    .map((m) => ({
      board: boardId,
      cardId: m.cardId,
      reason: (m.lastStatus ?? "exit") as "error" | "exit" | "timeout" | "oom-killed" | "no-op",
      detail: m.lastStatus ?? undefined,
      at: m.lastRunAt ?? 0,
      // trigger not available from the summary aggregate; omit (optional field)
    }));
  const stuckItems: CockpitItem[] = stuckItemsFromFailures(telemetryFailures, cardsById, config, boardId);

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

  // (6) Governance items — pending governance drafts awaiting operator approval.
  const governanceDrafts = await listGovernanceDrafts(boardId);
  const conflictsByDraftId = new Map<string, string[]>(
    governanceDrafts.map((d) => [d.id, governanceConflicts(d, config)]),
  );
  const governanceItems: CockpitItem[] = governanceItemsFromDrafts(governanceDrafts, conflictsByDraftId, boardId);

  // (7) F5.4 — pending ApprovalRequests: the autonomous copiloto asked the human to OK an `ask`-disposition
  // action (e.g. move a card into a run column). Surfaces in the "aprovar" lane so it shows on Inbox AND
  // in the chat context. Encoded as kind "approval" with the request id in the item id (`apr:<id>`) so a
  // future approve/reject UI (5.8) can wire it; orphan-safe (cardId falls back to "" like governance).
  const cardTitleById = new Map(board.cards.map((c) => [c.id, c.title]));
  const approvalItems: CockpitItem[] = (await listApprovalRequests(boardId))
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
      gateLabel: `Jido pede: ${a.tool} (${a.riskClass})`,
      // WS-3 §3.5 (D12) — mirror the ApprovalRequest sidecar onto the item so the Inbox shows the
      // FULL canonical args (fim da aprovação às cegas), not just the derived gateLabel.
      tool: a.tool,
      args: a.args,
      riskClass: a.riskClass,
      requestedAt: a.requestedAt,
      expiresAt: a.expiresAt,
      ...(a.note ? { note: a.note } : {}),
    }));

  // (8) WS-12.2 (D16) — stamp the items the autonomous copiloto GAVE UP on (per-item anti-noop backoff), so the
  //     cockpit can show the chip that makes the hand-off explicit ("this one is yours now"). Read-only over the
  //     durable orchestrator state; fail-open (an unreadable state just means no chips).
  const backoff = await readOrchestratorState(boardId)
    .then((s) => s.noopByItem ?? {})
    .catch(() => ({} as Record<string, NoopStreak>));

  // Merge all items and re-sort: lane urgency (travado<pergunta<aprovar) then age (oldest-first).
  return [
    ...cardItems,
    ...stuckLive,
    ...conflictItems,
    ...mergeFailedItems,
    ...proposalItems,
    ...designItems,
    ...governanceItems,
    ...approvalItems,
  ]
    .map((item) => {
      // WS-4.5: the chip tells the truth — an item given up on under a REVOKED doctrine is not "yours now",
      // it is about to come back to the tick on its own (itemsInNoopBackoff filters by the live doctrine).
      // Showing the hand-off chip for it would invite the operator to do work the tick is already picking up.
      const entry = backoff[item.id];
      return entry && entry.streak >= PER_ITEM_NOOP_MAX && entry.doctrine === AUTONOMO_DOCTRINE_VERSION
        ? { ...item, copilotBackoff: { streak: entry.streak } }
        : item;
    })
    .sort(
      (a, z) =>
        (LANE_RANK[a.lane] ?? 9) - (LANE_RANK[z.lane] ?? 9) ||
        (a.since || "9999").localeCompare(z.since || "9999"),
    );
}

/**
 * Os itens do board + quais deles o operador JÁ VIU (inbox-seen.ts).
 *
 * `items` é a lista INTEIRA — nada é filtrado, aqui nem em lugar nenhum. A marca de visto é um
 * carimbo de navegação do carrossel da home (o "Pular"), não um filtro: esconder trabalho por um
 * gesto de folhear seria transformar "vou ver o resto" em "some da minha frente". Quem consome esta
 * projeção é só a HOME, que usa `seenIds` para o chip; a tela do Inbox chama o coletor cru.
 *
 * Aproveita a passada para o GC do arquivo (marca de item resolvido/mudado cai fora) — só reescreve
 * quando algo de fato mudou. Server-only.
 */
export async function collectCockpitWithSeen(
  boardId: string,
): Promise<{ items: CockpitItem[]; seenIds: string[] }> {
  const items = await collectBoardCockpitItems(boardId);
  const stored = await readInboxSeen(boardId);
  const pruned = pruneSeen(stored, items);
  if (!sameSeenState(stored, pruned)) await writeInboxSeen(boardId, pruned);
  return { items, seenIds: seenIdsAmong(items, pruned) };
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
): Promise<{ count: number; sig: string; ids: string[]; itemCards: Array<{ id: string; cardId: string }> }> {
  const tier = copilotTier(await readBoardConfig(boardId).then((c) => c.orchestrator).catch(() => null));
  const items = (await collectBoardCockpitItems(boardId)).filter((i) => isCopilotActionable(i, tier));
  const ids = items.map((i) => i.id).sort();
  return { count: items.length, sig: ids.join("|"), ids, itemCards: items.map((i) => ({ id: i.id, cardId: i.cardId })) };
}
