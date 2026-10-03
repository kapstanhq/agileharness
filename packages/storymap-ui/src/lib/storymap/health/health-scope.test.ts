// O recorte de um board sobre os inputs do relatório: cada sinal passa a medir SÓ a fatia do board, e o que não se divide
// por board (terminais órfãos, atribuição) é dito, não escondido.

import { describe, expect, it } from "vitest";
import { computeHealth, type HealthInboxEntry, type HealthInputs } from "./ah-health";
import { BOARD_SCOPE_CAVEAT, scopeHealthInputs } from "./health-scope";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-01T21:12:17Z");

const base = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  now: NOW,
  inbox: [],
  demandLanes: [],
  cards: [],
  transitions: [],
  deliveredStatuses: { alfa: ["concluida"], beta: ["concluida"] },
  publishWaiting: [],
  publishHeld: [],
  fleetKnown: true,
  fleet: [],
  orphanTerminals: [],
  claims: [],
  conductorQueue: [],
  stall: [],
  toolFailures: [],
  attribution: { actions: 100, attributed: 100 },
  touches: { liveStories: 4, technicalTouches: 0, ownerSessionActions: 0 },
  openTechnicalQuestions: [],
  ...over,
});

const noBusiness = (board: string, cardId: string): HealthInboxEntry => ({
  board,
  cardId,
  kind: "deploy-failed",
  bucket: "decidir",
  decider: "owner",
  ownerClass: null,
  floorOnly: false,
  executable: 0,
  followUpAllowed: false,
});

const level = (inputs: HealthInputs, id: string) => computeHealth(inputs).signals.find((s) => s.id === id)!;

/** Dois boards: o `alfa` tem 3 itens de Decidir sem negócio e fila de publicação parada; o `beta` está limpo e calmo. */
function twoBoards(): HealthInputs {
  return base({
    inbox: [noBusiness("alfa", "story-a1"), noBusiness("alfa", "story-a2"), noBusiness("alfa", "story-a3")],
    demandLanes: [
      { board: "alfa", laneId: "voce", cardIds: ["story-a1", "story-a2", "story-a3", "story-a9"] },
      { board: "beta", laneId: "voce", cardIds: [] },
    ],
    cards: [
      { board: "alfa", cardId: "story-a1", status: "corrigir" },
      { board: "beta", cardId: "story-b1", status: "concluida" },
    ],
    transitions: [
      { board: "alfa", cardId: "story-a1", to: "release", at: NOW - 6 * HOUR, actor: "system" },
      { board: "beta", cardId: "story-b1", to: "concluida", at: NOW - 1 * HOUR, actor: "system" },
    ],
    publishWaiting: [{ board: "alfa", cardId: "story-a1" }],
    publishHeld: [{ board: "alfa", cardId: "story-a1", phase: "deploy", exitCode: 3 }],
    fleet: [
      { agentId: "ag1", board: "alfa", cardId: "story-a1", alive: true, isConductor: true, quietForMs: 40 * 60_000, declaredWaiting: false, asking: false, worktreeMissing: false, claimAgeMs: 45 * 60_000 },
      { agentId: "ag2", board: null, cardId: null, alive: true, isConductor: true, quietForMs: 40 * 60_000, declaredWaiting: false, asking: false, worktreeMissing: false, claimAgeMs: null },
    ],
    orphanTerminals: ["ah-conductor-zumbi"],
    conductorQueue: [{ board: "alfa", cardId: "story-a5", queuedAt: NOW - 3 * HOUR }],
    stall: [{ key: "alfa/story-a1@corrigir", firstSeenAt: NOW - HOUR }, { key: "beta/story-b2@enriquecer", firstSeenAt: NOW - HOUR, escalatedAt: NOW }],
    toolFailures: [{ signature: "sandbox:seccomp", at: NOW - HOUR, board: "alfa", cardId: "story-a1" }, { signature: "sandbox:seccomp", at: NOW - HOUR, board: "beta", cardId: "story-b2" }],
  });
}

describe("scopeHealthInputs — o recorte de um board", () => {
  it("o board com o problema mede o problema; o calmo mede verde — a instalação misturava os dois", () => {
    const all = twoBoards();
    expect(level(all, "S1").value).toBe(3);
    expect(level(all, "S10").value).toBe(2); // a mesma assinatura em DOIS boards: 2 repetições na instalação

    const alfa = scopeHealthInputs(all, "alfa");
    expect(level(alfa, "S1").value).toBe(3);
    expect(level(alfa, "S3").value).toBe(1); // story-a9 está na raia sem estar em Decidir
    expect(level(alfa, "S9").value).toBe(1); // o arquivo diz corrigir, o ledger diz release
    expect(level(alfa, "S10").value).toBe(1);
    expect(level(alfa, "S6").value).toBeGreaterThan(5); // fila de publicação parada há 6 h

    const beta = scopeHealthInputs(all, "beta");
    expect(level(beta, "S1").value).toBe(0);
    expect(level(beta, "S3").value).toBe(0);
    expect(level(beta, "S9").value).toBe(0);
    expect(level(beta, "S6").value).toBe(0);
    expect(level(beta, "S10").value).toBe(1);
  });

  it("agente sem board e terminal órfão não são «de» nenhum board; claim, fila e vigia de parados seguem o board", () => {
    const alfa = scopeHealthInputs(twoBoards(), "alfa");
    expect(alfa.fleet.map((r) => r.agentId)).toEqual(["ag1"]);
    expect(alfa.orphanTerminals).toEqual([]);
    expect(alfa.conductorQueue).toHaveLength(1);
    expect(alfa.stall.map((r) => r.key)).toEqual(["alfa/story-a1@corrigir"]);
    const beta = scopeHealthInputs(twoBoards(), "beta");
    expect(beta.fleet).toEqual([]);
    expect(beta.conductorQueue).toEqual([]);
    expect(beta.stall.map((r) => r.key)).toEqual(["beta/story-b2@enriquecer"]);
  });

  it("o prefixo do vigia é por BOARD inteiro: «alfa» não pega «alfa2/…»", () => {
    const inputs = base({ stall: [{ key: "alfa2/story-x@corrigir", firstSeenAt: NOW }] });
    expect(scopeHealthInputs(inputs, "alfa").stall).toEqual([]);
  });

  it("o que não se divide por board fica intacto, e a ressalva diz isso (S11 mede a instalação)", () => {
    const all = twoBoards();
    const alfa = scopeHealthInputs(all, "alfa");
    expect(alfa.attribution).toEqual(all.attribution);
    expect(alfa.touches).toEqual(all.touches);
    expect(alfa.now).toBe(all.now);
    expect(alfa.fleetKnown).toBe(true);
    expect(BOARD_SCOPE_CAVEAT).toMatch(/S4/);
    expect(BOARD_SCOPE_CAVEAT).toMatch(/S11/);
  });

  it("não muda o original (PURA) e um board desconhecido mede o vazio, nunca o resto da instalação", () => {
    const all = twoBoards();
    const snapshot = JSON.stringify(all);
    const nobody = scopeHealthInputs(all, "nao-existe");
    expect(JSON.stringify(all)).toBe(snapshot);
    expect(nobody.inbox).toEqual([]);
    expect(nobody.deliveredStatuses).toEqual({});
    expect(level(nobody, "S1").value).toBe(0);
  });
});
