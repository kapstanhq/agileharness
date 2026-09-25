// The AUTONOMY KEY — the pure answers. Every case is one row of the owner's table held in code:
//   human ⇒ nothing is proxied; ultra ⇒ only interview/ui-choice; money NEVER (category or floor); a story's own
//   mode beats the board's; the writer re-checks on the FRESH card; the audit sample is deterministic.

import { describe, expect, it } from "vitest";
import {
  applyProxyAnswers,
  auditDraw,
  effectiveAutonomy,
  isOwnerOnlyQuestion,
  isPendingProxyAudit,
  markProxyDeclined,
  ownerOnlyOpenQuestions,
  proxiableQuestions,
  proxyRefusal,
  proxySettings,
  resolveProxyAudit,
  shouldAuditProxyAnswer,
} from "./autonomy";
import type { BoardConfig, CardQuestion } from "./types";

const ultra = { autonomy: { mode: "ultra" as const } } satisfies Pick<BoardConfig, "autonomy">;
const human = { autonomy: { mode: "human" as const } } satisfies Pick<BoardConfig, "autonomy">;
const none = {} satisfies Pick<BoardConfig, "autonomy">;

const q = (id: string, extra: Partial<CardQuestion> = {}): CardQuestion => ({ id, text: `pergunta ${id}`, status: "open", ...extra });

describe("effectiveAutonomy — a exceção da story vence o board; ausente é human", () => {
  it("precedência card > board > default", () => {
    expect(effectiveAutonomy({}, none)).toEqual({ mode: "human", source: "default" });
    expect(effectiveAutonomy({}, ultra)).toEqual({ mode: "ultra", source: "board" });
    expect(effectiveAutonomy({ autonomyMode: "human" }, ultra)).toEqual({ mode: "human", source: "card" });
    expect(effectiveAutonomy({ autonomyMode: "ultra" }, human)).toEqual({ mode: "ultra", source: "card" });
    expect(effectiveAutonomy(null, null)).toEqual({ mode: "human", source: "default" });
  });

  it("proxySettings: sonnet e 0,2 por default; a taxa é presa em [0,1]", () => {
    expect(proxySettings(none)).toEqual({ model: "sonnet", auditSampleRate: 0.2 });
    expect(proxySettings({ autonomy: { mode: "ultra", proxyModel: "haiku", auditSampleRate: 3 } })).toEqual({ model: "haiku", auditSampleRate: 1 });
  });
});

describe("dinheiro NUNCA vai ao proxy — a categoria do autor, e um piso determinístico", () => {
  it("categoria money é do dono", () => {
    expect(isOwnerOnlyQuestion(q("a", { category: "money" }))).toBe(true);
  });

  it("o piso: marcador [humano] e palavras de preço/fornecedor/gasto, mesmo com categoria interview", () => {
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", context: "[humano] muda o PRD" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", text: "Qual o preço do plano?" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", text: "Trocamos de fornecedor de SMS?" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "ui-choice", context: "aumenta o gasto mensal" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", text: "Which vendor should we use?" }))).toBe(true);
  });

  it("uma pergunta de produto comum não é tocada pelo piso", () => {
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", text: "A leitora quer filtrar por gênero?" }))).toBe(false);
  });
});

describe("proxyRefusal / proxiableQuestions — quem o proxy pode responder", () => {
  const card = (questions: CardQuestion[], autonomyMode?: "human" | "ultra") => ({ questions, autonomyMode });

  it("ultra: só interview e ui-choice abertas; sem categoria, delivery e money ficam com o dono", () => {
    const qs = [
      q("q1", { category: "interview" }),
      q("q2", { category: "ui-choice" }),
      q("q3"),
      q("q4", { category: "delivery" }),
      q("q5", { category: "money" }),
      q("q6", { category: "interview", status: "answered", answer: "x" }),
    ];
    expect(proxiableQuestions(card(qs), ultra).map((x) => x.id)).toEqual(["q1", "q2"]);
    expect(proxyRefusal(qs[2], card(qs), ultra)).toMatch(/sem categoria/);
    expect(proxyRefusal(qs[3], card(qs), ultra)).toMatch(/delivery/);
    expect(proxyRefusal(qs[4], card(qs), ultra)).toMatch(/dinheiro/);
  });

  it("human (board ou exceção da story) ⇒ nada vai ao proxy", () => {
    const qs = [q("q1", { category: "interview" })];
    expect(proxiableQuestions(card(qs), human)).toEqual([]);
    expect(proxiableQuestions(card(qs), none)).toEqual([]);
    expect(proxiableQuestions(card(qs, "human"), ultra)).toEqual([]);
    expect(proxiableQuestions(card(qs, "ultra"), human).map((x) => x.id)).toEqual(["q1"]);
  });

  it("uma resposta do proxy que o dono REABRIU nunca volta ao proxy", () => {
    const reopened = q("q1", { category: "interview", proxy: { assumptions: "x", confidence: 0.9, audit: true, auditedAt: "d", auditOutcome: "reopened" } });
    expect(proxyRefusal(reopened, card([reopened]), ultra)).toMatch(/reabriu/);
  });

  it("a fila só-do-dono lista as de dinheiro abertas", () => {
    const qs = [q("q1", { category: "money" }), q("q2", { category: "interview" }), q("q3", { category: "money", status: "answered" })];
    expect(ownerOnlyOpenQuestions({ questions: qs }).map((x) => x.id)).toEqual(["q1"]);
  });
});

describe("auditoria — amostra determinística + toda resposta de baixa confiança", () => {
  it("auditDraw é estável e em [0,1)", () => {
    const a = auditDraw("b/c/q1");
    expect(a).toBe(auditDraw("b/c/q1"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it("confiança baixa ⇒ sempre; taxa 0 ⇒ nunca (acima do piso); taxa 1 ⇒ sempre", () => {
    expect(shouldAuditProxyAnswer("k", 0.3, 0)).toBe(true);
    expect(shouldAuditProxyAnswer("k", 0.9, 0)).toBe(false);
    expect(shouldAuditProxyAnswer("k", 0.9, 1)).toBe(true);
    expect(shouldAuditProxyAnswer("k", Number.NaN, 0)).toBe(true);
  });

  it("a taxa default amostra ~20% (a régua não é decorativa)", () => {
    let hits = 0;
    for (let i = 0; i < 2000; i++) if (shouldAuditProxyAnswer(`b/story-${i}/q1`, 0.9, 0.2)) hits++;
    expect(hits / 2000).toBeGreaterThan(0.15);
    expect(hits / 2000).toBeLessThan(0.25);
  });
});

describe("applyProxyAnswers — o escritor re-julga no card FRESCO", () => {
  const answers = [
    { questionId: "q1", answer: "Leitoras por indicação", assumptions: "PRD §público", confidence: 0.9 },
    { questionId: "q2", answer: "", selectedOptionIds: ["o2", "o9"], assumptions: "rubrica: aderência ao guia", confidence: 0.8 },
    { questionId: "q3", answer: "R$ 29", assumptions: "chute", confidence: 0.9 },
    { questionId: "q4", answer: "sim", assumptions: "x", confidence: 0.9 },
  ];
  const fresh = {
    questions: [
      q("q1", { category: "interview" }),
      q("q2", { category: "ui-choice", options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }] }),
      q("q3", { category: "money" }),
      q("q4", { category: "interview", status: "answered", answer: "o dono respondeu antes" }),
    ],
  };

  it("aplica só o que segue aberto e proxiável; carimba answeredBy proxy + premissas; opção inventada é descartada", () => {
    const r = applyProxyAnswers(fresh, ultra, "b", "c", answers, { today: "2026-09-25", runId: "run-1" });
    expect(r.applied).toEqual(["q1", "q2"]);
    const [q1, q2, q3, q4] = r.questions;
    expect(q1).toMatchObject({ status: "answered", answer: "Leitoras por indicação", answeredBy: "proxy", answeredAt: "2026-09-25" });
    expect(q1.proxy).toMatchObject({ assumptions: "PRD §público", confidence: 0.9, runId: "run-1" });
    expect(q2).toMatchObject({ status: "answered", selectedOptionIds: ["o2"], answeredBy: "proxy" });
    expect(q3.status).toBe("open"); // dinheiro: intocado
    expect(q4.answer).toBe("o dono respondeu antes"); // a resposta humana nunca é sobrescrita
  });

  it("a story virou human no meio do caminho ⇒ nada aterrissa (mesmo array)", () => {
    const r = applyProxyAnswers({ ...fresh, autonomyMode: "human" }, ultra, "b", "c", answers, { today: "d" });
    expect(r.applied).toEqual([]);
    expect(r.questions).toBe(fresh.questions);
  });

  it("a amostra marca `audit` (taxa 1) — e confiança baixa marca sempre", () => {
    const all = applyProxyAnswers(fresh, { autonomy: { mode: "ultra", auditSampleRate: 1 } }, "b", "c", answers, { today: "d" });
    expect(all.questions[0].proxy?.audit).toBe(true);
    const zero = applyProxyAnswers(fresh, { autonomy: { mode: "ultra", auditSampleRate: 0 } }, "b", "c", [{ ...answers[0], confidence: 0.2 }], { today: "d" });
    expect(zero.questions[0].proxy?.audit).toBe(true);
    const none0 = applyProxyAnswers(fresh, { autonomy: { mode: "ultra", auditSampleRate: 0 } }, "b", "c", [answers[0]], { today: "d" });
    expect(none0.questions[0].proxy?.audit).toBeUndefined();
  });
});

describe("resolveProxyAudit — o dono fecha o item de auditoria", () => {
  const audited: CardQuestion = {
    id: "q1",
    text: "Quem é o público?",
    status: "answered",
    answer: "Leitoras",
    answeredAt: "d0",
    answeredBy: "proxy",
    category: "interview",
    proxy: { assumptions: "PRD §público", confidence: 0.8, audit: true },
  };

  it("confirmar mantém a resposta e fecha a auditoria", () => {
    const [x] = resolveProxyAudit([audited], "q1", "confirmed", "d1");
    expect(x).toMatchObject({ status: "answered", answer: "Leitoras", proxy: { auditedAt: "d1", auditOutcome: "confirmed" } });
    expect(isPendingProxyAudit(x)).toBe(false);
  });

  it("reabrir devolve a pergunta ao dono com o que o proxy assumiu no contexto", () => {
    const [x] = resolveProxyAudit([audited], "q1", "reopened", "d1");
    expect(x.status).toBe("open");
    expect(x.answer).toBeUndefined();
    expect(x.answeredBy).toBeUndefined();
    expect(x.context).toMatch(/Leitoras/);
    expect(x.context).toMatch(/PRD §público/);
    expect(x.proxy?.auditOutcome).toBe("reopened");
  });

  it("uma pergunta sem auditoria pendente não muda (mesmo array)", () => {
    const list = [{ ...audited, proxy: { ...audited.proxy!, audit: undefined } }];
    expect(resolveProxyAudit(list, "q1", "confirmed", "d1")).toBe(list);
  });
});

describe("markProxyDeclined — o proxy DEVOLVE a pergunta ao dono, gravado na própria pergunta", () => {
  it("só a pergunta ABERTA muda: vira do dono (declined, confiança 0, o motivo no registro)", () => {
    const list = [
      q("q1", { category: "interview" }),
      q("q2", { category: "interview", status: "answered", answer: "do dono" }),
    ];
    const next = markProxyDeclined(list, [
      { questionId: "q1", reason: "o proxy recusou: depende de preço" },
      { questionId: "q2", reason: "x" },
    ], { runId: "r1" });
    expect(next[0]).toMatchObject({ status: "open", proxy: { declined: true, confidence: 0, runId: "r1", assumptions: "o proxy recusou: depende de preço" } });
    expect(next[1]).toBe(list[1]); // respondida: intocada
    expect(proxyRefusal(next[0], {}, ultra)).toMatch(/devolveu/);
  });

  it("nada a devolver (ou já devolvida) ⇒ o MESMO array (o escritor pula a gravação)", () => {
    const already = [q("q1", { category: "interview", proxy: { assumptions: "antes", confidence: 0, declined: true } })];
    expect(markProxyDeclined(already, [{ questionId: "q1", reason: "de novo" }])).toBe(already);
    const list = [q("q1", { category: "interview" })];
    expect(markProxyDeclined(list, [{ questionId: "q9", reason: "?" }])).toBe(list);
  });
});
