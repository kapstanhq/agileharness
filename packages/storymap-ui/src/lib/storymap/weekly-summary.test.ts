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
  formatImpactMoney,
  projectedMonthlyText,
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
  const entreposto = board("entreposto", "Entreposto", [
    card("story-e1", "Etiqueta de prateleira", {
      costImpact: { monthlyAmount: 7, currency: "EUR", scope: "infra", assumptions: "uma impressão térmica por lote", by: "agente-de-teste", at: "2026-06-10" },
    }),
    card("story-e2", "Contagem cíclica"),
    card("story-e3", "Mapa de corredores", { status: "arquivados" }),
    card("story-e4", "Rascunho de inventário"),
  ]);
  const oficina = board("oficina", "Oficina", [card("story-o1", "Pedido em dobro", { status: "arquivados" })]);
  const waiting: OwnerWaiting[] = [
    { boardId: "oficina", cardId: "story-w1", cardTitle: "Aviso aos clientes", kind: "question", what: "Avisamos os clientes antigos por e-mail?", ownerClass: "Falar em nome da marca", since: "2026-05-30", days: 9 },
    { boardId: "entreposto", cardId: "story-w2", cardTitle: "Plano de etiquetas", kind: "question", what: "Assinamos o plano anual da impressora?", ownerClass: "Dinheiro e preço", since: "2026-06-12", days: 2 },
  ];
  const s = buildWeeklySummary({
    week,
    boards: [entreposto, oficina],
    transitions: [
      { at: "2026-06-09T14:00:00Z", board: "entreposto", cardId: "story-e1", to: "concluida" },
      { at: "2026-06-12T21:00:00Z", board: "entreposto", cardId: "story-e2", to: "concluida" },
      { at: "2026-06-11T09:30:00Z", board: "entreposto", cardId: "story-e3", to: "arquivados" },
      { at: "2026-06-02T16:00:00Z", board: "entreposto", cardId: "story-e4", to: "concluida" }, // semana anterior
      { at: "2026-06-13T08:00:00Z", board: "entreposto", cardId: "story-e2", to: "desenvolver" }, // não terminal
    ],
    decisions: [
      decision({ id: "1", kind: "triage-discard", board: "oficina", cardId: "story-o1", what: "Descartou" }),
      decision({ id: "2", kind: "dilemma", board: "entreposto", cardId: "story-e2", what: "Publicar sem a contagem por turno", why: "a primeira versão só precisa do total" }),
      decision({ id: "3", kind: "proxy-answer" }),
      decision({ id: "4", kind: "proxy-answer" }),
      decision({ id: "5", kind: "proxy-answer" }),
      decision({ id: "6", kind: "proxy-answer", at: "2026-06-15T18:00:00Z" }), // semana seguinte
    ],
    runs: [
      { startedAt: at("2026-06-08T13:00:00Z"), costUSD: 0.8 },
      { startedAt: at("2026-06-11T13:00:00Z"), costUSD: 2.1 },
      { startedAt: at("2026-06-12T13:00:00Z"), costUSD: null },
      { startedAt: at("2026-06-01T13:00:00Z"), costUSD: 5 }, // fora
    ],
    waiting,
  });

  it("no ar e descartado: pelas chegadas a terminal na semana (entrega × não-entrega) e pelo descarte da triagem", () => {
    expect(s.live.map((i) => [i.boardName, i.title])).toEqual([
      ["Entreposto", "Etiqueta de prateleira"],
      ["Entreposto", "Contagem cíclica"],
    ]);
    expect(s.discarded.map((i) => [i.boardName, i.title]).sort()).toEqual([
      ["Entreposto", "Mapa de corredores"],
      ["Oficina", "Pedido em dobro"],
    ]);
  });

  it("dilemas, as decisões do sistema por tipo (com nome em português) e só as da semana", () => {
    expect(s.dilemmas).toEqual([expect.objectContaining({ what: "Publicar sem a contagem por turno", boardName: "Entreposto" })]);
    expect(s.systemDecisions.total).toBe(5);
    expect(s.systemDecisions.byKind[0]).toEqual({ kind: "proxy-answer", label: "Respondeu perguntas técnicas", count: 3 });
  });

  it("o que o vigia de cards parados fez entra no resumo com nome em português, nunca o id do tipo", () => {
    const stalls = buildWeeklySummary({
      week,
      boards: [entreposto],
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

  it("custo: a automação da semana e o que o que foi ao ar projetou por mês, na moeda do próprio impacto", () => {
    expect(s.cost).toMatchObject({ runs: 3, projectedMonthly: [{ currency: "EUR", amount: 7 }] });
    expect(s.cost.automationUSD).toBeCloseTo(2.9);
    expect(s.cost.projections).toEqual([expect.objectContaining({ title: "Etiqueta de prateleira", impact: expect.objectContaining({ monthlyAmount: 7, currency: "EUR" }) })]);
  });

  it("o que espera o dono vem junto — o lembrete semanal — e o push diz os números sem jargão", () => {
    expect(s.waiting).toEqual([
      expect.objectContaining({ what: "Avisamos os clientes antigos por e-mail?", boardName: "Oficina", days: 9 }),
      expect.objectContaining({ what: "Assinamos o plano anual da impressora?", boardName: "Entreposto", days: 2 }),
    ]);
    expect(weeklyPushText(s)).toEqual({ title: "Resumo da semana", body: "2 entregas no ar · 5 decisões do sistema · 2 decisões suas esperando." });
  });
});

describe("a linha de tendência da saúde da ferramenta", () => {
  const week = weekWindow("2026-06-15", SP); // 03:00Z de uma segunda a 03:00Z da segunda seguinte
  const rec = (iso: string, levels: Partial<Record<HealthSignalId, [HealthLevel, number | null]>>): HealthRecord => ({
    v: 1,
    at: iso,
    signals: Object.fromEntries(Object.entries(levels).map(([id, [level, value]]) => [id, { level, value }])),
  });
  // uma semana com um sinal que sai do vermelho, outro que entra nele, dois parados e um que não se mede
  const first = rec("2026-06-16T08:30:00Z", { S2: ["amber", 4], S5: ["red", 26], S7: ["ok", 1], S9: ["ok", 0], S12: ["unknown", null] });
  const last = rec("2026-06-20T18:00:00Z", { S2: ["red", 9], S5: ["ok", 3], S7: ["ok", 1], S9: ["ok", 0], S12: ["unknown", null] });

  it("compara a PRIMEIRA com a ÚLTIMA leitura da semana e diz o estado de agora", () => {
    const h = weeklyHealthTrend([last, first], week); // fora de ordem de propósito
    expect(h).toMatchObject({ readings: 2, from: first.at, to: last.at, worst: "red", red: ["S2"] });
    expect(h!.trend).toBe("melhorou: S5 (26→3); piorou: S2 (4→9)");
    expect(h!.now).toBe("1 vermelho (S2) · 3 ok · 1 não medível (S12)");
  });

  it("uma leitura só: o estado, sem tendência inventada", () => {
    expect(weeklyHealthTrend([first], week)).toMatchObject({ readings: 1, worst: "red", red: ["S5"], trend: null });
  });

  it("leitura fora da semana não entra; sem nenhuma na semana, null (a seção some — nada de «tudo bem» sem medir)", () => {
    const before = rec("2026-06-14T12:00:00Z", { S1: ["red", 99] }); // domingo, semana anterior
    expect(weeklyHealthTrend([before], week)).toBeNull();
    expect(weeklyHealthTrend([], week)).toBeNull();
    expect(weeklyHealthTrend([before, last], week)).toMatchObject({ readings: 1, from: last.at });
  });

  it("entra no resumo da semana quando o tick gravou leitura; fica fora quando não gravou", () => {
    const base = { week, boards: [], transitions: [], decisions: [], runs: [], waiting: [] };
    expect(buildWeeklySummary({ ...base, health: [first, last] }).health).toMatchObject({ readings: 2, worst: "red" });
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

describe("o custo projetado da semana — por MOEDA, nunca somado entre moedas", () => {
  const week2 = weekWindow("2026-06-08", SP);
  const legacy = (id: string, monthlyBRL: number) => card(id, id, { costImpact: { monthlyBRL, scope: "infra", assumptions: "um job noturno a mais", by: "x", at: "2026-06-09" } });
  const neutral = (id: string, monthlyAmount: number, currency: string) =>
    card(id, id, { costImpact: { monthlyAmount, currency, scope: "cash", assumptions: "um plano a mais", by: "x", at: "2026-06-09" } });
  const arrive = (boardId: string, ids: string[]) => ids.map((cardId) => ({ at: "2026-06-11T18:00:00Z", board: boardId, cardId, to: "concluida" }));
  const build = (boards: ReturnType<typeof board>[]) =>
    buildWeeklySummary({
      week: week2,
      boards,
      transitions: boards.flatMap((b) => arrive(b.id, b.cards.map((c) => c.id))),
      decisions: [],
      runs: [],
      waiting: [],
    });

  it("dois boards, BRL (grafia legada) e USD (neutra): duas entradas, nada de soma entre moedas", () => {
    const s2 = build([board("oficina", "Oficina", [legacy("story-ex9970", 12), legacy("story-ex9971", 8.5)]), board("livraria", "Livraria", [neutral("story-ex9972", 30, "USD")])]);
    expect(s2.cost.projectedMonthly).toEqual([
      { currency: "BRL", amount: 20.5 },
      { currency: "USD", amount: 30 },
    ]);
    expect(s2.cost.projections).toHaveLength(3);
  });

  it("um card legado segue BRL mesmo que o alvo declare outra moeda hoje (o dado carrega a dele); arredondamento a 2 casas", () => {
    const s2 = build([board("oficina", "Oficina", [legacy("story-ex9973", 0.1), legacy("story-ex9974", 0.2)])]);
    expect(s2.cost.projectedMonthly).toEqual([{ currency: "BRL", amount: 0.3 }]);
  });

  it("a frase: BRL/pt-BR sai igual à de sempre; USD não vira R$; sem projeção mantém «nenhum custo a mais por mês»", () => {
    expect(formatImpactMoney(15, "BRL")).toBe((15).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
    expect(projectedMonthlyText([{ currency: "BRL", amount: 15 }])).toBe(`+${(15).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} por mês`);
    expect(projectedMonthlyText([{ currency: "USD", amount: 12 }])).not.toContain("R$");
    expect(projectedMonthlyText([{ currency: "BRL", amount: 5 }, { currency: "USD", amount: 7 }])).toMatch(/^\+.*5.* e \+.*7.* por mês$/);
    expect(projectedMonthlyText([])).toBe("nenhum custo a mais por mês");
    expect(projectedMonthlyText([{ currency: "BRL", amount: 0 }])).toBe("nenhum custo a mais por mês");
  });
});
