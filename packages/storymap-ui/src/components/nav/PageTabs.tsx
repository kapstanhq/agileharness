"use client";

// O NÍVEL 3 da navegação — as abas que repartem o MIOLO de UMA tela (as seções de Configurações, as
// de Orquestração). Uma primitiva só, porque antes não havia nenhuma: Configurações desenhava a sua
// barra à mão, com o MESMO sublinhado `accent` do nível 2 — duas faixas idênticas empilhadas, e o
// operador sem pista de qual delas trocava de TELA e qual trocava de SEÇÃO da tela.
//
// Aqui o desenho é deliberadamente OUTRO: um segmentado (pílulas dentro de um trilho), que mora no
// CONTEÚDO — não numa barra grudada no topo. A hierarquia passa a se ler pela forma, não pela posição:
//   nível 1  topnav       → blocos/board/medidores        (links)
//   nível 2  BlockTabs    → as ferramentas da seção        (sublinhado, barra sticky)
//   nível 3  PageTabs     → as seções desta tela           (segmentado, no conteúdo)
//
// O estado mora na URL (`?tab=`) — deep-link, bookmark e o voltar do navegador funcionam entre
// seções —, e a aba default não escreve nada (URL limpa). Os demais params são PRESERVADOS: a versão
// à mão de Configurações reescrevia a query inteira, então abrir uma seção derrubava qualquer `?focus=`
// que tivesse trazido você até ali.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { countChipCls } from "@/lib/ui";

export interface PageTab<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  /** o `title` da pílula — diz o que a seção guarda antes do clique. */
  hint?: string;
  /** quantos itens a seção tem, num chip. Só onde a contagem é a informação que decide o clique
   *  (quantas personas × quantos sistemas); numa seção de formulário ela seria ruído. */
  count?: number;
}

/**
 * Lê/escreve a seção ativa na URL. A PRIMEIRA aba é a default (não escreve `?tab=`), e um valor
 * desconhecido na query cai nela em silêncio — link velho para uma seção que não existe mais abre a
 * tela, nunca uma página em branco.
 */
export function usePageTab<T extends string>(tabs: readonly PageTab<T>[]): [T, (id: T) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fallback = tabs[0].id;
  const raw = searchParams.get("tab");
  const active = (tabs.some((t) => t.id === raw) ? (raw as T) : fallback);

  const setTab = (id: T) => {
    const next = new URLSearchParams(searchParams.toString());
    if (id === fallback) next.delete("tab");
    else next.set("tab", id);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return [active, setTab];
}

/**
 * O segmentado. Rola na horizontal no celular (as seções não encolhem a ponto de virar ícone mudo) e
 * usa `role=tablist` para o leitor de tela anunciar "aba 2 de 3" — a barra à mão era um punhado de
 * `<button>` sem relação declarada entre si.
 */
export function PageTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: readonly PageTab<T>[];
  value: T;
  onChange: (id: T) => void;
  /** o que este grupo de abas reparte ("Seções de Configurações") — só para leitor de tela. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-inset p-0.5",
        className,
      )}
      style={{ scrollbarWidth: "none" }}
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={t.hint}
            onClick={() => onChange(t.id)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium transition",
              active
                ? "bg-surface font-semibold text-fg shadow-sm"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {Icon && <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : "text-fg-subtle")} />}
            {t.label}
            {t.count != null && <span className={countChipCls}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * O cabeçalho de uma tela do Sistema: título + linha de explicação + o segmentado embaixo. Existe
 * para as três telas do ⚙ abrirem IGUAIS — antes cada uma inventava o seu (uma com ícone colorido e
 * dois parágrafos, outra com o título espremido ao lado de um total, outra sem título nenhum).
 *
 * ⚠️ O cabeçalho igual não basta: as telas IRMÃS de uma seção também têm de ter a MESMA LARGURA de
 * conteúdo (`max-w-4xl`), porque a barra de abas do nível 2 troca entre elas — largura diferente faz a
 * página deslocar de lado e o título "pular" para outro x. Largura é parte da gramática da seção, não
 * decisão de cada tela. Marcada no código de cada uma:
 *
 *   • `SISTEMA_MAX_W` — Configurações · Orquestração · Métricas (eram 3xl / 4xl / 5xl);
 *   • `PRODUTO_MAX_W` — Mapa · Ideias · Priorização · Personas & Sistemas (esta última era 6xl, em
 *     2 colunas).
 *
 * O **Mapa** (User Story Mapping) era a EXCEÇÃO declarada enquanto era uma grade 2D que rolava nos
 * dois eixos (4xl o reduziria a uma luneta). Virou OUTLINE — uma coluna de conteúdo como as irmãs —
 * e entrou na régua. Não o tire dela.
 */
export function PageHeader({
  title,
  icon: Icon,
  description,
  actions,
  tabs,
}: {
  title: string;
  icon?: LucideIcon;
  description?: string;
  /** o que a tela oferece de ação/resumo, à direita do título. */
  actions?: React.ReactNode;
  /** o segmentado do nível 3, quando a tela tem seções. */
  tabs?: React.ReactNode;
}) {
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-fg">
            {Icon && <Icon className="h-5 w-5 shrink-0 text-fg-subtle" />}
            {title}
          </h1>
          {description && <p className="mt-1 max-w-prose text-[13px] leading-snug text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {tabs && <div className="mt-4">{tabs}</div>}
    </header>
  );
}
