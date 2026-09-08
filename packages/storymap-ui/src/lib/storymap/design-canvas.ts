// design-canvas.ts — PURE selectors over a WireframeDoc for the Canvas v2 read surfaces
// (CardDocument, CockpitView, card-document markdown, demands, the MCP text view).
//
// THE LEGACY BRIDGE LIVES HERE, AT RENDER TIME — never in coerceWireframeDoc. The choose/feedback
// actions persist the COERCED doc back to disk (read-modify-write), so a coerce that injected
// artifacts derived from options would PERSIST them on the first human action: a one-way ratchet
// that doubles the payload and shadows every later options[] edit. A selector derives the same
// view in memory and never touches the file. (No React, no fs — node-unit-testable.)

import type { DesignArtifact, DesignFeedbackEntry, WireframeDoc } from "./types";

/**
 * The canvas artifacts to render: authored artifacts when present, else derived IN MEMORY from the
 * legacy single-choice options (kind screen, title=label, note=rationale). Legacy `html` options
 * stay excluded — they keep the "HTML legado" note path (the F2 contract), only NEW artifacts with
 * explicit format "html" render in the sandboxed frame.
 */
export function canvasArtifacts(doc: Pick<WireframeDoc, "artifacts" | "options">): DesignArtifact[] {
  if (doc.artifacts.length) return doc.artifacts;
  return doc.options
    .filter((o) => o.format !== "html")
    .map((o): DesignArtifact => {
      const isDsl = o.format === "dsl" && o.dsl != null;
      return {
        id: o.id,
        kind: "screen",
        title: o.label,
        note: o.rationale,
        format: isDsl ? "dsl" : "text",
        viewport: o.viewport,
        state: o.state,
        ...(isDsl ? { dsl: o.dsl } : {}),
        content: o.content,
        ...(o.heightHint != null ? { heightHint: o.heightHint } : {}),
      };
    });
}

const KIND_ORDER: Record<DesignArtifact["kind"], number> = { screen: 0, component: 1, flow: 2, note: 3 };

/** Canvas artifacts in display order: primary screen first, then screens, components, flows, notes
 *  (authored order within each kind) — mirrors orderedWireframeOptions' chosen-first rule. */
export function orderedCanvasArtifacts(doc: Pick<WireframeDoc, "artifacts" | "options" | "chosenOptionId">): DesignArtifact[] {
  const all = canvasArtifacts(doc);
  return [...all].sort((a, b) => {
    const primary = (x: DesignArtifact) => (x.id === doc.chosenOptionId ? -1 : 0);
    return primary(a) - primary(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || all.indexOf(a) - all.indexOf(b);
  });
}

/** True when the doc has ANYTHING to show/approve — the design-stop gate for cockpit items
 *  (an artifacts-only doc must surface in Inbox exactly like an options doc always did). */
export function hasCanvasContent(doc: Pick<WireframeDoc, "artifacts" | "options">): boolean {
  return doc.artifacts.length > 0 || doc.options.length > 0;
}

/**
 * Reserved feedback target for the JOURNEY card. Three DISTINCT feedback scopes exist (operator
 * decision 2026-07-22): a concrete artifact (its id) · the journey/flow (THIS id) · the design as a
 * whole (`artifactId: null`). Journey and whole-design both re-enter through `design-ux` (the flow
 * may change), but their THREADS stay separate so the UI can anchor each where it belongs.
 */
export const JOURNEY_FEEDBACK_ID = "journey";

/** Feedback thread of ONE artifact (resolved + unresolved, authored order). Works for the journey
 *  card too — pass {@link JOURNEY_FEEDBACK_ID}. */
export function artifactFeedback(doc: Pick<WireframeDoc, "feedback">, artifactId: string): DesignFeedbackEntry[] {
  return doc.feedback.filter((f) => f.artifactId === artifactId);
}

/**
 * WHOLE-DESIGN thread: entries with no target PLUS entries whose target no longer resolves (a regen
 * that re-minted ids must never orphan-drop a human's words — they fall back here as history).
 * Journey-targeted entries ({@link JOURNEY_FEEDBACK_ID}) are NOT here — they live on the journey card.
 */
export function canvasWideFeedback(doc: Pick<WireframeDoc, "artifacts" | "options" | "feedback">): DesignFeedbackEntry[] {
  const ids = new Set(canvasArtifacts(doc).map((a) => a.id));
  return doc.feedback.filter(
    (f) => f.artifactId == null || (f.artifactId !== JOURNEY_FEEDBACK_ID && !ids.has(f.artifactId)),
  );
}

/** The change-requests a design re-run must still incorporate (kind change, not yet stamped). */
export function unresolvedChanges(doc: Pick<WireframeDoc, "feedback">): DesignFeedbackEntry[] {
  return doc.feedback.filter((f) => f.kind === "change" && !f.resolvedAt);
}

/**
 * Where a "Pedir ajuste" re-run should re-enter: `design-ux` (journey regen, harness-ux → harness-ui) when
 * any unresolved change targets the JOURNEY, the design as a whole (null) or a dangling id — all of
 * those may question the FLOW itself; `design-ui` (screens only) when every unresolved change
 * targets a concrete artifact — re-running the whole journey for a one-screen tweak is a full extra
 * run of pure waste per iteration. (`journey` is not a canvas artifact, so `!ids.has(...)` already
 * covers it — kept implicit on purpose: one rule, no special case to drift.)
 */
export function designReturnTarget(doc: Pick<WireframeDoc, "artifacts" | "options" | "feedback">): "design-ux" | "design-ui" {
  const ids = new Set(canvasArtifacts(doc).map((a) => a.id));
  const wide = unresolvedChanges(doc).some((f) => f.artifactId == null || !ids.has(f.artifactId));
  return wide ? "design-ux" : "design-ui";
}

/**
 * The lean projection for LLM readers (MCP get_card_wireframes view:"text"): every artifact keeps
 * only its code-derived `content` — the dsl/html/graph sources are omitted. NEVER round-trip this
 * into write_sidecar: it is a PROJECTION, writing it back would destroy the source trees.
 */
export function wireframeDocTextView(doc: WireframeDoc): Record<string, unknown> {
  return {
    cardId: doc.cardId,
    status: doc.status,
    chosenOptionId: doc.chosenOptionId,
    updated: doc.updated,
    journey: doc.journey
      ? {
          format: doc.journey.format,
          flow: doc.journey.flow,
          ...(doc.journey.issues?.length ? { issues: doc.journey.issues } : {}),
          narrative: doc.journey.narrative,
        }
      : null,
    artifacts: canvasArtifacts(doc).map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      note: a.note,
      format: a.format,
      viewport: a.viewport,
      state: a.state,
      ...(a.journeyRef ? { journeyRef: a.journeyRef } : {}),
      content: a.content,
    })),
    feedback: doc.feedback,
  };
}
