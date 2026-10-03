// Parse `ccusage weekly --json` into our TokenWindow — the Claude Code WEEKLY rate-limit
// gauge (what the user watches to decide accelerate/brake). PURE (no spawn/fs) so it is
// unit-testable against a captured fixture; metrics.ts owns the `bunx ccusage` spawn.
// DEFENSIVE: ccusage's JSON shape shifts across versions, so every field is read optionally
// and degrades rather than throwing.
//
// ccusage `weekly` aggregates token usage by CALENDAR week (period = the week's Monday). It
// does NOT know the PLAN's weekly token budget, so the "% usado" is computed against a limit
// passed in by metrics.ts ({@link resolveWeeklyTokenLimit}: env > `vps.weeklyTokenLimit` > none — NO built-in
// per-plan default, because the plan is the operator's, not the tool's). The current week is the entry with the latest
// period; the window nominally "resets" at period + 7 days.

import type { TokenWindow } from "./types";

interface CcWeek {
  period?: string; // week start, e.g. "2026-06-01"
  totalTokens?: number;
  totalCost?: number;
  modelsUsed?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * O denominador do «% usado» do ccusage: a env `AGILEHARNESS_WEEKLY_TOKEN_LIMIT` vence o `vps.weeklyTokenLimit` do
 * settings; lixo (vazio, zero, negativo, NaN, texto) em qualquer camada é IGNORADO. Sem declaração devolve `null`:
 * o ccusage mostra tokens e custo da semana SEM porcentagem («sem limite» na UI) e nenhum balde de cota é inventado —
 * um número embutido seria o orçamento de outra assinatura. PURA.
 */
export function resolveWeeklyTokenLimit(envValue: string | undefined, declared: number | undefined): number | null {
  const fromEnv = envValue !== undefined && envValue.trim() !== "" ? Number(envValue) : Number.NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) return Math.floor(declared);
  return null;
}

/**
 * @param raw stdout of `ccusage weekly --json`
 * @param now epoch ms (passed in for testability / SSE freshness)
 * @param limitTokens the plan's weekly token budget (the denominator), or null = no %
 */
export function parseWeeklyTokenWindow(raw: string, now: number, limitTokens: number | null): TokenWindow | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const rows: CcWeek[] = Array.isArray((data as any)?.weekly)
    ? (data as any).weekly
    : ((Object.values((data as any) ?? {}).find(Array.isArray) as CcWeek[] | undefined) ?? []);
  const weeks = rows.filter((w) => typeof w?.period === "string");
  if (!weeks.length) return null;
  // Current week = the latest period (ISO date strings sort lexicographically).
  const current = weeks.reduce((a, b) => ((a.period ?? "") >= (b.period ?? "") ? a : b));

  const startedAtRaw = Date.parse(`${current.period}T00:00:00Z`);
  const startedAt = Number.isFinite(startedAtRaw) ? startedAtRaw : now;
  const resetsAt = startedAt + WEEK_MS;
  const resetsInMinutes = Math.max(0, Math.round((resetsAt - now) / 60_000));

  const usedTokens = num(current.totalTokens) ?? 0;
  const limit = limitTokens && limitTokens > 0 ? limitTokens : null;
  const usedPct = limit ? clampPct((usedTokens / limit) * 100) : null;
  const remainingPct = limit ? clampPct((1 - usedTokens / limit) * 100) : null;

  return {
    source: "ccusage",
    startedAt,
    resetsAt,
    resetsInMinutes,
    usedTokens,
    costUSD: num(current.totalCost) ?? 0,
    limitTokens: limit,
    remainingPct,
    usedPct,
    // ccusage weekly carries no projection / burn rate (those are 5h-block-only).
    projectedTokens: null,
    willExceedBeforeReset: null,
    burnTokensPerMin: null,
    burnCostPerHour: null,
    models: Array.isArray(current.modelsUsed)
      ? (current.modelsUsed.filter((m) => typeof m === "string") as string[])
      : [],
  };
}
