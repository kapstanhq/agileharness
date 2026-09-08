"use client";

// ⚙ Sistema · Métricas (story-observabilidade-runs-telemetria) — the board-wide cost/turns panel: one
// row per card that has ever run, with total runs, total cost, mean turns and the last run's time +
// outcome. Sortable by any column; defaults to total cost DESC so the most expensive cards surface
// first (AC3). Pure presentation over the aggregated BoardMetricsSummary the server computed.
//
// Abre com o MESMO cabeçalho das irmãs do Sistema (`nav/PageHeader`): título, uma linha do que a tela
// responde, e o resumo à direita. Antes o título dividia a linha com o total de custo sem nada
// dizendo o que a tela era — a explicação vivia só no tooltip do item de menu.

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Coins } from "lucide-react";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/nav/PageTabs";
import { BoardHeader } from "./BoardHeader";
import { ToastProvider } from "./Toast";
import type { Board, BoardSummary } from "@/lib/storymap/types";
import type { BoardMetricsSummary, CardMetrics } from "@/lib/storymap/runner/telemetry";
import type { RunOutcome } from "@/lib/storymap/runner/journal";

// Exhaustive over RunOutcome — TS now flags a future outcome that forgets a badge here (story-vbkazs:
// a loose Record<string,string> let `cancelled` render as an unstyled raw-English badge).
const STATUS_CLS: Record<RunOutcome, string> = {
  ok: "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  error: "bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300",
  timeout: "bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
  exit: "bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "oom-killed": "bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "no-op": "bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
  // story-vbkazs: a deliberate operator cancel is NOT a failure → neutral slate (matches CardRunHistory).
  cancelled: "bg-slate-100 dark:bg-slate-500/15 text-slate-600 dark:text-slate-300",
  // story-9s52tu HALF B: a max-turns stop is RESUMABLE (not a failure) → calm sky/blue, distinct from
  // the red/amber failure family (it resumes via `claude --resume`, no operator action needed).
  "max-turns": "bg-sky-100 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

// pt-BR label only for the outcomes that don't read fine in English (story-vbkazs).
const STATUS_LABEL: Partial<Record<RunOutcome, string>> = { cancelled: "cancelado", "max-turns": "limite de turnos" };

type SortKey = "totalCostUSD" | "totalRuns" | "avgTurns" | "lastRunAt";

const DASH = "—";
const fmtCost = (v: number | null) => (v == null ? DASH : `$${v.toFixed(3)}`);
const fmtTurns = (v: number | null) => (v == null ? DASH : v.toFixed(1));
const fmtDateTime = (ms: number | null) =>
  ms == null
    ? DASH
    : new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function BoardMetricsView({
  board,
  boards,
  summary,
}: {
  board: Board;
  boards: BoardSummary[];
  summary: BoardMetricsSummary;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "totalCostUSD", dir: "desc" });

  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of board.cards) m.set(c.id, c.title);
    return m;
  }, [board.cards]);

  const rows = useMemo(() => {
    const sorted = [...summary.cards].sort((a, b) => {
      const av = a[sort.key] ?? -Infinity;
      const bv = b[sort.key] ?? -Infinity;
      return sort.dir === "desc" ? bv - av : av - bv;
    });
    return sorted;
  }, [summary.cards, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-canvas">
        <BoardHeader boards={boards} config={board.config} view="metricas" subnav />
        {/* SISTEMA_MAX_W — a MESMA largura das irmãs (ver `nav/PageTabs`). A tabela rola sozinha
            (`overflow-x-auto`) quando não couber, então nada se perde no estreitamento. */}
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
          <PageHeader
            title="Métricas"
            icon={Coins}
            description="Quanto cada card custou de verdade — runs, custo, turns e o desfecho do último run. Telemetria dos agentes, não etapa do fluxo."
            actions={
              <div className="text-right text-sm text-fg-muted">
                <span className="block text-lg font-semibold tabular-nums text-fg">{fmtCost(summary.totalCostUSD)}</span>
                <span className="text-[11px] text-fg-subtle">custo total · {summary.cards.length} card(s)</span>
              </div>
            }
          />

          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line bg-surface px-4 py-12 text-center text-sm text-fg-subtle">
              Nenhum run registrado ainda neste board. As métricas aparecem assim que um card é executado.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full text-left text-[12px] text-fg-muted">
                <thead className="border-b border-line text-[10px] uppercase tracking-wide text-fg-subtle">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Card</th>
                    <SortTh label="Runs" col="totalRuns" sort={sort} onSort={toggleSort} align="right" />
                    <SortTh label="Custo total" col="totalCostUSD" sort={sort} onSort={toggleSort} align="right" />
                    <SortTh label="Média turns" col="avgTurns" sort={sort} onSort={toggleSort} align="right" />
                    <SortTh label="Último run" col="lastRunAt" sort={sort} onSort={toggleSort} align="right" />
                    <th className="px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c: CardMetrics) => (
                    <tr key={c.cardId} className="border-t border-line-muted/60 hover:bg-surface-hover">
                      <td className="px-3 py-2">
                        <div className="font-medium text-fg">{titleById.get(c.cardId) ?? c.cardId}</div>
                        <div className="font-mono text-[10px] text-fg-subtle">{c.cardId}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.totalRuns}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-fg">{fmtCost(c.totalCostUSD)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTurns(c.avgTurns)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{fmtDateTime(c.lastRunAt)}</td>
                      <td className="px-3 py-2">
                        {c.lastStatus ? (
                          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", STATUS_CLS[c.lastStatus])}>
                            {STATUS_LABEL[c.lastStatus] ?? c.lastStatus}
                          </span>
                        ) : (
                          DASH
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>
    </ToastProvider>
  );
}

function SortTh({
  label,
  col,
  sort,
  onSort,
  align,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  align?: "right";
}) {
  const active = sort.key === col;
  return (
    <th className={cn("px-3 py-2 font-semibold", align === "right" && "text-right")}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex items-center gap-1 transition hover:text-fg",
          align === "right" && "flex-row-reverse",
          active && "text-fg",
        )}
      >
        {label}
        {active &&
          (sort.dir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );
}
