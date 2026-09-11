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
  Bug,
  Check,
  Clock,
  Copy,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequestClosed,
  History,
  Loader2,
  Lock,
  MoreHorizontal,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import Link from "next/link";
import {
  deleteCardAction,
  forceReleaseRunAction,
  getCardFullDiffAction,
  getCardRunDiffAction,
  getCardRunDiffStatAction,
  getCardRunHistoryAction,
  getCardTransitionsAction,
  getCardSessionIdAction,
  listResumableSessionsAction,
  moveCardAction,
  openTerminalForSessionAction,
  runCardSkillAction,
  syncCardAction,
} from "@/app/actions";
import {
  resolveRunSubstate,
  type RunSubstate,
  type RunSubstateIconName,
} from "@/lib/storymap/run-substate";
import { cardQuickActionVisibility, idleDiffVisible } from "@/lib/storymap/card-preview";
import { isReopenableStatus } from "@/lib/storymap/reopen";
import { capDiffLines } from "@/lib/storymap/runner/diff";
import type { LogFrame, MergeQueueSnapshot, RunnerLogBatch, RunnerSnapshot } from "@/lib/storymap/runner/types";
import type { CardClaim } from "@/lib/storymap/runner/claims";
import type { VpsMetrics } from "@/lib/vps/types";
import { isNearBottom, joinFramesText, shouldCloseOnBackdrop } from "@/lib/storymap/runner/console";
import { moveTargets } from "@/lib/storymap/move-targets";
import { computeStepRollups, stepProgress } from "@/lib/storymap/step-rollup";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { TelemetryRecord } from "@/lib/storymap/runner/telemetry";
import type { Transition } from "@/lib/storymap/runner/transitions";
import { ConfirmDialog, MovePreview } from "./ConfirmDialog";
import { CardStageHistory } from "./CardStageHistory";
import type { AgentAlert, AgileHarnessEvent } from "@/lib/notifications/event";
import type { TerminalAttention } from "@/lib/terminal/attention";
import { useToast } from "./Toast";
import { RefineModal } from "./RefineModal";
import { BugModal } from "./BugModal";
// WS-2 (copilot-actionability) — the next-action slot + the pre-explained blocked destinations.
import { QuickActionButton } from "./QuickActionButton";
import { blockedTargets, cardNextAction, mergeEntryDemand } from "@/lib/storymap/quick-actions";
import { cardDemands, dominantDemand } from "@/lib/storymap/demands";

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
  openConsole: () => {},
  subscribeStorymap: () => () => {},
  subscribeAlerts: () => () => {},
});

const keyOf = (board: string, cardId: string) => `${board}/${cardId}`;

// C1(a) — logsByKey lives in a SEPARATE context from the main runner value. Console frames (~5x/s
// during a run) change it constantly; keeping it out of the main value means those frames no longer
// wake the card consumers (useRunSubstate & friends read RunnerContext only).
const RunnerLogsContext = createContext<Record<string, LogFrame[]>>({});

export function RunnerStatusProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<RunnerSnapshot>(EMPTY);
  const [logsByKey, setLogsByKey] = useState<Record<string, LogFrame[]>>({});
  const [sessionByKey, setSessionByKey] = useState<Record<string, string>>({});
  const [metrics, setMetrics] = useState<VpsMetrics | null>(null);
  const [mergeQueue, setMergeQueue] = useState<MergeQueueSnapshot | null>(null);
  const [claimByKey, setClaimByKey] = useState<Record<string, CardClaim>>({});
  const [terminals, setTerminals] = useState<TerminalAttention[]>([]);
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
      openConsole,
      subscribeStorymap,
      subscribeAlerts,
    }),
    [snapshot, sessionByKey, metrics, mergeQueue, claimByKey, terminals, openConsole, subscribeStorymap, subscribeAlerts],
  );

  return (
    <RunnerContext.Provider value={value}>
      <RunnerLogsContext.Provider value={logsByKey}>
        {children}
        {consoleTarget && (
          <CardConsoleModal
            board={consoleTarget.board}
            cardId={consoleTarget.cardId}
            onClose={() => setConsoleTarget(null)}
          />
        )}
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

/** WS-4.3 — the live claim on ONE card (who holds it), or null when nobody does. */
export function useCardClaim(boardId: string, cardId: string): CardClaim | null {
  return useContext(RunnerContext).claimByKey[keyOf(boardId, cardId)] ?? null;
}

/**
 * The TAIL of one card's run console — the last `n` frames, oldest-first — for chrome that wants to
 * SHOW what a run is doing rather than just that it is running (the home's terminals).
 *
 * Free by construction: these frames already arrive on the shared SSE (`runner-log`), and the stream
 * replays the retained backlog on connect, so a mount reads recent output without any fetch. Returns
 * an empty array when the provider has never seen this card — the registry keeps 500 lines for the 16
 * most recent cards, in RAM, so an older or post-restart run legitimately has nothing to show.
 */
export function useCardConsoleTail(boardId: string, cardId: string, n = 3): LogFrame[] {
  const frames = useContext(RunnerLogsContext)[keyOf(boardId, cardId)];
  return useMemo(() => (frames ? frames.slice(-n) : EMPTY_FRAMES), [frames, n]);
}

/** Stable empty tail — a fresh `[]` per render would defeat the memo in every consumer. */
const EMPTY_FRAMES: LogFrame[] = [];

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
 * beside RunSubstateBadge rather than in CardBadges (which renders CARD fields) — a claim is deliberately NOT
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
// Run sub-state badge + card quick actions (story-redesenho-cards-storymap).
// A closed kanban card surfaces ONE coloured badge for the run's operational
// state (rodando/integrando/conflito/aguardando/travou/falhou/terminou) plus up
// to three one-tap actions (terminal · diff +/− · avançar coluna sugerida), so the
// operator acts from the board on mobile without opening each card.
// ---------------------------------------------------------------------------

/** Map the pure module's icon name → a Lucide glyph (kept here so the lib stays React-free). */
const SUBSTATE_ICON: Record<RunSubstateIconName, typeof Loader2> = {
  loader: Loader2,
  merge: GitMerge,
  conflict: GitPullRequestClosed,
  clock: Clock,
  alert: AlertTriangle,
  x: X,
  check: Check,
};

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

/** Presentational pill for a resolved sub-state — colour + icon + label (+ live elapsed). */
function RunSubstatePill({ substate, size }: { substate: RunSubstate; size: "sm" | "md" }) {
  const Icon = SUBSTATE_ICON[substate.iconName];
  const spin = substate.kind === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (substate.since == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [substate.since]);
  const elapsed = substate.since != null ? formatElapsed(now - substate.since) : null;
  const md = size === "md";
  return (
    <span
      title={[substate.label, substate.detail, elapsed].filter(Boolean).join(" · ")}
      className={cn(
        "inline-flex items-center rounded font-semibold tabular-nums",
        md ? "gap-1 px-2 py-1 text-[11px]" : "gap-0.5 px-1.5 py-0.5 text-[10px]",
        substate.colorCls,
      )}
    >
      <Icon className={cn(md ? "h-3.5 w-3.5" : "h-3 w-3", spin && "animate-spin")} />
      <span className="truncate">{substate.label}</span>
      {elapsed && <span className="opacity-80">· {elapsed}</span>}
      {md && substate.detail && <span className="opacity-70">· {substate.detail}</span>}
    </span>
  );
}

/**
 * The run sub-state badge for a card. Renders nothing when the card has no live state
 * (so a clean card carries no badge). `size="sm"` for the closed kanban card, `"md"`
 * for the open drawer's anchored run bar.
 */
export function RunSubstateBadge({
  boardId,
  cardId,
  size = "sm",
  substate,
}: {
  boardId: string;
  cardId: string;
  size?: "sm" | "md";
  /** Q1(ii) — when the host (KanbanCard) already resolved the substate once for the rail, it passes it
   *  in so this badge doesn't re-subscribe: 1 useRunSubstate per card instead of 3. `undefined` (prop
   *  omitted) falls back to the live hook; `null` means "resolved, no live state". */
  substate?: RunSubstate | null;
}) {
  if (substate !== undefined) return substate ? <RunSubstatePill substate={substate} size={size} /> : null;
  return <RunSubstateBadgeLive boardId={boardId} cardId={cardId} size={size} />;
}

/** The self-subscribing variant — used only when no `substate` prop is supplied. */
function RunSubstateBadgeLive({ boardId, cardId, size }: { boardId: string; cardId: string; size: "sm" | "md" }) {
  const substate = useRunSubstate(boardId, cardId);
  if (!substate) return null;
  return <RunSubstatePill substate={substate} size={size} />;
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

/**
 * The ▶ Rodar / ⏹ Parar inline action on a minimalist CLOSED kanban card (story-2ulzzl).
 * Three states from the live runner snapshot:
 *  - a LIVE run (the card is in `snapshot.running`) → ⏹ Parar, guarded by a ConfirmDialog
 *    (tone="danger") because killing a run is IRREVERSIBLE — an accidental mobile tap can
 *    cost minutes of work (grill q2) → forceReleaseRunAction (SIGTERM via the engine);
 *  - idle on a column WITH a trigger → ▶ Rodar (runCardSkillAction), with a local spinner
 *    until the SSE snapshot confirms the run;
 *  - idle on a column WITHOUT a trigger → nothing (no skill to run here).
 * Stops pointer/click propagation so it never starts the dnd-kit drag nor opens the card.
 */
export function KanbanCardRunButton({
  boardId,
  cardId,
  hasTrigger,
  card,
}: {
  boardId: string;
  cardId: string;
  /** card sits in a column with a `trigger` → ▶ Rodar is available when idle */
  hasTrigger?: boolean;
  /** the full card — used only for the stop confirmation's description */
  card?: Card;
}) {
  const router = useRouter();
  const toast = useToast();
  const { snapshot } = useRunner();
  const logsByKey = useRunnerLogs();
  const [starting, setStarting] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const key = keyOf(boardId, cardId);
  const run = snapshot.running.find((r) => r.board === boardId && r.cardId === cardId);
  const hasLogs = (logsByKey[key]?.length ?? 0) > 0;

  // Any sign of life clears the local "iniciando" spinner — from here the SSE snapshot owns state.
  useEffect(() => {
    if (run || hasLogs) setStarting(false);
  }, [run, hasLogs]);

  // Live elapsed while THIS card runs (user feedback: a RUNNING card shows its execution time —
  // ONLY while running). Ticks 1s only while `run` exists; idle cards carry no timer.
  const startedAt = run?.startedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  const elapsed = startedAt != null ? formatElapsed(now - startedAt) : null;

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const startRun = async (e: React.SyntheticEvent) => {
    stop(e);
    if (starting || run) return;
    setStarting(true);
    const res = await runCardSkillAction({ boardId, cardId });
    if (res.ok) toast(`Rodando ${prettyTrigger(res.data?.trigger ?? "skill")} neste card…`, "success");
    else {
      setStarting(false);
      toast(res.error);
    }
  };

  const doStop = async () => {
    setConfirmStop(false);
    const res = await forceReleaseRunAction({ boardId, cardId });
    if (res.ok) {
      toast("Run encerrado.", "success");
      router.refresh();
    } else {
      toast(res.error);
    }
  };

  // Icon-only square button (user feedback: no text labels on the closed card). The RUNNING
  // state is the one exception — it surfaces the live elapsed time next to the ⏹ icon.
  const iconBtn = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition";

  if (run) {
    return (
      <>
        <button
          type="button"
          title={`Parar run${elapsed ? ` · rodando há ${elapsed}` : ""}`}
          aria-label="Parar run"
          onPointerDown={stop}
          onClick={(e) => {
            stop(e);
            setConfirmStop(true);
          }}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold tabular-nums transition",
            "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10",
          )}
        >
          <Square className="h-3 w-3 fill-current" />
          {elapsed && <span>{elapsed}</span>}
        </button>
        {confirmStop &&
          createPortal(
            <ConfirmDialog
              title="Parar run?"
              description="Esta ação é irreversível — o processo será encerrado."
              confirmLabel="Parar"
              tone="danger"
              onCancel={() => setConfirmStop(false)}
              onConfirm={doStop}
            >
              <p className="rounded-lg border border-line bg-inset px-3 py-2 text-[12px] text-fg-muted">
                {card?.title ?? cardId}
              </p>
            </ConfirmDialog>,
            document.body,
          )}
      </>
    );
  }

  if (!hasTrigger) return null;

  return (
    <button
      type="button"
      title="Rodar a skill desta coluna neste card"
      aria-label="Rodar a skill desta coluna"
      disabled={starting}
      onPointerDown={stop}
      onClick={startRun}
      className={cn(
        iconBtn,
        "border-line bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50",
      )}
    >
      {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}
    </button>
  );
}

/**
 * Icon-only Terminal button for the closed card's action strip. ALWAYS present whenever the card
 * has a reachable session — a LIVE one (running / buffered log frames) OR a DURABLE one seeded
 * from the journal on mount — so a finished card still opens its run CONSOLE to review what was
 * done (user feedback). The click opens the read-only console modal (live frames + the durable
 * `claude --resume <id>` to copy and reconnect to that session); it NEVER navigates away.
 * Stops propagation so it never starts the dnd drag nor opens the card.
 */
export function KanbanCardConsoleButton({ boardId, cardId }: { boardId: string; cardId: string }) {
  const { snapshot, sessionByKey, openConsole } = useRunner();
  const logsByKey = useRunnerLogs();
  const key = keyOf(boardId, cardId);
  const running = snapshot.running.some((r) => r.board === boardId && r.cardId === cardId);
  const available = running || (logsByKey[key]?.length ?? 0) > 0 || !!sessionByKey[key];
  if (!available) return null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <button
      type="button"
      title="Abrir console do run (logs + copiar claude --resume)"
      aria-label="Abrir console do run"
      onPointerDown={stop}
      onClick={(e) => {
        stop(e);
        openConsole(boardId, cardId);
      }}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-muted transition hover:bg-surface-hover hover:text-fg"
    >
      <SquareTerminal className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * "Mover para" as a dedicated inline button + searchable popover on the minimalist closed
 * card (story-2ulzzl). It replaces hunting through the ⋮ kebab for the most frequent
 * post-run gesture. The popover lists the card's gate-passing destinations (moveTargets),
 * the RECOMMENDED next stage pinned on top (accent border + Sparkles + "recomendada"); a
 * SYNC search filters the local array (zero latency — the orchestrator needs instant
 * filtering, never a network query). Choosing a destination stages it behind a ConfirmDialog
 * (guards an accidental tap), then moveCardAction + refresh. Closes on Escape, click-away,
 * scroll, resize. Renders nothing when the card has no eligible destination.
 */
/**
 * WS-2 — the closed card's NEXT obvious action (1 click), a thin shell over the pure `cardNextAction`
 * (WS-0): the registry decides WHAT (happy primary + a sad escalate), this component decides only how
 * much fits on the closed card (`secondary` belongs to Inbox). No fetch — everything comes from the
 * already-mounted SSE (useRunSubstate/useMergeQueue) + props. The DELIVERY lane's happy "Aprovar/Publicar"
 * is owned by the DeliveryStepper, so a happy `move-card:advance` is suppressed on a laneStep step (sad
 * states — a merge conflict / deploy-failed on a delivery card — still surface).
 */
export function KanbanCardNextAction({
  boardId,
  cardId,
  card,
  config,
}: {
  boardId: string;
  cardId: string;
  card: Card;
  config: BoardConfig;
}) {
  const substate = useRunSubstate(boardId, cardId);
  const mergeQueue = useMergeQueue();
  if (card.type !== "story") return null; // the kanban only mounts stories; defensive
  // The machine-legible sad-merge source: the card's most-recent PARKED train entry (no runId Demand exists today).
  const parked =
    (mergeQueue?.entries ?? [])
      .filter((e) => e.board === boardId && e.cardId === cardId && (e.status === "conflict" || e.status === "gate-failed"))
      .at(-1) ?? null;
  const demand = (parked ? mergeEntryDemand(parked, card) : null) ?? dominantDemand(cardDemands(card, config, boardId));
  const set = cardNextAction(card, config, substate, demand);
  if (!set) return null;
  const def = config.statuses.find((s) => s.id === card.status);
  const primary = def?.laneStep && set.primary?.id === "move-card:advance" ? null : set.primary;
  if (!primary && !set.escalate) return null;
  return (
    <>
      {primary && <QuickActionButton boardId={boardId} cardId={cardId} action={primary} surface="kanban" size="sm" />}
      {set.escalate && <QuickActionButton boardId={boardId} cardId={cardId} action={set.escalate} surface="kanban" size="sm" />}
    </>
  );
}

export function MoveToPopover({
  boardId,
  cardId,
  card,
  config,
}: {
  boardId: string;
  cardId: string;
  card: Card;
  config: BoardConfig;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [pendingMove, setPendingMove] = useState<{ statusId: string; statusName: string; color: string } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const targets = card.type === "story" ? moveTargets(card, config) : [];
  // WS-2 (D11) — the destinations the popover OMITS today, with the WHY (pre-explanatory tooltip). Pure.
  const blocked = card.type === "story" ? blockedTargets(card, config) : [];
  const currentStatus = config.statuses.find((s) => s.id === card.status);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 220;
    const H = 280;
    const openUp = r.bottom + H + 8 > window.innerHeight;
    setPos({
      top: openUp ? Math.max(8, r.top - H - 4) : r.bottom + 4,
      left: Math.min(Math.max(8, r.left), window.innerWidth - W - 8),
    });
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    place();
    setOpen(true);
  };

  // Autofocus the search input on open so the operator can type immediately (mobile).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // The fixed popover detaches on scroll/resize → close it; Escape also closes.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (targets.length === 0 && blocked.length === 0) return null; // nothing to move to AND nothing to explain → hide

  const q = query.trim().toLowerCase();
  const filtered = q ? targets.filter((t) => t.status.name.toLowerCase().includes(q)) : targets;
  const filteredBlocked = q ? blocked.filter((b) => b.status.name.toLowerCase().includes(q)) : blocked;

  const doMove = async () => {
    if (!pendingMove) return;
    const { statusId, statusName } = pendingMove;
    setPendingMove(null);
    const res = await moveCardAction({ boardId, cardId, status: statusId });
    if (res.ok) {
      toast(`Movido para “${statusName}”.`, "success");
      router.refresh();
    } else {
      toast(res.error);
    }
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Mover para…"
        aria-label="Mover para outra coluna"
        onPointerDown={stop}
        onClick={toggle}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-muted transition hover:bg-surface-hover hover:text-fg"
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[90]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            />
            <div
              className="fixed z-[91] w-[220px] rounded-lg border border-line bg-surface p-1.5 shadow-lg"
              style={{ top: pos.top, left: pos.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="px-1 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                Mover para
              </p>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClick={stop}
                placeholder="Buscar coluna…"
                className="mb-1.5 w-full rounded-md border border-line bg-inset px-2.5 py-1.5 text-[12px] text-fg outline-none placeholder:text-fg-subtle focus:border-line-emphasis"
              />
              {filtered.length === 0 && filteredBlocked.length === 0 ? (
                <p className="px-2 py-3 text-center text-[11px] text-fg-subtle">Sem colunas correspondentes.</p>
              ) : (
                <>
                  {filtered.length > 0 && (
                    <div className="max-h-[170px] overflow-y-auto">
                      {filtered.map((t) => (
                        <button
                          key={t.status.id}
                          type="button"
                          title={
                            t.recommended ? `${t.status.name} — próximo passo recomendado` : `Mover para ${t.status.name}`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(false);
                            setPendingMove({
                              statusId: t.status.id,
                              statusName: t.status.name,
                              color: t.status.color ?? "#94a3b8",
                            });
                          }}
                          className={cn(
                            "mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium transition",
                            t.recommended
                              ? "border border-accent/60 bg-accent/5 text-fg ring-1 ring-accent/30 hover:bg-accent/10"
                              : "text-fg-muted hover:bg-surface-hover",
                          )}
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: t.status.color ?? "#94a3b8" }}
                          />
                          <span className="min-w-0 flex-1 truncate">{t.status.name}</span>
                          {t.recommended && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                              <Sparkles className="h-3 w-3" />
                              recomendada
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* D11 — the destinations moveTargets omits, with the WHY. DISABLED (the UI still never offers
                      what the server rejects — a mirror of moveTargets); the tooltip PRE-explains the gate. */}
                  {filteredBlocked.length > 0 && (
                    <div className="mt-1.5 border-t border-line-muted pt-1.5">
                      <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Bloqueadas</p>
                      <div className="max-h-[120px] overflow-y-auto">
                        {filteredBlocked.map((b) => (
                          <div
                            key={b.status.id}
                            title={`Gate ${b.gateLabel}: ${b.message}`}
                            className="mb-0.5 flex w-full cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg-subtle opacity-70"
                          >
                            <Lock className="h-3 w-3 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{b.status.name}</span>
                            <span className="shrink-0 text-[9px] uppercase tracking-wide text-fg-subtle">{b.gateLabel}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>,
          document.body,
        )}

      {pendingMove &&
        createPortal(
          <ConfirmDialog
            title="Mover card"
            description={card.title}
            confirmLabel="Mover"
            onCancel={() => setPendingMove(null)}
            onConfirm={doMove}
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

/**
 * The kebab (⋯) actions menu on a CLOSED kanban card — the secondary/destructive actions
 * (Sincronizar · Excluir card) that don't earn a permanent footer icon. Sits to the LEFT of the
 * footer icon group, hidden until the card is hovered (group-hover) so the strip stays calm; opens
 * on hover OR click. Mirrors MoveToPopover's anchored-portal placement because the card is
 * `overflow-hidden` (an inline menu would be clipped). "Excluir card" is a SOFT delete (autonomo-liberdade-
 * humana M2) — it moves the card's .md to the board's `.trash/` (deleteCardAction → trashCardFile),
 * restorable for 7 days (restore_deleted) before the GC prunes it (NOT the same as Descontinuar, which
 * retires the feature). Guarded by a danger ConfirmDialog. Closes on Escape,
 * click-away, scroll, resize, or mouse-leave (small grace delay so the cursor can reach the menu).
 */
export function KanbanCardActionsMenu({
  boardId,
  cardId,
  card,
}: {
  boardId: string;
  cardId: string;
  card: Card;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 200;
    const H = 110;
    const openUp = r.bottom + H + 8 > window.innerHeight;
    setPos({
      top: openUp ? Math.max(8, r.top - H - 4) : r.bottom + 4,
      // Right-align the menu to the button so it doesn't overflow past the card's right edge.
      left: Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8),
    });
  };

  const show = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    place();
    setOpen(true);
  };
  // Grace delay so the cursor can travel from the button across the gap to the portal'd menu.
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  // The fixed popover detaches on scroll/resize → close it; Escape also closes. Click-outside is a
  // document mousedown listener (NOT a full-screen overlay div) — an overlay would sit above the
  // button and steal the hover, firing onMouseLeave the instant the menu opens (close-on-open bug).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const sync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    setBusy(true);
    const res = await syncCardAction({ boardId, cardId });
    setBusy(false);
    if (res.ok) toast("Sincronizando este card com o código — acompanhe no console do card (🖥).", "success");
    else toast(res.error);
  };

  const doDelete = async () => {
    setBusy(true);
    const res = await deleteCardAction({ boardId, cardId });
    setBusy(false);
    setConfirmDelete(false);
    if (res.ok) {
      toast("Card excluído.", "success");
      router.refresh();
    } else {
      toast(res.error);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Mais ações"
        aria-label="Mais ações"
        onPointerDown={stop}
        onMouseEnter={show}
        onMouseLeave={scheduleClose}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else show();
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-muted opacity-0 transition hover:bg-surface-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div
              ref={menuRef}
              className="fixed z-[91] w-[200px] rounded-lg border border-line bg-surface p-1.5 shadow-lg"
              style={{ top: pos.top, left: pos.left }}
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={show}
              onMouseLeave={scheduleClose}
            >
              <p className="px-1 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                Ações
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={sync}
                title="Revisa o card vs. o código real e o reposiciona"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5 shrink-0 text-sky-500" />
                <span className="min-w-0 flex-1 truncate">Sincronizar</span>
              </button>
              <div className="my-1 border-t border-line-muted" />
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  setConfirmDelete(true);
                }}
                title="Apaga o registro do board — não a feature. Use Descontinuar p/ isso."
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-500/10"
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Excluir card</span>
              </button>
            </div>
          </>,
          document.body,
        )}

      {confirmDelete &&
        createPortal(
          <ConfirmDialog
            title="Excluir card"
            description={`“${card.title}” — vai para a lixeira do board (não a feature). Recuperável por 7 dias.`}
            confirmLabel="Excluir"
            tone="danger"
            confirmDisabled={busy}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={doDelete}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * The HISTORY button + popover on a closed kanban card. The action strip's most PASSIVE affordance:
 * it answers "did this card run, and what status did each step LEAVE?" WITHOUT opening it — the
 * compact stage TRAIL (✓ delivered · ✗ needs you · · pending, with what each step left), so the
 * operator decides RUN vs MOVE at a glance. Telemetry is fetched LAZILY on open (one request per
 * inspection, never per board render); computeStepRollups folds it with the card's fields + the live
 * run. Closes on Escape / click-away / scroll / resize (mirrors MoveToPopover). Story cards only.
 */
export function KanbanCardHistoryButton({
  boardId,
  cardId,
  card,
  config,
}: {
  boardId: string;
  cardId: string;
  card: Card;
  config: BoardConfig;
}) {
  const { running } = useRunnerSnapshot();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [rows, setRows] = useState<TelemetryRecord[]>([]);
  const [hops, setHops] = useState<Transition[]>([]); // 6.3 — the durable ledger (execution axis of the trail)
  const [everLoaded, setEverLoaded] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const liveTrigger = running.find((r) => r.board === boardId && r.cardId === cardId)?.trigger ?? null;
  const rollups = useMemo(
    // 6.3 — feed the ledger so the trail's "não visitado" reflects real ledger events, not array position.
    () => computeStepRollups(config, card, rows, liveTrigger, { transitions: hops }),
    [config, card, rows, liveTrigger, hops],
  );

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 260;
    const H = 340;
    const openUp = r.bottom + H + 8 > window.innerHeight;
    setPos({
      top: openUp ? Math.max(8, r.top - H - 4) : r.bottom + 4,
      left: Math.min(Math.max(8, r.left), window.innerWidth - W - 8),
    });
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    place();
    setOpen(true);
  };

  // Fetch the durable ledger on EVERY open (never per board render). Refetching each time is what
  // keeps it fresh: a run that settled while the popover was closed would otherwise show stale rows
  // forever (the `loaded`-once cache bug). `everLoaded` only gates the first-load spinner — a reopen
  // renders the previous rows instantly while the refetch updates them in place.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    getCardRunHistoryAction({ boardId, cardId, limit: 30 }).then((r) => {
      if (!alive) return;
      if (r.ok && r.data) setRows(r.data.runs);
      setEverLoaded(true);
    });
    // 6.3 — pull the durable ledger alongside telemetry so the trail's execution axis is honest on every open.
    void getCardTransitionsAction({ boardId, cardId }).then((r) => {
      if (!alive) return;
      if (r.ok && r.data) setHops(r.data.transitions);
    });
    return () => {
      alive = false;
    };
  }, [open, boardId, cardId]);

  // The fixed popover detaches on PAGE scroll/resize → close it; Escape also closes. But the popover
  // has its OWN inner scroll (max-h + overflow-y-auto) — a scroll INSIDE it must NOT close it, so the
  // capture-phase handler ignores scroll events whose target lives within the popover.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The trail is meaningful for a story's pipeline; backbone nodes (activity/step) don't run skills.
  if (card.type !== "story") return null;

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  // WS5 — the honest X/Y: exempt/skipped forward steps are excluded from BOTH numerator and denominator
  // (the card never has to satisfy them), so the counter can actually reach Y on a technical card.
  const { done: doneCount, total: totalCount } = stepProgress(rollups);
  const blocked = rollups.some((r) => r.gate === "blocked");
  const footer = (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="tabular-nums text-fg-subtle">
        {doneCount}/{totalCount} passos
      </span>
      {blocked && (
        <Link
          href={`/board/${boardId}/inbox?focus=${cardId}`}
          onClick={stop}
          title="Resolver no Inbox"
          className="inline-flex items-center gap-1 rounded-md bg-fg px-2 py-1 font-semibold text-surface transition hover:bg-fg/85"
        >
          Resolver
        </Link>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Histórico do card — estágio + runs"
        aria-label="Ver histórico do card"
        onPointerDown={stop}
        onClick={toggle}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-muted transition hover:bg-surface-hover hover:text-fg"
      >
        <History className="h-3.5 w-3.5" />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[90]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            />
            <div
              ref={popRef}
              className="fixed z-[91] max-h-[340px] w-[260px] overflow-y-auto rounded-lg border border-line bg-surface p-2 shadow-lg"
              style={{ top: pos.top, left: pos.left }}
              onClick={(e) => e.stopPropagation()}
            >
              {!everLoaded ? (
                <p className="px-1 py-3 text-center text-[11px] text-fg-subtle">Carregando…</p>
              ) : (
                <CardStageHistory density="compact" rollups={rollups} footer={footer} />
              )}
            </div>
          </>,
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
function CardDiffModal({ board, cardId, onClose }: { board: string; cardId: string; onClose: () => void }) {
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
              {/* story-apz8sa: the "Código (stage)" affordance is shown ONLY when the card actually has
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

/**
 * The run's +/− diff totals on a CLOSED, IDLE card footer — the persistent twin of the
 * command strip's +/− (story-wdmio4). While a run is alive the command strip carries the
 * +/−; once the run settles (or the page reloads) the live sub-state is gone, so this
 * resolves the card's most-recent run branch and pulls ONLY the shortstat totals
 * (getCardRunDiffStatAction), lazily and ONLY when a branch resolves — the action fires no
 * git for cards that never ran here, so it's cheap across a whole board. Tapping it opens
 * the SAME CardDiffModal as the command strip (surface reuse, no new screen). Renders
 * nothing until a run branch with real changes resolves (idleDiffVisible: no empty +0 −0).
 *
 * Mount it ONLY in the idle footer (where there's no live sub-state) — the host KanbanCard
 * already swaps the command strip for the idle footer on `substate`.
 */
export function CardIdleDiffBadge({
  boardId,
  cardId,
  substate,
  hasSession,
}: {
  boardId: string;
  cardId: string;
  /** Q1(ii) — resolved substate from the host; `undefined` (omitted) falls back to the live hook. */
  substate?: RunSubstate | null;
  /** Q7 — whether the card has a run session; when provided, gates the POST without re-subscribing. */
  hasSession?: boolean;
}) {
  if (substate !== undefined) {
    return <CardIdleDiffBadgeInner boardId={boardId} cardId={cardId} hasLiveSubstate={!!substate} hasSession={!!hasSession} />;
  }
  return <CardIdleDiffBadgeLive boardId={boardId} cardId={cardId} />;
}

/** Self-subscribing variant — used only when the host passes no `substate` prop. */
function CardIdleDiffBadgeLive({ boardId, cardId }: { boardId: string; cardId: string }) {
  const substate = useRunSubstate(boardId, cardId);
  const hasSession = useCardHasSession(boardId, cardId);
  return <CardIdleDiffBadgeInner boardId={boardId} cardId={cardId} hasLiveSubstate={!!substate} hasSession={hasSession} />;
}

function CardIdleDiffBadgeInner({
  boardId,
  cardId,
  hasLiveSubstate,
  hasSession,
}: {
  boardId: string;
  cardId: string;
  hasLiveSubstate: boolean;
  hasSession: boolean;
}) {
  const [stat, setStat] = useState<{ additions: number; deletions: number } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  // Lazy fetch: while a live sub-state owns the +/− we hold off (the command strip shows it); otherwise
  // resolve the branch + pull the shortstat totals. Q7 — gate on hasSession: a card that never ran here
  // has no session, so it fires NO POST (opening a board no longer bursts N getCardRunDiffStatAction
  // requests for idle, never-run cards). Keyed on the two booleans, not the substate object, so the 30s
  // sub-state tick doesn't re-spawn git — it refetches only on the live→idle transition.
  useEffect(() => {
    if (hasLiveSubstate || !hasSession) {
      setStat(null);
      return;
    }
    let alive = true;
    getCardRunDiffStatAction({ board: boardId, cardId }).then((res) => {
      if (!alive) return;
      setStat(res.ok && res.data ? { additions: res.data.additions, deletions: res.data.deletions } : null);
    });
    return () => {
      alive = false;
    };
  }, [hasLiveSubstate, hasSession, boardId, cardId]);

  if (!idleDiffVisible({ hasLiveSubstate, stat })) return null;

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <button
        type="button"
        title="Ver diff do run (+/−)"
        aria-label="Ver diff do run"
        onPointerDown={stop}
        onClick={(e) => {
          stop(e);
          setDiffOpen(true);
        }}
        className="inline-flex shrink-0 items-center gap-0.5 rounded font-semibold tabular-nums transition hover:opacity-80"
      >
        <span className="text-emerald-700 dark:text-emerald-400">+{stat!.additions}</span>
        <span className="text-rose-600 dark:text-rose-400">−{stat!.deletions}</span>
      </button>
      {diffOpen &&
        createPortal(<CardDiffModal board={boardId} cardId={cardId} onClose={() => setDiffOpen(false)} />, document.body)}
    </>
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
};

// Pretty display name per trigger (the raw id is verbose for harness-sync-card).
const TRIGGER_LABEL: Record<string, string> = {
  "harness-sync-card": "sincronizar",
};
const prettyTrigger = (t: string): string => TRIGGER_LABEL[t] ?? t;

/**
 * Compact live status + an actions kebab for a card. The CARD stays clean: by
 * default only a subtle ⋮ shows (revealed on hover — the host card must be a
 * `group`; kept faintly visible on touch where there's no hover). A compact
 * spinner/alert appears inline ONLY while a run is active or just failed
 * (informational, transient). Every quick action — Sincronizar, Rodar agora,
 * Console, Copiar ID — lives in the ⋮ menu. Drop it inside a RunnerStatusProvider,
 * ideally in the card footer's right cluster.
 */
export function CardRunStatusBadge({
  boardId,
  cardId,
  hasTrigger,
  card,
  config,
  menuOnly = false,
  hideMoves = false,
}: {
  boardId: string;
  cardId: string;
  /** card sits in a column with a `trigger` → expose "Rodar agora" + keep the console reachable */
  hasTrigger?: boolean;
  /** the full card — enables the reopen actions (Refinar / Reportar bug) on a delivered story */
  card?: Card;
  /** the board config — enables the "Mover para" quick action (gate-checked destinations) */
  config?: BoardConfig;
  /** render ONLY the ⋮ menu (no inline run/failure indicator) — used where the command
   * strip already shows the run sub-state badge, to avoid a duplicate indicator. */
  menuOnly?: boolean;
  /** suppress the ⋮ menu's "Mover para" section — used on the minimalist kanban card where a
   * dedicated MoveToPopover already owns that gesture (story-2ulzzl), avoiding a duplicate. */
  hideMoves?: boolean;
}) {
  const { snapshot, sessionByKey, openConsole } = useRunner();
  const logsByKey = useRunnerLogs();
  const router = useRouter();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const [modal, setModal] = useState<"refine" | "bug" | null>(null);
  // A move chosen from the ⋮ menu, held pending an explicit confirmation (guards against
  // accidental clicks — especially during focus mode). Null = no move awaiting confirm.
  const [pendingMove, setPendingMove] = useState<{ statusId: string; statusName: string; color: string } | null>(null);
  const key = keyOf(boardId, cardId);
  const run = snapshot.running.find((r) => r.board === boardId && r.cardId === cardId);
  const failure = snapshot.failures.find((f) => f.board === boardId && f.cardId === cardId);
  const hasLogs = (logsByKey[key]?.length ?? 0) > 0;

  // Any sign of life (running / failed / streaming logs) clears the local "iniciando"
  // spinner — from here the real state comes from the SSE snapshot.
  useEffect(() => {
    if (run || failure || hasLogs) setStarting(false);
  }, [run, failure, hasLogs]);

  // Run the CURRENT COLUMN's skill ("Rodar agora") — needs a column trigger.
  const startRun = async () => {
    if (starting || run) return;
    setStarting(true);
    const res = await runCardSkillAction({ boardId, cardId });
    if (res.ok) toast(`Rodando ${prettyTrigger(res.data?.trigger ?? "skill")} neste card…`, "success");
    else {
      setStarting(false);
      toast(res.error);
    }
  };

  // Reconcile THIS card with the live code + reposition it — works on ANY status.
  const startSync = async () => {
    if (starting || run) return;
    setStarting(true);
    const res = await syncCardAction({ boardId, cardId });
    if (res.ok) toast("Sincronizando este card com o código…", "success");
    else {
      setStarting(false);
      toast(res.error);
    }
  };

  // Copy the deterministic `claude --resume <id>` for THIS card's most-recent run, so
  // the user opens/takes over its terminal in one paste. Resolves the session id from
  // the live context first, then the registry (dev-server lifetime) — mirrors the console.
  const copyResumeCmd = async () => {
    let sessionId = sessionByKey[key];
    if (!sessionId) {
      const res = await getCardSessionIdAction({ board: boardId, cardId });
      if (res.ok && res.data?.sessionId) sessionId = res.data.sessionId;
    }
    if (!sessionId) {
      toast("Esse card ainda não rodou nesta sessão do dev — rode-o (ou Sincronizar) para gerar um terminal.");
      return;
    }
    try {
      await navigator.clipboard.writeText(`claude --resume ${sessionId}`);
      toast("Comando copiado — cole no terminal para abrir/assumir a sessão.", "success");
    } catch {
      toast("Não consegui copiar — abra o Console para copiar manualmente.");
    }
  };

  // Quick-move: change the card's status to one of the gate-passing destinations. The
  // server re-checks the gate (so a stale snapshot can't slip a card past one); on
  // success we refresh so every view reflects the new column.
  const moveTo = async (statusId: string, statusName: string) => {
    if (run) return;
    const res = await moveCardAction({ boardId, cardId, status: statusId });
    if (res.ok) {
      toast(`Movido para “${statusName}”.`, "success");
      router.refresh();
    } else {
      toast(res.error);
    }
  };

  // "Mover para" rows — gate-checked destinations (stories only), recommended first. A row
  // does NOT move immediately: it stages the move for an explicit confirm modal (below).
  const moves: MoveRow[] =
    card?.type === "story" && config && !hideMoves
      ? moveTargets(card, config).map((t) => ({
          key: t.status.id,
          label: t.status.name,
          color: t.status.color ?? "#94a3b8",
          recommended: t.recommended,
          onClick: () =>
            setPendingMove({ statusId: t.status.id, statusName: t.status.name, color: t.status.color ?? "#94a3b8" }),
        }))
      : [];

  // Current column (for the confirm modal's "de → para" preview).
  const currentStatus = config?.statuses.find((s) => s.id === card?.status);

  // A delivered story (in human QA or shipped) can be REOPENED to improve (Refinar) or
  // to fix a regression (Reportar bug). Single source: isReopenableStatus (reopen.ts).
  const canReopen = !!card && isReopenableStatus(card);

  // Quick actions, context-aware. Sincronizar + "copiar comando do terminal" always
  // (the latter resolves the card's last session on click); Rodar agora only on a
  // pipeline column that isn't already running; Console while there's a run/logs or on
  // a pipeline column; Refinar/Reportar bug only on a delivered story.
  const actions: CardAction[] = [
    {
      key: "sync",
      label: "Sincronizar",
      hint: "Revisa o card vs. o código real e o reposiciona na coluna certa",
      icon: RefreshCw,
      tone: "text-sky-500",
      disabled: starting || !!run,
      onClick: startSync,
    },
    ...(hasTrigger && !run
      ? [
          {
            key: "run",
            label: "Rodar agora",
            hint: "Roda a skill desta coluna neste card",
            icon: Play,
            tone: "text-emerald-500",
            disabled: starting,
            onClick: startRun,
          } as CardAction,
        ]
      : []),
    ...(run || hasLogs || hasTrigger
      ? [
          {
            key: "console",
            label: "Console / terminal",
            hint: "Abrir o console ao vivo da run (retomar com claude --resume)",
            icon: SquareTerminal,
            tone: "text-fg-subtle",
            onClick: () => openConsole(boardId, cardId),
          } as CardAction,
        ]
      : []),
    ...(canReopen
      ? [
          {
            key: "refine",
            label: "Refinar",
            hint: "Reabrir esta story para melhoria (UI/UX/copy/funcionalidade)",
            icon: Wand2,
            tone: "text-rose-500",
            onClick: () => setModal("refine"),
          } as CardAction,
          {
            key: "bug",
            label: "Reportar bug",
            hint: "Reabrir esta story para corrigir uma regressão (harness-fix)",
            icon: Bug,
            tone: "text-red-500",
            onClick: () => setModal("bug"),
          } as CardAction,
        ]
      : []),
    {
      key: "resume",
      label: "Copiar comando do terminal",
      hint: "Copiar `claude --resume <id>` para abrir/assumir num terminal a run deste card",
      icon: Copy,
      tone: "text-fg-subtle",
      onClick: copyResumeCmd,
    },
  ];

  return (
    <>
      <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {menuOnly ? null : run ? (
        <RunningBadge trigger={run.trigger} startedAt={run.startedAt} />
      ) : failure ? (
        <span
          title={
            failure.detail
              ? `${prettyTrigger(failure.trigger)} ${FAILURE_LABEL[failure.reason]} — ${failure.detail}`
              : `${prettyTrigger(failure.trigger)} ${FAILURE_LABEL[failure.reason]}`
          }
          className="inline-flex items-center rounded bg-rose-50 px-1 py-0.5 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300"
        >
          <AlertTriangle className="h-3 w-3" />
        </span>
      ) : starting ? (
        <Loader2 className="h-3 w-3 animate-spin text-accent" />
      ) : null}

      <CardActionsMenu actions={actions} moves={moves} />
      </span>

      {card &&
        modal === "refine" &&
        createPortal(
          <RefineModal
            boardId={boardId}
            card={card}
            statuses={config?.statuses}
            onCancel={() => setModal(null)}
            onDone={() => {
              setModal(null);
              toast("Story movida para Refinar — recarregue (⟳) para vê-la lá.", "success");
            }}
          />,
          document.body,
        )}
      {card &&
        modal === "bug" &&
        createPortal(
          <BugModal
            boardId={boardId}
            card={card}
            statuses={config?.statuses}
            onCancel={() => setModal(null)}
            onDone={() => {
              setModal(null);
              toast("Bug reportado — recarregue (⟳) para ver o card no fluxo de correção.", "success");
            }}
          />,
          document.body,
        )}
      {card &&
        pendingMove &&
        createPortal(
          <ConfirmDialog
            title="Mover card"
            description={card.title}
            confirmLabel="Mover"
            onCancel={() => setPendingMove(null)}
            onConfirm={() => {
              const { statusId, statusName } = pendingMove;
              setPendingMove(null);
              moveTo(statusId, statusName);
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

/** One row in the card actions (⋮) menu. */
interface CardAction {
  key: string;
  label: string;
  hint?: string;
  icon: typeof RefreshCw;
  /** icon color class */
  tone?: string;
  disabled?: boolean;
  onClick: () => void;
}

/** One destination in the "Mover para" section — a gate-passing target column. */
interface MoveRow {
  key: string;
  label: string;
  /** the status dot colour */
  color: string;
  /** the single recommended next stage (rendered first, accented) */
  recommended: boolean;
  onClick: () => void;
}

/**
 * The ⋮ kebab + its dropdown of quick actions. The button is hover-revealed on a
 * `group` card (kept faintly visible on touch, where there's no hover), so the card
 * reads clean until you reach for it. The menu renders in a portal at <body> with
 * fixed positioning from the button rect, so neither the card's drag `transform` nor
 * the column's `overflow` clips it; it flips above the button when low in the
 * viewport. Closes on click-away, Escape, scroll or resize.
 */
function CardActionsMenu({ actions, moves = [] }: { actions: CardAction[]; moves?: MoveRow[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // rows ≈ 34px each; + a labelled "Mover para" header (~22px) and divider when present.
    const moveH = moves.length ? moves.length * 32 + 30 : 0;
    const menuH = actions.length * 34 + moveH + 8;
    const openUp = r.bottom + menuH + 8 > window.innerHeight;
    setPos({
      top: openUp ? Math.max(8, r.top - menuH - 4) : r.bottom + 4,
      right: Math.max(8, window.innerWidth - r.right),
    });
  };

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    place();
    setOpen(true);
  };

  // Close on scroll/resize (the fixed menu would otherwise detach from the button)
  // and on Escape.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Ações do card"
        aria-label="Ações do card"
        onClick={toggle}
        className={cn(
          "inline-flex items-center rounded p-0.5 text-fg-subtle transition",
          "hover:bg-surface-hover hover:text-fg-muted",
          // Clean by default: hidden until the card is hovered (it's a `group`);
          // faintly visible on touch (no hover); solid while the menu is open.
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60",
          open && "bg-surface-hover text-fg-muted opacity-100",
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[90]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            />
            <div
              className="fixed z-[91] min-w-[200px] rounded-lg border border-line bg-surface p-1 shadow-lg"
              style={{ top: pos.top, right: pos.right }}
              onClick={(e) => e.stopPropagation()}
            >
              {moves.length > 0 && (
                <>
                  <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                    Mover para
                  </p>
                  {moves.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      title={m.recommended ? `${m.label} — próximo passo recomendado` : `Mover para ${m.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        m.onClick();
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium transition hover:bg-surface-hover",
                        m.recommended ? "text-fg" : "text-fg-muted",
                      )}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: m.color }}
                      />
                      <span className="min-w-0 flex-1 truncate">{m.label}</span>
                      {m.recommended && (
                        <Sparkles className="h-3 w-3 shrink-0 text-accent" />
                      )}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-line-muted" />
                </>
              )}
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  disabled={a.disabled}
                  title={a.hint}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    a.onClick();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <a.icon className={cn("h-3.5 w-3.5 shrink-0", a.tone)} />
                  {a.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/** Compact running indicator (spinner + elapsed) for the card footer. */
function RunningBadge({ trigger, startedAt }: { trigger: string; startedAt: number }) {
  // Own the 1s tick locally so only the badge re-renders, not the whole card tree.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = formatElapsed(now - startedAt);
  const long = now - startedAt > 5 * 60_000;

  return (
    <span
      title={`Rodando ${prettyTrigger(trigger)} há ${elapsed}`}
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums",
        long
          ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
          : "bg-accent/10 text-accent",
      )}
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      {elapsed}
    </span>
  );
}

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
