// O dispatcher do proxy em só-negócio (política só-negócio): antes de escolher o que o proxy responde, a pergunta SEM
// categoria passa pelo classificador (uma chamada barata de modelo, com limite de tentativas); a técnica vai ao
// proxy no mesmo passe, a do dono fica com o dono. Um board human nunca chama o classificador.

import { describe, expect, it, vi } from "vitest";
import { applyProxyAnswers, markProxyDeclined } from "@/lib/storymap/autonomy";
import { applyQuestionClassification, type QuestionClassificationResult } from "@/lib/storymap/question-classifier";
import { CLASSIFY_MAX_ATTEMPTS, memoryProxyLedger, proxyCard, sweepProxy, type ProxyDispatchDeps } from "./proxy";
import { blindQuestion, buildProxyPrompt, type ProxyRequest, type ProxyResult } from "./proxy-spawn";
import type { BoardConfig, Card, CardQuestion } from "@/lib/storymap/types";

const config = (over: Partial<BoardConfig> = {}): BoardConfig =>
  ({ id: "b", name: "B", statuses: [{ id: "desenvolver", name: "Desenvolver" }], releases: [], personas: [], systems: [], linkTypes: [], autonomy: { mode: "ultra" }, ...over }) as BoardConfig;
const card = (id: string, questions: CardQuestion[]): Card =>
  ({ id, type: "story", title: id, storyType: "technical", status: "desenvolver", questions }) as unknown as Card;
const q = (id: string, extra: Partial<CardQuestion> = {}): CardQuestion => ({ id, text: `pergunta ${id}`, status: "open", ...extra });

function world(cards: Card[], cfg: BoardConfig, classify: ProxyDispatchDeps["classify"]) {
  const state = { cards: cards.map((c) => ({ ...c })) };
  const spawned: ProxyRequest[] = [];
  const ledger = memoryProxyLedger();
  const deps: ProxyDispatchDeps = {
    ledger,
    listBoards: async () => ["b"],
    readBoardConfig: async () => cfg,
    readCards: async () => state.cards,
    masterEnabled: () => true,
    admission: () => null,
    buildRequest: async (board, c, _cfg, questions) =>
      ({ board, cardId: c.id, cardTitle: c.title, personas: [], history: [], questions: questions.map((x) => blindQuestion(x)!), model: "sonnet" }) as ProxyRequest,
    spawn: async (req): Promise<ProxyResult> => {
      spawned.push(req);
      return { runId: `run-${spawned.length}`, answers: req.questions.map((x) => ({ questionId: x.id, answer: "cursor", assumptions: "PRD: meta de tempo de resposta", confidence: 0.8 })) };
    },
    apply: async (board, cardId, answers, runId) => {
      const i = state.cards.findIndex((c) => c.id === cardId);
      const r = applyProxyAnswers(state.cards[i], cfg, board, cardId, answers, { today: "2026-09-28", runId });
      state.cards[i] = { ...state.cards[i], questions: r.questions };
      return r.applied;
    },
    decline: async (_b, cardId, items, runId) => {
      const i = state.cards.findIndex((c) => c.id === cardId);
      state.cards[i] = { ...state.cards[i], questions: markProxyDeclined(state.cards[i].questions ?? [], items, { runId }) };
    },
    classify,
    applyClassification: async (_b, cardId, results: QuestionClassificationResult[]) => {
      const i = state.cards.findIndex((c) => c.id === cardId);
      const before = state.cards[i].questions ?? [];
      const next = applyQuestionClassification(before, results, { by: "classifier", at: "2026-09-28" });
      state.cards[i] = { ...state.cards[i], questions: next };
      return next.filter((x, k) => x !== before[k]).map((x) => x.id);
    },
    inFlight: new Set(),
    log: () => {},
  };
  return { deps, state, spawned, ledger };
}

describe("proxyCard — classificar e responder no mesmo passe", () => {
  it("a sem categoria é classificada; a técnica vai ao proxy; a do dono fica com o dono, com o porquê", async () => {
    const classify = vi.fn(async () => ({
      results: [
        { questionId: "q1", decider: "system" as const, reason: "escolha de implementação" },
        { questionId: "q2", decider: "owner" as const, ownerClass: "prd", reason: "corta escopo do PRD" },
      ],
    }));
    const { deps, state, spawned } = world([card("c", [q("q1"), q("q2"), q("q3", { category: "technical" })])], config(), classify);
    const out = await proxyCard(deps, "b", "c");
    expect(classify).toHaveBeenCalledTimes(1);
    expect((classify.mock.calls[0] as unknown[])[3]).toEqual([expect.objectContaining({ id: "q1" }), expect.objectContaining({ id: "q2" })]);
    expect(out).toMatchObject({ action: "spawned", applied: ["q1", "q3"] });
    expect(spawned[0].questions.map((x) => [x.id, x.category])).toEqual([["q1", "technical"], ["q3", "technical"]]);
    const [q1, q2] = state.cards[0].questions!;
    expect(q1).toMatchObject({ status: "answered", answeredBy: "proxy", classified: { category: "technical" } });
    expect(q2).toMatchObject({ status: "open", classified: { category: "owner", ownerClass: "prd", reason: "corta escopo do PRD" } });
  });

  it("classificador que falha: nada é respondido (fica com o dono) e as tentativas têm teto", async () => {
    const classify = vi.fn(async () => ({ error: "modelo indisponível" }));
    const { deps, spawned, ledger } = world([card("c", [q("q1")])], config(), classify);
    for (let i = 0; i < CLASSIFY_MAX_ATTEMPTS + 2; i++) await proxyCard(deps, "b", "c");
    expect(classify).toHaveBeenCalledTimes(CLASSIFY_MAX_ATTEMPTS);
    expect(spawned).toHaveLength(0);
    expect(ledger.entries.find((e) => e.key === "b/c/q1#classify")).toMatchObject({ attempts: CLASSIFY_MAX_ATTEMPTS, outcome: "failed" });
  });

  it("board human: o classificador nunca é chamado", async () => {
    const classify = vi.fn(async () => ({ results: [] }));
    const { deps } = world([card("c", [q("q1")])], config({ autonomy: { mode: "human" } }), classify);
    await proxyCard(deps, "b", "c");
    await sweepProxy(deps);
    expect(classify).not.toHaveBeenCalled();
  });

  it("o autorun desligado também segura o classificador (nada é descartado — espera)", async () => {
    const classify = vi.fn(async () => ({ results: [] }));
    const { deps } = world([card("c", [q("q1")])], config({ autorunDisabled: true }), classify);
    expect(await proxyCard(deps, "b", "c")).toMatchObject({ action: "waiting" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("a varredura acha o card que só tem pergunta a classificar", async () => {
    const classify = vi.fn(async () => ({ results: [{ questionId: "q1", decider: "system" as const, reason: "técnica" }] }));
    const { deps } = world([card("c", [q("q1")])], config(), classify);
    const rep = await sweepProxy(deps);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(rep.spawned).toEqual([{ board: "b", cardId: "c", applied: ["q1"] }]);
  });
});

describe("o que o proxy vê e o que ele é instruído a fazer", () => {
  it("blindQuestion leva a técnica, a de entrega e a classificada técnica; nunca a do dono", () => {
    expect(blindQuestion(q("q1", { category: "technical" }))?.category).toBe("technical");
    expect(blindQuestion(q("q2", { category: "delivery" }))?.category).toBe("delivery");
    expect(blindQuestion(q("q3", { classified: { category: "technical", reason: "x", by: "classifier", at: "x" } }))?.category).toBe("technical");
    expect(blindQuestion(q("q4", { category: "owner", ownerClass: "money" }))).toBeNull();
    expect(blindQuestion(q("q5"))).toBeNull();
  });

  it("o prompt do proxy cobre as perguntas técnicas e manda decidir pela meta principal do PRD", () => {
    const p = buildProxyPrompt(".harness-proxy-answers.json");
    expect(p).toMatch(/T[ÉE]CNICA/);
    expect(p).toMatch(/meta principal do PRD/);
    expect(p).toMatch(/dados de pessoas/);
  });
});
