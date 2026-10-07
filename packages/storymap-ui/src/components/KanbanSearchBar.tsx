"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { readKanbanFilter, writeKanbanFilter, type KanbanFilter } from "@/lib/storymap/kanban-filter";

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

// (A BARRA de busca com chips de tipo — `KanbanSearchBar` — saiu na fase 1: a busca do Kanban novo é a da 2ª barra,
// kanban/KanbanSearchBox, e o recorte é o «Mostrar». Fica o filtro espelhado na URL, que ela usa.)
