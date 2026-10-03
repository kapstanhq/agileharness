// Flow Graph — the structured user-flow DSL the harness-ux skill emits INSTEAD of mermaid/ascii source.
//
// WHY (same contract as the wireframe DSL, wireframe-dsl/types.ts): the LLM declares SEMANTIC
// STRUCTURE — explicit nodes and edges with typed kinds — and CODE does the pixel plumbing:
//   • FlowGraphView (components/wireframe/FlowGraphView.tsx) lays the graph out deterministically
//     (layout.ts) and renders a real SVG diagram — the journey finally reads as a picture;
//   • graphToText (to-text.ts) projects the SAME graph to a compact, deterministic text outline for
//     every text surface (markdown projection, terminal, copilot, the legacy `journey.flow` field).
// Explicit nodes/edges also beat mermaid SOURCE for machine readers: refs are checkable (a dangling
// edge is a reportable issue, not a silent parse quirk) and screens can point at flow steps by id
// (DesignArtifact.journeyRef).
//
// mermaid/ascii remain accepted as LEGACY journey formats (rendered as text, exactly as before).

/** What a node IS in the flow — drives shape/tint in the SVG and the tag in the text projection. */
export const FLOW_NODE_KINDS = ["start", "step", "decision", "error", "end"] as const;
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];

export interface FlowGraphNode {
  id: string;
  /** short human label (the box text) — plain text, rendered as SVG text children only */
  label: string;
  kind: FlowNodeKind;
  /** optional one-line annotation under the label */
  note?: string | null;
}

export interface FlowGraphEdge {
  /** source node id */
  from: string;
  /** target node id */
  to: string;
  /** optional edge label (e.g. "sim" / "não") */
  label?: string | null;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

export function isFlowNodeKind(v: unknown): v is FlowNodeKind {
  return typeof v === "string" && (FLOW_NODE_KINDS as readonly string[]).includes(v);
}
