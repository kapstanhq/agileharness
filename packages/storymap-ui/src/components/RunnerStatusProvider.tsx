"use client";

// RunnerStatusProvider — the client end of the runner bridge. One EventSource:
//   - `runner`     → the RunnerSnapshot (which cards are running / just failed)
//   - `runner-log` → coalesced console frames per card (Fase B live terminal)
// Keeps both in context so any card can render a live badge + open a read-only
// console, and (decision: resume via --session-id) hand off to a real terminal.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { sharedEventSource } from "@/lib/sse-bus";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  Lock,
  SquareTerminal,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  getCardFullDiffAction,
  getCardRunDiffAction,
  getCardSessionIdAction,
  listResumableSessionsAction,
  moveCardAction,
  openTerminalForSessionAction,
} from "@/app/actions";
import {
  resolveRunSubstate,
  type RunSubstate,
} from "@/lib/storymap/run-substate";
import { cardQuickActionVisibility } from "@/lib/storymap/card-preview";
import { capDiffLines } from "@/lib/storymap/runner/diff";
import type { LogFrame, MergeQueueSnapshot, RunnerLogBatch, RunnerSnapshot } from "@/lib/storymap/runner/types";
import type { CardClaim } from "@/lib/storymap/runner/claims";
import type { VpsMetrics } from "@/lib/vps/types";
import { isNearBottom, joinFramesText, shouldCloseOnBackdrop } from "@/lib/storymap/runner/console";
import { moveTargets } from "@/lib/storymap/move-targets";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { ConfirmDialog, MovePreview } from "./ConfirmDialog";
import type { AgentAlert, AgileHarnessEvent } from "@/lib/notifications/event";
import type { TerminalAttention } from "@/lib/terminal/attention";
import { EMPTY_CARD_LIVE_FEED, type CardLiveFeed } from "@/lib/storymap/card-live-status";
import { reduceAgentPresence, type AgentPresence } from "@/lib/storymap/agent-presence";
import { useToast } from "./Toast";

const EMPTY: RunnerSnapshot = { running: [], failures: [] };
const LOG_CAP = 500;
// Q8 — cap the NUMBER of card keys logsByKey retains (mirrors the server's 16-card log retention),
// so the map can't grow one key per card that ever ran. LRU-evicted on flush.
const LOG_KEY_CAP = 16;
// C1(b) — coalesce console frames: never rebuild logsByKey more than ~2x/s, so a run's ~5 frames/s
// collapse into one ref change instead of waking every logs consumer per frame.
const LOG_FLUSH_MS = 500;

interface RunnerCtx {
  snapshot: RunnerSnapshot;
  sessionByKey: Record<string, string>;
  /** Live VPS health (RAM/disk/load + Claude usage window) on the SHARED SSE connection. */
  metrics: VpsMetrics | null;
  /** SM-2 merge train state (entries + processing), or null until the first frame. */
  mergeQueue: MergeQueueSnapshot | null;
  /** WS-4.3 — the LIVE card claims (who holds which card), keyed `board/cardId`. */
  claimByKey: Record<string, CardClaim>;
  /** Os terminais que esperam o operador AGORA (o retrato do vigia, via SSE). Lista vazia = nenhum. */
  terminals: TerminalAttention[];
  /** Os fatos vivos da linha de estado do card (sessões + bloco, fila do condutor, limite de ações, juiz) — SSE `card-live`. */
  cardLive: CardLiveFeed;
  openConsole: (board: string, cardId: string) => void;
  /** Subscribe to board content events (card.*) on the SHARED SSE connection. */
  subscribeStorymap: (fn: (event: AgileHarnessEvent) => void) => () => void;
  /** Assina os AVISOS do agente (terminal esperando/quieto) na MESMA conexão SSE. */
  subscribeAlerts: (fn: (alert: AgentAlert) => void) => () => void;
}

const RunnerContext = createContext<RunnerCtx>({
  snapshot: EMPTY,
  sessionByKey: {},
  metrics: null,
  mergeQueue: null,
  claimByKey: {},
  terminals: [],
  cardLive: EMPTY_CARD_LIVE_FEED,
  openConsole: () => {},
  subscribeStorymap: () => () => {},
  subscribeAlerts: () => () => {},
});

const keyOf = (board: string, cardId: string) => `${board}/${cardId}`;

// C1(a) — logsByKey lives in a SEPARATE context from the main runner value. Console frames (~5x/s
// during a run) change it constantly; keeping it out of the main value means those frames no longer
// wake the card consumers (useRunSubstate & friends read RunnerContext only).
const RunnerLogsContext = createContext<Record<string, LogFrame[]>>({});

/**
 * A PRESENÇA dos agentes, calculada UMA vez para a página inteira — o «Agentes N» do nav, o «Mais» do celular e o pulso
 * do Kanban leem DAQUI. Cada um calculava a sua, com o seu relógio: na fronteira dos 2 min o nav e o pulso discordavam
 * por até meio minuto. Contexto próprio (como o dos logs) para o relógio de 30 s não acordar os cards do board.
 */
interface AgentPresenceCtx {
  presence: AgentPresence;
  /** o instante em que a presença foi medida — a âncora do «há N» de quem a desenha. */
  now: number;
}
const AgentPresenceContext = createContext<AgentPresenceCtx>({ presence: reduceAgentPresence({}, 0), now: 0 });

function AgentPresenceProvider({ feed, running, terminals, children }: { feed: CardLiveFeed; running: RunnerSnapshot["running"]; terminals: TerminalAttention[]; children: React.ReactNode }) {
  // o relógio só refaz a conta: um condutor que parou de escrever vira «parado» sem esperar o próximo quadro do SSE
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const value = useMemo<AgentPresenceCtx>(() => {
    const now = Date.now();
    return { presence: reduceAgentPresence({ feed, running, terminals }, now), now };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` é o gatilho do relógio
  }, [feed, running, terminals, tick]);
  return <AgentPresenceContext.Provider value={value}>{children}</AgentPresenceContext.Provider>;
}

/** A presença dos agentes da página (ver {@link AgentPresenceProvider}) — some com `agentPulse` para o número. */
export function useAgentPresence(): AgentPresenceCtx {
  return useContext(AgentPresenceContext);
}

export function RunnerStatusProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<RunnerSnapshot>(EMPTY);
  const [logsByKey, setLogsByKey] = useState<Record<string, LogFrame[]>>({});
  const [sessionByKey, setSessionByKey] = useState<Record<string, string>>({});
  const [metrics, setMetrics] = useState<VpsMetrics | null>(null);
  const [mergeQueue, setMergeQueue] = useState<MergeQueueSnapshot | null>(null);
  const [claimByKey, setClaimByKey] = useState<Record<string, CardClaim>>({});
  const [terminals, setTerminals] = useState<TerminalAttention[]>([]);
  const [cardLive, setCardLive] = useState<CardLiveFeed>(EMPTY_CARD_LIVE_FEED);
  const [consoleTarget, setConsoleTarget] = useState<{ board: string; cardId: string } | null>(null);
  // Last seen run start per card → detect a fresh run and drop its stale console.
  const startRef = useRef<Record<string, number>>({});
  // C1(b) — console frames buffered between flushes (keyed like logsByKey), the flush timer, and
  // the LRU order of keys (oldest→newest) for the Q8 key-count eviction.
  const pendingLogsRef = useRef<Record<string, LogFrame[]>>({});
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logLruRef = useRef<string[]>([]);
  // Board content (card.*) listeners — fed from the SAME SSE connection so we don't open
  // a second EventSource just for the NotificationCenter (one stream for the whole board).
  const storymapListeners = useRef(new Set<(event: AgileHarnessEvent) => void>());
  const subscribeStorymap = useCallback((fn: (event: AgileHarnessEvent) => void) => {
    storymapListeners.current.add(fn);
    return () => {
      storymapListeners.current.delete(fn);
    };
  }, []);
  // Os AVISOS (AgentAlert) andam pela MESMA conexão, com a mesma disciplina de fan-out local.
  const alertListeners = useRef(new Set<(alert: AgentAlert) => void>());
  const subscribeAlerts = useCallback((fn: (alert: AgentAlert) => void) => {
    alertListeners.current.add(fn);
    return () => {
      alertListeners.current.delete(fn);
    };
  }, []);

  useEffect(() => {
    const es = sharedEventSource("/api/notifications/stream");

    es.addEventListener("agileharness", (ev) => {
      let event: AgileHarnessEvent;
      try {
        event = JSON.parse((ev as MessageEvent).data) as AgileHarnessEvent;
      } catch {
        return;
      }
      for (const fn of storymapListeners.current) {
        try {
          fn(event);
        } catch {
          /* a listener throwing must not break the others */
        }
      }
    });

    es.addEventListener("runner", (ev) => {
      try {
        const snap = JSON.parse((ev as MessageEvent).data) as RunnerSnapshot;
        setSnapshot(snap);
        // Persist each running card's sessionId so resume survives the run ending.
        setSessionByKey((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const r of snap.running) {
            const k = keyOf(r.board, r.cardId);
            if (r.sessionId && next[k] !== r.sessionId) {
              next[k] = r.sessionId;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        // A fresh run on a card (startedAt changed) → drop its stale console. logSeq
        // is process-global, so a re-run's frames would otherwise stack onto the old
        // run over a live connection (a fresh page load is fine — replay has only the
        // new run, since registry.start cleared the server buffer).
        setLogsByKey((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const r of snap.running) {
            const k = keyOf(r.board, r.cardId);
            const prevStart = startRef.current[k];
            if (prevStart !== undefined && prevStart !== r.startedAt && next[k]) {
              delete next[k];
              // C1(b) — also drop any buffered frames for the stale run so the pending flush can't
              // resurrect the old console after we cleared it.
              delete pendingLogsRef.current[k];
              changed = true;
            }
            startRef.current[k] = r.startedAt;
          }
          return changed ? next : prev;
        });
      } catch {
        /* ignore malformed frame */
      }
    });

    // C1(b)/Q8 — drain the buffered frames into logsByKey at most ~2x/s. Seq-dedup + LOG_CAP per key
    // as before; plus LRU eviction of the NUMBER of keys (Q8). LRU bookkeeping runs OUTSIDE the state
    // updater (a ref mutation inside would double-run under StrictMode).
    const flushLogs = () => {
      flushTimerRef.current = null;
      const pending = pendingLogsRef.current;
      pendingLogsRef.current = {};
      const keys = Object.keys(pending);
      if (keys.length === 0) return;
      const lru = logLruRef.current;
      for (const k of keys) {
        const at = lru.indexOf(k);
        if (at >= 0) lru.splice(at, 1);
        lru.push(k); // a card that just got frames is the most-recently-used
      }
      const evict: string[] = [];
      while (lru.length > LOG_KEY_CAP) evict.push(lru.shift()!);
      setLogsByKey((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const k of keys) {
          const cur = next[k] ?? [];
          const lastSeq = cur.length ? cur[cur.length - 1].seq : 0;
          const fresh = pending[k].filter((f) => f.seq > lastSeq);
          if (!fresh.length) continue;
          const merged = cur.concat(fresh);
          next[k] = merged.length > LOG_CAP ? merged.slice(merged.length - LOG_CAP) : merged;
          changed = true;
        }
        for (const old of evict) {
          if (old in next) {
            delete next[old];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    es.addEventListener("runner-log", (ev) => {
      try {
        const batch = JSON.parse((ev as MessageEvent).data) as RunnerLogBatch;
        const k = keyOf(batch.board, batch.cardId);
        // Buffer the frames and schedule a flush — don't rebuild logsByKey per frame.
        const buf = pendingLogsRef.current;
        buf[k] = buf[k] ? buf[k].concat(batch.frames) : batch.frames;
        if (flushTimerRef.current == null) {
          flushTimerRef.current = setTimeout(flushLogs, LOG_FLUSH_MS);
        }
      } catch {
        /* ignore malformed frame */
      }
    });

    es.addEventListener("metrics", (ev) => {
      try {
        setMetrics(JSON.parse((ev as MessageEvent).data) as VpsMetrics);
      } catch {
        /* ignore malformed frame */
      }
    });

    es.addEventListener("merge-queue", (ev) => {
      try {
        setMergeQueue(JSON.parse((ev as MessageEvent).data) as MergeQueueSnapshot);
      } catch {
        /* ignore malformed frame */
      }
    });

    // WS-4.3 — the LIVE card reservations. Each frame is the WHOLE live set (authoritative), so it REPLACES
    // the map: a released claim simply stops arriving and its chip disappears — no per-card delete protocol.
    es.addEventListener("claims", (ev) => {
      try {
        const claims = JSON.parse((ev as MessageEvent).data) as CardClaim[];
        setClaimByKey(Object.fromEntries(claims.map((c) => [keyOf(c.board, c.cardId), c])));
      } catch {
        /* ignore malformed frame */
      }
    });

    // AVISOS do agente — repassados aos assinantes (o NotificationCenter os transforma em som /
    // notificação, sob a política do modo do Jido). O provider não decide efeito nenhum.
    es.addEventListener("alert", (ev) => {
      let alert: AgentAlert;
      try {
        alert = JSON.parse((ev as MessageEvent).data) as AgentAlert;
      } catch {
        return;
      }
      for (const fn of alertListeners.current) {
        try {
          fn(alert);
        } catch {
          /* um assinante que explode não derruba os outros */
        }
      }
    });

    // RETRATO dos terminais que esperam o operador. Cada quadro é a lista INTEIRA (autoritativa), então
    // ele SUBSTITUI o estado: um terminal que voltou a trabalhar simplesmente deixa de chegar.
    es.addEventListener("terminals", (ev) => {
      try {
        setTerminals(JSON.parse((ev as MessageEvent).data) as TerminalAttention[]);
      } catch {
        /* ignore malformed frame */
      }
    });

    // A linha de estado do card: quem está nele e em que bloco, a fila do condutor, o limite de ações, o juiz. Cada
    // quadro é o retrato INTEIRO (o servidor só manda quando muda), então ele substitui o estado.
    es.addEventListener("card-live", (ev) => {
      try {
        setCardLive(JSON.parse((ev as MessageEvent).data) as CardLiveFeed);
      } catch {
        /* ignore malformed frame */
      }
    });

    return () => {
      es.close();
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  // Durable seed for the closed-card terminal icon: the SSE only reports sessions for runs it
  // SAW go live on THIS connection, so a finished card (or a fresh page load) would carry no
  // icon. Read the journal's one-entry-per-card session map ONCE on mount and fill the gaps —
  // a live SSE value (prev) always wins on conflict. A single batch action (the journal is
  // already in memory), NOT an N-card fetch, so it stays cheap on a board with hundreds of cards.
  useEffect(() => {
    let alive = true;
    listResumableSessionsAction().then((r) => {
      if (!alive || !r.ok || !r.data) return;
      const { sessions } = r.data;
      setSessionByKey((prev) => ({ ...sessions, ...prev }));
    });
    return () => {
      alive = false;
    };
  }, []);

  const openConsole = useCallback((board: string, cardId: string) => setConsoleTarget({ board, cardId }), []);

  const value = useMemo<RunnerCtx>(
    () => ({
      snapshot,
      sessionByKey,
      metrics,
      mergeQueue,
      claimByKey,
      terminals,
      cardLive,
      openConsole,
      subscribeStorymap,
      subscribeAlerts,
    }),
    [snapshot, sessionByKey, metrics, mergeQueue, claimByKey, terminals, cardLive, openConsole, subscribeStorymap, subscribeAlerts],
  );

  return (
    <RunnerContext.Provider value={value}>
      <RunnerLogsContext.Provider value={logsByKey}>
        <AgentPresenceProvider feed={cardLive} running={snapshot.running} terminals={terminals}>
          {children}
          {consoleTarget && (
            <CardConsoleModal
              board={consoleTarget.board}
              cardId={consoleTarget.cardId}
              onClose={() => setConsoleTarget(null)}
            />
          )}
        </AgentPresenceProvider>
      </RunnerLogsContext.Provider>
    </RunnerContext.Provider>
  );
}

function useRunner() {
  return useContext(RunnerContext);
}

/** C1(a) — the logs map, from its own low-frequency context (console frames don't wake card consumers). */
function useRunnerLogs(): Record<string, LogFrame[]> {
  return useContext(RunnerLogsContext);
}

/** Whether this card has a reachable run session (live or journal-seeded) — a cheap boolean read used
 *  to GATE the idle-diff POST (Q7): a card that never ran here fires no request. */
export function useCardHasSession(boardId: string, cardId: string): boolean {
  return !!useContext(RunnerContext).sessionByKey[keyOf(boardId, cardId)];
}

/**
 * Live runner status for chrome that FOLDS the runner into another menu (the
 * header overflow ⋯): exposes the raw running/failure lists so the host can
 * render its own status dot, plus `openConsole` to wire row clicks.
 */
export function useRunnerSnapshot(): {
  running: RunnerSnapshot["running"];
  failures: RunnerSnapshot["failures"];
  openConsole: (board: string, cardId: string) => void;
} {
  const { snapshot, openConsole } = useRunner();
  return { running: snapshot.running, failures: snapshot.failures, openConsole };
}

/**
 * Subscribe a handler to board content events (card.*) on the SHARED SSE connection
 * (no second EventSource). Re-subscribes only when the provider's subscribe fn changes;
 * the latest handler is kept in a ref so callers needn't memoize it.
 */
/** Live VPS health (RAM/disk/load + Claude usage window), or null until the first frame. */
export function useVpsMetrics(): VpsMetrics | null {
  return useContext(RunnerContext).metrics;
}

/** Live SM-2 merge train state (entries + processing), or null until the first frame. */
export function useMergeQueue(): MergeQueueSnapshot | null {
  return useContext(RunnerContext).mergeQueue;
}

/**
 * As fontes vivas da LINHA DE ESTADO do card (card-live-status.ts), todas do MESMO SSE: execuções, falhas, o train, o
 * feed `card-live`, os terminais que esperam o operador e se o card tem sessão de execução no diário.
 */
export function useCardLiveSources() {
  const { snapshot, mergeQueue, cardLive, terminals, sessionByKey } = useRunner();
  return { snapshot, mergeQueue, cardLive, terminals, sessionByKey };
}

/** WS-4.3 — the live claim on ONE card (who holds it), or null when nobody does. */
export function useCardClaim(boardId: string, cardId: string): CardClaim | null {
  return useContext(RunnerContext).claimByKey[keyOf(boardId, cardId)] ?? null;
}

/** How a claim's actor reads on the card: "session:a1b2c3d4…" is noise — "sessão", "run", "copiloto" is signal. */
function claimActorLabel(actor: string): string {
  if (actor.startsWith("run:")) return "run";
  if (actor.startsWith("session:")) return "sessão";
  if (actor.startsWith("copilot:")) return "Jido";
  if (actor.startsWith("human:")) return "humano";
  return actor.split(":")[0] || actor;
}

const CLAIM_KIND_LABEL: Record<CardClaim["kind"], string> = {
  implement: "implementando",
  review: "revisando",
  qa: "testando",
  triage: "triando",
  steward: "destravando",
};

/**
 * WS-4.3 — the CLAIM chip: "who is on this card, for what, for how long". Live state (SSE), so it lives here
 * beside the other live-state pieces rather than in CardBadges (which renders CARD fields) — a claim is deliberately NOT
 * a card field: it's ephemeral operational state, and putting it on the .md would freeze goldens.
 *
 * ADVISORY for the human, always: the chip INFORMS, it never disables the card, the drag, or any action. The
 * enforcement is only against agents (they get a refusal with the holder); a human who wants the card takes it.
 * Renders nothing when the card is free — a calm board shows no chips.
 */
export function CardClaimChip({ boardId, cardId }: { boardId: string; cardId: string }) {
  const claim = useCardClaim(boardId, cardId);
  // Re-render on a slow tick so the age stays honest without a frame per second (the chip is per-card, on a
  // board with hundreds of cards — a 1s timer each would be real waste for a minute-scale number).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!claim) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [claim]);
  if (!claim) return null;
  const who = claimActorLabel(claim.actor);
  const age = formatElapsed(Math.max(0, now - Date.parse(claim.acquiredAt)));
  const exclusive = claim.scope === "code" || claim.scope === "both";
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      <span
        title={
          `${claim.actor} — ${CLAIM_KIND_LABEL[claim.kind]} (escopo ${claim.scope}) desde ${claim.acquiredAt}` +
          `${claim.note ? ` · ${claim.note}` : ""}\n` +
          "Reserva informativa: outro agente não pega este card enquanto durar. Você não está bloqueado — " +
          "é aviso, não trava. Expira sozinha (nunca deixa o card preso)."
        }
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
          exclusive
            ? "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
            : "bg-surface-hover text-fg-muted",
        )}
      >
        <Lock className="h-3 w-3" />
        {who} · {CLAIM_KIND_LABEL[claim.kind]} · {age}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run sub-state + card quick actions (story-ex9518). The run's operational state
// (rodando/integrando/conflito/aguardando/travou/falhou/terminou) gates up to three
// one-tap actions (terminal · diff +/− · avançar coluna sugerida), so the operator
// acts from the board on mobile without opening each card.
// ---------------------------------------------------------------------------

/**
 * Resolve a card's operational sub-state from the two live snapshots. Re-evaluates
 * on every SSE frame (snapshot/mergeQueue change) and on a slow 30s tick so a `done`
 * badge expires past its TTL even with no new frames.
 */
export function useRunSubstate(boardId: string, cardId: string): RunSubstate | null {
  const { snapshot, mergeQueue } = useRunner();
  const [now, setNow] = useState(() => Date.now());
  const substate = useMemo(
    () => resolveRunSubstate(boardId, cardId, snapshot, mergeQueue, now),
    [boardId, cardId, snapshot, mergeQueue, now],
  );
  // Q1 — only arm the slow tick when there's a substate with a FINITE TTL to expire (one anchored by
  // `since`). A null substate — the vast majority of idle cards — arms NO timer, so a board of hundreds
  // of idle cards stops running one 30s interval each. The tick lets a `done` badge disappear past its
  // TTL even with no new SSE frame.
  const hasTtl = substate != null && substate.since != null;
  useEffect(() => {
    if (!hasTtl) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [hasTtl]);
  return substate;
}

/**
 * The three one-tap card actions, gated by the live state (cardQuickActionVisibility):
 *   • Terminal — open the run's read-only console (resume the loop)
 *   • Diff +/− — show `git diff main...run/<sessionId>` for a branch-bearing run
 *   • Avançar  — move to the recommended next column (idle + a recommendation exists)
 * Each button stops pointer/click propagation so it never starts the dnd-kit drag nor
 * opens the card. Renders nothing when no action applies.
 */
export function CardQuickActions({
  boardId,
  cardId,
  card,
  config,
  size = "sm",
}: {
  boardId: string;
  cardId: string;
  card?: Card;
  config?: BoardConfig;
  size?: "sm" | "md";
}) {
  const { sessionByKey, openConsole } = useRunner();
  const router = useRouter();
  const toast = useToast();
  const substate = useRunSubstate(boardId, cardId);
  const [diffOpen, setDiffOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ statusId: string; statusName: string; color: string } | null>(null);
  const [diffStats, setDiffStats] = useState<{ additions: number; deletions: number } | null>(null);
  const key = keyOf(boardId, cardId);

  const recommended =
    card?.type === "story" && config ? moveTargets(card, config).find((t) => t.recommended) ?? null : null;
  const isRunning = substate?.kind === "running";
  const hasDiffChanges = !!(diffStats && diffStats.additions + diffStats.deletions > 0);
  const vis = cardQuickActionVisibility({
    kind: substate?.kind ?? null,
    hasSession: !!sessionByKey[key],
    hasRecommendedMove: !!recommended,
    hasDiff: hasDiffChanges, // a live run shows the diff only once its branch actually has commits
  });
  const currentStatus = config?.statuses.find((s) => s.id === card?.status);

  // Fetch the run diff whenever the branch could carry commits: a post-run merge-queue state
  // (branchExists) OR a LIVE run — which we POLL so the +/− surfaces the moment the skill's first
  // incremental commit lands (small-commits flow), then keeps the count fresh as more land.
  const branchMaybeHasDiff = vis.diff || isRunning;
  useEffect(() => {
    if (!branchMaybeHasDiff) { setDiffStats(null); return; }
    let alive = true;
    const fetchStats = () =>
      getCardRunDiffAction({ board: boardId, cardId }).then((res) => {
        if (alive && res.ok && res.data) setDiffStats({ additions: res.data.additions, deletions: res.data.deletions });
      });
    void fetchStats();
    const poll = isRunning ? setInterval(() => void fetchStats(), 4000) : null;
    return () => {
      alive = false;
      if (poll) clearInterval(poll);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchMaybeHasDiff, isRunning, boardId, cardId]);

  if (!vis.terminal && !vis.diff && !vis.advance) return null;

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const md = size === "md";
  const btnCls = cn(
    "inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-muted transition hover:bg-surface-hover hover:text-fg",
    md ? "h-8 w-8" : "h-6 w-6",
  );
  const iconCls = md ? "h-4 w-4" : "h-3.5 w-3.5";

  const doMove = async (statusId: string, statusName: string) => {
    const res = await moveCardAction({ boardId, cardId, status: statusId });
    if (res.ok) {
      toast(`Movido para “${statusName}”.`, "success");
      router.refresh();
    } else {
      toast(res.error);
    }
  };

  return (
    <>
      <span className="inline-flex items-center gap-1" onClick={stop}>
        {vis.terminal && (
          <button
            type="button"
            title="Abrir terminal do run"
            aria-label="Abrir terminal do run"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              openConsole(boardId, cardId);
            }}
            className={btnCls}
          >
            <SquareTerminal className={iconCls} />
          </button>
        )}
        {vis.diff && (
          <button
            type="button"
            title="Ver diff do run (+/−)"
            aria-label="Ver diff do run"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              setDiffOpen(true);
            }}
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-muted transition hover:bg-surface-hover hover:text-fg",
              diffStats
                ? cn(md ? "h-8 gap-1 px-2" : "h-6 gap-0.5 px-1.5")
                : cn(md ? "h-8 w-8" : "h-6 w-6"),
            )}
          >
            <GitBranch className={iconCls} />
            {diffStats && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums">
                <span className="text-emerald-700 dark:text-emerald-400">+{diffStats.additions}</span>
                <span className="text-rose-600 dark:text-rose-400">−{diffStats.deletions}</span>
              </span>
            )}
          </button>
        )}
        {vis.advance && recommended && (
          <button
            type="button"
            title={`Avançar para ${recommended.status.name}`}
            aria-label={`Avançar para ${recommended.status.name}`}
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              setPendingMove({
                statusId: recommended.status.id,
                statusName: recommended.status.name,
                color: recommended.status.color ?? "#94a3b8",
              });
            }}
            className={cn(btnCls, "border-accent/40 text-accent hover:text-accent")}
          >
            <ArrowRight className={iconCls} />
          </button>
        )}
      </span>

      {diffOpen && createPortal(<CardDiffModal board={boardId} cardId={cardId} onClose={() => setDiffOpen(false)} />, document.body)}

      {pendingMove &&
        createPortal(
          <ConfirmDialog
            title="Avançar card"
            description={card?.title ?? cardId}
            confirmLabel="Avançar"
            onCancel={() => setPendingMove(null)}
            onConfirm={() => {
              const { statusId, statusName } = pendingMove;
              setPendingMove(null);
              doMove(statusId, statusName);
            }}
          >
            <MovePreview
              fromName={currentStatus?.name ?? "Sem status"}
              fromColor={currentStatus?.color ?? "#94a3b8"}
              toName={pendingMove.statusName}
              toColor={pendingMove.color}
            />
          </ConfirmDialog>,
          document.body,
        )}
    </>
  );
}

const DIFF_LINE_CLS = (line: string): string => {
  if (line.startsWith("@@")) return "text-sky-600 dark:text-sky-300";
  if (line.startsWith("+++") || line.startsWith("---")) return "text-fg-subtle";
  if (line.startsWith("+")) return "text-emerald-700 dark:text-emerald-400";
  if (line.startsWith("-")) return "text-rose-600 dark:text-rose-400";
  return "text-fg-muted";
};

/** One side (board/código) of the cumulative card diff the modal renders (server: CumulativeDiffPart). */
type CardDiffPart = { diff: string; additions: number; deletions: number };

/** Render one unified `git diff` blob — line-coloured + capped for the (mobile) DOM. */
function DiffBlob({ diff }: { diff: string }) {
  if (diff.trim() === "") return <p className="text-fg-subtle">Sem mudanças.</p>;
  const { lines, hidden } = capDiffLines(diff);
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className={cn("whitespace-pre-wrap break-words", DIFF_LINE_CLS(line))}>
          {line || " "}
        </div>
      ))}
      {hidden > 0 && (
        <p className="mt-2 text-amber-700 dark:text-amber-300">
          … diff truncado — {hidden.toLocaleString("pt-BR")} linha(s) ocultada(s). Abra o terminal para o diff completo.
        </p>
      )}
    </>
  );
}

/**
 * Card diff modal with TWO modes:
 *  • Run — the last run's `git diff` (commitRange → snapshot → grep fallback), via getCardRunDiffAction.
 *  • Completo — the CUMULATIVE diff of the whole card (board on main + código on stage), via
 *    getCardFullDiffAction. Answers "ver todo o diff até a revisão": the split scatters the changes, so
 *    this re-aggregates them into board + código sections. The cumulative side is fetched lazily on the
 *    first switch to "Completo".
 */
export function CardDiffModal({ board, cardId, onClose }: { board: string; cardId: string; onClose: () => void }) {
  const [mode, setMode] = useState<"run" | "full">("run");
  const [run, setRun] = useState<
    | { phase: "loading" }
    | { phase: "ok"; diff: string; branch: string; additions: number; deletions: number }
    | { phase: "error"; error: string }
  >({ phase: "loading" });
  const [full, setFull] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "ok"; board: CardDiffPart | null; code: CardDiffPart | null }
    | { phase: "error"; error: string }
  >({ phase: "idle" });

  useEffect(() => {
    let alive = true;
    getCardRunDiffAction({ board, cardId }).then((res) => {
      if (!alive) return;
      if (res.ok && res.data) setRun({ phase: "ok", ...res.data });
      else setRun({ phase: "error", error: res.ok ? "Sem dados de diff." : res.error });
    });
    return () => {
      alive = false;
    };
  }, [board, cardId]);

  // Lazy: fetch the cumulative diff only the first time the user opens "Completo".
  useEffect(() => {
    if (mode !== "full" || full.phase !== "idle") return;
    setFull({ phase: "loading" });
    let alive = true;
    getCardFullDiffAction({ board, cardId }).then((res) => {
      if (!alive) return;
      if (res.ok && res.data) setFull({ phase: "ok", board: res.data.board, code: res.data.code });
      else setFull({ phase: "error", error: res.ok ? "Sem dados de diff." : res.error });
    });
    return () => {
      alive = false;
    };
  }, [mode, full.phase, board, cardId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totals =
    mode === "run"
      ? run.phase === "ok"
        ? { a: run.additions, d: run.deletions }
        : null
      : full.phase === "ok"
        ? {
            a: (full.board?.additions ?? 0) + (full.code?.additions ?? 0),
            d: (full.board?.deletions ?? 0) + (full.code?.deletions ?? 0),
          }
        : null;

  const tab = (m: "run" | "full", label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={cn(
        "px-2 py-0.5 text-[11px] font-medium transition",
        mode === m ? "bg-surface-hover text-fg" : "text-fg-subtle hover:text-fg",
      )}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <GitBranch className="h-4 w-4 text-fg-subtle" />
          <div className="flex overflow-hidden rounded-md border border-line">
            {tab("run", "Run")}
            {tab("full", "Completo")}
          </div>
          {totals && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums">
              <span className="text-emerald-700 dark:text-emerald-400">+{totals.a}</span>
              <span className="text-rose-600 dark:text-rose-400">−{totals.d}</span>
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar diff"
            className="ml-auto rounded p-1 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto bg-inset px-4 py-3 font-mono text-[11px] leading-relaxed">
          {mode === "run" ? (
            run.phase === "loading" ? (
              <p className="text-fg-subtle">Carregando diff…</p>
            ) : run.phase === "error" ? (
              <p className="text-amber-700 dark:text-amber-300">{run.error}</p>
            ) : (
              <DiffBlob diff={run.diff} />
            )
          ) : full.phase === "ok" ? (
            <>
              <p className="mb-1 select-none text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                Board (main){full.board ? ` · +${full.board.additions} −${full.board.deletions}` : ""}
              </p>
              {full.board ? <DiffBlob diff={full.board.diff} /> : <p className="text-fg-subtle">Sem mudanças de board.</p>}
              {/* story-ex0052: the "Código (stage)" affordance is shown ONLY when the card actually has
                  staged code (full.code != null). A pre-dev card (capture/enrich/…/plan ran, but
                  `desenvolver` has not, so card_diff.code == null) is a BOARD-DATA-ONLY card with no run
                  worktree and no stage branch — surfacing an empty "Sem código staged ainda" row there is
                  noise that implies code work is pending when none is. Render the header + diff together,
                  or nothing. The Board section above stays unconditional. */}
              {full.code && (
                <>
                  <p className="mb-1 mt-4 select-none text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                    Código (stage) · +{full.code.additions} −{full.code.deletions}
                  </p>
                  <DiffBlob diff={full.code.diff} />
                </>
              )}
            </>
          ) : full.phase === "error" ? (
            <p className="text-amber-700 dark:text-amber-300">{full.error}</p>
          ) : (
            <p className="text-fg-subtle">Carregando diff completo…</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function useStorymapEvents(handler: (event: AgileHarnessEvent) => void): void {
  const { subscribeStorymap } = useContext(RunnerContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeStorymap((event) => ref.current(event)), [subscribeStorymap]);
}

/** Assina os AVISOS do agente na MESMA conexão SSE (mesma disciplina do hook acima: o handler mais
 *  recente vive num ref, então o chamador não precisa memoizá-lo). */
export function useAgentAlerts(handler: (alert: AgentAlert) => void): void {
  const { subscribeAlerts } = useContext(RunnerContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeAlerts((alert) => ref.current(alert)), [subscribeAlerts]);
}

/** Os terminais que esperam o operador AGORA (retrato vivo do vigia; [] quando nenhum). */
export function useTerminalAttention(): TerminalAttention[] {
  return useContext(RunnerContext).terminals;
}

/** Format an elapsed duration in ms as "42s" / "3m 12s". */
function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

const FAILURE_LABEL: Record<string, string> = {
  timeout: "travou (timeout)",
  exit: "falhou",
  error: "erro ao iniciar",
  "oom-killed": "estourou memória",
  "no-op": "não avançou (no-op)",
  "budget-cut": "cortado (teto de custo)",
};

// Pretty display name per trigger (the raw id is verbose for harness-sync-card).
const TRIGGER_LABEL: Record<string, string> = {
  "harness-sync-card": "sincronizar",
};
const prettyTrigger = (t: string): string => TRIGGER_LABEL[t] ?? t;

// ---------------------------------------------------------------------------

/**
 * Global runner menu (navbar): every harness-* run executing right now + recently-failed
 * ones, across boards. Click a row to open that run's console. Lives anywhere inside
 * a RunnerStatusProvider; a quiet icon when idle, a counted indigo pill when running.
 */
/**
 * The running / recently-failed process rows — the body shared by the standalone
 * navbar `RunnerMenu` and the header overflow (⋯) menu. Click a row to open that
 * run's live console. `onOpenRow` lets the host close its popover on selection.
 */
export function RunnerProcessList({ onOpenRow }: { onOpenRow?: () => void }) {
  const { snapshot, openConsole } = useRunner();
  const running = snapshot.running;
  const failures = snapshot.failures;
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second while something is running (drives the elapsed time).
  useEffect(() => {
    if (running.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  const openRow = (board: string, cardId: string) => {
    openConsole(board, cardId);
    onOpenRow?.();
  };

  if (running.length === 0 && failures.length === 0) {
    return (
      <p className="px-1 py-3 text-center text-xs text-fg-subtle">
        Nenhuma run ativa. Clique em ▶ num card para iniciar.
      </p>
    );
  }

  return (
    <ul className="flex max-h-80 flex-col gap-1 overflow-auto">
      {running.map((r) => (
        <li key={`r-${r.board}/${r.cardId}`}>
          <button
            type="button"
            onClick={() => openRow(r.board, r.cardId)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-hover"
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-fg-muted">
                {prettyTrigger(r.trigger)} · {r.cardId}
              </span>
              <span className="block truncate text-[10px] text-fg-subtle">
                {r.board} · ⏱ {formatElapsed(now - r.startedAt)}
              </span>
            </span>
            <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          </button>
        </li>
      ))}
      {failures.map((f) => (
        <li key={`f-${f.board}/${f.cardId}`}>
          <button
            type="button"
            onClick={() => openRow(f.board, f.cardId)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-hover"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-fg-muted">
                {prettyTrigger(f.trigger)} · {f.cardId}
              </span>
              <span className="block truncate text-[10px] text-rose-500 dark:text-rose-400">
                {f.board} · {FAILURE_LABEL[f.reason] ?? "falhou"}
              </span>
            </span>
            <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RunnerMenu() {
  const { snapshot } = useRunner();
  const [open, setOpen] = useState(false);
  const running = snapshot.running;
  const failures = snapshot.failures;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={
          running.length > 0
            ? `${running.length} run(s) ativa(s) no AgileHarness`
            : failures.length > 0
              ? `${failures.length} run(s) com falha recente — abra para ver`
              : "Processos do AgileHarness — nenhuma run ativa"
        }
        aria-label="Processos do AgileHarness"
        className={cn(
          "relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 transition",
          running.length > 0
            ? "border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-300"
            : "border-line text-fg-muted hover:bg-surface-hover",
        )}
      >
        <span className="relative inline-flex">
          <Activity className="h-4 w-4" />
          {running.length > 0 ? (
            // live: pulsing green dot (something is running right now)
            <span className="absolute -right-1.5 -top-1.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          ) : failures.length > 0 ? (
            // idle but a recent run failed: static rose dot
            <span className="absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-rose-500" />
          ) : null}
        </span>
        {running.length > 0 && (
          <span className="text-[11px] font-semibold tabular-nums leading-none">{running.length}</span>
        )}
      </button>

      {open && (
        <>
          {/* click-away */}
          <div className="fixed inset-0 z-[65]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-[70] mt-2 w-80 rounded-lg border border-line bg-surface p-2 shadow-md">
            <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Processos do AgileHarness
            </p>
            <RunnerProcessList onOpenRow={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Always-on live process strip for the navbar (desktop): one chip per ACTIVE run
 * (spinner + skill + card id + elapsed); click opens that run's console. Renders
 * nothing when idle — the sibling RunnerMenu button carries the idle/failure state and
 * the full list. Hidden below `lg` (the RunnerMenu count covers narrow screens), so the
 * header stays uncluttered while the runs are still visible WITHOUT opening any menu.
 */
export function RunnerInlineChips({ max = 2 }: { max?: number }) {
  const { snapshot, openConsole } = useRunner();
  const running = snapshot.running;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (running.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  if (running.length === 0) return null;
  const shown = running.slice(0, max);
  const extra = running.length - shown.length;

  return (
    <div className="hidden items-center gap-1 lg:flex">
      {shown.map((r) => (
        <button
          key={`${r.board}/${r.cardId}`}
          type="button"
          onClick={() => openConsole(r.board, r.cardId)}
          title={`${prettyTrigger(r.trigger)} · ${r.cardId} (${r.board}) — abrir console`}
          className="inline-flex max-w-[170px] items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
        >
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          <span className="truncate">
            {prettyTrigger(r.trigger)} · {r.cardId}
          </span>
          <span className="shrink-0 tabular-nums opacity-80">{formatElapsed(now - r.startedAt)}</span>
        </button>
      ))}
      {extra > 0 && (
        <span className="rounded-full border border-line px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
          +{extra}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const LEVEL_CLS: Record<string, string> = {
  info: "text-fg",
  tool: "text-sky-600 dark:text-sky-300",
  system: "text-fg-subtle",
  result: "text-emerald-700 dark:text-emerald-400",
  error: "text-rose-600 dark:text-rose-400",
};

function CardConsoleModal({ board, cardId, onClose }: { board: string; cardId: string; onClose: () => void }) {
  const { snapshot, sessionByKey } = useRunner();
  const logsByKey = useRunnerLogs();
  const key = keyOf(board, cardId);
  const frames = logsByKey[key] ?? [];
  const run = snapshot.running.find((r) => r.board === board && r.cardId === cardId);
  const [sessionId, setSessionId] = useState<string | undefined>(sessionByKey[key]);
  const [resolved, setResolved] = useState<boolean>(!!sessionByKey[key]);
  const [copied, setCopied] = useState(false);
  const [copiedLog, setCopiedLog] = useState(false);
  const [openMsg, setOpenMsg] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the console is currently pinned to the tail. Starts true (first frames
  // scroll into view); flipped by the scroll handler so streaming frames only stick
  // to the bottom when the user is ALREADY there — never yanking a scroll-up/select.
  const stickRef = useRef(true);
  // Did the press that may close the modal START on the backdrop itself? A drag that
  // begins inside (selecting log text) and is released over the backdrop must NOT close.
  const backdropDownRef = useRef(false);

  // Resolve the most-recent session id even if no live run is in the snapshot (null
  // when the card hasn't run in this dev-server lifetime → prompt to run it first).
  useEffect(() => {
    if (sessionByKey[key]) {
      setSessionId(sessionByKey[key]);
      setResolved(true);
      return;
    }
    let alive = true;
    getCardSessionIdAction({ board, cardId }).then((res) => {
      if (!alive) return;
      if (res.ok && res.data) setSessionId(res.data.sessionId ?? undefined);
      setResolved(true);
    });
    return () => {
      alive = false;
    };
  }, [board, cardId, key, sessionByKey]);

  // Track whether the user is pinned to the tail — measured BEFORE new frames land,
  // so the auto-scroll effect below knows the pre-append position.
  const onConsoleScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = isNearBottom(el);
  };

  // Stick to the tail as frames arrive — but ONLY when the user is already at the
  // bottom and isn't mid-selection inside the console. If they scrolled up to read
  // or are dragging a selection, streaming frames must not steal the view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (
      sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      el.contains(sel.getRangeAt(0).commonAncestorContainer)
    ) {
      return; // active selection inside the console — leave the scroll alone
    }
    el.scrollTop = el.scrollHeight;
  }, [frames.length]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resumeCmd = sessionId ? `claude --resume ${sessionId}` : "";

  const copy = async () => {
    if (!resumeCmd) return;
    try {
      await navigator.clipboard.writeText(resumeCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setOpenMsg("Não consegui copiar — selecione e copie manualmente.");
    }
  };

  // Copy the WHOLE console log (every frame, one per line) — the robust path for the
  // user to grab the run's output regardless of selection/auto-scroll fiddliness.
  const copyLog = async () => {
    if (frames.length === 0) return;
    try {
      await navigator.clipboard.writeText(joinFramesText(frames));
      setCopiedLog(true);
      setTimeout(() => setCopiedLog(false), 1500);
    } catch {
      setOpenMsg("Não consegui copiar o log — selecione e copie manualmente.");
    }
  };

  const openTerminal = async () => {
    if (!sessionId) return;
    setOpenMsg(null);
    const res = await openTerminalForSessionAction({ sessionId });
    if (!res.ok) setOpenMsg(res.error);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      // Close ONLY on a clean backdrop click: the press must START on the backdrop
      // (tracked here) AND land on it. A selection dragged out of the modal and
      // released over the backdrop begins inside → it won't close.
      onMouseDown={(e) => {
        backdropDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (shouldCloseOnBackdrop({ downOnBackdrop: backdropDownRef.current, clickTargetIsBackdrop: e.target === e.currentTarget })) {
          onClose();
        }
        backdropDownRef.current = false;
      }}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <SquareTerminal className="h-4 w-4 text-fg-subtle" />
          <span className="font-mono text-xs text-fg-muted">{key}</span>
          {run && (
            <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              <Loader2 className="h-3 w-3 animate-spin" /> {prettyTrigger(run.trigger)}
            </span>
          )}
          <button
            type="button"
            onClick={copyLog}
            disabled={frames.length === 0}
            title="Copiar todo o log do console"
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-40"
          >
            {copiedLog ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            {copiedLog ? "Copiado" : "Copiar log"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar console"
            className="rounded p-1 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* console */}
        <div
          ref={scrollRef}
          onScroll={onConsoleScroll}
          className="flex-1 overflow-auto bg-inset px-4 py-3 font-mono text-[11px] leading-relaxed"
        >
          {frames.length === 0 ? (
            <p className="text-fg-subtle">Sem saída ainda. As linhas aparecem aqui conforme a skill roda.</p>
          ) : (
            frames.map((f) => (
              <div key={f.seq} className={cn("whitespace-pre-wrap break-words", LEVEL_CLS[f.level] ?? "text-fg")}>
                {f.text}
              </div>
            ))
          )}
        </div>

        {/* resume footer */}
        <div className="border-t border-line px-4 py-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            Entrar no loop — retoma esta sessão num terminal real
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-inset px-2 py-1.5 text-[11px] text-fg">
              {resumeCmd || (resolved ? "Sem sessão ainda — rode o card para gerar uma." : "resolvendo sessão…")}
            </code>
            <button
              type="button"
              onClick={copy}
              disabled={!resumeCmd}
              title="Copiar comando"
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-40"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copiado" : "Copiar"}
            </button>
            <button
              type="button"
              onClick={openTerminal}
              disabled={!sessionId}
              title="Abrir num terminal real (requer AGILEHARNESS_AUTORUN_OPEN_TERMINAL=1)"
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-40"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Abrir
            </button>
          </div>
          {openMsg && <p className="mt-1.5 text-[11px] text-amber-400">{openMsg}</p>}
        </div>
      </div>
    </div>
  );
}
