// Flow Graph — pure core barrel (no React). The SVG renderer lives in
// components/wireframe/FlowGraphView.tsx and imports from here.

export {
  FLOW_NODE_KINDS,
  isFlowNodeKind,
  type FlowGraph,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowNodeKind,
} from "./types";
export { coerceFlowGraph, type CoercedFlowGraph } from "./coerce";
export { layoutFlowGraph, wrapLabel, type FlowLayout, type LaidOutEdge, type LaidOutNode } from "./layout";
export { graphToText, coerceGraphToText } from "./to-text";
