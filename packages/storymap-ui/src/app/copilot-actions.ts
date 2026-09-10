"use server";

// WS8 — the CONVERSATIONAL copiloto chat backend. copilotContextAction serializes ONE board's live state
// (the cockpit inbox + a per-column card summary + the open questions) into a text block the chat injects as
// `context` (data, not instruction) so the copiloto answers GROUNDED in reality — the actual conversation
// runs through the shared HITL backend (advanceHitlAction, purpose "copilot"). It also returns the open
// questions so the chat can surface them inline (you SEE its pending questions in the same thread).

import { requireSession } from "@/lib/auth/action-guard";
import { getBoard, listBoards, readBoardConfig, readCard } from "@/lib/storymap/repo";
import { openQuestions } from "@/lib/storymap/questions";
import { collectBoardCockpitItems } from "@/lib/storymap/cockpit-collect";
import { listApprovalRequests } from "@/lib/storymap/approvals";
import {
  applyLease,
  budgetOk,
  leaseHeldByHuman,
  leaseHeldByTick,
  readOrchestratorState,
  releaseLease,
  writeOrchestratorState,
} from "@/lib/storymap/runner/orchestrator-state";
import { rearmNoopItem } from "@/lib/storymap/runner/noop-rearm";
import { readClock } from "@/lib/storymap/runner/orchestrator-clock";
import {
  readCopilotChats,
  readCopilotSessionPointer,
  reconcileCopilotChats,
  resumeCopilotChat,
  startNewCopilotChat,
} from "@/lib/storymap/copilot/session-store";
import { locateTranscript, readTranscriptTitle } from "@/lib/storymap/copilot/transcript-history";
import { readCopilotActivity, type CopilotActivityEntry } from "@/lib/storymap/copilot/activity";
import { currentTerminalAttention } from "@/lib/terminal/attention-watch";
import { waitedFor } from "@/lib/terminal/attention";
import { WAKE_DEFAULTS } from "@/lib/storymap/runner/orchestrator-wake";
import { contextWindowForModel } from "@/lib/storymap/copilot/copilot-status";
import { boardScope, resolveCopilotModelEffort, viewScope } from "@/lib/storymap/copilot/agent-session";
import { readModelResolutions } from "@/lib/storymap/copilot/model-resolution";
import { chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import {
  loadRunnerConfig,
  readFileSettings,
  writeOrchestratorSettings,
  type OrchestratorSettingsPatch,
} from "@/lib/storymap/runner/config";
import { autonomousModeSafe, dispositionFor, lintRiskMatrix } from "@/lib/storymap/runner/orchestrator-policy";
import { RISK_CLASSES } from "@/lib/storymap/types";
import type { CardQuestion, OrchestratorMode, RiskClass, RiskDisposition, RunnerSettings } from "@/lib/storymap/types";
// WS-1 (copilot-actionability) — sources for the per-item escalation context aggregator (read-only).
import { evaluateGate } from "@/lib/storymap/gates";
import { getMergeQueue } from "@/lib/storymap/runner/merge-queue";
import { getRunnerJournal } from "@/lib/storymap/runner/journal";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { defaultPreservedBranchesDeps, listPreservedRunBranches } from "@/lib/storymap/runner/preserved-branches";
import { conflictedBranchFindingId, gateBlockerFindingId, mergeBackFailureFindingId, secretScanBlockerFindingId } from "@/lib/storymap/runner/findings";
import { listGovernanceDrafts } from "@/lib/storymap/sidecars";
import { DEPLOY_FAILURE_FINDING_ID } from "@/lib/storymap/demands";
import { RUN_DEATH_FINDING_ID } from "@/lib/storymap/runner/run-death";
import { buildItemContext, type ItemContextPieces } from "@/lib/storymap/copilot/item-context";
import { escalationInstructionFor, type EscalationRef } from "@/lib/storymap/copilot/escalation";

export interface CopilotApprovalRef {
  id: string;
  tool: string;
  riskClass: string;
  cardId?: string;
}

export interface CopilotBoardContext {
  /** the serialized board state the chat injects as `context`. */
  context: string;
  /** open agent questions across the board, so the chat can surface them inline. */
  openQuestions: { cardId: string; cardTitle: string; question: CardQuestion }[];
  /** F5.8 — pending ApprovalRequests the autonomous copiloto raised, so the operator can grant/deny inline. */
  pendingApprovals: CopilotApprovalRef[];
  /** how many items need the human right now (the cockpit count — shown on the topnav badge). */
  needsYouCount: number;
}

/** Gather + serialize ONE board's state for the copiloto chat. Read-only; never throws (fails to an empty
 *  context so the chat still opens). */
export async function copilotContextAction(boardId: string): Promise<CopilotBoardContext> {
  await requireSession("copilotContextAction");
  try {
    const board = await getBoard(boardId);
    if (!board) return { context: `Board "${boardId}" não encontrado.`, openQuestions: [], pendingApprovals: [], needsYouCount: 0 };
    const cockpit = await collectBoardCockpitItems(boardId).catch(() => []);
    // F5.8 — pending ApprovalRequests the autonomous copiloto raised → surfaced as inline grant/deny chips.
    const pendingApprovals: CopilotApprovalRef[] = (await listApprovalRequests(boardId).catch(() => []))
      .filter((a) => a.status === "pending")
      .map((a) => ({ id: a.id, tool: a.tool, riskClass: a.riskClass, cardId: a.cardId }));

    // per-column card counts + a few example titles (the copiloto's map of where work sits).
    const byStatus = new Map<string, { name: string; titles: string[]; count: number }>();
    const statusName = (id: string | null) => board.config.statuses.find((s) => s.id === id)?.name ?? id ?? "(sem status)";
    for (const c of board.cards) {
      if (c.type !== "story") continue;
      const key = c.status ?? "(sem status)";
      const e = byStatus.get(key) ?? { name: statusName(c.status), titles: [], count: 0 };
      e.count += 1;
      if (e.titles.length < 3) e.titles.push(`${c.id}: ${c.title}`);
      byStatus.set(key, e);
    }
    const columnLines = [...byStatus.values()]
      .sort((a, b) => b.count - a.count)
      .map((e) => `- ${e.name} (${e.count}): ${e.titles.join(" · ")}${e.count > 3 ? " · …" : ""}`);

    // open questions across the board.
    const oq: CopilotBoardContext["openQuestions"] = [];
    for (const c of board.cards) {
      for (const q of openQuestions(c)) oq.push({ cardId: c.id, cardTitle: c.title, question: q });
    }

    const cockpitLines = cockpit
      .slice(0, 15)
      .map((i: { title?: string; cardTitle?: string; kind?: string; type?: string }) => `- [${i.kind ?? i.type ?? "item"}] ${i.title ?? i.cardTitle ?? ""}`);

    // 3.5b — the chat and the autonomous TICK are the SAME copiloto to the operator, but the chat didn't know
    // the tick existed. Surface the board's mode + the last tick's outcome/reason + today's budget.
    const autonomousLines = await autonomousStateLines(boardId, board.config.orchestrator?.mode ?? "off");
    // Os TERMINAIS do operador. O Jido enxergava só o board — então um terminal parado num prompt há uma
    // hora era, para ele, um fato inexistente: perguntado "o que está acontecendo?", ele respondia sobre
    // cards e não mencionava a única coisa que estava travada. É leitura de memória (o vigia já mantém o
    // retrato), custo zero por turno.
    const terminalLines = terminalContextLines();

    const context = [
      `# Board: ${board.config.name} (${boardId})`,
      // 3.4 — carimbo de frescura: este contexto é RE-LIDO a cada turno, então o modelo sabe que reflete o
      // board AGORA (não um snapshot da abertura do chat).
      `_Estado lido em ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC — reflete o board AGORA._`,
      board.config.desiredOutcome ? `Resultado-alvo: ${board.config.desiredOutcome}` : "",
      "",
      `## Precisa de você agora (cockpit — ${cockpit.length} item${cockpit.length === 1 ? "" : "s"})`,
      cockpitLines.length ? cockpitLines.join("\n") : "(nada pendente)",
      "",
      "## Cards por coluna",
      columnLines.length ? columnLines.join("\n") : "(sem stories)",
      "",
      `## Perguntas em aberto (${oq.length})`,
      oq.length ? oq.map((x) => `- ${x.cardId}: ${x.question.text}`).join("\n") : "(nenhuma)",
      ...terminalLines,
      ...autonomousLines,
    ]
      .filter((l) => l !== "")
      .join("\n");

    return { context, openQuestions: oq, pendingApprovals, needsYouCount: cockpit.length };
  } catch (err) {
    return { context: `Falha ao ler o board: ${err instanceof Error ? err.message : String(err)}`, openQuestions: [], pendingApprovals: [], needsYouCount: 0 };
  }
}

/**
 * A seção "## Terminais" do contexto: quem está esperando o operador AGORA, e desde quando.
 *
 * O QUE ELA MUDA na conversa: o Jido deixa de ser cego para a superfície onde o operador realmente trava.
 * Ele NÃO ganha poder nenhum aqui — responder um prompt de terminal é `run-free`, humano em todo tier (e
 * `claude_send` nem está na matriz dele). O que ele ganha é a capacidade de DIZER: "antes de mais nada, o
 * terminal X está te esperando há 40min". Avisar é o ato; agir continua sendo seu.
 *
 * Leitura de memória (o retrato que o vigia mantém) — nenhum spawn, nenhuma captura de tela por turno.
 * Vazia quando não há ninguém esperando: uma seção "(nenhum)" a cada turno é contexto pago por nada.
 */
function terminalContextLines(now = Date.now()): string[] {
  const waiting = currentTerminalAttention();
  if (waiting.length === 0) return [];
  return [
    "",
    `## Terminais esperando o operador (${waiting.length})`,
    ...waiting.map((t) => {
      const what = t.kind === "asking" ? "parado num prompt" : "quieto (terminou ou espera instrução)";
      const q = t.question ? ` — “${t.question}”` : "";
      return `- ${t.label} (tmux ${t.session}): ${what} há ${waitedFor(t.since, now)}${q}`;
    }),
    "Você NÃO responde por eles (um prompt de terminal é humano em qualquer modo) — avise o operador.",
  ];
}

/** 3.5b — the "## Copiloto autônomo" section: the board's mode + the LAST tick's outcome/reason + today's
 *  budget, so the chat (the SAME copiloto persona) can answer "o que você fez hoje?". Empty when mode:off.
 *  Best-effort — never throws (the context still serializes without it). */
async function autonomousStateLines(boardId: string, mode: OrchestratorMode): Promise<string[]> {
  if (mode === "off") return [];
  try {
    const st = await readOrchestratorState(boardId);
    const orch = loadRunnerConfig().orchestrator;
    const last = st.lastTick;
    const budget = orch?.budget;
    const clock = readClock(boardId);
    const wake = clock.pendingWake;
    return [
      "",
      "## Copiloto autônomo",
      `Modo do board: ${mode}${orch?.enabled === true ? "" : " (o tick global está DESARMADO em settings)"}`,
      last
        ? `Último tick: ${last.at} — ${
            last.outcome === "ran"
              ? `rodou${last.costUSD ? ` (custou $${last.costUSD.toFixed(2)})` : ""}${last.summary ? `: ${last.summary}` : ""}`
              : `pulou (${last.reason ?? "sem motivo"})`
          }`
        : "Último tick: (ainda não rodou)",
      clock.nextTickAt ? `Próximo tick: ${new Date(clock.nextTickAt).toISOString()}` : "",
      wake ? `Wake agendado: ${wake.reason} (dispara em ${new Date(wake.dueAt).toISOString()})` : "",
      budget
        ? `Budget de hoje: ${st.budget.ticksToday}/${budget.maxTicksPerDay} ticks · $${st.budget.costToday.toFixed(2)}/$${budget.maxCostPerDay}`
        : "",
    ].filter((l) => l !== "");
  } catch {
    return [];
  }
}

// REMOVIDA: `copilotNeedsYouCountAction` — dizia ser "a contagem leve para o badge do topnav", mas o
// badge sempre leu `getBoardDemandsAction`, e ela chamava o MESMO `collectBoardCockpitItems` (uma
// varredura cara de telemetria + sidecars + cards). Era uma segunda porta para o mesmo dado, sem
// consumidor e com um comentário que afirmava ter um — a armadilha exata para o próximo que precisasse
// da contagem e chamasse a "versão barata", dobrando a varredura. Hoje a barra lê UMA vez
// (BoardHeader `useBoardDemands`) e serve o chip e a fala do Jido.

// ── O DIÁRIO de decisões do Jido autônomo (o que ele fez / decidiu NÃO fazer) ─────────────────

/**
 * As últimas decisões do Jido neste board — inclusive as de NÃO agir ("sem trabalho", "budget esgotado",
 * "você está no comando"). O chat mostra isto no corpo da conversa: uma decisão invisível fazia o Jido
 * parecer quebrado quando ele só estava sendo disciplinado. Read-only; nunca lança.
 */
export async function copilotActivityAction(boardId: string, limit = 30): Promise<CopilotActivityEntry[]> {
  await requireSession("copilotActivityAction");
  return readCopilotActivity(boardId, limit);
}

// ── O MEDIDOR da sessão do chat (ativa? há quanto tempo? quanto de contexto?) ─────────────────────

export interface CopilotSessionMeter {
  sessionId: string;
  /** ISO do primeiro turno desta sessão. */
  startedAt: string;
  /** ISO do último turno (a UI mostra "ociosa há X"). */
  lastTurnAt: string;
  turns: number;
  /** tamanho do contexto após o último turno. */
  contextTokens: number;
  /** a janela do MODELO que este chat roda — 1M só quando o operador pede a variante `[1m]`. Era chumbada em 200k. */
  contextWindow: number;
  costUSD: number;
}

/**
 * O estado da CONVERSA (não do board): existe sessão? de quando? quantos turnos, quanto de contexto e quanto
 * custou. É o que faltava p/ o operador decidir entre seguir, /compact ou limpar — antes o chat era uma caixa
 * preta e a única pista era ele ficar lento. Null quando nunca houve turno (conversa nova). Nunca lança.
 */
/**
 * "Nova conversa": FECHA a conversa do lado do SERVIDOR também. O reset do cliente limpa só o sessionStorage —
 * sem isto o medidor seguiria mostrando o contexto/custo da conversa anterior num chat recém-aberto.
 * A fechada NÃO se perde: ela fica no histórico do board, recuperável por {@link resumeCopilotChatAction}.
 */
export async function startNewCopilotChatAction(boardId: string, view?: string): Promise<void> {
  await requireSession("startNewCopilotChatAction");
  await startNewCopilotChat(chatScope(boardId, view));
}

/** A raia da conversa: sem `view`, o chat do board (o caminho de sempre). Ver copilot/chat-surfaces. */
function chatScope(boardId: string, view?: string): string {
  return view ? viewScope(boardId, view) : boardScope(boardId);
}

// ── O HISTÓRICO de conversas (uma aberta, as anteriores recuperáveis) ─────────────────────────────

/** Uma conversa na lista do cabeçalho: o que a torna reconhecível + o que a torna comparável. */
export interface CopilotChatRef {
  sessionId: string;
  /** a primeira fala do operador nela (null enquanto ela não tem fala humana). */
  title: string | null;
  /** ISO do último turno — a lista mostra "há 2h". */
  lastTurnAt: string;
  turns: number;
  costUSD: number;
  /** é a conversa ABERTA? (só uma é). */
  active: boolean;
}

/**
 * A lista de conversas do board — a aberta primeiro, depois as recuperáveis (MRU).
 *
 * Faz TRÊS coisas de manutenção, todas best-effort e todas numa passada só:
 *  1. RESOLVE o rótulo que falta (a 1ª fala do operador, lida do cabeçalho do transcript) e o CACHEIA no
 *     roster — a lista só paga essa leitura uma vez por conversa.
 *  2. ESQUECE o que não abre mais: transcript coletado pelo GC do CLI ⇒ a entrada sai da lista. Oferecer um
 *     item que abriria vazio é pior que não oferecer nada. Só o ponteiro é esquecido; arquivo nenhum é tocado.
 *  3. Nunca lança — a falta da lista não pode derrubar o chat (o cabeçalho só some com o botão).
 */
export async function copilotChatsAction(boardId: string, view?: string): Promise<CopilotChatRef[]> {
  await requireSession("copilotChatsAction");
  const scope = chatScope(boardId, view);
  try {
    const roster = await readCopilotChats(scope);
    if (!roster.chats.length) return [];
    // Em paralelo: o transcript ainda existe? e, se falta rótulo, qual é ele?
    const probed = await Promise.all(
      roster.chats.map(async (c) => ({
        chat: c,
        exists: Boolean(await locateTranscript(c.sessionId).catch(() => null)),
        title: c.title ?? (await readTranscriptTitle(c.sessionId).catch(() => null)),
      })),
    );
    await reconcileCopilotChats(scope, {
      gone: probed.filter((p) => !p.exists).map((p) => p.chat.sessionId),
      titles: probed
        .filter((p) => p.exists && p.title && p.title !== p.chat.title)
        .map((p) => ({ sessionId: p.chat.sessionId, title: p.title! })),
    });
    return probed
      .filter((p) => p.exists)
      .map(({ chat, title }) => ({
        sessionId: chat.sessionId,
        title: title ?? null,
        lastTurnAt: chat.lastTurnAt,
        turns: chat.turns,
        costUSD: chat.costUSD,
        active: chat.sessionId === roster.activeSessionId,
      }));
  } catch {
    return [];
  }
}

/**
 * RETOMA uma conversa do histórico: o board volta a apontar para ela e o painel re-hidrata do transcript dela.
 * Recusa uma sessão que não está no roster — a lista é a fronteira do que se pode reabrir, não o id digitado.
 */
export async function resumeCopilotChatAction(input: {
  boardId: string;
  sessionId: string;
  view?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireSession("resumeCopilotChatAction");
  try {
    const ok = await resumeCopilotChat(chatScope(input.boardId, input.view), input.sessionId);
    return ok ? { ok: true } : { ok: false, error: "Esta conversa não está mais no histórico desta tela." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function copilotSessionMeterAction(boardId: string, view?: string): Promise<CopilotSessionMeter | null> {
  await requireSession("copilotSessionMeterAction");
  try {
    const p = await readCopilotSessionPointer(chatScope(boardId, view));
    if (!p?.stats) return null;
    return {
      sessionId: p.sessionId,
      startedAt: p.stats.startedAt,
      lastTurnAt: p.stats.lastTurnAt,
      turns: p.stats.turns,
      contextTokens: p.stats.contextTokens,
      // a MESMA resolução de modelo que o spawn do turno usa — a barra mede contra a janela que o chat de fato tem.
      contextWindow: contextWindowForModel(resolveCopilotModelEffort().model),
      costUSD: p.stats.costUSD,
    };
  } catch {
    return null;
  }
}

// ── Fase 5.1 — the Copiloto config tab overview ──────────────────────────────────────────────────

export interface CopilotOrchestratorOverview {
  /** global runner settings (settings.yaml), with the ORIGIN of `enabled` (yaml vs the AGILEHARNESS_ORCH_ENABLED override). */
  settings: {
    enabled: { value: boolean; origin: "yaml" | "env-override" };
    tickMinutes: number;
    budget: { maxTicksPerDay: number; maxCostPerDay: number };
    notifyBudget: { maxPushesPerDay: number };
    /** wake por evento: o Jido acorda quando algo trava/cai no cockpit, sem esperar o tick. */
    wake: { enabled: boolean; debounceSeconds: number; cooldownMinutes: number };
  };
  /** this board's declared orchestrator mode (off/paired/autonomous). */
  boardMode: OrchestratorMode;
  /** the RESOLVED disposition per risk class (board matrix, kernel-clamped) — deploy/destructive can never be auto. */
  riskMatrix: Record<RiskClass, RiskDisposition>;
  /** lint warnings on the declared matrix (a deploy/destructive:auto reproves). */
  riskMatrixWarnings: string[];
  /** live per-board state from disk. */
  state: {
    /** o último tick: se rodou ou parou (e por quê), quanto CUSTOU e o RESUMO do que o Jido fez. */
    lastTick?: { at: string; outcome: "ran" | "skipped"; reason?: string; costUSD?: number; summary?: string };
    lastTickAt?: string;
    budget: { ticksToday: number; costToday: number; pushesToday: number };
    withinBudget: boolean;
    /** a paired human holds the lease → the autonomous tick stands down. */
    humanLeased: boolean;
    leaseOwner: "paired" | "tick" | null;
    /** um run do Jido está EM VOO agora (lease `tick` vivo). */
    running: boolean;
    /** WS-4.2: um ciclo AUTÔNOMO (tick) está rodando neste board AGORA — derivado do tickLease vivo,
     *  independente do pairedLease. O drawer mostra um aviso + botão de cancelar enquanto true, para o
     *  operador ver (e poder matar) um run que começou ANTES dele parear. (Mesma info de `running`, nomeada
     *  para o consumo do drawer — os dois slots agora são independentes.) */
    tickRunInFlight: boolean;
  };
  /** O RELÓGIO (in-process): quando cai o próximo tick e se há um wake por evento agendado. Ausente ⇒ o timer
   *  não está armado neste processo. Epoch ms — o cliente faz a contagem regressiva local. */
  clock: {
    nextTickAt?: number;
    intervalMs?: number;
    /** um evento (card travado, finding, item no cockpit) já agendou um wake p/ este board. */
    pendingWake?: { reason: string; dueAt: number };
  };
  /** Fase 6.5 — whether the server-side riskMatrix enforcement is actually wired. FALSE ⇒ the UI must BLOCK
   *  toggle→autonomous (the only containment would be the skill prompt). */
  enforcementShipped: boolean;
  /** Item 3 — the scoped orchestrator token (AGILEHARNESS_MCP_TOKEN_ORCH) is present on the service ⇒ the autonomous
   *  tick can actually SPAWN. FALSE ⇒ autonomous is INERT (spawnOrchestrator no-ops) — the UI says so honestly. */
  orchTokenPresent: boolean;
}

/**
 * Fase 5.1 — assemble the Copiloto tab's read model: effective global settings (with yaml-vs-env origin for
 * `enabled`), the board's declared mode + RESOLVED riskMatrix (+ lint warnings), the live tick/budget/lease
 * state, and the 6.5 enforcement-shipped signal that gates the autonomous toggle. Read-only; never throws.
 */
export async function orchestratorOverviewAction(boardId: string): Promise<CopilotOrchestratorOverview> {
  await requireSession("orchestratorOverviewAction");
  const eff = loadRunnerConfig().orchestrator!; // readFileSettings always populates orchestrator (coerce fills defaults)
  const file = readFileSettings().orchestrator!;
  // origin of `enabled`: AGILEHARNESS_ORCH_ENABLED (0/1) is applied in applyEnvOverrides but NOT listed by
  // activeEnvOverrides, so probe it directly. When set to 0/1 the effective value comes from the env, not yaml.
  const envFlag = process.env.AGILEHARNESS_ORCH_ENABLED;
  const enabledFromEnv = envFlag === "0" || envFlag === "1";

  const policy = (await readBoardConfig(boardId).catch(() => null))?.orchestrator ?? null;
  const now = Date.now();
  const state = await readOrchestratorState(boardId);

  const riskMatrix = Object.fromEntries(
    RISK_CLASSES.map((c) => [c, dispositionFor(policy, c)]),
  ) as Record<RiskClass, RiskDisposition>;

  const clock = readClock(boardId);

  return {
    settings: {
      enabled: { value: eff.enabled, origin: enabledFromEnv ? "env-override" : "yaml" },
      tickMinutes: eff.tickMinutes,
      budget: { maxTicksPerDay: eff.budget?.maxTicksPerDay ?? 0, maxCostPerDay: eff.budget?.maxCostPerDay ?? 0 },
      notifyBudget: { maxPushesPerDay: eff.notifyBudget?.maxPushesPerDay ?? 0 },
      wake: {
        enabled: eff.wake?.enabled ?? WAKE_DEFAULTS.enabled,
        debounceSeconds: eff.wake?.debounceSeconds ?? WAKE_DEFAULTS.debounceSeconds,
        cooldownMinutes: eff.wake?.cooldownMinutes ?? WAKE_DEFAULTS.cooldownMinutes,
      },
    },
    boardMode: policy?.mode ?? "off",
    riskMatrix,
    riskMatrixWarnings: lintRiskMatrix(policy),
    state: {
      lastTick: state.lastTick
        ? {
            at: state.lastTick.at,
            outcome: state.lastTick.outcome,
            reason: state.lastTick.reason,
            costUSD: state.lastTick.costUSD,
            summary: state.lastTick.summary,
          }
        : undefined,
      lastTickAt: state.lastTickAt,
      budget: { ticksToday: state.budget.ticksToday, costToday: state.budget.costToday, pushesToday: state.budget.pushesToday },
      withinBudget: budgetOk(state, eff, now),
      humanLeased: leaseHeldByHuman(state, now),
      // WS-4.1: derive the single-valued display owner from the two slots — a live paired human takes
      // precedence over a still-in-flight tick (both can be true at once now).
      leaseOwner: leaseHeldByHuman(state, now) ? "paired" : leaseHeldByTick(state, now) ? "tick" : null,
      running: leaseHeldByTick(state, now),
      tickRunInFlight: leaseHeldByTick(state, now),
    },
    clock: {
      nextTickAt: clock.nextTickAt,
      intervalMs: clock.intervalMs,
      ...(clock.pendingWake ? { pendingWake: { reason: clock.pendingWake.reason, dueAt: clock.pendingWake.dueAt } } : {}),
    },
    enforcementShipped: autonomousModeSafe(),
    orchTokenPresent: !!process.env.AGILEHARNESS_MCP_TOKEN_ORCH?.trim(),
  };
}

/**
 * F3.2 — the FULL RunnerSettings (raw file, sem env overrides) para o quick-settings gravar com SEGURANÇA.
 * `overview.settings` é uma PROJEÇÃO de 4 campos — dar spread dela em saveRunnerSettingsAction clobbaria
 * autorun/mergeGate/mcpTokens/scheduler. O popover SEMPRE parte deste objeto inteiro. Read-only; nunca lança.
 */
export async function getRunnerSettingsAction(): Promise<RunnerSettings> {
  await requireSession("getRunnerSettingsAction");
  return readFileSettings();
}

/**
 * O model/effort EFETIVOS do chat — o que o PRÓXIMO turno vai realmente rodar (a mesma resolução que o
 * spawn usa: request > settings > default do purpose). É o que o `/model` mostra como "atual"; ler o
 * arquivo cru mostraria o que está escrito, não o que vale.
 */
export async function copilotChatModelAction(input?: { view?: string }): Promise<{
  model: string;
  effort: string;
  /** apelido base (`opus`) → o id que o CLI resolveu da última vez (`claude-opus-5`). Ver model-resolution. */
  resolutions: Record<string, string>;
}> {
  await requireSession("copilotChatModelAction");
  // Uma conversa de TELA resolve o tier pelo PROPÓSITO dela (o Explorador é sonnet/medium), não pelo
  // `orchestrator.chat` — que `resolveCopilotModelEffort` só consulta para o `copilot`. Sem passar o propósito, o
  // `/model` de uma tela anunciaria como "atual" o modelo do Jido do board, que não é o que aquele turno roda.
  // Tela sem entrada no registro cai no default (`copilot`) — mesma régua fail-closed da rota do turno.
  const purposeId = input?.view ? (chatSurfaceFor(input.view)?.purposeId ?? "copilot") : "copilot";
  const { model, effort } = resolveCopilotModelEffort(undefined, undefined, purposeId);
  // A VERSÃO por trás do apelido. Não é config: é o que o CLI ANUNCIOU no init do último turno de cada
  // família (`opus` promete "o mais recente" — a tela precisa dizer QUAL é hoje, sem chumbar uma tabela
  // que envelhece no próximo lançamento).
  const table = await readModelResolutions().catch(() => ({}));
  const resolutions = Object.fromEntries(Object.entries(table).map(([k, v]) => [k, v.resolved]));
  return { model, effort, resolutions };
}

/**
 * TROCA o modelo/effort do chat — de verdade: grava em `settings.orchestrator.chat`, que é de onde o spawn
 * do próximo turno resolve. Mesmo destino que a engrenagem escreve (um escritor só; se um dia forem dois,
 * um deles vai apodrecer).
 *
 * Três cuidados que o corpo esconde:
 *  1. Escrita CIRÚRGICA (`writeOrchestratorSettings`): só as duas linhas mudam. O caminho normal
 *     (`yaml.dump` do objeto inteiro) apagaria os comentários do arquivo — medido, 60 linhas de
 *     documentação operacional por uma troca de modelo em dois toques.
 *  2. O que ele NÃO toca é o ponto: enabled/tickMinutes/budget/wake/riskMatrix atravessam intactos — um
 *     spread pela metade aqui desligaria o tick de quem só queria trocar de modelo.
 *  3. Devolve o valor RE-RESOLVIDO depois da escrita, não o que foi pedido: a coerção do settings pode
 *     rejeitar um valor fora do vocabulário, e o chat tem de ecoar a verdade, não o desejo.
 */
export async function setCopilotChatModelAction(input: {
  model?: string;
  effort?: string;
}): Promise<{ ok: true; model: string; effort: string } | { ok: false; error: string }> {
  await requireSession("setCopilotChatModelAction");
  try {
    const current = resolveCopilotModelEffort();
    await writeOrchestratorSettings({
      model: (input.model ?? current.model).trim(),
      effort: (input.effort ?? current.effort).trim(),
    });
    return { ok: true, ...resolveCopilotModelEffort() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * O SALVAR da engrenagem do chat — grava só os knobs que o popover edita, cirurgicamente.
 *
 * Ele substitui o caminho antigo (`getRunnerSettingsAction` → spread do RunnerSettings inteiro no cliente
 * → `saveRunnerSettingsAction` → `yaml.dump`), que tinha DOIS defeitos com a mesma raiz — mandar o arquivo
 * inteiro de ida e volta para trocar 7 campos:
 *  • APAGAVA OS COMENTÁRIOS do settings.yaml a cada salvamento (o `yaml.dump` não os carrega).
 *  • Era CLOBBER por construção: um campo que o servidor ganhasse enquanto o popover estava aberto
 *    (outra sessão, um deploy) sumia no spread da cópia velha que o cliente devolvia.
 * Com um patch parcial, os dois desaparecem: o que não está no patch não é tocado.
 *
 * Não valida vocabulário aqui — quem decide o que é aceitável é a coerção da LEITURA
 * (`coerceRunnerSettings`), fonte única; um segundo juízo aqui seria a segunda verdade.
 */
export async function saveOrchestratorSettingsAction(
  patch: OrchestratorSettingsPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireSession("saveOrchestratorSettingsAction");
  try {
    await writeOrchestratorSettings(patch);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The boards the operator can open a copiloto for (id + name), for a board switcher in the chat header. */
export async function copilotBoardsAction(): Promise<{ id: string; name: string }[]> {
  await requireSession("copilotBoardsAction");
  try {
    return (await listBoards()).map((b) => ({ id: b.id, name: b.name }));
  } catch {
    return [];
  }
}

// ── Fase 6.4 — the chat lease (paired human ↔ autonomous tick arbitration) ────────────────────────
// While the copiloto drawer is OPEN, the human holds the board's lease so the autonomous tick STANDS DOWN
// (runOrchestratorTick already checks leaseHeldByHuman — until now nothing ever acquired it). Acquire on open,
// renew each turn (copilotContextAction runs per turn), release on close. TTL-bounded so a crashed tab can't
// freeze the tick forever. All best-effort: a lease hiccup must never break the chat.
const COPILOT_LEASE_TTL_MS = 15 * 60_000;

/** Acquire/RENEW the paired-human lease for a board (called on chat open + every turn). Best-effort. */
export async function acquireCopilotLeaseAction(boardId: string): Promise<void> {
  await requireSession("acquireCopilotLeaseAction");
  try {
    const s = await readOrchestratorState(boardId);
    await writeOrchestratorState(boardId, applyLease(s, "paired", Date.now(), COPILOT_LEASE_TTL_MS));
  } catch {
    /* best-effort — the tick just doesn't stand down this window */
  }
}

/** Release the paired-human lease (called on chat close/unmount/board-switch) so the tick resumes. Best-effort.
 *  Only releases a lease the HUMAN holds — never yanks the tick's own lease. */
export async function releaseCopilotLeaseAction(boardId: string): Promise<void> {
  await requireSession("releaseCopilotLeaseAction");
  try {
    const s = await readOrchestratorState(boardId);
    if (s.pairedLease) await writeOrchestratorState(boardId, releaseLease(s)); // WS-4.1: release only the paired slot
  } catch {
    /* best-effort */
  }
}

/**
 * WS-12.3 (D16) — RE-ARM one item the autonomous copiloto gave up on (the chip's one click on Inbox). The
 * human's exit from the per-item backoff: it needs no justification (advisory by design — exit #3, the
 * steward's, is the one that must prove a change of fact). The copiloto's diary records who re-armed it, so the
 * next stand-down can't pretend it decided this on its own. Never throws — the chip degrades to an error toast.
 */
export async function rearmCopilotItemAction(input: { boardId: string; itemId: string }): Promise<{ ok: boolean; error?: string }> {
  await requireSession("rearmCopilotItemAction");
  try {
    const r = await rearmNoopItem({ board: input.boardId, itemId: input.itemId, by: "human" });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "falha ao re-armar o item" };
  }
}

// ── WS-1 (copilot-actionability) — per-item escalation context (D5) ───────────────────────────────
// A READ-ONLY aggregator: given the escalated item's ref, it gathers the MINIMAL evidence + pointers from the
// live sources (best-effort per source — a broken source degrades to a "Fontes indisponíveis" line, never a
// thrown escalation), serializes it via buildItemContext (which the client injects INSIDE <contexto>, D5/inv.7),
// and returns the template instruction enriched with real labels. Never writes; no revalidateBoard.

/** The repo's Result<T> is module-private (actions.ts) — the copiloto surface declares its own equivalent. */
type ItemContextResult = { ok: true; data: { context: string; instruction: string } } | { ok: false; error: string };

const ITEM_CTX_SLUG_RE = /^[a-z0-9-]{1,64}$/i;

/** The cardId a ref carries, or null for the card-less kinds (branch/process/approval/governance). */
function refCardId(ref: EscalationRef): string | null {
  switch (ref.kind) {
    case "card":
    case "question":
    case "finding":
    case "merge":
    case "run":
    case "deploy":
    case "move-blocked":
      return ref.cardId;
    default:
      return null;
  }
}

export async function copilotItemContextAction(input: { boardId: string; ref: EscalationRef }): Promise<ItemContextResult> {
  await requireSession("copilotItemContextAction");
  try {
    const { boardId, ref } = input;
    if (!ITEM_CTX_SLUG_RE.test(boardId)) return { ok: false, error: "boardId inválido" };

    const pieces: ItemContextPieces = { boardId, ref };
    const unavailable: string[] = [];
    const extra: Record<string, string> = {};
    // best-effort per source: a broken source records a line and returns null (fail-safe like copilotContextAction).
    const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (e) {
        unavailable.push(`${label} indisponível: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };

    const cardId = refCardId(ref);
    if (cardId) pieces.card = await safe("card", () => readCard(boardId, cardId));

    if (ref.kind === "merge") {
      const entry = await safe("merge-queue", async () => getMergeQueue().getSnapshot().entries.find((e) => e.runId === ref.runId) ?? null);
      pieces.mergeEntry = entry;
      if (!entry) unavailable.push(`run ${ref.runId} não encontrado na fila de merge (pode já ter sido resolvido)`);
      if (pieces.card) {
        const ids = new Set([
          gateBlockerFindingId(ref.runId),
          secretScanBlockerFindingId(ref.runId),
          conflictedBranchFindingId(ref.runId),
          mergeBackFailureFindingId(ref.runId),
        ]);
        pieces.findings = (pieces.card.findings ?? []).filter((f) => ids.has(f.id) && f.status === "open");
      }
    } else if (ref.kind === "run") {
      pieces.journal = await safe("journal", async () => {
        const all = await getRunnerJournal().list();
        return (
          all.find((j) => j.board === boardId && j.cardId === ref.cardId && (ref.runId ? j.sessionId === ref.runId : false)) ??
          all.find((j) => j.board === boardId && j.cardId === ref.cardId) ??
          null
        );
      });
      const failure = await safe("registry", async () => getRunnerRegistry().snapshot().failures.find((f) => f.board === boardId && f.cardId === ref.cardId) ?? null);
      if (failure) {
        pieces.failure = { reason: failure.reason, detail: failure.detail, at: failure.at };
        extra.reason = failure.reason;
      }
      if (pieces.card) {
        const death = (pieces.card.findings ?? []).find((f) => f.id === RUN_DEATH_FINDING_ID && f.status === "open");
        if (death) {
          pieces.findings = [death];
          if (death.failureClass) extra.failureClass = death.failureClass;
          if (!extra.reason && death.failureClass) extra.reason = death.failureClass;
        }
      }
    } else if (ref.kind === "deploy") {
      if (pieces.card) {
        const df = (pieces.card.findings ?? []).find((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open");
        pieces.findings = df ? [df] : [];
        if (pieces.card.deployFiredAt) extra.firedAt = pieces.card.deployFiredAt;
      }
    } else if (ref.kind === "branch") {
      const preserved = await safe("preserved-branches", async () => (await listPreservedRunBranches(defaultPreservedBranchesDeps())).find((b) => b.branch === ref.branch) ?? null);
      pieces.preserved = preserved;
      if (!preserved) unavailable.push(`branch ${ref.branch} não encontrada entre as preservadas`);
    } else if (ref.kind === "finding") {
      if (pieces.card) pieces.findings = (pieces.card.findings ?? []).filter((f) => f.id === ref.findingId);
    } else if (ref.kind === "process") {
      unavailable.push(`sessão ${ref.session}: inspecione via /processes ou claude_sessions (a evidência é o pane vivo)`);
    } else if (ref.kind === "governance") {
      const draft = await safe("governance", async () => (await listGovernanceDrafts(boardId)).find((d) => d.id === ref.draftId) ?? null);
      if (draft) extra.draftId = draft.id;
      else unavailable.push(`draft ${ref.draftId} não encontrado`);
    } else if (ref.kind === "approval") {
      const appr = await safe("approvals", async () => (await listApprovalRequests(boardId)).find((a) => a.id === ref.approvalId) ?? null);
      if (!appr) unavailable.push(`aprovação ${ref.approvalId} não encontrada`);
    } else if (ref.kind === "move-blocked" && pieces.card) {
      const config = await safe("board-config", () => readBoardConfig(boardId));
      if (config) {
        const verdict = evaluateGate(pieces.card, ref.target, config); // RE-derive the gate reason server-side (never in the URL)
        if (verdict) {
          extra.gate = verdict.gate;
          extra.gateLabel = verdict.label;
        }
      }
    }

    if (unavailable.length) pieces.unavailable = unavailable;
    return { ok: true, data: { context: buildItemContext(pieces), instruction: escalationInstructionFor(ref, extra) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
