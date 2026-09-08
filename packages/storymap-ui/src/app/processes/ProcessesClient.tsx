"use client";

// The live body of the Processos page, reorganized BY OPERATOR ATTENTION (not by type):
//
//   1. A compact, collapsible VPS health strip (RAM/disk/Claude quota).
//   2. "Travados · precisam de intervenção" — the ONLY thing that should pull the operator in:
//      blocked merges (gate-failed/conflict) + failed/interrupted runs + preserved branches that
//      still carry uncommitted CODE. Hidden entirely when nothing is stuck. (Distinct from the
//      board "Inbox": that surfaces PRODUCT demands — agent questions, card approvals — this
//      surfaces PROCESS failures.)
//   3. "Rodando agora" — the calm live list, filterable by ORIGIN (kanban/ajuda/merge/manual/
//      externo). Technical metadata (id/cost/tokens) is hidden until row hover.
//   4. "Arquivo & recuperação" — one collapsed disclosure folding everything that's safe to ignore:
//      finished services, superseded (safe-to-discard) branches, and the merge-train history.
//
// Runner runs update instantly via the SSE runner snapshot; tmux rows re-poll GET /api/processes
// every 8s. The whole service row links to /processes/<id>; action clusters stop propagation.

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { sharedEventSource } from "@/lib/sse-bus";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Archive, ChevronDown, ChevronRight, GitMerge, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMergeQueue, useRunnerSnapshot } from "@/components/RunnerStatusProvider";
import { discardPreservedBranchAction, resolveGateFailedAction, resolveMergeConflictAction } from "@/app/actions";
import type { MergeQueueEntry, MergeQueueStatus } from "@/lib/storymap/runner/types";
import type { PreservedBranch } from "@/lib/storymap/runner/preserved-branches";
import type { HelperAgent } from "@/lib/vps/helper-registry";
import { laneOf, type OriginKind, type RunningService, type ServiceStatus } from "@/lib/vps/types";
import { MeterRow, PROMPT_INDENT, PromptLine, StateChip, stripLineMarker } from "@/components/terminal/parts";
import { useServiceMeters, type MeterMap } from "@/components/terminal/useServiceMeters";
import { meterFallback, type ServiceMeter } from "@/lib/vps/service-meters";
import { inboxFocusHref } from "@/lib/storymap/deep-links";
import { mergeEntryEscalation, preservedBranchEscalation, resolveProcessAnchor } from "@/lib/storymap/copilot/process-escalation";
import { EscalateButton } from "@/components/copilot/EscalateButton";
// WS-5 — surface parity: the failed MergeQueueRow gets the SAME Reenfileirar the Inbox offers.
import { QuickActionButton } from "@/components/QuickActionButton";
import { mergeFailedActionsFor } from "@/lib/storymap/quick-actions";
import { ProcessActions } from "./ProcessActions";

/** `mq:<runId>` / `svc:<serviceId>` row key — the §4.6 receptor's scroll+ring target. */
function mqRowKey(runId: string): string {
  return `mq:${runId}`;
}
function svcRowKey(serviceId: string): string {
  return `svc:${serviceId}`;
}

// `formatElapsed` / `formatTokens` / `formatCost` / `STATUS_META` used to live here, and are gone with the
// things they fed: the status badge asserted "rodando" from `status === "running"` (process liveness, NOT
// work); the uptime measured how long the process had existed, which never answered whether it was
// producing; and cost/tokens hid behind a hover. All of it now comes from the meters — `StateChip` reads
// the CLI's own busy/idle flag, `MeterRow` prints cost beside contexto/diff. See components/terminal/parts.tsx.

// --- origin lens ------------------------------------------------------------

const ORIGIN_META: Record<OriginKind, { label: string; hex: string; hint: string }> = {
  kanban: { label: "kanban", hex: "#3b82f6", hint: "disparado pela cascata do autorun (card avançando no pipeline)" },
  ajuda: { label: "ajuda", hex: "#8b5cf6", hint: "assistente de painel (Lean Canvas, Posicionamento, Ideias…)" },
  merge: { label: "merge", hex: "#14b8a6", hint: "merge train integrando / regenerando após conflito" },
  manual: { label: "manual", hex: "#64748b", hint: "você disparou (Rodar agora / Sincronizar / terminal)" },
  externo: { label: "externo", hex: "#f97316", hint: "claude iniciado fora do sistema (SSH / tmux manual)" },
};
const ORIGIN_ORDER: OriginKind[] = ["kanban", "ajuda", "merge", "manual", "externo"];

function OriginChip({ origin }: { origin?: OriginKind }) {
  if (!origin) return null;
  const m = ORIGIN_META[origin];
  return (
    <span
      title={m.hint}
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ backgroundColor: `${m.hex}1a`, color: m.hex }}
    >
      {m.label}
    </span>
  );
}

// The page's own VPS/quota strip used to live here. It is GONE on purpose: it read the ccusage
// ESTIMATE (`metrics.tokens.usedPct` → "85%") while the navbar's HealthPill reads the REAL
// subscription window (`metrics.usage.week`), so the same box reported two different quotas
// depending on the page you were standing on. Two implementations of one number is a bug generator,
// not a feature — the page now wears the app's topnav (which carries HealthPill), leaving exactly
// ONE quota gauge in the product. RAM/disk live in that same pill.

// --- SM-2 merge train -------------------------------------------------------

const MQ_STATUS_META: Record<MergeQueueStatus, { label: string; hex: string }> = {
  waiting: { label: "aguardando", hex: "#94a3b8" }, // slate
  "gate-running": { label: "validando", hex: "#0ea5e9" }, // sky — gate suite running in staging
  "gate-failed": { label: "gate reprovou", hex: "#f43f5e" }, // rose — paused awaiting operator
  merging: { label: "mergeando", hex: "#10b981" }, // emerald
  conflict: { label: "conflito", hex: "#f43f5e" }, // rose
  "re-driving": { label: "regenerando", hex: "#8b5cf6" }, // violet — conflict re-driven (story-92ldyt)
  done: { label: "concluído", hex: "#94a3b8" }, // slate (history)
  failed: { label: "falhou", hex: "#f59e0b" }, // amber
  // WS-1.4 — terminal, and deliberately NOT rose/amber: nothing is stuck and nobody needs to act. The
  // conflict went back to the live agent session that wrote the code, which resolves + re-submits on its own.
  "returned-to-session": { label: "devolvido à sessão", hex: "#8b5cf6" }, // violet — like re-driving: regenerating elsewhere
};

function MergeQueueRow({
  entry,
  focused = false,
  rowRef,
}: {
  entry: MergeQueueEntry;
  /** WS-4 §4.6 — the receptor rings this row for ~2s when `?run=<entry.runId>` anchors it. */
  focused?: boolean;
  rowRef?: (el: HTMLLIElement | null) => void;
}) {
  const meta = MQ_STATUS_META[entry.status];
  const [busy, setBusy] = useState(false);
  // WS-4 §4.2 — conflict/gate-failed/failed escalate; the other 5 statuses get null (no button).
  const esc = mergeEntryEscalation(entry);
  // WS-5 — Reenfileirar (terminal-retry) for a `failed` entry: the registry's decision, config-free.
  // WS-1.3: a card-less session entry has no card to re-drive INTO, so it gets no requeue button — its
  // owner is the live session, which re-submits from its own worktree (`worktree_refresh` + `worktree_submit`).
  const requeueAction =
    entry.status === "failed" && entry.cardId
      ? mergeFailedActionsFor({
          id: `${entry.cardId}:merge-failed:${entry.runId}`,
          kind: "merge-failed",
          boardId: entry.board,
          cardId: entry.cardId,
          cardTitle: "",
          status: null,
          lane: "travado",
          severity: "high",
          runId: entry.runId,
          branch: entry.branch,
          failureReason: entry.failureReason,
        }).primary
      : null;

  const resolve = useCallback(
    async (action: "merged" | "aborted") => {
      setBusy(true);
      try {
        await resolveMergeConflictAction({ runId: entry.runId, action });
      } finally {
        setBusy(false);
      }
    },
    [entry.runId],
  );

  const resolveGate = useCallback(
    async (action: "retry" | "abort") => {
      setBusy(true);
      try {
        await resolveGateFailedAction({ runId: entry.runId, action });
      } finally {
        setBusy(false);
      }
    },
    [entry.runId],
  );

  return (
    <li
      ref={rowRef}
      className={cn(
        "flex items-start gap-2 rounded border border-line bg-surface px-2 py-1.5 transition-shadow",
        focused && "ring-2 ring-accent",
      )}
    >
      <span
        className="mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
        style={{ backgroundColor: `${meta.hex}1a`, color: meta.hex }}
      >
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[12px] font-medium text-fg">{entry.cardId}</span>
          <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
            {entry.board}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-fg-subtle opacity-0 transition group-hover/mq:opacity-100">
            {entry.branch}
          </span>
        </div>
        {entry.status === "conflict" && entry.conflictDetail && (
          <p className="mt-1 truncate font-mono text-[10px] text-rose-600 dark:text-rose-400" title={entry.conflictDetail}>
            {entry.conflictDetail}
          </p>
        )}
        {entry.status === "gate-failed" && entry.gateLog && (
          <p className="mt-1 truncate font-mono text-[10px] text-rose-600 dark:text-rose-400" title={entry.gateLog}>
            {entry.gateLog}
          </p>
        )}
        {entry.status === "failed" && entry.failureReason && (
          <p className="mt-1 truncate text-[10px] text-fg-muted" title={entry.failureReason}>
            {entry.failureReason}
          </p>
        )}
      </div>
      {entry.status === "gate-failed" && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => resolveGate("retry")}
            className="rounded border border-sky-500/40 px-2 py-1 text-[11px] font-medium text-sky-600 transition hover:bg-sky-500/10 disabled:opacity-50 dark:text-sky-400"
          >
            Tentar de novo
          </button>
          {esc && <EscalateButton target={esc.ref} surface="processes" label="Copiloto: investigar gate" size="sm" />}
          <button
            type="button"
            disabled={busy}
            onClick={() => resolveGate("abort")}
            className="rounded border border-rose-500/40 px-2 py-1 text-[11px] font-medium text-rose-600 transition hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-400"
          >
            Abortar
          </button>
        </div>
      )}
      {entry.status === "conflict" && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve("merged")}
            className="rounded border border-emerald-500/40 px-2 py-1 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400"
          >
            Resolver
          </button>
          {esc && <EscalateButton target={esc.ref} surface="processes" label="Copiloto: resolver conflito" size="sm" />}
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve("aborted")}
            className="rounded border border-rose-500/40 px-2 py-1 text-[11px] font-medium text-rose-600 transition hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-400"
          >
            Abortar
          </button>
        </div>
      )}
      {entry.status === "failed" && (requeueAction || esc) && (
        <div className="flex shrink-0 items-center gap-1">
          {requeueAction && (
            <QuickActionButton action={requeueAction} boardId={entry.board} cardId={entry.cardId} surface="processes" size="sm" />
          )}
          {esc && <EscalateButton target={esc.ref} surface="processes" label="Copiloto: recuperar run" size="sm" />}
        </div>
      )}
    </li>
  );
}

// --- preserved run branches (off the merge train) ---------------------------

function PreservedBranchRow({
  b,
  onDiscard,
  pending,
}: {
  b: PreservedBranch;
  onDiscard: (branch: string) => void;
  pending: boolean;
}) {
  // The badge states the VERDICT, and the line under it states WHY — because "revisar" with no
  // reason is what let a branch holding nothing sit in the attention panel for a week.
  const badge = b.needsAttention
    ? { label: b.verdict === "unknown" ? "indefinido" : "código", tone: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" }
    : b.superseded
      ? { label: "superado", tone: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" }
      : { label: "revisar", tone: "bg-surface-hover text-fg-muted" };
  // WS-4 §4.4 — the "não descarte sem tentar recuperar" 1-clique; null for superseded/board-less.
  const esc = preservedBranchEscalation(b);

  return (
    // Content on top (badge + full-width text), actions on their OWN wrapping row below — the same shape the
    // service/fleet rows use. The old single horizontal flex crushed the title to one-word-per-line on mobile
    // (the operator's main surface) and let the invisible hover hints reserve ~12 empty lines on desktop.
    <li className="group/br rounded-md border border-line bg-surface p-2.5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
            badge.tone,
          )}
          title={b.reason}
        >
          {badge.label}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
            {b.board && b.cardId ? (
              <Link
                href={inboxFocusHref(b.board, b.cardId)}
                title="Abrir no Inbox"
                className="font-medium text-fg transition hover:text-accent"
              >
                {b.cardTitle ?? b.cardId}
              </Link>
            ) : (
              <span className="font-medium text-fg-muted">{b.subject || b.branch}</span>
            )}
            {b.cardStatus && <span className="rounded bg-surface-hover px-1 text-[10px] text-fg-subtle">{b.cardStatus}</span>}
            {b.touchesCode && (
              <span className="rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                {b.filesChanged} arq · com código
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-fg-muted">{b.reason}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-fg-subtle">
            <span>{b.ageRelative}</span>
            {b.ownCommits > 0 && <span>{b.ownCommits} commit(s) do run</span>}
            {/* branch hash + recovery command: technical noise for desktop power users — `hidden` (not
                opacity-0) so it reserves ZERO height when not hovered instead of ballooning the row. */}
            <span className="hidden truncate font-mono group-hover/br:inline">{b.branch}</span>
            {!b.superseded && (
              <span className="hidden truncate font-mono text-fg-muted group-hover/br:inline" title="recuperar manualmente">
                {b.recoverHint}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {esc && <EscalateButton target={esc.ref} surface="processes" label="Recuperar com o Jido" size="sm" />}
        <button
          onClick={() => onDiscard(b.branch)}
          disabled={pending}
          className="rounded-md border border-line px-2 py-1 text-[11px] text-fg-subtle transition hover:border-rose-300 hover:text-rose-600 disabled:opacity-40 dark:hover:text-rose-300"
          title="git branch -D (irreversível)"
        >
          Descartar
        </button>
      </div>
    </li>
  );
}

// --- one service row --------------------------------------------------------

function ServiceRow({
  service,
  meter,
  onChanged,
  focused = false,
  rowRef,
}: {
  service: RunningService;
  /** the row's meters (state/contexto/custo/diff); absent until the 15s poll answers → fallback */
  meter?: ServiceMeter;
  onChanged: () => void;
  /** WS-4 §4.6 — the receptor rings this row for ~2s when `?svc=<service.id>` anchors it. */
  focused?: boolean;
  rowRef?: (el: HTMLLIElement | null) => void;
}) {
  const m = meter ?? meterFallback(service);
  // No uptime, and therefore no per-second clock: "⏱ 3h 04m" measured how long the process had existed,
  // which says nothing about whether it is producing — the meters answer that. Dropping it also drops a
  // setInterval that re-rendered every live row once a second for a number nobody could act on.
  // What the row is DOING, in one line: the server's derived activity for a tmux session, else the
  // failure/outcome detail for a run. Never truncated — see the prompt line below.
  const raw = service.activity ?? service.detail ?? null;
  const activity = raw ? stripLineMarker(raw) : null;

  return (
    // The whole row links to the detail via a STRETCHED overlay <Link> (absolute, z-0): the
    // row content/actions sit above it (relative, z-10), so the card link, the action buttons
    // and the "Abrir terminal" <a> stay clickable WITHOUT illegally nesting them in an anchor.
    <li ref={rowRef} className={cn("group relative rounded-md transition-shadow", focused && "ring-2 ring-accent")}>
      <Link
        href={`/processes/${encodeURIComponent(service.id)}`}
        aria-label={`Detalhes de ${service.label}`}
        className="absolute inset-0 z-0 rounded-md border border-line transition group-hover:border-line-emphasis"
      />
      <div className="pointer-events-none relative z-10 rounded-md bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* The state WORD, from the CLI's own busy/idle flag — replaces the process-liveness badge that
              painted "rodando" on a session that had been sitting at a prompt for hours. */}
          {/* When this row has an activity line, ITS dots carry the working signal — no second set here. */}
          <StateChip meter={m} hideWorking={Boolean(activity)} />
          <OriginChip origin={service.origin} />
          <span className="text-[13px] font-medium text-fg">{service.label}</span>
          {service.board && service.cardId && (
            <Link
              href={inboxFocusHref(service.board, service.cardId)}
              onClick={(e) => e.stopPropagation()}
              title="Abrir o card no Inbox"
              className="pointer-events-auto relative shrink-0 truncate rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-accent hover:underline"
            >
              {service.cardTitle ?? service.cardId}
            </Link>
          )}
          <span className="flex items-center gap-x-2 text-[10px] text-fg-subtle opacity-0 transition group-hover:opacity-100">
            <span className="font-mono">{service.id}</span>
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-subtle">
          {service.board && <span className="font-medium text-fg-muted">{service.board}</span>}
          {service.trigger && (
            <>
              {service.board && <span>·</span>}
              <span>{service.trigger}</span>
            </>
          )}
        </div>

        {/* The prompt line — what it is doing, ENTIRE. It used to be a `truncate`d tail of the metadata
            row, which is where the sentence that actually explains the row went to die. */}
        {activity && (
          <div className="mt-1.5 font-mono">
            <PromptLine
              state={m.state}
              muted={m.state !== "working" && m.state !== "failed"}
              danger={m.state === "failed"}
            >
              {activity}
            </PromptLine>
          </div>
        )}

        <MeterRow meter={m} className={cn("mt-1.5", activity && PROMPT_INDENT)} />

        {/* actions — pointer-events re-enabled; each button stops propagation itself */}
        <div className="pointer-events-auto relative mt-2">
          <ProcessActions service={service} size="sm" onChanged={onChanged} />
        </div>
      </div>
    </li>
  );
}

// --- origin filter ----------------------------------------------------------

function OriginFilter({
  origins,
  value,
  onChange,
}: {
  origins: OriginKind[];
  value: OriginKind | null;
  onChange: (v: OriginKind | null) => void;
}) {
  if (origins.length <= 1) return null; // a single origin needs no filter
  const chip = (active: boolean, hex?: string) =>
    cn(
      "rounded-full border px-2 py-0.5 text-[11px] font-medium transition",
      active ? "border-transparent text-white" : "border-line text-fg-muted hover:text-fg",
    );
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" onClick={() => onChange(null)} className={chip(value == null)} style={value == null ? { backgroundColor: "#475569" } : undefined}>
        Todos
      </button>
      {origins.map((o) => {
        const active = value === o;
        const m = ORIGIN_META[o];
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange(active ? null : o)}
            title={m.hint}
            className={chip(active)}
            style={active ? { backgroundColor: m.hex } : undefined}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

// --- the page body ----------------------------------------------------------

export function ProcessesClient({
  initialServices,
  initialPreserved,
  fleet,
}: {
  initialServices: RunningService[];
  initialPreserved: PreservedBranch[];
  /** the agent fleet, rendered between "Rodando" and the archive so living agents sit near the top. */
  fleet?: ReactNode;
}) {
  const [services, setServices] = useState<RunningService[]>(initialServices);
  // ONE meters poll for the whole page, passed down — a hook per row would open N polls of an endpoint
  // that costs a transcript read and two git spawns per session.
  const meters = useServiceMeters();
  const mq = useMergeQueue();
  // WS-4 §4.6 — the receptor: ?run=<runId> / ?svc=<serviceId> anchor a row instead of leaving the
  // operator to scroll-and-hunt (the emission side is the "Ver processos" links of the stuck/conflict
  // renderers — WS-3's CockpitView + this WS's §4.1 helpers).
  const searchParams = useSearchParams();
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [ringedKey, setRingedKey] = useState<string | null>(null);
  const registerRow = useCallback(
    (key: string) => (el: HTMLLIElement | null) => {
      if (el) rowRefs.current.set(key, el);
      else rowRefs.current.delete(key);
    },
    [],
  );
  // Headless runner runs ride the SSE snapshot → reflect "running" instantly. tmux rows
  // (master/shell/card/adhoc) aren't on SSE, so we re-poll the route for those.
  const { running: liveRunning } = useRunnerSnapshot();

  // Preserved branches — local optimistic state (server-rendered initial, discarded inline).
  const [branches, setBranches] = useState<PreservedBranch[]>(initialPreserved);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const discardBranch = useCallback((branch: string) => {
    setBranchError(null);
    startTransition(async () => {
      const res = await discardPreservedBranchAction({ branch });
      if (res.ok) setBranches((bs) => bs.filter((b) => b.branch !== branch));
      else setBranchError(res.error);
    });
  }, []);

  const [originFilter, setOriginFilter] = useState<OriginKind | null>(null);
  const [helpers, setHelpers] = useState<HelperAgent[]>([]);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/processes", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { services: RunningService[] };
      if (Array.isArray(json.services)) setServices(json.services);
    } catch {
      /* keep the last good snapshot on a transient fetch error */
    }
  }, []);

  // 8s poll for the tmux side of the list; cleared on unmount.
  useEffect(() => {
    const t = setInterval(refetch, 8000);
    return () => clearInterval(t);
  }, [refetch]);

  // Ephemeral helper agents (panel assistants) ride a DEDICATED SSE channel so a short-lived one
  // shows up in real time without waiting for the 8s poll. The browser auto-reconnects on error.
  useEffect(() => {
    const es = sharedEventSource("/api/processes/stream");
    const onHelpers = (e: MessageEvent) => {
      try {
        setHelpers(JSON.parse(e.data) as HelperAgent[]);
      } catch {
        /* ignore a malformed frame */
      }
    };
    es.addEventListener("helpers", onHelpers as EventListener);
    return () => es.close();
  }, []);

  // Overlay live SSE runner runs onto the polled list (merge by id) so a just-started run
  // shows without waiting 8s. Preserve a row's derived origin; a fresh SSE-only run is the
  // autorun cascade → "kanban".
  const merged = useMemo(() => {
    const byId = new Map(services.map((s) => [s.id, s] as const));
    for (const r of liveRunning) {
      const id = `run:${r.board}/${r.cardId}`;
      const existing = byId.get(id);
      if (existing) {
        byId.set(id, { ...existing, status: "running", startedAt: r.startedAt, trigger: r.trigger });
      } else {
        byId.set(id, {
          id,
          kind: "runner-run",
          lane: laneOf("runner-run"),
          label: `${r.trigger} · ${r.cardId}`,
          status: "running",
          origin: "kanban",
          board: r.board,
          cardId: r.cardId,
          cardTitle: undefined,
          trigger: r.trigger,
          sessionId: r.sessionId,
          attachable: true,
          startedAt: r.startedAt,
          costUSD: r.usage?.costUSD ?? null,
          tokens: r.usage?.tokens ?? null,
        });
      }
    }
    const STATUS_RANK: Record<ServiceStatus, number> = { running: 0, interrupted: 1, failed: 2, idle: 3, done: 4 };
    return Array.from(byId.values()).sort(
      (a, z) => STATUS_RANK[a.status] - STATUS_RANK[z.status] || (z.startedAt ?? 0) - (a.startedAt ?? 0),
    );
  }, [services, liveRunning]);

  // Partition by ATTENTION.
  // `useMemo` na ORIGEM: sem ele este array nascia novo a cada render, e o `useMemo` de
  // `mergeStatusByRunId` (que depende dele) recalculava sempre — memoização que não memoizava nada.
  // Calar o aviso teria mantido o desperdício; memoizar aqui o remove de verdade.
  const mqEntries = useMemo(() => mq?.entries ?? [], [mq]);
  const mqBlocked = mqEntries.filter((e) => e.status === "gate-failed" || e.status === "conflict");
  const mqActive = mqEntries.filter(
    (e) => e.status === "waiting" || e.status === "gate-running" || e.status === "merging" || e.status === "re-driving",
  );
  const mqHistory = mqEntries.filter((e) => e.status === "done" || e.status === "failed");

  // Ephemeral helper agents (SSE) → transient "ajuda" rows shown only while they run.
  const helperServices: RunningService[] = helpers.map((h) => ({
    id: `helper:${h.id}`,
    kind: "helper-agent",
    lane: laneOf("helper-agent"),
    label: h.cardId ? `${h.label} · ${h.cardId}` : h.label,
    status: "running",
    origin: "ajuda",
    board: h.board,
    cardId: h.cardId,
    attachable: false,
    startedAt: h.startedAt,
    pid: h.pid,
    detail: h.view,
  }));

  const stuckSvc = merged.filter((s) => s.status === "failed" || s.status === "interrupted");
  const liveSvc = [...merged.filter((s) => s.status === "running" || s.status === "idle"), ...helperServices];
  const doneSvc = merged.filter((s) => s.status === "done");

  // §4.6 — resolve the anchor from the CURRENT snapshot (mq entries + every known service id, incl.
  // helpers). An unknown id (run left the queue, service died post-restart) resolves to null — silent,
  // the page just opens normally (no toast, invariant: the param isn't `?copilot=`, so it's never cleaned).
  const mergeStatusByRunId = useMemo(() => new Map(mqEntries.map((e) => [e.runId, e.status] as const)), [mqEntries]);
  const serviceIds = useMemo(
    () => new Set([...merged, ...helperServices].map((s) => s.id)),
    [merged, helperServices],
  );
  const anchor = useMemo(
    () => resolveProcessAnchor({ run: searchParams.get("run"), svc: searchParams.get("svc") }, mergeStatusByRunId, serviceIds),
    [searchParams, mergeStatusByRunId, serviceIds],
  );
  const anchorKey = anchor ? (anchor.kind === "merge" ? mqRowKey(anchor.runId) : svcRowKey(anchor.serviceId)) : null;
  const anchorInArchive = anchor?.kind === "merge" && anchor.archived;

  // Scroll to + ring the anchored row for ~2s once it's registered (mirrors CockpitView.tsx's ?focus=).
  useEffect(() => {
    if (!anchorKey) return;
    const el = rowRefs.current.get(anchorKey);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setRingedKey(anchorKey);
    const t = setTimeout(() => setRingedKey(null), 2000);
    return () => clearTimeout(t);
  }, [anchorKey]);

  // THE LANE SPLIT — "rodando agora" answers "is the machine working?", so it holds ONLY pipeline
  // work. A human's shell and a claude started by hand over SSH are real and stay one click away,
  // but they are not the board making progress: counting them is what let an idle pipeline read as
  // "5 rodando" (two of which were the operator's own session, and one the page's own Bash call).
  const pipelineSvc = liveSvc.filter((s) => s.lane === "pipeline");
  const offPipelineSvc = liveSvc.filter((s) => s.lane !== "pipeline");

  // TRAVADO = the branch is holding real work hostage (see preserved-branches.needsAttention) — NOT
  // merely "not superseded", which used to drag every board-data leftover into the alarm panel.
  const attentionBranches = branches.filter((b) => b.needsAttention);
  const supersededBranches = branches.filter((b) => b.superseded);
  const reviewBranches = branches.filter((b) => !b.needsAttention && !b.superseded);

  const hasAttention = mqBlocked.length > 0 || stuckSvc.length > 0 || attentionBranches.length > 0;

  // "Rodando agora" — pipeline services + the in-flight merge train, filterable by origin.
  const presentOrigins = ORIGIN_ORDER.filter((o) => pipelineSvc.some((s) => s.origin === o));
  const filteredLive = originFilter ? pipelineSvc.filter((s) => s.origin === originFilter) : pipelineSvc;

  const archiveCount =
    supersededBranches.length + reviewBranches.length + mqHistory.length + doneSvc.length;

  return (
    <>
      {hasAttention ? (
        <section className="mb-6 border-l-2 border-amber-400 pl-3 dark:border-amber-500/60">
          <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            Travados · precisam de intervenção
            <span className="text-fg-subtle">· {mqBlocked.length + stuckSvc.length + attentionBranches.length}</span>
          </h2>
          <div className="space-y-2">
            {mqBlocked.length > 0 && (
              <ul className="group/mq space-y-1.5">
                {mqBlocked.map((entry) => (
                  <MergeQueueRow
                    key={entry.runId}
                    entry={entry}
                    focused={ringedKey === mqRowKey(entry.runId)}
                    rowRef={registerRow(mqRowKey(entry.runId))}
                  />
                ))}
              </ul>
            )}
            {stuckSvc.length > 0 && (
              <ul className="space-y-2">
                {stuckSvc.map((svc) => (
                  <ServiceRow
                    key={svc.id}
                    service={svc}
                    meter={meters[svc.id]}
                    onChanged={refetch}
                    focused={ringedKey === svcRowKey(svc.id)}
                    rowRef={registerRow(svcRowKey(svc.id))}
                  />
                ))}
              </ul>
            )}
            {attentionBranches.length > 0 && (
              <ul className="space-y-1.5">
                {attentionBranches.map((b) => (
                  <PreservedBranchRow key={b.branch} b={b} onDiscard={discardBranch} pending={pending} />
                ))}
              </ul>
            )}
          </div>
          {branchError && <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-300">{branchError}</p>}
        </section>
      ) : (
        <p className="mb-6 flex items-center gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
          <span aria-hidden>✓</span> Tudo em ordem — nada pede intervenção agora.
        </p>
      )}

      <section>
        <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight text-fg">
            Rodando no pipeline <span className="text-fg-subtle">· {pipelineSvc.length + mqActive.length}</span>
          </h2>
          <OriginFilter origins={presentOrigins} value={originFilter} onChange={setOriginFilter} />
        </header>

        {mqActive.length > 0 && (
          <div className="group/mq mb-2 flex items-center gap-1.5 text-[11px] text-fg-muted">
            <GitMerge className="h-3.5 w-3.5 text-fg-subtle" />
            <span>
              Fila de merge {mq?.processing ? "· processando" : ""} — {mqActive.length} em andamento
            </span>
          </div>
        )}
        {mqActive.length > 0 && (
          <ul className="group/mq mb-2 space-y-1.5">
            {mqActive.map((entry) => (
              <MergeQueueRow
                key={entry.runId}
                entry={entry}
                focused={ringedKey === mqRowKey(entry.runId)}
                rowRef={registerRow(mqRowKey(entry.runId))}
              />
            ))}
          </ul>
        )}

        {filteredLive.length > 0 ? (
          <ul className="space-y-2">
            {filteredLive.map((svc) => (
              <ServiceRow
                key={svc.id}
                service={svc}
                meter={meters[svc.id]}
                onChanged={refetch}
                focused={ringedKey === svcRowKey(svc.id)}
                rowRef={registerRow(svcRowKey(svc.id))}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-line bg-surface p-6 text-center text-sm text-fg-muted">
            {pipelineSvc.length === 0
              ? "Nada rodando no pipeline agora."
              : "Nenhum processo com esse filtro de origem."}
          </p>
        )}
      </section>

      {fleet}

      {offPipelineSvc.length > 0 && (
        <OffPipelineDisclosure services={offPipelineSvc} meters={meters} onChanged={refetch} />
      )}

      {archiveCount > 0 && (
        <ArchiveDisclosure
          doneSvc={doneSvc}
          supersededBranches={supersededBranches}
          reviewBranches={reviewBranches}
          mqHistory={mqHistory}
          onDiscardBranch={discardBranch}
          onDiscardAllSuperseded={() => supersededBranches.forEach((b) => discardBranch(b.branch))}
          pending={pending}
          onChanged={refetch}
          defaultOpen={anchorInArchive}
          ringedKey={ringedKey}
          registerRow={registerRow}
        />
      )}
    </>
  );
}

/** Terminals and hand-started claudes: REAL processes (inspectable, killable) that are simply not the
 *  board working. Folded away by default so they can never be mistaken for pipeline activity again. */
function OffPipelineDisclosure({
  services,
  meters,
  onChanged,
}: {
  services: RunningService[];
  meters: MeterMap;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const terminals = services.filter((s) => s.lane === "terminal").length;
  const external = services.filter((s) => s.lane === "externo").length;
  const summary = [
    // "terminais", não "terminalis": em português o plural TROCA o -l final por -is, não o acrescenta.
    // O sufixo `+ "is"` produzia "3 terminalis" na dobra da seção — visível na tela, não num teste.
    terminals > 0 ? `${terminals} ${terminals === 1 ? "terminal" : "terminais"}` : null,
    external > 0 ? `${external} claude externo${external === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-[12px] font-medium text-fg-muted transition hover:text-fg"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <TerminalSquare className="h-3.5 w-3.5 text-fg-subtle" />
        Fora do pipeline
        {summary && <span className="font-normal text-fg-subtle">· {summary}</span>}
      </button>
      {open && (
        <ul className="mt-3 space-y-2">
          {services.map((svc) => (
            <ServiceRow key={svc.id} service={svc} meter={meters[svc.id]} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One collapsed disclosure folding everything safe to ignore: finished services, superseded
 *  (safe-to-discard) branches, and the merge-train history. */
function ArchiveDisclosure({
  doneSvc,
  supersededBranches,
  reviewBranches,
  mqHistory,
  onDiscardBranch,
  onDiscardAllSuperseded,
  pending,
  onChanged,
  defaultOpen = false,
  ringedKey = null,
  registerRow,
}: {
  doneSvc: RunningService[];
  supersededBranches: PreservedBranch[];
  /** preserved branches that are neither provably safe NOR stuck (a live card's board data, or an
   *  ESTIMATED base we refuse to raise an alarm on) — visible and discardable, just not shouting. */
  reviewBranches: PreservedBranch[];
  mqHistory: MergeQueueEntry[];
  onDiscardBranch: (branch: string) => void;
  onDiscardAllSuperseded: () => void;
  pending: boolean;
  onChanged: () => void;
  /** WS-4 §4.6 — a `?run=<runId de done/failed>` anchor opens the disclosure by itself. */
  defaultOpen?: boolean;
  ringedKey?: string | null;
  registerRow?: (key: string) => (el: HTMLLIElement | null) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const summary = [
    supersededBranches.length > 0 ? `${supersededBranches.length} superado${supersededBranches.length === 1 ? "" : "s"}` : null,
    reviewBranches.length > 0 ? `${reviewBranches.length} a revisar` : null,
    mqHistory.length > 0 ? `${mqHistory.length} concluído${mqHistory.length === 1 ? "" : "s"}` : null,
    doneSvc.length > 0 ? `${doneSvc.length} encerrado${doneSvc.length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="mt-8 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-[12px] font-medium text-fg-muted transition hover:text-fg"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Archive className="h-3.5 w-3.5 text-fg-subtle" />
        Arquivo &amp; recuperação
        {summary && <span className="font-normal text-fg-subtle">· {summary}</span>}
      </button>

      {open && (
        <div className="mt-3 space-y-5">
          {supersededBranches.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold text-fg-muted">Branches superadas — seguras de descartar</h3>
                <button
                  onClick={onDiscardAllSuperseded}
                  disabled={pending}
                  className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-fg-muted transition hover:text-fg disabled:opacity-40"
                >
                  Descartar {supersededBranches.length}
                </button>
              </div>
              <ul className="space-y-1.5">
                {supersededBranches.map((b) => (
                  <PreservedBranchRow key={b.branch} b={b} onDiscard={onDiscardBranch} pending={pending} />
                ))}
              </ul>
            </div>
          )}

          {reviewBranches.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold text-fg-muted">
                Branches preservadas — revisar antes de descartar
              </h3>
              <ul className="space-y-1.5">
                {reviewBranches.map((b) => (
                  <PreservedBranchRow key={b.branch} b={b} onDiscard={onDiscardBranch} pending={pending} />
                ))}
              </ul>
            </div>
          )}

          {mqHistory.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold text-fg-muted">Fila de merge — histórico</h3>
              <ul className="group/mq space-y-1.5">
                {mqHistory.map((entry) => (
                  <MergeQueueRow
                    key={entry.runId}
                    entry={entry}
                    focused={ringedKey === mqRowKey(entry.runId)}
                    rowRef={registerRow?.(mqRowKey(entry.runId))}
                  />
                ))}
              </ul>
            </div>
          )}

          {doneSvc.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold text-fg-muted">Serviços encerrados</h3>
              <ul className="space-y-2">
                {doneSvc.map((svc) => (
                  <ServiceRow
                    key={svc.id}
                    service={svc}
                    onChanged={onChanged}
                    focused={ringedKey === svcRowKey(svc.id)}
                    rowRef={registerRow?.(svcRowKey(svc.id))}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
