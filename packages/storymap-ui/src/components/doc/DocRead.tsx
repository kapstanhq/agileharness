"use client";

// DocRead — the READ-ONLY renderer of the DocModel IR (doc-model.ts). A light client component,
// deliberately NOT an editor: it renders all 13 DocBlock kinds with the Notion-like visual language
// (see the package's design tokens in globals.css) using only semantic Tailwind classes — the only
// non-token colours are the ones DATA carries itself (a bullet's `dotColor`, a status/chip's `color`).
//
// ── TEXTO PURO É A REGRA; CAIXA É A EXCEÇÃO ──────────────────────────────────────────────────────
// Um `section` (o bloco ANCORADO de uma projeção — "A ideia", "Posicionamento", um bloco do canvas)
// renderiza como TÍTULO + conteúdo, não como caixa com etiqueta em caixa-alta. A caixa era a REGRA, e
// virava um documento de cinco painéis empilhados que ninguém lê como texto; a hierarquia agora é a
// do próprio documento (tamanho/peso/espaço — ver typography.ts). A ÚNICA caixa que restou é o
// `quote`/blockquote: um poço NEUTRO que o autor pede explicitamente com `>` — a exceção.
//
// O SCALE (tamanhos/entrelinhas) vive em ./typography.ts e é compartilhado com <Markdown variant="doc">,
// então uma página de card que mistura blocos do IR com prosa projetada de markdown não tem costura —
// inclusive no MAPA DE NÍVEL (level 1 → título, 2 → seção, 3 → subseção), que antes divergia entre as
// duas superfícies (o mesmo `## X` saía 26px por <Markdown> e 22px aqui).
//
// Inline markdown (bold/em/`code`/links) inside a block's text is delegated to the board's existing
// <Markdown> renderer (components/Markdown.tsx) rather than re-implemented here — ONE markdown dialect,
// one set of tokens. <Markdown> always wraps its output in a block-level `<div><p>…</p></div>` (even
// for a single inline line), which is the right shape for a paragraph block but wrong for text that
// must flow INSIDE a heading/list-item/table-cell. `InlineMd` neutralizes that shape with a `prose-adjust`
// wrapper: `[&>div]:contents` unwraps Markdown's own root div (its children lay out as if it weren't
// there) and `[&_p]:inline [&_p]:m-0` turns the inner <p> into an unmargined inline run, whose exact
// size/weight/colour the caller then sets via `[&_p]:…` utilities in `className` (CSS specificity of
// `.wrapper p` beats a bare `.text-[13px]` utility, so this reliably overrides Markdown's own defaults).
//
// List grouping: DocBlock has no concept of "this bullet belongs to that list" — like md-codec's own
// LIST_KINDS grouping on serialize, `BlockList` groups contiguous bullet/numbered/todo siblings into
// ONE <ul>/<ol> so numbered lists count correctly and adjacent items don't carry list-to-list margin.
// `DocReadBlock` (the public single-block export, for callers that render one block in isolation) wraps
// a lone list block in its own one-item list container instead.

import type { ReactNode } from "react";
import { Check, Image as ImageIcon, icons, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Markdown } from "@/components/Markdown";
import { DOC, DOC_INLINE } from "@/components/doc/typography";
import type { DocBlock, DocBlockKind, DocModel, PropEntry, PropValue } from "@/lib/storymap/doc/doc-model";

export interface DocReadProps {
  model: DocModel;
  className?: string;
}

export function DocRead({ model, className }: DocReadProps) {
  return (
    <div className={cn("text-fg", className)}>
      {model.title && <h1 className={cn("mb-8 text-fg", DOC.title)}>{model.title}</h1>}
      <BlockList blocks={model.blocks} />
    </div>
  );
}

// ── inline markdown ─────────────────────────────────────────────────────────────────────────────

function InlineMd({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("prose-adjust inline [&>div]:contents [&_p]:m-0 [&_p]:inline", className)}>
      <Markdown>{text}</Markdown>
    </span>
  );
}

// ── icon-by-name (headings + property labels) ───────────────────────────────────────────────────

/** kebab-case / snake_case / camelCase / PascalCase → PascalCase (the `icons` dict's key shape). */
function pascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function iconByName(name?: string): LucideIcon | null {
  if (!name) return null;
  return (icons as Record<string, LucideIcon>)[pascalCase(name)] ?? null;
}

// ── block list (grouping) ───────────────────────────────────────────────────────────────────────

const LIST_KINDS = new Set<DocBlockKind>(["bullet", "numbered", "todo"]);
type ListBlock = Extract<DocBlock, { kind: "bullet" | "numbered" | "todo" }>;

/** `lead`: este run abre o documento (corpo de um `section` hero) — parágrafo um degrau acima. */
function BlockList({ blocks, lead }: { blocks: DocBlock[]; lead?: boolean }) {
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (LIST_KINDS.has(block.kind)) {
      const kind = block.kind;
      const group: ListBlock[] = [];
      while (i < blocks.length && blocks[i].kind === kind) group.push(blocks[i++] as ListBlock);
      nodes.push(<ListGroup key={group[0].id} items={group} />);
      continue;
    }
    nodes.push(<DocReadBlock key={block.id} block={block} lead={lead} />);
    i++;
  }
  return <>{nodes}</>;
}

function ListGroup({ items }: { items: ListBlock[] }) {
  return (
    <ul className="my-2 space-y-1.5">
      {items.map((item, idx) => (
        <ListItemView key={item.id} block={item} index={idx + 1} />
      ))}
    </ul>
  );
}

function ListItemView({ block, index }: { block: ListBlock; index: number }) {
  if (block.kind === "bullet") {
    return (
      <li className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-[10px] h-[5px] w-[5px] shrink-0 rounded-full"
          style={{ backgroundColor: block.dotColor ?? "currentColor" }}
        />
        <InlineMd text={block.text} className={cn("flex-1", DOC_INLINE.body)} />
      </li>
    );
  }
  if (block.kind === "numbered") {
    return (
      <li className="flex items-start gap-2.5">
        <span className={cn("min-w-[1.4rem] shrink-0 text-fg-subtle tabular-nums", DOC.body)}>{index}.</span>
        <InlineMd text={block.text} className={cn("flex-1", DOC_INLINE.body)} />
      </li>
    );
  }
  // todo
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={cn(
          "mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border",
          block.checked ? "border-primary bg-primary text-primary-fg" : "border-line-emphasis",
        )}
      >
        {block.checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <InlineMd
        text={block.text}
        className={cn("flex-1", block.checked ? DOC_INLINE.bodyDone : DOC_INLINE.body)}
      />
    </li>
  );
}

// ── single-block renderer (public — reusable in isolation) ─────────────────────────────────────

export function DocReadBlock({ block, lead }: { block: DocBlock; lead?: boolean }): ReactNode {
  switch (block.kind) {
    case "bullet":
    case "numbered":
    case "todo":
      return <ListGroup items={[block]} />;
    case "heading":
      return <HeadingBlockView block={block} />;
    case "paragraph":
      return (
        <p className={lead ? "my-2.5" : "my-2"}>
          <InlineMd text={block.text} className={lead ? DOC_INLINE.lead : DOC_INLINE.body} />
        </p>
      );
    case "toggle":
      return <ToggleBlockView block={block} />;
    case "quote":
      // A EXCEÇÃO: o único container do documento, e só porque o autor escreveu `>`. Poço NEUTRO
      // (sem cor de acento) e com a mesma forma que <Markdown> dá a um blockquote — dois desenhos do
      // mesmo construto markdown na mesma coluna era parte do ruído.
      return (
        <div className="my-4 rounded-r-md border-l-[3px] border-line-emphasis bg-inset/60 py-2.5 pl-4 pr-3">
          <InlineMd text={block.text} className={DOC_INLINE.quote} />
        </div>
      );
    case "code":
      return <CodeBlockView block={block} />;
    case "table":
      return <TableBlockView block={block} />;
    case "divider":
      return <hr className="my-8 border-line" />;
    case "image":
      return (
        <div className="my-3 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-center">
          <ImageIcon className="h-6 w-6 text-fg-subtle" />
          <span className="max-w-full truncate font-mono text-[11px] text-fg-subtle">
            {block.alt || block.src}
          </span>
        </div>
      );
    case "properties":
      return <PropertiesBlockView block={block} />;
    case "section":
      return <SectionBlockView block={block} />;
  }
}

// ── heading ──────────────────────────────────────────────────────────────────────────────────────

/**
 * NÍVEL → DEGRAU, a mesma tabela de <Markdown variant="doc"> (typography.ts): level 1 é título de
 * documento, 2 é seção, 3 é subseção. O ícone (quando a projeção manda um) fica DISCRETO — decoração
 * não pode competir com a palavra que titula a seção.
 */
function HeadingBlockView({ block }: { block: Extract<DocBlock, { kind: "heading" }> }) {
  const Icon = iconByName(block.icon);
  if (block.level === 1) {
    return (
      <h1 className={cn("mb-3 mt-12 flex items-center gap-2.5 text-fg first:mt-0", DOC.title)}>
        {Icon && <Icon className="h-7 w-7 shrink-0 text-fg-subtle" />}
        <InlineMd text={block.text} className={DOC_INLINE.title} />
      </h1>
    );
  }
  if (block.level === 2) {
    return (
      <h2 className={cn("mb-2 mt-10 flex items-center gap-2 text-fg first:mt-0", DOC.h1)}>
        {Icon && <Icon className="h-5 w-5 shrink-0 text-fg-subtle" />}
        <InlineMd text={block.text} className={DOC_INLINE.h1} />
      </h2>
    );
  }
  return (
    <h3 className={cn("mb-1.5 mt-8 flex items-center gap-2 text-fg first:mt-0", DOC.h2)}>
      {Icon && <Icon className="h-[18px] w-[18px] shrink-0 text-fg-subtle" />}
      <InlineMd text={block.text} className={DOC_INLINE.h2} />
    </h3>
  );
}

// ── toggle ───────────────────────────────────────────────────────────────────────────────────────

function ToggleBlockView({ block }: { block: Extract<DocBlock, { kind: "toggle" }> }) {
  return (
    <details className="group/toggle my-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-[16px] font-medium text-fg [&::-webkit-details-marker]:hidden">
        <ChevronGlyph />
        <InlineMd text={block.title} className={DOC_INLINE.toggle} />
      </summary>
      <div className="mt-1 border-l border-line pl-5">
        <BlockList blocks={block.children} />
      </div>
    </details>
  );
}

function ChevronGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open/toggle:rotate-90"
    >
      <path d="M6 3.5 10 8l-4 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── code ─────────────────────────────────────────────────────────────────────────────────────────

function CodeBlockView({ block }: { block: Extract<DocBlock, { kind: "code" }> }) {
  return (
    <div className="my-4 overflow-hidden rounded-lg border border-line">
      {(block.label || block.lang) && (
        <div className="flex items-center justify-between gap-2 border-b border-line bg-inset px-3 py-1.5">
          <span className="truncate font-mono text-[11px] text-fg-subtle">{block.label || block.lang}</span>
          {block.label && block.lang && (
            <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{block.lang}</span>
          )}
        </div>
      )}
      <pre className="overflow-x-auto bg-inset p-3">
        <code className={cn(DOC.code, "text-fg-muted")}>{block.text}</code>
      </pre>
    </div>
  );
}

// ── table ────────────────────────────────────────────────────────────────────────────────────────

function TableBlockView({ block }: { block: Extract<DocBlock, { kind: "table" }> }) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-full border-collapse text-left">
        <thead className="bg-inset">
          <tr>
            {block.header.map((cell, i) => (
              <th key={i} className="border-b border-line px-3 py-2">
                <InlineMd text={cell} className={DOC_INLINE.tableHead} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="border-b border-line-muted px-3 py-2 align-top">
                  <InlineMd text={cell} className={DOC_INLINE.tableCell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── properties ───────────────────────────────────────────────────────────────────────────────────

/** As propriedades da página (espelho read-only de campos da entidade) — linhas discretas sob o
 *  título, fechadas por um divisor. É o cabeçalho de uma página do Notion, não um painel. */
function PropertiesBlockView({ block }: { block: Extract<DocBlock, { kind: "properties" }> }) {
  return (
    <div className="mb-8 space-y-2 border-b border-line pb-6">
      {block.entries.map((entry) => (
        <PropEntryRow key={entry.key} entry={entry} />
      ))}
    </div>
  );
}

function PropEntryRow({ entry }: { entry: PropEntry }) {
  const Icon = iconByName(entry.icon);
  return (
    <div className="grid grid-cols-[132px_1fr] items-start gap-3">
      <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-[14px] text-fg-subtle">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{entry.label}</span>
      </div>
      <PropValueView value={entry.value} />
    </div>
  );
}

function PropValueView({ value }: { value: PropValue }) {
  switch (value.kind) {
    case "text":
      return <span className="py-0.5 text-[14px] text-fg">{value.text}</span>;
    case "badge":
      return (
        <span className="inline-flex w-fit items-center rounded bg-surface-hover px-1.5 py-0.5 text-[13px] text-fg-muted">
          {value.text}
        </span>
      );
    case "status":
      return (
        <span className="inline-flex items-center gap-1.5 py-0.5 text-[14px] text-fg">
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: value.color ?? "rgb(var(--fg-subtle))" }}
          />
          {value.text}
        </span>
      );
    case "chips":
      return (
        <div className="flex flex-wrap gap-1">
          {value.chips.map((chip, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded bg-surface-hover px-1.5 py-0.5 text-[13px] text-fg-muted"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: chip.color ?? "rgb(var(--fg-subtle))" }}
              />
              {chip.text}
            </span>
          ))}
        </div>
      );
  }
}

// ── section ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Uma REGIÃO ANCORADA do documento — antes uma caixa com etiqueta em caixa-alta, agora o que ela
 * sempre foi semanticamente: uma SEÇÃO. O rótulo vira um `<h2>` no mesmo degrau de um `##` da prosa
 * ao redor (então a trilha do DocOutline o lista junto com os demais), e o corpo é texto corrido.
 * `tone: "hero"` NÃO pinta nada: marca a abertura do documento, cujo parágrafo ganha um degrau de
 * tamanho (DOC.lead) — hierarquia por tipografia, não por cor.
 */
function SectionBlockView({ block }: { block: Extract<DocBlock, { kind: "section" }> }) {
  const hero = block.tone === "hero";
  return (
    <section className="mt-10 first:mt-0">
      {block.label && <h2 className={cn("mb-2 text-fg", DOC.h1)}>{block.label}</h2>}
      <BlockList blocks={block.body} lead={hero} />
    </section>
  );
}
