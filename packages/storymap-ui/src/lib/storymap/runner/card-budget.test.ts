// O teto de gasto de IA do card e o seu aumento (fatia 3 das «paradas por recurso»):
// o sistema aprova sozinho até +30%, uma vez por card, e só com a cota no ritmo; fora disso espera a cota ou vai ao dono.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import { applyUndoToCard, type SystemDecision } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card, CardQuestion } from "@/lib/storymap/types";
import {
  BUDGET_APPROVE_OPTION,
  DEFAULT_BUDGET_RAISE,
  approveAsSystem,
  approvedRaises,
  budgetQuestion,
  budgetRequestUSD,
  capLine,
  effectiveCardBudgetUSD,
  judgeBudgetRequest,
  openBudgetRequests,
  quotaPace,
  sweepCardBudgets,
  type BudgetSweepCard,
  type CardBudgetSweepDeps,
  type QuotaReading,
} from "./card-budget";

const WEEK = 7 * 24 * 60 * 60_000;
const RESET = Date.UTC(2026, 2, 11, 5, 0); // a semana vai de qua 04/03 05:00Z a qua 11/03 05:00Z
const at = (pctOfWeek: number) => RESET - WEEK + (WEEK * pctOfWeek) / 100;
const reading = (usage7dPct: number, usage5hPct: number | null = 10, stale = false): QuotaReading => ({ usage7dPct, usage5hPct, resetsAt7d: RESET, stale });
const S = DEFAULT_BUDGET_RAISE;
const ON = { onPace: true, detail: "a semana consumiu 20% da cota com 50% do tempo decorrido" };
const OFF = { onPace: false, detail: "a semana já consumiu 38% da cota com 25% do tempo decorrido" };

const req = (id: string, toUSD: number, state: "open" | "approved" | "refused" = "open", by?: string): CardQuestion => ({
  id,
  text: `Subir o teto para ${toUSD}?`,
  askedBy: `teto:${toUSD}`,
  status: state === "open" ? "open" : "answered",
  category: "money",
  ...(state === "approved" ? { selectedOptionIds: [BUDGET_APPROVE_OPTION], answeredBy: by } : {}),
  ...(state === "refused" ? { selectedOptionIds: ["o2"] } : {}),
});
const cardWith = (questions: CardQuestion[]): Card => coerceCard("story-x", { type: "story", storyType: "bug", title: "Ajuste da vitrine", status: "desenvolver", routing: { driver: "conductor" }, questions }, "");

describe("o teto em vigor é derivado das perguntas de teto do card", () => {
  it("sem pedido aprovado vale o teto do settings; com um, o maior valor aprovado; sem teto no settings não há teto", () => {
    expect(effectiveCardBudgetUSD(40, cardWith([]))).toBe(40);
    expect(effectiveCardBudgetUSD(40, cardWith([req("q1", 50, "approved")]))).toBe(50);
    expect(effectiveCardBudgetUSD(40, cardWith([req("q1", 50, "open"), req("q2", 60, "refused")]))).toBe(40);
    expect(effectiveCardBudgetUSD(undefined, cardWith([req("q1", 50, "approved")]))).toBeNull();
    expect(effectiveCardBudgetUSD(0, cardWith([]))).toBeNull();
  });

  it("só uma pergunta com o marcador de teto conta — uma pergunta de dinheiro qualquer com a primeira opção escolhida não sobe nada", () => {
    const other: CardQuestion = { id: "q9", text: "Contratar o plano pago?", status: "answered", category: "money", selectedOptionIds: ["o1"] };
    expect(effectiveCardBudgetUSD(40, cardWith([other]))).toBe(40);
    expect(budgetRequestUSD({ askedBy: "teto:50" })).toBe(50);
    expect(budgetRequestUSD({ askedBy: "teto:52.5" })).toBe(52.5);
    for (const bad of ["teto:", "teto:-5", "teto:abc", "harness-conductor", undefined]) expect(budgetRequestUSD({ askedBy: bad })).toBeNull();
  });

  it("separa aprovados de abertos (reabrir a pergunta desfaz o aumento)", () => {
    const card = cardWith([req("q1", 50, "approved", "system"), req("q2", 60, "open")]);
    expect(approvedRaises(card)).toEqual([{ toUSD: 50, by: "system", questionId: "q1" }]);
    expect(openBudgetRequests(card)).toEqual([{ toUSD: 60, questionId: "q2", ownerOnly: false }]);
    const reopened = cardWith([{ ...req("q1", 50, "open") }]);
    expect(effectiveCardBudgetUSD(40, reopened)).toBe(40);
  });
});

describe("quotaPace — «no ritmo da semana»", () => {
  it("consumo igual ou abaixo do tempo decorrido, e janela de 5 horas abaixo de 70% ⇒ no ritmo", () => {
    expect(quotaPace(reading(50), at(50), S).onPace).toBe(true);
    expect(quotaPace(reading(20), at(50), S)).toMatchObject({ onPace: true, detail: expect.stringMatching(/20% da cota com 50% do tempo/) });
  });
  it("38% consumido com 25% da semana decorrida ⇒ fora do ritmo, e a frase diz os dois números", () => {
    expect(quotaPace(reading(38), at(25), S)).toEqual({ onPace: false, detail: "a semana já consumiu 38% da cota com 25% do tempo decorrido" });
  });
  it("janela de 5 horas em 70% ou mais ⇒ fora do ritmo, mesmo com a semana folgada", () => {
    expect(quotaPace(reading(10, 70), at(50), S).onPace).toBe(false);
    expect(quotaPace(reading(10, 69), at(50), S).onPace).toBe(true);
    expect(quotaPace(reading(10, null), at(50), S).onPace).toBe(true); // o medidor não reporta a janela: vale a semana
  });
  it("sem leitura, ou com leitura velha, NÃO está no ritmo (sem saber quanto resta, o sistema não gasta mais sozinho)", () => {
    expect(quotaPace(null, at(50), S).onPace).toBe(false);
    expect(quotaPace(reading(1, 1, true), at(50), S).onPace).toBe(false);
  });
});

describe("judgeBudgetRequest — a régua do pedido", () => {
  const judge = (toUSD: number, card = cardWith([]), pace = ON, capUSD: number | null = 40) => judgeBudgetRequest({ capUSD, card, toUSD, pace, settings: S });

  it("o caso 40 → 50 (+25%) com a cota no ritmo: o sistema aprova", () => {
    expect(judge(50)).toMatchObject({ kind: "approved", toUSD: 50 });
    expect(judge(52)).toMatchObject({ kind: "approved" }); // exatamente +30%
  });
  it("acima de +30% é do dono, e o motivo diz o limite", () => {
    expect(judge(53)).toMatchObject({ kind: "owner", why: expect.stringMatching(/até US\$ 52,/) });
  });
  it("cota fora do ritmo: o pedido espera — não vai ao dono como decisão, nem é aprovado", () => {
    expect(judge(50, cardWith([]), OFF)).toEqual({ kind: "wait-quota", toUSD: 50, why: OFF.detail });
  });
  it("uma vez por card: com um aumento já aprovado (pelo sistema ou pelo dono) o segundo é do dono", () => {
    expect(judge(51, cardWith([req("q1", 46, "approved", "system")]))).toMatchObject({ kind: "owner", why: expect.stringMatching(/já teve um aumento/) });
    expect(judge(51, cardWith([req("q1", 46, "approved")]))).toMatchObject({ kind: "owner" });
  });
  it("pedido que já cabe no teto em vigor não precisa de nada; sem teto no settings não há o que julgar", () => {
    expect(judge(40)).toEqual({ kind: "not-needed", capUSD: 40 });
    expect(judge(47, cardWith([req("q1", 50, "approved")]))).toEqual({ kind: "not-needed", capUSD: 50 });
    expect(judge(50, cardWith([]), ON, null)).toEqual({ kind: "no-cap" });
  });
  it("`maxPct: 0` desliga a aprovação automática: tudo é do dono", () => {
    expect(judgeBudgetRequest({ capUSD: 40, card: cardWith([]), toUSD: 41, pace: ON, settings: { ...S, maxPct: 0 } })).toMatchObject({ kind: "owner" });
  });
});

describe("a pergunta que o dono vê", () => {
  it("é de dinheiro, marcada como do dono, com a PRIMEIRA opção aprovando, e explica a espera pela cota", () => {
    const q = budgetQuestion({ id: "q3", toUSD: 50, capUSD: 40, spentUSD: 28.9, reason: "falta a verificação final (US$ 8–12)", verdict: { kind: "wait-quota", toUSD: 50, why: OFF.detail }, today: "2026-03-09" });
    expect(q).toMatchObject({ id: "q3", status: "open", category: "money", ownerClass: "money", askedBy: "teto:50", text: "Subir o teto de gasto deste card de US$ 40 para US$ 50?" });
    expect(q.options?.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
    expect(q.options?.[0].label).toBe("Subir o teto para US$ 50");
    expect(q.context).toMatch(/^\[humano\]/);
    expect(q.context).toMatch(/US\$ 28,90 de um teto de US\$ 40/);
    expect(q.context).toMatch(/será aprovado automaticamente quando a cota voltar ao ritmo/);
  });
  it("aprovada pelo sistema: respondida, com a opção de aprovar e a assinatura `system`", () => {
    const q = approveAsSystem(req("q3", 50), "cabe no envelope", "2026-03-09");
    expect(q).toMatchObject({ status: "answered", answeredBy: "system", selectedOptionIds: ["o1"], answeredAt: "2026-03-09" });
    expect(effectiveCardBudgetUSD(40, cardWith([q]))).toBe(50);
  });
});

describe("«Desfazer» a aprovação do sistema — de ponta a ponta, pelas funções reais", () => {
  it("reabre a pergunta: o teto volta ao do settings, e o carimbo SOBREVIVE a uma leitura do card (a regra não aprova de novo)", () => {
    const approvedBySystem = approveAsSystem(req("q3", 50), "cabe no envelope", "2026-03-09");
    const before = cardWith([approvedBySystem]);
    expect(effectiveCardBudgetUSD(40, before)).toBe(50);
    const config = { id: "b", name: "B", statuses: [{ id: "desenvolver", name: "Desenvolver" }], releases: [], personas: [], systems: [], linkTypes: [] } as unknown as BoardConfig;
    const undone = applyUndoToCard({ kind: "reopen-question", cardId: "story-x", questionId: "q3" }, before, config, { today: "2026-03-10", note: "não quero gastar mais neste card" });
    // o que o disco devolve: o card relido pelo mesmo leitor que o serviço usa
    const reread = coerceCard("story-x", JSON.parse(JSON.stringify({ type: "story", storyType: "bug", title: "Ajuste da vitrine", status: "desenvolver", questions: undone.questions })), "");
    expect(effectiveCardBudgetUSD(40, reread)).toBe(40);
    expect(openBudgetRequests(reread)).toEqual([{ toUSD: 50, questionId: "q3", ownerOnly: true }]);
  });
});

function sweepWorld(rows: BudgetSweepCard[], opts: { quota?: QuotaReading | null; now?: number; cap?: number | null; master?: boolean } = {}) {
  const decisions: SystemDecision[] = [];
  const lines: string[] = [];
  const deps: CardBudgetSweepDeps = {
    masterEnabled: () => opts.master ?? true,
    capUSD: () => (opts.cap === undefined ? 40 : opts.cap),
    settings: () => S,
    quota: () => (opts.quota === undefined ? reading(20) : opts.quota),
    cards: async () => rows,
    approve: vi.fn(async () => true),
    wake: vi.fn(async () => {}),
    warn: vi.fn(async () => true),
    record: async (e) => {
      decisions.push(e);
    },
    warned: new Map(),
    now: () => opts.now ?? at(50),
    log: (l) => lines.push(l),
  };
  return { deps, decisions, lines };
}
const row = (card: Card, spentUSD = 30, live = false): BudgetSweepCard => ({ board: "b", card, spentUSD, liveConductor: live ? { sessionId: "s1", tmuxSession: "agent-conductor-story-x-ab12" } : null });

describe("sweepCardBudgets — aprova o que esperava a cota e avisa quem passou do teto", () => {
  it("a cota voltou ao ritmo: o pedido aberto dentro do envelope é aprovado, registrado (com desfazer = reabrir) e o condutor é acordado", async () => {
    const w = sweepWorld([row(cardWith([req("q3", 50)]))]);
    expect((await sweepCardBudgets(w.deps)).approved).toEqual([{ board: "b", cardId: "story-x", toUSD: 50 }]);
    expect(w.deps.approve).toHaveBeenCalledWith("b", "story-x", "q3", expect.stringMatching(/cabe no que o sistema aprova sozinho/));
    expect(w.deps.wake).toHaveBeenCalledWith("b", "story-x", "q3");
    expect(w.decisions[0]).toMatchObject({ kind: "budget-raise", agent: "system", cardId: "story-x", what: "Subiu o teto de gasto de «Ajuste da vitrine» de US$ 40 para US$ 50", undo: { kind: "reopen-question", cardId: "story-x", questionId: "q3" } });
  });

  it("cota ainda fora do ritmo, pedido acima do envelope ou segundo aumento: o sistema não toca — é espera ou é do dono", async () => {
    const offPace = sweepWorld([row(cardWith([req("q3", 50)]))], { quota: reading(38), now: at(25) });
    const tooBig = sweepWorld([row(cardWith([req("q3", 60)]))]);
    const second = sweepWorld([row(cardWith([req("q1", 46, "approved", "system"), req("q3", 51)]))]);
    for (const w of [offPace, tooBig, second]) {
      expect((await sweepCardBudgets(w.deps)).approved).toEqual([]);
      expect(w.deps.approve).not.toHaveBeenCalled();
    }
  });

  it("o dono DESFEZ a aprovação do sistema: a pergunta volta aberta e a regra nunca mais a aprova sozinha", async () => {
    // o carimbo que o «Desfazer» deixa (system-decisions.ts) — com premissa não vazia, senão a leitura do card o descarta
    const undone: CardQuestion = { ...req("q3", 50), proxy: { assumptions: "resposta do sistema, sem premissas registradas", confidence: 0, auditedAt: "2026-03-09", auditOutcome: "reopened" } };
    expect(openBudgetRequests(cardWith([undone]))).toEqual([{ toUSD: 50, questionId: "q3", ownerOnly: true }]);
    const w = sweepWorld([row(cardWith([undone]))]);
    expect((await sweepCardBudgets(w.deps)).approved).toEqual([]);
    expect(w.deps.approve).not.toHaveBeenCalled();
  });

  it("um aumento por card e por passe: de dois pedidos abertos só o primeiro é aprovado", async () => {
    const w = sweepWorld([row(cardWith([req("q3", 46), req("q4", 50)]))]);
    await sweepCardBudgets(w.deps);
    expect(w.deps.approve).toHaveBeenCalledTimes(1);
  });

  it("condutor VIVO que passou do teto sem pedir nada recebe a linha do teto — uma vez por sessão e por teto", async () => {
    const w = sweepWorld([row(cardWith([]), 41.2, true)]);
    expect((await sweepCardBudgets(w.deps)).warned).toEqual([{ board: "b", cardId: "story-x" }]);
    expect(w.deps.warn).toHaveBeenCalledWith("agent-conductor-story-x-ab12", capLine(41.2, 40));
    await sweepCardBudgets(w.deps);
    expect(w.deps.warn).toHaveBeenCalledTimes(1);
    expect(capLine(41.2, 40)).toMatch(/^teto — o gasto deste card chegou a US\$ 41,20 do teto de US\$ 40\. /);
    expect(capLine(41.2, 40)).toMatch(/request_budget/);
  });

  it("abaixo do teto, com pedido já aberto, ou dentro de um teto aumentado: ninguém é avisado", async () => {
    const below = sweepWorld([row(cardWith([]), 39.9, true)]);
    const asked = sweepWorld([row(cardWith([req("q3", 60)]), 45, true)]);
    const raised = sweepWorld([row(cardWith([req("q1", 50, "approved")]), 45, true)]);
    for (const w of [below, asked, raised]) {
      expect((await sweepCardBudgets(w.deps)).warned).toEqual([]);
    }
  });

  it("sem teto no settings, ou com o autorun desligado, o passe não faz nada; um erro não derruba quem chama", async () => {
    const noCap = sweepWorld([row(cardWith([req("q3", 50)]), 45, true)], { cap: null });
    const off = sweepWorld([row(cardWith([req("q3", 50)]), 45, true)], { master: false });
    for (const w of [noCap, off]) expect(await sweepCardBudgets(w.deps)).toEqual({ approved: [], warned: [] });
    const broken = sweepWorld([]);
    broken.deps.cards = async () => {
      throw new Error("disco fora");
    };
    expect(await sweepCardBudgets(broken.deps)).toEqual({ approved: [], warned: [] });
    expect(broken.lines.join("\n")).toMatch(/a varredura falhou — disco fora/);
  });
});
