// Deterministic layered layout for a FlowGraph (Sugiyama-lite) — pure geometry, no DOM, no React.
//
// Journeys are small (5-20 nodes, mostly linear with a few branches), so a full Sugiyama pipeline
// would be over-engineering; this does the three passes that matter and nothing else:
//   1. layer assignment  — longest path from the sources (cycle-guarded relaxation);
//   2. in-layer ordering — one barycenter pass over predecessor positions (stable tie-break);
//   3. geometry          — word-wrapped labels size each box; layers stack top-down, centered.
// The output is plain numbers the SVG renderer consumes verbatim — same input, same pixels, always
// (the layout feeds snapshot-style tests; nothing here may depend on environment or time).

import type { FlowGraph, FlowNodeKind } from "./types";

export interface LaidOutNode {
  id: string;
  kind: FlowNodeKind;
  /** wrapped label lines (1-3) */
  lines: string[];
  note: string | null;
  x: number; // left
  y: number; // top
  w: number;
  h: number;
}

export interface LaidOutEdge {
  from: string;
  to: string;
  label: string | null;
  /** cubic bezier: start, control 1, control 2, end */
  path: { x1: number; y1: number; c1x: number; c1y: number; c2x: number; c2y: number; x2: number; y2: number };
  /** label anchor */
  lx: number;
  ly: number;
  /** true when the edge points back up (a cycle) — rendered dashed so the loop reads as a loop */
  back: boolean;
}

export interface FlowLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

const WRAP_CHARS = 22;
const MAX_LINES = 3;
const CHAR_W = 6.6; // ~13px system font average — generous so text never overflows the box
const PAD_X = 12;
const LINE_H = 15;
const NOTE_H = 13;
const PAD_Y = 9;
const MIN_W = 88;
const MAX_W = 200;
const H_GAP = 28;
const V_GAP = 46;
const MARGIN = 12;

/** Greedy word-wrap into at most MAX_LINES lines of ~WRAP_CHARS (last line hard-clipped). */
export function wrapLabel(label: string): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= WRAP_CHARS || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length === MAX_LINES - 1) break;
    }
  }
  if (cur) lines.push(cur);
  const rest = words.join(" ");
  if (lines.length === MAX_LINES && lines.join(" ").length < rest.length) {
    const last = lines[MAX_LINES - 1];
    lines[MAX_LINES - 1] = last.length >= WRAP_CHARS ? `${last.slice(0, WRAP_CHARS - 1)}…` : `${last}…`;
  }
  return lines.length ? lines : [""];
}

export function layoutFlowGraph(graph: FlowGraph): FlowLayout {
  const ids = graph.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }

  // 1 — layers: sources at 0, then longest-path relaxation. The pass count is bounded by the node
  // count, so a cycle simply stops relaxing instead of looping forever (its back edge renders `back`).
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of graph.edges) {
      const want = layer.get(e.from)! + 1;
      if (want > layer.get(e.to)! && want < ids.length) {
        layer.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 2 — group by layer (insertion order), then one barycenter pass ordering each layer by the mean
  // position of its predecessors in the layer above (stable: ties keep insertion order).
  const layerIds = [...new Set([...layer.values()])].sort((a, b) => a - b);
  const byLayer = new Map<number, string[]>(layerIds.map((l) => [l, []]));
  for (const id of ids) byLayer.get(layer.get(id)!)!.push(id);
  const pos = new Map<string, number>();
  for (const l of layerIds) {
    const row = byLayer.get(l)!;
    if (l !== layerIds[0]) {
      const keyed = row.map((id, i) => {
        const ps = preds.get(id)!.filter((p) => pos.has(p));
        const bary = ps.length ? ps.reduce((s, p) => s + pos.get(p)!, 0) / ps.length : i;
        return { id, bary, i };
      });
      keyed.sort((a, b) => a.bary - b.bary || a.i - b.i);
      byLayer.set(l, keyed.map((k) => k.id));
    }
    byLayer.get(l)!.forEach((id, i) => pos.set(id, i));
  }

  // 3 — geometry.
  const size = new Map<string, { w: number; h: number; lines: string[] }>();
  for (const n of graph.nodes) {
    const lines = wrapLabel(n.label);
    const longest = Math.max(...lines.map((s) => s.length), n.note ? Math.min(n.note.length, WRAP_CHARS + 4) : 0);
    const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(longest * CHAR_W) + PAD_X * 2));
    const h = PAD_Y * 2 + lines.length * LINE_H + (n.note ? NOTE_H : 0);
    size.set(n.id, { w, h, lines });
  }
  const rowWidth = (row: string[]) => row.reduce((s, id) => s + size.get(id)!.w, 0) + H_GAP * (row.length - 1);
  const maxRow = Math.max(...layerIds.map((l) => rowWidth(byLayer.get(l)!)));
  const width = maxRow + MARGIN * 2;

  const nodes: LaidOutNode[] = [];
  const at = new Map<string, LaidOutNode>();
  let y = MARGIN;
  for (const l of layerIds) {
    const row = byLayer.get(l)!;
    const rowH = Math.max(...row.map((id) => size.get(id)!.h));
    let x = MARGIN + (maxRow - rowWidth(row)) / 2;
    for (const id of row) {
      const n = graph.nodes[index.get(id)!];
      const s = size.get(id)!;
      const node: LaidOutNode = {
        id,
        kind: n.kind,
        lines: s.lines,
        note: n.note ?? null,
        x: Math.round(x),
        y: Math.round(y + (rowH - s.h) / 2),
        w: s.w,
        h: s.h,
      };
      nodes.push(node);
      at.set(id, node);
      x += s.w + H_GAP;
    }
    y += rowH + V_GAP;
  }
  const height = y - V_GAP + MARGIN;

  const edges: LaidOutEdge[] = graph.edges.map((e) => {
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    const back = layer.get(e.to)! <= layer.get(e.from)!;
    const x1 = a.x + a.w / 2;
    const y1 = back ? a.y + a.h / 2 : a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = back ? b.y + b.h / 2 : b.y;
    // Forward: a gentle vertical S-curve. Back edge: bow out sideways so the loop is visible.
    const bend = back ? Math.max(a.w, b.w) / 2 + 24 : 0;
    const path = back
      ? { x1: a.x + a.w, y1, c1x: a.x + a.w + bend, c1y: y1, c2x: b.x + b.w + bend, c2y: y2, x2: b.x + b.w, y2 }
      : { x1, y1, c1x: x1, c1y: y1 + V_GAP / 2, c2x: x2, c2y: y2 - V_GAP / 2, x2, y2 };
    return {
      from: e.from,
      to: e.to,
      label: e.label ?? null,
      path,
      lx: Math.round((path.x1 + path.x2) / 2 + (back ? bend : 0)),
      ly: Math.round((path.y1 + path.y2) / 2),
      back,
    };
  });

  return { nodes, edges, width: Math.round(width), height: Math.round(height) };
}
