// O dispatcher do JUIZ DA TRIAGEM (política só-negócio), contra fakes (sem modelo, sem disco): julga os cards em
// quarentena de um board só-negócio pelo PRD, aplica pelo escritor único (que re-planeja no card FRESCO), respeita
// os mesmos interruptores do autorun e tem teto de tentativas — esgotado, o card vai ao dono com o motivo.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import { triageJudgeWork, planTriageJudgement, type TriageJudgePlan } from "@/lib/storymap/triage/judge";
import { memoryProxyLedger } from "./proxy";
import { judgeTriageCard, sweepTriageJudge, TRIAGE_JUDGE_MAX_ATTEMPTS, TRIAGE_JUDGE_MAX_PER_SWEEP, type TriageJudgeDeps } from "./triage-judge";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const statuses = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "enriquecer", name: "Especificar" },
  { id: "duplicado", name: "Duplicado", gate: "hasDuplicateOf", terminal: true },
  { id: "cancelado", name: "Cancelado", terminal: true },
];
const cfg = (over: Partial<BoardConfig> = {}): BoardConfig =>
  ({ id: "b", name: "Oficina", statuses, releases: [], personas: [], systems: [], linkTypes: [], autonomy: { mode: "ultra" }, ...over }) as unknown as BoardConfig;
const step = coerceCard("step-agendar", { type: "step", title: "Agendar", parent: "activity-a" }, "");
const user = coerceCard("story-user", { type: "story", storyType: "user", title: "Marcar revisão do carro", status: "enriquecer", parent: "step-agendar" }, "");
const tech = coerceCard("story-t", { type: "story", storyType: "technical", title: "Reindexar a tabela de peças", status: "triage", links: [{ rel: "relates-to", to: "story-user" }] }, "");

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verdict: "accept", reason: "serve a aposta de agendamento", prdAnchor: "Aposta 2", ownerClasses: [], confidence: 0.9, ...over });

function world(config: BoardConfig, judge: TriageJudgeDeps["judge"]) {
  const state = { cards: [step, user, tech].map((c) => ({ ...c })) as Card[] };
  const after = vi.fn(async (_b: string, _id: string, _plan: TriageJudgePlan) => {});
  const deps: TriageJudgeDeps = {
    ledger: memoryProxyLedger(),
    listBoards: async () => ["b"],
    readBoardConfig: async () => config,
    readCards: async () => state.cards,
    readPrd: async () => "## Apostas\n1. estoque de peças\n2. agendamento online",
    masterEnabled: () => true,
    admission: () => null,
    judge,
    // o escritor real re-planeja sob o lock sobre o card FRESCO — aqui, o mesmo planner puro sobre a memória
    apply: async (_b, cardId, judgement) => {
      const i = state.cards.findIndex((c) => c.id === cardId);
      const fresh = state.cards[i];
      if (fresh.status !== "triage" || fresh.triageDecision) return null;
      const plan = planTriageJudgement(fresh, judgement, config, state.cards, { today: "2026-04-14", by: "triage-judge" });
      state.cards[i] = plan.card;
      return plan;
    },
    hold: async (_b, cardId, reason) => {
      const i = state.cards.findIndex((c) => c.id === cardId);
      state.cards[i] = { ...state.cards[i], needsHumanReview: true, triageDecision: { verdict: "hold", reason, by: "triage-judge", at: "2026-04-14" } };
    },
    after,
    inFlight: new Set(),
    log: () => {},
  };
  return { deps, state, after };
}

describe("judgeTriageCard", () => {
  it("aceita pelo PRD: o prompt leva o PRD, o card vai para a raia, e os efeitos de depois recebem o plano", async () => {
    const judge = vi.fn(async (_prompt: string) => answer());
    const { deps, state, after } = world(cfg(), judge);
    const out = await judgeTriageCard(deps, "b", "story-t");
    expect(out).toMatchObject({ action: "judged", verdict: "accept" });
    expect(judge.mock.calls[0][0]).toContain("agendamento");
    expect(state.cards[2]).toMatchObject({ status: "enriquecer", serves: "story-user", triageDecision: { verdict: "accept" } });
    expect(after).toHaveBeenCalledWith("b", "story-t", expect.objectContaining({ action: "accept", to: "enriquecer" }));
  });

  it("nasce de um card ADIADO ⇒ o juiz não aceita: o filho fica adiado e o modelo nem é chamado", async () => {
    const judge = vi.fn(async (_prompt: string) => answer());
    const { deps, state } = world(cfg(), judge);
    state.cards[1] = { ...state.cards[1], deferred: { reason: "módulo de relatórios fica fora do ciclo", since: "2026-03-11", by: "human" } } as Card;
    state.cards[2] = { ...state.cards[2], serves: "story-user" } as Card;
    const marked: string[] = [];
    deps.deferChild = async (_b, id, anchor) => void marked.push(`${id}<-${anchor.id}`);
    const out = await judgeTriageCard(deps, "b", "story-t");
    expect(out).toMatchObject({ action: "skipped", reason: expect.stringMatching(/adiado/) });
    expect(judge).not.toHaveBeenCalled();
    expect(marked).toEqual(["story-t<-story-user"]);
    expect(state.cards[2]!.status).toBe("triage"); // não foi aceito
  });

  it("um card ADIADO nunca é trabalho do juiz", () => {
    const { state } = world(cfg(), vi.fn());
    const work = (cards: Card[]) => triageJudgeWork(cards, cfg()).map((c) => c.id);
    expect(work(state.cards)).toContain("story-t");
    expect(work(state.cards.map((c) => (c.id === "story-t" ? ({ ...c, deferred: { reason: "x", since: "2026-03-11", by: "human" } } as Card) : c)))).not.toContain("story-t");
  });

  it("toca uma classe do dono ⇒ fica na Triagem com a classe nomeada", async () => {
    const { deps, state } = world(cfg(), async () => answer({ ownerClasses: ["money"], ownerReason: "API paga" }));
    await judgeTriageCard(deps, "b", "story-t");
    expect(state.cards[2]).toMatchObject({ status: "triage", businessClasses: { ids: ["money"] }, needsHumanReview: true });
  });

  it("modelo falhando: tentativas contadas; esgotado o teto, o card vai ao dono com o motivo (nunca some)", async () => {
    const judge = vi.fn(async () => "isto não é JSON");
    const { deps, state } = world(cfg(), judge);
    for (let i = 0; i < TRIAGE_JUDGE_MAX_ATTEMPTS + 1; i++) await judgeTriageCard(deps, "b", "story-t");
    expect(judge).toHaveBeenCalledTimes(TRIAGE_JUDGE_MAX_ATTEMPTS);
    expect(state.cards[2]).toMatchObject({ status: "triage", needsHumanReview: true, triageDecision: { verdict: "hold" } });
    expect(state.cards[2].triageDecision?.reason).toMatch(/juiz/);
  });

  it("board human: o juiz nunca é chamado; autorun desligado: espera", async () => {
    const judge = vi.fn(async () => answer());
    const h = world(cfg({ autonomy: { mode: "human" } }), judge);
    await sweepTriageJudge(h.deps);
    expect(judge).not.toHaveBeenCalled();
    const off = world(cfg({ autorunDisabled: true }), judge);
    expect(await judgeTriageCard(off.deps, "b", "story-t")).toMatchObject({ action: "waiting" });
    expect(judge).not.toHaveBeenCalled();
  });

  it("o card saiu da Triagem enquanto o juiz pensava: nada é escrito, nenhum efeito", async () => {
    const { deps, state, after } = world(cfg(), async () => {
      state.cards[2] = { ...state.cards[2], status: "enriquecer" };
      return answer();
    });
    expect(await judgeTriageCard(deps, "b", "story-t")).toMatchObject({ action: "skipped" });
    expect(after).not.toHaveBeenCalled();
  });

  it("a varredura julga no máximo TRIAGE_JUDGE_MAX_PER_SWEEP cards (um backlog inteiro não vira uma rajada de gasto)", async () => {
    const judge = vi.fn(async () => answer());
    const { deps, state } = world(cfg(), judge);
    for (let i = 0; i < TRIAGE_JUDGE_MAX_PER_SWEEP + 2; i++) {
      state.cards.push({ ...tech, id: `story-t${i}` });
    }
    await sweepTriageJudge(deps);
    expect(judge).toHaveBeenCalledTimes(TRIAGE_JUDGE_MAX_PER_SWEEP);
  });

  it("a varredura julga cada card pendente uma vez", async () => {
    const judge = vi.fn(async () => answer());
    const { deps } = world(cfg(), judge);
    const rep = await sweepTriageJudge(deps);
    expect(rep.judged).toEqual([{ board: "b", cardId: "story-t", verdict: "accept" }]);
    await sweepTriageJudge(deps);
    expect(judge).toHaveBeenCalledTimes(1);
  });
});
