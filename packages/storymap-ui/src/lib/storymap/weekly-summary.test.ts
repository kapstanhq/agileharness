// O RESUMO DA SEMANA: a janela da semana no fuso do operador, a hora do push de segunda e o
// que entra em cada seção. O push em si (o único não-crítico) é testado com fakes no fim.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "./repo";
import type { OwnerWaiting } from "./owner-waiting";
import type { SystemDecision } from "./system-decisions";
import type { BoardConfig } from "./types";
import {
  addDays,
  buildWeeklySummary,
  isMonday,
  localClock,
  mondayOf,
  weekWindow,
  weeklyHealthTrend,
  weeklyPushDue,
  weeklyPushText,
} from "./weekly-summary";
import type { HealthLevel, HealthRecord, HealthSignalId } from "./health/ah-health";
import { sendWeeklySummaryIfDue, type WeeklyPushDeps } from "./runner/weekly-summary-push";

const SP = "America/Sao_Paulo";
const at = (iso: string) => Date.parse(iso);

describe("a semana no fuso do dono", () => {
  it("segunda 09:00 em São Paulo é 12:00 UTC; a semana começa na meia-noite local (03:00 UTC)", () => {
    expect(localClock(at("2026-06-15T12:00:00Z"), SP)).toMatchObject({ date: "2026-06-15", weekday: 1, hour: 9 });
    expect(mondayOf(at("2026-06-15T02:59:00Z"), SP)).toBe("2026-06-08"); // ainda domingo em São Paulo
    const w = weekWindow("2026-06-08", SP);
    expect(w).toEqual({ from: "2026-06-08", to: "2026-06-14", start: at("2026-06-08T03:00:00Z"), end: at("2026-06-15T03:00:00Z") });
    expect(addDays("2026-06-15", -7)).toBe("2026-06-08");
  });

  it("só uma segunda de verdade vale como `?de=`", () => {
    expect(isMonday("2026-06-08")).toBe(true);
    expect(isMonday("2026-06-09")).toBe(false);
    expect(isMonday("2026-02-30")).toBe(false);
    expect(isMonday("../x")).toBe(false);
  });
});

describe("weeklyPushDue — segunda às 9h, uma vez", () => {
  it("antes das 9h não; às 9h sim (a chave é a segunda de hoje); já enviado não; terça não", () => {
    expect(weeklyPushDue(at("2026-06-15T11:59:00Z"), SP, null)).toBeNull();
    expect(weeklyPushDue(at("2026-06-15T12:00:00Z"), SP, "2026-06-08")).toBe("2026-06-15");
    expect(weeklyPushDue(at("2026-06-15T20:00:00Z"), SP, "2026-06-15")).toBeNull();
    expect(weeklyPushDue(at("2026-06-16T12:00:00Z"), SP, "2026-06-08")).toBeNull();
    // 09:00 UTC de segunda ainda é 06:00 em São Paulo
    expect(weeklyPushDue(at("2026-06-15T09:00:00Z"), SP, null)).toBeNull();
  });
});

const statuses = [
  { id: "desenvolver", name: "Desenvolver" },
  { id: "concluida", name: "No ar", terminal: true, delivered: true },
  { id: "arquivados", name: "Arquivados", terminal: true },
];
const board = (id: string, name: string, cards: ReturnType<typeof coerceCard>[]) => ({
  id,
  name,
  config: { id, name, statuses, releases: [], personas: [], systems: [], linkTypes: [] } as unknown as BoardConfig,
  cards,
});
const card = (id: string, title: string, extra: Record<string, unknown> = {}) => coerceCard(id, { type: "story", title, status: "concluida", ...extra }, "");
const decision = (over: Partial<SystemDecision>): SystemDecision => ({ v: 1, id: over.id ?? "d", at: "2026-06-10T15:00:00Z", board: "armazem", agent: "system", kind: "proxy-answer", what: "x", why: "y", ...over });

describe("buildWeeklySummary", () => {
  const week = weekWindow("2026-06-08", SP);
  const armazem = board("armazem", "Armazem", [
    card("story-a", "Busca por autor", { costImpact: { monthlyBRL: 12, scope: "infra", assumptions: "uma consulta a mais por busca", by: "harness-conductor", at: "2026-06-09" } }),
    card("story-b", "Capa interativa", { status: "arquivados" }),
    card("story-c", "Antiga"),
  ]);
  const spot = board("balcao", "Balcao", [card("story-d", "Ideia repetida", { status: "arquivados" })]);
  const waiting: OwnerWaiting[] = [{ boardId: "armazem", cardId: "story-q", cardTitle: "Push", kind: "question", what: "Mandamos push para todos?", ownerClass: "Falar em nome da marca", since: "2026-06--3", days: 18 }];
  const s = buildWeeklySummary({
    week,
    boards: [armazem, spot],
    transitions: [
      { at: "2026-06-11T18:00:00Z", board: "armazem", cardId: "story-a", to: "concluida" },
      { at: "2026-06-12T10:00:00Z", board: "armazem", cardId: "story-b", to: "arquivados" },
      { at: "2026-06-05T10:00:00Z", board: "armazem", cardId: "story-c", to: "concluida" }, // semana anterior
      { at: "2026-06-13T10:00:00Z", board: "armazem", cardId: "story-a", to: "desenvolver" }, // não terminal
    ],
    decisions: [
      decision({ id: "1", kind: "triage-discard", board: "balcao", cardId: "story-d", what: "Descartou" }),
      decision({ id: "2", kind: "dilemma", cardId: "story-a", what: "Entregar sem o filtro por editora", why: "a meta é o primeiro uso" }),
      decision({ id: "3", kind: "proxy-answer" }),
      decision({ id: "4", kind: "proxy-answer" }),
      decision({ id: "5", kind: "proxy-answer", at: "2026-06-16T15:00:00Z" }), // semana seguinte
    ],
    runs: [
      { startedAt: at("2026-06-09T12:00:00Z"), costUSD: 1.25 },
      { startedAt: at("2026-06-10T12:00:00Z"), costUSD: null },
      { startedAt: at("2026-06-07T12:00:00Z"), costUSD: 9 }, // fora
    ],
    waiting,
  });

  it("no ar e descartado: pelas chegadas a terminal na semana (entrega × não-entrega) e pelo descarte da triagem", () => {
    expect(s.live.map((i) => [i.boardName, i.title])).toEqual([["Armazem", "Busca por autor"]]);
    expect(s.discarded.map((i) => [i.boardName, i.title])).toEqual([
      ["Balcao", "Ideia repetida"],
      ["Armazem", "Capa interativa"],
    ]);
  });

  it("dilemas, as decisões do sistema por tipo (com nome em português) e só as da semana", () => {
    expect(s.dilemmas).toEqual([expect.objectContaining({ what: "Entregar sem o filtro por editora", boardName: "Armazem" })]);
    expect(s.systemDecisions.total).toBe(4);
    expect(s.systemDecisions.byKind[0]).toEqual({ kind: "proxy-answer", label: "Respondeu perguntas técnicas", count: 2 });
  });

  it("o que o vigia de cards parados fez entra no resumo com nome em português, nunca o id do tipo", () => {
    const stalls = buildWeeklySummary({
      week,
      boards: [armazem],
      transitions: [],
      decisions: [decision({ id: "r", kind: "stall-retry" }), decision({ id: "f", kind: "stall-fix-card" })],
      runs: [],
      waiting: [],
    });
    expect(stalls.systemDecisions.byKind).toEqual([
      { kind: "stall-fix-card", label: "Abriu consertos para cards travados", count: 1 },
      { kind: "stall-retry", label: "Refez passos parados", count: 1 },
    ]);
  });

  it("custo: a automação da semana e o que o que foi ao ar projetou por mês", () => {
    expect(s.cost).toMatchObject({ automationUSD: 1.25, runs: 2, projectedMonthlyBRL: 12 });
    expect(s.cost.projections).toEqual([expect.objectContaining({ title: "Busca por autor", impact: expect.objectContaining({ monthlyBRL: 12 }) })]);
  });

  it("o que espera o dono vem junto — o lembrete semanal — e o push diz os números sem jargão", () => {
    expect(s.waiting).toEqual([expect.objectContaining({ what: "Mandamos push para todos?", boardName: "Armazem", days: 18 })]);
    expect(weeklyPushText(s)).toEqual({ title: "Resumo da semana", body: "1 entrega no ar · 4 decisões do sistema · 1 decisão sua esperando." });
  });
});

describe("a linha de tendência da saúde da ferramenta", () => {
  const week = weekWindow("2026-06-15", SP); // 03:00Z de uma segunda a 03:00Z da segunda seguinte
  const rec = (iso: string, levels: Partial<Record<HealthSignalId, [HealthLevel, number | null]>>): HealthRecord => ({
    v: 1,
    at: iso,
    signals: Object.fromEntries(Object.entries(levels).map(([id, [level, value]]) => [id, { level, value }])),
  });
  // uma semana típica: S6 vermelho (8 h) no começo, sem nada no ar; no fim, entregue; S11 segue não medível
  const first = rec("2026-06-17T12:00:00Z", { S1: ["red", 11], S6: ["red", 8], S3: ["ok", 0], S11: ["unknown", null] });
  const last = rec("2026-06-19T12:00:00Z", { S1: ["amber", 2], S6: ["ok", 0.4], S3: ["ok", 0], S11: ["unknown", null] });

  it("compara a PRIMEIRA com a ÚLTIMA leitura da semana e diz o estado de agora", () => {
    const h = weeklyHealthTrend([last, first], week); // fora de ordem de propósito
    expect(h).toMatchObject({ readings: 2, from: first.at, to: last.at, worst: "amber", red: [] });
    expect(h!.trend).toBe("melhorou: S1 (11→2), S6 (8→0.4); piorou: nenhum");
    expect(h!.now).toBe("1 em atenção (S1) · 2 ok · 1 não medível (S11)");
  });

  it("uma leitura só: o estado, sem tendência inventada", () => {
    expect(weeklyHealthTrend([first], week)).toMatchObject({ readings: 1, worst: "red", red: ["S1", "S6"], trend: null });
  });

  it("leitura fora da semana não entra; sem nenhuma na semana, null (a seção some — nada de «tudo bem» sem medir)", () => {
    const before = rec("2026-06-14T12:00:00Z", { S1: ["red", 99] }); // domingo, semana anterior
    expect(weeklyHealthTrend([before], week)).toBeNull();
    expect(weeklyHealthTrend([], week)).toBeNull();
    expect(weeklyHealthTrend([before, last], week)).toMatchObject({ readings: 1, from: last.at });
  });

  it("entra no resumo da semana quando o tick gravou leitura; fica fora quando não gravou", () => {
    const base = { week, boards: [], transitions: [], decisions: [], runs: [], waiting: [] };
    expect(buildWeeklySummary({ ...base, health: [first, last] }).health).toMatchObject({ readings: 2, worst: "amber" });
    expect(buildWeeklySummary(base).health).toBeUndefined();
    expect(buildWeeklySummary({ ...base, health: [] }).health).toBeUndefined();
  });
});

describe("o push de segunda (o único não-crítico)", () => {
  function deps(last: string | null) {
    const state = { last, sent: [] as unknown[] };
    const d: WeeklyPushDeps = {
      timeZone: () => SP,
      loadLastSent: async () => state.last,
      saveLastSent: async (m) => void (state.last = m),
      summarize: vi.fn(async (monday: string) => buildWeeklySummary({ week: weekWindow(monday, SP), boards: [], transitions: [], decisions: [], runs: [], waiting: [] })),
      publish: (a) => void state.sent.push(a),
    };
    return { d, state };
  }

  it("segunda às 9h: resume a semana que ACABOU, com o link para ela; uma vez só", async () => {
    const { d, state } = deps("2026-06-08");
    expect(await sendWeeklySummaryIfDue(d, at("2026-06-15T12:05:00Z"))).toBe("2026-06-15");
    expect(d.summarize).toHaveBeenCalledWith("2026-06-08");
    expect(state.sent).toEqual([expect.objectContaining({ kind: "weekly-summary", event: "weekly-summary", urgency: "pending", url: "/semana?de=2026-06-08" })]);
    expect(await sendWeeklySummaryIfDue(d, at("2026-06-15T12:10:00Z"))).toBeNull();
    expect(state.sent).toHaveLength(1);
  });

  it("fora da hora, nada", async () => {
    const { d, state } = deps(null);
    expect(await sendWeeklySummaryIfDue(d, at("2026-06-14T12:00:00Z"))).toBeNull();
    expect(state.sent).toEqual([]);
  });
});
