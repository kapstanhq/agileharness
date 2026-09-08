// graphToText — the deterministic TEXT projection of a FlowGraph (mirrors wireframe-dsl/to-text.ts).
//
// Every text surface (the card markdown projection, terminal, a copilot reading the sidecar, the
// legacy `journey.flow` field) reads THIS instead of the graph JSON: one node per line in layout
// order with its kind tagged, then one edge per line. Coerce issues are appended so no repair the
// coerce made can hide from a text reader (the SVG shows the same as a warning badge).

import { coerceFlowGraph } from "./coerce";
import type { FlowGraph, FlowNodeKind } from "./types";

const KIND_TAG: Record<FlowNodeKind, string> = {
  start: "início",
  step: "",
  decision: "decisão",
  error: "erro/vazio",
  end: "fim",
};

/** Render a (coerced) FlowGraph to a compact, deterministic pt-BR outline. */
export function graphToText(graph: FlowGraph, issues: string[] = []): string {
  const out: string[] = [];
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
  for (const n of graph.nodes) {
    const tag = KIND_TAG[n.kind] ? ` (${KIND_TAG[n.kind]})` : "";
    out.push(`• ${n.label}${tag}${n.note ? ` — ${n.note}` : ""}`);
  }
  if (graph.edges.length) out.push("");
  for (const e of graph.edges) {
    const arrow = e.label ? `—${e.label}→` : "→";
    out.push(`${label.get(e.from) ?? e.from} ${arrow} ${label.get(e.to) ?? e.to}`);
  }
  for (const issue of issues) out.push(`⚠ ${issue}`);
  return out.join("\n");
}

/** Coerce + project in one step — what sidecar coercion uses to derive `journey.flow`. */
export function coerceGraphToText(raw: unknown): { graph: FlowGraph | null; issues: string[]; text: string } {
  const { graph, issues } = coerceFlowGraph(raw);
  return { graph, issues, text: graph ? graphToText(graph, issues) : "" };
}
