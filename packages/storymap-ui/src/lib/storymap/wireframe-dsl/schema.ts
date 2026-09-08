// Tolerant coercion for the Wireframe DSL — pure, never throws (mirrors sidecars.ts coerce*).
// The LLM output is untrusted: unknown node types become a labeled `placeholder` (nothing renders
// blank), non-JSON prop values are dropped, and the tree is bounded (depth + node count) so a
// runaway generation can't blow up the renderer. coerceNode returns null only for structurally
// empty input, so a caller can treat null as "no DSL".

import {
  CONTAINER_TYPES,
  isPrimitiveType,
  type WireframeNode,
  type WireframePrimitiveType,
  type WireframePropValue,
} from "./types";

const MAX_DEPTH = 12; // deepest realistic screen tree; deeper is almost certainly a generation error
const MAX_NODES = 500; // hard ceiling on total nodes across the tree
const MAX_PROP_DEPTH = 4; // nested prop objects/arrays (e.g. tabbar items) — no deep JSON blobs
const MAX_ARRAY = 24; // cap array-valued props (tabbar/grid item lists)

/** Deep-sanitise a raw prop value into a JSON-safe WireframePropValue; undefined = drop the key. */
function coerceProp(raw: unknown, depth: number): WireframePropValue | undefined {
  if (raw === null) return null;
  const t = typeof raw;
  if (t === "string") return raw as string;
  if (t === "number") return Number.isFinite(raw as number) ? (raw as number) : undefined;
  if (t === "boolean") return raw as boolean;
  if (depth >= MAX_PROP_DEPTH) return undefined;
  if (Array.isArray(raw)) {
    const out: WireframePropValue[] = [];
    for (const item of raw.slice(0, MAX_ARRAY)) {
      const v = coerceProp(item, depth + 1);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  if (t === "object") {
    const out: Record<string, WireframePropValue> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const cv = coerceProp(v, depth + 1);
      if (cv !== undefined) out[k] = cv;
    }
    return out;
  }
  return undefined; // functions, symbols, bigint, undefined
}

function coerceProps(raw: unknown): Record<string, WireframePropValue> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, WireframePropValue> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const cv = coerceProp(v, 0);
    if (cv !== undefined) out[k] = cv;
  }
  return Object.keys(out).length ? out : undefined;
}

interface Ctx {
  count: number;
}

function coerceNodeInner(raw: unknown, depth: number, ctx: Ctx): WireframeNode | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (ctx.count >= MAX_NODES || depth > MAX_DEPTH) return null;
  const o = raw as Record<string, unknown>;

  // Unknown/missing type → a placeholder that keeps the original label so nothing is lost.
  let type: WireframePrimitiveType;
  let props = coerceProps(o.props);
  if (isPrimitiveType(o.type)) {
    type = o.type;
  } else {
    type = "placeholder";
    const orig = o.type != null ? String(o.type) : "?";
    props = { ...(props ?? {}), label: (props?.label as string) ?? `${orig}` };
  }
  ctx.count += 1;

  const node: WireframeNode = { type };
  if (props) node.props = props;

  // Only containers keep children; leaves drop them (a mis-nested tree degrades, never crashes).
  if (CONTAINER_TYPES.has(type) && Array.isArray(o.children)) {
    const kids: WireframeNode[] = [];
    for (const child of o.children) {
      if (ctx.count >= MAX_NODES) break;
      const c = coerceNodeInner(child, depth + 1, ctx);
      if (c) kids.push(c);
    }
    if (kids.length) node.children = kids;
  }
  return node;
}

/** Coerce raw JSON (from the sidecar `dsl` field) into a bounded, JSON-safe WireframeNode.
 *  Returns null for empty/invalid input so the caller falls back to `content` (ASCII). */
export function coerceNode(raw: unknown): WireframeNode | null {
  return coerceNodeInner(raw, 0, { count: 0 });
}

/** Count the nodes in a (already-coerced) tree — used by tests/telemetry. */
export function countNodes(node: WireframeNode | null): number {
  if (!node) return 0;
  return 1 + (node.children ?? []).reduce((n, c) => n + countNodes(c), 0);
}
