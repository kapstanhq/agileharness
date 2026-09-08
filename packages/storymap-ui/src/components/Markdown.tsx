"use client";

// Markdown (F1) — the single rich-markdown renderer of the app. react-markdown + remark-gfm, with
// every element mapped to the board's SEMANTIC design tokens (no @tailwindcss/typography — its
// hard-coded prose colours would fight the CSS-variable theme in dark mode). SECURITY: no rehype-raw
// → raw HTML in LLM markdown is NOT rendered, so there is zero XSS surface (the only injection
// surface — the old wireframe iframe — went away in F2). Fenced ```ascii blocks render as a pan/zoom
// <AsciiFigure> (figures in the flow, not a gallery).
//
// TWO VARIANTS, one dialect. The renderer serves two very different places, and rendering both at
// ONE size is what made the card page read like a config dump instead of a document:
//
//   • `doc` (default) — READING surfaces: the card document, the plano, any long-form projection.
//     Its scale comes from components/doc/typography.ts — the SAME numbers <DocRead> uses — so prose
//     projected from a markdown string and blocks rendered from the DocModel IR sit in one column
//     with no visible seam.
//   • `compact` — DENSE surfaces: chat bubbles, feeds, tooltips. The old 13px scale, preserved
//     verbatim, because a 15.5px paragraph inside a chat bubble is not a document.
//
// A third scale is almost always the wrong move: stretch one of these two, and put the numbers in
// typography.ts — never inline at a call site.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import dynamic from "next/dynamic";
import { cn } from "@/lib/cn";
import { DOC } from "@/components/doc/typography";

// AsciiFigure pulls in react-zoom-pan-pinch (~16kB of pan/zoom) but only renders for the rare
// fenced ```ascii block. Load it LAZILY (next/dynamic, ssr:false — valid because this is a
// "use client" module) so that chunk is fetched only when an ascii block actually appears, instead
// of riding in the bundle of EVERY Markdown consumer (card body, HITL, DocRead).
const AsciiFigure = dynamic(() => import("./AsciiFigure").then((m) => m.AsciiFigure), { ssr: false });

export type MarkdownVariant = "doc" | "compact";

/** The per-variant class table — the ONLY place a size/spacing decision for markdown lives. */
interface MarkdownScale {
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  p: string;
  list: string;
  listMarker: string;
  li: string;
  quote: string;
  hr: string;
  tableWrap: string;
  table: string;
  th: string;
  td: string;
  codeInline: string;
  codeBlock: string;
  /** GFM task-list checkbox (read-only) */
  check: string;
  checkOn: string;
  checkOff: string;
  image: string;
}

const SCALES: Record<MarkdownVariant, MarkdownScale> = {
  doc: {
    h1: `mb-4 mt-0 ${DOC.title} text-fg`,
    // SEM `first:mt-0` (a compacta mantém): na superfície-documento um bloco de prosa raramente é o
    // primeiro — `## Notas de execução` e `## Priorização` são ilhas <Markdown> próprias depois do
    // canvas/bloqueios, e zerar o topo delas colava a seção na anterior. O `# título` já nasce mt-0.
    h2: `mb-2 mt-10 ${DOC.h1} text-fg`,
    h3: `mb-1.5 mt-8 ${DOC.h2} text-fg`,
    h4: `mb-1 mt-6 ${DOC.h3} text-fg`,
    p: `my-2 ${DOC.body} text-fg`,
    list: `my-2 space-y-1.5 ${DOC.body} text-fg`,
    listMarker: "marker:text-fg-subtle",
    li: "leading-[1.6]",
    // Um `>` aqui é quase sempre um CALLOUT de contexto com VÁRIOS blocos (o bloco estratégico do
    // card), não um pull-quote de uma linha — daí o poço + a escala própria (DOC.callout), e a escala
    // empurrada também para o <p> aninhado (senão só a primeira linha a pegava). É a ÚNICA caixa que
    // sobrou por desenho, e por isso NEUTRA (o filete âmbar fazia dela um destaque de sistema; ela é
    // um destaque do AUTOR). Mesma forma que <DocRead> dá ao bloco `quote` — um construto, um desenho.
    quote: [
      "my-4 rounded-r-md border-l-[3px] border-line-emphasis bg-inset/60 py-2.5 pl-4 pr-3",
      `${DOC.callout} text-fg-muted`,
      "[&_p]:my-1.5 [&_p]:text-[15px] [&_p]:leading-[1.6] [&_p]:text-fg-muted [&_strong]:text-fg-muted",
      // O poço tem padding próprio: a margem do primeiro/último filho viraria um vão duplo.
      "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      // Um heading DENTRO do callout é subordinado — não pode competir com as seções do documento
      // (30px). Um degrau abaixo em cada nível, com o respiro proporcional.
      "[&_h2]:mt-5 [&_h2]:text-[20px] [&_h3]:mt-4 [&_h3]:text-[17px] [&_h4]:mt-3 [&_h4]:text-[15px]",
    ].join(" "),
    hr: "my-8 border-line",
    tableWrap: "my-4 overflow-x-auto rounded-lg border border-line",
    table: "w-full border-collapse text-left",
    th: `border-b border-line px-3 py-2 ${DOC.tableHead} text-fg`,
    td: `border-b border-line-muted px-3 py-2 align-top ${DOC.tableCell} text-fg`,
    codeInline: "rounded bg-inset px-1.5 py-0.5 font-mono text-[14px] text-fg-muted",
    codeBlock: `my-4 max-h-96 overflow-auto rounded-lg border border-line bg-inset p-3 ${DOC.code} text-fg-muted`,
    check: "mt-[5px] h-[18px] w-[18px] rounded-[5px] text-[10px]",
    checkOn: "border-primary bg-primary text-primary-fg",
    checkOff: "border-line-emphasis text-transparent",
    image: "max-h-[28rem]",
  },
  compact: {
    h1: "mb-1 mt-0 text-[19px] font-semibold leading-snug text-fg",
    h2: "mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle first:mt-1",
    h3: "mb-1 mt-4 text-[13px] font-semibold text-fg",
    h4: "mb-1 mt-3 text-[12px] font-semibold text-fg-muted",
    p: "my-2 text-[13px] leading-relaxed text-fg",
    list: "my-2 space-y-1 text-[13px] text-fg",
    listMarker: "",
    li: "leading-snug",
    quote: "my-3 space-y-0.5 border-l-2 border-line pl-3 text-[12px] leading-relaxed text-fg-muted",
    hr: "my-4 border-line-muted",
    tableWrap: "my-3 overflow-x-auto",
    table: "w-full border-collapse text-left text-[12px] text-fg-muted",
    th: "border-b border-line px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle",
    td: "border-b border-line-muted/60 px-2 py-1 align-top",
    codeInline: "rounded bg-surface-hover px-1 py-0.5 font-mono text-[11.5px] text-fg-muted",
    codeBlock:
      "my-3 max-h-80 overflow-auto rounded-lg border border-line bg-inset p-3 font-mono text-[11px] leading-relaxed text-fg-muted",
    check: "mt-[3px] h-3.5 w-3.5 rounded-[4px] text-[9px]",
    checkOn: "border-emerald-500 bg-emerald-500 text-white",
    checkOff: "border-line text-transparent",
    image: "max-h-96",
  },
};

function buildComponents(s: MarkdownScale): Components {
  /** A fenced code block WITH a language that isn't `ascii` (mermaid source, json, …) — readable mono. */
  const CodeBlock = ({ children }: { children: React.ReactNode }) => (
    <pre className={cn("not-prose", s.codeBlock)}>
      <code>{children}</code>
    </pre>
  );

  return {
    // Unwrap <pre> so the `code` renderer owns block-level rendering (AsciiFigure / CodeBlock are
    // block elements — they must not sit inside a <pre>).
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      // react-markdown@9 dropped the `inline` prop, so we infer block-vs-inline from the raw child:
      // a FENCED block always carries a trailing "\n" (the fence), inline code never does. Keying off
      // the RAW (before stripping that newline) correctly classifies even a single-line no-lang fence
      // as a block, and never leaks the trailing newline into an inline pill.
      const raw = String(children ?? "");
      const text = raw.replace(/\n$/, "");
      const lang = /language-([\w-]+)/.exec(className || "")?.[1];
      const isBlock = lang != null || raw.includes("\n");
      if (lang === "ascii") return <AsciiFigure ascii={text} />;
      if (isBlock) return <CodeBlock>{text}</CodeBlock>;
      return <code className={s.codeInline}>{text}</code>;
    },
    h1: ({ children }) => <h1 className={s.h1}>{children}</h1>,
    h2: ({ children }) => <h2 className={s.h2}>{children}</h2>,
    h3: ({ children }) => <h3 className={s.h3}>{children}</h3>,
    h4: ({ children }) => <h4 className={s.h4}>{children}</h4>,
    p: ({ children }) => <p className={s.p}>{children}</p>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-accent underline transition hover:no-underline">
        {children}
      </a>
    ),
    strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="text-fg-subtle line-through">{children}</del>,
    ul: ({ children, className }) => (
      <ul className={cn(s.list, isTaskList(className) ? "list-none pl-1" : cn("list-disc pl-5", s.listMarker))}>
        {children}
      </ul>
    ),
    ol: ({ children }) => <ol className={cn(s.list, "list-decimal pl-5", s.listMarker)}>{children}</ol>,
    li: ({ children, className }) => (
      <li className={cn(s.li, isTaskItem(className) && "flex items-start gap-2.5")}>{children}</li>
    ),
    // GFM task-list checkbox (read-only — reflects qaPassed/done state baked into the markdown).
    input: ({ checked, type }) =>
      type === "checkbox" ? (
        <span
          aria-hidden
          className={cn(
            "inline-flex shrink-0 items-center justify-center border font-bold",
            s.check,
            checked ? s.checkOn : s.checkOff,
          )}
        >
          ✓
        </span>
      ) : null,
    blockquote: ({ children }) => <blockquote className={s.quote}>{children}</blockquote>,
    hr: () => <hr className={s.hr} />,
    table: ({ children }) => (
      <div className={s.tableWrap}>
        <table className={s.table}>{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-inset">{children}</thead>,
    th: ({ children }) => <th className={s.th}>{children}</th>,
    td: ({ children }) => <td className={s.td}>{children}</td>,
    // Images: INLINE only what OUR OWN origin serves (a root-relative path — e.g. the feedback
    // overlay's region screenshot at /api/feedback/shot). Everything else — an absolute or
    // protocol-relative URL in LLM-authored markdown — stays a LINK, exactly as before: rendering it
    // would auto-fetch a third-party pixel on every card view (a beacon), which is why this renderer
    // never emitted an <img> at all. The producer side is guarded too (isSafeScreenshotRef).
    img: ({ src, alt }) => {
      const str = typeof src === "string" ? src : "";
      if (str.startsWith("/") && !str.startsWith("//")) {
        return (
          <a href={str} target="_blank" rel="noreferrer" className="not-prose my-3 block">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, not next/image-optimizable */}
            <img src={str} alt={alt || "imagem"} className={cn("max-w-full rounded-lg border border-line", s.image)} />
          </a>
        );
      }
      return (
        <a href={str || undefined} target="_blank" rel="noreferrer" className="text-accent underline">
          🖼 {alt || "imagem"}
        </a>
      );
    },
  };
}

/** Built ONCE per variant (a fresh `components` object each render would remount every node). */
const COMPONENTS: Record<MarkdownVariant, Components> = {
  doc: buildComponents(SCALES.doc),
  compact: buildComponents(SCALES.compact),
};

function isTaskList(className?: string): boolean {
  return !!className && className.includes("contains-task-list");
}
function isTaskItem(className?: string): boolean {
  return !!className && className.includes("task-list-item");
}

/** Estável por módulo: um array novo a cada render faria o react-markdown reprocessar o pipeline à toa. */
const REMARK = [remarkGfm];

/**
 * Render a markdown string with the board's tokens. `not-prose` islands (AsciiFigure/CodeBlock)
 * opt out of inherited spacing.
 *
 * @param variant `doc` (default) for reading surfaces, `compact` for chat/feed density.
 */
export function Markdown({
  children,
  variant = "doc",
  className,
}: {
  children: string;
  variant?: MarkdownVariant;
  className?: string;
}) {
  return (
    <div className={cn("text-fg", className)}>
      <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS[variant] ?? COMPONENTS.doc}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
