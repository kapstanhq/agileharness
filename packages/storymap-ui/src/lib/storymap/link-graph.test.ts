// Unit tests para link-graph.ts — aceites #1, #2, #3 (unidade), #4 da story-sbfutw.
// Rodam contra fixtures sintéticas (sem I/O). Padrão: red → green (TDD).

import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, LinkTypeDef } from "./types";
import {
  makeCtx,
  resolveNodeKind,
  validateLink,
  validateBoardLinks,
  buildLinkGraph,
  depsFromLinks,
} from "./link-graph";

// ── fixtures ──────────────────────────────────────────────────────────────────

const BASE_LINK_TYPES: LinkTypeDef[] = [
  { id: "depends-on", name: "Depende de" },
  { id: "relates-to", name: "Relacionado a" },
  { id: "blocks", name: "Bloqueia" },
  { id: "duplicates", name: "Duplica" },
  { id: "serves", name: "Serve", from: ["canvas", "inputMetric"], to: ["desiredOutcome"] },
  { id: "references", name: "Referencia", from: ["canvas"], to: ["persona", "release", "idea", "activity"] },
  { id: "moves", name: "Move", from: ["idea"], to: ["inputMetric"] },
  { id: "addresses", name: "Endereça", from: ["story"], to: ["idea"] },
  { id: "targets", name: "Mira", from: ["story", "idea"], to: ["persona"] },
];

function makeBoardConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    id: "test",
    name: "Test",
    statuses: [],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: BASE_LINK_TYPES,
    ...overrides,
  };
}

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    type: "story",
    title: id,
    storyType: "user",
    status: "desenvolver",
    parent: null,
    serves: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    rice: { reach: null, impact: null, confidence: null, effort: null },
    kano: null,
    funnelStage: null,
    findings: [],
    order: 0,
    created: null,
    updated: null,
    body: "",
    ...overrides,
  } as Card;
}

// ── resolveNodeKind ───────────────────────────────────────────────────────────

describe("resolveNodeKind", () => {
  it("resolve card type=story para 'story'", () => {
    const card = makeCard("s1", { type: "story" });
    const ctx = makeCtx(makeBoardConfig(), [card]);
    expect(resolveNodeKind("s1", ctx)).toBe("story");
  });

  it("resolve card type=activity para 'activity'", () => {
    const card = makeCard("a1", { type: "activity" });
    const ctx = makeCtx(makeBoardConfig(), [card]);
    expect(resolveNodeKind("a1", ctx)).toBe("activity");
  });

  it("resolve card type=step para 'step'", () => {
    const card = makeCard("st1", { type: "step" });
    const ctx = makeCtx(makeBoardConfig(), [card]);
    expect(resolveNodeKind("st1", ctx)).toBe("step");
  });

  it("resolve card type=idea para 'idea' (dual-track — a ◆ é card)", () => {
    const card = makeCard("opp1", { type: "idea" });
    const ctx = makeCtx(makeBoardConfig(), [card]);
    expect(resolveNodeKind("opp1", ctx)).toBe("idea");
  });

  it("resolve persona id para 'persona'", () => {
    const board = makeBoardConfig({ personas: [{ id: "p1", name: "Persona 1", color: "#000" }] });
    const ctx = makeCtx(board, []);
    expect(resolveNodeKind("p1", ctx)).toBe("persona");
  });

  it("resolve release id para 'release'", () => {
    const board = makeBoardConfig({ releases: [{ id: "r1", name: "Release 1", order: 1 }] });
    const ctx = makeCtx(board, []);
    expect(resolveNodeKind("r1", ctx)).toBe("release");
  });

  it("retorna null para id desconhecido", () => {
    const ctx = makeCtx(makeBoardConfig(), []);
    expect(resolveNodeKind("nao-existe", ctx)).toBeNull();
  });
});

// ── validateLink ─────────────────────────────────────────────────────────────

describe("validateLink", () => {
  it("retorna null para link válido (rel + pontas dentro da restrição)", () => {
    const story = makeCard("story-x", { type: "story" });
    const board = makeBoardConfig({
      // idea não existe como card, mas está no NodeKind — seam para artefatos futuros.
      // Para este teste usamos 'persona' como destino (targets from=story/idea to=persona).
      personas: [{ id: "persona-x", name: "P", color: "#000" }],
    });
    const ctx = makeCtx(board, [story]);
    const err = validateLink("story-x", { rel: "targets", to: "persona-x" }, board, ctx);
    expect(err).toBeNull();
  });

  it("retorna erro para rel desconhecido", () => {
    const s = makeCard("s1");
    const board = makeBoardConfig();
    const ctx = makeCtx(board, [s]);
    const err = validateLink("s1", { rel: "nao-existe", to: "s1" }, board, ctx);
    expect(err).not.toBeNull();
    expect(err).toMatch(/desconhecido|tipo de relação/i);
  });

  it("rejeita origem fora da restrição from com mensagem PT-BR que nomeia os permitidos", () => {
    // 'addresses' exige from=[story]; usamos card type=activity como origem → deve rejeitar
    const actCard = makeCard("act-1", { type: "activity" });
    const storyCard = makeCard("story-dest", { type: "story" });
    const board = makeBoardConfig();
    const ctx = makeCtx(board, [actCard, storyCard]);
    // origemId=act-1 (activity), destino=story-dest (story)
    // 'addresses' exige from=[story], mas act-1 é activity → rejeitar
    const err = validateLink("act-1", { rel: "addresses", to: "story-dest" }, board, ctx);
    expect(err).not.toBeNull();
    // mensagem deve citar os tipos permitidos na origem
    expect(err).toMatch(/story/);
  });

  it("rejeita destino fora da restrição to com mensagem PT-BR que nomeia os permitidos", () => {
    // 'addresses' exige to=[idea]; usamos story como destino → deve rejeitar
    const origin = makeCard("story-1", { type: "story" });
    const dest = makeCard("story-2", { type: "story" });
    const board = makeBoardConfig();
    const ctx = makeCtx(board, [origin, dest]);
    // origin=story-1 (story) ✓ from OK; dest=story-2 (story) mas to=[idea] → rejeitar
    const err = validateLink("story-1", { rel: "addresses", to: "story-2" }, board, ctx);
    expect(err).not.toBeNull();
    expect(err).toMatch(/idea/);
  });

  it("aceita um edge addresses story→idea VÁLIDO (a ◆ agora resolve)", () => {
    const story = makeCard("story-sol", { type: "story" });
    const idea = makeCard("idea-dor", { type: "idea" });
    const board = makeBoardConfig();
    const ctx = makeCtx(board, [story, idea]);
    const err = validateLink("story-sol", { rel: "addresses", to: "idea-dor" }, board, ctx);
    expect(err).toBeNull();
  });

  it("aceita link para edge sem from/to (legado, sem restrição)", () => {
    const s1 = makeCard("s1");
    const s2 = makeCard("s2");
    const board = makeBoardConfig();
    const ctx = makeCtx(board, [s1, s2]);
    // 'depends-on' não tem from/to → aceita qualquer ponta
    const err = validateLink("s1", { rel: "depends-on", to: "s2" }, board, ctx);
    expect(err).toBeNull();
  });

  it("rejeita destino inexistente no board", () => {
    const s = makeCard("s1");
    const board = makeBoardConfig();
    const ctx = makeCtx(board, [s]);
    const err = validateLink("s1", { rel: "depends-on", to: "nao-existe" }, board, ctx);
    expect(err).not.toBeNull();
    expect(err).toMatch(/nao-existe|inexistente|não encontrado/i);
  });
});

// ── aceite #1: os 5 edges tipados existem com from/to declarados ──────────────

describe("aceite #1 — 5 edges tipados existem no board com from/to esperados", () => {
  const board = makeBoardConfig();
  const byId = new Map(board.linkTypes.map((lt) => [lt.id, lt]));

  it("'serves' from=[canvas,inputMetric] to=[desiredOutcome]", () => {
    const lt = byId.get("serves");
    expect(lt).toBeDefined();
    expect(lt!.from).toEqual(["canvas", "inputMetric"]);
    expect(lt!.to).toEqual(["desiredOutcome"]);
  });

  it("'references' from=[canvas] to=[persona,release,idea,activity]", () => {
    const lt = byId.get("references");
    expect(lt).toBeDefined();
    expect(lt!.from).toEqual(["canvas"]);
    expect(lt!.to).toEqual(["persona", "release", "idea", "activity"]);
  });

  it("'moves' from=[idea] to=[inputMetric]", () => {
    const lt = byId.get("moves");
    expect(lt!.from).toEqual(["idea"]);
    expect(lt!.to).toEqual(["inputMetric"]);
  });

  it("'addresses' from=[story] to=[idea]", () => {
    const lt = byId.get("addresses");
    expect(lt!.from).toEqual(["story"]);
    expect(lt!.to).toEqual(["idea"]);
  });

  it("'targets' from=[story,idea] to=[persona]", () => {
    const lt = byId.get("targets");
    expect(lt!.from).toEqual(["story", "idea"]);
    expect(lt!.to).toEqual(["persona"]);
  });
});

// ── validateBoardLinks ────────────────────────────────────────────────────────

describe("validateBoardLinks", () => {
  it("retorna [] para board sem links nos cards", () => {
    const cards = [makeCard("s1"), makeCard("s2")];
    const board = makeBoardConfig();
    expect(validateBoardLinks(board, cards)).toEqual([]);
  });

  it("retorna violações para links inválidos", () => {
    const cards = [makeCard("s1"), makeCard("s2")];
    cards[0] = makeCard("s1", { links: [{ rel: "nao-existe", to: "s2" }] });
    const board = makeBoardConfig();
    const violations = validateBoardLinks(board, cards);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].card).toBe("s1");
  });

  it("retorna [] para links legados (depends-on) sem restrição", () => {
    const s1 = makeCard("s1", { links: [{ rel: "depends-on", to: "s2" }] });
    const s2 = makeCard("s2");
    const board = makeBoardConfig();
    expect(validateBoardLinks(board, [s1, s2])).toEqual([]);
  });
});

// ── buildLinkGraph ────────────────────────────────────────────────────────────

describe("buildLinkGraph", () => {
  it("emite só arestas válidas (nenhuma de links inválidos)", () => {
    const s1 = makeCard("s1", { links: [{ rel: "nao-existe", to: "s2" }, { rel: "depends-on", to: "s2" }] });
    const s2 = makeCard("s2");
    const board = makeBoardConfig();
    const edges = buildLinkGraph(board, [s1, s2]);
    expect(edges.length).toBe(1);
    expect(edges[0].rel).toBe("depends-on");
  });

  it("parent NÃO vira edge implícita (sem relação contains)", () => {
    const child = makeCard("child", { parent: "parent-card" });
    const parent = makeCard("parent-card", { type: "activity" });
    const board = makeBoardConfig();
    const edges = buildLinkGraph(board, [child, parent]);
    // Não deve ter nenhuma aresta implicit de parent→child
    expect(edges).toEqual([]);
  });

  it("emite fromKind e toKind corretos para arestas válidas", () => {
    const s1 = makeCard("s1", {
      type: "story",
      links: [{ rel: "targets", to: "persona-1" }],
    });
    const board = makeBoardConfig({
      personas: [{ id: "persona-1", name: "P1", color: "#000" }],
    });
    const edges = buildLinkGraph(board, [s1]);
    expect(edges.length).toBe(1);
    expect(edges[0]).toMatchObject({ rel: "targets", from: "s1", to: "persona-1", fromKind: "story", toKind: "persona" });
  });
});

// ── aceite #4: backward-compat ────────────────────────────────────────────────

describe("backward-compat (aceite #4)", () => {
  it("board sem linkTypes (campo ausente) valida sem erro", () => {
    const board = makeBoardConfig({ linkTypes: [] });
    const s1 = makeCard("s1");
    expect(validateBoardLinks(board, [s1])).toEqual([]);
    expect(buildLinkGraph(board, [s1])).toEqual([]);
  });

  it("linkType sem from/to aceita qualquer ponta sem erro", () => {
    const board = makeBoardConfig({
      linkTypes: [{ id: "custom", name: "Custom" }],
    });
    const s1 = makeCard("s1", { links: [{ rel: "custom", to: "s2" }] });
    const s2 = makeCard("s2");
    const violations = validateBoardLinks(board, [s1, s2]);
    expect(violations).toEqual([]);
  });
});

describe("depsFromLinks (WS7) — depends-on links → scheduling edges", () => {
  it("derives a {from,to} edge (B finishes before A) with board/cardId keys", () => {
    const a = makeCard("a", { type: "story", links: [{ rel: "depends-on", to: "b" }] });
    const b = makeCard("b", { type: "story" });
    expect(depsFromLinks("storymap", [a, b])).toEqual([{ from: "storymap/b", to: "storymap/a" }]);
  });

  it("ignores non-depends-on rels + edges to cards outside the set + self-edges", () => {
    const a = makeCard("a", { type: "story", links: [{ rel: "relates-to", to: "b" }, { rel: "depends-on", to: "ghost" }, { rel: "depends-on", to: "a" }] });
    const b = makeCard("b", { type: "story" });
    expect(depsFromLinks("storymap", [a, b])).toEqual([]);
  });

  it("dedupes duplicate depends-on edges", () => {
    const a = makeCard("a", { type: "story", links: [{ rel: "depends-on", to: "b" }, { rel: "depends-on", to: "b" }] });
    const b = makeCard("b", { type: "story" });
    expect(depsFromLinks("storymap", [a, b])).toHaveLength(1);
  });
});
