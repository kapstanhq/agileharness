// AgileHarness feedback overlay — the versioned ANNOTATION IR (the "keystone" seam).
//
// This is the ONLY contract shared between PRODUCERS (our vanilla overlay, a future
// Agentation/lavish webhook adapter, a CLI) and the broker's SINKS (triage / refine /
// terminal / handoff). Extensibility = add a producer OR a sink — never a change to this
// contract's MEANING. Pure: no fs, no DOM, no server imports → unit-testable and imported by
// the intake route, the sinks and tests. (The Fase 1 overlay is a SEPARATE static IIFE that
// re-implements the client-side projection; a Fase 4 bundled producer imports this module.)
//
// Fase 1 uses only: coerceAnnotationBatch (validate the POST body) + renderBatchMarkdown
// (the triage-card body / copy-paste handoff). The `anchor` already carries the full grep
// context (selector + text + rect + route) so the LLM can locate the code WITHOUT any
// framework source-map — the app-agnostic bet.

import { z } from "zod";

export const ANNOTATION_SCHEMA_VERSION = 1 as const;

/**
 * Is a screenshot reference SAFE to embed in a card? Only a same-origin, ROOT-RELATIVE path.
 * Rejects `javascript:`/`data:` (script execution), an absolute `https://evil/x.png` and the
 * protocol-relative `//evil/x.png` — any of which would turn every later render of that card into an
 * outbound beacon to a third party (the card body is markdown, and an image src auto-loads). The
 * screenshotRef is producer-supplied, so this is enforced HERE, at the boundary, not at the renderer.
 */
export function isSafeScreenshotRef(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return false;
  if (!raw.startsWith("/")) return false; // must be root-relative…
  if (raw.startsWith("//")) return false; // …and NOT protocol-relative (//host = another origin)
  return !raw.includes("\\") && !raw.includes("\n") && !raw.includes("\r");
}

/** Where a captured element lives — enough for an agent to `grep` its way to the code. */
export const anchorSchema = z.object({
  /** grep-friendly CSS path (the agent searches on this). REQUIRED — an anchor with no
   *  selector is not locatable, so it is not a valid pin. */
  selector: z.string().min(1).max(2000),
  tag: z.string().optional(),
  classes: z.array(z.string()).optional(),
  /** the DOM element's own id — NOT an AgileHarness card id. */
  elementId: z.string().optional(),
  /** visible text snippet (helps disambiguate the component). */
  text: z.string().max(1000).optional(),
  rect: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .optional(),
  viewport: z.object({ w: z.number(), h: z.number() }).optional(),
  url: z.string().optional(),
  route: z.string().optional(),
  /** optional enricher output (react-hint / data-attr) — never required (keeps it agnostic). */
  componentHint: z.string().optional(),
  /** The region screenshot (6b), filled by the producer AFTER uploading the image out-of-band to
   *  /api/feedback/shot — a same-origin URL PATH, never raw bytes here. Constrained by
   *  isSafeScreenshotRef so a hostile producer cannot smuggle an external/`javascript:` src into the
   *  card markdown; an invalid value is REJECTED (not silently stripped) so the failure is loud. */
  screenshotRef: z.string().refine(isSafeScreenshotRef, "screenshotRef deve ser um caminho same-origin").optional(),
  /** REGION capture (drag-a-box): `selector` is the smallest CONTAINER of the box and `rect` is the
   *  box; `covered` lists the notable elements the box overlaps. An element click leaves both unset.
   *  Aditive — routing stays link.kind-only (keystone-freeze guards the batch/link shapes, NOT the
   *  anchor, so a new anchor facet is safe). */
  region: z.boolean().optional(),
  /** for a region: the notable elements the box overlaps (selector + human label), so the card can
   *  point at more than the single container. Capped so a huge box can't bloat the batch. */
  covered: z
    .array(z.object({ selector: z.string().min(1).max(2000), label: z.string().max(200).optional() }))
    .max(12)
    .optional(),
});
export type AnnotationAnchor = z.infer<typeof anchorSchema>;

// Fase 1 admits only change/approve — the exact set the refine sink's DesignFeedbackEntry
// accepts, so Pin.kind maps 1:1 with no ambiguous projection. bug/idea (+ their fold-to-change
// projection) arrive in Fase 2 alongside a producer UI that can pick them.
export const pinKindSchema = z.enum(["change", "approve"]);
export type PinKind = z.infer<typeof pinKindSchema>;

/** One annotation: an anchor + the human's note + its intent. */
export const pinSchema = z.object({
  note: z.string().min(1).max(2000),
  kind: pinKindSchema.default("change"),
  anchor: anchorSchema,
});
export type Pin = z.infer<typeof pinSchema>;

/** How this batch attaches to AgileHarness work. `board` is always required by a sink; `cardId`
 *  turns it into a refine (Fase 2); `sessionId` enables the terminal round-trip (Fase 3). */
export const linkSchema = z.object({
  kind: z.enum(["card", "session", "none"]).default("none"),
  board: z.string().optional(),
  cardId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type AnnotationLink = z.infer<typeof linkSchema>;

export const annotationBatchSchema = z.object({
  /** schema version — tolerated when absent; the broker treats an unknown/absent v as current. */
  v: z.number().optional(),
  producer: z.string().default("agileharness-overlay"),
  producedAt: z.string().optional(),
  link: linkSchema.default({ kind: "none" }),
  // NOTE: routing is decided ENTIRELY by link.kind (none→triage, card→refine, session→terminal).
  // There is deliberately no separate `returnMode` field — a second routing signal would compete
  // with link.kind (the "declared capability with no consumer" anti-pattern).
  pins: z.array(pinSchema).min(1).max(50),
});
export type AnnotationBatch = z.infer<typeof annotationBatchSchema>;

export type CoerceResult =
  | { ok: true; batch: AnnotationBatch }
  | { ok: false; error: string };

/** Tolerant parse: returns a typed error (mapped to HTTP 400 by the intake route) instead of
 *  throwing, so a malformed producer payload can never crash the broker. */
export function coerceAnnotationBatch(raw: unknown): CoerceResult {
  const parsed = annotationBatchSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join(".") || "batch"}: ${first.message}` : "batch inválido",
    };
  }
  return { ok: true, batch: parsed.data };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Whitespace-collapse anything that goes INSIDE a markdown list item.
 *
 * `anchor.text` is the captured element's `innerText`, which keeps the page's own line breaks —
 * and a bullet only owns its FIRST line. Marking a container full of rows therefore produced
 * `- **Texto:** Inbox` followed by a dozen orphan lines that silently ended the list and mangled
 * everything after it. One line in, one line out.
 */
function inline(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** One pin → a compact, faithful markdown block. The SAME projection feeds the triage-card
 *  body, the copy-paste handoff and (later) the terminal round-trip — one truth, many surfaces. */
export function renderPinMarkdown(pin: Pin, i: number): string {
  const a = pin.anchor;
  const where = [a.route || a.url, a.viewport ? `${a.viewport.w}×${a.viewport.h}` : null]
    .filter(Boolean)
    .join(" · ");
  // The note is a HEADING — a line break inside it would spawn a second, headingless paragraph.
  const lines = [`### ${i + 1}. ${inline(pin.note)}`, ""];
  if (a.region) lines.push(`- **Tipo:** região (área desenhada)`);
  // Two whole literals, not one interpolation: this way both labels are greppable in the source, which
  // is what lets the parity test compare the field sets of the two copies (schema.test.ts).
  lines.push(a.region ? `- **Contêiner:** \`${a.selector}\`` : `- **Seletor:** \`${a.selector}\``);
  if (a.text) lines.push(`- **Texto:** ${truncate(inline(a.text), 120)}`);
  if (a.covered && a.covered.length) {
    const items = a.covered.map((c) =>
      c.label ? `${truncate(inline(c.label), 60)} (\`${c.selector}\`)` : `\`${c.selector}\``,
    );
    lines.push(`- **Cobre:** ${items.join(", ")}`);
  }
  if (a.componentHint) lines.push(`- **Componente:** ${inline(a.componentHint)}`);
  if (where) lines.push(`- **Onde:** ${where}`);
  if (a.rect) {
    lines.push(
      `- **Posição:** ${Math.round(a.rect.x)},${Math.round(a.rect.y)} · ${Math.round(a.rect.w)}×${Math.round(a.rect.h)}`,
    );
  }
  // A markdown IMAGE (not a bare path) so the card actually shows the region instead of a filename.
  // The renderer only inlines same-origin srcs — which is exactly what the schema guard admits.
  if (a.screenshotRef) lines.push("", `![Captura da região](${a.screenshotRef})`);
  return lines.join("\n");
}

export function renderBatchMarkdown(batch: AnnotationBatch): string {
  const n = batch.pins.length;
  const head = `## Feedback visual (${n} ${n === 1 ? "anotação" : "anotações"})`;
  // `join("\n\n")` already puts a blank line between the parts — the extra "" member added a second
  // one, so every batch opened with a three-line gap under its own title.
  return [head, ...batch.pins.map((p, i) => renderPinMarkdown(p, i))].join("\n\n");
}

