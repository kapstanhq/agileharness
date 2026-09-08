// Wireframe DSL — pure core barrel (no React). The client renderer lives in
// components/wireframe/WireframeDSL.tsx and imports from here.

export {
  PRIMITIVE_SPECS,
  PRIMITIVE_TYPES,
  CONTAINER_TYPES,
  isPrimitiveType,
  type WireframeNode,
  type WireframePropValue,
  type WireframePrimitiveType,
  type PrimitiveSpec,
} from "./types";
export { coerceNode, countNodes } from "./schema";
export { dslToText } from "./to-text";

import { PRIMITIVE_SPECS, PRIMITIVE_TYPES } from "./types";

/**
 * Render the primitive vocabulary as a compact markdown table — the single source both the harness-ui
 * SKILL.md guidance and any /docs surface read from, so the documented vocabulary can never drift
 * from the code. (Container primitives are marked ▸.)
 */
export function vocabularyMarkdown(): string {
  const rows = PRIMITIVE_TYPES.map((t) => {
    const spec = PRIMITIVE_SPECS[t];
    const props = Object.entries(spec.props)
      .map(([k, doc]) => `\`${k}\` (${doc})`)
      .join("; ");
    const kind = spec.container ? "▸" : "·";
    return `| ${kind} \`${t}\` | ${spec.doc} | ${props || "—"} |`;
  });
  return ["| type | does | props |", "|---|---|---|", ...rows].join("\n");
}
