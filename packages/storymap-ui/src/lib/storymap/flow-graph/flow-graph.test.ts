import { describe, it, expect } from "vitest";
import { coerceFlowGraph, graphToText, layoutFlowGraph, wrapLabel, type FlowGraph } from "./index";

// A representative journey: entry → decision → happy/empty branches → exit (+ labels).
const SAMPLE = {
  nodes: [
    { id: "entra", label: "Entra pelo feed", kind: "start" },
    { id: "tem", label: "Tem eventos salvos?", kind: "decision" },
    { id: "lista", label: "Vê a lista agrupada por dia", kind: "step" },
    { id: "vazio", label: "Estado vazio com CTA de descoberta", kind: "error" },
    { id: "detalhe", label: "Abre o detalhe do evento", kind: "end" },
  ],
  edges: [
    { from: "entra", to: "tem" },
    { from: "tem", to: "lista", label: "sim" },
    { from: "tem", to: "vazio", label: "não" },
    { from: "lista", to: "detalhe" },
  ],
};

describe("coerceFlowGraph — tolerant, NEVER silent", () => {
  it("round-trips a valid graph with zero issues", () => {
    const { graph, issues } = coerceFlowGraph(SAMPLE);
    expect(issues).toEqual([]);
    expect(graph!.nodes).toHaveLength(5);
    expect(graph!.edges).toHaveLength(4);
    expect(graph!.nodes[1].kind).toBe("decision");
  });

  it("reports (not silently drops) a dangling edge — the P2 approval-surface guarantee", () => {
    const { graph, issues } = coerceFlowGraph({
      nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "a", to: "fantasma" }],
    });
    expect(graph!.edges).toHaveLength(0);
    expect(issues.some((i) => i.includes("fantasma") && i.includes("inexistente"))).toBe(true);
  });

  it("reports duplicate node ids and self-loops", () => {
    const { graph, issues } = coerceFlowGraph({
      nodes: [{ id: "a", label: "A" }, { id: "a", label: "A de novo" }, { id: "b", label: "B" }],
      edges: [{ from: "b", to: "b" }],
    });
    expect(graph!.nodes).toHaveLength(2);
    expect(issues.some((i) => i.includes("duplicado"))).toBe(true);
    expect(issues.some((i) => i.includes("laço"))).toBe(true);
  });

  it("defaults unknown kinds to step and mints missing ids", () => {
    const { graph } = coerceFlowGraph({ nodes: [{ label: "Sem id", kind: "wat" }] });
    expect(graph!.nodes[0].kind).toBe("step");
    expect(graph!.nodes[0].id).toBe("n1");
  });

  it("returns null graph for structurally empty input", () => {
    expect(coerceFlowGraph(null).graph).toBeNull();
    expect(coerceFlowGraph({ nodes: [] }).graph).toBeNull();
    expect(coerceFlowGraph("flowchart TD").graph).toBeNull();
  });

  it("bounds a pathological graph and reports the truncation", () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    const { graph, issues } = coerceFlowGraph({ nodes, edges: [] });
    expect(graph!.nodes.length).toBeLessThanOrEqual(60);
    expect(issues.some((i) => i.includes("truncado"))).toBe(true);
  });
});

describe("layoutFlowGraph — deterministic geometry", () => {
  it("is deterministic (same input ⇒ identical output)", () => {
    const { graph } = coerceFlowGraph(SAMPLE);
    expect(layoutFlowGraph(graph!)).toEqual(layoutFlowGraph(graph!));
  });

  it("assigns layers top-down: branches share a layer, the exit sits below", () => {
    const { graph } = coerceFlowGraph(SAMPLE);
    const l = layoutFlowGraph(graph!);
    const y = Object.fromEntries(l.nodes.map((n) => [n.id, n.y]));
    expect(y.entra).toBeLessThan(y.tem);
    expect(y.tem).toBeLessThan(y.lista);
    expect(y.lista).toBe(y.vazio); // sibling branches on the same layer
    expect(y.lista).toBeLessThan(y.detalhe);
  });

  it("produces finite, positive geometry for a 20-node two-branch graph (no NaN, no overlap blowup)", () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, label: `Passo número ${i} da jornada` }));
    const edges = Array.from({ length: 18 }, (_, i) => ({ from: `n${Math.floor(i / 2)}`, to: `n${i + 1}` }));
    const { graph, issues } = coerceFlowGraph({ nodes, edges });
    expect(issues).toEqual([]);
    const l = layoutFlowGraph(graph!);
    expect(l.nodes).toHaveLength(20);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
    for (const n of l.nodes) {
      for (const v of [n.x, n.y, n.w, n.h]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(n.w).toBeGreaterThan(0);
      expect(n.h).toBeGreaterThan(0);
    }
    for (const e of l.edges) {
      for (const v of Object.values(e.path)) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("survives a cycle (bounded relaxation, back edge flagged)", () => {
    const { graph } = coerceFlowGraph({
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    });
    const l = layoutFlowGraph(graph!);
    expect(l.edges.some((e) => e.back)).toBe(true);
  });

  it("wraps long labels to at most 3 lines with ellipsis", () => {
    const lines = wrapLabel("uma jornada com um rótulo absurdamente longo que jamais caberia numa caixa só de linha única");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[lines.length - 1].endsWith("…")).toBe(true);
  });
});

describe("graphToText — the deterministic text projection", () => {
  it("lists every node with its kind tag and every edge with its label", () => {
    const { graph } = coerceFlowGraph(SAMPLE);
    const text = graphToText(graph!);
    expect(text).toContain("• Entra pelo feed (início)");
    expect(text).toContain("• Tem eventos salvos? (decisão)");
    expect(text).toContain("Tem eventos salvos? —sim→ Vê a lista agrupada por dia");
    expect(text).toContain("—não→ Estado vazio");
  });

  it("appends coerce issues so text surfaces see every repair", () => {
    const { graph, issues } = coerceFlowGraph({
      nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "a", to: "x" }],
    });
    const text = graphToText(graph!, issues);
    expect(text).toContain("⚠");
    expect(text).toContain("inexistente");
  });
});
