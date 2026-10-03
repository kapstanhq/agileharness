// O Jido faz a RECUPERAÇÃO TÉCNICA num board só-negócio (política só-negócio — a D13, decidida: sim). O que ele
// pega: execução travada (com limite; nunca no-op nem corte de orçamento), conflito do train, publicação que falhou
// (menos a que pediu o dono) e efeito que não rodou (uma vez). O que ele NÃO pega: gate genérico (é do pipeline,
// do verificador e do condutor). Esgotado o limite, abre um card de conserto e segue — nunca pergunta ao dono.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import { isCopilotActionable, recoveryRetryLimit, stuckItemsFromFailures, type CockpitItem, type CockpitItemKind } from "@/lib/storymap/demands";
import { AUTONOMO_DOCTRINE_VERSION } from "@/lib/storymap/copilot/tier";
import { emptyOrchestratorState, itemsInRecoveryBackoff, markRecoveryHandoff, type OrchestratorState } from "./orchestrator-state";
import { buildOrchestratorWakePrompt } from "./orchestrator-spawn";
import { buildRecoveryFixCard, planRecoveryHandoffs, runBusinessRecoveryPass, type BusinessRecoveryDeps } from "./business-recovery";
import { stewardMayAskOwner } from "./steward-deps";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const base = { boardId: "b", cardId: "story-t", cardTitle: "Indexar a lista de peças", status: "desenvolver", lane: "travado" as const, severity: "high" as const };
const item = (kind: CockpitItemKind, extra: Record<string, unknown> = {}) => ({ id: `story-t:${kind}`, kind, ...base, ...extra }) as unknown as CockpitItem;

describe("o que o Jido pega num board só-negócio", () => {
  const biz = { businessOnly: true };
  it("recuperação técnica: execução travada, conflito, merge falho, publicação falha e efeito que não rodou", () => {
    expect(isCopilotActionable(item("stuck", { reason: "error" }), "autonomo", biz)).toBe(true);
    expect(isCopilotActionable(item("conflict"), "autonomo", biz)).toBe(true);
    expect(isCopilotActionable(item("merge-failed"), "autonomo", biz)).toBe(true);
    expect(isCopilotActionable(item("deploy-failed"), "autonomo", biz)).toBe(true);
    expect(isCopilotActionable(item("effect-failed"), "autonomo", biz)).toBe(true);
  });

  it("NUNCA: no-op, corte de orçamento, publicação que pediu o dono — e o efeito exige o poder de publicar (Autônomo)", () => {
    expect(isCopilotActionable(item("stuck", { reason: "no-op" }), "autonomo", biz)).toBe(false);
    expect(isCopilotActionable(item("stuck", { reason: "budget-cut", outcome: "cortado no teto" }), "autonomo", biz)).toBe(false);
    expect(isCopilotActionable(item("deploy-failed", { needsHuman: true }), "autonomo", biz)).toBe(false);
    expect(isCopilotActionable(item("effect-failed"), "copiloto", biz)).toBe(false);
  });

  it("o gate genérico NÃO é dele (pipeline, verificador, condutor) — nem pergunta, triagem, design ou governança", () => {
    for (const kind of ["gate", "question", "review", "design", "governance", "proposal", "finding", "blocker", "release-aging", "deploy-unsettled"] as CockpitItemKind[]) {
      expect(isCopilotActionable(item(kind, { gateLabel: "Aprovar entrega" }), "autonomo", biz), kind).toBe(false);
    }
  });

  it("board human: a tabela de sempre (o gate segue acionável no Copiloto)", () => {
    expect(isCopilotActionable(item("gate", { gateLabel: "Aprovar entrega" }), "copiloto")).toBe(true);
    expect(isCopilotActionable(item("effect-failed"), "autonomo")).toBe(false);
  });

  it("o item de execução travada carrega o MOTIVO da morte (a régua não depende do texto de detalhe)", () => {
    const [stuck] = stuckItemsFromFailures(
      [{ board: "b", cardId: "story-t", reason: "budget-cut", detail: "cortado no teto de US$5", at: Date.now(), trigger: "harness-do" }],
      new Map([["story-t", { id: "story-t", title: "X", status: "desenvolver" }]]),
      { statuses: [{ id: "desenvolver", name: "Desenvolver" }] } as unknown as BoardConfig,
      "b",
    );
    expect(stuck).toMatchObject({ reason: "budget-cut" });
    expect(isCopilotActionable(stuck, "autonomo", biz)).toBe(false);
  });
});

describe("o limite de tentativas por tipo", () => {
  it("efeito que não rodou: UMA vez; o resto: duas", () => {
    expect(recoveryRetryLimit("effect-failed")).toBe(1);
    for (const k of ["stuck", "conflict", "merge-failed", "deploy-failed"] as CockpitItemKind[]) expect(recoveryRetryLimit(k)).toBe(2);
  });

  it("itemsInRecoveryBackoff aplica o limite do tipo, sob a doutrina em vigor", () => {
    const s: OrchestratorState = {
      ...emptyOrchestratorState(0),
      noopByItem: {
        "story-t:effect-failed": { streak: 1, doctrine: AUTONOMO_DOCTRINE_VERSION },
        "story-t:stuck:error": { streak: 1, doctrine: AUTONOMO_DOCTRINE_VERSION },
        "story-u:stuck:error": { streak: 2, doctrine: AUTONOMO_DOCTRINE_VERSION },
        "story-v:stuck:error": { streak: 5, doctrine: "pre" },
      },
    };
    const out = itemsInRecoveryBackoff(s, [
      { id: "story-t:effect-failed", kind: "effect-failed" },
      { id: "story-t:stuck:error", kind: "stuck" },
      { id: "story-u:stuck:error", kind: "stuck" },
      { id: "story-v:stuck:error", kind: "stuck" },
    ]);
    expect([...out].sort()).toEqual(["story-t:effect-failed", "story-u:stuck:error"]);
  });
});

describe("esgotado o limite: um card de conserto, uma vez, e segue", () => {
  const statuses = [
    { id: "triage", name: "Triagem", staging: true },
    { id: "desenvolver", name: "Desenvolver" },
  ];
  // o board que o tick dirige: só-negócio + Jido Autônomo (modo autônomo, deploy auto)
  const config = {
    id: "b",
    name: "Oficina",
    statuses,
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
    autonomy: { mode: "ultra" },
    orchestrator: { mode: "autonomous", riskMatrix: { deploy: "auto" } },
  } as unknown as BoardConfig;
  const user = coerceCard("story-user", { type: "story", storyType: "user", title: "Ver agenda de reparos", status: "desenvolver", parent: "step-a" }, "");
  const tech = coerceCard("story-t", { type: "story", storyType: "technical", title: "Indexar a lista de peças", status: "desenvolver", serves: "story-user" }, "");
  const cards = [user, tech];

  it("planRecoveryHandoffs: só o que está no limite e ainda não ganhou card", () => {
    const items = [item("stuck", { id: "story-t:stuck:error", reason: "error" }), item("conflict", { id: "conflict:r1" })];
    const handed = markRecoveryHandoff(emptyOrchestratorState(0), "conflict:r1", "story-fix1", "2026-09-28T00:00:00Z");
    expect(planRecoveryHandoffs(items, new Set(["story-t:stuck:error", "conflict:r1"]), handed).map((h) => h.item.id)).toEqual(["story-t:stuck:error"]);
    expect(planRecoveryHandoffs(items, new Set(), emptyOrchestratorState(0))).toEqual([]);
  });

  it("o card de conserto: técnico, na Triagem, serve a mesma história, relacionado ao card de origem, com a evidência", () => {
    const fix = buildRecoveryFixCard(item("stuck", { id: "story-t:stuck:error", reason: "error", trigger: "harness-do", outcome: "exit 1" }), cards, config, {
      tries: 2,
      now: "2026-09-28",
    });
    expect(fix).toMatchObject({ type: "story", storyType: "technical", status: "triage", serves: "story-user" });
    expect(fix.title).toMatch(/Indexar a lista de peças/);
    expect(fix.links).toContainEqual({ rel: "relates-to", to: "story-t" });
    expect(fix.body).toMatch(/2 tentativas/);
    expect(fix.body).toMatch(/exit 1/);
  });

  function world(cfg: BoardConfig = config) {
    let state = emptyOrchestratorState(0);
    state = { ...state, noopByItem: { "story-t:stuck:error": { streak: 2, doctrine: AUTONOMO_DOCTRINE_VERSION } } };
    const created: Card[] = [];
    const deps: BusinessRecoveryDeps = {
      readBoardConfig: async () => cfg,
      readCards: async () => cards,
      collectItems: async () => [item("stuck", { id: "story-t:stuck:error", reason: "error" })],
      readState: async () => state,
      writeState: async (_b, s) => {
        state = s;
      },
      createCard: async (_b, card) => {
        created.push(card);
        return { ...card, id: `story-fix${created.length}` };
      },
      record: vi.fn(async () => {}),
      now: () => Date.parse("2026-09-28T12:00:00Z"),
    };
    return { deps, created, state: () => state };
  }

  it("runBusinessRecoveryPass abre o card UMA vez e registra no estado (a segunda passada não duplica)", async () => {
    const w = world();
    await runBusinessRecoveryPass(w.deps, "b");
    await runBusinessRecoveryPass(w.deps, "b");
    expect(w.created).toHaveLength(1);
    expect(w.state().recoveryHandoffs?.["story-t:stuck:error"]).toMatchObject({ cardId: "story-fix1" });
    expect(w.deps.record).toHaveBeenCalledTimes(1);
  });

  it("o item que sumiu solta o registro (uma falha nova do mesmo item volta a ser tentada)", async () => {
    const w = world();
    await runBusinessRecoveryPass(w.deps, "b");
    expect(w.state().recoveryHandoffs).toBeDefined();
    w.deps.collectItems = async () => [];
    await runBusinessRecoveryPass(w.deps, "b");
    expect(w.state().recoveryHandoffs).toBeUndefined();
  });

  it("board human: nada acontece", async () => {
    const w = world({ ...config, autonomy: { mode: "human" } });
    await runBusinessRecoveryPass(w.deps, "b");
    expect(w.created).toHaveLength(0);
  });

  // Vários cards em «Liberar» podem parar pela MESMA lacuna de configuração. Chavear por item abriria um conserto por card.
  it("N publicações paradas pela MESMA causa ⇒ UM card de conserto, relacionado a todos os cards dela; a 2ª passada não duplica", async () => {
    const cause = { pkg: "acme", phase: "needs-units", units: ["batch-sync"], rules: ["unit-operator-only"], ownerClass: null, decider: "system", causeKey: "acme:system" };
    const blocked = (id: string) =>
      coerceCard(id, { type: "story", storyType: "technical", title: id, status: "release", findings: [{ id: "deploy-failure", lens: "general", severity: "high", status: "open", title: "parada", deployPhase: "needs-units", deployCause: cause }] }, "");
    const many = ["story-a", "story-b", "story-c"].map(blocked);
    const items = many.map((c) => item("deploy-failed", { id: `${c.id}:deploy-failed`, cardId: c.id, cardTitle: c.title }));
    let state: OrchestratorState = { ...emptyOrchestratorState(0), noopByItem: Object.fromEntries(items.map((i) => [i.id, { streak: 2, doctrine: AUTONOMO_DOCTRINE_VERSION }])) };
    const created: Card[] = [];
    const deps: BusinessRecoveryDeps = {
      readBoardConfig: async () => config,
      readCards: async () => [...cards, ...many],
      collectItems: async () => items,
      readState: async () => state,
      writeState: async (_b, s) => void (state = s),
      createCard: async (_b, c) => (created.push(c), { ...c, id: "story-fix" }),
      now: () => Date.parse("2026-10-01T22:45:00Z"),
    };
    await runBusinessRecoveryPass(deps, "b");
    await runBusinessRecoveryPass(deps, "b");
    expect(created).toHaveLength(1);
    expect(created[0].links?.map((l) => l.to).sort()).toEqual(["story-a", "story-b", "story-c"]);
    expect(created[0].title).toMatch(/publicação de acme \(3 cards parados\)/);
    expect(created[0].body).toMatch(/acme:system/);
    expect(Object.keys(state.recoveryHandoffs ?? {})).toEqual(["causa:b:acme:system"]);
    // a causa sumiu do Inbox ⇒ o registro solta (uma recaída é falha nova)
    deps.collectItems = async () => [];
    await runBusinessRecoveryPass(deps, "b");
    expect(state.recoveryHandoffs).toBeUndefined();
  });
});

describe("o steward não escala ao dono num board só-negócio", () => {
  it("a pergunta de integração vira diário; o card de conserto vem pelo limite", () => {
    expect(stewardMayAskOwner({ autonomy: { mode: "ultra" } })).toBe(false);
    expect(stewardMayAskOwner({ autonomy: { mode: "human" } })).toBe(true);
    expect(stewardMayAskOwner(null)).toBe(true);
  });
});

describe("o que o Jido lê ao acordar num board só-negócio", () => {
  it("recupera o técnico com limite, não empurra gate e nunca pergunta ao dono", () => {
    const p = buildOrchestratorWakePrompt("autonomo", { businessOnly: true });
    expect(p).toMatch(/SÓ-NEGÓCIO/);
    expect(p).toMatch(/gate/i);
    expect(p).toMatch(/card de conserto/);
    expect(p).toMatch(/nunca pergunte ao dono/i);
    expect(buildOrchestratorWakePrompt("autonomo")).not.toMatch(/SÓ-NEGÓCIO/);
  });
});
