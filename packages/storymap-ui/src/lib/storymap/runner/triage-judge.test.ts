// O dispatcher do JUIZ DA TRIAGEM (política só-negócio), contra fakes (sem modelo, sem disco): julga os cards em
// quarentena de um board só-negócio pelo PRD, aplica pelo escritor único (que re-planeja no card FRESCO), respeita
// os mesmos interruptores do autorun e tem teto de tentativas — esgotado, o card vai ao dono com o motivo.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import { triageJudgeWork, planTriageJudgement, type TriageJudgePlan } from "@/lib/storymap/triage/judge";
import { memoryProxyLedger } from "./proxy";
import { judgeTriageCard, sweepTriageJudge, TRIAGE_JUDGE_MAX_ATTEMPTS, TRIAGE_JUDGE_MAX_PER_SWEEP, type TriageJudgeDeps } from "./triage-judge";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { gateAdmitsCard, resolveBoardGate, type BoardPaceRow } from "./board-pace";

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

// R7 — O ESCOPO DE TIPOS (board-pace.ts): a Triagem é «captura/triagem», que CONTINUA andando para o tipo ser decidido. O
// juiz segue ACEITANDO funcionalidade nova no backlog (ela espera pronta, sem gastar: quem a barra é a construção).
describe("judgeTriageCard — com o escopo de tipos «só consertos», o juiz continua julgando e aceitando", () => {
  const AT = "2026-10-02T12:00:00.000Z";
  const NOW = Date.parse(AT) + 1000;
  const fixes: BoardPaceRow = { board: "b", ownerScope: { types: ["bug", "technical", "chore", "spike"], by: { kind: "owner" }, at: AT } } as unknown as BoardPaceRow;
  const feature = coerceCard("story-feat", { type: "story", storyType: "user", title: "Cartão fidelidade da oficina", status: "triage", parent: "step-agendar" }, "");

  it("funcionalidade nova na Triagem: o modelo É chamado e o card é aceito no backlog (não fica retido pelo escopo)", async () => {
    const judge = vi.fn(async (_prompt: string) => answer());
    // o passo da Entrevista é para onde a funcionalidade nova é roteada (acceptRoute: user → interview)
    const { deps, state } = world(cfg({ statuses: [...statuses, { id: "interview", name: "Entrevista" }] as BoardConfig["statuses"] }), judge);
    deps.boardGate = (_b, config) => resolveBoardGate(config, fixes, NOW);
    state.cards.push({ ...feature });
    const out = await judgeTriageCard(deps, "b", "story-feat");
    expect(out).toMatchObject({ action: "judged", verdict: "accept" });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(state.cards.find((c) => c.id === "story-feat")!.status).toBe("interview");
  });

  it("o card aceito está na Triagem (captura/triagem): a pergunta por card da COLUNA admite — a fronteira é a construção", () => {
    const gate = resolveBoardGate(cfg(), fixes, NOW);
    expect(gateAdmitsCard(gate, feature, "column")).toEqual({ admit: true, why: "" });
  });

  it("o PAUSADO continua valendo para o juiz (eixos independentes): espera, mesmo para o conserto", async () => {
    const judge = vi.fn(async () => answer());
    const { deps } = world(cfg(), judge);
    deps.boardGate = (_b, config) => resolveBoardGate(config, { ...fixes, owner: { level: "paused", by: { kind: "owner" }, at: AT } } as unknown as BoardPaceRow, NOW);
    const out = await judgeTriageCard(deps, "b", "story-t");
    expect(out).toMatchObject({ action: "waiting", reason: expect.stringMatching(/pausado/) });
    expect(judge).not.toHaveBeenCalled();
  });

  it("DEVAGAR + escopo: o juiz segue (só o fundo para) — fica a conferir que o juiz não olha o tipo para decidir se roda", async () => {
    const judge = vi.fn(async () => answer());
    const { deps, state } = world(cfg({ statuses: [...statuses, { id: "interview", name: "Entrevista" }] as BoardConfig["statuses"] }), judge);
    deps.boardGate = (_b, config) => resolveBoardGate(config, { ...fixes, owner: { level: "slow", by: { kind: "owner" }, at: AT } } as unknown as BoardPaceRow, NOW);
    state.cards.push({ ...feature });
    expect(await judgeTriageCard(deps, "b", "story-feat")).toMatchObject({ action: "judged" });
  });
});

// O ROTEAMENTO: o juiz manda o card ao board a que ele pertence pela MESMA mudança de board da tela; se a mudança
// recusa, o card fica com o dono, com o motivo — nunca aceito aqui «no lugar».
describe("judgeTriageCard — route", () => {
  const others = [{ id: "galpao", name: "Galpão", package: "apps/galpao" }];

  it("o prompt recebe os outros boards; ROUTE chama a mudança de board e não carimba nada aqui", async () => {
    const judge = vi.fn(async (_prompt: string) => answer({ verdict: "route", routeTo: "galpao", reason: "os arquivos são do galpão" }));
    const { deps, state, after } = world(cfg(), judge);
    const routed: string[] = [];
    deps.otherBoards = async () => others;
    deps.route = async (b, id, to, reason) => {
      routed.push(`${b}/${id}>${to}:${reason}`);
      return { ok: true };
    };
    const out = await judgeTriageCard(deps, "b", "story-t");
    expect(out).toMatchObject({ action: "judged", verdict: "route" });
    expect(judge.mock.calls[0][0]).toContain("### galpao — Galpão");
    expect(routed).toEqual(["b/story-t>galpao:os arquivos são do galpão"]);
    expect(state.cards[2].triageDecision).toBeUndefined();
    expect(after).toHaveBeenCalledWith("b", "story-t", expect.objectContaining({ action: "route", toBoard: "galpao" }));
  });

  it("a mudança de board recusa ⇒ o card fica com o dono, com o motivo", async () => {
    const judge = vi.fn(async (_prompt: string) => answer({ verdict: "route", routeTo: "galpao" }));
    const { deps, state } = world(cfg(), judge);
    deps.otherBoards = async () => others;
    deps.route = async () => ({ ok: false, error: "há uma sessão de trabalho aberta neste card" });
    const out = await judgeTriageCard(deps, "b", "story-t");
    expect(out).toMatchObject({ action: "judged", verdict: "hold" });
    expect(state.cards[2]).toMatchObject({ needsHumanReview: true, triageDecision: { verdict: "hold", reason: expect.stringMatching(/sessão de trabalho/) } });
  });

  it("sem a porta de roteamento (deps.route ausente) o juiz nem vê outros boards", async () => {
    const judge = vi.fn(async (_prompt: string) => answer());
    const { deps } = world(cfg(), judge);
    deps.otherBoards = vi.fn(async () => others);
    await judgeTriageCard(deps, "b", "story-t");
    expect(deps.otherBoards).not.toHaveBeenCalled();
    expect(judge.mock.calls[0][0]).not.toMatch(/"route"/);
  });
});
