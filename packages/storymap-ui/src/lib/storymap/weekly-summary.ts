// O RESUMO DA SEMANA. PURO (zero IO): a página /semana e o push de segunda leem daqui.
//
// O dono não acompanha o dia a dia: uma vez por semana ele quer ver, em um lugar só e de todos os boards, o que foi ao
// ar, o que foi descartado, os dilemas decididos, o que o sistema decidiu em nome dele, quanto a semana custou e o
// que ainda espera por ele. É também o LEMBRETE semanal das decisões dele que seguem esperando (C): elas nunca
// vencem, e ninguém insiste por push — o lembrete mora aqui.
//
// A semana é de segunda 00:00 a segunda 00:00 no fuso do dono (o mesmo `governor.timezone` do ritmo diário; ausente,
// o do host). O push sai toda segunda às 09:00 nesse fuso, apontando para a semana que acabou — o único push que não
// é crítico (notifications/push-policy `weekly-summary`), uma vez por semana.

import { costImpactFigures } from "./cost-impact";
import { formatMoney } from "./currency";
import { deliveredStatusIds } from "./delivered";
import { healthDelta, recordAsReading, summarizeSignals, worstLevel, type HealthLevel, type HealthRecord, type HealthSignalId } from "./health/ah-health";
import type { OwnerWaiting } from "./owner-waiting";
import type { SystemDecision, SystemDecisionKind } from "./system-decisions";
import type { BoardConfig, Card, CostImpact } from "./types";

/** Quando o push sai: segunda-feira (1), às 9h, no fuso do dono. */
export const WEEKLY_PUSH_WEEKDAY = 1;
export const WEEKLY_PUSH_HOUR = 9;

const DAY_MS = 86_400_000;

// ── o tempo local ──────────────────────────────────────────────────────────────────────────────────────────

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? "";
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    FORMATTERS.set(key, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** A data, o dia da semana (0 = domingo) e a hora de `now` no fuso `tz`. PURA. */
export function localClock(now: number, tz?: string): { date: string; weekday: number; hour: number; minute: number } {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** `date` (YYYY-MM-DD) + `days`, em calendário puro. PURA. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** O deslocamento do fuso em `at` (local − UTC, ms). */
function offsetAt(at: number, tz?: string): number {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** O instante da meia-noite local de `date` no fuso `tz`. PURA. */
export function localMidnight(date: string, tz?: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

/** A segunda-feira da semana de `now` no fuso `tz` (YYYY-MM-DD). PURA. */
export function mondayOf(now: number, tz?: string): string {
  const c = localClock(now, tz);
  return addDays(c.date, -((c.weekday + 6) % 7));
}

/** Uma semana: de segunda 00:00 (inclusive) a segunda seguinte 00:00 (exclusive), no fuso do dono. */
export interface WeekWindow {
  /** a segunda-feira (YYYY-MM-DD). */
  from: string;
  /** o domingo (YYYY-MM-DD). */
  to: string;
  start: number;
  end: number;
}

export function weekWindow(monday: string, tz?: string): WeekWindow {
  return { from: monday, to: addDays(monday, 6), start: localMidnight(monday, tz), end: localMidnight(addDays(monday, 7), tz) };
}

/** Uma segunda-feira válida (YYYY-MM-DD que cai numa segunda)? PURA — a página aceita `?de=` só assim. */
export function isMonday(date: string | null | undefined): date is string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === date && new Date(t).getUTCDay() === 1;
}

/**
 * O push desta semana está devido? Segunda, a partir das 9h no fuso do dono, e ainda não enviado para esta segunda —
 * devolve a segunda de HOJE (a chave do envio), ou null. Uma segunda inteira com o serviço fora do ar pula a semana:
 * o resumo continua na página. PURA.
 */
export function weeklyPushDue(now: number, tz: string | undefined, lastSentFor: string | null | undefined): string | null {
  const c = localClock(now, tz);
  if (c.weekday !== WEEKLY_PUSH_WEEKDAY || c.hour < WEEKLY_PUSH_HOUR) return null;
  return lastSentFor === c.date ? null : c.date;
}

// ── o resumo ──────────────────────────────────────────────────────────────────────────────────────────────

/** O que o sistema decidiu, dito para o dono — exaustivo por tipo (um kind novo não compila sem o seu nome). */
export const DECISION_KIND_LABEL: Record<SystemDecisionKind, string> = {
  "triage-accept": "Aceitou na triagem",
  "triage-discard": "Descartou na triagem",
  "triage-duplicate": "Juntou duplicatas",
  "proxy-answer": "Respondeu perguntas técnicas",
  "ui-choice": "Escolheu telas",
  "delivery-skip": "Entregou sem parar para aprovação",
  publish: "Publicou",
  dilemma: "Decidiu dilemas",
  "recovery-fix-card": "Abriu cards de conserto",
  "security-review": "Revisou a segurança antes de publicar",
  "cost-within-ceiling": "Aceitou custo dentro dos tetos",
  "technical-audit": "Auditou entregas técnicas",
  "stall-retry": "Refez passos parados",
  "stall-fix-card": "Abriu consertos para cards travados",
  "budget-raise": "Subiu o teto de gasto de cards",
  "extra-slot": "Abriu vagas extras de condutor",
  "card-missing": "Registrou cards que sumiram do disco",
  "extra-cycle": "Autorizou ciclos extras de verificação",
  "conductor-park": "Estacionou condutores parados",
  "proof-republish": "Republicou com a prova de segurança",
  undo: "Desfez decisões (a seu pedido)",
};

export interface WeeklyBoardInput {
  id: string;
  name: string;
  config: BoardConfig;
  cards: Card[];
}

export interface WeeklyItem {
  boardId: string;
  boardName: string;
  cardId: string;
  title: string;
  at: string;
}

/**
 * A saúde da FERRAMENTA na semana (health/): o que as leituras que o tick gravou dizem da primeira à última — o dono vê, em
 * uma linha, se a ferramenta melhorou ou piorou. Só aparece quando o tick gravou ao menos uma leitura na semana.
 */
export interface WeeklyHealth {
  /** quantas leituras caíram na semana. */
  readings: number;
  /** a primeira e a última leitura da semana (ISO). */
  from: string;
  to: string;
  /** o pior nível da ÚLTIMA leitura. */
  worst: HealthLevel;
  /** os sinais vermelhos na última leitura. */
  red: HealthSignalId[];
  /** o estado na última leitura: «4 vermelhos (S2, S5…) · 4 em atenção (…) · 2 ok · 2 não medíveis». */
  now: string;
  /** a tendência da primeira à última leitura: «melhorou: S6 (8→0); piorou: nenhum». Nula com uma leitura só. */
  trend: string | null;
}

export interface WeeklySummary {
  week: WeekWindow;
  /** o que chegou a um status de entrega ("No ar") na semana. */
  live: WeeklyItem[];
  /** o que foi para um terminal que NÃO é entrega (arquivado, descontinuado) ou foi descartado na triagem. */
  discarded: WeeklyItem[];
  /** os dilemas decididos (o registro do que decidiu, com a escolha). */
  dilemmas: Array<SystemDecision & { boardName: string }>;
  /** tudo o que o sistema decidiu em nome do dono na semana. */
  systemDecisions: { total: number; byKind: Array<{ kind: SystemDecisionKind; label: string; count: number }> };
  cost: {
    /** o gasto estimado das execuções automáticas (US$, a estimativa que o Claude informa; pela assinatura, só vira
     *  cobrança com o uso extra ligado). */
    automationUSD: number;
    runs: number;
    /**
     * o custo MENSAL a mais que o que foi ao ar esta semana projetou, SOMADO POR MOEDA (boards de moedas diferentes
     * nunca se somam — não existe câmbio), na ordem em que cada moeda apareceu; com as projeções abaixo.
     */
    projectedMonthly: Array<{ currency: string; amount: number }>;
    projections: Array<WeeklyItem & { impact: CostImpact }>;
  };
  /** as decisões do dono que seguem esperando — o lembrete semanal (nunca vencem). */
  waiting: Array<OwnerWaiting & { boardName: string }>;
  /** a regra de expansão do só-negócio (rollout.ts), quando o coletor a mediu: «pronto para estender: sim|não, N/10». */
  rollout?: { ready: boolean; line: string };
  /** a linha de tendência da saúde da ferramenta; ausente quando o tick não gravou leitura na semana. */
  health?: WeeklyHealth;
}

export interface WeeklySummaryInput {
  week: WeekWindow;
  boards: WeeklyBoardInput[];
  transitions: ReadonlyArray<{ at: string; board: string; cardId: string; to: string }>;
  decisions: readonly SystemDecision[];
  runs: ReadonlyArray<{ startedAt: number; costUSD: number | null }>;
  waiting: ReadonlyArray<OwnerWaiting>;
  rollout?: { ready: boolean; line: string };
  /** as leituras gravadas no health.jsonl (qualquer ordem, qualquer semana — a janela é filtrada aqui). */
  health?: readonly HealthRecord[];
}

const inWeek = (w: WeekWindow, iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= w.start && t < w.end;
};

/**
 * A linha de tendência da saúde da semana: compara a PRIMEIRA com a ÚLTIMA leitura que o tick gravou dentro da janela
 * (`healthDelta`, a mesma régua do ciclo de conserto). `null` sem leitura na semana — a seção some, em vez de dizer «tudo
 * bem» sem ter medido. O ledger guarda 7 dias: a semana corrente vem inteira, uma semana passada vem só em parte (ou nada).
 * PURA.
 */
export function weeklyHealthTrend(records: readonly HealthRecord[], week: WeekWindow): WeeklyHealth | null {
  const inside = records
    .filter((r) => inWeek(week, r.at))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!inside.length) return null;
  const first = inside[0]!;
  const last = inside[inside.length - 1]!;
  const levels = (Object.entries(last.signals) as Array<[HealthSignalId, { level: HealthLevel }]>).map(([id, s]) => ({ id, level: s.level }));
  return {
    readings: inside.length,
    from: first.at,
    to: last.at,
    worst: worstLevel(levels.map((l) => l.level)),
    red: levels.filter((l) => l.level === "red").map((l) => l.id),
    now: summarizeSignals(levels),
    trend: inside.length > 1 ? healthDelta(recordAsReading(first), recordAsReading(last)).line : null,
  };
}

/** A soma do custo mensal projetado, por moeda (2 casas). Um impacto sem moeda não tem unidade e fica fora da soma. PURA. */
function projectedByCurrency(impacts: readonly CostImpact[]): Array<{ currency: string; amount: number }> {
  const sums = new Map<string, number>();
  for (const impact of impacts) {
    const f = costImpactFigures(impact);
    if (f.currency) sums.set(f.currency, (sums.get(f.currency) ?? 0) + f.amount);
  }
  return [...sums.entries()].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }));
}

/** O dinheiro do produto na moeda do PRÓPRIO impacto (formato completo da tela); sem moeda, só o número. PURA. */
export function formatImpactMoney(amount: number, currency: string | null): string {
  return currency ? formatMoney(amount, { code: currency }) : String(amount);
}

/** A frase «+12,00 por mês», com o símbolo da moeda (uma parte por moeda, nunca somadas entre si) ou «nenhum custo a mais por mês». PURA. */
export function projectedMonthlyText(projected: WeeklySummary["cost"]["projectedMonthly"]): string {
  const parts = projected.filter((p) => p.amount > 0).map((p) => `+${formatImpactMoney(p.amount, p.currency)}`);
  return parts.length ? `${parts.join(" e ")} por mês` : "nenhum custo a mais por mês";
}

/** Monta o resumo. PURA. */
export function buildWeeklySummary(input: WeeklySummaryInput): WeeklySummary {
  const { week } = input;
  const boards = new Map(input.boards.map((b) => [b.id, b]));
  const nameOf = (id: string) => boards.get(id)?.name ?? id;
  const cardOf = (board: string, cardId: string) => boards.get(board)?.cards.find((c) => c.id === cardId);
  const item = (board: string, cardId: string, at: string): WeeklyItem => ({ boardId: board, boardName: nameOf(board), cardId, title: cardOf(board, cardId)?.title ?? cardId, at });

  const live = new Map<string, WeeklyItem>();
  const discarded = new Map<string, WeeklyItem>();
  for (const t of input.transitions) {
    if (!inWeek(week, t.at)) continue;
    const b = boards.get(t.board);
    if (!b) continue;
    const def = b.config.statuses.find((s) => s.id === t.to);
    if (!def?.terminal) continue;
    const key = `${t.board}/${t.cardId}`;
    const target = deliveredStatusIds(b.config).has(t.to) ? live : discarded;
    const prev = target.get(key);
    if (!prev || prev.at < t.at) target.set(key, item(t.board, t.cardId, t.at));
  }
  const decisions = input.decisions.filter((d) => inWeek(week, d.at));
  for (const d of decisions) {
    if (d.kind !== "triage-discard" || !d.cardId) continue;
    const key = `${d.board}/${d.cardId}`;
    if (!discarded.has(key)) discarded.set(key, item(d.board, d.cardId, d.at));
  }
  for (const key of live.keys()) discarded.delete(key);

  const counts = new Map<SystemDecisionKind, number>();
  for (const d of decisions) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  const byKind = [...counts.entries()]
    .map(([kind, count]) => ({ kind, label: DECISION_KIND_LABEL[kind] ?? kind, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const weekRuns = input.runs.filter((r) => r.startedAt >= week.start && r.startedAt < week.end);
  const projections: WeeklySummary["cost"]["projections"] = [];
  for (const l of live.values()) {
    const impact = cardOf(l.boardId, l.cardId)?.costImpact;
    if (impact) projections.push({ ...l, impact });
  }

  const health = weeklyHealthTrend(input.health ?? [], week);
  const byTime = (a: WeeklyItem, b: WeeklyItem) => a.at.localeCompare(b.at);
  return {
    week,
    live: [...live.values()].sort(byTime),
    discarded: [...discarded.values()].sort(byTime),
    dilemmas: decisions.filter((d) => d.kind === "dilemma").map((d) => ({ ...d, boardName: nameOf(d.board) })),
    systemDecisions: { total: decisions.length, byKind },
    cost: {
      automationUSD: Math.round(weekRuns.reduce((s, r) => s + (r.costUSD ?? 0), 0) * 100) / 100,
      runs: weekRuns.length,
      projectedMonthly: projectedByCurrency(projections.map((p) => p.impact)),
      projections,
    },
    waiting: input.waiting.map((w) => ({ ...w, boardName: nameOf(w.boardId) })),
    ...(input.rollout ? { rollout: input.rollout } : {}),
    ...(health ? { health } : {}),
  };
}

/** O link da página de uma semana. */
export function weeklySummaryHref(monday: string): string {
  return `/semana?de=${monday}`;
}

/** O texto do push de segunda: uma linha com os números, sem jargão. PURA. */
export function weeklyPushText(s: WeeklySummary): { title: string; body: string } {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    `${n(s.live.length, "entrega", "entregas")} no ar`,
    `${n(s.systemDecisions.total, "decisão", "decisões")} do sistema`,
    s.waiting.length ? `${n(s.waiting.length, "decisão sua esperando", "decisões suas esperando")}` : "nada esperando você",
  ];
  return { title: "Resumo da semana", body: `${parts.join(" · ")}.` };
}
