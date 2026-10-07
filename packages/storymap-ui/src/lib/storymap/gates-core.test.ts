import { describe, expect, it } from "vitest";
import { checkGate, hasNarrative } from "./gates";
import { GATES, evaluateGate, placementViolation, resolveBoardStatuses } from "./gate-core";
import { coerceCard, coerceStatuses } from "./repo";
import type { BoardConfig, Card, GateId, StoryNarrative } from "./types";

// The 5 CORE pipeline gates (refinada/com-tasks/pronta) — the guard rails the
// whole /harness-* automation trusts to not advance a half-baked story. None were
// covered before (pipeline-cd.test.ts only exercises the Fase-C/D gates).
const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "so-aceite", name: "Só aceite", gate: "hasAcceptance" },
    { id: "refinada", name: "Refinada", gate: "hasRefinement" },
    { id: "com-tasks", name: "Com tasks", gate: "hasTasks" },
    { id: "pronta", name: "A fazer", gate: "hasRefinement" },
    { id: "so-staged", name: "Só staged", gate: "hasStaged" }, // Fase 4b
    { id: "so-released", name: "Só released", gate: "hasReleased" }, // Fase 4b
    { id: "sem-gate", name: "Sem gate" }, // no gate field
    { id: "gate-fantasma", name: "Gate fantasma", gate: "naoExisteNoRecord" as GateId },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (data: Record<string, unknown>): Card =>
  coerceCard("c", { type: "story", ...data }, "");

const FULL_NARRATIVE = { role: "Como leitor", want: "quero achar livros do meu gosto", soThat: "para ler mais" };

// hasNarrative is pure; test it directly with a hand-built narrative so coerce
// can't interfere with the whitespace/trim branch.
const narr = (n: Partial<StoryNarrative>): Card =>
  ({ narrative: { role: null, want: null, soThat: null, ...n } } as unknown as Card);

describe("hasNarrative — all three clauses, trimmed", () => {
  it("true only when role + want + soThat are all non-empty after trim", () => {
    expect(hasNarrative(narr(FULL_NARRATIVE))).toBe(true);
  });

  it("false when any single clause is missing", () => {
    expect(hasNarrative(narr({ want: "q", soThat: "s" }))).toBe(false); // no role
    expect(hasNarrative(narr({ role: "r", soThat: "s" }))).toBe(false); // no want
    expect(hasNarrative(narr({ role: "r", want: "q" }))).toBe(false); // no soThat
  });

  it("false for a whitespace-only clause (trim is load-bearing)", () => {
    expect(hasNarrative(narr({ role: "   ", want: "q", soThat: "s" }))).toBe(false);
  });
});

describe("checkGate — core pipeline gates", () => {
  it("hasAcceptance: needs >= 1 criterion (the boundary is 0 vs 1)", () => {
    expect(checkGate(card({ acceptance: [] }), "so-aceite", board)).toMatch(/aceite/i);
    expect(checkGate(card({ acceptance: ["dado X, quando Y, então Z"] }), "so-aceite", board)).toBeNull();
  });

  it("hasRefinement: requires narrative AND >= 1 acceptance (the AND-chain)", () => {
    const narrativeOnly = card({ narrative: FULL_NARRATIVE, acceptance: [] });
    const acceptanceOnly = card({ acceptance: ["ac"] }); // empty narrative
    const both = card({ narrative: FULL_NARRATIVE, acceptance: ["ac"] });
    expect(checkGate(narrativeOnly, "refinada", board)).toMatch(/narrativa|refinada/i); // narrative present, acceptance missing → blocked
    expect(checkGate(acceptanceOnly, "refinada", board)).toMatch(/narrativa|refinada/i); // acceptance present, narrative missing → blocked
    expect(checkGate(both, "refinada", board)).toBeNull();
  });

  it("hasTasks: needs >= 1 task", () => {
    expect(checkGate(card({ tasks: [] }), "com-tasks", board)).toMatch(/task/i);
    expect(checkGate(card({ tasks: [{ id: "t1", title: "fazer", done: false }] }), "com-tasks", board)).toBeNull();
  });

  // A priorização saiu: «A fazer» (pronta) pede só narrativa + aceite. Uma nota antiga (rice/kano/funil/priorityCall) num
  // card legado não abre nem fecha o gate — ela nem é lida.
  it("pronta (A fazer) é hasRefinement: sem nota de prioridade, e a nota legada não satisfaz nada", () => {
    const legacy = { rice: { reach: 100, impact: 2, confidence: 0.8, effort: 4 }, kano: "performance", funnelStage: "activation", priorityCall: { rank: 3, rationale: "r", source: "agent", assessedAt: "2026-06-20" } };
    expect(checkGate(card(legacy), "pronta", board)).toMatch(/narrativa|aceite/i);
    expect(checkGate(card({ narrative: FULL_NARRATIVE, acceptance: ["Dado A Quando B Então C"] }), "pronta", board)).toBeNull();
    expect(checkGate(card({ storyType: "bug", severity: "blocker", narrative: FULL_NARRATIVE, acceptance: ["Dado A Quando B Então C"] }), "pronta", board)).toBeNull();
  });

  it("os gates de priorização não existem mais (hasRice/hasPrioritization)", () => {
    expect("hasRice" in GATES).toBe(false);
    expect("hasPrioritization" in GATES).toBe(false);
  });
});

// A INVARIANTE DE HIERARQUIA — activity é raiz · step sob activity · user story sob step · entrega
// sob a user story que serve. Substitui o gate WS6 "soft" (parent OU serves OU unplacedAck, sem olhar
// tipo nem existência do alvo), que deixava passar as três formas de órfão que este bloco agora fixa:
// (a) card sem âncora nenhuma "aceito sem lugar", (b) âncora apontando para id inexistente e
// (c) âncora do TIPO errado — entrega pendurada em step/activity, user story pendurada em activity.
describe("hierarquia — placementViolation é a regra única de ancoragem", () => {
  const NODES: Record<string, Card> = {
    "act-1": coerceCard("act-1", { type: "activity" }, ""),
    "step-1": coerceCard("step-1", { type: "step", parent: "act-1" }, ""),
    "story-user": coerceCard("story-user", { type: "story", storyType: "user", parent: "step-1" }, ""),
  };
  const lookup = (id: string) => NODES[id] ?? null;
  const violation = (c: Card, cfg: BoardConfig | null = board) => placementViolation(c, lookup, cfg);
  const codeOf = (c: Card, cfg: BoardConfig | null = board) => violation(c, cfg)?.code ?? null;

  it("aceita a hierarquia canônica inteira", () => {
    expect(codeOf(NODES["act-1"]!)).toBeNull();
    expect(codeOf(NODES["step-1"]!)).toBeNull();
    expect(codeOf(NODES["story-user"]!)).toBeNull();
    expect(codeOf(card({ storyType: "bug", serves: "story-user" }))).toBeNull();
    // entrega SEM serves cai no parent — mas o parent também tem de ser a story base
    expect(codeOf(card({ storyType: "technical", parent: "story-user" }))).toBeNull();
  });

  it("card sem âncora nenhuma é violação — não há mais 'aceitar sem lugar'", () => {
    expect(codeOf(card({ parent: null }))).toBe("sem-ancora");
    expect(codeOf(card({ parent: null, unplacedAck: { by: "human", at: "2026-07-10" } }))).toBe("sem-ancora");
    expect(codeOf(coerceCard("s", { type: "step" }, ""))).toBe("sem-ancora");
  });

  it("âncora que não existe no board é violação (o gate antigo aceitava id fantasma)", () => {
    expect(codeOf(card({ parent: "step-que-nao-existe" }))).toBe("ancora-inexistente");
    expect(codeOf(card({ storyType: "bug", serves: "story-fantasma" }))).toBe("ancora-inexistente");
  });

  it("âncora do TIPO errado é violação — é o defeito das âncoras trocadas que um censo achou", () => {
    // entrega pendurada direto no step e na activity
    expect(codeOf(card({ storyType: "technical", parent: "step-1" }))).toBe("ancora-de-tipo-errado");
    expect(codeOf(card({ storyType: "bug", serves: "step-1" }))).toBe("ancora-de-tipo-errado");
    expect(codeOf(card({ storyType: "chore", parent: "act-1" }))).toBe("ancora-de-tipo-errado");
    // user story pulando o step e pendurada na activity
    expect(codeOf(card({ parent: "act-1" }))).toBe("ancora-de-tipo-errado");
    // step pendurado em qualquer coisa que não seja activity
    expect(codeOf(coerceCard("s", { type: "step", parent: "step-1" }, ""))).toBe("ancora-de-tipo-errado");
    // activity é raiz: ter pai é violação
    expect(codeOf(coerceCard("a", { type: "activity", parent: "act-1" }, ""))).toBe("activity-com-pai");
  });

  it("`serves` NÃO ancora uma user story — só entrega usa esse eixo", () => {
    expect(codeOf(card({ storyType: "user", parent: null, serves: "story-user" }))).toBe("sem-ancora");
  });

  it("as isenções são as declaradas — e só elas", () => {
    const cfg: BoardConfig = {
      ...board,
      statuses: [
        ...board.statuses,
        { id: "triage", name: "Triagem", staging: true },
        { id: "concluida", name: "Concluída", terminal: true },
      ],
    };
    // contêiner efêmero (captura) e ideia vivem fora do backbone por desenho
    expect(codeOf(card({ parent: null, capture: true }), cfg)).toBeNull();
    expect(codeOf(coerceCard("idea", { type: "idea" }, ""), cfg)).toBeNull();
    // quarentena: a caixa de entrada é onde o card ainda não sabe onde encaixa
    expect(codeOf(card({ parent: null, status: "triage" }), cfg)).toBeNull();
    // história: o concluído de antes da regra não é reancorado à força
    expect(codeOf(card({ parent: null, status: "concluida" }), cfg)).toBeNull();
    // ...mas um status VIVO qualquer volta a exigir âncora
    expect(codeOf(card({ parent: null, status: "pronta" }), cfg)).toBe("sem-ancora");
  });

  it("sem `lookup` a checagem degrada para só a FORMA (o que o cliente enxerga)", () => {
    // sem o board à mão não dá para saber se a âncora existe ou é do tipo certo — mas a AUSÊNCIA
    // de âncora continua detectável, e é o caso mais comum.
    expect(placementViolation(card({ parent: null }), null, board)?.code).toBe("sem-ancora");
    expect(placementViolation(card({ storyType: "technical", parent: "step-1" }), null, board)).toBeNull();
  });

  it("o gate hasPlacement é uma projeção da invariante (não uma segunda regra)", () => {
    expect(GATES.hasPlacement.ok(card({ parent: "step-1" }), { lookup, config: board })).toBe(true);
    expect(GATES.hasPlacement.ok(card({ parent: null }), { lookup, config: board })).toBe(false);
    expect(GATES.hasPlacement.ok(card({ storyType: "bug", serves: "step-1" }), { lookup, config: board })).toBe(false);
  });

  it("WS6 review fix: an EMPTY/whitespace parent (or serves) does NOT count as placement (no silent orphan)", () => {
    // defense-in-depth on the raw card (pre-coerce): "" must not evade the gate.
    expect(GATES.hasPlacement.ok({ type: "story", parent: "", serves: null } as Card)).toBe(false);
    expect(GATES.hasPlacement.ok({ type: "story", parent: "   ", serves: "  " } as Card)).toBe(false);
    // and coerceCard collapses an empty-string parent to null so it reads as unplaced everywhere.
    expect(coerceCard("c", { type: "story", parent: "" }, "").parent).toBeNull();
    expect(coerceCard("c", { type: "story", parent: "  " }, "").parent).toBeNull();
  });
});

// gate-fix-strings (story-ex0013, hardened): a gate's self-unblock advice must name update_card ONLY
// for a field update_card can actually set. The previous version asserted /update_card/ for hasTasks
// while update_card CANNOT set `tasks` — a string assertion masquerading as a contract, which is
// exactly how the misleading advice shipped. This is the DATA-DRIVEN contract instead.
//
// Mirror of update_card's inputSchema authoring fields (mcp/tools.ts update_card). KEEP IN SYNC: if you
// add a settable field there, add it here. Fields update_card CANNOT set (pipeline-owned or absent from
// the schema): tasks, techPlanReady, wireframeChosen, severity, frequency.
const SETTABLE_VIA_UPDATE_CARD = new Set([
  "title", "storyType", "narrative", "acceptance", "personas", "systems", "body", "status",
]);
// The authoring field(s) each AUTHORING gate requires. Pipeline gates (hasNoBlockers/hasQaPassed/hasStaged/…)
// require no authoring field → omitted.
const GATE_REQUIRED_FIELDS: Partial<Record<GateId, string[]>> = {
  hasAcceptance: ["acceptance"],
  hasRefinement: ["narrative", "acceptance"],
  hasTasks: ["tasks"],
  hasTechPlan: ["techPlanReady"],
  hasWireframe: ["wireframeChosen"],
};
// "Positively recommends update_card" = mentions it WITHOUT a negation ("NÃO ... update_card").
const recommendsUpdateCard = (s: string): boolean => /update_card/.test(s) && !/não[^.!?]*update_card/i.test(s);

describe("checkGate — unblock advice only names update_card for a field it can set (gate-fix-strings)", () => {
  for (const [gateId, fields] of Object.entries(GATE_REQUIRED_FIELDS)) {
    it(`${gateId}: if its advice names update_card, the required field IS settable there`, () => {
      const g = GATES[gateId as GateId];
      // A IMPLICAÇÃO NO LUGAR DO `if` — e a troca não é estilo.
      //
      // Com `if (recommendsUpdateCard(s))`, o `expect` só existia para os gates cuja mensagem CITA
      // `update_card`. MEDIDO: para 3 dos 5 gates deste laço ele nunca era alcançado — e são
      // justamente `hasTasks`/`hasTechPlan`/`hasWireframe`, os de campo NÃO settable, que é
      // onde este invariante importa. O teste ficava verde nos casos que ele existe para guardar.
      //
      // Agora o laço é sobre um literal de dois elementos (nunca vazio) e a asserção é a implicação
      // inteira: "não aconselha update_card, OU o campo é settable lá". Passa pelo mesmo motivo de
      // antes, e agora MEDE nos dois ramos.
      for (const s of [g.message, g.fix]) {
        const steers = recommendsUpdateCard(s);
        expect(
          !steers || fields!.every((f) => SETTABLE_VIA_UPDATE_CARD.has(f)),
          `${gateId} steers the agent to update_card but requires non-settable ${fields!.join("/")}`,
        ).toBe(true);
      }
    });
  }

  it("hasTechPlan names /harness-plan + denies update_card; hasWireframe names choose_wireframe + denies update_card", () => {
    expect(GATES.hasTechPlan.fix).toMatch(/harness-plan/);
    expect(recommendsUpdateCard(GATES.hasTechPlan.fix)).toBe(false); // techPlanReady not settable there
    expect(GATES.hasWireframe.fix).toMatch(/choose_wireframe/); // the REAL MCP unblock
    expect(recommendsUpdateCard(GATES.hasWireframe.fix)).toBe(false); // wireframeChosen not settable there
  });

  it("the author gates that DO name update_card require only settable fields (control: hasAcceptance/hasRefinement)", () => {
    expect(recommendsUpdateCard(GATES.hasAcceptance.fix)).toBe(true);
    expect(recommendsUpdateCard(GATES.hasRefinement.fix)).toBe(true);
  });
});

describe("checkGate — fallbacks always allow (load-bearing for forward-compat)", () => {
  it("a status with no gate field → null", () => {
    expect(checkGate(card({}), "sem-gate", board)).toBeNull();
  });

  it("a status not present in the board config → null", () => {
    expect(checkGate(card({}), "status-inexistente", board)).toBeNull();
  });

  it("a null/undefined target status → null (no-op move)", () => {
    expect(checkGate(card({}), null, board)).toBeNull();
    expect(checkGate(card({}), undefined, board)).toBeNull();
  });

  it("a gate id with no entry in the GATES record → null (never throws)", () => {
    // exercises the `if (!spec) return null` branch — a board.yaml referencing
    // an unknown gate id must degrade to "allow", not crash every drag.
    expect(checkGate(card({}), "gate-fantasma", board)).toBeNull();
  });
});

describe("checkGate — Fase 4b staged-release gates (hasStaged / hasReleased)", () => {
  it("hasStaged: blocked until the merge train stamps stagedAt (code on the stage branch)", () => {
    expect(checkGate(card({}), "so-staged", board)).toMatch(/stage/i);
    expect(checkGate(card({ stagedAt: "2026-06-10" }), "so-staged", board)).toBeNull();
  });

  it("hasReleased: bloqueia código STAGED não-liberado; vacuamente ok sem código (evita deadlock board-only)", () => {
    // tem código staged mas ainda não liberado → bloqueado
    expect(checkGate(card({ stagedAt: "2026-06-10" }), "so-released", board)).toMatch(/staged|libera/i);
    // liberado (promovido a main) → ok
    expect(checkGate(card({ stagedAt: "2026-06-10", releasedAt: "2026-06-11" }), "so-released", board)).toBeNull();
    // card board-only (nunca teve código) → vacuamente ok: nada a liberar, não trava
    expect(checkGate(card({}), "so-released", board)).toBeNull();
  });

  it("the dates round-trip through coerceCard (pipeline-owned persisted stamps)", () => {
    const c = card({ stagedAt: "2026-06-10", releasedAt: "2026-06-11" });
    expect(c.stagedAt).toBe("2026-06-10");
    expect(c.releasedAt).toBe("2026-06-11");
  });
});

// Um alvo que ainda não migrou: o `_base` dele declara o passo de prioridade e `pronta.gate: hasPrioritization`. O id
// aposentado é LIDO como o sucessor (hasRefinement) — pelo app (repo.ts) e pelo hook (gate-core, sobre o YAML cru) —,
// e nunca descartado: descartá-lo deixava «A fazer» sem gate, e stories entravam ali sem narrativa nem aceite.
describe("board.yaml antigo — gate aposentado lido como o sucessor", () => {
  const oldBase = {
    statuses: [
      { id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true },
      { id: "priorizar", name: "Estimar", trigger: "harness-prioritize", autorun: true, gate: "hasRefinement" },
      { id: "pronta", name: "A fazer", gate: "hasPrioritization" },
      { id: "estimada", name: "Estimada", gate: "hasRice" },
      { id: "concluida", name: "No ar", terminal: true },
    ],
  };
  const bare = coerceCard("story-ex9301", { type: "story", storyType: "user", status: "priorizar" }, "");
  const ready = coerceCard("story-ex9302", { type: "story", storyType: "user", status: "priorizar", narrative: { role: "leitor", want: "achar um livro", soThat: "comprar" }, acceptance: ["a"] }, "");

  it("o app lê `pronta` com hasRefinement (não SEM gate) e o passo velho vira passagem sem skill", () => {
    const statuses = coerceStatuses(oldBase.statuses);
    expect(statuses.find((x) => x.id === "pronta")?.gate).toBe("hasRefinement");
    expect(statuses.find((x) => x.id === "estimada")?.gate).toBe("hasRefinement");
    expect(statuses.find((x) => x.id === "priorizar")?.trigger).toBeUndefined();
    const config = { statuses } as unknown as BoardConfig;
    expect(checkGate(bare, "pronta", config)).toMatch(/narrativa/);
    expect(checkGate(ready, "pronta", config)).toBeNull();
  });

  it("o hook (gate-core sobre o YAML cru) segura a mesma entrada", () => {
    const raw = { statuses: resolveBoardStatuses(oldBase, {}) } as unknown as BoardConfig;
    expect(evaluateGate(bare, "pronta", raw)).toMatchObject({ gate: "hasRefinement" });
    expect(evaluateGate(ready, "pronta", raw)).toBeNull();
  });
});
