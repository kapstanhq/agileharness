// Run sub-state — the OPERATIONAL state of a card's most-recent autorun run, resolved
// from the two live snapshots (RunnerSnapshot + MergeQueueSnapshot) into ONE coloured
// badge the operator can read at a glance from the kanban (story-redesenho-cards-storymap).
//
// PURE — no React, no IO, no lucide import: it returns an `iconName` (a small union) that
// the badge component maps to a Lucide icon, so this module stays node-unit-testable and
// the colours/labels live in one place. `resolveRunSubstate` takes `nowMs` explicitly so
// the "done recente" TTL is deterministic in tests.

import type { MergeQueueSnapshot, RunnerSnapshot } from "@/lib/storymap/runner/types";

/** The seven operational sub-states a card's run can be in (priority order below). */
export type RunSubstateKind =
  | "running"
  | "merging"
  | "conflict"
  | "waiting"
  | "error"
  | "failed"
  | "done";

/** Which Lucide glyph the badge renders — kept as a tiny union so this module is pure. */
export type RunSubstateIconName = "loader" | "merge" | "conflict" | "clock" | "alert" | "x" | "check";

/** The resolved, presentation-ready sub-state for a card (or null when there's nothing live). */
export interface RunSubstate {
  kind: RunSubstateKind;
  /** short PT-BR label, e.g. "Rodando" / "Aguardando merge" */
  label: string;
  /** Tailwind classes (bg + text) for the pill badge */
  colorCls: string;
  /** Tailwind bg-class for the card's left accent rail (opt-2 design) */
  railCls: string;
  iconName: RunSubstateIconName;
  /** optional extra detail (e.g. "timeout", "#3 na fila") */
  detail?: string;
  /** epoch ms to count elapsed from (running → startedAt; queued → enqueuedAt) — drives the timer */
  since?: number;
}

/** Static look (label/colour/rail/icon) per kind — the single source of the palette. */
export const RUN_SUBSTATE_VIEW: Record<
  RunSubstateKind,
  { label: string; colorCls: string; railCls: string; iconName: RunSubstateIconName }
> = {
  running: {
    label: "Rodando",
    colorCls: "bg-accent/10 text-accent",
    railCls: "bg-accent",
    iconName: "loader",
  },
  merging: {
    label: "Integrando",
    colorCls: "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300",
    railCls: "bg-indigo-400",
    iconName: "merge",
  },
  conflict: {
    label: "Conflito",
    colorCls: "bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300",
    railCls: "bg-rose-400",
    iconName: "conflict",
  },
  waiting: {
    label: "Aguardando merge",
    colorCls: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
    railCls: "bg-amber-400",
    iconName: "clock",
  },
  error: {
    label: "Travou",
    colorCls: "bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300",
    railCls: "bg-rose-500",
    iconName: "alert",
  },
  failed: {
    label: "Falhou",
    colorCls: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300",
    railCls: "bg-red-400",
    iconName: "x",
  },
  done: {
    label: "Terminou",
    colorCls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
    railCls: "bg-emerald-400",
    iconName: "check",
  },
};

/** A TERMINAL merge-queue state (`done` or `failed`) stops driving the badge once it's older than
 * this — so a merge that finished/failed hours ago never lingers as a permanent badge (especially on
 * a card already in `concluída`/`arquivados`). Recent ones still surface for the operator. */
export const DONE_TTL_MS = 2 * 60 * 60_000; // 2h

/**
 * How long `re-driving` may read as "Integrando" before the badge stops believing it.
 *
 * `re-driving` is TERMINAL on the queue: nothing will ever move that entry again. The badge shows it as
 * merging on the ASSUMPTION that the re-drive's own `running` frame (top priority) overtakes it within
 * seconds. On 2026-07-16 that frame never came — the re-drive was stranded in the heavy lane by a pump
 * that only fires on an edge — and with no TTL the badge counted "Integrando · 325m" for FIVE HOURS while
 * `runner_status` showed an empty queue. Both were telling the truth; only the operator was misled.
 *
 * The engine's stranding bug is fixed (the pump now re-arms), so a re-drive that has not shown up long
 * after the fact means something is wrong AGAIN — and this badge is the only place it would show. The
 * window is deliberately generous: a re-drive can legitimately sit queued while the box is hot, and the
 * pump retries every 30s, so minutes of silence are normal and a quarter of an hour is not.
 *
 * A false "Travou" costs the operator one look; silence cost five hours. That asymmetry sets the default.
 */
export const REDRIVING_TTL_MS = 15 * 60_000; // 15min

function build(kind: RunSubstateKind, extra: { detail?: string; since?: number } = {}): RunSubstate {
  return { kind, ...RUN_SUBSTATE_VIEW[kind], ...extra };
}

/**
 * Resolve the single most-relevant sub-state for a card from the two live snapshots.
 * Priority (first match wins): running > merging > conflict > waiting > error > failed >
 * done (recent). Returns null when nothing live applies (cold start, or an old `done`).
 *
 * `gate-running`/`gate-failed` merge-queue states fold into waiting/conflict respectively
 * (the operator reads them the same way: "queued" vs "paused, needs me").
 */
export function resolveRunSubstate(
  boardId: string,
  cardId: string,
  snapshot: RunnerSnapshot | null | undefined,
  mergeQueue: MergeQueueSnapshot | null | undefined,
  nowMs: number,
): RunSubstate | null {
  const snap = snapshot ?? { running: [], failures: [] };

  const run = snap.running.find((r) => r.board === boardId && r.cardId === cardId);
  if (run) return build("running", { since: run.startedAt });

  const entries = (mergeQueue?.entries ?? []).filter((e) => e.board === boardId && e.cardId === cardId);
  const pick = (...statuses: string[]) =>
    entries.find((e) => statuses.includes(e.status));

  // `re-driving` (story-92ldyt) folds into `merging`: the branch conflicted but is being autonomously
  // regenerated against the updated main (the engine re-runs the skill) — to the operator it reads as
  // "still integrating", NOT a pause needing them. The brief window before the re-run's `running` frame
  // (top priority) overtakes it shows this instead of a blank.
  const merging = pick("merging", "re-driving");
  if (merging) {
    const since = merging.mergeStartedAt ?? merging.enqueuedAt;
    // …but only for as long as "brief" is still honest. Past the TTL the promised `running` frame is not
    // coming, and the entry is terminal, so nothing else will ever correct this badge — say so instead of
    // counting forever (2026-07-16: 325m of "Integrando" over a re-drive that never spawned).
    // Scoped to `re-driving` ON PURPOSE: a real `merging` is a LIVE entry the train is holding right now
    // (it is in LIVE_MQ, and `runner_status` shows it), so it cannot strand the same silent way.
    if (merging.status === "re-driving" && nowMs - since > REDRIVING_TTL_MS) {
      return build("error", { detail: "re-drive não apareceu — trabalho pode estar encalhado", since });
    }
    return build("merging", { since });
  }

  const conflict = pick("conflict", "gate-failed");
  if (conflict) {
    const detail = conflict.status === "gate-failed" ? "gate falhou" : "conflito de merge";
    return build("conflict", { detail, since: conflict.enqueuedAt });
  }

  const waiting = pick("waiting", "gate-running");
  if (waiting) {
    // Position among ALL queued branches (FIFO by enqueuedAt) → "#N na fila".
    const queued = (mergeQueue?.entries ?? [])
      .filter((e) => e.status === "waiting" || e.status === "gate-running")
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const pos = queued.findIndex((e) => e.runId === waiting.runId);
    const detail = waiting.status === "gate-running" ? "validando" : pos >= 0 ? `#${pos + 1} na fila` : undefined;
    return build("waiting", { detail, since: waiting.enqueuedAt });
  }

  const failure = snap.failures.find((f) => f.board === boardId && f.cardId === cardId);
  if (failure) return build("error", { detail: failure.detail, since: failure.at });

  const failed = pick("failed");
  if (failed) {
    // Same TTL as `done`: a merge that failed hours ago must not paint a permanent "merge falhou"
    // badge (it was lingering forever on terminal cards). A recent failure still surfaces.
    const since = failed.mergeEndedAt ?? failed.enqueuedAt;
    if (nowMs - since < DONE_TTL_MS) return build("failed", { detail: failed.failureReason, since });
  }

  const done = pick("done");
  if (done && done.mergeEndedAt && nowMs - done.mergeEndedAt < DONE_TTL_MS) {
    return build("done", { since: done.mergeEndedAt });
  }

  return null;
}
