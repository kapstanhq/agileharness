"use client";

// CardStageHistory — the MODULAR view of a card's per-step execution history + stage. One
// component, three densities over the SAME StepRollup[] (computeStepRollups, step-rollup.ts):
//
//   • "full"    — the detailed table at the END of an open card (Quando · Step · Deixou · Status;
//                  metrics on hover). Rows = the steps that RAN (+ a live run), in pipeline order.
//   • "compact" — the stage TRAIL inside the closed card's history popover: every forward step with
//                  its ✓/✗/· verdict + what it left, so the operator decides RUN vs MOVE at a glance.
//   • "tooltip" — the trail collapsed to inline chips (✓Espec ✓Estim ✗Rev ·QA).
//
// Purely presentational: it takes rollups + a density + an optional footer; it never fetches and
// never owns run/move logic (the closed-card popover injects those as `footer`), so it composes
// freely in the card document, a popover, or a tooltip without coupling.

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { DOC_SECTION } from "@/components/doc/typography";
import { GATE_ICON, runStatusLabel, type StepCapability, type StepGate, type StepRollup } from "@/lib/storymap/step-rollup";
import type { RunOutcome } from "@/lib/storymap/runner/journal";
import type { Transition } from "@/lib/storymap/runner/transitions";

const DASH = "—";

// ── formatters (pure) ─────────────────────────────────────────────────────────
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(ms: number | null): string {
  if (ms == null) return DASH;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
function fmtTokens(tokens: number | null): string {
  return tokens == null ? DASH : `${tokens.toLocaleString("pt-BR")} tok`;
}
function fmtCost(costUSD: number | null): string {
  return costUSD == null ? DASH : `$${costUSD.toFixed(3)}`;
}
/** The hover title for a step's row: agent (model·effort) · the LATEST run's duration · turns ·
 *  tokens · cost, then the cumulative cost across runs (Σ) when the step ran more than once — so
 *  every per-run field is consistent and the total is still surfaced. */
function metricsTitle(r: StepRollup): string | undefined {
  if (!r.metrics) return undefined;
  const m = r.metrics;
  const agent = [m.model, m.effort].filter(Boolean).join("·") || null;
  const total = r.runs > 1 ? `Σ ${fmtCost(m.totalCostUSD)} (${r.runs} runs)` : null;
  // capabilities folded into the hover (the full table keeps its columns clean): "graphify✓ · navegador✗"
  const caps = r.capabilities.length
    ? r.capabilities.map((c) => `${c.label}${c.used ? "✓" : "✗"}`).join(" · ")
    : null;
  return [agent, fmtDuration(m.durationMs), m.turns != null ? `${m.turns} turns` : null, fmtTokens(m.tokens), fmtCost(m.costUSD), total, caps]
    .filter(Boolean)
    .join(" · ");
}

/** Capability markers — ◆ used (the skill exercised it) / ◇ expected-but-not-used (a soft anomaly). */
function CapabilityMarkers({ caps }: { caps: StepCapability[] }) {
  if (!caps.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {caps.map((c) => (
        <span
          key={c.id}
          title={c.used ? `${c.label}: usado` : `${c.label}: disponível mas não usado`}
          className={cn(
            "inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-medium",
            c.used
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
          )}
        >
          <span aria-hidden>{c.used ? "◆" : "◇"}</span>
          {c.label}
        </span>
      ))}
    </span>
  );
}

// ── colour maps (semantic — only inside the doc/popover, never on the closed-card FACE) ─────────
const GATE_CLS: Record<StepGate, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  blocked: "text-rose-600 dark:text-rose-400",
  pending: "text-fg-subtle",
  // WS5 — exempt (–) / skipped (⊘): muted, not an alarm and not a fake ✓.
  exempt: "text-fg-subtle",
  skipped: "text-fg-subtle opacity-70",
};

// 4.4 — PT-BR label per gate, consistent with the step-rollup vocab (exempt/skipped). Feeds the per-icon
// tooltip AND the compact legend so the WS5 `–`/`⊘` icons stop being unexplained. `live` reads as "rodando".
const GATE_TITLE: Record<StepGate, string> = {
  ok: "feito",
  blocked: "bloqueado",
  pending: "não visitado",
  exempt: "isento",
  skipped: "pulado pela rota",
};
// 6.3 — a column a real ledger event ENTERED reads "visitado", never "não visitado" (that pending verdict is
// the ROUTE/GATE axis; `visited` is the EXECUTION axis). Only softens the pending label — never demotes a
// real gate verdict (ok/blocked/exempt/skipped pass straight through).
const gateTitle = (r: StepRollup): string =>
  r.live ? "rodando" : r.gate === "pending" && r.visited ? "visitado" : GATE_TITLE[r.gate];
// legend order (glyphs pulled from GATE_ICON so they can never drift from what actually renders).
const LEGEND_GATES: StepGate[] = ["ok", "exempt", "skipped", "pending"];

const STATUS_CLS: Record<RunOutcome, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  error: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  "oom-killed": "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  timeout: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  exit: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  "no-op": "bg-surface-hover text-fg-muted",
  cancelled: "bg-surface-hover text-fg-muted",
  "max-turns": "bg-surface-hover text-fg-muted",
};

function StatusChip({ rollup }: { rollup: StepRollup }) {
  if (rollup.live) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
        rodando
      </span>
    );
  }
  if (!rollup.lastStatus) return <span className="text-fg-subtle">{DASH}</span>;
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", STATUS_CLS[rollup.lastStatus])}>
      {runStatusLabel(rollup.lastStatus)}
    </span>
  );
}

export function CardStageHistory({
  rollups,
  density,
  footer,
}: {
  rollups: StepRollup[];
  density: "full" | "compact" | "tooltip";
  /** the closed-card popover injects a contextual action footer; ignored in full/tooltip. */
  footer?: ReactNode;
}) {
  if (density === "tooltip") return <StageTrailChips rollups={rollups} />;
  if (density === "compact") return <StageTrail rollups={rollups} footer={footer} />;
  return <StageTable rollups={rollups} />;
}

// ── full: the detailed per-step table at the end of an open card ────────────────────────────────
function StageTable({ rollups }: { rollups: StepRollup[] }) {
  // The steps that actually ran (or one in flight) — pipeline order is preserved by the rollups.
  const rows = rollups.filter((r) => r.runs > 0 || r.live);
  if (rows.length === 0) return null;

  return (
    <section>
      <h2 className={DOC_SECTION}>Histórico</h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left text-[12px] text-fg-muted">
          <thead className="text-[10px] uppercase tracking-wide text-fg-subtle">
            <tr className="border-b border-line-muted">
              <th className="px-2.5 py-1.5 font-semibold">Quando</th>
              <th className="px-2.5 py-1.5 font-semibold">Step</th>
              <th className="px-2.5 py-1.5 font-semibold">Deixou</th>
              <th className="px-2.5 py-1.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.trigger}
                title={metricsTitle(r)}
                className={cn("border-t border-line-muted/60 align-top", r.live && "bg-sky-50/60 dark:bg-sky-500/5")}
              >
                <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums">
                  {r.live ? <span className="font-semibold text-sky-700 dark:text-sky-300">▸ agora</span> : r.lastRunAt != null ? fmtDateTime(r.lastRunAt) : DASH}
                </td>
                <td className="px-2.5 py-1.5">
                  <span className="text-fg">{r.step}</span>
                  {r.runs > 1 && <span className="ml-1 text-[10px] text-fg-subtle">({r.runs} runs)</span>}
                </td>
                <td className="px-2.5 py-1.5">{r.left ? <span>{r.left}</span> : <span className="text-fg-subtle">{DASH}</span>}</td>
                <td className="px-2.5 py-1.5">
                  <StatusChip rollup={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── compact: the stage trail (every forward step + its verdict) — the RUN-vs-MOVE decision aid ──
function StageTrail({ rollups, footer }: { rollups: StepRollup[]; footer?: React.ReactNode }) {
  if (rollups.length === 0) {
    return <p className="px-1 py-2 text-center text-[11px] text-fg-subtle">Sem passos para este card.</p>;
  }
  return (
    <div>
      <p className="px-1 pb-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Estágio do card</p>
      <ul className="space-y-0.5">
        {rollups.map((r) => (
          <li key={r.trigger} className={cn("rounded-md px-1.5 py-1 text-[12px]", r.isCurrent && "bg-surface-hover")}>
            <div className="flex items-center gap-2">
              <span className={cn("w-3 shrink-0 text-center font-semibold", GATE_CLS[r.gate])} title={gateTitle(r)}>
                {r.live ? "▸" : GATE_ICON[r.gate]}
              </span>
              <span className={cn("shrink-0 font-medium", r.gate === "pending" ? "text-fg-muted" : "text-fg")}>{r.step}</span>
              <span className="ml-auto min-w-0 truncate text-right text-[11px] text-fg-subtle">
                {r.live ? "rodando…" : r.left ?? (r.runs > 0 ? runStatusLabel(r.lastStatus) : "")}
              </span>
            </div>
            {r.capabilities.length > 0 && (
              <div className="mt-0.5 pl-5">
                <CapabilityMarkers caps={r.capabilities} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {/* 4.4 — a compact legend so the WS5 –/⊘ icons read at a glance (glyphs from GATE_ICON, terms from the
          step-rollup vocab). */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-1 text-[10px] text-fg-subtle">
        {LEGEND_GATES.map((g) => (
          <span key={g} className="inline-flex items-center gap-1">
            <span className={cn("font-semibold", GATE_CLS[g])} aria-hidden>{GATE_ICON[g]}</span>
            {GATE_TITLE[g]}
          </span>
        ))}
      </div>
      {footer && <div className="mt-1.5 border-t border-line-muted pt-1.5">{footer}</div>}
    </div>
  );
}

// ── tooltip: the trail collapsed to inline chips ────────────────────────────────────────────────
function StageTrailChips({ rollups }: { rollups: StepRollup[] }) {
  if (rollups.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
      {rollups.map((r) => (
        <span key={r.trigger} className="inline-flex items-center gap-0.5">
          <span className={cn("font-semibold", GATE_CLS[r.gate])} title={gateTitle(r)}>
            {r.live ? "▸" : GATE_ICON[r.gate]}
          </span>
          <span className={r.gate === "pending" ? "text-fg-subtle" : "text-fg-muted"}>{r.step}</span>
        </span>
      ))}
    </span>
  );
}

// ── 6.3 — the durable HOP TIMELINE: the card's real status trajectory read from the WS2 ledger. Every from→to
//    hop with WHO moved it and WHY (note) — the auditable reader that makes merge:reproved / deploy:reverted /
//    revive visible in the drawer, and turns the ledger from a write-only file into a read surface.
const HOP_ACTOR_LABEL = (actor: string): string =>
  actor.startsWith("run:")
    ? "agente"
    : (({ human: "você", cascade: "cascata", system: "sistema", merge: "merge" }) as Record<string, string>)[actor] ??
      actor;

export function CardHopTimeline({ transitions }: { transitions: Transition[] }) {
  if (transitions.length === 0) return null;
  // The ledger is append-only chronological; show most-recent first (stable sort by ISO `at`, desc).
  const hops = transitions
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.at < b.t.at ? 1 : a.t.at > b.t.at ? -1 : a.i - b.i))
    .map(({ t }) => t);
  return (
    <section>
      <h2 className={DOC_SECTION}>Trajeto</h2>
      <ul className="space-y-1">
        {hops.map((t, i) => {
          const ms = Date.parse(t.at);
          return (
            <li key={`${t.at}-${i}`} className="flex items-baseline gap-2 text-[12px] text-fg-muted">
              <span className="w-[92px] shrink-0 whitespace-nowrap tabular-nums text-[11px] text-fg-subtle">
                {Number.isFinite(ms) ? fmtDateTime(ms) : DASH}
              </span>
              <span className="min-w-0 flex-1 leading-snug">
                <span className={t.from ? "text-fg-muted" : "text-fg-subtle"}>{t.from ?? "início"}</span>
                <span className="mx-1 text-fg-subtle" aria-hidden>
                  →
                </span>
                <span className="font-medium text-fg">{t.to}</span>
                <span className="ml-1.5 text-[11px] text-fg-subtle">
                  · {HOP_ACTOR_LABEL(t.actor)}
                  {t.note ? ` · ${t.note}` : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
