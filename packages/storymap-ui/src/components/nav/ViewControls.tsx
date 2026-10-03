"use client";

// OS CONTROLES DA VIEW — filtrar cards e mostrar/ocultar os detalhes deles.
//
// Moraram no menu ⋯ até aqui, e era o pior lugar possível: são os únicos itens daquele menu que
// mudam o CONTEÚDO da tela na sua frente (o resto muda configuração). Um filtro ligado escondendo
// metade do board ficava invisível atrás de um ícone — o remendo era um badge no gatilho, que conta
// mas não diz o quê, e ainda obrigava a duas viagens de clique para desfazer.
//
// Agora vivem na barra da própria view (as ações de `BlockTabs`), ao lado do conteúdo que alteram:
// o estado é visível sem abrir nada, e "Limpar" fica a um clique. Vale para desktop E celular — o
// sheet "Mais" não precisa mais de uma segunda cópia dos mesmos três selects.

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Filter } from "lucide-react";
import { cn } from "@/lib/cn";
import { useEscape } from "@/components/nav/NavShell";
import type { BoardConfig } from "@/lib/storymap/types";

export type Filters = { status: string; persona: string; system: string };

const EMPTY: Filters = { status: "", persona: "", system: "" };

export function ViewControls({
  config,
  filters,
  onFilterChange,
  showMeta,
  onToggleMeta,
}: {
  config: BoardConfig;
  filters?: Filters;
  onFilterChange?: (next: Filters) => void;
  showMeta?: boolean;
  onToggleMeta?: () => void;
}) {
  const hasFilters = !!(filters && onFilterChange);
  if (!hasFilters && !onToggleMeta) return null;
  return (
    <>
      {hasFilters && <FilterButton config={config} filters={filters!} onChange={onFilterChange!} />}
      {onToggleMeta && (
        <button
          type="button"
          onClick={onToggleMeta}
          aria-pressed={!!showMeta}
          title={showMeta ? "Ocultar os detalhes dos cards (personas, sistemas)" : "Mostrar os detalhes dos cards (personas, sistemas)"}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition",
            showMeta ? "text-emerald-700 hover:bg-surface-hover dark:text-emerald-400" : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
          )}
        >
          {showMeta ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          <span className="hidden sm:inline">Detalhes</span>
        </button>
      )}
    </>
  );
}

/** O gatilho conta QUANTOS filtros estão ligados (e o `title` diz QUAIS); o painel os edita e limpa. */
function FilterButton({
  config,
  filters,
  onChange,
}: {
  config: BoardConfig;
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEscape(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const active = [
    config.statuses.find((s) => s.id === filters.status)?.name,
    config.personas.find((p) => p.id === filters.persona)?.name,
    config.systems.find((s) => s.id === filters.system)?.name,
  ].filter(Boolean) as string[];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={active.length ? `Filtrando por ${active.join(" · ")}` : "Filtrar os cards por status, persona ou sistema"}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition",
          active.length
            ? "bg-accent/10 text-accent hover:bg-accent/15"
            : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
          open && !active.length && "bg-surface-hover text-fg",
        )}
      >
        <Filter className="h-4 w-4" />
        <span className="hidden sm:inline">Filtros</span>
        {active.length > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-fg">
            {active.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filtrar cards"
          className="absolute right-0 top-full z-[60] mt-1.5 w-64 rounded-xl border border-line bg-surface p-2 shadow-lg"
        >
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Filtrar cards</span>
            {active.length > 0 && (
              <button
                type="button"
                onClick={() => onChange(EMPTY)}
                className="text-[11px] font-medium text-accent transition hover:underline"
              >
                Limpar
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <FilterSelect
              value={filters.status}
              onChange={(v) => onChange({ ...filters, status: v })}
              allLabel="Status: todos"
              options={config.statuses.map((s) => ({ value: s.id, label: s.name }))}
            />
            <FilterSelect
              value={filters.persona}
              onChange={(v) => onChange({ ...filters, persona: v })}
              allLabel="Persona: todas"
              options={config.personas.map((p) => ({ value: p.id, label: p.name }))}
            />
            <FilterSelect
              value={filters.system}
              onChange={(v) => onChange({ ...filters, system: v })}
              allLabel="Sistema: todos"
              options={config.systems.map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full rounded-md border bg-inset px-2 py-1.5 text-xs outline-none transition focus:border-accent",
        value ? "border-accent/40 text-fg" : "border-line text-fg-muted",
      )}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
