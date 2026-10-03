"use client";

// 🪟 QUADRO — as seções de um documento como cartões, os itens como notas.
//
// A view não conhece nenhuma entidade: ela recebe um {@link SchemaDoc} e o schema dele, e desenha o
// que encontra. O Lean Canvas cai aqui por ter seções que carregam itens, não porque esta view
// saiba o que é um canvas — troque o schema e o mesmo componente desenha outra coisa.
//
// Três coisas que o modelo dá de graça, e que antes eram CAMPOS mantidos à mão:
//   · o NÚMERO de preenchimento é a POSIÇÃO da seção no schema (era `order:`);
//   · os GRUPOS emergem dos `###` autorais do próprio conteúdo (era `item.group`);
//   · o arranjo vem do layout — e a AUSÊNCIA dele é caminho normal, não caso degradado
//     (`boardLayoutFor` → null ⇒ grade automática).
//
// Editar aqui escreve no MESMO documento que a fonte markdown e o editor rico escrevem, pelas
// mutações puras do codec. Nenhuma view tem caminho de escrita próprio — é o que impede a segunda
// gramática (e a segunda é sempre a que diverge).

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardSurface } from "@/lib/ui";
import type { DocSchema, SectionRule } from "@/lib/storymap/doc/doc-schema";
import {
  appendSectionItem,
  removeSectionItem,
  sectionItems,
  updateSectionItem,
  type SchemaDoc,
  type SchemaItem,
} from "@/lib/storymap/doc/schema-codec";
import { AUTO_BOARD_CONTAINER, boardLayoutFor } from "./board-layouts";
import { docTags, splitItemText, type DocTag } from "./item-text";

export interface BoardViewProps {
  doc: SchemaDoc;
  schema: DocSchema;
  /** Ausente ⇒ o quadro é só leitura (a superfície não tem caminho de volta). */
  onChange?: (next: SchemaDoc) => void;
  className?: string;
}

interface Cursor {
  sectionKey: string;
  index: number;
}

export function BoardView({ doc, schema, onChange, className }: BoardViewProps) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const layout = boardLayoutFor(schema.docType);
  const tags = docTags(doc.frontmatter);
  const tops = schema.sections.filter((s) => s.level === 2);
  const editable = !!onChange;

  const addItem = (key: string) => {
    if (!onChange) return;
    const next = appendSectionItem(doc, key, { text: "", group: null }, schema);
    onChange(next);
    setCursor({ sectionKey: key, index: sectionItems(next, key).length - 1 });
  };

  const saveItem = (key: string, index: number, text: string) => {
    if (!onChange) return;
    const trimmed = text.trim();
    onChange(
      trimmed
        ? updateSectionItem(doc, key, index, { text: trimmed }, schema)
        : removeSectionItem(doc, key, index, schema),
    );
    setCursor(null);
  };

  return (
    <div className={cn("grid gap-3", layout?.container ?? AUTO_BOARD_CONTAINER, className)}>
      {tops.map((rule, i) => (
        <BoardSection
          key={rule.key}
          rule={rule}
          order={i + 1}
          doc={doc}
          schema={schema}
          tags={tags}
          cell={layout?.cells[rule.key]}
          compact={layout?.compact?.includes(rule.key) ?? false}
          cursor={cursor}
          editable={editable}
          onOpen={(index) => editable && setCursor({ sectionKey: rule.key, index })}
          onCancel={() => setCursor(null)}
          onSave={(index, text) => saveItem(rule.key, index, text)}
          onDelete={(index) => {
            if (!onChange) return;
            onChange(removeSectionItem(doc, rule.key, index, schema));
            setCursor(null);
          }}
          onAdd={addItem}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface SectionProps {
  rule: SectionRule;
  /** a posição da seção no schema — o "por onde começar" que o método ensina. */
  order: number;
  doc: SchemaDoc;
  schema: DocSchema;
  tags: DocTag[];
  cell?: string;
  compact: boolean;
  cursor: Cursor | null;
  editable: boolean;
  onOpen: (index: number) => void;
  onCancel: () => void;
  onSave: (index: number, text: string) => void;
  onDelete: (index: number) => void;
  onAdd: (key: string) => void;
}

function BoardSection({
  rule,
  order,
  doc,
  schema,
  tags,
  cell,
  compact,
  cursor,
  editable,
  onOpen,
  onCancel,
  onSave,
  onDelete,
  onAdd,
}: SectionProps) {
  const items = sectionItems(doc, rule.key);
  const children = schema.sections.filter((s) => s.parent === rule.key);
  const groups = groupsOf(items);

  return (
    <section className={cn(cardSurface, "flex flex-col gap-2.5 p-3.5", cell)} aria-label={rule.label}>
      <header className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-semibold",
            order === 1 ? "bg-fg text-canvas" : "bg-fg/[0.05] text-fg-subtle",
          )}
          title={`Ordem de preenchimento: ${order}`}
        >
          {order}
        </span>
        {/* O rótulo é TRAVADO: um `<h2>`, nunca um campo. Quem edita, edita o conteúdo. */}
        <h2 className="text-[11px] font-bold uppercase leading-none tracking-[0.07em] text-fg-muted">
          {rule.label}
        </h2>
        <span className="flex-1" />
        {editable && <AddButton onClick={() => onAdd(rule.key)} label={`Adicionar em ${rule.label}`} />}
      </header>

      {items.length === 0 ? (
        <EmptyState hint={rule.hint} editable={editable} onClick={() => onAdd(rule.key)} />
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group) => {
            const inGroup = items
              .map((item, index) => ({ item, index }))
              .filter(({ item }) => (item.group?.trim() || null) === group);
            if (!inGroup.length) return null;
            return (
              <div key={group ?? "__sem-grupo"} className="flex flex-col gap-2">
                {group && (
                  <div className="flex items-center gap-2 pt-0.5">
                    <span className="text-[9.5px] font-bold uppercase leading-none tracking-[0.08em] text-fg-subtle">
                      {group}
                    </span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
                {inGroup.map(({ item, index }) => (
                  <Note
                    key={`${rule.key}-${index}`}
                    item={item}
                    tags={tags}
                    compact={compact}
                    editable={editable}
                    editing={cursor?.sectionKey === rule.key && cursor.index === index}
                    onOpen={() => onOpen(index)}
                    onCancel={onCancel}
                    onSave={(text) => onSave(index, text)}
                    onDelete={() => onDelete(index)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {children.length > 0 && <span className="flex-1" />}
      {children.map((child) => (
        <NestedSection
          key={child.key}
          rule={child}
          doc={doc}
          tags={tags}
          editable={editable}
          onAdd={() => onAdd(child.key)}
        />
      ))}
    </section>
  );
}

/** Uma seção ANINHADA refina a mãe — então se lê como o rodapé tracejado que é, nunca como irmã. */
function NestedSection({
  rule,
  doc,
  tags,
  editable,
  onAdd,
}: {
  rule: SectionRule;
  doc: SchemaDoc;
  tags: DocTag[];
  editable: boolean;
  onAdd: () => void;
}) {
  const items = sectionItems(doc, rule.key);
  return (
    <div className="mt-auto rounded-[9px] border border-dashed border-line-emphasis/70 bg-inset/60 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[9.5px] font-bold uppercase leading-none tracking-[0.06em] text-fg-subtle">
          {rule.label}
        </span>
        <span className="flex-1" />
        {editable && <AddButton onClick={onAdd} label={`Adicionar em ${rule.label}`} />}
      </div>
      {items.length === 0 ? (
        <p className="text-[12px] leading-[1.45] text-fg-muted">{rule.hint}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((item, i) => {
            const split = splitItemText(item.text, tags);
            return (
              // CONTEÚDO AUTORAL usa `fg-muted`, nunca `fg-subtle`: o subtle é o degrau DECORATIVO
              // (ícone, placeholder, separador). Pintar com ele o que a pessoa escreveu fazia a
              // subseção parecer desabilitada ao lado da nota da seção-mãe — a diferença de
              // hierarquia já vem do tamanho (13→12px) e da borda tracejada.
              <p key={i} className="text-[12px] leading-[1.45] text-fg-muted">
                {split.tags.map((t) => (
                  <Dot key={t.id} color={t.color} />
                ))}
                {split.text}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Note({
  item,
  tags,
  compact,
  editable,
  editing,
  onOpen,
  onCancel,
  onSave,
  onDelete,
}: {
  item: SchemaItem;
  tags: DocTag[];
  compact: boolean;
  editable: boolean;
  editing: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(item.text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(item.text);
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing, item.text]);

  if (editing) {
    return (
      <div className="rounded-[9px] border border-accent/50 bg-surface p-2 shadow-sm">
        <textarea
          ref={ref}
          value={draft}
          rows={compact ? 2 : 3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter grava (a nota é UMA ideia — quebra de linha aqui quase sempre é engano);
            // Shift+Enter continua sendo quebra de verdade, para quem realmente precisa.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSave(draft);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => onSave(draft)}
          placeholder="Uma ideia por nota…"
          className="w-full resize-none bg-transparent text-[13px] leading-[1.5] text-fg outline-none placeholder:text-fg-subtle"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10.5px] text-fg-subtle">Enter grava · Esc cancela</span>
          <button
            type="button"
            // `onMouseDown` e não `onClick`: o blur do textarea dispara antes do click e já teria
            // gravado — o botão de apagar viraria "gravar e depois apagar", que pisca na tela.
            onMouseDown={(e) => {
              e.preventDefault();
              onDelete();
            }}
            title="Remover"
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  const split = splitItemText(item.text, tags);
  const body = (
    <>
      {split.tags.map((t) => (
        <Dot key={t.id} color={t.color} />
      ))}
      {split.text || <span className="text-fg-subtle">(vazio)</span>}
    </>
  );

  if (compact) {
    return (
      <button
        type="button"
        disabled={!editable}
        onClick={onOpen}
        className={cn(
          "rounded text-left text-[12.5px] leading-[1.45] text-fg-muted transition",
          editable && "hover:text-fg",
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={!editable}
      onClick={onOpen}
      className={cn(
        "rounded-[9px] border border-line bg-inset/40 px-3 py-2 text-left text-[13px] leading-[1.5] text-fg transition",
        editable && "hover:border-accent/40 hover:bg-inset",
      )}
    >
      {body}
    </button>
  );
}

function Dot({ color }: { color?: string }) {
  return (
    <span
      className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-[1px]"
      style={{ backgroundColor: color ?? "var(--fg-subtle)" }}
    />
  );
}

function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

function EmptyState({ hint, editable, onClick }: { hint: string; editable: boolean; onClick: () => void }) {
  // Sem o `/80`: opacidade solta não é degrau declarado do sistema (a rampa é fg → muted → subtle), e
  // aqui ela caía sobre o RÓTULO DE UM BOTÃO — no modo editável este texto é o alvo clicável que cria
  // o primeiro item. Um rótulo de botão a 2.23:1 é inalcançável para quem não enxerga bem.
  const className =
    "rounded-[9px] border border-dashed border-line-emphasis/70 px-3 py-2.5 text-left text-[12px] leading-[1.45] text-fg-muted";
  if (!editable) return <p className={className}>{hint}</p>;
  return (
    <button type="button" onClick={onClick} className={cn(className, "transition hover:border-accent/50 hover:text-fg")}>
      {hint}
    </button>
  );
}

/** Os grupos na ordem de aparição; `null` (sem grupo) primeiro, que é onde o autor os vê. */
function groupsOf(items: readonly SchemaItem[]): Array<string | null> {
  const out: Array<string | null> = [];
  let sawUngrouped = false;
  for (const item of items) {
    const g = item.group?.trim() || null;
    if (g === null) {
      if (!sawUngrouped) {
        sawUngrouped = true;
        out.push(null);
      }
      continue;
    }
    if (!out.includes(g)) out.push(g);
  }
  return out;
}
