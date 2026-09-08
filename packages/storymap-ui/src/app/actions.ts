"use server";

// story-rwlu34 — TODA action deste arquivo começa por `await requireSession(<nome>)`. O que isso
// IMPEDE: que um chamador anônimo que alcance o boundary (matcher do middleware alterado, rota nova
// entrando em PUBLIC_ROUTES por descuido) execute um mutador — apagar card, spawnar agente, publicar.
// É redundante com `src/middleware.ts` POR DESENHO. O porquê inteiro, e os três chamadores legítimos
// (operador com cookie · agente MCP com token · o próprio serviço fora de request), estão em
// `lib/auth/action-guard.ts`; a exaustividade é congelada por `action-guard-exhaustiveness.test.ts`.
import { requireSession } from "@/lib/auth/action-guard";
import { revalidatePath } from "next/cache";
import { listBoards, readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
import { applyReopen, isReopenDestination, REOPEN_KINDS, type ReopenDestination } from "@/lib/storymap/reopen";
import { appendTransition, readTransitions, type Transition } from "@/lib/storymap/runner/transitions";
import { isScopedActor, transitionActorLabel } from "@/lib/storymap/mcp/actor";
import { moveRiskClass } from "@/lib/storymap/entry-effect";
import { dispositionFor } from "@/lib/storymap/runner/orchestrator-policy";
import { consumeGrant, createApprovalRequest, decideApprovalRequest, findMatchingGrant } from "@/lib/storymap/approvals";
import { appendAgentAction } from "@/lib/storymap/runner/agent-actions";
// WS-6.4 — a frota: reciclar um agente e liberar o claim dele a partir de /processes.
import { getCardClaims, sessionClaimActor } from "@/lib/storymap/runner/claims";
import { recycleSession } from "@/lib/storymap/runner/session-spawn";
import { discardSessionWorktree } from "@/lib/storymap/runner/session-worktree";
import { supersedeStaleTerminalBlockers } from "@/lib/storymap/runner/findings";
import { sessionSpawnDeps } from "@/lib/storymap/mcp/dev-tools";
import { logHumanActionAction } from "./audit-actions";
import { resolveRouteProfile, routeSkipsValidationError, triggerForCard } from "@/lib/storymap/skip-routing";
import { addQuestions, answerQuestion, openQuestions, resolveStaleQuestions } from "@/lib/storymap/questions";
import { boardCardDemands, SEVERITY_RANK, DEPLOY_FAILURE_FINDING_ID, supersedeDeliveryFindingsOnReentry, type Demand, type CockpitItem } from "@/lib/storymap/demands";
import { collectBoardCockpitItems } from "@/lib/storymap/cockpit-collect";
import {
  defaultPreservedBranchesDeps,
  listPreservedRunBranches,
  type PreservedBranch,
} from "@/lib/storymap/runner/preserved-branches";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ENTRY_EFFECTS } from "@/lib/storymap/runner/entry-effects";
import { entryEffect } from "@/lib/storymap/entry-effect";
import { defaultExec } from "@/lib/storymap/runner/worktree";
import {
  cardCumulativeDiff,
  commitRangeDiff,
  grepCardCommitRangeDiff,
  parseDiffStat,
  parseShortstat,
  runBranchName,
  snapshotRangeDiff,
  type CumulativeDiffPart,
  type GitRunner,
} from "@/lib/storymap/runner/diff";
import {
  restoreCardFile,
  trashCardFile,
  updateBoardConfigOnDisk,
  updateCardOnDisk,
  withCreateLock,
  writeBoardConfig,
  writeCard,
} from "@/lib/storymap/write";
import { listTrashManifests, readTrashManifest, removeTrashEntry, writeTrashManifest } from "@/lib/storymap/trash";
import { ADDRESSES_REL, ideaFingerprint } from "@/lib/storymap/idea";
import { makeCtx, validateLink } from "@/lib/storymap/link-graph";
import { loadRunnerConfig, writeRunnerSettings } from "@/lib/storymap/runner/config";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { buildRequeueEntry, isRequeueableStatus, requeueCandidates } from "@/lib/storymap/runner/requeue";
import { getRunnerEngine } from "@/lib/storymap/runner/engine";
import { resolveHeadroomUrl } from "@/lib/storymap/runner/headroom";
import { evaluateAutorunOnEntry } from "@/lib/notifications/server/channels/autorun-eval";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { getRunnerJournal } from "@/lib/storymap/runner/journal";
import { getTelemetryStore } from "@/lib/storymap/runner/telemetry";
import type { BoardMetricsSummary, TelemetryRecord } from "@/lib/storymap/runner/telemetry";
import { SYNC_STATUS_DEF, SYNC_TRIGGER } from "@/lib/storymap/runner/sync";
import { ensureDetachedSession, isSafeSessionName, killSession, listClaudeProcesses } from "@/lib/vps/tmux";
import { assessKillLive } from "@/lib/vps/kill-guard";
import { cardSessionName } from "@/lib/vps/processes";
import {
  deleteProposal,
  readGovernanceDraft,
  readPlan,
  readProposal,
  readRetirePlan,
  readWireframe,
  writeBugScreenshot,
  writeBugScreenshots,
  writeGovernanceDraft,
  writeProposal,
  writeRefineScreenshot,
  writeRetireScreenshot,
  writeWireframe,
} from "@/lib/storymap/sidecars";
import { isNonConfigArtifact, applyGovernanceChange, governanceConflicts } from "@/lib/storymap/governance";
import { designReturnTarget, unresolvedChanges } from "@/lib/storymap/design-canvas";
import { withKeyedLock } from "@/lib/storymap/serialize";
import type { DesignFeedbackEntry } from "@/lib/storymap/types";
import { makeId, randomCardId } from "@/lib/storymap/id";
import { mergeCardOnSave } from "@/lib/storymap/card-merge";
import { isBugSeverity, isDisposition, isImprovementKind, isRemovalLevel, isRemovalScope } from "@/lib/storymap/frameworks";
import type { BugSeverity, Disposition, ImprovementKind, RemovalLevel, RemovalScope, StoryType } from "@/lib/storymap/frameworks";
import type { CardType } from "@/lib/storymap/types";
import { checkGate } from "@/lib/storymap/gates";
import { decideAdvance } from "@/lib/storymap/advance";
import { entryStatusId } from "@/lib/storymap/views";
import { validateBatchAnchoring, validateExtendTargets } from "@/lib/storymap/smart-capture/anchoring";
import { normalizeTaskTitle, type ExtendedCardOutcome } from "@/lib/storymap/smart-capture/types";
import { emptyCardFields, makeDraftCard, nextOrder } from "@/lib/storymap/draft";
import { servesIsPlacement } from "@/lib/storymap/unplaced";
import { buildIdeaTasksPrompt, buildProposalPrompt, buildRecastPrompt } from "@/lib/storymap/smart-capture/prompt";
import { boardStrategy } from "@/lib/storymap/board-strategy";
import { applyGovernedChange, docIsCanonical, readGovernedValue } from "@/lib/storymap/doc/doc-governance";
import { parseProposal } from "@/lib/storymap/smart-capture/parse";
import { guardCaptureIdeas } from "@/lib/storymap/smart-capture/commit";
import { runClaudeJson } from "@/lib/storymap/smart-capture/claude";
import type { CaptureImageInput, CaptureTurn, Proposal, ProposedItem } from "@/lib/storymap/smart-capture/types";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildTriagePrompt } from "@/lib/storymap/triage/prompt";
import { resolvedClaudeBin } from "@/lib/storymap/runner/claude-bin";
import {
  acceptRoute,
  buildTriageBugReport,
  buildTriageRefinement,
  decideTriage,
  parseTriage,
  sanitizeIntakeText,
} from "@/lib/storymap/triage/parse";
import type { TriageOutcome, TriageReport } from "@/lib/storymap/triage/types";
import type {
  BoardConfig,
  BugReport,
  Card,
  CardCommitWarning,
  CardLink,
  CardMode,
  CardProvenance,
  CardRouting,
  EffortLevel,
  EntryEffect,
  ModelTier,
  FindingStatus,
  GovernanceChange,
  GovernanceDraft,
  OrchestratorMode,
  Persona,
  RiskClass,
  RiskDisposition,
  RunnerSettings,
  SystemDef,
  TrashManifest,
  WireframeDoc,
} from "@/lib/storymap/types";
import { autonomousModeSafe, lintRiskMatrix } from "@/lib/storymap/runner/orchestrator-policy";

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function revalidateBoard(boardId: string) {
  revalidatePath(`/board/${boardId}`);
}

function fail<T = unknown>(e: unknown): Result<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/**
 * storymap-critical-audit #3 — a write that SETS a status must target a step that exists in the
 * board config. `checkGate` is a no-op for an unknown status (no gate declared → returns null) and
 * `coerceCard` coerces any string through, so without this an MCP `move_card` / `update_card` with a
 * typo'd or renamed-column id (a free `z.string()`) — or a hardcoded route — silently strands the
 * card in a phantom status OUTSIDE the pipeline (cascade goes inert, the card drops into the
 * NO_STATUS lane). The membership check at the server write layer is authoritative regardless of any
 * MCP schema. Returns an error string (like `checkGate`) or null. Lives beside every checkGate site.
 */
function unknownStatusError(statusId: string, config: BoardConfig): string | null {
  return config.statuses.some((s) => s.id === statusId)
    ? null
    : `status inexistente no board: "${statusId}" (use list_statuses para os ids válidos)`;
}

/** Today as YYYY-MM-DD (the card's date granularity). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Answer ONE HITL question on a card (open → answered, stamping the answer + today). The /perguntas
 * queue and the Inbox cockpit call this; the answer rides in the card spec and the next skill
 * (harness-enrich) reads it. Accepts optional `selectedOptionIds` (structured option picks) alongside the
 * free-text answer — either alone is sufficient; both empty is rejected. Locked read-modify-write.
 */
export async function answerQuestionAction(input: {
  boardId: string;
  cardId: string;
  questionId: string;
  answer: string;
  selectedOptionIds?: string[];
  /** F6.3 — quem respondeu: "human" (default, omitido no card) ou "copilot" (o agente apurou o fato via
   *  answer_question). O human responde pela UI /perguntas (sem este campo); o Jido pelo MCP. */
  answeredBy?: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("answerQuestionAction");
  const hasText = input.answer.trim().length > 0;
  const hasOptions = (input.selectedOptionIds?.length ?? 0) > 0;
  if (!hasText && !hasOptions) return { ok: false, error: "Resposta ou opção obrigatória." };
  try {
    const card = await updateCardOnDisk(input.boardId, input.cardId, (prev) => ({
      ...prev,
      questions: answerQuestion(
        prev.questions ?? [],
        input.questionId,
        input.answer,
        today(),
        input.selectedOptionIds,
        input.answeredBy,
      ),
    }));
    if (!card) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);

    // HITL auto-advance (story-rl5v03): the `grill`/Dúvidas step is a human-in-the-loop PAUSE —
    // harness-grill raises the questions and intentionally does NOT advance the card. Once the human
    // answers the LAST open question the pause is satisfied, so resume the cascade automatically
    // (board- + storyType-aware via decideAdvance) instead of stranding the card in Dúvidas waiting
    // for a manual drag — the /perguntas empty state already PROMISES "os agentes seguem assim que
    // você responde". Scoped to the grill step (trigger harness-grill) so operator follow-up questions
    // raised on OTHER steps never silently advance a card past a real human gate. decideAdvance
    // returns `blocked` when the next step's entry gate is unmet → we leave the card where it is.
    const config = await readBoardConfig(input.boardId);
    const inGrill = config.statuses.find((s) => s.id === card.status)?.trigger === "harness-grill";
    if (inGrill && openQuestions(card).length === 0) {
      const decision = decideAdvance(card, config);
      if (decision.action === "advance") {
        const moved = await moveCardAction({ boardId: input.boardId, cardId: input.cardId, status: decision.to });
        if (moved.ok) {
          const fresh = await readCard(input.boardId, input.cardId);
          return { ok: true, data: { card: fresh ?? card } };
        }
      }
    }
    // NÃO re-pumpar a cascata aqui (tentado e revertido — answer-autoadvance.test.ts pega): responder
    // uma pergunta NÃO é destravar um gate. `evaluateAutorunOnEntry` re-DISPARARIA a skill da coluna,
    // e isso quebra duas garantias deliberadas: (1) enquanto AINDA há perguntas abertas o grill seria
    // re-rodado por cima do humano; (2) uma pergunta de follow-up do operador num step qualquer
    // geraria run espúrio nesse step. O único auto-advance legítimo é o do grill, logo acima, que é
    // condicionado a "última pergunta respondida" e usa decideAdvance (respeita o gate do próximo step).
    return { ok: true, data: { card } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Ask one or more HITL questions on a card (appends OPEN questions, dedup-guarded by text). The
 * operator uses it to push a follow-up/directive back to the agent loop; the surface a future MCP
 * ask_question reuses. Locked read-modify-write.
 */
export async function askQuestionsAction(input: {
  boardId: string;
  cardId: string;
  texts: string[];
  askedBy?: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("askQuestionsAction");
  try {
    const card = await updateCardOnDisk(input.boardId, input.cardId, (prev) => ({
      ...prev,
      questions: addQuestions(prev.questions ?? [], input.texts, input.askedBy || "operator", today()),
    }));
    if (!card) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    return { ok: true, data: { card } };
  } catch (e) {
    return fail(e);
  }
}

// APOSENTADO — `ackUnplacedAction` ("Aceitar sem lugar", Fase 4.3). Carimbava `unplacedAck` para um
// card sem pai passar o gate e entrar em construção. Era a válvula que permitia card fora da
// hierarquia: 83 dos 304 cards do repo saíram por ela. A invariante agora é imposta na ESCRITA
// (write.ts → placementViolation), então não há o que "aceitar" — ou o card tem âncora, ou está na
// quarentena da Triagem. `unplacedAck` permanece no schema como marca HISTÓRICA dos cards antigos
// (leitura), sem nenhum escritor. NÃO reintroduzir.

/**
 * HITL count for the top-nav badge (#23): how many OPEN agent questions await the human across a
 * board's NON-terminal cards (terminal cards' questions are auto-resolved as stale, so they never
 * count). Cheap read-only aggregation; the QuestionsChip polls it so "precisa de você" is visible
 * from any view — the operator no longer has to open /perguntas to know a card needs them.
 */
export async function getOpenQuestionsCountAction(input: {
  boardId: string;
}): Promise<Result<{ count: number; cards: number }>> {
  await requireSession("getOpenQuestionsCountAction");
  try {
    const [config, cs] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);
    const terminal = new Set(config.statuses.filter((s) => s.terminal).map((s) => s.id));
    let count = 0;
    let cards = 0;
    for (const card of cs) {
      if (card.status && terminal.has(card.status)) continue;
      const open = openQuestions(card).length;
      if (open > 0) {
        count += open;
        cards += 1;
      }
    }
    return { ok: true, data: { count, cards } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * GLOBAL HITL demand aggregation (cross-board) — the data source for the top-nav demand badge/center
 * AND the unified "Central de Ações" queue. Generalizes getOpenQuestionsCountAction from "open
 * questions on ONE board" to EVERY pending human demand (question, blocker, review, gate) across ALL
 * boards, derived from the single source of truth `cardDemands` (demands.ts) so the badge, the queue
 * and the (future) web-push read the same state. Read-only; sorted severity-then-age.
 */
export async function getPendingDemandsAction(): Promise<
  Result<{ total: number; cards: number; byType: Record<string, number>; demands: Demand[] }>
> {
  await requireSession("getPendingDemandsAction");
  try {
    const boards = await listBoards();
    const all: Demand[] = [];
    for (const b of boards) {
      const [config, cs] = await Promise.all([readBoardConfig(b.id), readCards(b.id)]);
      all.push(...boardCardDemands(cs, config, b.id));
    }
    all.sort(
      (a, z) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[z.severity] ||
        (a.since || "9999").localeCompare(z.since || "9999"),
    );
    const byType: Record<string, number> = {};
    for (const d of all) byType[d.type] = (byType[d.type] ?? 0) + 1;
    const cards = new Set(all.map((d) => `${d.boardId}/${d.cardId}`)).size;
    return { ok: true, data: { total: all.length, cards, byType, demands: all } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Per-board HITL demand aggregation — the data source for the BoardHeader ActionsChip (badge). It
 * counts via the SAME `collectBoardCockpitItems` folding the /board/[boardId]/inbox cockpit
 * renders, so the badge can NEVER diverge from the page: it folds in ALL five sources (card items +
 * stuck telemetry + merge conflicts + capture proposals + design approvals), not just the legacy
 * card-level `Demand` model. `total` therefore includes proposal/design (when the user captures, the
 * badge increments). `items` is the full inbox; the ActionsChip only reads `.total`.
 */
export async function getBoardDemandsAction(input: {
  boardId: string;
}): Promise<Result<{ total: number; items: CockpitItem[] }>> {
  await requireSession("getBoardDemandsAction");
  try {
    // O contador conta TUDO — nada é escondido por marca de visto (o "Pular" da home é navegação).
    const items = await collectBoardCockpitItems(input.boardId);
    return { ok: true, data: { total: items.length, items } };
  } catch (e) {
    return fail(e);
  }
}

/** One row in the board-header trash drawer (a story sitting in a `system` archive column). */
export type ArchivedCardRow = {
  id: string;
  title: string;
  status: string;
  statusName: string;
  updatedMs: number;
  /** duplicado: the card this one was merged into (for the "→ story-x" hint). */
  duplicateOf: string | null;
};

/**
 * The board's ARCHIVED stories — the tombstones living in a `system` column (arquivados/
 * duplicado/cancelado/capturado). Replaces the old "Arquivo" kanban column: the header trash
 * chip fetches this and renders the drawer (revive via reviveCardAction). Read-only.
 */
export async function getArchivedCardsAction(input: {
  boardId: string;
}): Promise<Result<{ items: ArchivedCardRow[] }>> {
  await requireSession("getArchivedCardsAction");
  try {
    const [config, cards] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);
    const sysCols = new Set((config.columns ?? []).filter((c) => c.system).map((c) => c.id));
    const byId = new Map(config.statuses.map((s) => [s.id, s]));
    const archived = cards.filter((c) => {
      if (c.type !== "story" || !c.status) return false;
      const col = byId.get(c.status)?.column;
      return !!col && sysCols.has(col);
    });
    const items: ArchivedCardRow[] = archived
      .map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status!,
        statusName: byId.get(c.status!)?.name ?? c.status!,
        updatedMs: c.updatedMs ?? 0,
        duplicateOf: c.duplicateOf ?? null,
      }))
      .sort((a, b) => b.updatedMs - a.updatedMs);
    return { ok: true, data: { items } };
  } catch (e) {
    return fail(e);
  }
}

/** List preserved/orphan run branches (the safe-remove guard's failed/* + detached settle-gap orphans)
 * with card context + a safe-to-discard verdict, for the /processes ops panel. Read-only. */
export async function listPreservedBranchesAction(): Promise<Result<{ branches: PreservedBranch[] }>> {
  await requireSession("listPreservedBranchesAction");
  try {
    return { ok: true, data: { branches: await listPreservedRunBranches(defaultPreservedBranchesDeps()) } };
  } catch (e) {
    return fail(e);
  }
}

/** Discard ONE preserved/orphan run branch (`git branch -D`). GUARDED: only a `failed/run/*` or `run/*`
 * id, and a bare `run/*` must NOT still be on the merge train. Irreversible — the UI confirms first. */
export async function discardPreservedBranchAction(input: { branch: string }): Promise<Result> {
  await requireSession("discardPreservedBranchAction");
  try {
    const branch = input.branch.trim();
    if (!/^(failed\/)?run\/[A-Za-z0-9-]+$/.test(branch)) return { ok: false, error: `branch inválida: ${branch}` };
    if (!branch.startsWith("failed/")) {
      const live = new Set(await defaultPreservedBranchesDeps().liveRunIds().catch(() => []));
      if (live.has(branch.replace(/^run\//, ""))) {
        return { ok: false, error: "essa run ainda está na fila de merge — não pode descartar" };
      }
    }
    await defaultExec(`git branch -D ${JSON.stringify(branch)}`, { cwd: findRepoRoot(), timeout: 15_000 });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Persist a fully-formed draft card — the "Salvar" of a NEW card. The draft is built
 * in memory client-side (lib/storymap/draft.ts) and never touched disk until here,
 * so cancelling the editor leaves nothing behind.
 */
export async function createCardAction(input: {
  boardId: string;
  card: Card;
  /** WS6 (F5): creation provenance for this direct-write path (UI "+ Novo item", triage accept, …).
   *  Defaults to "ui"; a card that already carries `via` keeps it. */
  via?: CardProvenance;
}): Promise<Result<{ card: Card }>> {
  await requireSession("createCardAction");
  try {
    // createcard-toctou: serialize read-ids → mint → write per board so two concurrent creates of the
    // same deterministic slug id (e.g. a UI "+ Novo item" racing an MCP create_card of an identically-
    // titled backbone) can't both mint it and have the second writeCard overwrite the first.
    return await withCreateLock(input.boardId, async () => {
    const cards = await readCards(input.boardId);
    const existing = new Set(cards.map((c) => c.id));
    // WS6 (F5): stamp provenance (dedicated field) — the card's own `via` wins, else the caller's, else "ui".
    let card: Card = { ...input.card, via: input.card.via ?? input.via ?? "ui" };
    // The client id is collision-free against the snapshot it held, but re-check
    // against fresh disk state (a concurrent create/agent run may have taken it).
    if (existing.has(card.id)) {
      const id =
        card.type === "story"
          ? randomCardId(card.type, existing)
          : makeId(card.type, card.title || "Sem título", existing);
      card = { ...card, id };
    }
    // NÃO existe mais o desvio "sem pai → vai para o backlog não-mapeado" (unplaced:true). Um card
    // fora da hierarquia deixou de ser representável: quem tentar criá-lo sem âncora é recusado pelo
    // chokepoint de escrita (write.ts → placementViolation), com a mensagem dizendo o que falta. A
    // única exceção é a QUARENTENA (status `staging`, a Triagem), onde o card ainda não sabe onde
    // encaixa — e é o aceite da triagem que cobra a decisão.
    // Gate: a new card entering a gated status must already satisfy it (entry
    // statuses like Rascunho have no gate, so a normal draft passes through).
    if (card.status) {
      const config = await readBoardConfig(input.boardId);
      const statusError = unknownStatusError(card.status, config);
      if (statusError) return { ok: false, error: statusError };
      const gateError = checkGate(card, card.status, config);
      if (gateError) return { ok: false, error: gateError };
    }
    await writeCard(input.boardId, card);
    revalidateBoard(input.boardId);
    return { ok: true, data: { card } };
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Smart capture, step 1: ask the LLM to turn free text into a card PROPOSAL. Reads
 * the board for context, runs Claude headless, returns the parsed/sanitized plan.
 * `history` carries prior turns so the user can refine in free text. Writes nothing.
 */
/**
 * Decode the attached context images to a throwaway temp dir and return their absolute paths plus a
 * cleanup. The agent reads them visually with the Read tool (so the spawn must skip permissions). We
 * cap count/size defensively — the modal already downscales, this is the server-side backstop.
 */
const MAX_CAPTURE_IMAGES = 4;
const MAX_CAPTURE_IMAGE_BYTES = 6 * 1024 * 1024; // ~6MB per image after client downscale
const CAPTURE_IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

async function writeCaptureImages(
  images: CaptureImageInput[] | undefined,
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const list = (images ?? []).slice(0, MAX_CAPTURE_IMAGES);
  if (!list.length) return { paths: [], cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "storymap-capture-"));
  const cleanup = async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best effort — a leaked temp image in the OS tmp dir is harmless.
    }
  };
  try {
    const decoded: { path: string; buf: Buffer }[] = [];
    list.forEach((img, i) => {
      const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(img.dataUrl ?? "");
      if (!m) return;
      const ext = CAPTURE_IMAGE_EXT[m[1].toLowerCase()] ?? "png";
      const buf = Buffer.from(m[2], "base64");
      if (buf.byteLength > MAX_CAPTURE_IMAGE_BYTES) return; // skip oversized — don't blow the prompt
      decoded.push({ path: join(dir, `ctx-${i + 1}.${ext}`), buf });
    });
    await Promise.all(decoded.map(({ path, buf }) => writeFile(path, buf)));
    const paths = decoded.map((d) => d.path);
    return { paths, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

export async function proposeCardsAction(input: {
  boardId: string;
  text: string;
  history?: CaptureTurn[];
  /** context images the user attached (data URLs) — read visually by the agent. */
  images?: CaptureImageInput[];
  /** ① dica de intenção do humano (chips) — prior forte na classificação do PASSO 1. WS-9: "idea" foi
   *  removido (a captura estruturada não cunha ◆ — dor crua vai para a bancada). */
  intentHint?: "story" | "bug" | null;
}): Promise<Result<{ proposal: Proposal }>> {
  await requireSession("proposeCardsAction");
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const text = input.text?.trim();
    const hasImages = (input.images?.length ?? 0) > 0;
    // images alone (e.g. a print) are a valid capture; require text only when there's no image.
    if (!text && !hasImages) return { ok: false, error: "Escreva o que você quer capturar (ou anexe uma imagem)." };
    const [config, cards, imgs] = await Promise.all([
      readBoardConfig(input.boardId),
      readCards(input.boardId),
      writeCaptureImages(input.images),
    ]);
    cleanup = imgs.cleanup;
    const prompt = buildProposalPrompt({
      config,
      cards,
      strategy: await boardStrategy(input.boardId, config),
      text: text || "(sem texto — interprete a partir das imagens de contexto anexadas)",
      history: input.history,
      imagePaths: imgs.paths,
      intentHint: input.intentHint,
    });
    const raw = await runClaudeJson(prompt, {
      context: { label: "Captura inteligente", view: "captura", board: input.boardId },
      // reading the attached images needs the Read tool → bypass the headless permission prompt.
      dangerouslySkipPermissions: imgs.paths.length > 0,
    });
    const proposal = parseProposal(raw, config, cards);
    if (!proposal.items.length) {
      return { ok: false, error: "O agente não propôs nenhum item. Tente reescrever o pedido." };
    }
    return { ok: true, data: { proposal } };
  } catch (e) {
    return fail(e);
  } finally {
    if (cleanup) await cleanup();
  }
}

/**
 * SYNCHRONOUS twin of generateTasksForIdeaAction: propose (without writing) the delivery
 * stories that resolve an existing idea, so the capture modal can show them inline in the same
 * <ProposalTree> right after the pain is created. Uses the WORK-path prompt (no dual-track reclassify).
 * Returns the proposal + the idea identity (so the caller commits with addressesIdeaId).
 */
export async function proposeTasksForIdeaAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ proposal: Proposal; idea: { id: string; title: string } }>> {
  await requireSession("proposeTasksForIdeaAction");
  try {
    const [config, cards] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);
    const idea = cards.find((c) => c.id === input.cardId);
    if (!idea || idea.type !== "idea") return { ok: false, error: "Ideia não encontrada." };
    const o = idea.idea;
    const statement = o?.statement?.trim() || idea.title;
    const prompt = buildIdeaTasksPrompt({
      config,
      cards,
      idea: {
        statement,
        candidateSolutions: o?.candidateSolutions,
        keyAssumption: o?.keyAssumption ?? null,
        successSignal: o?.successSignal ?? null,
      },
    });
    const raw = await runClaudeJson(prompt, {
      context: { label: "Gerar tarefas da ideia", view: "captura", board: input.boardId, cardId: input.cardId },
    });
    const proposal = parseProposal(raw, config, cards);
    // WORK path: keep only stories (defensive — the prompt forbids ideas), and stamp the
    // addresses edge for DISPLAY so the tree shows "→ aborda: «a dor»". Commit re-stamps it canonically
    // via addressesIdeaId, so display and persistence agree.
    const items = proposal.items
      .filter((it) => it.type === "story")
      .map((it) => ({ ...it, addresses: input.cardId }));
    if (!items.length) {
      return { ok: false, error: "O agente não propôs nenhuma story. Tente ajustar a ideia e gerar de novo." };
    }
    return { ok: true, data: { proposal: { ...proposal, items }, idea: { id: idea.id, title: statement } } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * ② Re-cast: rewrite ONE proposed item into another type's shape (the human corrected the type in the
 * review). One-shot LLM (no conversation); reuses parseProposal for sanitization. Returns the rewritten
 * item with its identity (tempId) + target type forced. Proposal-level — writes NOTHING.
 */
export async function recastProposedItemAction(input: {
  boardId: string;
  item: ProposedItem;
  toType: CardType;
  toStoryType?: StoryType | null;
  /** original free text (turn 1) — helps the agent recover the substance when reshaping. */
  sourceText?: string;
}): Promise<Result<{ item: ProposedItem }>> {
  await requireSession("recastProposedItemAction");
  try {
    const [config, cards] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);
    const prompt = buildRecastPrompt({
      config,
      cards,
      item: input.item,
      toType: input.toType,
      toStoryType: input.toStoryType,
      sourceText: input.sourceText,
    });
    const raw = await runClaudeJson(prompt, {
      context: { label: "Reclassificar item", view: "captura", board: input.boardId },
    });
    const proposal = parseProposal(raw, config, cards);
    const out = proposal.items[0];
    if (!out) return { ok: false, error: "O agente não devolveu o item reescrito." };
    // Force identity + target type (defensive: the agent may drift on tempId/type).
    const item: ProposedItem = {
      ...out,
      tempId: input.item.tempId,
      type: input.toType,
      storyType: input.toType === "story" ? input.toStoryType ?? out.storyType ?? "user" : null,
    };
    return { ok: true, data: { item } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Smart capture, step 2: create the approved items as draft cards (status = entry,
 * no enrichment). Resolves tempId parent refs to real ids so a new step/activity and
 * the stories hung under it land wired together. Returns the created cards.
 */
export async function commitProposalAction(input: {
  boardId: string;
  items: ProposedItem[];
  /** dual-track OST (Fatia 3B): when a SCOPED capture (generateTasksForIdeaAction) produced these
   *  items, every created STORY gets an `addresses` edge to this idea, so it traces UP to the pain. */
  addressesIdeaId?: string;
  /** story-cl1mi9: context images the operator pasted in the capture modal (data URLs). Persisted to
   *  the bug sidecar for each captured BUG card so the pasted evidence survives onto the card. */
  images?: CaptureImageInput[];
  /** WS6 (F5): creation provenance stamped on every created card. Defaults to "capture" (the smart-capture
   *  path); create_card passes "mcp". */
  via?: CardProvenance;
  /**
   * UM HUMANO já revisou estes itens nesta tela, agora. Quem passa `true` são as superfícies de
   * REVISÃO (a modal de captura e o aceite no Inbox), onde o operador viu tipo, confiança e
   * suspeita de duplicata — e pôde reclassificar/reancorar antes de confirmar.
   *
   * Efeito: os cards NÃO nascem com `needsHumanReview`. Pedir "revise este item (baixa confiança)"
   * logo depois de o operador ter revisado e clicado em criar é fazer a MESMA pergunta duas vezes —
   * era o que acontecia com todo chore capturado à mão. A flag continua valendo para quem chega SEM
   * ninguém olhar: texto livre da triagem (`report_issue`) e lote aplicado por agente.
   */
  humanReviewed?: boolean;
}): Promise<Result<{ created: Card[]; extended: ExtendedCardOutcome[]; warnings: CardCommitWarning[] }>> {
  await requireSession("commitProposalAction");
  try {
    // WS6 (F5): the provenance stamped on every card this commit mints, and the structured degradation
    // warnings (a placement the proposal asked for that couldn't be honored) — surfaced, not dropped silent.
    const via: CardProvenance = input.via ?? "capture";
    const warnings: CardCommitWarning[] = [];
    // createcard-toctou: serialize the whole read→mint→write loop per board so concurrent captures
    // (a UI commit racing an MCP usm_capture) can't mint colliding deterministic ids and overwrite
    // each other's cards. Per-card edits/reads stay parallel.
    return await withCreateLock(input.boardId, async () => {
    const config = await readBoardConfig(input.boardId);
    const entryStatus = entryStatusId(config);
    const all = await readCards(input.boardId);
    const existing = new Set(all.map((c) => c.id));
    const tempToReal = new Map<string, string>();
    const created: Card[] = [];
    /** Cards EXISTENTES que este lote apenas estendeu (modo `targetCardId`) — nada foi criado para eles. */
    const extended: ExtendedCardOutcome[] = [];

    // WS-9 (D15) — a captura NUNCA cunha ideia. Cinto-e-suspensório no chokepoint de escrita: itens
    // `type:"idea"` (heurística do prompt escapou, OU sidecar legado) são IGNORADOS com um warning
    // apontando a bancada; um `addresses` de story para um ◆ do MESMO lote é limpo (o ◆ nunca nasce, então o
    // alvo não resolve). NUNCA lança sobre um ◆ legado — só o materializar é barrado. Ver commit.ts / ADR-064.
    const guarded = guardCaptureIdeas(input.items);
    const itemsToCreate = guarded.items;
    warnings.push(...guarded.warnings);

    // "NENHUM ITEM NASCE SEM LUGAR NO MAPA" — e a guarda mora AQUI, no chokepoint de escrita.
    //
    // A política já existia (WS6/F5) — mas só dentro do `create_card` do MCP. A CAPTURA (o modal e o
    // usm_capture mode:apply) chamava commitProposalAction direto e passava batido: uma story órfã era criada
    // em silêncio com `unplaced: true` e nenhum aceite. A decisão de "sem lugar" era então empurrada para o
    // pior momento possível — lá adiante, quando o gate hasPlacement travasse o card no plano-tecnico e o
    // humano tivesse que ir caçá-lo no drawer para clicar "Aceitar sem lugar". Exatamente o oposto de decidir
    // com o mapa inteiro na tela, na hora da revisão. (É a MESMA classe do ramo de duplicata: política num
    // caminho, caminho paralelo furando.) Guardar o caminho de ESCRITA faz todo caller herdar a regra.
    //
    // Um `parent` resolve contra o board EXISTENTE **ou** contra um tempId do PRÓPRIO lote — é o que permite ao
    // agente propor o backbone (activity/step) junto e pendurar as stories nele. `serves` só conta como lugar
    // para um item de ENTREGA (storyType ≠ user): `serves` numa user story é descartado no commit, e
    // aceitá-lo aqui criaria um órfão silencioso. Não há mais escape: todo card nasce ancorado.
    // CICLO entre tempIds — o furo que a guarda de placement NÃO pega. Um item cujo `parent` é um tempId do
    // lote que (direta ou indiretamente) volta nele mesmo nunca fica "ready": o loop de criação cai no `forced`
    // pass e o cria com `parent: null`. Ou seja, um ÓRFÃO — apesar de o item ter DECLARADO um pai, que é
    // exatamente o que a guarda checa. Recusado SEMPRE: um ciclo não é uma decisão de lugar, é uma proposta
    // malformada (o agente se contradisse). Aceitá-la só produziria lixo.
    {
      const byTemp = new Map(itemsToCreate.map((i) => [i.tempId, i]));
      const cyclic: string[] = [];
      for (const it of itemsToCreate) {
        const seen = new Set<string>([it.tempId]);
        let cur = it.parent ?? null;
        while (cur && byTemp.has(cur)) {
          if (seen.has(cur)) {
            cyclic.push(`"${it.title}"`);
            break;
          }
          seen.add(cur);
          cur = byTemp.get(cur)!.parent ?? null;
        }
      }
      if (cyclic.length > 0) {
        return {
          ok: false,
          error:
            `Hierarquia circular na proposta: ${cyclic.join(", ")} — o \`parent\` volta no próprio item. ` +
            `Nada foi criado (um ciclo faria os itens nascerem SEM lugar no mapa). Refaça a proposta pelo ` +
            `Feedback, com uma hierarquia acíclica.`,
        };
      }
    }

    // ANCORAGEM do lote — a versão RICA do erro que o chokepoint de escrita daria de qualquer jeito.
    // A REGRA não mora aqui (é `placementSpec`, gate-core, a mesma que a escrita usa); aqui mora só o
    // QUANDO cobrar, em `smart-capture/anchoring.ts` — puro e testável. O card capturado nasce na
    // QUARENTENA (a lane `staging`), que a invariante isenta de propósito: exigir âncora aqui era ser
    // mais estrito que a própria invariante, e foi o que quebrou a captura de bug (o prompt manda a
    // entrega sair com `parent` = step; a guarda exigia a user story; o lote inteiro caía).
    {
      // `entryStatus` (acima) é o ID do status de entrada; a quarentena é a lane `staging` (views.ts).
      const landsInQuarantine = !!config.statuses.find((s) => s.id === entryStatus)?.staging;
      const batchById = new Map(itemsToCreate.map((i) => [i.tempId, i]));
      const byBoardId = new Map(all.map((c) => [c.id, c]));
      const resolve = (ref: string) => {
        const inBatch = batchById.get(ref);
        if (inBatch) return { type: inBatch.type, storyType: inBatch.storyType ?? "user" };
        const card = byBoardId.get(ref);
        return card ? { type: card.type, storyType: card.storyType ?? "user" } : null;
      };
      const problems = [
        ...validateBatchAnchoring(itemsToCreate, resolve, { config, landsInQuarantine }),
        ...validateExtendTargets(itemsToCreate, (id) => byBoardId.has(id)),
      ];
      if (problems.length > 0) {
        const steps = all.filter((c) => c.type === "step").slice(0, 8).map((c) => `${c.id} (${c.title})`);
        const stories = all
          .filter((c) => c.type === "story" && (c.storyType ?? "user") === "user")
          .slice(0, 8)
          .map((c) => `${c.id} (${c.title})`);
        return {
          ok: false,
          error:
            `Nada foi criado — ${problems.length} item(ns) fora da hierarquia: ` +
            `${problems.map((p) => p.message).join("; ")}. ` +
            `Todo card vive no mapa: passo sob ação, user story sob passo, entrega sob a user story que ela ` +
            `serve (pelo id de um card EXISTENTE ou pelo tempId de um item do mesmo lote). ` +
            `Passos disponíveis: ${steps.length ? steps.join("; ") : "(nenhum — proponha o backbone no lote)"}. ` +
            `User stories disponíveis: ${stories.length ? stories.join("; ") : "(nenhuma)"}.`,
        };
      }
    }

    // Iteratively create items whose parent is already resolvable (null, an existing
    // card, or an already-created tempId). Parents-before-children without a full
    // topo-sort; any leftover (cycle/dangling) is created parentless on the last pass.
    let pending = [...itemsToCreate];
    let guard = pending.length + 1;
    while (pending.length && guard-- > 0) {
      const ready = pending.filter(
        (it) =>
          (!it.parent || existing.has(it.parent) || tempToReal.has(it.parent)) &&
          // dual-track: a story addressing an IN-BATCH idea must wait for that idea to exist
          // (resolve its tempId) — else the edge would resolve to undefined and drop silently.
          (!it.addresses || existing.has(it.addresses) || tempToReal.has(it.addresses)),
      );
      const forced = ready.length === 0; // last resort: force-create the rest (cycle/dangling)
      const batch = ready.length ? ready : pending;
      for (const it of batch) {
        const title = it.title.trim() || "Sem título";
        // ESTENDER em vez de CRIAR: o item só acrescenta tasks a um card que já existe. Nada é
        // escrito como card novo — por isso este ramo sai antes de tudo que decide id/parent/status.
        // A dedupe por título (case/acento-insensível contra as tasks JÁ presentes) existe porque a
        // captura costuma reformular a mesma tarefa em palavras próximas; reabrir uma task que o card
        // já tem seria pior que não acrescentar nada.
        if (it.targetCardId) {
          const targetId = it.targetCardId;
          let addedTasks = 0;
          const updated = await updateCardOnDisk(input.boardId, targetId, (card) => {
            const have = new Set((card.tasks ?? []).map((t) => normalizeTaskTitle(t.title)));
            const fresh = (it.tasks ?? [])
              .filter((t) => t.title.trim() && !have.has(normalizeTaskTitle(t.title)))
              .map((t, i) => ({
                id: t.id ?? `t${(card.tasks?.length ?? 0) + i + 1}`,
                title: t.title.trim(),
                done: false,
              }));
            addedTasks = fresh.length;
            if (!fresh.length) return null; // nada novo — não suja o mtime do card
            return { ...card, tasks: [...(card.tasks ?? []), ...fresh] };
          });
          extended.push({
            tempId: it.tempId,
            cardId: targetId,
            title: updated?.title ?? all.find((c) => c.id === targetId)?.title ?? targetId,
            addedTasks,
          });
          continue;
        }
        const parent = it.parent
          ? tempToReal.get(it.parent) ?? (existing.has(it.parent) ? it.parent : null)
          : null;
        // WS6 (F5): a requested parent that resolved to null is a DROPPED placement — warn (don't drop silent).
        const parentDropped = !!(it.parent && parent == null);
        if (parentDropped) {
          warnings.push({ tempId: it.tempId, code: "parent-dropped", detail: `parent "${it.parent}" não resolveu — card criado sem lugar` });
        }
        if (forced) {
          warnings.push({ tempId: it.tempId, code: "forced-created", detail: "ciclo/dependência não-resolvível — criado nesta passagem final" });
        }
        const release = it.type === "story" ? it.release ?? null : null;
        const id =
          it.type === "story"
            ? randomCardId(it.type, existing)
            : makeId(it.type, title, existing);

        // DUPLICATA É UM AVISO, NÃO UM VEREDITO.
        //
        // Antes, um `duplicateOf` que resolvia fazia o commit criar o card já em `duplicado` — um status
        // TERMINAL na coluna `archive`. Efeito prático: o operador capturava uma ideia, a UI mostrava o card
        // que seria criado, ele confirmava… e nada aparecia no board. O card existia, arquivado, invisível.
        // A decisão tinha sido tomada por ele. (Foi o que aconteceu com a captura de melhoria no headline:
        // deduplicada contra uma story JÁ ENTREGUE — e uma melhoria sobre algo entregue não é duplicata dela.)
        //
        // O contrato do campo sempre disse "aviso": ProposedItem.duplicateOf = "existing card id this looks
        // like a duplicate of (warn the human)", e o schema MCP diz "(aviso)". A UI de proposta já alertava
        // ("⚠ possível duplicata de X") e o CardBadges já mostra "Dup · X" em QUALQUER status. Só o commit é
        // que transformava o aviso em decisão.
        //
        // Agora: o card entra na Triagem normal CARREGANDO a suspeita (`duplicateOf` + `needsHumanReview`), e
        // quem decide é o HUMANO — ou o Jido autônomo — via a ação "Marcar duplicado", que já encontra o
        // `duplicateOf` preenchido (o gate hasDuplicateOf passa de primeira). Nada é arquivado às escondidas.
        const duplicateSuspect = it.duplicateOf && existing.has(it.duplicateOf) ? it.duplicateOf : null;
        if (duplicateSuspect) {
          warnings.push({
            tempId: it.tempId,
            code: "duplicate-suspected",
            detail: `possível duplicata de ${duplicateSuspect} — criado na Triagem para você decidir (marcar duplicado ou seguir)`,
          });
        }

        // WS-9 (D15): a captured IDEA (◆) is NEVER materialized here — it was already filtered out
        // above (guardCaptureIdeas) into an `idea-ignored` warning that points the human at the
        // Ideias bench. The old Fatia-3A branch (mint a status:null idea card from a captured ◆)
        // is retired: ideas are born ONLY via the deliberate bench (create_idea / the view),
        // never as a reflex of structured capture. See docs/adr/ADR-064. So every item reaching here is a
        // story or backbone (activity/step).

        // Routing by storyType for the planning path (mirrors triage/parse.ts:acceptRoute +
        // reportIssueAction's resting-triage intake). A bug/chore captured via planning must NOT
        // auto-enter the build pipeline — it RESTS in triage until a human ACCEPTS it:
        //  - bug   → stays in triage, pre-stamped mode:fix + a minimal bugReport (satisfies the
        //            hasBugReport gate). On accept, acceptRoute routes mode:fix → corrigir, where
        //            harness-fix rewrites the bugReport in full on diagnosis. (#31a: a freshly captured
        //            bug must NOT fire harness-fix on its own — the human gates it via triage, exactly
        //            like reportIssueAction does for free-text bug intake.)
        //  - chore → ambiguous (could be legit technical backlog), so it RESTS in triage
        //            flagged needsHumanReview rather than auto-routing into a lane.
        // Anything else (incl. an undefined storyType → "user") keeps the entry status (triage).
        const isStory = it.type === "story";
        let resolvedStatus = entryStatus;
        let resolvedMode: CardMode | undefined;
        let resolvedBugReport: BugReport | undefined;
        let resolvedNeedsHumanReview: boolean | undefined;
        if (isStory && it.storyType === "bug") {
          resolvedMode = "fix";
          // story-cl1mi9: retain the operator's pasted context images. Persist them to the bug
          // sidecar under the minted id; the returned filenames ride on the additive `screenshots`
          // array. `screenshot` stays null here — it's the single primary reserved for the reopen flow.
          const shots = input.images?.length
            ? await writeBugScreenshots(input.boardId, id, input.images.map((im) => im.dataUrl))
            : [];
          resolvedBugReport = {
            brief: title,
            severity: "medium",
            expected: null,
            actual: null,
            steps: [],
            target: null,
            screenshot: null,
            ...(shots.length ? { screenshots: shots } : {}),
            openedAt: new Date().toISOString().slice(0, 10),
          };
        } else if (isStory && it.storyType === "chore" && !input.humanReviewed) {
          // chore é ambíguo (pode ser backlog técnico legítimo) → descansa na triagem sinalizado.
          // Só quando NINGUÉM olhou: numa captura revisada à mão o operador já viu o tipo (e podia
          // trocá-lo no próprio seletor da revisão).
          resolvedNeedsHumanReview = true;
        }

        // Dual-track: a DELIVERY item may declare the map node it serves (resolve tempId/existing
        // like parent). Only kept for non-user stories; falls back to parent when absent/unresolvable.
        const isDelivery = isStory && it.storyType != null && it.storyType !== "user";
        const serves =
          isDelivery && it.serves
            ? tempToReal.get(it.serves) ?? (existing.has(it.serves) ? it.serves : undefined)
            : undefined;
        // WS6 (F5): a delivery's requested `serves` that didn't resolve is a DROPPED placement — warn.
        if (isDelivery && it.serves && serves == null) {
          warnings.push({ tempId: it.tempId, code: "serves-dropped", detail: `serves "${it.serves}" não resolveu para um node do mapa` });
        }

        // dual-track OST: a STORY may address an idea — per-item `addresses` (resolve tempId/existing
        // like parent/serves) takes PRIORITY; the batch-level addressesIdeaId is the fallback (scoped
        // capture, already idea-validated upstream). Only stories carry the edge. GUARD the per-item
        // target by KIND (linkType addresses is from:[story] to:[idea]): the LLM/MCP could address any
        // id, so a non-idea target is DROPPED instead of persisting an edge the board-integrity lint
        // (a gate) would flag + buildLinkGraph would silently drop.
        const perItemAddressed =
          isStory && it.addresses
            ? tempToReal.get(it.addresses) ?? (existing.has(it.addresses) ? it.addresses : undefined)
            : undefined;
        const perItemOppId =
          perItemAddressed && [...all, ...created].some((c) => c.id === perItemAddressed && c.type === "idea")
            ? perItemAddressed
            : undefined;
        const addressedId = isStory ? perItemOppId ?? input.addressesIdeaId : undefined;

        const card: Card = {
          id,
          type: it.type,
          title,
          storyType: it.type === "story" ? it.storyType ?? "user" : null,
          status: resolvedStatus,
          parent,
          release,
          order: nextOrder([...all, ...created], it.type, parent, release),
          ...emptyCardFields(),
          via,
          // Sem `unplaced`/`unplacedAck`: a guarda de ancoragem acima já recusou o lote se algum item
          // estivesse fora da hierarquia, então todo card que chega aqui nasce ancorado.
          ...(serves ? { serves } : {}),
          personas: it.personas ?? [],
          systems: it.systems ?? [],
          // dual-track OST: write the `addresses` edge (story→idea) from the per-item `addresses`
          // (resolved above), with the scoped-capture addressesIdeaId as fallback. Only stories reach
          // here (idea/backbone branch out earlier); the edge is from:[story] to:[idea].
          ...(addressedId ? { links: [{ rel: ADDRESSES_REL, to: addressedId }] } : {}),
          ...(it.narrative != null
            ? { narrative: { role: it.narrative.role ?? null, want: it.narrative.want ?? null, soThat: it.narrative.soThat ?? null } }
            : {}),
          ...(it.acceptance?.length ? { acceptance: it.acceptance } : {}),
          // WS7 (F6): a captured umbrella card carries its PRE-SEEDED decomposition → Card.tasks (done:false),
          // so N similar refactors land as 1 card with N tasks (intake consolidation). harness-plan/harness-do consume it.
          ...(isStory && it.tasks?.length
            ? {
                tasks: (() => {
                  // 1.6 — assign UNIQUE ids: filter empty titles FIRST (so `t{n}` stays dense), then keep an
                  // explicit LLM id only if free, else the next unused `t{n}` — a collision between an explicit
                  // id and a `t{idx+1}` fallback (e.g. task0.id="t2" + task1 no id → both "t2") is deduped.
                  const seen = new Set<string>();
                  return it
                    .tasks!.map((t) => ({ id: (t.id ?? "").trim(), title: (t.title ?? "").trim() }))
                    .filter((t) => t.title)
                    .map((t, idx) => {
                      let id = t.id;
                      if (!id || seen.has(id)) {
                        let n = idx + 1;
                        while (seen.has(`t${n}`)) n++;
                        id = `t${n}`;
                      }
                      seen.add(id);
                      return { id, title: t.title, done: false };
                    });
                })(),
              }
            : {}),
          ...(it.body?.trim() ? { body: it.body.trim() } : {}),
          ...(resolvedMode ? { mode: resolvedMode } : {}),
          ...(resolvedBugReport ? { bugReport: resolvedBugReport } : {}),
          // A SUSPEITA de duplicata viaja com o card (badge "Dup · X" no board) e o marca para decisão humana.
          // Ela NÃO o arquiva: `duplicateOf` aqui é o candidato a canônico, não a confirmação — a confirmação
          // é o status `duplicado`, e só um humano (ou o Jido autônomo) o aplica.
          // A suspeita VIAJA sempre (o badge "Dup · X" aparece em qualquer status); a COBRANÇA de
          // revisão só quando ninguém olhou — na revisão da captura o aviso de duplicata já está na
          // tela, com as ações de 1 clique ao lado dele.
          ...(duplicateSuspect
            ? { duplicateOf: duplicateSuspect, ...(input.humanReviewed ? {} : { needsHumanReview: true }) }
            : {}),
          ...(resolvedNeedsHumanReview ? { needsHumanReview: resolvedNeedsHumanReview } : {}),
        };
        await writeCard(input.boardId, card);
        existing.add(id);
        tempToReal.set(it.tempId, id);
        created.push(card);
      }
      pending = pending.filter((it) => !batch.includes(it));
    }

    // Fase 4.1 — resolve each warning's REAL minted id from the tempId→id map so the human surface can link
    // straight to the created card. All three codes (parent-dropped/serves-dropped/forced-created) correspond
    // to a card that WAS minted, so tempToReal always has it; the field stays sparse if it somehow didn't.
    for (const w of warnings) {
      const realId = tempToReal.get(w.tempId);
      if (realId) w.cardId = realId;
    }
    revalidateBoard(input.boardId);
    return { ok: true, data: { created, extended, warnings } };
    });
  } catch (e) {
    return fail(e);
  }
}

// ── Smart capture (async) — container in `capturando`, proposal sidecar, human accepts/refines ──

/**
 * Start an async smart capture: create an ephemeral container card (capture:true) in `capturando` with
 * the free text in its body, then kick the autorun so harness-capture generates the proposal sidecar.
 * Returns immediately — the human reviews/accepts the result in the Inbox (no spinner, no timeout).
 */
export async function startCaptureAction(input: {
  boardId: string;
  text: string;
  /** título LEGÍVEL do container (ex.: "Gerar stories: «a dor»"); default = início do texto livre.
   *  Sem isto, uma captura scoped fica com a INSTRUÇÃO como título ("Gere as user stories de…"), que polui
   *  o painel de runs e o Inbox. O harness-capture lê o `body` (texto), não o título — então é só cosmético. */
  title?: string;
  /** dual-track OST (Fatia 3B): scope the capture to an idea — the container carries an `addresses`
   *  edge to it (container is type:"story", so the edge is valid), which acceptProposalAction propagates to
   *  every created story. Set by generateTasksForIdeaAction; omit for a plain free-text capture. */
  scopeIdeaId?: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("startCaptureAction");
  try {
    const text = input.text?.trim();
    if (!text) return { ok: false, error: "Escreva o que você quer capturar." };
    const card = await withCreateLock(input.boardId, async () => {
      const all = await readCards(input.boardId);
      const existing = new Set(all.map((c) => c.id));
      const id = randomCardId("story", existing);
      const rawTitle = input.title?.trim() || text;
      const title = rawTitle.length > 70 ? `${rawTitle.slice(0, 70).trimEnd()}…` : rawTitle;
      const container: Card = {
        id,
        type: "story",
        title,
        storyType: "user",
        status: "capturando",
        parent: null,
        release: null,
        order: nextOrder(all, "story", null, null),
        ...emptyCardFields(),
        capture: true,
        body: text,
        ...(input.scopeIdeaId
          ? { links: [{ rel: ADDRESSES_REL, to: input.scopeIdeaId }] }
          : {}),
      };
      await writeCard(input.boardId, container);
      return container;
    });
    revalidateBoard(input.boardId);
    // Fire harness-capture (capturando is autorun:true+trigger) — same kick moveCardAction uses on entry.
    void evaluateAutorunOnEntry(input.boardId, card.id).catch((err) =>
      console.error(`[startCaptureAction autorun ${input.boardId}/${card.id}]`, err),
    );
    return { ok: true, data: { card } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Accept a capture proposal: create the real cards (commitProposalAction), then consume the container
 * (move it to the terminal `capturado`) and delete its proposal sidecar. The created cards land in the
 * board's staging intake (Triagem); the container leaves the active board.
 */
export async function acceptProposalAction(input: {
  boardId: string;
  containerId: string;
  items: ProposedItem[];
}): Promise<Result<{ created: Card[]; extended: ExtendedCardOutcome[]; warnings: CardCommitWarning[] }>> {
  await requireSession("acceptProposalAction");
  try {
    if (!input.items?.length) return { ok: false, error: "Nenhum item selecionado para criar." };
    // dual-track OST (Fatia 3B): a scoped capture tagged its container with an `addresses` edge to the
    // idea it serves; read it so the created stories trace UP to that pain. Plain captures have none.
    const all = await readCards(input.boardId);
    const container = all.find((c) => c.id === input.containerId);
    const addressesIdeaId = container?.links.find((l) => l.rel === ADDRESSES_REL)?.to;
    const res = await commitProposalAction({
      boardId: input.boardId,
      items: input.items,
      addressesIdeaId,
      humanReviewed: true, // o Inbox É a tela de revisão: o operador aceitou item a item
    });
    if (!res.ok) return res;
    await moveCardAction({ boardId: input.boardId, cardId: input.containerId, status: "capturado" });
    await deleteProposal(input.boardId, input.containerId);
    revalidateBoard(input.boardId);
    // Fase 4.1 — FORWARD the placement-degradation warnings (previously dropped here) so the Inbox accept
    // surface can tell the human a card was created without the requested parent/serves, just like the modal.
    return {
      ok: true,
      data: {
        created: res.data?.created ?? [],
        extended: res.data?.extended ?? [],
        warnings: res.data?.warnings ?? [],
      },
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Refine a capture proposal: append the human's free-text feedback to the proposal sidecar and move the
 * container back to `capturando`, which re-fires harness-capture to regenerate the proposal with the feedback.
 */
export async function refineProposalAction(input: {
  boardId: string;
  containerId: string;
  feedback: string;
}): Promise<Result> {
  await requireSession("refineProposalAction");
  try {
    const feedback = input.feedback?.trim();
    if (!feedback) return { ok: false, error: "Escreva o ajuste que você quer." };
    const doc = (await readProposal(input.boardId, input.containerId)) ?? {
      containerId: input.containerId,
      summary: "",
      items: [],
      feedback: [],
      generatedBy: "harness-capture",
      updated: null,
    };
    doc.feedback = [...doc.feedback, feedback];
    await writeProposal(input.boardId, doc);
    // Back to capturando → harness-capture re-runs and regenerates with the new feedback (moveCardAction
    // kicks the autorun on entry).
    const moved = await moveCardAction({
      boardId: input.boardId,
      cardId: input.containerId,
      status: "capturando",
    });
    if (!moved.ok) return moved;
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Mint the next unique feedback id (fbN, bumping past any existing id). Pure. */
function nextFeedbackId(existing: DesignFeedbackEntry[]): string {
  let n = existing.length + 1;
  const ids = new Set(existing.map((f) => f.id));
  while (ids.has(`fb${n}`)) n += 1;
  return `fb${n}`;
}

/** The per-card lock key for wireframe-sidecar read-modify-write (append feedback / choose). The
 *  card is parked at the com-design HUMAN stop, so no run regenerates it concurrently — the lock
 *  serializes the two in-process writers that CAN race: the canvas UI and the design_feedback MCP. */
const wireframeLockKey = (boardId: string, cardId: string) => `wireframe:${boardId}/${cardId}`;

/**
 * Append one entry to the design-canvas feedback thread (Canvas v2): a per-artifact change request,
 * a one-tap approve marker, or a canvas-wide note (`artifactId: null`). Sidecar-only — no card
 * field, no move; "Pedir ajuste" (requestDesignChangeAction) is what re-runs the design with the
 * accumulated unresolved entries.
 */
export async function submitDesignFeedbackAction(input: {
  boardId: string;
  cardId: string;
  artifactId: string | null;
  note?: string;
  kind?: "change" | "approve";
  by?: string;
}): Promise<Result<{ id: string }>> {
  await requireSession("submitDesignFeedbackAction");
  try {
    const kind = input.kind === "approve" ? "approve" : "change";
    const note = (input.note ?? "").trim() || (kind === "approve" ? "aprovado" : "");
    if (!note) return { ok: false, error: "Escreva o feedback." };
    const id = await withKeyedLock(wireframeLockKey(input.boardId, input.cardId), async () => {
      const doc = await readWireframe(input.boardId, input.cardId);
      if (!doc) return null;
      const entry: DesignFeedbackEntry = {
        id: nextFeedbackId(doc.feedback),
        artifactId: input.artifactId != null && input.artifactId.trim() ? input.artifactId : null,
        kind,
        note,
        by: (input.by ?? "").trim() || "human",
        at: today(),
        resolvedAt: null,
      };
      await writeWireframe(input.boardId, { ...doc, feedback: [...doc.feedback, entry] });
      return entry.id;
    });
    if (id == null) return { ok: false, error: "Sem design para comentar (sidecar de wireframes ausente)." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { id } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Ask for a design change at the "approve design" stop. The note (optional when per-artifact
 * change-requests already exist) lands as a CANVAS-WIDE entry in the sidecar `feedback[]` — the
 * structured channel the design skills read — and the card re-enters the design pipeline:
 * `design-ux` when any unresolved change is canvas-wide (the journey itself may change), else
 * `design-ui` (screens only — re-running the whole journey for a one-screen tweak is pure waste).
 */
export async function requestDesignChangeAction(input: {
  boardId: string;
  cardId: string;
  feedback: string;
}): Promise<Result> {
  await requireSession("requestDesignChangeAction");
  try {
    const note = input.feedback?.trim() ?? "";
    let target: "design-ux" | "design-ui" = "design-ux";
    const outcome = await withKeyedLock(wireframeLockKey(input.boardId, input.cardId), async () => {
      const doc = await readWireframe(input.boardId, input.cardId);
      if (!doc) return "no-doc" as const;
      const next: WireframeDoc = note
        ? {
            ...doc,
            feedback: [
              ...doc.feedback,
              { id: nextFeedbackId(doc.feedback), artifactId: null, kind: "change", note, by: "human", at: today(), resolvedAt: null },
            ],
          }
        : doc;
      if (unresolvedChanges(next).length === 0) return "nothing" as const;
      if (note) await writeWireframe(input.boardId, next);
      target = designReturnTarget(next);
      return "ok" as const;
    });
    if (outcome === "no-doc") return { ok: false, error: "Sem design para ajustar (sidecar de wireframes ausente)." };
    if (outcome === "nothing") {
      return { ok: false, error: "Nada a ajustar: escreva o pedido ou deixe feedback num artefato antes." };
    }
    const moved = await moveCardAction({ boardId: input.boardId, cardId: input.cardId, status: target });
    if (!moved.ok) return moved;
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Compose the markdown body of a triage card from the agent's report + the outcome. */
function renderTriageBody(text: string, report: TriageReport, outcome: TriageOutcome): string {
  const quoted = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  const lines = [
    "## Reporte (triagem automática)",
    "",
    report.summary || text,
    "",
    ...quoted.split("\n").map((l) => `> ${l}`),
    "",
    "---",
    `- **Triagem:** ${report.verb} · intenção ${report.intent} · confiança ${Math.round(report.confidence * 100)}%`,
    `- **Tipo:** ${report.storyType}${report.labels.length ? ` · labels: ${report.labels.join(", ")}` : ""}`,
    ...(report.intent === "bug"
      ? [`- **Prioridade (bug):** severidade ${report.severity} · frequência ${report.frequency} · workaround ${report.hasWorkaround ? "sim" : "não"}`]
      : []),
  ];
  if (report.relatesTo.length) lines.push(`- **Relaciona-se a:** ${report.relatesTo.join(", ")}`);
  if (outcome.duplicateOf) lines.push(`- **Duplicado de:** ${outcome.duplicateOf}`);
  if (report.declineReason) lines.push(`- **Motivo do declínio:** ${report.declineReason}`);
  if (outcome.needsHumanReview) lines.push("- ⚠️ **Precisa de revisão humana** (baixa confiança)");
  if (report.reasoning) lines.push(`- **Raciocínio:** ${report.reasoning}`);
  return lines.join("\n");
}

/**
 * Free-text bug/improvement intake (ADR-056, Fase 1). Sanitizes the report, runs the
 * READ-ONLY triage agent to classify + dedup against the board, applies the allowlist
 * + confidence gate (parse.ts), and materializes EXACTLY ONE card in the resolved
 * staging/terminal status (triage / duplicado / cancelado). Never reopens a story, never
 * runs a build skill — the only write is this one card. Unlike report_bug, no cardId is
 * required: the agent decides what it is and where it lands.
 */
export async function reportIssueAction(input: {
  boardId: string;
  text: string;
}): Promise<Result<{ card: Card; outcome: TriageOutcome; report: TriageReport }>> {
  await requireSession("reportIssueAction");
  try {
    const text = sanitizeIntakeText(input.text ?? "");
    if (!text) return { ok: false, error: "Escreva o relato (o que está quebrado ou o que melhorar)." };

    const [config, cards] = await Promise.all([
      readBoardConfig(input.boardId),
      readCards(input.boardId),
    ]);
    const raw = await runClaudeJson(buildTriagePrompt({ config, cards, text }), {
      context: { label: "Triagem", view: "triagem", board: input.boardId },
    });
    const report = parseTriage(raw, config, cards);
    const outcome = decideTriage(report);

    const links: CardLink[] = [
      ...report.relatesTo.map((to) => ({ rel: "relates-to", to })),
      ...(outcome.duplicateOf ? [{ rel: "duplicates", to: outcome.duplicateOf }] : []),
    ];

    // Opção B — a RESTING triage card carries its lane-prep so the later ACCEPT is a
    // clean status move (acceptRoute): a bug gets the bug priority axes + a canonical
    // bugReport (→ corrigir); a melhoria gets a refinement brief (→ refinar); a feature
    // stays a plain build card (→ enriquecer). Skipped for duplicado/cancelado (terminal).
    const intentExtra: Partial<Card> =
      outcome.status !== "triage"
        ? {}
        : report.intent === "bug"
          ? {
              storyType: "bug",
              severity: report.severity,
              frequency: report.frequency,
              hasWorkaround: report.hasWorkaround,
              mode: "fix",
              bugReport: buildTriageBugReport(report),
            }
          : report.intent === "melhoria"
            ? { mode: "refine", refinement: buildTriageRefinement(report) }
            : {};

    const card: Card = {
      ...makeDraftCard({
        type: "story",
        title: report.title || "Reporte de triagem",
        status: outcome.status,
        cards,
      }),
      storyType: report.storyType,
      severity: report.severity,
      labels: report.labels.length ? report.labels : undefined,
      duplicateOf: outcome.duplicateOf ?? undefined,
      needsHumanReview: outcome.needsHumanReview || undefined,
      links,
      body: renderTriageBody(text, report, outcome),
      ...intentExtra,
    };

    const r = await createCardAction({ boardId: input.boardId, card, via: "triage" });
    if (!r.ok) return r;
    return { ok: true, data: { card: r.data!.card, outcome, report } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Accept a card OUT of the triage staging lane into the build flow (Opção B, Fase 2).
 * Routes by the kind the intake persisted on the card (acceptRoute): a bug → `corrigir`,
 * a melhoria → `refinar`, a feature → `enriquecer`. The lane's entry gate
 * (hasBugReport / hasRefineBrief) was pre-satisfied at intake, so this is a clean,
 * gate-checked move. Re-reads fresh inside the lock; only triage cards are acceptable.
 */
/**
 * F5.3 — the DYNAMIC move gate for a SCOPED agent (autonomous tick). The per-call guard (5.2) classifies
 * move_card/accept_triage statically as `write-board`, but the REAL risk is the TARGET column's effect: moving
 * into a deploy/promote column fires an irreversible deploy; into an autorun column fires a harness-* run. This
 * re-gates the move at the target's class BEFORE the status write commits (the entry effect is post-commit —
 * gating around it would be too late). Returns a Result FAILURE to intercept (pending-approval or refusal), or
 * null to proceed. Only fires for a scoped actor + a class ABOVE write-board; a human/internal move is never
 * gated. `tool`/`args` scope the approval so the agent's re-try (same tool + same args) finds & consumes the grant.
 */
async function gateScopedMove(
  boardId: string,
  cardId: string,
  toStatus: string,
  config: BoardConfig,
  tool: "move_card" | "accept_triage",
  args: Record<string, unknown>,
): Promise<{ ok: false; error: string } | null> {
  if (!isScopedActor()) return null; // human / UI / internal move → never gated
  const cls = moveRiskClass(config, toStatus, undefined);
  if (cls === "write-board") return null; // benign move — the 5.2 guard already handled write-board
  const disp = dispositionFor(config.orchestrator ?? null, cls);
  if (disp === "auto") return null; // (deploy/destructive never resolve auto; run/merge only if the matrix says so)
  // A live human GRANT for this exact re-call? Consume it atomically and proceed.
  const grant = await findMatchingGrant(boardId, tool, args).catch(() => null);
  if (grant && (await consumeGrant(boardId, grant.id, tool, args).catch(() => false))) {
    void appendAgentAction({ board: boardId, tool, cls, disposition: "auto", outcome: "grant-consumed", approvalId: grant.id });
    return null;
  }
  if (disp === "ask") {
    const req = await createApprovalRequest({ board: boardId, cardId, tool, args, riskClass: cls, requestedBy: "run:orch" });
    void appendAgentAction({ board: boardId, tool, cls, disposition: "ask", outcome: "pending", approvalId: req.id });
    return { ok: false, error: `Mover "${cardId}" para "${toStatus}" dispara ${cls} — precisa de aprovação humana (pendente: ${req.id}). Aprove no Inbox, use wait_for_approval e re-tente com os MESMOS args.` };
  }
  // never — deploy/destructive: a human does it directly, the agent can't even with a grant.
  void appendAgentAction({ board: boardId, tool, cls, disposition: "never", outcome: "refused" });
  return { ok: false, error: `Mover "${cardId}" para "${toStatus}" dispara ${cls} (irreversível) — SEMPRE exige o operador humano; um agente autônomo não pode. Escale.` };
}

export async function acceptTriageCardAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ status: string }>> {
  await requireSession("acceptTriageCardAction");
  try {
    const config = await readBoardConfig(input.boardId);
    // F5.3 — a SCOPED agent accepting a triage card LANDS it in a routed lane that may be autorun/deploy. Pre-gate
    // at the routed target's class (the accept writes status DIRECTLY, bypassing moveCardAction). Human accept skips.
    // Quem pode ser aceito é quem está na QUARENTENA — a régua é a faceta `staging` do passo, não o id
    // literal "triage". O id era um segundo nome do mesmo conceito (e o board é que declara o seu passo
    // de entrada, ADR-056/065): num board que chame a coluna de outra coisa, o botão de aceitar existiria
    // e a ação recusaria. Uma régua só, declarativa.
    const isQuarantine = (statusId: string | null | undefined) =>
      Boolean(statusId) && config.statuses.find((s) => s.id === statusId)?.staging === true;
    if (isScopedActor()) {
      const pre = await readCard(input.boardId, input.cardId);
      if (pre && isQuarantine(pre.status)) {
        const gate = await gateScopedMove(input.boardId, input.cardId, acceptRoute(pre), config, "accept_triage", {
          board: input.boardId,
          cardId: input.cardId,
        });
        if (gate) return gate;
      }
    }
    let routed = "";
    const moved = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (!isQuarantine(card.status))
        throw new Error("Só cards na Triagem podem ser aceitos no fluxo (Opção B).");
      const to = acceptRoute(card);
      routed = to;
      // acceptRoute returns hardcoded entry ids (enriquecer / the reopen lanes) — guard that they
      // exist on THIS board so a board without one can't strand the accepted card in a phantom status.
      const statusError = unknownStatusError(to, config);
      if (statusError) throw new Error(statusError);
      const gateError = checkGate(card, to, config);
      if (gateError) throw new Error(gateError);
      // The human just acted on the flagged intake → the triage review HAPPENED. Clear the stale
      // needsHumanReview flag so it never resurfaces as a cockpit "review" on the advanced card.
      return { ...card, status: to, needsHumanReview: undefined };
    });
    if (!moved) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    // Autorun in-process: accepting a triage card LANDS it in a routed lane (enriquecer /
    // interview / corrigir / refinar) — some of which are autorun:true+trigger columns. Fire the
    // cascade right here through the SAME shared, gate-respecting helper a UI drag and MCP move_card
    // use, instead of leaving the autorun-on-accept at the mercy of the fs watcher (which needs an
    // open SSE tab + a recursive fs.watch delivering card.moved). The accept is always a genuine
    // status change (acceptRoute never returns `triage`), but the guard is kept explicit/defensive
    // so a future acceptRoute that returns triage can't loop. Best-effort + dedup-guarded: the
    // engine's dedupe window + per-card in-flight lock collapse the watcher's later echo into ONE
    // run, and a failure here never breaks the accept (story-wy1t7d, extends story-pqd7gs).
    if (moved.status && moved.status !== "triage") {
      // WS2 — the human accepted a triage card into a routed lane. from is always `triage` (guarded above).
      // F5.1 — atribui pelo ator MCP: um accept via token escopado é `run:orch`, não "human" (a triagem NÃO
      // pode virar uma via de lavar deploy de agente como humano no ledger).
      void appendTransition({ board: input.boardId, cardId: input.cardId, from: "triage", to: moved.status, actor: transitionActorLabel(), note: "accept-triage" });
      void evaluateAutorunOnEntry(input.boardId, input.cardId).catch((err) =>
        console.error(`[acceptTriageCardAction autorun ${input.boardId}/${input.cardId}]`, err),
      );
    }
    return { ok: true, data: { status: routed } };
  } catch (e) {
    return fail(e);
  }
}

/** Persist the full card (used by the editor drawer). */
export async function updateCardAction(input: {
  boardId: string;
  card: Card;
  /** audit #4: the status the card was in when the editor opened. Lets the server preserve a
   * concurrent on-disk advance instead of letting a stale plain Save silently revert it. Optional —
   * non-drawer callers (MCP update_card) omit it and keep the prior whole-card-save behaviour. */
  expectedStatus?: string | null;
  /** Doc-editor concurrency guard: the body as it was when the editor loaded. `mergeCardOnSave`
   * only protects pipeline-owned fields — the body is human-owned and would be last-writer-wins
   * against MCP/autorun. When provided and the on-disk body no longer matches, the save is refused
   * instead of silently clobbering the concurrent edit. */
  expectedBody?: string;
  /**
   * ADR-066 — o mesmo guard do `expectedBody`, para o bloco `idea`. Ele é preciso porque `mergeCardOnSave` só
   * protege campos PIPELINE-owned: o bloco `idea` é autoral, então o snapshot (possivelmente velho) de quem
   * salva vence o disco. Com o Explorador escrevendo no mesmo documento, "vence o disco" significa apagar em
   * silêncio o que o agente acabou de apurar — e sem tocar no corpo, o `expectedBody` nem percebe.
   */
  expectedIdea?: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("updateCardAction");
  try {
    const config = await readBoardConfig(input.boardId);
    // The drawer owns only the human-authored product fields; the pipeline-owned
    // fields are mutated by their OWN actions / harness-* skills and may have advanced
    // AFTER this drawer loaded its snapshot. updateCardOnDisk re-reads the card FRESH
    // inside the write lock, so mergeCardOnSave preserves the latest pipeline state
    // from disk (see card-merge.ts + the storymap-drawer-pipeline-fields-clobber bug).
    // Captured inside the lock from the FRESH on-disk card (not the possibly-stale drawer/MCP
    // snapshot), so we can tell a genuine status change from a plain body/title/RICE edit and only
    // fire autorun on the former — mirroring moveCardAction's prevStatus guard.
    let prevStatus: string | null | undefined;
    const card = await updateCardOnDisk(input.boardId, input.card.id, (prev) => {
      prevStatus = prev.status ?? null;
      if (input.expectedBody !== undefined && (prev.body ?? "") !== input.expectedBody) {
        throw new Error(
          "o corpo do card mudou no disco enquanto você editava (outra sessão/agente salvou antes) — recarregue o card e reaplique sua edição",
        );
      }
      if (input.expectedIdea !== undefined && ideaFingerprint(prev.idea) !== input.expectedIdea) {
        throw new Error(
          "os campos da ideia mudaram no disco enquanto você editava (o Explorador ou outra sessão escreveu antes) — recarregue a ideia e reaplique sua edição",
        );
      }
      const merged: Card = mergeCardOnSave(input.card, prev);
      // audit #4: the drawer loaded its snapshot when the card was in `expectedStatus`. If the user did
      // NOT touch status (merged.status still === expectedStatus) but the cascade ADVANCED the card on
      // disk meanwhile, a plain Save would silently REVERT that advance (spec drifts from real pipeline
      // state). Detect exactly that case and PRESERVE the disk status; only an INTENTIONAL status change
      // (merged.status !== expectedStatus — the Status select or "Mover para") falls through to the gate.
      if (
        input.expectedStatus !== undefined &&
        (merged.status ?? null) === (input.expectedStatus ?? null) &&
        (merged.status ?? null) !== (prev.status ?? null)
      ) {
        merged.status = prev.status ?? null;
      }
      // Gate: when this save changes status into a gated status, the (merged) card
      // must already satisfy that status's entry criteria — else block without writing.
      if (merged.status && merged.status !== (prev.status ?? null)) {
        const statusError = unknownStatusError(merged.status, config);
        if (statusError) throw new Error(statusError);
        const gateError = checkGate(merged, merged.status, config);
        if (gateError) throw new Error(gateError);
      }
      return merged;
    });
    if (!card) return { ok: false, error: `card não encontrado: ${input.card.id}` };
    revalidateBoard(input.boardId);
    // Autorun in-process: an intentional status change via update_card (the MCP path, or the drawer's
    // Status select) that LANDS the card in an autorun:true+trigger column must fire the cascade
    // through the SAME shared, gate-respecting helper a UI drag / MCP move_card use — instead of
    // depending on the fs watcher. Fires ONLY when the PERSISTED status differs from what was on disk
    // before the save, so: a plain body/title/RICE edit (status untouched) does NOT spawn, and the
    // audit#4 preserve branch (which sets merged.status = prev.status → card.status === prevStatus)
    // does NOT re-fire an already-advanced card. Best-effort + dedup-guarded, like the other paths
    // (story-wy1t7d, extends story-pqd7gs).
    if (card.status && (card.status ?? null) !== (prevStatus ?? null)) {
      // WS2 — a genuine status change via the drawer Status select / "Mover para" (the closed-list gap: MCP
      // update_card rejects status changes upstream, but the drawer persists the whole card through here).
      void appendTransition({ board: input.boardId, cardId: input.card.id, from: prevStatus ?? null, to: card.status, actor: "human", note: "drawer" });
      void evaluateAutorunOnEntry(input.boardId, input.card.id).catch((err) =>
        console.error(`[updateCardAction autorun ${input.boardId}/${input.card.id}]`, err),
      );
      // merge-train rootcause Front 3 (move-parity, story-wy1t7d): a real status change via update_card
      // (MCP update_card / the drawer Status select) OVERRIDES any PARKED integration of this card —
      // exactly like moveCardAction's drag/move_card path — so a reopen/move via this surface supersedes
      // the stale merge-queue entry instead of letting a ghost head-of-line demand linger while a fresh
      // run spawns. Best-effort, dynamic-imported (mirrors moveCardAction + the resolve actions), never
      // breaks the save; a no-op when nothing is parked.
      void import("@/lib/storymap/runner/merge-queue")
        .then(({ getMergeQueue }) => getMergeQueue().reconcileCardMergeEntries(input.boardId, input.card.id))
        .catch((err) => console.error(`[updateCardAction reconcile ${input.boardId}/${input.card.id}]`, err));
      // B3 parity (story-dboh30): a real status change via THIS action must ALSO fire the destination step's
      // onEnter ENTRY_EFFECT (promote-stage/deploy-board) — exactly like moveCardAction's drag/move_card path
      // does below. Both drawer surfaces reach here (the Status select + Save, and the "Mover para" confirm)
      // because the drawer persists the WHOLE card through updateCardAction so unsaved authorial edits aren't
      // lost (moveCardAction writes only position fields). Before this, updateCardAction fired the autorun
      // cascade + merge reconcile but SKIPPED the effect — so a human moving a card into release/deploy via the
      // drawer marked it advanced WITHOUT the code ever being promoted/deployed (the story-byel8k root cause on
      // the ACTION layer the MCP-tool fix left uncovered). entryEffect is PURE and returns null unless the
      // destination step declares onEnter; we're already inside the genuine-status-change guard. Best-effort —
      // never breaks the save (mirrors moveCardAction). The MCP update_card path can't reach here: it rejects
      // status changes upstream, so card.status === prevStatus there and this branch never runs.
      const effect = entryEffect(config, card.status, prevStatus);
      if (effect) {
        void ENTRY_EFFECTS[effect](input.boardId, input.card.id).catch((err) =>
          console.error(`[updateCardAction ${effect} ${input.boardId}/${input.card.id}]`, err),
        );
      }
    }
    return { ok: true, data: { card } };
  } catch (e) {
    return fail(e);
  }
}

/** Move/reorder a card: change parent, release, order and/or status in one write. */
// fireReleaseStaged + fireDeployBoard + ENTRY_EFFECTS live in lib/storymap/runner/entry-effects.ts
// so the autorun cascade (autorun-eval `forward`) can fire the SAME effects — without an actions.ts
// import cycle. moveCardAction below dispatches via the imported ENTRY_EFFECTS map.

export async function moveCardAction(input: {
  boardId: string;
  cardId: string;
  parent?: string | null;
  release?: string | null;
  order?: number;
  status?: string | null;
  /** Dual-track attribution override (delivery stories): set the map node it serves. */
  serves?: string | null;
  /**
   * Esta chamada é o DESFAZER de um move anterior — restaura um estado que já existia, não é uma
   * entrada nova. Logo ela NÃO dispara `evaluateAutorunOnEntry` nem os `ENTRY_EFFECTS` (release/
   * deploy): re-entrar num status com `autorun` re-spawnaria a skill que já rodou, e um desfazer que
   * dispara run não é desfazer. A transição continua sendo registrada no ledger (com o ator marcado),
   * porque ela de fato aconteceu — o que se suprime é o EFEITO de entrada, não o histórico.
   */
  isUndo?: boolean;
}): Promise<Result> {
  await requireSession("moveCardAction");
  try {
    const config = await readBoardConfig(input.boardId);
    // F5.3 — a SCOPED agent moving a card into a deploy/run column is re-gated at the TARGET's class (above the
    // static write-board the 5.2 guard saw). Runs BEFORE the write commits (the entry effect is post-commit).
    // A human/UI/internal move (isScopedActor()===false) skips this entirely.
    if (input.status && input.status !== undefined) {
      const gate = await gateScopedMove(input.boardId, input.cardId, input.status, config, "move_card", {
        board: input.boardId,
        cardId: input.cardId,
        status: input.status,
      });
      if (gate) return gate;
    }
    // Captured inside the lock = the card's status BEFORE this move, so we can tell a
    // real status change from a same-column reorder (the Kanban passes the unchanged
    // status alongside the new `order`) and only fire autorun on the former.
    let prevStatus: string | null | undefined;
    // Re-read fresh inside the lock + apply ONLY the position delta, so a concurrent
    // skill writing this card's content (acceptance/tasks/findings) isn't clobbered.
    const moved = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      prevStatus = card.status;
      // Gate: when this move enters a NEW gated status, validate before mutating.
      if (input.status !== undefined && input.status && input.status !== card.status) {
        const statusError = unknownStatusError(input.status, config);
        if (statusError) throw new Error(statusError);
        const gateError = checkGate(card, input.status, config);
        if (gateError) throw new Error(gateError);
      }
      const nextParent = input.parent !== undefined ? input.parent : card.parent;
      // SM-02: only an EXPLICIT reparent of a story toggles the unplaced flag — drop it
      // when parented onto a step (leaves the Backlog não-mapeado lane), set it when
      // intentionally un-mapped to parent:null (so it shows in the lane, not invisibly).
      // A pure status/order move (input.parent undefined — e.g. a kanban drag) preserves
      // whatever the card had, so a legacy orphan is never silently migrated.
      const nextUnplaced =
        input.parent !== undefined && card.type === "story"
          ? input.parent == null
            ? true
            : undefined
          : card.unplaced;
      const nextStatus = input.status !== undefined ? input.status : card.status;
      // HITL: open questions are moot once the card lands in a TERMINAL column (done/archived) — the
      // agent shipped without the answer. Resolve them as stale so they don't strand as "precisa de
      // você" on a concluded card (the orphan-questions bug: harness-grill asks, nothing closes them, the
      // card advances past them). Pure + idempotent.
      const nextDef = nextStatus ? config.statuses.find((s) => s.id === nextStatus) : undefined;
      const enteringTerminal = !!nextDef?.terminal;
      // O par para FINDINGS DE ENTREGA (story-cvq4w0): um card DEVOLVIDO a um step de implementação
      // (não-entrega, não-terminal) inicia um ciclo novo — o `deploy-failure` aberto descrevia o ciclo
      // morto e ficava MENTINDO na UI ("Republicar"/"Release falhou" sobre um run de implementação
      // ativo). Só num status CHANGE real, nunca num reorder da mesma coluna.
      const enteringImplementation =
        !!nextDef && nextStatus !== card.status && !nextDef.terminal && !nextDef.laneStep;
      return {
        ...card,
        parent: nextParent,
        unplaced: nextUnplaced,
        // Dual-track: only an EXPLICIT serves in the input changes it; "" clears the override
        // (falls back to parent). write.ts emits it only for delivery stories.
        serves:
          input.serves !== undefined ? (input.serves ? input.serves : undefined) : card.serves,
        release: input.release !== undefined ? input.release : card.release,
        order: input.order !== undefined ? input.order : card.order,
        status: nextStatus,
        questions: enteringTerminal ? resolveStaleQuestions(card.questions ?? [], today()) : card.questions,
        // Override condicional de findings (exactOptionalPropertyTypes: nunca atribuir `undefined` explícito).
        // Os dois ramos são MUTUAMENTE EXCLUSIVOS (enteringImplementation exige !terminal): reentrada em
        // implementação supersede os findings de ENTREGA (deploy-failure) do ciclo morto; entrada em TERMINAL
        // supersede os MECHANISM blockers residuais (code/data-not-landed, merge-back) que ficariam `open` para
        // sempre num card que nunca mais integra — o drift auto-perpetuante do selo "Bloqueio" stale.
        ...(enteringImplementation && card.findings
          ? { findings: supersedeDeliveryFindingsOnReentry(card.findings, today()) ?? card.findings }
          : enteringTerminal && card.findings
            ? {
                findings:
                  supersedeStaleTerminalBlockers(card.findings, { by: `terminal:${nextStatus}`, at: today() }) ??
                  card.findings,
              }
            : {}),
      };
    });
    if (!moved) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    // Autorun in-process: when this move LANDS the card in an autorun:true+trigger column,
    // fire the cascade right here — the SAME codepath a UI drag AND an MCP move_card use —
    // instead of leaving autorun-on-move at the mercy of the fs watcher (which needs an open
    // SSE tab + a recursive fs.watch to deliver the card.moved event). Best-effort and
    // dedup-guarded: the engine's dedupe window + in-flight lock collapse the watcher's later
    // echo of the same move into ONE run, and a failure here never breaks the move (story-pqd7gs).
    // Only on a real status CHANGE — a pure reorder/reparent (incl. a same-column drag,
    // which the Kanban submits with the unchanged status + a new order) must not trigger
    // a run, or it would re-fire the column's skill on a parked card. `prevStatus` is the
    // status before the write, so the change is genuine iff the new status differs.
    if (
      input.status !== undefined &&
      input.status &&
      moved.status === input.status &&
      prevStatus !== input.status
    ) {
      // WS2 — the primary transition (Kanban drag / MCP move_card). Genuine status change only.
      // F5.1 — atribui pelo ator MCP: `run:orch` p/ um move via token escopado, "human" p/ o operador/UI.
      // O ATOR continua sendo quem agiu (o operador); "foi um desfazer" é CONTEXTO e vai no `note` —
      // misturar os dois eixos corromperia a leitura de quem move card neste board.
      void appendTransition({ board: input.boardId, cardId: input.cardId, from: prevStatus ?? null, to: moved.status, actor: transitionActorLabel(), ...(input.isUndo ? { note: "undo" } : {}) });
      if (input.isUndo) return { ok: true }; // desfazer restaura estado: sem autorun, sem entry effect
      void evaluateAutorunOnEntry(input.boardId, input.cardId).catch((err) =>
        console.error(`[moveCardAction autorun ${input.boardId}/${input.cardId}]`, err),
      );
      // merge-train rootcause Front 3: a real status change OVERRIDES any PARKED integration of this card
      // (gate-failed/conflict awaiting the operator) — supersede it so a stale entry can't linger as a
      // head-of-line/ghost demand after a reopen/move. Best-effort, dynamic-imported (mirrors the resolve
      // actions), never breaks the move; a no-op when nothing is parked.
      void import("@/lib/storymap/runner/merge-queue")
        .then(({ getMergeQueue }) => getMergeQueue().reconcileCardMergeEntries(input.boardId, input.cardId))
        .catch((err) => console.error(`[moveCardAction reconcile ${input.boardId}/${input.cardId}]`, err));
    }
    // B3: entrar num step com `onEnter` (release/deploy) DISPARA o efeito via ENTRY_EFFECTS — um eixo
    // único no lugar dos if-blocks clonados. entryEffect já aplica o dedup (mudança real de status); o
    // `moved.status === input.status` confirma que o move pegou. Best-effort (nunca quebra o move).
    const effect = moved.status === input.status ? entryEffect(config, input.status, prevStatus) : null;
    if (effect) {
      void ENTRY_EFFECTS[effect](input.boardId, input.cardId).catch((err) =>
        console.error(`[moveCardAction ${effect} ${input.boardId}/${input.cardId}]`, err),
      );
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Reopen a story in human QA (`revisao`) or shipped (`concluida`) for improvement —
 * the "Refinar" action (see the card page's action menu, CardDocScreen).
 * Stamps `mode: refine` + the human brief onto the SAME card (no fork, no history)
 * and moves it into the `refinar` column, where the watcher → trigger-runner spawns
 * `harness-refine` to diagnose the live code, respec the delta and route it onward. The
 * brief carries the intent AND the intensity (polish ↔ aggressive redesign), which
 * harness-refine infers; `kind` biases the deep-skill roster + the entry column.
 */
export async function refineCardAction(input: {
  boardId: string;
  cardId: string;
  brief: string;
  kinds: ImprovementKind[];
  target?: string | null;
  /** reabertura R1 — the build column the operator reopens INTO (Discovery/Design/Em desenvolvimento).
   *  The card lands here carrying mode:refine + brief; the cascade's mode-aware override runs harness-refine
   *  THERE. Defaults to design-ux (refine is usually visual). */
  destination?: ReopenDestination;
  /** optional `data:image/...;base64,...` of the current state, stored in the sidecar */
  screenshotDataUrl?: string | null;
}): Promise<Result<{ card: Card }>> {
  await requireSession("refineCardAction");
  try {
    const brief = input.brief?.trim();
    if (!brief) return { ok: false, error: "Escreva o feedback de refino (o que melhorar e por quê)." };
    const picked = Array.from(new Set((input.kinds ?? []).filter(isImprovementKind)));
    const kinds: ImprovementKind[] = picked.length ? picked : ["ux"];
    const config = await readBoardConfig(input.boardId);
    // R1: land in the operator's chosen destination column (not a fixed `refinar` lane). harness-refine then
    // runs THERE via the mode-aware override. updateCardOnDisk bypasses the destination's entry gate by
    // design — the refine brief IS the pre-requisite (the same way the old `refinar` gate was the brief).
    const dest: ReopenDestination = isReopenDestination(input.destination) ? input.destination : "design-ux";
    if (!config.statuses.some((s) => s.id === dest)) {
      return { ok: false, error: `Coluna de destino inexistente neste board: ${dest}.` };
    }
    let screenshot: string | null = null;
    if (input.screenshotDataUrl) {
      screenshot = await writeRefineScreenshot(input.boardId, input.cardId, input.screenshotDataUrl);
    }
    const today = new Date().toISOString().slice(0, 10);
    let refineFrom: string | null = null;
    const next = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (card.type !== "story") throw new Error("Só stories podem ser refinadas.");
      refineFrom = card.status ?? null;
      return {
        ...applyReopen(card, {
          mode: "refine",
          refinement: { brief, kinds, target: input.target?.trim() || null, screenshot, openedAt: today },
        }),
        status: dest,
        reopenPending: true, // one-shot: harness-refine runs THIS pass at the destination, then clears it
      };
    });
    if (!next) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    if (next.status) void appendTransition({ board: input.boardId, cardId: input.cardId, from: refineFrom, to: next.status, actor: "human", note: "reopen:refine" });
    // A reopen is a REAL status change — fire the cascade in-process (mirrors move/triage actions) so the
    // mode-aware override (harness-refine) runs WITHOUT depending on an open SSE tab + the fs-watcher
    // (story-pqd7gs/wy1t7d), and supersede any parked integration of this card.
    void evaluateAutorunOnEntry(input.boardId, input.cardId).catch((err) =>
      console.error(`[refineCardAction autorun ${input.boardId}/${input.cardId}]`, err),
    );
    void import("@/lib/storymap/runner/merge-queue")
      .then(({ getMergeQueue }) => getMergeQueue().reconcileCardMergeEntries(input.boardId, input.cardId))
      .catch((err) => console.error(`[refineCardAction reconcile ${input.boardId}/${input.cardId}]`, err));
    return { ok: true, data: { card: next } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Reopen a story in human QA (`revisao`) or shipped (`concluida`) because it BROKE —
 * the "Reportar bug" action (sibling of refineCardAction; see REOPENABLE_STATUSES in
 * CardDocScreen). Stamps `mode: fix` + the human bug report onto the SAME card (no
 * fork, no history) and moves it into the `corrigir` column, where the watcher →
 * trigger-runner spawns `harness-fix` to diagnose the live code, REPRODUCE the defect,
 * respec `acceptance` as expected×actual and route it onward (visual regression →
 * design-ux; behaviour → desenvolver). `severity` triages urgency (no queue-jumping
 * in v1). A bug is a defect, not an improvement — so no `kinds`.
 */
export async function reportBugAction(input: {
  boardId: string;
  cardId: string;
  brief: string;
  severity: BugSeverity;
  expected?: string | null;
  actual?: string | null;
  steps?: string[];
  target?: string | null;
  /** reabertura R1 — the build column the operator reopens INTO. The card lands here carrying mode:fix +
   *  the bug report; the cascade's mode-aware override runs harness-fix THERE. Defaults to desenvolver (a bug
   *  is a code defect). */
  destination?: ReopenDestination;
  /** optional `data:image/...;base64,...` of the broken state, stored in the sidecar */
  screenshotDataUrl?: string | null;
}): Promise<Result<{ card: Card }>> {
  await requireSession("reportBugAction");
  try {
    const brief = input.brief?.trim();
    if (!brief) return { ok: false, error: "Escreva o relato do bug (o que está quebrado e o contexto)." };
    const severity: BugSeverity = isBugSeverity(input.severity) ? input.severity : "medium";
    const config = await readBoardConfig(input.boardId);
    // R1: land in the operator's chosen destination column (not a fixed `corrigir` lane). harness-fix then
    // runs THERE via the mode-aware override. The bug report IS the gate pre-requisite (updateCardOnDisk
    // bypasses the destination's entry gate by design).
    const dest: ReopenDestination = isReopenDestination(input.destination) ? input.destination : "desenvolver";
    if (!config.statuses.some((s) => s.id === dest)) {
      return { ok: false, error: `Coluna de destino inexistente neste board: ${dest}.` };
    }
    let screenshot: string | null = null;
    if (input.screenshotDataUrl) {
      screenshot = await writeBugScreenshot(input.boardId, input.cardId, input.screenshotDataUrl);
    }
    const steps = Array.isArray(input.steps) ? input.steps.map((s) => String(s).trim()).filter(Boolean) : [];
    const today = new Date().toISOString().slice(0, 10);
    let fixFrom: string | null = null;
    const next = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (card.type !== "story") throw new Error("Só stories podem ser corrigidas.");
      fixFrom = card.status ?? null;
      return {
        ...applyReopen(card, {
          mode: "fix",
          bugReport: {
            brief,
            severity,
            expected: input.expected?.trim() || null,
            actual: input.actual?.trim() || null,
            steps,
            target: input.target?.trim() || null,
            screenshot,
            openedAt: today,
          },
        }),
        status: dest,
        reopenPending: true, // one-shot: harness-fix runs THIS pass at the destination, then clears it
      };
    });
    if (!next) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    if (next.status) void appendTransition({ board: input.boardId, cardId: input.cardId, from: fixFrom, to: next.status, actor: "human", note: "reopen:fix" });
    // A reopen is a REAL status change — fire the cascade in-process (mirrors move/triage actions) so the
    // mode-aware override (harness-fix) runs WITHOUT depending on an open SSE tab + the fs-watcher, and
    // supersede any parked integration of this card.
    void evaluateAutorunOnEntry(input.boardId, input.cardId).catch((err) =>
      console.error(`[reportBugAction autorun ${input.boardId}/${input.cardId}]`, err),
    );
    void import("@/lib/storymap/runner/merge-queue")
      .then(({ getMergeQueue }) => getMergeQueue().reconcileCardMergeEntries(input.boardId, input.cardId))
      .catch((err) => console.error(`[reportBugAction reconcile ${input.boardId}/${input.cardId}]`, err));
    return { ok: true, data: { card: next } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Descontinuar — the third reopen sibling (after refine/fix), for the REMOVE flow.
 * Stamps `mode: retire` + a Retirement brief onto the card and ROUTES it: a `level`
 * set (there is live/WIP code to cut) sends it through the `descontinuar` executor
 * column (where `harness-retire` diagnoses the live feature, writes a removal plan and
 * removes it at the chosen level); no level (postergado, or "nothing to remove")
 * sends it STRAIGHT to the terminal `arquivados` graveyard. Unlike refine/fix this can
 * leave from ANY status (a never-built enriquecer, a mid-flow desenvolver, a shipped
 * concluida). The original status rides in `fromStatus` so a postergado revive returns
 * it. The destructive cut is the executor's job; the data wipe is human-gated.
 */
export async function discontinueCardAction(input: {
  boardId: string;
  cardId: string;
  brief: string;
  disposition: Disposition;
  level?: RemovalLevel | null;
  scope?: RemovalScope[];
  target?: string | null;
  /** optional `data:image/...;base64,...` of the current state, stored in the sidecar */
  screenshotDataUrl?: string | null;
}): Promise<Result<{ card: Card }>> {
  await requireSession("discontinueCardAction");
  try {
    const brief = input.brief?.trim();
    if (!brief) return { ok: false, error: "Escreva o motivo da descontinuação (por que sai e até onde remover)." };
    const disposition: Disposition = isDisposition(input.disposition) ? input.disposition : "descontinuado";
    // postergado never removes code → no level; otherwise keep a valid level or null.
    const level: RemovalLevel | null =
      disposition === "postergado" ? null : isRemovalLevel(input.level) ? input.level : null;
    const scope = Array.from(new Set((input.scope ?? []).filter(isRemovalScope)));
    const config = await readBoardConfig(input.boardId);
    const lane = REOPEN_KINDS.retire; // status = `descontinuar` (executor), noOpStatus = `arquivados`
    if (!config.statuses.some((s) => s.id === lane.noOpStatus)) {
      return { ok: false, error: "Este board não tem a coluna Arquivados (adicione-a no board.yaml)." };
    }
    const hasExecutor = config.statuses.some((s) => s.id === lane.status);
    let screenshot: string | null = null;
    if (input.screenshotDataUrl) {
      screenshot = await writeRetireScreenshot(input.boardId, input.cardId, input.screenshotDataUrl);
    }
    const today = new Date().toISOString().slice(0, 10);
    // A level to cut + an executor column present → route through the agent; else the
    // card has nothing to remove (postergado / abandoned) → straight to the graveyard.
    const status = level && hasExecutor ? lane.status : (lane.noOpStatus as string);
    // Entrar DIRETO no terminal `arquivados` (postergado / nada a remover) supersede os MECHANISM blockers
    // residuais — mesma régua dos outros chokepoints de terminal. Um card arquivado nunca re-integra, então um
    // `code/data-not-landed`/`merge-back` aberto ficaria stale para sempre (o mesmo drift do selo "Bloqueio").
    // (Quando `level && hasExecutor`, o destino é o executor `descontinuar` — NÃO terminal — e o harness-retire
    // arquiva depois; esse caminho é coberto no display por liveOpenBlockers, já que ele grava o .md direto.)
    const destTerminal = !!config.statuses.find((s) => s.id === status)?.terminal;
    const next = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (card.type !== "story") throw new Error("Só stories podem ser descontinuadas.");
      const reopened = {
        ...applyReopen(card, {
          mode: "retire",
          retirement: {
            brief,
            disposition,
            level,
            scope,
            target: input.target?.trim() || null,
            screenshot,
            fromStatus: card.status ?? null,
            dataDeletionApproved: false,
            openedAt: today,
          },
        }),
        status,
      };
      if (!destTerminal) return reopened;
      const superseded = supersedeStaleTerminalBlockers(reopened.findings ?? [], { by: `terminal:${status}`, at: today });
      return superseded ? { ...reopened, findings: superseded } : reopened;
    });
    if (!next) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    if (next.status) void appendTransition({ board: input.boardId, cardId: input.cardId, from: next.retirement?.fromStatus ?? null, to: next.status, actor: "human", note: "reopen:retire" });
    // story-ql5mjm: descontinuar virou automático (harness-retire autorun, lane oculta) — dispara a cascata
    // in-process igual às outras reaberturas, para o harness-retire rodar sem depender de uma aba SSE aberta.
    void evaluateAutorunOnEntry(input.boardId, input.cardId).catch((err) =>
      console.error(`[discontinueCardAction autorun ${input.boardId}/${input.cardId}]`, err),
    );
    return { ok: true, data: { card: next } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Reviver — bring a POSTERGADO card back into the active pipeline (the "Reviver"
 * button on an archived card). Only postergado is revivable (abandonado/descontinuado
 * are definitive). Clears `mode: retire` + the retirement block and returns the card
 * to where it came from (`fromStatus`), falling back to the entry column when that
 * status no longer exists, is terminal, or its gate would block the revive.
 */
export async function reviveCardAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("reviveCardAction");
  try {
    const config = await readBoardConfig(input.boardId);
    const entry = entryStatusId(config) ?? "triage";
    let reviveFrom: string | null = null;
    const revived = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (card.mode !== "retire" || !card.retirement) throw new Error("Card não está arquivado.");
      if (card.retirement.disposition !== "postergado") {
        throw new Error(
          "Só itens postergados podem ser revividos — abandonados e descontinuados são definitivos.",
        );
      }
      reviveFrom = card.status ?? null; // 6.1 — the archived status we're reviving OUT of (ledger `from`)
      const from = card.retirement.fromStatus;
      const fromOk = !!from && config.statuses.some((s) => s.id === from && !s.terminal);
      const r: Card = { ...card, mode: undefined, retirement: null, status: fromOk ? from! : entry };
      // The destination may carry a gate (it normally passes — the card came from there);
      // if it can't, fall back to the entry column (no gate) rather than block the revive.
      if (r.status && checkGate(r, r.status, config)) r.status = entry;
      return r;
    });
    if (!revived) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    // 6.1 — the reopen SIBLINGS (refine:reopen/fix:reopen/retire:reopen) all append a transition; revive was
    // the missing 4th write-point. actor="human" (the Reviver button); note names the archive origin.
    if (revived.status)
      void appendTransition({ board: input.boardId, cardId: input.cardId, from: reviveFrom, to: revived.status, actor: "human", note: "revive:postergado" });
    return { ok: true, data: { card: revived } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Aprovar exclusão de dados — the human go-ahead for the one IRREVERSIBLE step (a
 * production data wipe), required only at level `excluir-tudo`. Flips
 * `retirement.dataDeletionApproved` and RE-RUNS `harness-retire`, which now sees the
 * approval and executes the data cut (then archives the card). Mirrors the manual
 * "Rodar agora" path: same engine, in-flight lock, concurrency cap and master switch.
 */
export async function approveDataDeletionAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ trigger: string }>> {
  await requireSession("approveDataDeletionAction");
  try {
    if (!loadRunnerConfig().autorun.enabled) {
      return { ok: false, error: "Runner desligado (Config → autorun, ou USM_AUTORUN=0). Ligue para executar a remoção." };
    }
    const approved = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (card.mode !== "retire" || !card.retirement) throw new Error("Card não está em descontinuação.");
      if (card.retirement.level !== "excluir-tudo") {
        throw new Error("Só o nível “Excluir tudo” precisa de aprovação de exclusão de dados.");
      }
      return { ...card, retirement: { ...card.retirement, dataDeletionApproved: true } };
    });
    if (!approved) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    const config = await readBoardConfig(input.boardId);
    // The card normally waits in `descontinuar` (the executor column) pending approval;
    // resolve its status def (with model/effort) to re-run, falling back to that column.
    const def =
      config.statuses.find((s) => s.id === approved.status && s.trigger === "harness-retire") ??
      config.statuses.find((s) => s.id === "descontinuar");
    if (!def?.trigger) {
      return { ok: false, error: "Coluna Descontinuar sem trigger — não há o que rodar." };
    }
    const res = getRunnerEngine().runSkill(input.boardId, approved.id, def.trigger, def, {
      headroomUrl: resolveHeadroomUrl(config, process.env),
    });
    if (!res.ok) {
      return { ok: false, error: res.reason === "in-flight" ? "Esse card já está rodando." : res.detail };
    }
    revalidateBoard(input.boardId);
    return { ok: true, data: { trigger: def.trigger } };
  } catch (e) {
    return fail(e);
  }
}

/** Load the removal-plan sidecar markdown for a card (retire mode) — null when none. */
export async function getRetirePlanAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ markdown: string | null }>> {
  await requireSession("getRetirePlanAction");
  try {
    return { ok: true, data: { markdown: await readRetirePlan(input.boardId, input.cardId) } };
  } catch (e) {
    return fail(e);
  }
}

/** Delete a card and clean dangling references (parent + links) in other cards. */
export async function deleteCardAction(input: {
  boardId: string;
  cardId: string;
  /** M2 — audit attribution for the trash manifest (default "human"). */
  by?: string;
  /** M2 — optional free-text reason recorded on the trash manifest. */
  reason?: string;
}): Promise<Result<{ unlinked: string[] }>> {
  await requireSession("deleteCardAction");
  try {
    const cards = await readCards(input.boardId);
    // A hierarquia não se apaga por baixo: um card que ANCORA outros não pode ser removido enquanto eles
    // dependem dele. Antes, apagar um step/activity com filhos os deixava órfãos (com um ack sistêmico
    // `system:parent-deleted` para o lint não ficar vermelho) — ou seja, a própria deleção FABRICAVA a
    // dívida que a invariante existe para impedir. Agora ela RECUSA e diz quem depende: o operador
    // reancora primeiro (arrastando no mapa ou pelo picker de Pai) e só então apaga.
    const dependents = cards.filter(
      (c) => c.id !== input.cardId && (c.parent === input.cardId || c.serves === input.cardId),
    );
    if (dependents.length) {
      const sample = dependents.slice(0, 5).map((c) => `“${c.title}”`).join(", ");
      return {
        ok: false,
        error:
          `Não dá para apagar: ${dependents.length} card(s) vivem ancorados neste — ${sample}` +
          `${dependents.length > 5 ? ` e mais ${dependents.length - 5}` : ""}. ` +
          `Reancore-os primeiro (arraste no mapa ou troque o Pai/Serve no card); depois apague este.`,
      };
    }
    // M2 — which OTHER cards reference this one; recorded on the manifest (informational — restore re-materializes
    // the card, NOT the topology, so the operator can see what was unlinked). Sem `parent`/`serves` (barrados
    // acima), sobram os `links` — arestas laterais, que não são ancoragem.
    const referencing = cards
      .filter((c) => c.id !== input.cardId && c.links.some((l) => l.to === input.cardId))
      .map((c) => c.id);
    // M2 — SOFT delete: move the `.md` into `.trash/` with a restore manifest (reversible 7 days) instead of rm.
    await trashCardFile(input.boardId, input.cardId, {
      kind: "card",
      id: input.cardId,
      by: input.by ?? "human",
      at: new Date().toISOString(),
      reason: input.reason,
      strippedRefs: referencing.length ? referencing : undefined,
    });
    // Só restam as arestas LATERAIS (`links`): a ancoragem já foi barrada acima, então nenhuma deleção
    // pode mais produzir órfão. Limpa o link pendente relendo cada card fresco, para não clobberar uma
    // edição concorrente de campo alheio.
    const unlinked: string[] = [];
    await Promise.all(
      cards
        .filter((c) => c.id !== input.cardId && c.links.some((l) => l.to === input.cardId))
        .map((c) =>
          updateCardOnDisk(input.boardId, c.id, (fresh) => {
            const links = fresh.links.filter((l) => l.to !== input.cardId);
            if (links.length === fresh.links.length) return null;
            unlinked.push(fresh.id);
            return { ...fresh, links };
          }),
        ),
    );
    // Best-effort: drop the proposal sidecar too, so deleting a capture container leaves nothing
    // behind (no-op for non-container cards / when there's no sidecar).
    await deleteProposal(input.boardId, input.cardId).catch(() => {});
    revalidateBoard(input.boardId);
    return { ok: true, data: { unlinked } };
  } catch (e) {
    return fail(e);
  }
}

/** Persist board.yaml (add/edit personas, systems, releases, statuses, linkTypes). */
export async function updateBoardConfigAction(input: {
  boardId: string;
  config: BoardConfig;
}): Promise<Result> {
  await requireSession("updateBoardConfigAction");
  try {
    await writeBoardConfig(input.boardId, input.config);
    revalidateBoard(input.boardId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Fase 5.1 — set a board's orchestrator MODE (off/paired/autonomous) from the Copiloto config tab, via the
 * existing board-config write path (persists the delta + versions board.yaml to main). SECURITY: reject
 * `autonomous` while the server-side riskMatrix enforcement (item 6.5) is NOT wired — otherwise the only
 * containment for an autonomous tick is the skill prompt (guidance, not a gate). Mirrors the UI's blocking gate.
 */
export async function setBoardOrchestratorModeAction(input: {
  boardId: string;
  mode: OrchestratorMode;
  /**
   * A AUTONOMIA que o operador escolheu no MESMO gesto de ligar o modo (o popover "o que ele pode fazer
   * sozinho?"). Gravar mode e matriz numa ÚNICA escrita é o que evita o buraco anterior: ligar `autonomous`
   * deixava a matriz no default (todo write-board = `ask`), então o "auto" recém-ligado só sabia LER e
   * enfileirar aprovações — parecia autônomo e não era. Ausente ⇒ preserva a matriz atual do board.
   */
  riskMatrix?: Partial<Record<RiskClass, RiskDisposition>>;
}): Promise<Result> {
  await requireSession("setBoardOrchestratorModeAction");
  try {
    if (input.mode === "autonomous" && !autonomousModeSafe()) {
      return {
        ok: false,
        error:
          "Modo autônomo bloqueado: o enforcement server-side da matriz de risco (item 6.5) ainda não está ativo — sem ele a única contenção do tick é o prompt da skill. Habilite após o 6.5.",
      };
    }
    const config = await readBoardConfig(input.boardId);
    const candidate = {
      ...(config.orchestrator ?? { mode: "off" as OrchestratorMode }),
      mode: input.mode,
      ...(input.riskMatrix ? { riskMatrix: input.riskMatrix } : {}),
    };
    // a matriz passa pelo MESMO lint da setBoardRiskMatrixAction (um deploy/run:auto REPROVA) — o caminho de
    // escrita nunca pode ser mais frouxo que o editor dedicado.
    const errors = lintRiskMatrix(candidate);
    if (errors.length) return { ok: false, error: errors.join("; ") };
    const next: BoardConfig = { ...config, orchestrator: candidate };
    await writeBoardConfig(input.boardId, next);
    revalidateBoard(input.boardId);
    // Item 2 — ativar autonomous dispara um tick IMEDIATO só deste board (fire-and-forget, lazy import) em vez
    // de esperar até 30min pelo próximo tick global. Inerte sem STORYMAP_MCP_TOKEN_ORCH (spawnOrchestrator pula).
    if (input.mode === "autonomous") {
      void import("@/lib/storymap/runner/orchestrator-run")
        .then(({ runBoardTickNow }) => runBoardTickNow(input.boardId, "você acabou de ligar o modo autônomo"))
        .catch(() => {});
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * F3.4 — set a board's riskMatrix (risk CLASS → auto/ask/never) from the Copiloto quick-settings / config tab.
 * Espelho de setBoardOrchestratorModeAction (readBoardConfig → spread orchestrator → writeBoardConfig →
 * revalidateBoard), preservando mode/maxActionsPerHour. LINTA antes de gravar: um deploy/destructive/run/
 * merge-resolve:auto (NEVER_AUTO) REPROVA com a mensagem do lint — a UI mostra o clamp, a escrita o recusa.
 */
export async function setBoardRiskMatrixAction(input: {
  boardId: string;
  riskMatrix: Partial<Record<RiskClass, RiskDisposition>>;
}): Promise<Result> {
  await requireSession("setBoardRiskMatrixAction");
  try {
    const config = await readBoardConfig(input.boardId);
    const prev = config.orchestrator ?? { mode: "off" as OrchestratorMode };
    const candidate = { ...prev, riskMatrix: input.riskMatrix };
    const errors = lintRiskMatrix(candidate);
    if (errors.length) return { ok: false, error: errors.join("; ") };
    const next: BoardConfig = { ...config, orchestrator: candidate };
    await writeBoardConfig(input.boardId, next);
    revalidateBoard(input.boardId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Read the current economy mode from settings.yaml (for the top-nav chip).
 * Returns false when the file is absent or the field is not set.
 */
export async function getEconomyModeAction(): Promise<Result<{ economyMode: boolean }>> {
  await requireSession("getEconomyModeAction");
  try {
    return { ok: true, data: { economyMode: loadRunnerConfig().economyMode ?? false } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Toggle economy mode on/off — writes settings.yaml and revalidates board routes.
 * Economy ON: caps all runs at sonnet/high; skips autorun for harness-refine and harness-fix.
 */
export async function setEconomyModeAction(input: { enabled: boolean }): Promise<Result> {
  await requireSession("setEconomyModeAction");
  try {
    const current = loadRunnerConfig();
    await writeRunnerSettings({ ...current, economyMode: input.enabled });
    revalidatePath("/board", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Persist the GLOBAL runner settings (storymap/settings.yaml) that drive the
 * autorun trigger-runner channel: kill switch, concurrency, watchdogs, claude
 * binary, global extra args, and the model/effort/maxTurns column fallbacks.
 * USM_* env vars still override these at runtime — the panel flags active ones.
 */
export async function saveRunnerSettingsAction(input: {
  settings: RunnerSettings;
}): Promise<Result> {
  await requireSession("saveRunnerSettingsAction");
  try {
    await writeRunnerSettings(input.settings);
    // Settings affect every board's runner; refresh all board routes.
    revalidatePath("/board", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Open a real OS terminal running `claude --resume <sessionId>` so the user can
 * take over a card's headless run interactively. Opt-in via
 * USM_AUTORUN_OPEN_TERMINAL=1 (default off — the primary affordance is copying
 * the command). The sessionId is validated as a UUID before use.
 */
export async function openTerminalForSessionAction(input: { sessionId: string }): Promise<Result> {
  await requireSession("openTerminalForSessionAction");
  try {
    if (process.env.USM_AUTORUN_OPEN_TERMINAL !== "1") {
      return {
        ok: false,
        error: "Abrir terminal está desligado. Defina USM_AUTORUN_OPEN_TERMINAL=1 (ou copie o comando).",
      };
    }
    const id = String(input.sessionId || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { ok: false, error: "sessionId inválido." };
    }
    const bin = resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
    const cwd = findRepoRoot();
    const resumeCmd = `${bin} --resume ${id}`;
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "", "cmd", "/k", resumeCmd], { cwd, detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("sh", ["-c", resumeCmd], { cwd, detached: true, stdio: "ignore" }).unref();
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// UUID v4-ish shape (what newRunSessionId produces) — validated before it touches a shell.
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R4 "Abrir terminal" for a headless run: materialize a tmux session named
 * `card-<board>__<cardId>` running `claude --resume <sessionId>` (so it's attachable in the
 * web terminal at /terminal?b=<session>) and return the session name. Idempotent — if the
 * session already exists it's reused (no second claude). On root+POSIX it injects IS_SANDBOX=1
 * so `--dangerously-skip-permissions` is accepted (same guard the autorun engine uses).
 */
export async function resumeRunInTerminalAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ tmuxSession: string }>> {
  await requireSession("resumeRunInTerminalAction");
  try {
    const { boardId, cardId } = input;
    const live = getRunnerRegistry().lastSessionId(boardId, cardId);
    const sessionId = live ?? (await getRunnerJournal().sessionFor(boardId, cardId));
    if (!sessionId) return { ok: false, error: "Esse card não tem sessão para retomar — rode-o primeiro." };
    if (!SESSION_UUID.test(sessionId)) return { ok: false, error: "sessionId inválido." };
    const tmuxSession = cardSessionName(boardId, cardId);
    if (!isSafeSessionName(tmuxSession)) return { ok: false, error: "board/card fora do charset de sessão." };
    const bin = resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
    const onRootPosix = process.platform !== "win32" && process.getuid?.() === 0;
    const prefix = onRootPosix ? "IS_SANDBOX=1 " : "";
    // `; exec bash` keeps the session (and its terminal) alive after the resumed agent exits.
    const cmd = `${prefix}${bin} --resume ${sessionId} --dangerously-skip-permissions; exec bash`;
    const res = await ensureDetachedSession(tmuxSession, cmd, findRepoRoot());
    if (!res.ok) return { ok: false, error: res.error ?? "falha ao abrir a sessão." };
    return { ok: true, data: { tmuxSession } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * R1 "Liberar/Matar run travado": force-release a card's in-flight run (kill a hung child or
 * cancel a queued one). The engine releases the in-flight lock so the next run for that card
 * isn't blocked. Returns a note when the run was only queued.
 */
export async function forceReleaseRunAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ note?: string }>> {
  await requireSession("forceReleaseRunAction");
  try {
    const res = await getRunnerEngine().forceRelease(input.boardId, input.cardId);
    if (!res.released) return { ok: false, error: res.note ?? "Nada para liberar neste card." };
    return { ok: true, data: { note: res.note } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * SM-2 merge train: the operator resolves a PAUSED (conflict) entry from the ops panel.
 * `merged` = they integrated it by hand in the shell (mark done, drop the branch); `aborted`
 * = drop it entirely (mark failed). Either way the queue resumes the entries behind it.
 */
export async function resolveMergeConflictAction(input: {
  runId: string;
  action: "merged" | "aborted";
}): Promise<Result> {
  await requireSession("resolveMergeConflictAction");
  try {
    const runId = String(input.runId || "").trim();
    if (!runId) return { ok: false, error: "runId ausente." };
    if (input.action !== "merged" && input.action !== "aborted") {
      return { ok: false, error: "ação inválida (use merged|aborted)." };
    }
    const { getMergeQueue } = await import("@/lib/storymap/runner/merge-queue");
    await getMergeQueue().resolveMergeConflict(runId, input.action, "operador (inbox)"); // WS-2.4: real actor
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Integration gate (story-1k7els): the operator resolves a PAUSED (`gate-failed`) entry from the ops
 * panel. `retry` = reset to `waiting` so the gate runs again (the companion run was re-driven / a
 * flake); `abort` = drop the branch and mark `failed`. Either way the queue resumes behind it.
 */
export async function resolveGateFailedAction(input: {
  runId: string;
  action: "retry" | "abort";
}): Promise<Result> {
  await requireSession("resolveGateFailedAction");
  try {
    const runId = String(input.runId || "").trim();
    if (!runId) return { ok: false, error: "runId ausente." };
    if (input.action !== "retry" && input.action !== "abort") {
      return { ok: false, error: "ação inválida (use retry|abort)." };
    }
    const { getMergeQueue } = await import("@/lib/storymap/runner/merge-queue");
    await getMergeQueue().resolveGateFailed(runId, input.action, "operador (inbox)"); // WS-2.4: real actor
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** R4 management: kill a tmux session by name. The never-kill decision is the fail-closed
 *  `assessKillLive` guard (lib/vps/kill-guard) — the SAME predicate the web terminal's DELETE route
 *  and the claude_kill MCP tool use, so a session protected in one place is protected everywhere
 *  (master/infra, live autorun run, a session hosting a live agent, a live fleet worktree). */
export async function killTmuxSessionAction(input: { session: string }): Promise<Result> {
  await requireSession("killTmuxSessionAction");
  try {
    const session = String(input.session || "").trim();
    if (!isSafeSessionName(session)) return { ok: false, error: "nome de sessão inválido." };
    const verdict = await assessKillLive(session);
    if (verdict.protected) {
      return { ok: false, error: `Sessão protegida — ${verdict.reason || "não pode ser encerrada por aqui."}` };
    }
    const res = await killSession(session);
    if (!res.ok) return { ok: false, error: res.error ?? "falha ao encerrar a sessão." };
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Resolve a card's most-recent run session id (for `claude --resume <id>`). Runs now
 * use a fresh id each time (so re-runs don't collide), so the registry — not a pure
 * function — is the source of truth. Returns null when the card hasn't run in this
 * dev-server lifetime (the console then prompts to run it first).
 */
export async function getCardSessionIdAction(input: {
  board: string;
  cardId: string;
}): Promise<Result<{ sessionId: string | null }>> {
  await requireSession("getCardSessionIdAction");
  try {
    // Live registry first; fall back to the durable journal so `claude --resume` still
    // resolves after a dev-server restart wiped the in-memory registry (recovery path).
    const live = getRunnerRegistry().lastSessionId(input.board, input.cardId);
    const sessionId = live ?? (await getRunnerJournal().sessionFor(input.board, input.cardId));
    return { ok: true, data: { sessionId: sessionId ?? null } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Batch-resolve EVERY card that currently has a resumable run session — the durable journal's
 * one-entry-per-card map (`board/cardId` → sessionId). The board reads this ONCE on mount so the
 * closed-card terminal icon can surface on a FINISHED card (or after a page reload) without an
 * N-card fetch storm: the journal is already in memory, so this is a cheap map, not 200 lookups.
 * Cards whose journal entry aged out past the retention cap simply drop off (no icon) — which
 * matches the "último run" promise (only recently-run cards are resumable).
 */
export async function listResumableSessionsAction(): Promise<Result<{ sessions: Record<string, string> }>> {
  await requireSession("listResumableSessionsAction");
  try {
    const entries = await getRunnerJournal().list();
    const sessions: Record<string, string> = {};
    for (const e of entries) {
      if (e.sessionId) sessions[`${e.board}/${e.cardId}`] = e.sessionId;
    }
    return { ok: true, data: { sessions } };
  } catch (e) {
    return fail(e);
  }
}

const execFileP = promisify(execFile);

/**
 * R4 management: kill a STRAY `claude` process by pid — the "externo" rows on /processes
 * (a claude started by hand over SSH, outside the runner). Guarded two ways: it refuses any
 * pid the box's `ps` doesn't currently report as a live `claude` process (so it can't kill an
 * arbitrary pid), and never the dev-server process itself.
 */
export async function killProcessAction(input: { pid: number }): Promise<Result<{ note: string }>> {
  await requireSession("killProcessAction");
  try {
    const pid = Number(input.pid);
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: "pid inválido." };
    if (pid === process.pid) return { ok: false, error: "não dá para encerrar o próprio servidor do AgileHarness." };
    const procs = await listClaudeProcesses();
    if (!procs.some((p) => p.pid === pid)) {
      return { ok: false, error: "esse pid não é um processo claude ativo (ou já encerrou)." };
    }
    if (process.platform === "win32") {
      await execFileP("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(pid, "SIGTERM");
    }
    return { ok: true, data: { note: `Processo ${pid} encerrado.` } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Card quick action "Diff +/−": the unified `git diff main...run/<sessionId>` for a card's
 * most-recent run, plus the +/− line totals. Resolves the run's branch from the live
 * registry (then the durable journal) exactly like getCardSessionIdAction. Returns a
 * friendly error when the card never ran here or its branch was already merged + removed.
 */
export async function getCardRunDiffAction(input: {
  board: string;
  cardId: string;
}): Promise<Result<{ diff: string; branch: string; additions: number; deletions: number }>> {
  await requireSession("getCardRunDiffAction");
  try {
    const cwd = findRepoRoot();
    const live = getRunnerRegistry().lastSessionId(input.board, input.cardId);
    const sessionId = live ?? (await getRunnerJournal().sessionFor(input.board, input.cardId));
    // A live run branch is the freshest source; when it's gone (no session resolvable,
    // or merged + deleted) fall through to the durable card-id commit-grep (SM-05).
    if (sessionId) {
      const branch = runBranchName(sessionId);
      try {
        await execFileP("git", ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], { cwd });
        // Anchor the diff at the run's integration base (its captured `stage` sha) when known, so the
        // unreleased code the run was cut from is excluded — showing ONLY this run's own work. Falls back
        // to `main...branch` for legacy/staging-off runs (no baseCommit on the queue entry). (stale-base fix)
        const { getMergeQueue } = await import("@/lib/storymap/runner/merge-queue");
        const baseCommit = getMergeQueue().getSnapshot().entries.find((e) => e.branch === branch)?.baseCommit;
        const range = baseCommit ? `${baseCommit}..${branch}` : `main...${branch}`;
        const { stdout } = await execFileP("git", ["diff", range], {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { ok: true, data: { diff: stdout, branch, ...parseDiffStat(stdout) } };
      } catch {
        // branch deleted — fall through to the grep fallback below.
      }
    }
    const runGit: GitRunner = async (args) =>
      (await execFileP("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
    const card = await readCard(input.board, input.cardId);
    // PREFERRED durable source: the review/QA-validated `commitRange`. The diffSnapshot
    // below is rewritten on EVERY merge-back, so a card that ran multiple times (implement →
    // review → qa, each merging separately) ends up with the LAST — often a trivial
    // status-transition — merge's range, masking the real implementation delta (story-sm-12:
    // a +54/−9 doc change displayed as +6/−1). commitRange pins the contiguous delta the
    // review stamped and never moves, so consult it first.
    const range = card?.commitRange;
    if (range?.base && range?.head) {
      try {
        const cr = await commitRangeDiff(runGit, range);
        if (cr.ok) {
          return { ok: true, data: { diff: cr.diff, branch: "(revisado)", ...parseDiffStat(cr.diff) } };
        }
      } catch {
        // invalid/unreachable SHAs — fall through to the snapshot below.
      }
    }
    // SM-04 fallback: the run branch is gone (merged + `branch -D`). Reconstruct the
    // EXACT diff the operator reviewed from the SHAs the merge train persisted on the
    // card right before deleting the branch: `git diff <base>..<mergeCommit>`. Preferred
    // over the grep range below — it pins the precise merge commit instead of scanning
    // commits by message convention.
    const snap = card?.diffSnapshot;
    if (snap?.base && snap?.mergeCommit) {
      try {
        const sn = await snapshotRangeDiff(runGit, snap);
        if (sn.ok) {
          return { ok: true, data: { diff: sn.diff, branch: "(mergeado)", ...parseDiffStat(sn.diff) } };
        }
      } catch {
        // invalid/unreachable SHAs — fall through to the grep range below.
      }
    }
    // SM-05 fallback: reconstruct the range from the `· <board>/<cardId>` commit
    // convention even for old cards that never ran in this dev-server lifetime.
    const fb = await grepCardCommitRangeDiff(runGit, input.board, input.cardId);
    if (!fb.ok) return { ok: false, error: fb.error };
    return {
      ok: true,
      data: { diff: fb.diff, branch: `grep:${input.cardId}`, ...parseDiffStat(fb.diff) },
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * The CUMULATIVE diff of a card — "todo o diff até a revisão". Because the split scatters a card's
 * changes (board → main, code → stage), this returns BOTH parts: `board` (narrative/acceptance/tasks/
 * plan, all its `· <board>/<cardId>` commits on main) + `code` (the product code, all its `código
 * staged` commits on `stage`). Each is null when absent (e.g. code not written yet). Reconstructed from
 * git history — no new storage. The card-diff modal renders it as a "Completo" mode beside the run diff.
 */
export async function getCardFullDiffAction(input: {
  board: string;
  cardId: string;
}): Promise<Result<{ board: CumulativeDiffPart | null; code: CumulativeDiffPart | null }>> {
  await requireSession("getCardFullDiffAction");
  try {
    const cwd = findRepoRoot();
    const runGit: GitRunner = async (args) =>
      (await execFileP("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
    return { ok: true, data: await cardCumulativeDiff(runGit, input.board, input.cardId) };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Light sibling of getCardRunDiffAction for the IDLE card footer (story-wdmio4): pulls JUST the
 * +/− totals (not the whole diff, which getCardRunDiffAction allows up to 10 MB — far too heavy
 * per card across a board). Sources, freshest first: (1) a still-existing run branch via
 * `--shortstat main...run/<id>`; then the DURABLE sources so a MERGED/settled card (branch gone)
 * still shows its +/− — (2) the review-pinned `commitRange`, (3) the merge train's `diffSnapshot`.
 * Returns `data: null` (clean footer) when none resolve. PERF GUARD: each durable source is gated
 * on its field EXISTING on the card, so NO git fires for a card that never ran/reached review/merged;
 * the grep-by-convention fallback is deliberately OMITTED here (it scans git for EVERY card on board
 * load) — it stays in the on-click modal (getCardRunDiffAction) only.
 */
export async function getCardRunDiffStatAction(input: {
  board: string;
  cardId: string;
}): Promise<Result<{ branch: string; additions: number; deletions: number } | null>> {
  await requireSession("getCardRunDiffStatAction");
  try {
    const cwd = findRepoRoot();
    const live = getRunnerRegistry().lastSessionId(input.board, input.cardId);
    const sessionId = live ?? (await getRunnerJournal().sessionFor(input.board, input.cardId));
    // (1) Freshest source: a still-existing run branch (live, or pre-merge). Probe it first so a
    // deleted/merged run falls through to the durable snapshots, not a git error.
    if (sessionId) {
      const branch = runBranchName(sessionId);
      try {
        await execFileP("git", ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], { cwd });
        // Anchor at the run's integration base (captured `stage` sha) when known — exclude the unreleased
        // stage code the run inherited, so the +/− reflects ONLY this run's work. Fallback `main...branch`. (stale-base fix)
        const { getMergeQueue } = await import("@/lib/storymap/runner/merge-queue");
        const baseCommit = getMergeQueue().getSnapshot().entries.find((e) => e.branch === branch)?.baseCommit;
        const range = baseCommit ? `${baseCommit}..${branch}` : `main...${branch}`;
        const { stdout } = await execFileP("git", ["diff", "--shortstat", range], { cwd });
        return { ok: true, data: { branch, ...parseShortstat(stdout) } };
      } catch {
        // branch gone — fall through to the durable snapshots below.
      }
    }
    // (2+3) Durable fallbacks so a MERGED/settled card still shows +/− (story-wdmio4) — gated on the
    // field EXISTING so NO git fires for cards that never reached review/merge (perf guard).
    const card = await readCard(input.board, input.cardId);
    const runGit: GitRunner = async (args) =>
      (await execFileP("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
    const range = card?.commitRange;
    if (range?.base && range?.head) {
      try {
        const cr = await commitRangeDiff(runGit, range);
        if (cr.ok) return { ok: true, data: { branch: "(revisado)", ...parseDiffStat(cr.diff) } };
      } catch {
        // unreachable SHAs — fall through.
      }
    }
    const snap = card?.diffSnapshot;
    if (snap?.base && snap?.mergeCommit) {
      try {
        const sn = await snapshotRangeDiff(runGit, snap);
        if (sn.ok) return { ok: true, data: { branch: "(mergeado)", ...parseDiffStat(sn.diff) } };
      } catch {
        // unreachable SHAs — fall through.
      }
    }
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Manually launch a card's column skill ("Rodar agora") — the on-demand counterpart
 * to autorun. Works regardless of the column's per-column `autorun` flag (that flag
 * only governs AUTO-triggering on entry); it still goes through the SAME engine, so
 * it shares the in-flight lock + concurrency cap, registers in the runner registry,
 * and streams to the live console exactly like an autorun run. Requires a column
 * with a `trigger` and the global master switch on (so USM_AUTORUN=0 is honored).
 */
export async function runCardSkillAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ trigger: string }>> {
  await requireSession("runCardSkillAction");
  try {
    if (!loadRunnerConfig().autorun.enabled) {
      return { ok: false, error: "Runner desligado (Config → autorun, ou USM_AUTORUN=0). Ligue para rodar." };
    }
    const [config, cards] = await Promise.all([
      readBoardConfig(input.boardId),
      readCards(input.boardId),
    ]);
    const card = cards.find((c) => c.id === input.cardId);
    if (!card || !card.status) return { ok: false, error: "Card sem status — mova-o para uma coluna primeiro." };
    const status = config.statuses.find((s) => s.id === card.status);
    if (!status?.trigger) {
      return { ok: false, error: "Esta coluna não tem skill associada (sem trigger), então não há o que rodar." };
    }
    // Reabertura R1: a reopened card (reopenPending + mode refine/fix) runs its DEDICATED skill even on a
    // manual launch — resolve the effective trigger so "Rodar agora" of a card reopened INTO this column
    // runs harness-fix/harness-refine (not the column's harness-do/harness-ux), which is the ONLY way to start it when the
    // destination is autorun:false. The reopen skill then clears reopenPending; running the raw column
    // trigger here would instead leave the flag armed (a later re-entry would re-fire the override).
    const effectiveTrigger = triggerForCard(card, status.trigger);
    const res = getRunnerEngine().runSkill(input.boardId, card.id, effectiveTrigger, status, {
      origin: "manual",
      headroomUrl: resolveHeadroomUrl(config, process.env),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: res.reason === "in-flight" ? "Esse card já está rodando." : res.detail,
      };
    }
    return { ok: true, data: { trigger: effectiveTrigger } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Sincronizar — reconcile ONE card with the live code (the per-card button). Unlike
 * `runCardSkillAction` (which runs the CURRENT COLUMN's skill, so it needs a column
 * with a trigger), this runs a FIXED skill (`harness-sync-card`) on the card REGARDLESS
 * of status — it works on any column, incl. cards with no column trigger and the
 * backbone (activity/step). The skill reviews the card against the real code, updates
 * its fields and repositions it by facts. Shares the SAME engine as autorun (in-flight
 * lock + concurrency cap + live console + `claude --resume`), and honors the same master
 * switch (USM_AUTORUN=0). The model/effort come from the synthetic SYNC_STATUS_DEF, so
 * the run is capable regardless of which column the card sits in.
 */
export async function syncCardAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ trigger: string }>> {
  await requireSession("syncCardAction");
  try {
    if (!loadRunnerConfig().autorun.enabled) {
      return { ok: false, error: "Runner desligado (Config → autorun, ou USM_AUTORUN=0). Ligue para sincronizar." };
    }
    const [card, config] = await Promise.all([
      readCards(input.boardId).then((cs) => cs.find((c) => c.id === input.cardId)),
      readBoardConfig(input.boardId).catch(() => null),
    ]);
    if (!card) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    const res = getRunnerEngine().runSkill(input.boardId, card.id, SYNC_TRIGGER, SYNC_STATUS_DEF, {
      origin: "manual",
      headroomUrl: resolveHeadroomUrl(config, process.env),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: res.reason === "in-flight" ? "Esse card já está rodando." : res.detail,
      };
    }
    return { ok: true, data: { trigger: SYNC_TRIGGER } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Set the PRIMARY design (Fase C, extended by Canvas v2): persist `chosenOptionId` in the sidecar
 * and mirror it onto the card as `wireframeChosen` (which the hasWireframe gate reads). Valid ids
 * are the union of legacy options and canvas SCREEN artifacts.
 */
export async function chooseWireframeAction(input: {
  boardId: string;
  cardId: string;
  optionId: string;
}): Promise<Result> {
  await requireSession("chooseWireframeAction");
  try {
    const outcome = await withKeyedLock(wireframeLockKey(input.boardId, input.cardId), async () => {
      const doc = await readWireframe(input.boardId, input.cardId);
      if (!doc) return "no-doc" as const;
      const validIds = [
        ...doc.options.map((o) => o.id),
        ...doc.artifacts.filter((a) => a.kind === "screen").map((a) => a.id),
      ];
      if (!validIds.includes(input.optionId)) return validIds;
      await writeWireframe(input.boardId, { ...doc, status: "chosen", chosenOptionId: input.optionId });
      return "ok" as const;
    });
    if (outcome === "no-doc") return { ok: false, error: "Sem wireframes para este card." };
    if (outcome !== "ok") {
      return { ok: false, error: `Opção/tela inexistente: "${input.optionId}". Válidas: ${outcome.join(", ") || "(nenhuma)"}.` };
    }
    // Mirror the pick onto the card (the hasWireframe gate reads it) under the card lock,
    // re-reading fresh so a concurrent harness-* write isn't clobbered.
    await updateCardOnDisk(input.boardId, input.cardId, (card) => ({
      ...card,
      wireframeChosen: input.optionId,
    }));
    revalidateBoard(input.boardId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Triage a code-review finding (Fase D): flip its status (e.g. open → fixed /
 * wontfix). Clearing every open `blocker` unblocks the hasNoBlockers gate.
 */
export async function updateFindingStatusAction(input: {
  boardId: string;
  cardId: string;
  findingId: string;
  status: FindingStatus;
  /** WS-2 (2.3) — quem triou: "human" (default, a UI do operador) ou "copilot" (o agente via a tool MCP
   *  triage_finding). Vira `statusBy`/`statusAt` no finding. Ao contrário do `answeredBy` (que omite o
   *  human), "human" É carimbado: statusBy ausente precisa continuar significando "nunca triado". */
  by?: string;
}): Promise<Result> {
  await requireSession("updateFindingStatusAction");
  try {
    const stamp = { by: input.by?.trim() || "human", at: today() };
    const updated = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (!card.findings.some((f) => f.id === input.findingId)) throw new Error("finding não encontrado");
      return {
        ...card,
        findings: card.findings.map((f) =>
          f.id === input.findingId ? { ...f, status: input.status, statusBy: stamp.by, statusAt: stamp.at } : f,
        ),
      };
    });
    if (!updated) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    // Fluidez do pipeline: um `blocker` aberto trava o gate `hasNoBlockers`, e triar NÃO troca o
    // status do card — então, sem re-pump, resolver o último blocker deixava o card ENCALHADO no
    // mesmo step (o Inbox esvazia, mas nada re-avalia a cascata: o autorun dispara na ENTRADA
    // de coluna, não na satisfação TARDIA do gate). O re-pump é CIRÚRGICO de propósito: só quando o
    // finding triado ERA um blocker que saiu de `open` E não sobrou nenhum blocker aberto — isto é,
    // exatamente no instante em que o gate passa a valer. Triagem de finding não-bloqueante (um
    // `medium` virando wontfix) NÃO re-dispara a skill da coluna: gerar run espúrio custa dinheiro e
    // refaz trabalho — foi esse excesso que a suíte pegou no answerQuestion (ver answer-autoadvance).
    const triaged = updated.findings?.find((f) => f.id === input.findingId);
    const clearedABlocker = triaged?.severity === "blocker" && input.status !== "open";
    const noOpenBlockersLeft = !(updated.findings ?? []).some((f) => f.severity === "blocker" && f.status === "open");
    if (clearedABlocker && noOpenBlockersLeft) {
      void evaluateAutorunOnEntry(input.boardId, input.cardId).catch((err) =>
        console.error("[updateFindingStatus] autorun re-pump falhou (não-fatal)", err),
      );
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * WS-3 §3.2 — read-only evidence for a failed deploy: the open `deploy-failure` finding
 * (title + detail — the detail ALREADY carries the logTail DECODIFIED, the webhook route
 * decodes it before writing the finding, see deploy-webhook/route.ts + deploy-revert.ts) plus
 * the tail (~16KB) of `storymap/.runner/self-deploy.log` (best-effort — ENOENT/any read
 * failure → null; a missing log never fails the whole read, same philosophy as
 * copilotItemContextAction in WS-1). STRICTLY read-only: no write, no revalidateBoard — the
 * finding is resolved EXCLUSIVELY by the settle webhook on success
 * (resolveDeployFailureFindingOnSuccess), never by this action or by the UI (see
 * DeployFailedRenderer's docstring: the Re-publicar button is the ONLY sanctioned exit).
 */
export async function getDeployFailureLogAction(input: {
  boardId: string;
  cardId: string;
}): Promise<
  Result<{
    findingTitle: string | null;
    findingDetail: string | null;
    deployFiredAt: string | null;
    /** tail of self-deploy.log (~16KB); null when the file is absent/unreadable. */
    selfDeployLogTail: string | null;
    /** pointer for the operator (and for a copiloto escalado reading it via Bash). */
    logPath: string;
  }>
> {
  await requireSession("getDeployFailureLogAction");
  try {
    if (!/^[a-z0-9-]{1,64}$/i.test(input.boardId)) return { ok: false, error: "boardId inválido." };
    const card = await readCard(input.boardId, input.cardId);
    if (!card) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    const finding = (card.findings ?? []).find((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open") ?? null;

    const logPath = join(runnerStateDir(), "self-deploy.log");
    let selfDeployLogTail: string | null = null;
    try {
      const raw = await readFile(logPath, "utf8");
      selfDeployLogTail = raw.length > 16_384 ? raw.slice(-16_384) : raw;
    } catch {
      selfDeployLogTail = null; // absent/unreadable — best-effort, never fails the action
    }

    return {
      ok: true,
      data: {
        findingTitle: finding?.title ?? null,
        findingDetail: finding?.detail ?? null,
        deployFiredAt: card.deployFiredAt ?? null,
        selfDeployLogTail,
        logPath,
      },
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Statuses where a human REVIEWS the QA outcome — the only columns where approving QA
 * makes sense. `qa-automatizado` (QA / Testes, where harness-qa runs) and `revisao` (Aprovar
 * entrega, gated by hasQaPassed). Stamping qaPassed:true on an earlier column (e.g. a card
 * still in `capturando`) would leave the spec inconsistent with the real pipeline, so
 * approveQaAction rejects it.
 */
const QA_APPROVAL_STATUSES = ["qa-automatizado", "revisao"] as const;

/**
 * First-class QA approval (Eixo 3.1): set qaPassed/qaRanAt/qaCommit on a card via the SAME
 * fresh-disk re-read lock as every other pipeline action, so the merge that preserves the
 * other pipeline-owned fields (mergeCardOnSave) never clobbers concurrent skill state. This
 * replaces hand-editing the card YAML (the gambiarra from the previous session): the MCP
 * approve_qa tool delegates here.
 *
 * Guarded: only a card in a human QA-review column (QA_APPROVAL_STATUSES) can be approved —
 * stamping qaPassed on an upstream/autorun column would drift the spec from the pipeline. It
 * does NOT advance the card (the human moves it past the hasQaPassed gate); it only records
 * the approval so that gate passes.
 */
export async function approveQaAction(input: {
  boardId: string;
  cardId: string;
  /** default true — set false to UNDO/revoke a prior approval. */
  qaPassed?: boolean;
  /** default today() — the date the QA was validated. */
  qaRanAt?: string | null;
  /** the commit/HEAD the QA validated (optional). */
  qaCommit?: string | null;
  /** "eu OLHEI a tela renderizada" — grava qaEvidence.visual, a prova que o gate cobra de um card cujo
   *  diff tocou superfície. Omitido ⇒ a evidência existente fica intacta. */
  visual?: boolean;
  /** optional note (not persisted on the card; surfaced in the result for the caller's log). */
  comment?: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("approveQaAction");
  try {
    const passed = input.qaPassed ?? true;
    const updated = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (!(QA_APPROVAL_STATUSES as readonly string[]).includes(card.status ?? "")) {
        throw new Error(
          `Só dá para aprovar QA num card em revisão humana (${QA_APPROVAL_STATUSES.join(" ou ")}); ` +
            `este está em "${card.status ?? "(sem status)"}". Avance o card até QA / Testes (ou rode a skill) antes de aprovar.`,
        );
      }
      return {
        ...card,
        qaPassed: passed,
        qaRanAt: input.qaRanAt !== undefined ? input.qaRanAt : today(),
        qaCommit: input.qaCommit !== undefined ? input.qaCommit : (card.qaCommit ?? null),
        // A saída HUMANA do gate de QA visual. Um card cujo diff tocou tela exige prova de que alguém
        // olhou; quando quem olhou foi o operador (e não o sweep headless), é AQUI que ele diz isso —
        // `visual: true` é uma afirmação assinada, não um flag de conveniência. Sem `visual` informado
        // a evidência anterior é preservada intacta: aprovar de novo não apaga o que o QA registrou.
        ...(input.visual !== undefined
          ? {
              qaEvidence: {
                ...(card.qaEvidence ?? {}),
                visual: input.visual,
                at: new Date().toISOString(),
                by: "human",
              },
            }
          : {}),
      };
    });
    if (!updated) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    return { ok: true, data: { card: updated } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Statuses where approving a REVIEW makes sense — the review column (harness-review runs here) plus the
 * downstream human-review columns (`qa-automatizado` / `revisao`), so a human can stamp the review
 * provenance at review time OR retroactively while reconciling a card that already advanced. Stamping
 * reviewedAt on an upstream/autorun column would drift the spec from the real pipeline, so
 * approveReviewAction rejects it. Mirrors QA_APPROVAL_STATUSES.
 */
const REVIEW_APPROVAL_STATUSES = ["revisar-codigo", "qa-automatizado", "revisao"] as const;

/**
 * First-class REVIEW approval (story-740c8g) — SYMMETRIC to approveQaAction. Sets reviewedAt/reviewCommit
 * (both PIPELINE_OWNED, so update_card rejects them) via the SAME fresh-disk re-read lock as every other
 * pipeline action, so a human who already reviewed the code rigorously can stamp the review PROVENANCE
 * instead of re-running harness-review ($2-5 + minutes) or hand-editing the YAML (the gambiarra approve_qa
 * eliminated for QA). UNLIKE approveQaAction it unblocks NO gate — there is no `hasReview` gate (the review
 * column's exit gate is hasNoBlockers, owned by triage_finding); it only records that a human reviewed.
 * Guarded to REVIEW_APPROVAL_STATUSES; does NOT advance the card (the human moves it forward).
 */
export async function approveReviewAction(input: {
  boardId: string;
  cardId: string;
  /** default true — set false to UNDO/revoke a prior review stamp (clears reviewedAt/reviewCommit). */
  reviewed?: boolean;
  /** default today() — the date the review was done. */
  reviewedAt?: string | null;
  /** the commit/HEAD the review covered (optional). */
  reviewCommit?: string | null;
  /** optional note (not persisted on the card; surfaced in the result for the caller's log). */
  comment?: string;
}): Promise<Result<{ card: Card }>> {
  await requireSession("approveReviewAction");
  try {
    const reviewed = input.reviewed ?? true;
    const updated = await updateCardOnDisk(input.boardId, input.cardId, (card) => {
      if (!(REVIEW_APPROVAL_STATUSES as readonly string[]).includes(card.status ?? "")) {
        throw new Error(
          `Só dá para aprovar a revisão de código num card em Revisão de código (${REVIEW_APPROVAL_STATUSES.join(" ou ")}); ` +
            `este está em "${card.status ?? "(sem status)"}". Avance o card até Revisão de código (ou rode a skill) antes de aprovar.`,
        );
      }
      return {
        ...card,
        reviewedAt: reviewed ? (input.reviewedAt !== undefined ? input.reviewedAt : today()) : null,
        reviewCommit: reviewed
          ? input.reviewCommit !== undefined
            ? input.reviewCommit
            : (card.reviewCommit ?? null)
          : null,
      };
    });
    if (!updated) return { ok: false, error: `card não encontrado: ${input.cardId}` };
    revalidateBoard(input.boardId);
    return { ok: true, data: { card: updated } };
  } catch (e) {
    return fail(e);
  }
}

/** Load the wireframe sidecar for a card (Fase C) — null when none exists. */
export async function getWireframeAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ doc: WireframeDoc | null }>> {
  await requireSession("getWireframeAction");
  try {
    return { ok: true, data: { doc: await readWireframe(input.boardId, input.cardId) } };
  } catch (e) {
    return fail(e);
  }
}

/** Load the technical-plan sidecar markdown for a card (Fase C) — null when none. */
export async function getPlanAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ markdown: string | null }>> {
  await requireSession("getPlanAction");
  try {
    return { ok: true, data: { markdown: await readPlan(input.boardId, input.cardId) } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Telemetry history of a card's runs (story-observabilidade-runs-telemetria) — the last N settled
 * runs with cost/turns/duration/outcome, most-recent first. Read-only; null-safe (empty on any error).
 */
export async function getCardRunHistoryAction(input: {
  boardId: string;
  cardId: string;
  limit?: number;
}): Promise<Result<{ runs: TelemetryRecord[] }>> {
  await requireSession("getCardRunHistoryAction");
  try {
    const runs = await getTelemetryStore().listByCard(input.boardId, input.cardId, input.limit ?? 20);
    return { ok: true, data: { runs } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * 6.3 — the card's durable status-transition ledger (the WS2 write-points read back): every from→to hop with
 * WHO caused it (a human move · the cascade · a run's advance · the merge verdict · a system deploy-revert) and
 * WHEN. Read-only, tolerant (empty on any error, or a legacy card with no ledger). Feeds the EXECUTION axis of
 * the step rollup (`visited`) + the card drawer's hop timeline — the auditable reader that closes the WS2 loop.
 */
export async function getCardTransitionsAction(input: {
  boardId: string;
  cardId: string;
}): Promise<Result<{ transitions: Transition[] }>> {
  await requireSession("getCardTransitionsAction");
  try {
    return { ok: true, data: { transitions: await readTransitions({ board: input.boardId, cardId: input.cardId }) } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Aggregated cost/turns metrics for a whole board (story-observabilidade-runs-telemetria) — per-card
 * rows sorted by total cost desc + the board-wide total. Drives the /board/[id]/metricas table.
 */
export async function getBoardMetricsAction(input: {
  boardId: string;
}): Promise<Result<{ summary: BoardMetricsSummary }>> {
  await requireSession("getBoardMetricsAction");
  try {
    const summary = await getTelemetryStore().boardSummary(input.boardId);
    return { ok: true, data: { summary } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Upsert a persona by id (create or replace). Returns the fresh config.
 *
 * ⚠️ As seis ações de vocabulário abaixo passam por `updateBoardConfigOnDisk` — leitura DENTRO do
 * lock. Elas liam fora dele, o que é lost-update clássico: com escritores humanos (um clique de cor,
 * um rename) as janelas nunca se cruzavam, mas um AGENTE emite vários `tool_use` numa mensagem só e
 * o cliente MCP os despacha em paralelo — sete escritas leram o mesmo snapshot e sobrou uma, todas
 * com `ok: true`. Não reintroduza o par `readBoardConfig` + `writeBoardConfig` aqui.
 */
export async function savePersonaAction(input: {
  boardId: string;
  persona: Persona;
}): Promise<Result<{ config: BoardConfig }>> {
  await requireSession("savePersonaAction");
  try {
    const next = await updateBoardConfigOnDisk(input.boardId, (config) => {
      const idx = config.personas.findIndex((p) => p.id === input.persona.id);
      const personas = [...config.personas];
      if (idx >= 0) personas[idx] = input.persona;
      else personas.push(input.persona);
      return { ...config, personas };
    });
    if (!next) return { ok: false, error: "Board não encontrado." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { config: next } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Patch SOME fields of an existing persona (the bench surface — the `prompt` via the AssistedEditor, or
 * name/color from the identity row). Re-reads the config FRESH and merges the patch so a concurrent
 * edit of a sibling field can't clobber the other (mirrors the updateCardOnDisk anti-clobber
 * discipline). `id` is never patched. Returns the fresh config.
 */
export async function patchPersonaAction(input: {
  boardId: string;
  personaId: string;
  patch: Partial<Persona>;
}): Promise<Result<{ config: BoardConfig }>> {
  await requireSession("patchPersonaAction");
  try {
    let missing = false;
    const next = await updateBoardConfigOnDisk(input.boardId, (config) => {
      const idx = config.personas.findIndex((p) => p.id === input.personaId);
      if (idx < 0) {
        missing = true;
        return null;
      }
      const personas = [...config.personas];
      personas[idx] = { ...personas[idx], ...input.patch, id: personas[idx].id };
      return { ...config, personas };
    });
    if (missing) return { ok: false, error: `Persona não encontrada: ${input.personaId}` };
    if (!next) return { ok: false, error: "Board não encontrado." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { config: next } };
  } catch (e) {
    return fail(e);
  }
}

/** Delete a persona and strip its id from every card that referenced it. M2 — SOFT: the removed object is captured
 *  in `.trash/` so restore_deleted can re-insert it (reversible 7 days). */
export async function deletePersonaAction(input: {
  boardId: string;
  personaId: string;
  by?: string;
  reason?: string;
}): Promise<Result<{ config: BoardConfig }>> {
  await requireSession("deletePersonaAction");
  try {
    // O objeto removido sai do `mutate` por closure: ele é o que vai para o `.trash/` (o undo de 7
    // dias), e lê-lo fora do lock seria ler uma versão que pode não ser a que saiu.
    let removed: Persona | undefined;
    const next = await updateBoardConfigOnDisk(input.boardId, (config) => {
      removed = config.personas.find((p) => p.id === input.personaId);
      return { ...config, personas: config.personas.filter((p) => p.id !== input.personaId) };
    });
    if (!next) return { ok: false, error: "Board não encontrado." };
    // Fora do lock de config de propósito: isto escreve CARDS, que têm o lock deles. Segurar os dois
    // ao mesmo tempo é a receita de deadlock entre dois escritores que os pegam em ordens opostas.
    const strippedRefs = await stripVocabFromCards(input.boardId, "personas", input.personaId);
    if (removed) {
      await writeTrashManifest(input.boardId, {
        kind: "persona",
        id: input.personaId,
        by: input.by ?? "human",
        at: new Date().toISOString(),
        reason: input.reason,
        object: removed,
        strippedRefs: strippedRefs.length ? strippedRefs : undefined,
      });
    }
    revalidateBoard(input.boardId);
    return { ok: true, data: { config: next } };
  } catch (e) {
    return fail(e);
  }
}

/** Upsert a system by id (create or replace). Returns the fresh config. */
export async function saveSystemAction(input: {
  boardId: string;
  system: SystemDef;
}): Promise<Result<{ config: BoardConfig }>> {
  await requireSession("saveSystemAction");
  try {
    const next = await updateBoardConfigOnDisk(input.boardId, (config) => {
      const idx = config.systems.findIndex((s) => s.id === input.system.id);
      const systems = [...config.systems];
      if (idx >= 0) systems[idx] = input.system;
      else systems.push(input.system);
      return { ...config, systems };
    });
    if (!next) return { ok: false, error: "Board não encontrado." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { config: next } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Patch SOME fields of an existing system (the bench surface — the `prompt` via the AssistedEditor, or
 * name/kind/color from the identity row). Re-reads FRESH and merges so a concurrent edit of a sibling
 * field can't clobber the other (mirrors patchPersonaAction). `id` is never patched.
 */
export async function patchSystemAction(input: {
  boardId: string;
  systemId: string;
  patch: Partial<SystemDef>;
}): Promise<Result<{ config: BoardConfig }>> {
  await requireSession("patchSystemAction");
  try {
    let missing = false;
    const next = await updateBoardConfigOnDisk(input.boardId, (config) => {
      const idx = config.systems.findIndex((s) => s.id === input.systemId);
      if (idx < 0) {
        missing = true;
        return null;
      }
      const systems = [...config.systems];
      systems[idx] = { ...systems[idx], ...input.patch, id: systems[idx].id };
      return { ...config, systems };
    });
    if (missing) return { ok: false, error: `Sistema não encontrado: ${input.systemId}` };
    if (!next) return { ok: false, error: "Board não encontrado." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { config: next } };
  } catch (e) {
    return fail(e);
  }
}

/** Delete a system and strip its id from every card that referenced it. M2 — SOFT: the removed object is captured
 *  in `.trash/` so restore_deleted can re-insert it (reversible 7 days). */
export async function deleteSystemAction(input: {
  boardId: string;
  systemId: string;
  by?: string;
  reason?: string;
}): Promise<Result<{ config: BoardConfig }>> {
  await requireSession("deleteSystemAction");
  try {
    let removed: SystemDef | undefined;
    const next = await updateBoardConfigOnDisk(input.boardId, (config) => {
      removed = config.systems.find((s) => s.id === input.systemId);
      return { ...config, systems: config.systems.filter((s) => s.id !== input.systemId) };
    });
    if (!next) return { ok: false, error: "Board não encontrado." };
    // Fora do lock de config — escreve CARDS, que têm o lock deles (ver deletePersonaAction).
    const strippedRefs = await stripVocabFromCards(input.boardId, "systems", input.systemId);
    if (removed) {
      await writeTrashManifest(input.boardId, {
        kind: "system",
        id: input.systemId,
        by: input.by ?? "human",
        at: new Date().toISOString(),
        reason: input.reason,
        object: removed,
        strippedRefs: strippedRefs.length ? strippedRefs : undefined,
      });
    }
    revalidateBoard(input.boardId);
    return { ok: true, data: { config: next } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * autonomo-liberdade-humana M2 — RESTORE a soft-deleted entry from the board's `.trash/`. Reverses delete_* within
 * the 7-day window: a card's `.md` moves back to `cards/`; a persona/system object is re-inserted into board.yaml.
 * It restores the ENTRY, not the topology — refs that were stripped on delete are recorded on the manifest but not
 * auto-re-linked (the operator/agent re-links deliberately). Fail-safe: unknown kind / missing manifest ⇒ error.
 */
export async function restoreDeletedAction(input: {
  boardId: string;
  kind: "card" | "persona" | "system";
  id: string;
}): Promise<Result> {
  await requireSession("restoreDeletedAction");
  try {
    const manifest = await readTrashManifest(input.boardId, input.kind, input.id);
    if (!manifest) return { ok: false, error: "Entrada não encontrada na lixeira (já restaurada ou expirada)." };

    if (input.kind === "card") {
      const r = await restoreCardFile(input.boardId, input.id);
      if (!r.ok) return { ok: false, error: r.error ?? "Falha ao restaurar o card." };
      revalidateBoard(input.boardId);
      return { ok: true };
    }

    // persona / system — re-insert the captured object into board.yaml (idempotent by id: replace if it exists).
    // Atômico como as delete_* que ele desfaz: um restore que lesse fora do lock reviveria a entidade
    // por cima de qualquer escrita concorrente (e o restore é tool de MCP, alcançável em paralelo).
    const obj = manifest.object as Persona | SystemDef | undefined;
    if (!obj || typeof obj !== "object") {
      return { ok: false, error: `Manifesto sem o objeto ${input.kind === "persona" ? "da persona" : "do sistema"}.` };
    }
    const restored = await updateBoardConfigOnDisk(input.boardId, (config) =>
      input.kind === "persona"
        ? { ...config, personas: [...config.personas.filter((p) => p.id !== input.id), obj as Persona] }
        : { ...config, systems: [...config.systems.filter((s) => s.id !== input.id), obj as SystemDef] },
    );
    if (!restored) return { ok: false, error: "Board não encontrado." };
    await removeTrashEntry(input.boardId, { kind: input.kind, id: input.id });
    revalidateBoard(input.boardId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** M2 — list what's currently in a board's trash (for the operator / restore_deleted discovery). */
export async function listTrashAction(input: { boardId: string }): Promise<Result<{ entries: TrashManifest[] }>> {
  await requireSession("listTrashAction");
  try {
    return { ok: true, data: { entries: await listTrashManifests(input.boardId) } };
  } catch (e) {
    return fail(e);
  }
}

// ── Governance (story-w9n03r) ─────────────────────────────────────────────────
// The three lifecycle actions for owner:human field proposals. The MCP surface
// (propose_change / list_pending_changes — see mcp/tools.ts) calls proposeChangeAction;
// the Inbox cockpit approve/reject buttons call the other two.

/**
 * Create a new GovernanceDraft — agents use this (via the MCP propose_change tool) to
 * propose changes to owner:human board fields without touching the canonical value.
 * `before` in each change MUST reflect the current canonical value at call time
 * (the MCP tool reads it before calling this action).
 */
export async function proposeChangeAction(input: {
  boardId: string;
  draftId?: string;
  reason: string;
  origin?: { skill?: string | null; cardId?: string | null } | null;
  changes: GovernanceChange[];
}): Promise<Result<{ draftId: string }>> {
  await requireSession("proposeChangeAction");
  try {
    if (!input.changes?.length) return { ok: false, error: "Uma proposta precisa de ao menos uma mudança." };
    const draftId = input.draftId?.trim() || crypto.randomUUID();
    const draft: GovernanceDraft = {
      id: draftId,
      board: input.boardId,
      status: "pending",
      reason: input.reason?.trim() || "",
      origin: input.origin ?? null,
      changes: input.changes,
      createdAt: new Date().toISOString().slice(0, 10),
      decidedAt: null,
    };
    await writeGovernanceDraft(input.boardId, draft);
    revalidateBoard(input.boardId);
    return { ok: true, data: { draftId } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Approve a governance draft — re-checks for conflict, then applies each change to the live
 * board config in order and marks the draft `approved`. If the canonical value changed since
 * the proposal was created (before ≠ canonical), approve REFUSES (returns an error) and writes
 * nothing — the operator must re-propose over the current value. No blind overwrite: this
 * preserves the AC1/AC3 invariant even under a propose↔approve race (decision q1=o1, 2026-06-16:
 * "recusar no conflito" over "avisar e sobrescrever"). Does not delete the draft (audit trail).
 */
export async function approveGovernanceDraftAction(input: {
  boardId: string;
  draftId: string;
  /** WHO approved it (autonomo-liberdade-humana M1). Default `"human"` (the UI/operator path). request_peer_review
   *  passes `"peer:<runId>"` after an INDEPENDENT reviewer approved — the proponent can never reach this action. */
  approvedBy?: string;
}): Promise<Result> {
  await requireSession("approveGovernanceDraftAction");
  try {
    const draft = await readGovernanceDraft(input.boardId, input.draftId);
    if (!draft) return { ok: false, error: "Proposta não encontrada." };
    if (draft.status !== "pending") return { ok: false, error: `Proposta já ${draft.status === "approved" ? "aprovada" : "rejeitada"}.` };

    const board = await readBoardConfig(input.boardId);

    // Conflict gate: if the canonical diverged from the proposal's `before` snapshot, refuse —
    // applying would clobber a newer human edit. Force a re-proposal instead of overwriting blind.
    const conflicts = governanceConflicts(draft, board);
    if (conflicts.length > 0) {
      return {
        ok: false,
        error: `O valor canônico mudou desde a proposta (${conflicts.join(", ")}). A proposta precisa ser refeita sobre o valor atual antes de aprovar.`,
      };
    }

    // ONDE cada mudança é canônica AGORA — a mesma pergunta que `loadDoc` responde ao LER. O PRD é
    // sempre documento; o canvas só depois de o `.md` existir (antes disso `loadDoc` projeta do
    // `board.yaml`, e o YAML É o canônico). Decidir isto aqui, e não por lista fixa, é o que impede
    // a aprovação de gravar num lugar que o leitor deixou de ler.
    const paraDoc: typeof draft.changes = [];
    const paraConfig: typeof draft.changes = [];
    for (const change of draft.changes) {
      ((await docIsCanonical(input.boardId, change.artifact)) ? paraDoc : paraConfig).push(change);
    }

    // O conflito do documento é sobre o texto em disco; o núcleo puro (que só enxerga `BoardConfig`)
    // não o alcança. Aqui, que tem I/O, ele é checado com a MESMA régua: o `before` da proposta
    // contra o que o documento diz AGORA.
    const docConflicts: string[] = [];
    for (const change of paraDoc) {
      const atual = await readGovernedValue(input.boardId, change.artifact, change.field, board);
      if (JSON.stringify(atual ?? "") !== JSON.stringify(change.before ?? "")) {
        docConflicts.push(change.label ?? `${change.artifact}${change.field ? `.${change.field}` : ""}`);
      }
    }
    if (docConflicts.length > 0) {
      return {
        ok: false,
        error: `O documento mudou desde a proposta (${docConflicts.join(", ")}). A proposta precisa ser refeita sobre o texto atual antes de aprovar.`,
      };
    }

    // Só o que é canônico no `board.yaml` passa pelo núcleo puro. (Ele também pula `prd` por conta
    // própria — defesa em profundidade: mesmo que a régua acima erre, o PRD nunca vira chave no YAML.)
    let config = board;
    for (const change of paraConfig) {
      config = applyGovernanceChange(config, change);
    }
    await writeBoardConfig(input.boardId, config);

    // O documento grava pelo MESMO chokepoint da tela (`writeSchemaDoc`, que revalida o esqueleto).
    // Se a gravação for recusada, a proposta NÃO é marcada como aprovada: um draft "aprovado" cujo
    // texto não aterrissou é a pior das saídas — reporta sucesso e não muda o que o leitor lê.
    for (const change of paraDoc) {
      const r = await applyGovernedChange(input.boardId, change.artifact, change.field, change.after, board);
      if (!r.ok) return { ok: false, error: r.error };
    }

    const decided: GovernanceDraft = {
      ...draft,
      status: "approved",
      decidedAt: new Date().toISOString().slice(0, 10),
      approvedBy: input.approvedBy ?? "human",
    };
    await writeGovernanceDraft(input.boardId, decided);
    revalidateBoard(input.boardId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Reject a governance draft — marks it `rejected` and leaves the canonical unchanged.
 * The draft is kept for audit trail; it disappears from the cockpit inbox because
 * cockpit-collect filters for `status: "pending"` only.
 */
export async function rejectGovernanceDraftAction(input: {
  boardId: string;
  draftId: string;
}): Promise<Result> {
  await requireSession("rejectGovernanceDraftAction");
  try {
    const draft = await readGovernanceDraft(input.boardId, input.draftId);
    if (!draft) return { ok: false, error: "Proposta não encontrada." };
    if (draft.status !== "pending") return { ok: false, error: `Proposta já ${draft.status === "approved" ? "aprovada" : "rejeitada"}.` };

    const decided: GovernanceDraft = {
      ...draft,
      status: "rejected",
      decidedAt: new Date().toISOString().slice(0, 10),
    };
    await writeGovernanceDraft(input.boardId, decided);
    revalidateBoard(input.boardId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── F5.4 — human decisions on the copiloto's ApprovalRequests (grant/deny a scoped agent's `ask` action) ──

/** Grant a pending ApprovalRequest (the human OKs the copiloto's action). The agent's re-try then consumes it. */
export async function approveActionRequestAction(input: { boardId: string; approvalId: string; note?: string }): Promise<Result> {
  await requireSession("approveActionRequestAction");
  try {
    const decided = await decideApprovalRequest(input.boardId, input.approvalId, "granted", "human", input.note);
    if (!decided) return { ok: false, error: "Pedido de aprovação não encontrado, já decidido, ou expirado." };
    revalidateBoard(input.boardId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Reject a pending ApprovalRequest — the copiloto's action is denied and never runs. */
export async function rejectActionRequestAction(input: { boardId: string; approvalId: string; note?: string }): Promise<Result> {
  await requireSession("rejectActionRequestAction");
  try {
    const decided = await decideApprovalRequest(input.boardId, input.approvalId, "rejected", "human", input.note);
    if (!decided) return { ok: false, error: "Pedido de aprovação não encontrado, já decidido, ou expirado." };
    revalidateBoard(input.boardId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Set (REPLACE) a card's typed links — the only CRUD for the link graph (e.g. a story→idea
 * `addresses` edge created OUTSIDE a capture, linking an EXISTING story to its pain). Validates every
 * link with validateLink against the resolved board (rejects unknown rel, missing target, or a from/to
 * that breaks the linkType's declared NodeKind ends), then writes via updateCardOnDisk (fresh re-read
 * under the per-card lock). Pure graph CRUD — links is an authoral field, NOT pipeline-owned.
 */
export async function setCardLinksAction(input: {
  boardId: string;
  cardId: string;
  links: CardLink[];
}): Promise<Result<{ card: Card }>> {
  await requireSession("setCardLinksAction");
  try {
    const board = await readBoardConfig(input.boardId);
    const cards = await readCards(input.boardId);
    if (!cards.some((c) => c.id === input.cardId)) return { ok: false, error: "Card não encontrado." };
    const ctx = makeCtx(board, cards);
    const links: CardLink[] = [];
    for (const raw of input.links) {
      const link: CardLink = { rel: String(raw.rel), to: String(raw.to) };
      const err = validateLink(input.cardId, link, board, ctx);
      if (err) return { ok: false, error: `Link inválido (${link.rel}→${link.to}): ${err}` };
      links.push(link);
    }
    const updated = await updateCardOnDisk(input.boardId, input.cardId, (fresh) => ({ ...fresh, links }));
    if (!updated) return { ok: false, error: "Card não encontrado." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { card: updated } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * WS4 — set a card's per-instance ROUTE (`routing`), the sanctioned HUMAN write path (the drawer editor +
 * the `set_card_route` MCP tool). `routing` is pipeline-owned (update_card rejects it), so this is the ONLY
 * way a human overrides it. SERVER-SIDE VALIDATION (the kernel guard is defense-in-depth, but reject early
 * with a clear reason): every requested skip must be a REAL step, must be DISPENSABLE, and can NEVER be
 * LOAD-BEARING (plano-tecnico/desenvolver/revisar-codigo/qa-*). A named `profile` must exist in the board's
 * routeProfiles. Stamps `decidedBy: "human"`. Empty skips + no caps/profile CLEARS the routing (back to the
 * rules). Returns a `note` (non-fatal) when skipping `priorizar` without a priorityCall — the card would
 * then fail-close at its priority gate; the human should set priority first (the writer coherence rule).
 */
export async function setCardRouteAction(input: {
  boardId: string;
  cardId: string;
  skips?: string[];
  profile?: string;
  modelCap?: ModelTier;
  effortCap?: EffortLevel;
  rationale?: string;
}): Promise<Result<{ card: Card; note?: string }>> {
  await requireSession("setCardRouteAction");
  try {
    const board = await readBoardConfig(input.boardId);
    if (input.profile && !board.routeProfiles?.[input.profile]) {
      return { ok: false, error: `Perfil de rota desconhecido: "${input.profile}".` };
    }
    // 4.2 — MATERIALIZE the profile: a profile is authoring sugar, but the runner reads
    // routing.skips/modelCap/effortCap DIRECTLY (config.ts) — a route stamped with only `profile` is INERT.
    // So union the profile's skips into the requested skips and default the caps from the profile when the
    // caller didn't override, THEN validate the merged set (a profile could name a now-load-bearing step).
    const prof = resolveRouteProfile(input.profile, board.routeProfiles);
    const skips = Array.from(
      new Set([...(input.skips ?? []), ...(prof?.skips ?? [])].map((s) => String(s).trim()).filter(Boolean)),
    );
    const skipErr = routeSkipsValidationError(skips, board.statuses);
    if (skipErr) return { ok: false, error: skipErr };
    const modelCap = input.modelCap ?? prof?.modelCap;
    const effortCap = input.effortCap ?? prof?.effortCap;
    const current = await readCard(input.boardId, input.cardId);
    if (!current) return { ok: false, error: "Card não encontrado." };
    // Writer coherence (non-fatal): skipping `priorizar` without an argued priority makes the card
    // fail-close at its priority gate — surface it so the human sets priority first (/harness-prioritize).
    const note =
      skips.includes("priorizar") && !current.priorityCall
        ? "Aviso: pulou 'priorizar' sem priorityCall — o card vai travar no gate de prioridade (fail-closed). Defina a prioridade antes (/harness-prioritize)."
        : undefined;
    // An empty route (no skips, no caps, no profile) CLEARS the override (routing = null → rules decide).
    const hasOverride = skips.length > 0 || !!input.profile || !!modelCap || !!effortCap;
    const routing: CardRouting | null = hasOverride
      ? {
          skips,
          decidedBy: "human",
          decidedAt: today(),
          ...(input.profile ? { profile: input.profile } : {}),
          ...(modelCap ? { modelCap } : {}),
          ...(effortCap ? { effortCap } : {}),
          ...(input.rationale && input.rationale.trim() ? { rationale: input.rationale.trim() } : {}),
        }
      : null;
    const updated = await updateCardOnDisk(input.boardId, input.cardId, (fresh) => ({ ...fresh, routing }));
    if (!updated) return { ok: false, error: "Card não encontrado." };
    revalidateBoard(input.boardId);
    return { ok: true, data: { card: updated, ...(note ? { note } : {}) } };
  } catch (e) {
    return fail(e);
  }
}

/** Remove a vocab id (persona/system) from every card that listed it. */
async function stripVocabFromCards(
  boardId: string,
  key: "personas" | "systems",
  id: string,
): Promise<string[]> {
  const cards = await readCards(boardId);
  const affected = cards.filter((c) => c[key].includes(id)).map((c) => c.id); // M2 — reported for the trash manifest
  await Promise.all(
    affected.map((cardId) =>
      // Re-read fresh + drop the id, so concurrent edits to other fields survive.
      updateCardOnDisk(boardId, cardId, (fresh) => {
        if (!fresh[key].includes(id)) return null;
        const kept = fresh[key].filter((x) => x !== id);
        return key === "personas" ? { ...fresh, personas: kept } : { ...fresh, systems: kept };
      }),
    ),
  );
  return affected;
}

/**
 * WS-5 — re-enfileira uma entry TERMINAL do merge train com a MESMA branch (terminal-retry do enqueueMerge).
 * Uma entry VIVA (waiting/merging/gate-running) tem os próprios caminhos e não passa por aqui. Branch
 * inexistente → erro apontando o caminho alternativo (▶ Rodar = branch nova). Não é irreversível: a entry
 * re-entra `waiting` e pode ser abortada de novo.
 *
 * autonomy-endgame WS-3.5 — `conflict` também é aceito. A restrição a `failed` deixava a ÚNICA ferramenta
 * manual de recuperação sem alcance justamente sobre o estado do incidente: a falha da metade de dados
 * parqueia em `conflict` (maybeRedrive esgotado ⇒ finalize "conflict"), não em `failed`. O operador via o
 * card encalhado, clicava, e a ferramenta respondia que aquilo não era com ela. `conflict` É terminal e
 * parqueado (não segura a fila), então re-enfileirar é exatamente a operação certa — e o `split` NÃO é
 * herdado (buildRequeueEntry o descarta de propósito: progresso é da TENTATIVA). O fato de o código já ter
 * aterrissado vem do RECIBO (WS-2), não do split herdado.
 */
export async function requeueMergeEntryAction(input: { runId: string }): Promise<Result<{ branch: string }>> {
  await requireSession("requeueMergeEntryAction");
  try {
    const runId = String(input.runId || "").trim();
    if (!/^[A-Za-z0-9-]+$/.test(runId)) return { ok: false, error: "runId inválido." };
    const { getMergeQueue } = await import("@/lib/storymap/runner/merge-queue");
    const queue = getMergeQueue();
    const entry = queue.getSnapshot().entries.find((e) => e.runId === runId);
    if (!entry) return { ok: false, error: `run ${runId} não está na fila de merge (histórico expirado).` };
    // `done` também é reenfileirável (isRequeueableStatus): um done pode MENTIR (falso-done 94bfdb77 —
    // ref renomeada sob a fila ⇒ diff vazio ⇒ "aterrissou vazio"), e reintegrar um done honesto é no-op
    // estrutural (applyPatch idempotente re-detecta as duas metades como landed).
    if (!isRequeueableStatus(entry.status)) {
      return { ok: false, error: `essa entry está '${entry.status}' — reenfileirar é só para 'failed'/'conflict'/'done'.` };
    }
    // Entry PARQUEADA-VIVA (`conflict`; `gate-failed` tem porta própria mas o retry cobre): a porta é
    // retryParkedEntry — reset in-place para `waiting` + pump. NUNCA enqueueMerge: `conflict` conta como
    // VIVA (isLive), então o re-insert era um NO-OP SILENCIOSO com `ok:true` — capacidade anunciada com
    // efeito zero (o requeue do flip de 21/07 "funcionou" e a entry seguiu parqueada com timestamps velhos).
    if (entry.status === "conflict") {
      const retried = await queue.retryParkedEntry(runId, "requeue (operador/agente)");
      if (!retried.ok) return { ok: false, error: retried.detail };
      revalidateBoard(entry.board);
      return { ok: true, data: { branch: entry.branch } };
    }
    // Resolve which branch still exists on disk (registered → preserved failed/ → original run/).
    let branch: string | null = null;
    for (const cand of requeueCandidates(entry)) {
      const probe = await defaultExec(`git rev-parse --verify --quiet ${JSON.stringify(`refs/heads/${cand}`)}`, {
        cwd: findRepoRoot(),
        timeout: 15_000,
      }).catch(() => null);
      if (probe) {
        branch = cand;
        break;
      }
    }
    if (!branch) {
      return {
        ok: false,
        error: `a branch do run ${runId} não existe mais — use ▶ Rodar (re-executa a skill e gera branch nova) ou escale ao Jido.`,
      };
    }
    await queue.enqueueMerge(buildRequeueEntry(entry, branch));
    revalidateBoard(entry.board);
    return { ok: true, data: { branch } };
  } catch (e) {
    return fail(e);
  }
}

// ── FROTA (WS-6.4) ─────────────────────────────────────────────────────────────────────────────────────────
// As três ações do fleet view em /processes. Matar já existe (killTmuxSessionAction — a sessão `agent-*` não é
// protegida); estas duas são as que faltavam.

/**
 * WS-6.3 — RECICLAR: troca o processo do agente mantendo árvore, branch, card e claim (a identidade lógica não
 * muda). A sessão nova é verificada ANTES de a antiga morrer, então uma falha aqui não deixa a árvore órfã.
 */
export async function recycleSessionAction(input: { sessionId: string }): Promise<
  Result<{ session: string; previous?: string | null; model?: string | null }>
> {
  await requireSession("recycleSessionAction");
  try {
    const res = await recycleSession(sessionSpawnDeps(), { sessionId: String(input.sessionId || "").trim() });
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, data: { session: res.tmuxSession, previous: res.previousTmux ?? null, model: res.route.model ?? null } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * WS-6.4 — LIBERAR o claim de um agente. ADVISORY por construção (claims.ts: uma reserva nunca é lock de
 * integridade): liberar não interrompe o trabalho da sessão, só devolve o CARD para a fila — e é por isso que
 * quem liberou fica anotado no ledger append-only (`human:<surface>`), não num campo do claim: um card que
 * "se soltou sozinho" enquanto um agente ainda o trabalha precisa ter um responsável rastreável.
 */
export async function releaseSessionClaimAction(input: {
  board: string;
  cardId: string;
  agentId: string;
  surface?: string;
}): Promise<Result<{ note: string }>> {
  await requireSession("releaseSessionClaimAction");
  try {
    const board = String(input.board || "").trim();
    const cardId = String(input.cardId || "").trim();
    const agentId = String(input.agentId || "").trim();
    if (!board || !cardId || !agentId) return { ok: false, error: "board, cardId e agentId são obrigatórios." };
    const actor = sessionClaimActor(agentId);
    await getCardClaims().release(board, cardId, actor, "released");
    // `.catch` no fire-and-forget: `logHumanActionAction` agora começa por `requireSession`, e uma
    // promise rejeitada sem handler DERRUBA o processo Node. O ledger é fail-open por desenho (uma
    // linha de auditoria perdida nunca pode quebrar o clique) — então a recusa morre aqui.
    void logHumanActionAction({
      surface: /^[a-z0-9-]{1,32}$/.test(input.surface ?? "") ? input.surface! : "processes",
      tool: "releaseSessionClaimAction",
      cls: "write-board",
      boardId: board,
      cardId,
      note: `claim de ${actor} liberado manualmente`,
    }).catch(() => {});
    revalidateBoard(board);
    return {
      ok: true,
      data: {
        note:
          `Claim de ${board}/${cardId} liberado (o agente ${agentId.slice(0, 8)} NÃO foi interrompido — a reserva é ` +
          `advisory). Quem liberou ficou registrado no ledger.`,
      },
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * DESCARTAR (esquecer) uma sessão da frota — o botão da lista "Encerrados" em /processes (e o "Limpar" em
 * lote). Passa pelo MESMO teardown fail-closed que o `worktree_discard` do MCP usa: um branch com commits
 * NÃO integrados é PRESERVADO como `failed/agent/<id>` (aparece em "Travados" como código a recuperar), só
 * a linha da frota some. Para uma sessão ADOTADA (sem árvore/branch) é só desregistro. O caller (a UI) só o
 * oferece para linhas comprovadamente MORTAS — mas o guard do teardown é a rede: uma sessão viva recusa.
 */
export async function discardSessionAction(input: { sessionId: string }): Promise<Result<{ detail: string }>> {
  await requireSession("discardSessionAction");
  try {
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) return { ok: false, error: "sessionId é obrigatório." };
    const res = await discardSessionWorktree(sessionSpawnDeps().worktree, { sessionId });
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, data: { detail: res.detail } };
  } catch (e) {
    return fail(e);
  }
}
