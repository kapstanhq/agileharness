"use client";

// UMA RAIA do Kanban: o seu trecho do fluxo em cima (o cabeçalho da coluna) e a coluna embaixo, com rolagem vertical
// própria. No computador as seis raias dividem a largura (grade de 6); no celular viram UM rolador horizontal com
// scroll-snap, cada raia ~86vw com a sua faixa em cima — sem rolagem horizontal da PÁGINA. No celular a raia INTEIRA
// rola (a faixa do fluxo sobe junto com os cards): com a barra do topo, a 2ª barra em duas linhas e o compositor, uma
// faixa fixa de 150px deixava menos de um card à vista. O fundo da coluna deixa espaço para o compositor do chat
// (fixo no rodapé) não tapar o último card: no computador BAIXO (lib/viewport.ts) a reserva é EXATAMENTE a altura que
// o compositor publica (`--jido-composer-h`) — numa tela de ~600px os 220px de folga do computador alto eram um terço
// da raia vazio; no alto e no celular, a folga de sempre.

import type { ReactNode } from "react";

/** O fundo de cada raia no computador: alto, a folga de sempre; baixo, só a altura do compositor do Jido. */
export const LANE_BOTTOM_RESERVE = "tall:pb-[220px] short:pb-[var(--jido-composer-h,0px)]";

export function KanbanLane({ label, segment, children }: { label: string; segment: ReactNode; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className="col-scroll group flex min-h-0 w-[86vw] min-w-0 shrink-0 snap-start flex-col overflow-y-auto overscroll-contain md:w-auto md:shrink md:overflow-visible"
    >
      {segment}
      <div className={`col-scroll flex flex-1 flex-col gap-2.5 border-r border-surface-hover bg-board p-3 pb-44 md:min-h-0 md:overflow-y-auto ${LANE_BOTTOM_RESERVE}`}>
        {children}
      </div>
    </section>
  );
}
