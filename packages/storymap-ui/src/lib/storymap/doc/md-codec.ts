// 📄 md-codec — the CANONICAL markdown ⇄ DocModel codec. Markdown here is pure GFM (plus the
// two upgrade conventions below) — exactly what the agent reads/writes and what git diffs show.
//
// Upgrade rules (parse) / canonical forms (serialize):
//   section  ⇄ blockquote whose first line is ONLY a `**strong**` label  →  `> **Label**` + body
//   toggle   ⇄ `<details><summary>t</summary>` … `</details>` (the only HTML the codec understands)
//   todo     ⇄ GFM task-list items; quote ⇄ plain blockquote; divider ⇄ `---`; the rest is GFM.
//
// Two laws this file must never break (golden-tested in md-codec.test.ts):
//   1. IDEMPOTENCY  — serialize(parse(x)) is a fixed point: reserializing never changes bytes.
//   2. VERBATIM INLINE — untouched blocks keep their inline markdown byte-for-byte (block text is
//      the source SUBSTRING, not a re-print), so saving a doc the user didn't edit rewrites nothing.
//      Canonicalization only touches STRUCTURE markers (list bullets, `> ` prefixes, fences,
//      blank-line rhythm) — never the inline content inside a block.
//
// `properties` blocks never serialize into body markdown (they mirror structural fields owned by
// the entity). They only appear in the full-doc EXPORT (Copiar Markdown) as YAML frontmatter.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { dump as yamlDump } from "js-yaml";
import type {
  Content as MdNode,
  ListItem as MdListItem,
  Root as MdRoot,
  Table as MdTable,
} from "mdast";
import { blockIdFactory, type DocBlock, type DocModel, type PropEntry } from "./doc-model";

const parser = unified().use(remarkParse).use(remarkGfm);

export interface ParseDocMdOptions {
  /** Registry key stamped on the resulting model (default "generic"). */
  docType?: string;
  /** Title for the model — the codec never reads it from the body. */
  title?: string;
  /**
   * Read a LEADING `# Title` as the model's title instead of leaving it in `blocks` — the exact
   * inverse of `serializeDocMd({ includeTitle: true })`. Off by default: a card BODY that happens
   * to open with an `#` must keep it (the body is not a document with a title of its own). The
   * raw-markdown VIEW (DocMarkdown) turns it on, so editing the first line renames the doc.
   */
  stripTitle?: boolean;
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export function parseDocMd(md: string, opts: ParseDocMdOptions = {}): DocModel {
  const nextId = blockIdFactory();
  const root = parser.parse(md) as MdRoot;
  const blocks = transformNodes(root.children, md, 0, nextId);
  let title = opts.title ?? "";
  if (opts.stripTitle) {
    const first = blocks[0];
    if (first?.kind === "heading" && first.level === 1) {
      title = first.text.trim();
      blocks.shift();
    }
  }
  return { docType: opts.docType ?? "generic", title, blocks };
}

/**
 * Transform a run of sibling mdast nodes into DocBlocks.
 * `quoteDepth` = how many `> ` levels wrap these nodes in the source (blockquote children keep
 * absolute source positions, so verbatim extraction must strip that prefix from continuations).
 */
function transformNodes(
  nodes: MdNode[],
  md: string,
  quoteDepth: number,
  nextId: () => string,
): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    switch (node.type) {
      case "heading": {
        const level = Math.min(3, Math.max(1, node.depth)) as 1 | 2 | 3;
        blocks.push({ kind: "heading", id: nextId(), level, text: innerSpan(node, md, quoteDepth) });
        break;
      }
      case "paragraph": {
        const onlyImage =
          node.children.length === 1 && node.children[0].type === "image" ? node.children[0] : null;
        if (onlyImage) {
          blocks.push({
            kind: "image",
            id: nextId(),
            alt: onlyImage.alt ?? "",
            src: onlyImage.url,
          });
        } else {
          blocks.push({ kind: "paragraph", id: nextId(), text: nodeSpan(node, md, quoteDepth) });
        }
        break;
      }
      case "list": {
        for (const item of node.children) {
          blocks.push(listItemToBlock(item, node.ordered === true, md, quoteDepth, nextId));
        }
        break;
      }
      case "blockquote": {
        const section = asSection(node.children, md, quoteDepth + 1, nextId);
        if (section) {
          blocks.push({ kind: "section", id: nextId(), tone: "neutral", ...section });
        } else {
          const text = node.children
            .map((child) => nodeSpan(child, md, quoteDepth + 1))
            .join("\n\n");
          blocks.push({ kind: "quote", id: nextId(), text });
        }
        break;
      }
      case "code": {
        const info = (node.lang ?? "") + (node.meta ? ` ${node.meta}` : "");
        const [lang, ...labelParts] = info.split(/\s+/);
        blocks.push({
          kind: "code",
          id: nextId(),
          lang: lang ?? "",
          label: labelParts.length ? labelParts.join(" ") : undefined,
          text: node.value,
        });
        break;
      }
      case "table": {
        blocks.push(tableToBlock(node, md, quoteDepth, nextId));
        break;
      }
      case "thematicBreak": {
        blocks.push({ kind: "divider", id: nextId() });
        break;
      }
      case "html": {
        const toggle = tryCollectToggle(nodes, i, md, quoteDepth, nextId);
        if (toggle) {
          blocks.push(toggle.block);
          i = toggle.endIndex;
        } else {
          // Unknown raw HTML survives as an opaque paragraph (render path never injects raw HTML).
          blocks.push({ kind: "paragraph", id: nextId(), text: nodeSpan(node, md, quoteDepth) });
        }
        break;
      }
      default: {
        blocks.push({ kind: "paragraph", id: nextId(), text: nodeSpan(node, md, quoteDepth) });
        break;
      }
    }
  }
  return blocks;
}

function listItemToBlock(
  item: MdListItem,
  ordered: boolean,
  md: string,
  quoteDepth: number,
  nextId: () => string,
): DocBlock {
  const first = item.children[0];
  const last = item.children[item.children.length - 1];
  let text = "";
  if (first?.position && last?.position) {
    text = extractSpan(md, first.position.start.offset!, last.position.end.offset!, quoteDepth, {
      dedentTo: first.position.start.column - 1,
    });
  }
  if (typeof item.checked === "boolean") {
    // O MARCADOR sai do texto — e este `replace` não é paranoia, é um defeito MEDIDO.
    //
    // Quando o conteúdo de um item de tarefa começa com texto puro, o `position` do parágrafo já
    // começa DEPOIS do `[ ] ` e o span sai limpo. Quando começa com um nó inline — `**negrito**`,
    // `*itálico*`, `` `code` `` — ele começa no `[`, e o marcador entra no texto. Medido:
    //   `- [ ] texto`            → todo|texto            ✔
    //   `- [ ] **negrito** …`    → todo|[ ] **negrito** … ✘
    //
    // O estrago é silencioso e CUMULATIVO: a serialização acrescenta o marcador de novo, então cada
    // ciclo ler→gravar ganha mais um `[ ]`. Um teste de ponto fixo não o pega (o texto sujo volta
    // igual quando ninguém regrava). Foi assim que o PRD deste board saiu com `- [ ] [ ] …`.
    //
    // Num item de tarefa o marcador NUNCA é conteúdo: o estado tem campo próprio (`checked`).
    return { kind: "todo", id: nextId(), text: text.replace(/^\[[ xX]\]\s+/, ""), checked: item.checked };
  }
  return ordered
    ? { kind: "numbered", id: nextId(), text }
    : { kind: "bullet", id: nextId(), text };
}

/**
 * A blockquote is a section iff its FIRST LINE is only a `**strong**` label. Two source shapes
 * produce that: the label paragraph alone (blank `>` line after it), or — the common tight form
 * `> **Label**` + `> body` — ONE paragraph whose children are [strong, text starting with "\n"]
 * (markdown lazy continuation merges the lines).
 */
function asSection(
  children: MdNode[],
  md: string,
  quoteDepth: number,
  nextId: () => string,
): { label: string; body: DocBlock[] } | null {
  const first = children[0];
  if (!first || first.type !== "paragraph" || first.children[0]?.type !== "strong") return null;
  const strong = first.children[0];
  const label = innerSpan(strong, md, quoteDepth);

  if (first.children.length === 1) {
    return { label, body: transformNodes(children.slice(1), md, quoteDepth, nextId) };
  }

  const after = first.children[1];
  if (after.type !== "text" || !after.value.startsWith("\n")) return null; // same-line content → quote
  // Tight form: the rest of the merged paragraph (after the label line) is the first body block.
  const rest = extractSpan(
    md,
    strong.position!.end.offset!,
    first.position!.end.offset!,
    quoteDepth,
  ).replace(/^\n/, "");
  const body: DocBlock[] = [{ kind: "paragraph", id: nextId(), text: rest }];
  body.push(...transformNodes(children.slice(1), md, quoteDepth, nextId));
  return { label, body };
}

function tableToBlock(
  table: MdTable,
  md: string,
  quoteDepth: number,
  nextId: () => string,
): DocBlock {
  const toCells = (rowIndex: number): string[] =>
    table.children[rowIndex].children.map((cell) => innerSpan(cell, md, quoteDepth));
  const header = table.children.length ? toCells(0) : [];
  const rows = table.children.slice(1).map((_, i) => toCells(i + 1));
  return { kind: "table", id: nextId(), header, rows };
}

const DETAILS_OPEN = /^<details>\s*<summary>([\s\S]*?)<\/summary>\s*(<\/details>)?\s*$/;
const DETAILS_CLOSE = /^<\/details>\s*$/;

/**
 * `<details><summary>t</summary>` … `</details>` spanning sibling nodes → toggle block.
 * Returns null when the html node is not a well-formed toggle opener (falls back to opaque text).
 */
function tryCollectToggle(
  nodes: MdNode[],
  start: number,
  md: string,
  quoteDepth: number,
  nextId: () => string,
): { block: DocBlock; endIndex: number } | null {
  const opener = nodes[start];
  if (opener.type !== "html") return null;
  const match = DETAILS_OPEN.exec(opener.value.trim());
  if (!match) return null;
  const title = match[1].trim();
  if (match[2]) {
    // Self-contained `<details><summary>t</summary></details>` in a single node — empty toggle.
    return { block: { kind: "toggle", id: nextId(), title, children: [] }, endIndex: start };
  }
  for (let i = start + 1; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === "html" && DETAILS_CLOSE.test(node.value.trim())) {
      const children = transformNodes(nodes.slice(start + 1, i), md, quoteDepth, nextId);
      return { block: { kind: "toggle", id: nextId(), title, children }, endIndex: i };
    }
  }
  return null; // unclosed <details> → opaque paragraph
}

// --- verbatim span extraction ------------------------------------------------

/** Verbatim source of a whole node (outer span). */
function nodeSpan(node: MdNode, md: string, quoteDepth: number): string {
  if (!node.position) return "";
  return extractSpan(md, node.position.start.offset!, node.position.end.offset!, quoteDepth);
}

/** Verbatim source of a node's CHILDREN (inner span) — e.g. heading text without `## `. */
function innerSpan(
  node: { children: { position?: MdNode["position"] }[] },
  md: string,
  quoteDepth: number,
): string {
  const first = node.children[0];
  const last = node.children[node.children.length - 1];
  if (!first?.position || !last?.position) return "";
  return extractSpan(md, first.position.start.offset!, last.position.end.offset!, quoteDepth);
}

/**
 * Extract md[start,end) and normalize continuation lines: strip `quoteDepth` levels of `> ` and
 * optionally dedent to the content column (list items). First line needs no stripping — offsets
 * start at the content itself.
 */
function extractSpan(
  md: string,
  start: number,
  end: number,
  quoteDepth: number,
  opts: { dedentTo?: number } = {},
): string {
  const raw = md.slice(start, end);
  const lines = raw.split("\n");
  if (lines.length === 1) return raw;
  const quotePrefix = /^\s{0,3}(>\s?)/;
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      let out = line;
      for (let d = 0; d < quoteDepth; d++) out = out.replace(quotePrefix, "");
      if (opts.dedentTo && opts.dedentTo > 0) {
        out = out.startsWith(" ".repeat(opts.dedentTo))
          ? out.slice(opts.dedentTo)
          : out.replace(/^\s+/, "");
      }
      return out;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

export interface SerializeDocMdOptions {
  /**
   * Emit `properties` blocks as YAML frontmatter (full-doc EXPORT only — canonical body
   * serialization always skips them).
   */
  includeProperties?: boolean;
  /** Prepend the model title as `# Title` (EXPORT only). */
  includeTitle?: boolean;
}

export function serializeDocMd(model: DocModel, opts: SerializeDocMdOptions = {}): string {
  const chunks: string[] = [];
  if (opts.includeProperties) {
    const entries = model.blocks.filter(
      (b): b is Extract<DocBlock, { kind: "properties" }> => b.kind === "properties",
    );
    const props: Record<string, string> = {};
    for (const block of entries) {
      for (const entry of block.entries) props[entry.key] = propValueText(entry);
    }
    // A guarda é sobre as LINHAS, não sobre os blocos: um bloco de propriedades sem entradas fazia
    // `entries.length` valer 1 e o markdown saía com um frontmatter vazio (`---\n{}\n---`).
    if (Object.keys(props).length) chunks.push(`---\n${yamlDump(props).trimEnd()}\n---`);
  }
  if (opts.includeTitle && model.title) chunks.push(`# ${model.title}`);
  const body = serializeBlocks(model.blocks);
  if (body) chunks.push(body);
  const out = chunks.join("\n\n");
  return out ? `${out}\n` : "";
}

function propValueText(entry: PropEntry): string {
  const v = entry.value;
  if (v.kind === "chips") return v.chips.map((c) => c.text).join(", ");
  return v.text;
}

/** Serialize one block (the grip-menu "Copiar como Markdown"). */
export function serializeBlockMd(block: DocBlock): string {
  return serializeBlocks([block]);
}

const LIST_KINDS = new Set<DocBlock["kind"]>(["bullet", "numbered", "todo"]);

function serializeBlocks(blocks: DocBlock[]): string {
  const rendered = blocks.filter((b) => b.kind !== "properties");
  const parts: string[] = [];
  let i = 0;
  while (i < rendered.length) {
    const block = rendered[i];
    if (LIST_KINDS.has(block.kind)) {
      // Contiguous same-kind list blocks form ONE tight list (single newline between items).
      const group: DocBlock[] = [];
      while (i < rendered.length && rendered[i].kind === block.kind) group.push(rendered[i++]);
      let n = 0;
      parts.push(
        group
          .map((item) => {
            if (item.kind === "todo")
              return listLine(`- [${item.checked ? "x" : " "}] `, item.text);
            if (item.kind === "numbered") return listLine(`${++n}. `, item.text);
            return listLine("- ", (item as Extract<DocBlock, { kind: "bullet" }>).text);
          })
          .join("\n"),
      );
      continue;
    }
    parts.push(serializeSingle(block));
    i++;
  }
  return parts.join("\n\n");
}

/** Marker + text, with continuation lines indented to align under the content column. */
function listLine(marker: string, text: string): string {
  const indent = " ".repeat(marker.length);
  const lines = text.split("\n");
  return marker + lines.map((line, i) => (i === 0 ? line : indent + line)).join("\n");
}

function serializeSingle(block: DocBlock): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(block.level)} ${block.text}`;
    case "paragraph":
      return block.text;
    case "quote":
      return quotePrefix(block.text);
    case "section": {
      // Seção SEM rótulo = um parágrafo de abertura que a projeção marcou (o hero do canvas): sai
      // como o próprio corpo, sem citação. `> ****` não é markdown — e o rótulo é justamente o que
      // faz o parse reconhecer a seção, então uma seção anônima não tem forma canônica própria.
      const body = serializeBlocks(block.body);
      if (!block.label.trim()) return body;
      const label = `> **${block.label}**`;
      return body ? `${label}\n${quotePrefix(body)}` : label;
    }
    case "toggle": {
      const body = serializeBlocks(block.children);
      return body
        ? `<details><summary>${block.title}</summary>\n\n${body}\n\n</details>`
        : `<details><summary>${block.title}</summary></details>`;
    }
    case "code": {
      const fence = block.text.includes("```") ? "````" : "```";
      const info = block.label ? `${block.lang} ${block.label}` : block.lang;
      return `${fence}${info}\n${block.text}\n${fence}`;
    }
    case "table": {
      const header = `| ${block.header.join(" | ")} |`;
      const sep = `| ${block.header.map(() => "---").join(" | ")} |`;
      const rows = block.rows.map((row) => `| ${row.join(" | ")} |`);
      return [header, sep, ...rows].join("\n");
    }
    case "divider":
      return "---";
    case "image":
      return `![${block.alt}](${block.src})`;
    case "properties":
      return ""; // never serialized into the body (see module header)
    case "bullet":
      return listLine("- ", block.text);
    case "numbered":
      return listLine("1. ", block.text);
    case "todo":
      return listLine(`- [${block.checked ? "x" : " "}] `, block.text);
  }
}

/** Prefix every line with `> ` (`>` alone on blank lines) — the canonical quote/section body form. */
function quotePrefix(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}
