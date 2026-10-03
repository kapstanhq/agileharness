"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  isKanbanFilterActive,
  readKanbanFilter,
  writeKanbanFilter,
  type KanbanFilter,
  type KanbanTypeFacet,
} from "@/lib/storymap/kanban-filter";
import type { StoryType } from "@/lib/storymap/frameworks";

/**
 * Espera entre a última tecla e a escrita na URL. O recorte em si é instantâneo (vem do estado); só a URL
 * espera — o Safari limita a taxa de `history.replaceState` e lança SecurityError acima dela.
 */
const URL_WRITE_DELAY_MS = 250;

/**
 * O filtro do Kanban espelhado na URL (`?q=` e `?tipo=`), para um reload ou um link colado manterem o recorte.
 *
 * Escreve com `history.replaceState` e não com `router.replace`: o Next 15 integra o replaceState nativo ao
 * roteador (usePathname/useSearchParams acompanham) SEM refazer a página no servidor — um router.replace por
 * tecla re-renderizaria o board inteiro a cada letra. Replace, nunca push: digitar não enche o histórico.
 *
 * O estado é a fonte enquanto a tela está montada. Uma URL que chega com OUTRO `?q=`/`?tipo=` (um link para
 * esta mesma tela) vence; uma URL que simplesmente PERDEU os parâmetros (outro componente reescreveu a query
 * sem eles) ganha o filtro de volta.
 */
export function useKanbanFilter(): [KanbanFilter, (next: KanbanFilter) => void] {
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<KanbanFilter>(() => readKanbanFilter(searchParams));
  const urlFilter = useMemo(() => readKanbanFilter(searchParams), [searchParams]);
  const urlKey = writeKanbanFilter("", urlFilter);
  const stateKey = writeKanbanFilter("", filter);
  // A última query (só a nossa parte) que a URL teve — inclusive a que nós mesmos escrevemos, para a própria
  // escrita não voltar lida como "mudança de fora".
  const lastUrlKey = useRef(urlKey);

  useEffect(() => {
    if (urlKey === lastUrlKey.current) return;
    lastUrlKey.current = urlKey;
    if (urlKey) setFilter(urlFilter);
  }, [urlKey, urlFilter]);

  useEffect(() => {
    if (stateKey === urlKey) return;
    const t = window.setTimeout(() => {
      lastUrlKey.current = stateKey;
      const qs = writeKanbanFilter(window.location.search, filter);
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    }, URL_WRITE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [stateKey, urlKey, filter]);

  return [filter, setFilter];
}

/** Um campo onde a pessoa está digitando — ali o `/` é texto, não atalho. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * A BARRA DE BUSCA do Kanban — uma linha fina entre o cabeçalho e as colunas, a mesma nas duas formas do
 * board (raias e colunas de status), fora da área que rola: fica à vista enquanto se percorre as colunas.
 * O campo acha por id, título, tipo e passo/atividade; os chips recortam por tipo (só os tipos que o board
 * tem, cada um com quantos traria). `/` foca o campo; `Esc` limpa o texto, depois os chips, depois sai.
 */
export function KanbanSearchBar({
  filter,
  onChange,
  facets,
  shown,
  total,
}: {
  filter: KanbanFilter;
  onChange: (next: KanbanFilter) => void;
  facets: KanbanTypeFacet[];
  /** quantos cards passam no filtro */
  shown: number;
  /** quantos cards o Kanban tem */
  total: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const active = isKanbanFilterActive(filter);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleType = (type: StoryType) =>
    onChange({
      ...filter,
      types: filter.types.includes(type) ? filter.types.filter((t) => t !== type) : [...filter.types, type],
    });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (filter.q) onChange({ ...filter, q: "" });
    else if (filter.types.length) onChange({ ...filter, types: [] });
    else inputRef.current?.blur();
  };

  return (
    <div className="shrink-0 bg-canvas px-4 pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 transition focus-within:border-line-emphasis sm:w-72">
          <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden />
          <input
            ref={inputRef}
            value={filter.q}
            onChange={(e) => onChange({ ...filter, q: e.target.value })}
            onKeyDown={onKeyDown}
            placeholder="Buscar por id, título ou tipo…"
            aria-label="Buscar cards no Kanban"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-subtle"
          />
          {filter.q ? (
            <button
              type="button"
              onClick={() => {
                onChange({ ...filter, q: "" });
                inputRef.current?.focus();
              }}
              title="Limpar busca"
              aria-label="Limpar busca"
              className="shrink-0 rounded-full p-0.5 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <kbd
              title="Atalho: / foca a busca"
              className="hidden shrink-0 rounded border border-line px-1 font-mono text-[10px] leading-4 text-fg-subtle sm:inline"
            >
              /
            </kbd>
          )}
        </label>

        <div className="flex min-w-0 flex-1 items-center gap-3">
          {facets.length > 1 && (
            <div
              role="group"
              aria-label="Filtrar por tipo"
              className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {facets.map((f) => {
                const on = filter.types.includes(f.type);
                return (
                  <button
                    key={f.type}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleType(f.type)}
                    title={on ? `Mostrando só ${f.label} — clique para tirar` : `Mostrar só ${f.label}`}
                    className={cn(
                      "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium transition",
                      on
                        ? "border-fg bg-fg text-surface hover:bg-fg/85"
                        : "border-line bg-surface text-fg-muted hover:border-line-emphasis hover:text-fg",
                    )}
                  >
                    {f.label}
                    <span className={cn("tabular-nums", on ? "text-surface/70" : "text-fg-subtle")}>{f.count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {active && (
            <div className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-fg-muted">
              <span aria-live="polite">
                <strong className="font-semibold tabular-nums text-fg">{shown}</strong> de{" "}
                <span className="tabular-nums">{total}</span> cards
              </span>
              <button
                type="button"
                onClick={() => onChange({ q: "", types: [] })}
                className="rounded px-1 py-0.5 font-medium text-fg-subtle underline-offset-2 transition hover:text-fg hover:underline"
              >
                Limpar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
