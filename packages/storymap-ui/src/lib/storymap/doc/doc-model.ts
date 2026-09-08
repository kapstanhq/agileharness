// 📄 DocModel — the pure intermediate representation (IR) of a "Notion-style" document.
//
// This IR is the SINGLE format the doc subsystem thinks in. Everything else is an adapter:
//   markdown  ⇄ DocModel   (md-codec.ts — the canonical GFM interchange the AGENT reads/writes)
//   BlockNote ⇄ DocModel   (components/doc/blocknote/adapter.ts — the editing surface, swappable)
//   entity SoT ⇄ DocModel  (doc-registry.ts projections — board.yaml/StyleGuideDoc/cards stay canonical)
//
// The IR is NEVER persisted. What lands on disk is always the entity's existing source of truth,
// written through its existing server action — so there is no Zod contract change and no new write
// path. `DocBlockSchema` below exists for tests and defensive validation only.
//
// Anchoring: blocks that mirror a structural field carry the field's identity in props
// (`binding` for named fields/sections, `itemId` for canvas items). Commit walks anchors — it never
// re-derives identity from text, so a rename is an UPDATE, not a delete+add.

import { z } from "zod";

/** Inline markdown (bold/em/`code`/links), kept VERBATIM from the source. Never HTML. */
export type InlineMd = string;

/** One key/value row of the properties block at the top of a doc. */
export interface PropEntry {
  key: string;
  label: string;
  /** lucide icon name (render-time lookup; unknown names fall back to a dot). */
  icon?: string;
  value: PropValue;
}
export type PropValue =
  | { kind: "text"; text: string }
  | { kind: "badge"; text: string }
  | { kind: "status"; text: string; color?: string }
  | { kind: "chips"; chips: { text: string; color?: string }[] };

export type DocBlock =
  | { kind: "heading"; id: string; level: 1 | 2 | 3; text: InlineMd; icon?: string; binding?: string }
  | { kind: "paragraph"; id: string; text: InlineMd }
  | { kind: "bullet"; id: string; text: InlineMd; dotColor?: string; itemId?: string }
  | { kind: "numbered"; id: string; text: InlineMd }
  | { kind: "todo"; id: string; text: InlineMd; checked: boolean; readOnlyCheck?: boolean }
  | { kind: "toggle"; id: string; title: InlineMd; children: DocBlock[] }
  | { kind: "quote"; id: string; text: InlineMd }
  | { kind: "code"; id: string; lang: string; label?: string; text: string }
  | { kind: "table"; id: string; header: InlineMd[]; rows: InlineMd[][] }
  | { kind: "divider"; id: string }
  | { kind: "image"; id: string; alt: string; src: string }
  | { kind: "properties"; id: string; entries: PropEntry[] }
  | {
      kind: "section";
      id: string;
      label: string;
      tone: "hero" | "neutral";
      body: DocBlock[];
      binding?: string;
    };

export type DocBlockKind = DocBlock["kind"];

export interface DocModel {
  /** Registry key (e.g. "card", "canvas") — "generic" when the doc is free markdown. */
  docType: string;
  /** Doc title (H1 of the surface). Lives OUTSIDE the block list so body md never carries it. */
  title: string;
  blocks: DocBlock[];
}

// ---------------------------------------------------------------------------
// Zod (tests + defensive validation only — the IR is never persisted)
// ---------------------------------------------------------------------------

const InlineMdSchema = z.string();

const PropValueSchema: z.ZodType<PropValue> = z.union([
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("badge"), text: z.string() }),
  z.object({ kind: z.literal("status"), text: z.string(), color: z.string().optional() }),
  z.object({
    kind: z.literal("chips"),
    chips: z.array(z.object({ text: z.string(), color: z.string().optional() })),
  }),
]);

const PropEntrySchema: z.ZodType<PropEntry> = z.object({
  key: z.string(),
  label: z.string(),
  icon: z.string().optional(),
  value: PropValueSchema,
});

export const DocBlockSchema: z.ZodType<DocBlock> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("heading"),
      id: z.string(),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      text: InlineMdSchema,
      icon: z.string().optional(),
      binding: z.string().optional(),
    }),
    z.object({ kind: z.literal("paragraph"), id: z.string(), text: InlineMdSchema }),
    z.object({
      kind: z.literal("bullet"),
      id: z.string(),
      text: InlineMdSchema,
      dotColor: z.string().optional(),
      itemId: z.string().optional(),
    }),
    z.object({ kind: z.literal("numbered"), id: z.string(), text: InlineMdSchema }),
    z.object({
      kind: z.literal("todo"),
      id: z.string(),
      text: InlineMdSchema,
      checked: z.boolean(),
      readOnlyCheck: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("toggle"),
      id: z.string(),
      title: InlineMdSchema,
      children: z.array(DocBlockSchema),
    }),
    z.object({ kind: z.literal("quote"), id: z.string(), text: InlineMdSchema }),
    z.object({
      kind: z.literal("code"),
      id: z.string(),
      lang: z.string(),
      label: z.string().optional(),
      text: z.string(),
    }),
    z.object({
      kind: z.literal("table"),
      id: z.string(),
      header: z.array(InlineMdSchema),
      rows: z.array(z.array(InlineMdSchema)),
    }),
    z.object({ kind: z.literal("divider"), id: z.string() }),
    z.object({ kind: z.literal("image"), id: z.string(), alt: z.string(), src: z.string() }),
    z.object({ kind: z.literal("properties"), id: z.string(), entries: z.array(PropEntrySchema) }),
    z.object({
      kind: z.literal("section"),
      id: z.string(),
      label: z.string(),
      tone: z.union([z.literal("hero"), z.literal("neutral")]),
      body: z.array(DocBlockSchema),
      binding: z.string().optional(),
    }),
  ]),
);

export const DocModelSchema: z.ZodType<DocModel> = z.object({
  docType: z.string(),
  title: z.string(),
  blocks: z.array(DocBlockSchema),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sequential block-id factory ("b1", "b2", …) — ids are UI identity, never persisted. */
export function blockIdFactory(): () => string {
  let n = 0;
  return () => `b${++n}`;
}

/** Depth-first walk over blocks (toggle children + section bodies included). */
export function walkBlocks(blocks: DocBlock[], visit: (block: DocBlock) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.kind === "toggle") walkBlocks(block.children, visit);
    if (block.kind === "section") walkBlocks(block.body, visit);
  }
}

/**
 * Content equality between two blocks, ignoring UI identity (`id`) — the primitive the
 * dirty-check and the no-op≡no-write invariant build on.
 */
export function sameBlockContent(a: DocBlock, b: DocBlock): boolean {
  return JSON.stringify(stripIds(a)) === JSON.stringify(stripIds(b));
}

export function sameDocContent(a: DocModel, b: DocModel): boolean {
  if (a.docType !== b.docType || a.title !== b.title) return false;
  if (a.blocks.length !== b.blocks.length) return false;
  return a.blocks.every((block, i) => sameBlockContent(block, b.blocks[i]));
}

/**
 * Re-attach `binding` metadata lost by an editing surface. BlockNote's DEFAULT heading spec has no
 * binding prop, so a bound heading comes back from the editor as a plain heading — without this
 * pass, commit() would treat its region as free content and fold it into the body (duplication).
 * Deterministic rule: an original bound heading re-anchors onto the edited heading with the SAME
 * level and text; sections keep their binding through the custom spec's props and need no help.
 * Renaming a bound heading in the editor therefore DETACHES the region — the entity commit's
 * label fallback (e.g. card-doc's ACCEPTANCE_LABEL) is the second net.
 */
export function reattachBindings(edited: DocBlock[], original: DocBlock[]): DocBlock[] {
  const boundHeadings = original.filter(
    (b): b is Extract<DocBlock, { kind: "heading" }> => b.kind === "heading" && !!b.binding,
  );
  if (!boundHeadings.length) return edited;
  return edited.map((block) => {
    if (block.kind !== "heading" || block.binding) return block;
    const match = boundHeadings.find((h) => h.level === block.level && h.text === block.text);
    return match ? { ...block, binding: match.binding, icon: match.icon ?? block.icon } : block;
  });
}

/**
 * Re-anchor the BOUND SECTIONS of a doc that came back from a surface which cannot carry props —
 * i.e. the raw-MARKDOWN view, where a section round-trips through `> **Label**` (binding lost) or,
 * more likely, where the author simply typed `## Label` because the section now READS as a heading
 * (DocRead renders it as one). Without this the region would silently detach and its text would be
 * folded into the free body — the same data-loss shape idea-doc's structural containment fixed.
 *
 * Deterministic, label-keyed, first-match-wins (a duplicated label stays free content):
 *   · a section WITHOUT binding whose label matches a bound one  → takes that binding + tone;
 *   · a HEADING whose text matches a bound section's label       → becomes that section, absorbing
 *     the contiguous run of blocks below it (up to the next heading/section — the same "run" rule
 *     the codec and card-doc already use).
 * Sections that still carry their binding (the rich editor's custom spec preserves props) pass
 * through untouched, so running this on that path is a no-op.
 */
export function reattachSections(edited: DocBlock[], original: DocBlock[]): DocBlock[] {
  const bound: Extract<DocBlock, { kind: "section" }>[] = [];
  walkBlocks(original, (block) => {
    if (block.kind === "section" && block.binding) bound.push(block);
  });
  if (!bound.length) return edited;

  const key = (s: string) => s.trim().toLowerCase();
  const byLabel = new Map(bound.map((section) => [key(section.label), section] as const));
  const used = new Set<string>();
  const out: DocBlock[] = [];

  for (let i = 0; i < edited.length; i++) {
    const block = edited[i];

    if (block.kind === "section" && !block.binding) {
      const spec = byLabel.get(key(block.label));
      if (spec && !used.has(spec.binding!)) {
        used.add(spec.binding!);
        out.push({ ...block, label: spec.label, tone: spec.tone, binding: spec.binding });
        continue;
      }
    }

    if (block.kind === "heading") {
      const spec = byLabel.get(key(block.text));
      if (spec && !used.has(spec.binding!)) {
        used.add(spec.binding!);
        const body: DocBlock[] = [];
        let j = i + 1;
        while (j < edited.length && edited[j].kind !== "heading" && edited[j].kind !== "section") {
          body.push(edited[j++]);
        }
        out.push({
          kind: "section",
          id: block.id,
          label: spec.label,
          tone: spec.tone,
          binding: spec.binding,
          body,
        });
        i = j - 1;
        continue;
      }
    }

    out.push(block);
  }
  return out;
}

function stripIds(block: DocBlock): unknown {
  const { id: _id, ...rest } = block;
  if (block.kind === "toggle") {
    return { ...rest, children: block.children.map(stripIds) };
  }
  if (block.kind === "section") {
    return { ...rest, body: block.body.map(stripIds) };
  }
  return rest;
}
