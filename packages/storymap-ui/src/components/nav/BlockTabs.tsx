"use client";

// A barra de ABAS da seção — o NÍVEL 2, logo abaixo do topnav. Substitui o antigo ToolSubnav.
//
// Divisão de papéis: o TOPNAV (nível 1) é dono dos LINKS (board · blocos · medidores); esta barra é
// dona da FERRAMENTA atual (as abas da seção) e das AÇÕES da tela; o NÍVEL 3 (`nav/PageTabs`) reparte
// o MIOLO de uma tela e usa outro desenho de propósito (segmentado, dentro do conteúdo) — dois
// sublinhados empilhados não diziam qual era qual. É o ÚNICO trocador de ferramenta: o clique no bloco
// abre a ferramenta default, e daqui você pula para as irmãs. Só aparece quando a seção tem MAIS de
// uma ferramenta (Design, ferramenta única, não mostra barra). Os rótulos/ícones saem de `nav-groups`
// — a MESMA fonte dos blocos —, então nunca divergem do que o bloco navega.
//
// Serve os DOIS planos com a mesma anatomia: os blocos do produto e o grupo SISTEMA (⚙). A diferença
// é o `lead`: num bloco, quem nomeia a seção é o próprio bloco aceso no topo; no Sistema não há bloco
// aceso, então a barra se apresenta ("⚙ Sistema") em vez de deixar quatro abas órfãs na tela.

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { BoardView, NavItem } from "@/components/nav/nav-groups";

export function BlockTabs({
  items,
  view,
  boardId,
  actions,
  lead,
}: {
  /** As ferramentas da seção ativa (≥2 — a barra não é montada para seção de ferramenta única). */
  items: NavItem[];
  /** A view atual — marca a aba em que você está. */
  view: BoardView;
  boardId: string;
  /** Ações da tela, alinhadas à direita (opcional). */
  actions?: ReactNode;
  /** Quem é a seção — só quando ela NÃO tem bloco aceso no topnav (o Sistema). */
  lead?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-30 bg-surface/95 backdrop-blur">
      <div className="flex items-stretch gap-1 px-2 sm:px-3">
        {/* A faixa de abas rola na horizontal quando não cabe (mobile) — o divisor (border-b) mora na
            própria nav para o sublinhado da aba ativa assentar sobre ele. */}
        <nav
          aria-label="Ferramentas da seção"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto border-b border-line"
          style={{ scrollbarWidth: "none" }}
        >
          {lead ? (
            <span className="mr-1 inline-flex shrink-0 items-center gap-1.5 border-r border-line-muted py-2.5 pr-2.5 text-[12px] font-semibold uppercase tracking-wide text-fg-subtle">
              {lead}
            </span>
          ) : null}
          {items.map((it) => {
            const Icon = it.icon;
            const active = it.id === view;
            return (
              <Link
                key={it.id}
                href={it.href(boardId)}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                title={it.hint}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition",
                  active
                    ? "border-accent font-semibold text-fg"
                    : "border-transparent text-fg-subtle hover:text-fg-muted",
                )}
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : "text-fg-subtle")} />
                {it.label}
              </Link>
            );
          })}
        </nav>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-line pl-1">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
