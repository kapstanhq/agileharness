"use client";

// <EntityRow> — a PRIMITIVA de casca reutilizável de uma entidade do board (ideia / story /
// item). Orientada a apresentação e CONTROLADA: zero server action, zero router.refresh, zero
// useSortable/@dnd-kit ou useRunSubstate (ao contrário de KanbanCard/StoryCard) — por isso é segura
// fora de um DndContext/Provider e reutilizável na modal de captura, na bancada e onde mais precisar.
// O container injeta TUDO (estado de seleção, slots de meta/chips, descritores de ação + onRun).
//
// Dois layouts: `variant="row"` (linha compacta de lista, estilo Notion) e `variant="card"` (bloco
// emoldurado com CTA — usado no HUB da captura). O checkbox de seleção reusa o <TriCheckbox>
// compartilhado, garantindo identidade visual com a árvore de proposta.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { TriCheckbox, type TriState } from "@/components/TriCheckbox";

export interface EntityRowAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  tone?: "primary" | "ghost" | "danger";
  onRun: () => void;
  disabled?: boolean;
}

export function EntityRow({
  variant = "row",
  tone = "neutral",
  typeLabel,
  title,
  selectable = false,
  checkState = "off",
  selectionActive = false,
  onToggleSelect,
  leadingMeta,
  meta,
  chips,
  hint,
  actions = [],
  busyActionId = null,
  trailing,
  onOpen,
  children,
}: {
  variant?: "row" | "card";
  /** "idea" tinge a casca com accent (mesmo tratamento do ProposalRow de ideia). */
  tone?: "neutral" | "idea";
  /** rótulo de tipo (card variant): "Ideia", "User story"… */
  typeLabel?: string;
  title: string;
  selectable?: boolean;
  checkState?: TriState;
  /** quando há ≥1 selecionado na lista, mantém os checkboxes visíveis (modo seleção). */
  selectionActive?: boolean;
  onToggleSelect?: () => void;
  /** slot à ESQUERDA do título (row variant) — ex.: a recência "DD/MM HH:MM". */
  leadingMeta?: ReactNode;
  /** slot de metadados — à direita (row) ou abaixo do título (card). */
  meta?: ReactNode;
  /** chips pequenos (soluções/aborda) sob o título (card variant). */
  chips?: ReactNode;
  /** texto de orientação acima das ações (card variant). */
  hint?: ReactNode;
  actions?: EntityRowAction[];
  /** id da ação cujo botão deve mostrar spinner (as demais apenas desabilitam). */
  busyActionId?: string | null;
  /** afford. extra à direita (row variant) — ex.: o excluir inline de 2-toques. */
  trailing?: ReactNode;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  if (variant === "card") {
    return (
      <div
        className={cn(
          "space-y-2.5 rounded-xl border p-4",
          tone === "idea" ? "border-accent/30 bg-accent/5" : "border-line bg-inset",
        )}
      >
        <div className="flex items-start gap-2.5">
          {selectable && (
            <TriCheckbox
              state={checkState}
              onChange={() => onToggleSelect?.()}
              className="mt-1"
              label={`Selecionar ${title}`}
            />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            {typeLabel && (
              <span
                className={cn(
                  "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  tone === "idea" ? "bg-accent/10 text-accent" : "bg-surface text-fg-subtle",
                )}
              >
                {typeLabel}
              </span>
            )}
            <p className="text-[14px] font-medium leading-snug text-fg">{title}</p>
            {chips}
            {meta}
          </div>
        </div>
        {children}
        {(hint || actions.length > 0) && (
          <div className={cn("space-y-2 border-t pt-2.5", tone === "idea" ? "border-accent/20" : "border-line")}>
            {hint && <p className="text-[12px] leading-snug text-fg-muted">{hint}</p>}
            {actions.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                {actions.map((a) => (
                  <ActionButton key={a.id} action={a} busy={busyActionId === a.id} variant="card" />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // row variant
  return (
    <div className="group relative flex items-stretch">
      {selectable && (
        <span
          className={cn(
            "flex items-center pl-3 transition",
            // em telas de toque (sem hover) o checkbox fica sempre visível para iniciar a seleção.
            checkState !== "off" || selectionActive
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          <TriCheckbox state={checkState} onChange={() => onToggleSelect?.()} label={`Selecionar ${title}`} />
        </span>
      )}
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
      >
        {leadingMeta}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{title}</span>
        {meta}
      </button>
      <div className="flex shrink-0 items-center gap-1 pr-3">
        {actions.length > 0 && (
          // No mobile (< sm) as ações ficam OCULTAS (não ocupam largura → o título não é espremido); a
          // ação avulsa fica acessível abrindo o detalhe. Em sm+ aparecem no hover/foco da linha.
          <span className="hidden items-center gap-1 transition focus-within:opacity-100 group-hover:opacity-100 sm:flex sm:opacity-0">
            {actions.map((a) => (
              <ActionButton key={a.id} action={a} busy={busyActionId === a.id} variant="row" />
            ))}
          </span>
        )}
        {trailing}
        {onOpen && <ChevronRight className="h-4 w-4 shrink-0 text-fg-subtle" />}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  busy,
  variant,
}: {
  action: EntityRowAction;
  busy: boolean;
  variant: "row" | "card";
}) {
  const tone = action.tone ?? "ghost";
  const Icon = action.icon;
  const base = "inline-flex items-center gap-1.5 rounded-lg font-semibold transition disabled:opacity-50";
  const sizing =
    variant === "card" && tone === "primary" ? "px-4 py-2 text-[13px]" : "px-2.5 py-1 text-[12px] font-medium";
  const toneCls =
    tone === "primary"
      ? "bg-fg text-surface hover:bg-fg/85"
      : tone === "danger"
        ? "text-red-600 hover:bg-red-500/10 dark:text-red-400"
        : "text-fg-muted hover:bg-surface-hover hover:text-fg";
  return (
    <button
      type="button"
      onClick={action.onRun}
      disabled={busy || action.disabled}
      className={cn(base, sizing, toneCls)}
      title={action.label}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {action.label}
    </button>
  );
}
