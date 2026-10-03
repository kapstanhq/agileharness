import { describe, expect, it } from "vitest";
import { isOwnerDecisionQuestion, isProxiableQuestion } from "@/lib/storymap/autonomy";
import { whoDecides } from "@/lib/storymap/decision-class";
import { applyUndoToCard, undoRefusal } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card, CardQuestion } from "@/lib/storymap/types";
import { nextQuestionId } from "@/lib/storymap/questions";
import {
  EXTRA_CYCLE,
  extraCycleNumber,
  extraCycleRecord,
  judgeExtraCycle,
  requestExtraCycle,
  type ExtraCycleDeps,
  type ExtraCycleInput,
} from "./extra-cycle";
import type { SystemDecision } from "@/lib/storymap/system-decisions";

// A regra do operador em código: UM ciclo extra de verificação, decidido pela regra (não pelo condutor, não pelo
// dono); acima do teto, encadeia o pedido de teto; o 2º pedido é do dono, em palavras simples.

const ultra = { autonomy: { mode: "ultra" as const }, statuses: [{ id: "desenvolver", name: "Desenvolver" }] } as unknown as BoardConfig;
const card = (questions: CardQuestion[] = []): Card => ({ id: "story-ex9310", type: "story", title: "Etiqueta de envio em lote", status: "desenvolver", questions }) as Card;

describe("judgeExtraCycle — a régua", () => {
  const base = { card: card(), estimateUSD: 10, capUSD: 55, spentUSD: 31 };

  it("1º pedido depois do 2º ciclo reprovado, dentro do teto ⇒ aprovado pela regra", () => {
    expect(judgeExtraCycle({ ...base, loopsUsed: 2 })).toMatchObject({ kind: "approved" });
    expect(judgeExtraCycle({ ...base, loopsUsed: 2, capUSD: null })).toMatchObject({ kind: "approved", why: expect.stringMatching(/não declara teto/) });
  });

  it("antes do 2º ciclo ⇒ cedo demais (o condutor ainda tem ciclo dele)", () => {
    expect(judgeExtraCycle({ ...base, loopsUsed: 1 }).kind).toBe("too-early");
  });

  it("a estimativa passa do teto em vigor ⇒ encadeia o pedido de teto até o total projetado", () => {
    expect(judgeExtraCycle({ ...base, loopsUsed: 2, spentUSD: 50 })).toMatchObject({ kind: "budget", toUSD: 60 });
    // um aumento já aprovado no card conta como teto em vigor
    const raised = card([{ id: "q1", text: "x", status: "answered", askedBy: "teto:70", selectedOptionIds: ["o1"], answeredBy: "system" }]);
    expect(judgeExtraCycle({ ...base, card: raised, loopsUsed: 2, spentUSD: 50 }).kind).toBe("approved");
  });

  it("2º pedido (já houve um ciclo extra) ou depois do 3º ciclo ⇒ do dono", () => {
    const granted = card([extraCycleRecord({ id: "q2", failing: ["c2"], reason: "r", estimateUSD: 10, why: "w", today: "2026-04-14" })]);
    expect(judgeExtraCycle({ ...base, card: granted, loopsUsed: 3 })).toMatchObject({ kind: "owner", cycle: 4 });
    expect(judgeExtraCycle({ ...base, loopsUsed: 3 })).toMatchObject({ kind: "owner", cycle: 4 });
  });

  it("um pedido aberto (o do dono, ou o 1º que ele desfez) ⇒ espere a resposta", () => {
    const open = card([{ id: "q5", text: "x", status: "open", askedBy: "ciclo-extra:4", category: "owner" }]);
    expect(judgeExtraCycle({ ...base, card: open, loopsUsed: 3 })).toMatchObject({ kind: "pending", questionId: "q5" });
  });
});

/** As portas falsas: o card em memória, o teto, o pedido de teto e o registro. */
function harness(over: { card?: Card; capUSD?: number | null; spentUSD?: number; budgetApproves?: boolean } = {}) {
  const state = { card: over.card ?? card(), decisions: [] as SystemDecision[], budgetCalls: [] as Array<{ toUSD: number; reason: string }> };
  const deps: ExtraCycleDeps = {
    readCard: async () => state.card,
    spend: async () => ({ capUSD: over.capUSD === undefined ? 55 : over.capUSD, spentUSD: over.spentUSD ?? 31 }),
    requestBudget: async (i) => {
      state.budgetCalls.push({ toUSD: i.toUSD, reason: i.reason });
      return over.budgetApproves
        ? { ok: true, verdict: "approved", approved: true, questionId: "q9" }
        : { ok: true, verdict: "owner", approved: false, questionId: "q9", detail: "acima do envelope" };
    },
    update: async (_b, _c, fn) => {
      const next = fn(state.card);
      if (!next) return false;
      state.card = next;
      return true;
    },
    nextQuestionId: (qs) => nextQuestionId([...qs]),
    record: async (d) => void state.decisions.push(d),
    today: () => "2026-04-15",
    now: () => Date.parse("2026-04-15T00:20:00Z"),
  };
  return { state, deps };
}

const req = (over: Partial<ExtraCycleInput> = {}): ExtraCycleInput => ({
  board: "armazem",
  cardId: "story-ex9310",
  loopsUsed: 2,
  failing: ["validação de CEP nas etiquetas geradas em lote"],
  reason: "fechar o achado alto do revisor: etiqueta emitida com CEP malformado",
  estimateUSD: 10,
  ...over,
});

describe("requestExtraCycle — o pedido inteiro", () => {
  it("1º pedido com loops=2 dentro do teto ⇒ a regra aprova, grava a pergunta respondida pelo sistema e o registro com Desfazer", async () => {
    const h = harness();
    const r = await requestExtraCycle(req(), h.deps);
    expect(r).toMatchObject({ ok: true, verdict: "approved", approved: true });
    const q = h.state.card.questions!.find((x) => x.id === (r.ok ? r.questionId : ""))!;
    expect(q).toMatchObject({ status: "answered", answeredBy: "system", category: "technical", costUsd: 10, askedBy: `ciclo-extra:${EXTRA_CYCLE}`, selectedOptionIds: ["o1"] });
    expect(extraCycleNumber(q)).toBe(EXTRA_CYCLE);
    expect(h.state.decisions).toHaveLength(1);
    expect(h.state.decisions[0]).toMatchObject({ kind: "extra-cycle", agent: "system", undo: { kind: "reopen-question", questionId: q.id } });
    expect(h.state.budgetCalls).toEqual([]);
  });

  it("Desfazer a aprovação reabre a pergunta: dali em diante o ciclo é decisão do dono (nunca do proxy)", async () => {
    const h = harness();
    const r = await requestExtraCycle(req(), h.deps);
    const d = h.state.decisions[0];
    expect(undoRefusal(d, { config: ultra, card: h.state.card })).toBeNull();
    const undone = applyUndoToCard(d.undo as { kind: "reopen-question"; cardId: string; questionId: string }, h.state.card, ultra, { today: "2026-04-15" });
    const q = undone.questions!.find((x) => x.id === (r.ok ? r.questionId : ""))!;
    expect(q.status).toBe("open");
    expect(isProxiableQuestion(q, undone, ultra)).toBe(false);
    expect(whoDecides({ kind: "question", question: q }, undone, ultra).decider).toBe("owner");
    // e um novo pedido do condutor espera a resposta dele, em vez de aprovar de novo
    h.state.card = undone;
    expect(await requestExtraCycle(req(), h.deps)).toMatchObject({ ok: true, verdict: "pending", questionId: q.id });
  });

  it("2º pedido ⇒ pergunta do DONO em palavras simples (category owner, custo como dado), sem registro de sistema", async () => {
    const h = harness();
    await requestExtraCycle(req(), h.deps);
    const r = await requestExtraCycle(req({ loopsUsed: 3, estimateUSD: 12 }), h.deps);
    expect(r).toMatchObject({ ok: true, verdict: "owner", approved: false });
    const q = h.state.card.questions!.find((x) => x.id === (r.ok ? r.questionId : ""))!;
    expect(q).toMatchObject({ status: "open", category: "owner", costUsd: 12, askedBy: "ciclo-extra:4" });
    expect(q.text).toMatch(/ainda falha: «validação de CEP/);
    expect(q.text).not.toMatch(/sha|commit|worktree|tmux|CLS/i);
    expect(q.options?.map((o) => o.label)).toEqual([
      "Aceitar como está e publicar; o que falta vira outro card",
      "Autorizar mais uma rodada de correção",
      "Parar o card aqui",
    ]);
    expect(isOwnerDecisionQuestion(q)).toBe(true);
    expect(h.state.decisions).toHaveLength(1); // só o da 1ª aprovação
    // idempotente: com a pergunta do dono aberta, um 3º pedido devolve a mesma
    expect(await requestExtraCycle(req({ loopsUsed: 3 }), h.deps)).toMatchObject({ verdict: "pending", questionId: q.id });
  });

  it("acima do teto ⇒ encadeia o pedido de teto; teto negado/esperando ⇒ nada aprovado, o condutor estaciona", async () => {
    const h = harness({ spentUSD: 50 });
    const r = await requestExtraCycle(req(), h.deps);
    expect(r).toMatchObject({ ok: true, verdict: "budget", approved: false, budget: { verdict: "owner", questionId: "q9" } });
    expect(h.state.budgetCalls).toEqual([{ toUSD: 60, reason: expect.stringMatching(/^ciclo extra de verificação — /) }]);
    expect(h.state.card.questions ?? []).toEqual([]); // nenhum ciclo concedido: o 1º pedido segue disponível
  });

  it("acima do teto e a régua do teto aprova ⇒ o ciclo sai junto, aprovado pela regra", async () => {
    const h = harness({ spentUSD: 50, budgetApproves: true });
    const r = await requestExtraCycle(req(), h.deps);
    expect(r).toMatchObject({ ok: true, verdict: "approved", approved: true, budget: { verdict: "approved" } });
    expect(h.state.decisions[0]).toMatchObject({ kind: "extra-cycle", why: expect.stringMatching(/teto subiu/) });
  });

  it("entrada torta é recusada com o porquê; cedo demais também", async () => {
    const h = harness();
    expect(await requestExtraCycle(req({ failing: [" "] }), h.deps)).toMatchObject({ ok: false, error: expect.stringMatching(/failing/) });
    expect(await requestExtraCycle(req({ reason: "" }), h.deps)).toMatchObject({ ok: false, error: expect.stringMatching(/reason/) });
    expect(await requestExtraCycle(req({ estimateUSD: Number.NaN }), h.deps)).toMatchObject({ ok: false });
    expect(await requestExtraCycle(req({ loopsUsed: 1 }), h.deps)).toMatchObject({ ok: false, error: expect.stringMatching(/depois do 2º ciclo/) });
  });
});

// Repetir a chamada depois de um erro de transporte do MCP é o comportamento normal do agente.
// A repetição da 1ª chamada (loopsUsed 2) depois da aprovação virava uma pergunta do DONO para o «4º ciclo» («Depois de
// 3 rodadas…», com 2 feitas): o condutor estacionava e o ciclo aprovado se perdia. E duas chamadas concorrentes davam
// `ok:false` na 2ª. A mesma entrada ⇒ o mesmo desfecho, sem pergunta nova.
describe("requestExtraCycle — a repetição da mesma chamada devolve o que já foi decidido", () => {
  it("repetir a MESMA chamada depois da aprovação da regra ⇒ approved com o MESMO questionId, sem pergunta nem registro novo", async () => {
    const h = harness();
    const first = await requestExtraCycle(req(), h.deps);
    const again = await requestExtraCycle(req(), h.deps);
    expect(first).toMatchObject({ ok: true, verdict: "approved", approved: true });
    expect(again).toMatchObject({ ok: true, verdict: "approved", approved: true, questionId: first.ok ? first.questionId : "?" });
    expect(h.state.card.questions).toHaveLength(1);
    expect(h.state.decisions).toHaveLength(1);
  });

  it("duas chamadas concorrentes (a 2ª leu o card antes da 1ª gravar) ⇒ a 2ª devolve a aprovação existente, não ok:false", async () => {
    const h = harness();
    const first = await requestExtraCycle(req(), h.deps);
    // a 2ª chamada leu o card ANTES da escrita da 1ª; a trava entrega o card fresco
    const stale = { ...h.deps, readCard: async () => card() };
    const second = await requestExtraCycle(req(), stale);
    expect(second).toMatchObject({ ok: true, verdict: "approved", approved: true, questionId: first.ok ? first.questionId : "?" });
    expect(h.state.card.questions).toHaveLength(1);
    expect(h.state.decisions).toHaveLength(1);
  });

  it("o dono desfez a aprovação e respondeu: a repetição devolve a resposta DELE (parar ⇒ não aprovado; fazer ⇒ aprovado)", async () => {
    for (const [option, approved] of [["o3", false], ["o1", true]] as const) {
      const h = harness();
      const r = await requestExtraCycle(req(), h.deps);
      const qid = r.ok ? r.questionId! : "?";
      const d = h.state.decisions[0];
      const reopened = applyUndoToCard(d.undo as { kind: "reopen-question"; cardId: string; questionId: string }, h.state.card, ultra, { today: "2026-04-15" });
      h.state.card = {
        ...reopened,
        questions: reopened.questions!.map((q) => (q.id === qid ? { ...q, status: "answered" as const, answer: "decidi", answeredAt: "2026-04-15", selectedOptionIds: [option] } : q)),
      };
      const again = await requestExtraCycle(req(), h.deps);
      expect(again, option).toMatchObject({ ok: true, verdict: "owner", approved, questionId: qid });
      expect(h.state.card.questions, option).toHaveLength(1);
    }
  });

  it("a pergunta do dono conta as rodadas pelo loopsUsed do condutor, não pelo número do ciclo", async () => {
    const odd = card([{ id: "q1", text: "x", status: "answered", askedBy: "ciclo-extra:5", category: "owner", selectedOptionIds: ["o2"] }]);
    const h = harness({ card: odd });
    const r = await requestExtraCycle(req({ loopsUsed: 3 }), h.deps);
    expect(r).toMatchObject({ ok: true, verdict: "owner" });
    const q = h.state.card.questions!.find((x) => x.id === (r.ok ? r.questionId : ""))!;
    expect(q.text).toMatch(/^Depois de 3 rodadas de verificação/);
  });
});
