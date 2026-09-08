// 🟥 Style Guide — pure state-derivation for the `estilo` view. The client component (EstiloView) is a
// THIN SHELL: the "which state do I render" decision lives here, in a node-testable module, because RTL
// `.tsx` tests are broken under rolldown-vite (invariant 4). The guide is a PLAIN SOURCE-OF-TRUTH
// document — there is no generation/approval flow — so there are only TWO states: it is published, or
// it is empty (author it via prompt/refs).
//
// ⚠️ TYPE-ONLY import from "./style-guide" on purpose: that module has a top-level
// `import { createHash } from "node:crypto"` (for computeStyleGuideHash), so any RUNTIME (value)
// import of it — even one unused named export — drags `node:crypto` into whatever bundle imports
// THIS file. This module is imported by EstiloView ("use client"), so a value import here would
// break the client webpack build (the app's own next.config.js only externalizes node builtins
// `if (isServer)` — "No-op on the client bundle", by its own comment). `isEmptyStyleGuideDoc` is
// therefore never called here — the caller (a Server Component, where node:crypto is fine) does that
// check ONCE and hands over the plain boolean `hasPublishedGuide`.
import type { StyleGuideDoc } from "./style-guide";

export type EstiloState =
  | { kind: "vazio" }
  | { kind: "publicado"; styleGuide: StyleGuideDoc };

export interface DeriveEstiloStateInput {
  /** The canonical guide (design/style-guide.md), or null when the board has none yet. Carried through
   *  only to be rendered by the "publicado" state — emptiness is decided by `hasPublishedGuide`, NOT
   *  re-derived here (see the top-of-file note on why `isEmptyStyleGuideDoc` isn't called in this module). */
  styleGuide: StyleGuideDoc | null;
  /** Precomputed by the caller: `!!styleGuide && !isEmptyStyleGuideDoc(styleGuide)`. */
  hasPublishedGuide: boolean;
}

/**
 * Resolve the 2-state view:
 *
 *   guide non-empty → "publicado"
 *   otherwise       → "vazio"      (author it — a human writes/edits the guide via the assist action)
 */
export function deriveEstiloState(input: DeriveEstiloStateInput): EstiloState {
  const { styleGuide, hasPublishedGuide } = input;
  if (styleGuide && hasPublishedGuide) return { kind: "publicado", styleGuide };
  return { kind: "vazio" };
}
