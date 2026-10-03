// O VIGIA DE CARD PARADO (stall-watch.ts) ligado à produção. Resolvido por varredura: os fatos de BOARD (sessões,
// fila do condutor, pedidos de publicação, provas pendentes, disjuntor, reservas, merge train) são lidos uma vez por
// passada, não por card. Tudo aqui é chamado como o próprio serviço: o efeito de entrada roda direto
// (`runEntryEffect`), nunca por uma server action — a varredura pode correr dentro do contexto de um request alheio
// (a tool `claude_sessions` chama `reconcileFleetNow`), e uma action autentica quem chama pelo escopo ambiente.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { currentTerminalAttention } from "@/lib/terminal/attention-watch";
import { listPaneOwners, listProcesses, probeLiveTmuxSessions } from "@/lib/vps/tmux";
import { isClaudeProcess, type PaneOwner } from "@/lib/vps/process-attribution";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { CARD_STALLED_FINDING_ID } from "@/lib/storymap/demands";
import { makeDraftCard } from "@/lib/storymap/draft";
import { runnerStateDir } from "@/lib/storymap/paths";
import { republishRefusal } from "@/lib/storymap/preconditions";
import { listBoards, readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
import { cardOwnerClass } from "@/lib/storymap/decision-class";
import { isAutonomousDelivery } from "@/lib/storymap/delivery-audit";
import { isConducted } from "@/lib/storymap/driver";
import { OWNER_DECISION_STOP_REASON } from "@/lib/storymap/owner-waiting";
import { decideCascade } from "@/lib/notifications/server/channels/cascade-decision";
import type { Card } from "@/lib/storymap/types";
import { updateCardOnDisk, withCreateLock, writeCard } from "@/lib/storymap/write";
import { capturePane } from "@/lib/terminal/tmux";
import { getCardClaims } from "./claims";
import { conductorQuiet, paneHasLiveChildren, type ConductorQuiet, type PaneProc, type QuietIo } from "./conductor-quiet";
import { diskConductorQueueStore, isLiveConductor, isSlotWait } from "./conductor";
import { ladderGraceMs } from "./conductor-pause";
import { conductorTreeGone } from "./fleet-deps";
import { loadRunnerConfig } from "./config";
import { appendSystemDecision } from "./decision-log";
import { defaultDeployProofDeps } from "./deploy-proof-deps";
import { getRunnerEngine } from "./engine";
import { upsertFindingIfChanged } from "./findings";
import { getMergeQueue } from "./merge-queue";
import { isActiveMergeStatus } from "./merge-status";
import { getPendingSelfDeploy } from "./pending-self-deploy";
import { getProductDeploy, productDeployTargets } from "./product-deploy";
import { automationAdmission } from "./proxy-deps";
import { tryGetPublishBreaker } from "./publish-breaker";
import { listPublishRequests } from "./publish-queue";
import { publishLogTargets } from "./publish-status";
import { isSessionAlive } from "./session-liveness";
import { allSessions } from "./session-worktree";
import { readTransitions } from "./transitions";
import { isPassageStep, sweepStalledCards, type StallBoard, type StallFacts, type StallRow, type StallWatchDeps } from "./stall-watch";
import { boardGateNow } from "./board-pace-store";

export function stallLedgerPath(): string {
  return path.join(runnerStateDir(), "stall-watch.json");
}

const today = () => new Date().toISOString().slice(0, 10);

export function diskStallLedger(file: string = stallLedgerPath()): StallWatchDeps["ledger"] {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { rows?: unknown };
        const list = Array.isArray(parsed?.rows) ? parsed.rows : [];
        return list.filter((r): r is StallRow => !!r && typeof r === "object" && typeof (r as StallRow).key === "string" && typeof (r as StallRow).attempts === "number");
      } catch {
        return [];
      }
    },
    async persist(rows) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteFile(file, JSON.stringify({ v: 1, rows }, null, 2));
    },
  };
}

/** Quanto do fim do transcript basta para achar o último turno (o erro sintético e o `turn_duration` são linhas curtas). */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/** A tabela de processos + os panes, lidos no máximo a cada 5 s: um passe olha vários condutores de uma vez. */
const PROC_MEMO_MS = 5_000;
let procMemo: { at: number; value: Promise<{ panes: PaneOwner[]; procs: PaneProc[] }> } | null = null;
function paneProcessTable(now: number = Date.now()) {
  if (!procMemo || now - procMemo.at > PROC_MEMO_MS) {
    procMemo = {
      at: now,
      value: Promise.all([listPaneOwners(), listProcesses()]).then(([panes, rows]) => ({
        panes,
        procs: rows.map((r) => ({ pid: r.pid, ppid: r.ppid, claude: isClaudeProcess(r) })),
      })),
    };
  }
  return procMemo.value;
}

/** O IO de «condutor quieto»: o pane de agora, a última escrita do transcript, os filhos do claude e o último turno. */
export const QUIET_IO: QuietIo = {
  capture: (tmux) => capturePane(tmux, 40),
  mtimeMs: async (file) => {
    try {
      return (await fsp.stat(file)).mtimeMs;
    } catch {
      return null;
    }
  },
  busy: async (tmux) => {
    try {
      const { panes, procs } = await paneProcessTable();
      return paneHasLiveChildren(panes.filter((p) => p.session === tmux).map((p) => p.pid), procs);
    } catch {
      return null;
    }
  },
  tail: async (file) => {
    let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      handle = await fsp.open(file, "r");
      const { size } = await handle.stat();
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, size - len);
      return buf.subarray(0, bytesRead).toString("utf8");
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  },
};

/** A hora como o dono a lê («07h53»), no fuso que o settings declara para o governador (ausente ⇒ o do host). */
function clockOf(timeZone: string | undefined): (ms: number) => string {
  const fmt = (tz: string | undefined) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) });
  let f: Intl.DateTimeFormat;
  try {
    f = fmt(timeZone);
  } catch {
    f = fmt(undefined); // fuso inválido no settings não derruba o vigia
  }
  return (ms) => f.format(new Date(ms)).replace(":", "h");
}

/** Os fatos de board, lidos UMA vez por varredura. Cada leitura que falha vira o lado SEGURO (ninguém é julgado). */
async function boardWideFacts() {
  const now = Date.now();
  const [probe, sessions, queue, publishes, proofs, breaker, merge] = await Promise.all([
    probeLiveTmuxSessions().catch(() => ({ ok: false as const, reason: "sonda falhou" })),
    allSessions().catch(() => null),
    diskConductorQueueStore()
      .load()
      .catch(() => null),
    listPublishRequests().catch(() => null),
    defaultDeployProofDeps()
      .pending.load()
      .catch(() => null),
    tryGetPublishBreaker()
      ?.snapshot()
      .catch(() => null) ?? Promise.resolve([]),
    Promise.resolve()
      .then(() => getMergeQueue().getSnapshot().entries)
      .catch(() => null),
  ]);
  const attention = new Map(currentTerminalAttention().map((t) => [t.session, t]));
  return { now, liveTmux: probe.ok ? new Set(probe.names) : null, sessions, queue, publishes, proofs, breaker, merge, attention };
}

type BoardWide = Awaited<ReturnType<typeof boardWideFacts>>;

async function factsOf(wide: BoardWide, board: StallBoard, card: Card): Promise<StallFacts> {
  const mine = <T extends { board?: string; cardId?: string }>(list: readonly T[] | null) => (list ?? []).some((e) => e.board === board.id && e.cardId === card.id);
  // Uma leitura que falhou (null) conta como «tem alguém nele»: sem fato, o vigia não mexe.
  const unknown = wide.publishes === null || wide.proofs === null || wide.breaker === null || wide.merge === null;
  const claims = await getCardClaims()
    .list(board.id)
    .catch(() => null);
  let engineBusy = false;
  try {
    engineBusy = getRunnerEngine().isInFlight(board.id, card.id);
  } catch {
    engineBusy = true;
  }
  const mergeBusy = (wide.merge ?? []).some((e) => e.board === board.id && e.cardId === card.id && isActiveMergeStatus(e.status));
  // A reserva de um card CONDUZIDO é do próprio condutor (ele a segura enquanto vive): contá-la como «tem alguém»
  // esconderia justamente o condutor quieto. Nos outros passos uma reserva é uma sessão trabalhando no card.
  const inFlight = unknown || claims === null || engineBusy || mergeBusy || (!isConducted(card) && mine(claims));

  let deployRunning = false;
  try {
    const targets = publishLogTargets(card, board.config, productDeployTargets());
    if (targets.kind === "registry") deployRunning = targets.targets.some((t) => getProductDeploy().isRunning(t));
    // O self-deploy não tem registro em memória (ele reinicia o serviço): o que resta é o pedido pendente.
    else if (targets.kind === "self") deployRunning = (await getPendingSelfDeploy().peek()) != null;
  } catch {
    deployRunning = true;
  }

  const publishOpen = (wide.publishes ?? []).some((r) => r.board === board.id && (r.status === "waiting" || r.status === "publishing"));

  let conductor: StallFacts["conductor"] = null;
  if (wide.liveTmux && wide.sessions && wide.queue) {
    const session = wide.sessions.find((s) => s.board === board.id && s.cardId === card.id && isLiveConductor(s, wide.liveTmux, (x) => isSessionAlive(x, wide.now), conductorTreeGone));
    // A foto do vigia de terminais quando ela sabe; senão transcript + tela (conductor-quiet.ts) — o vigia olha no
    // máximo 12 sessões e, depois de um restart, só declara `idle` quem ele viu trabalhar.
    const quiet: ConductorQuiet = session ? await conductorQuiet(session, session.tmuxSession ? wide.attention.get(session.tmuxSession) : undefined, wide.now, QUIET_IO) : { quietForMs: null, asking: false };
    // A ESCADA do estacionar (conductor-pause.ts) age neste condutor quando o último turno morreu num erro de transporte
    // ou há fila esperando vaga no board: enquanto ela tem prazo, a quietude é tratada — o aviso só vem depois dela. O
    // filho vivo no pane NÃO cala o aviso (revisão do WP5-F2: o processo esquecido escondia o condutor para sempre); ele só
    // estende o prazo da escada pela janela dele — a mesma conta dela (`ladderGraceMs`).
    const slotWaiters = wide.queue.filter((e) => e.board === board.id && isSlotWait(e.lastWaitKind)).length;
    const ladderGrace = ladderGraceMs(loadRunnerConfig().autorun.park, { transportError: !!quiet.transportError, slotWaiters, childBusy: quiet.childBusy === true });
    conductor = {
      live: !!session,
      queued: mine(wide.queue),
      quietForMs: quiet.quietForMs,
      asking: quiet.asking,
      declaredWaiting: !!session?.progress?.waiting,
      ...(ladderGrace ? { ladderGraceMs: ladderGrace } : {}),
    };
  }

  // Passo de passagem: a cascata o segura por uma decisão humana? A MESMA conta de `evaluateAutorunOnEntry` (a
  // aprovação do dono vem do ledger de transições). Leitura que falha ⇒ «segura» (sem fato, o vigia não mexe).
  let ownerHeld = false;
  const def = board.config.statuses.find((s) => s.id === card.status);
  if (def && isPassageStep(def) && cardOwnerClass(card)) {
    const ownerApproved = await readTransitions({ board: board.id, cardId: card.id })
      .then((ts) => !isAutonomousDelivery(ts, board.config))
      .catch(() => false);
    const decision = decideCascade(card, board.config, { ownerApproved });
    ownerHeld = decision.action === "stop" && decision.reason.startsWith(OWNER_DECISION_STOP_REASON);
  }

  return { inFlight, deployRunning, publishOpen, proofPending: mine(wide.proofs), breakerHeld: mine(wide.breaker), ownerHeld, conductor };
}

export function defaultStallWatchDeps(): StallWatchDeps {
  let wide: Promise<BoardWide> | null = null;
  const settings = () => loadRunnerConfig();
  return {
    ledger: diskStallLedger(),
    masterEnabled: () => settings().autorun.enabled,
    settings: () => settings().autorun.stall,
    admission: automationAdmission,
    boards: async () => {
      const out: StallBoard[] = [];
      for (const b of await listBoards()) {
        // Um board ilegível, desarmado ou pausado fica de fora (as linhas dele no ledger são preservadas).
        const config = await readBoardConfig(b.id).catch(() => null);
        if (!config || boardGateNow(b.id, config).held) continue;
        const cards = await readCards(b.id).catch(() => null);
        if (cards) out.push({ id: b.id, config, cards });
      }
      return out;
    },
    facts: async (board, card) => factsOf(await (wide ??= boardWideFacts()), board, card),
    // O MESMO efeito do «Re-publicar», como o próprio serviço (ver o cabeçalho). O efeito relata a si mesmo: uma
    // recusa ou um erro deixa o finding `entry-effect-failed` no card — a partir daí ele tem explicação e item próprio.
    retry: async (board, cardId, effect) => {
      const [config, card] = await Promise.all([readBoardConfig(board), readCard(board, cardId)]);
      if (!card) return { ok: false, error: `card não encontrado: ${cardId}` };
      const refusal = republishRefusal(card, config);
      const declared = config.statuses.find((s) => s.id === card.status)?.onEnter;
      if (refusal || declared !== effect) return { ok: false, error: refusal ?? "o card já não está no passo que tinha o efeito" };
      const { runEntryEffect } = await import("./entry-effects");
      void runEntryEffect(effect, board, cardId).catch((err) => console.error(`[stall-watch retry ${effect} ${board}/${cardId}]`, err instanceof Error ? err.message : err));
      return { ok: true };
    },
    // O «refazer» de um passo de passagem: a MESMA avaliação que o evento de entrada dispara (com gates, a trava do
    // dono e o disjuntor de publicação) — se ela decidir parar, nada acontece e o vigia escala na próxima vez.
    reevaluate: async (board, cardId) => {
      const { evaluateAutorunOnEntry } = await import("@/lib/notifications/server/channels/autorun-eval");
      await evaluateAutorunOnEntry(board, cardId);
      return { ok: true };
    },
    // Card de conserto técnico na Triagem (o juiz o aceita), ligado ao card parado. Escrita pela lib, sob a mesma
    // trava de criação da action — sem depender de quem chamou.
    openFixCard: async (board, card, reason) =>
      withCreateLock(board, async () => {
        const [config, cards] = await Promise.all([readBoardConfig(board), readCards(board)]);
        const staging = config.statuses.find((s) => s.staging)?.id ?? null;
        if (!staging) return null; // sem coluna de entrada não há onde pousar um card sem âncora
        const serves = card.storyType == null || card.storyType === "user" ? card.id : (card.serves ?? card.parent ?? undefined);
        const draft = makeDraftCard({ type: "story", title: `Conserto: «${card.title}» parou sem ninguém cuidando`, status: staging, cards });
        const fix: Card = {
          ...draft,
          storyType: "technical",
          via: "triage",
          ...(serves ? { serves } : {}),
          links: [{ rel: "relates-to", to: card.id }],
          labels: ["card-travado"],
          body: [
            "## Um card parou num passo do sistema",
            "",
            `- Card: ${card.id} — ${card.title}`,
            `- O que aconteceu: ${reason}.`,
            "- O que se espera deste conserto: achar por que o passo não andou sozinho, corrigir a causa e levar o card parado adiante.",
            "- O dono não foi chamado: é trabalho técnico.",
          ].join("\n"),
        };
        await writeCard(board, fix);
        return fix.id;
      }),
    stamp: async (board, cardId, finding) => {
      await updateCardOnDisk(board, cardId, (fresh) => {
        const next = upsertFindingIfChanged(fresh.findings ?? [], finding);
        return next ? { ...fresh, findings: next } : null;
      });
    },
    clear: async (board, cardId) => {
      await updateCardOnDisk(board, cardId, (fresh) => {
        if (!fresh.findings?.some((f) => f.id === CARD_STALLED_FINDING_ID && f.status === "open")) return null;
        return {
          ...fresh,
          findings: fresh.findings.map((f) => (f.id === CARD_STALLED_FINDING_ID && f.status === "open" ? { ...f, status: "fixed" as const, statusBy: "system:voltou-a-andar", statusAt: today() } : f)),
        };
      });
    },
    record: appendSystemDecision,
    clock: clockOf(settings().governor?.timezone),
  };
}

/** A varredura do tick da frota. No máximo a cada 5 min: com o limite de 15, um card parado é refeito entre 15 e 20. */
export const STALL_WATCH_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
const LAST_SWEEP_KEY = Symbol.for("agileharness.stall-watch.lastSweep");
export async function maybeSweepStalledCards(now: number = Date.now()): Promise<unknown> {
  const store = globalThis as unknown as { [LAST_SWEEP_KEY]?: number };
  if (now - (store[LAST_SWEEP_KEY] ?? 0) < STALL_WATCH_SWEEP_MIN_INTERVAL_MS) return null;
  store[LAST_SWEEP_KEY] = now;
  return sweepStalledCards(defaultStallWatchDeps());
}
