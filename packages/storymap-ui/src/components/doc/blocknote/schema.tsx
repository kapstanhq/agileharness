"use client";

// schema.tsx — the BlockNote schema for the doc EDITING surface (DocEditorImpl.tsx). Registers only
// the default block specs the doc subsystem actually uses (doc-model.ts's 13 DocBlockKinds minus
// `properties`/`section`, which have no BlockNote equivalent) plus the two structural custom blocks:
//
//   - `section`        a TITLED REGION whose BODY is nested block CHILDREN (not inline content) — the
//                       same choice DocRead.tsx's read-only renderer makes (`<BlockList blocks=…/>`),
//                       so a section can hold a whole sub-list/sub-heading, not just one run of text.
//                       O rótulo é um TÍTULO (a escala de `DOC.h1`, a mesma de um `##` ao redor), não
//                       mais uma etiqueta em caixa-alta dentro de uma caixa tingida: ver o cabeçalho do
//                       DocRead — texto puro é a regra, caixa é a exceção — e theme.css, onde as regras
//                       `:has()` que desenhavam a caixa foram removidas.
//   - `docProperties`   a READ-ONLY grid projection of PropEntry[] (never user-edited here — it mirrors
//                       a structural field owned by the entity, see doc-model.ts header). Visual
//                       language copied from DocRead's PropertiesBlockView/PropValueView.
//
// Rótulo BOUND é IMUTÁVEL aqui: numa seção ancorada (`binding` não vazio) o rótulo É a âncora — foi
// por ele que o commit reencontra a região (idea-doc/positioning-doc; ver reattachSections). Renomear
// no editor desligava a região em silêncio e o texto caía no corpo livre, então a seção ancorada
// mostra o título como texto e só a seção LIVRE tem campo editável.
//
// Icon-by-name: PropEntry.icon is "a lucide icon name; unknown names fall back to a dot" (doc-model.ts).
// `PropIcon`/`pascalCase` below duplicate DocRead.tsx's own lookup (neither file exports it — this
// package's convention is each renderer owns its copy) so `Calendar`/`calendar-days`/`calendar_days`
// all resolve the same way in both the read and edit surfaces.

import { useState } from "react";
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { icons, Sparkles, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { DOC } from "@/components/doc/typography";
import type { PropEntry, PropValue } from "@/lib/storymap/doc/doc-model";

/** Fired on the section block's own root DOM node (bubbles) when "Pedir ao agente" is clicked. */
export const DOC_SECTION_AGENT_EVENT = "doc-section-agent";

const SECTION_TONES = ["hero", "neutral"] as const;

// ── icon-by-name (docProperties labels) ─────────────────────────────────────────────────────────

function pascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function PropIcon({ name }: { name?: string }) {
  if (!name) return null;
  const Icon = (icons as Record<string, LucideIcon>)[pascalCase(name)];
  if (Icon) return <Icon className="h-3.5 w-3.5 shrink-0" />;
  return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg-subtle" />;
}

function PropValueView({ value }: { value: PropValue }) {
  switch (value.kind) {
    case "text":
      return <span className="text-[14px] text-fg">{value.text}</span>;
    case "badge":
      return (
        <span className="inline-flex w-fit items-center rounded bg-surface-hover px-1.5 py-0.5 text-[13px] text-fg-muted">
          {value.text}
        </span>
      );
    case "status":
      return (
        <span className="inline-flex items-center gap-1.5 text-[14px] text-fg">
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
    default:
      return null;
  }
}

// ── docProperties (custom, read-only) ───────────────────────────────────────────────────────────

function parsePropEntries(raw: string): PropEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PropEntry[]) : [];
  } catch {
    return [];
  }
}

const DocPropertiesBlock = createReactBlockSpec(
  {
    type: "docProperties",
    propSchema: {
      entries: { default: "[]" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const entries = parsePropEntries(block.props.entries);
      return (
        <div className="mb-4 w-full space-y-2 border-b border-line pb-4" contentEditable={false}>
          {entries.map((entry) => (
            <div key={entry.key} className="grid grid-cols-[132px_1fr] items-start gap-3">
              <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-[14px] text-fg-subtle">
                <PropIcon name={entry.icon} />
                <span className="truncate">{entry.label}</span>
              </div>
              <PropValueView value={entry.value} />
            </div>
          ))}
        </div>
      );
    },
  },
);

// ── section (custom, editable header + nested-block body) ──────────────────────────────────────

const SectionBlock = createReactBlockSpec(
  {
    type: "section",
    propSchema: {
      label: { default: "" },
      tone: { default: "neutral", values: SECTION_TONES },
      binding: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const { label, tone, binding } = block.props;
      // `render` É o componente: o BlockNote monta `createReactBlockSpec(...).render` como elemento React
      // (`<Render …/>`), então estes hooks obedecem as regras — o que a heurística do lint não enxerga é o
      // NOME, que a API da lib dita e não podemos escolher (ela exige a chave `render`). Desativação
      // pontual, na linha, em vez de desligar a regra no arquivo: qualquer OUTRO componente aqui
      // continua sob a regra.
      // eslint-disable-next-line react-hooks/rules-of-hooks -- `render` é montado como componente pelo BlockNote
      const [draft, setDraft] = useState(label);

      const commitLabel = () => {
        if (draft.trim() !== label) editor.updateBlock(block, { props: { label: draft.trim() } });
      };

      return (
        <div data-doc-section data-tone={tone === "hero" ? "hero" : "neutral"} className="group/section w-full">
          <div className="flex items-baseline justify-between gap-2">
            {binding || !editor.isEditable ? (
              // ANCORADA: o rótulo é a âncora do commit — texto, não campo (ver o cabeçalho).
              // `div`, NUNCA `p`/`h2`: o reset do BlockNote (`.bn-default-styles p,h1..h6,li
              // {font-size:inherit}`) vence uma utility do Tailwind por especificidade e achatava o
              // título da seção para o tamanho do corpo — o editor mostrava uma hierarquia que a
              // leitura não tinha.
              <div className={cn("min-w-0 flex-1 text-fg", DOC.h1)}>{label || "Seção"}</div>
            ) : (
              <input
                // `key` no rótulo: o commit só acontece no blur, então o valor externo só muda entre
                // edições — remontar ali mantém o campo em dia (undo/redo, edição do agente) sem
                // brigar com o que está sendo digitado.
                key={label}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitLabel}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitLabel();
                    e.currentTarget.blur();
                  }
                  if (e.key === "Escape") {
                    setDraft(label);
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Título da seção"
                className={cn(
                  "min-w-0 flex-1 border-none bg-transparent p-0 text-fg outline-none placeholder:text-fg-subtle",
                  DOC.h1,
                )}
              />
            )}

            {editor.isEditable && binding && (
              <div
                className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover/section:opacity-100 focus-within:opacity-100"
                contentEditable={false}
              >
                <button
                  type="button"
                  data-section-agent-btn
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.currentTarget
                      .closest("[data-doc-section]")
                      ?.dispatchEvent(
                        new CustomEvent(DOC_SECTION_AGENT_EVENT, { detail: { binding, label }, bubbles: true }),
                      );
                  }}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-fg-muted transition hover:bg-surface-hover hover:text-fg"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Pedir ao agente
                </button>
              </div>
            )}
          </div>
        </div>
      );
    },
  },
);

// ── schema ───────────────────────────────────────────────────────────────────────────────────────

export const docSchema = BlockNoteSchema.create({
  blockSpecs: {
    heading: defaultBlockSpecs.heading,
    paragraph: defaultBlockSpecs.paragraph,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
    toggleListItem: defaultBlockSpecs.toggleListItem,
    quote: defaultBlockSpecs.quote,
    codeBlock: defaultBlockSpecs.codeBlock,
    table: defaultBlockSpecs.table,
    divider: defaultBlockSpecs.divider,
    image: defaultBlockSpecs.image,
    section: SectionBlock(),
    docProperties: DocPropertiesBlock(),
  },
});

export type DocBlockNoteBlock = typeof docSchema.Block;
export type DocBlockNotePartialBlock = typeof docSchema.PartialBlock;
