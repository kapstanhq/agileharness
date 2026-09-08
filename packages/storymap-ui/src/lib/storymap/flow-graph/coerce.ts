// Tolerant coercion for the Flow Graph — pure, never throws (mirrors wireframe-dsl/schema.ts).
// The LLM output is untrusted AND typo-prone; unlike the wireframe tree, a dropped piece here would
// change the MEANING of the journey the human approves — so nothing is dropped silently: every
// repair is reported in `issues[]`, which the renderer surfaces as a warning badge and graphToText
// appends to the text projection. An author (harness-ux) is instructed to re-read after writing and fix
// until issues is empty.

import { isFlowNodeKind, type FlowGraph, type FlowGraphEdge, type FlowGraphNode } from "./types";

const MAX_NODES = 60; // a journey is 5-20 nodes; more is a generation error
const MAX_EDGES = 120;
const MAX_LABEL = 120; // hard clip — labels are box text, not paragraphs
const MAX_NOTE = 160;

export interface CoercedFlowGraph {
  /** the usable graph, or null when the input has no usable nodes */
  graph: FlowGraph | null;
  /** human-readable repairs/drops (pt-BR) — non-empty means the author should fix the source */
  issues: string[];
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Coerce raw JSON (the sidecar `journey.graph` / artifact `graph` field) into a bounded FlowGraph. */
export function coerceFlowGraph(raw: unknown): CoercedFlowGraph {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { graph: null, issues };
  const r = raw as Record<string, unknown>;

  const rawNodes = Array.isArray(r.nodes) ? r.nodes : [];
  const nodes: FlowGraphNode[] = [];
  const seen = new Set<string>();
  for (const [i, rn] of rawNodes.entries()) {
    if (nodes.length >= MAX_NODES) {
      issues.push(`grafo truncado em ${MAX_NODES} nós (${rawNodes.length} no total)`);
      break;
    }
    if (!rn || typeof rn !== "object") continue;
    const o = rn as Record<string, unknown>;
    const label = clip(str(o.label) ?? "", MAX_LABEL);
    let id = (str(o.id) ?? "").trim();
    if (!id) id = `n${i + 1}`;
    if (!label && !id) continue;
    if (seen.has(id)) {
      // A duplicate id would make edges ambiguous — keep the FIRST, report the rest.
      issues.push(`nó duplicado descartado: "${id}"`);
      continue;
    }
    seen.add(id);
    const kind = isFlowNodeKind(o.kind) ? o.kind : "step";
    const note = str(o.note);
    nodes.push({ id, label: label || id, kind, ...(note?.trim() ? { note: clip(note, MAX_NOTE) } : {}) });
  }
  if (!nodes.length) return { graph: null, issues };

  const rawEdges = Array.isArray(r.edges) ? r.edges : [];
  const edges: FlowGraphEdge[] = [];
  for (const re of rawEdges) {
    if (edges.length >= MAX_EDGES) {
      issues.push(`arestas truncadas em ${MAX_EDGES} (${rawEdges.length} no total)`);
      break;
    }
    if (!re || typeof re !== "object") continue;
    const o = re as Record<string, unknown>;
    const from = (str(o.from) ?? "").trim();
    const to = (str(o.to) ?? "").trim();
    if (!from || !to) continue;
    const missing = [from, to].filter((id) => !seen.has(id));
    if (missing.length) {
      // NEVER silent: a dropped transition changes the journey's meaning at the approval stop.
      issues.push(`aresta descartada (${from} → ${to}): nó ${missing.map((m) => `"${m}"`).join(" e ")} inexistente`);
      continue;
    }
    if (from === to) {
      issues.push(`aresta descartada (${from} → ${to}): laço sobre o próprio nó`);
      continue;
    }
    const label = str(o.label);
    edges.push({ from, to, ...(label?.trim() ? { label: clip(label, 40) } : {}) });
  }

  return { graph: { nodes, edges }, issues };
}
