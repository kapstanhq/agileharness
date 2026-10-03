// adapter.ts — PURE bridge between BlockNote's own block tree and the doc subsystem's canonical
// DocModel IR (doc-model.ts). No React, no DOM: `docToBlockNote`/`blockNoteToDoc` are plain data
// transforms, exercised directly (no editor instance) by adapter.test.ts's round-trip suite.
//
// Inline text: the IR keeps markdown VERBATIM (doc-model.ts's `InlineMd`); BlockNote wants a styled
// run tree. `parseInlineMd`/`serializeInlineMd` below are a SMALL, deterministic subset parser — bold
// (**), italic (*), inline code (`), strikethrough (~~) and links ([text](href)) — matching exactly
// what md-codec.ts ever emits for these constructs (one style per run, never nested/combined; that
// combination is never produced by the canonical fixtures — see adapter.test.ts).
//
// Table header: our IR has exactly ONE header row (`header: InlineMd[]`); `docToBlockNote` always
// emits `headerRows: 1` and `blockNoteToDoc` always treats the table's FIRST row as the header,
// regardless of what `headerRows` BlockNote's own "Cabeçalho" toggle reports.
//
// Key order matters: `sameBlockContent`/`sameDocContent` (doc-model.ts) compare via `JSON.stringify`,
// which is insertion-order-sensitive. Each case below constructs its DocBlock with the SAME field
// order md-codec.ts's parser uses, so `blockNoteToDoc(docToBlockNote(model.blocks))` stays
// content-identical to `model.blocks` for every kind the two canonical fixtures exercise.

import type {
  DefaultInlineContentSchema,
  DefaultStyleSchema,
  InlineContent,
  PartialInlineContentElement,
  TableCell,
} from "@blocknote/core";
import type { DocBlock, PropEntry } from "@/lib/storymap/doc/doc-model";
import { docSchema, type DocBlockNoteBlock, type DocBlockNotePartialBlock } from "./schema";

type Inline = PartialInlineContentElement<DefaultInlineContentSchema, DefaultStyleSchema>;
type FullInline = InlineContent<DefaultInlineContentSchema, DefaultStyleSchema>;
type FullCell = FullInline[] | TableCell<DefaultInlineContentSchema, DefaultStyleSchema>;

// ── inline markdown ⇄ BlockNote styled runs ─────────────────────────────────────────────────────

const INLINE_RE = /\*\*([^*]+)\*\*|~~([^~]+)~~|`([^`]+)`|\[([^\]]*)\]\(([^)]*)\)|\*([^*]+)\*/g;

function plainRun(text: string): Inline {
  return { type: "text", text, styles: {} };
}

function parseInlineMd(md: string): Inline[] {
  const nodes: Inline[] = [];
  let lastIndex = 0;
  for (const match of md.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(plainRun(md.slice(lastIndex, index)));
    const [, bold, strike, code, linkText, linkHref, italic] = match;
    if (bold !== undefined) nodes.push({ type: "text", text: bold, styles: { bold: true } });
    else if (strike !== undefined) nodes.push({ type: "text", text: strike, styles: { strike: true } });
    else if (code !== undefined) nodes.push({ type: "text", text: code, styles: { code: true } });
    else if (linkText !== undefined)
      // `content` is the fully-expanded StyledText[] form (not the bare-string shorthand): the
      // round-trip test chains docToBlockNote → blockNoteToDoc directly with NO real editor in
      // between (adapter.test.ts is node-env, no DOM for ProseMirror) — so nothing ever normalizes
      // a shorthand string into it. serializeInlineNode below reads `content` as an array.
      nodes.push({ type: "link", href: linkHref ?? "", content: [{ type: "text", text: linkText, styles: {} }] });
    else if (italic !== undefined) nodes.push({ type: "text", text: italic, styles: { italic: true } });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < md.length) nodes.push(plainRun(md.slice(lastIndex)));
  return nodes.length ? nodes : [plainRun("")];
}

function serializeInlineMd(content: FullInline[]): string {
  return content.map(serializeInlineNode).join("");
}

function serializeInlineNode(node: FullInline): string {
  if (node.type === "link") {
    return `[${node.content.map((run) => run.text).join("")}](${node.href})`;
  }
  const text = node.text;
  if (node.styles.bold) return `**${text}**`;
  if (node.styles.code) return `\`${text}\``;
  if (node.styles.strike) return `~~${text}~~`;
  if (node.styles.italic) return `*${text}*`;
  return text;
}

function cellToInlineMd(cell: FullCell): string {
  const content = Array.isArray(cell) ? cell : cell.content;
  return serializeInlineMd(content);
}

// ── DocModel → BlockNote ────────────────────────────────────────────────────────────────────────

export function docToBlockNote(blocks: DocBlock[]): DocBlockNotePartialBlock[] {
  return blocks.map(docBlockToBlockNote);
}

function docBlockToBlockNote(block: DocBlock): DocBlockNotePartialBlock {
  switch (block.kind) {
    case "heading":
      return { type: "heading", props: { level: block.level }, content: parseInlineMd(block.text) };
    case "paragraph":
      return { type: "paragraph", content: parseInlineMd(block.text) };
    case "bullet":
      return { type: "bulletListItem", content: parseInlineMd(block.text) };
    case "numbered":
      return { type: "numberedListItem", content: parseInlineMd(block.text) };
    case "todo":
      return { type: "checkListItem", props: { checked: block.checked }, content: parseInlineMd(block.text) };
    case "toggle":
      return { type: "toggleListItem", content: parseInlineMd(block.title), children: docToBlockNote(block.children) };
    case "quote":
      return { type: "quote", content: parseInlineMd(block.text) };
    case "code": {
      const language = block.label ? `${block.lang} ${block.label}` : block.lang;
      // Fully-expanded form (see the link comment above) — not the bare-string shorthand.
      return { type: "codeBlock", props: { language }, content: [{ type: "text", text: block.text, styles: {} }] };
    }
    case "table":
      return {
        type: "table",
        content: {
          type: "tableContent",
          headerRows: 1,
          rows: [block.header, ...block.rows].map((row) => ({ cells: row.map(parseInlineMd) })),
        },
      };
    case "divider":
      return { type: "divider" };
    case "image":
      return { type: "image", props: { url: block.src, caption: block.alt } };
    case "properties":
      return { type: "docProperties", props: { entries: JSON.stringify(block.entries) } };
    case "section":
      return {
        type: "section",
        props: { label: block.label, tone: block.tone, binding: block.binding ?? "" },
        children: docToBlockNote(block.body),
      };
  }
}

// ── BlockNote → DocModel ────────────────────────────────────────────────────────────────────────

export function blockNoteToDoc(blocks: DocBlockNoteBlock[]): DocBlock[] {
  return blocks.map(blockNoteToDocBlock);
}

function clampHeadingLevel(level: number): 1 | 2 | 3 {
  if (level <= 1) return 1;
  if (level >= 3) return 3;
  return 2;
}

function parsePropEntries(raw: string): PropEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PropEntry[]) : [];
  } catch {
    return [];
  }
}

function blockNoteToDocBlock(block: DocBlockNoteBlock): DocBlock {
  switch (block.type) {
    case "heading":
      return {
        kind: "heading",
        id: block.id,
        level: clampHeadingLevel(block.props.level),
        text: serializeInlineMd(block.content),
      };
    case "paragraph":
      return { kind: "paragraph", id: block.id, text: serializeInlineMd(block.content) };
    case "bulletListItem":
      return { kind: "bullet", id: block.id, text: serializeInlineMd(block.content) };
    case "numberedListItem":
      return { kind: "numbered", id: block.id, text: serializeInlineMd(block.content) };
    case "checkListItem":
      return { kind: "todo", id: block.id, text: serializeInlineMd(block.content), checked: block.props.checked };
    case "toggleListItem":
      return {
        kind: "toggle",
        id: block.id,
        title: serializeInlineMd(block.content),
        children: blockNoteToDoc(block.children),
      };
    case "quote":
      return { kind: "quote", id: block.id, text: serializeInlineMd(block.content) };
    case "codeBlock": {
      const [lang, ...labelParts] = block.props.language.split(/\s+/);
      return {
        kind: "code",
        id: block.id,
        lang: lang ?? "",
        label: labelParts.length ? labelParts.join(" ") : undefined,
        text: block.content.map((run) => run.text).join(""),
      };
    }
    case "table": {
      const [header, ...rows] = block.content.rows.map((row) => row.cells.map((cell) => cellToInlineMd(cell)));
      return { kind: "table", id: block.id, header: header ?? [], rows };
    }
    case "divider":
      return { kind: "divider", id: block.id };
    case "image":
      return { kind: "image", id: block.id, alt: block.props.caption, src: block.props.url };
    case "docProperties":
      return { kind: "properties", id: block.id, entries: parsePropEntries(block.props.entries) };
    case "section":
      return {
        kind: "section",
        id: block.id,
        tone: block.props.tone,
        label: block.props.label,
        body: blockNoteToDoc(block.children),
        binding: block.props.binding || undefined,
      };
  }
}
