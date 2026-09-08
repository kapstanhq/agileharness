"use client";

// As MINIATURAS de layout das ferramentas — o "retrato" que o popover de um bloco do topnav mostra
// para cada tela da seção (ver `nav/GroupNav.tsx`).
//
// Por que esqueleto em divs, e não screenshot: um print apodrece no primeiro redesign, não segue o
// tema (claro/escuro) e pesa. O que o olho precisa aqui não é o conteúdo da tela — é a FORMA dela: o
// grid de nove caixas do Lean Canvas, as colunas do Kanban, a fita de passos do Story Map. Reconhecer
// a forma é o que faz o clique ser certeiro antes de ler o rótulo.
//
// A gramática é fechada e vale para TODAS: tinta = os tokens (`fg` em alfas decrescentes para o
// esqueleto neutro, `accent` para o ÚNICO elemento que dá nome à tela), cantos de 2–3px, barras de
// 5–9px. Tela nova = um `ThumbKind` novo em `nav-groups.ts` + uma entrada em `THUMBS` — o TypeScript
// cobra a entrada (o Record é exaustivo) e `nav-groups.test.ts` cobra que nenhuma miniatura fique
// órfã (declarada e usada por ninguém).

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ThumbKind } from "@/components/nav/nav-groups";

/** Os pesos de tinta do esqueleto. `accent` marca o elemento-assinatura da tela; o resto é neutro em
 *  alfas decrescentes (o que está "mais ao fundo" é mais fraco). */
const INK = {
  accent: "bg-accent/50",
  strong: "bg-fg/20",
  mid: "bg-fg/[0.14]",
  soft: "bg-fg/10",
  faint: "bg-fg/[0.06]",
} as const;

type Ink = keyof typeof INK;

/** Um bloco do esqueleto (caixa de grid, barra, chip) — o átomo de toda miniatura. */
function B({ ink, className }: { ink: Ink; className?: string }) {
  return <span className={cn("block rounded-[2px]", INK[ink], className)} />;
}

/** Uma barra de texto simulado (canto mais redondo que o das caixas). */
function Bar({ ink, className }: { ink: Ink; className?: string }) {
  return <span className={cn("block rounded-[3px]", INK[ink], className)} />;
}

/** Lean Canvas — as nove caixas da folha, com o bloco do problema em destaque. */
function CanvasThumb() {
  return (
    <div className="grid flex-1 grid-cols-3 grid-rows-3 gap-1">
      <B ink="accent" />
      <B ink="mid" />
      <B ink="mid" className="row-span-2" />
      <B ink="mid" />
      <B ink="soft" />
      <B ink="soft" className="col-span-2" />
      <B ink="mid" />
    </div>
  );
}

/**
 * PRD — o documento LONGO e seccionado: um título e, sob ele, seções que se repetem (um rótulo curto
 * e forte, o corpo mais claro). A forma que o olho tem de reconhecer é a REPETIÇÃO vertical, e é ela
 * que separa esta miniatura da folha de nove caixas do canvas e da escada do mapa.
 *
 * Substituiu o retrato do Posicionamento, que era uma declaração e um parágrafo — a forma certa para
 * o que aquela tela era (uma frase), e a forma errada para o que ela virou.
 */
function PrdThumb() {
  return (
    <div className="flex flex-1 flex-col justify-center gap-[5px]">
      <Bar ink="accent" className="h-2 w-[46px]" />
      <Bar ink="mid" className="h-1.5 w-[30px]" />
      <Bar ink="soft" className="h-1 w-full" />
      <Bar ink="soft" className="h-1 w-[88%]" />
      <Bar ink="mid" className="h-1.5 w-[36px]" />
      <Bar ink="soft" className="h-1 w-[94%]" />
      <Bar ink="soft" className="h-1 w-[62%]" />
    </div>
  );
}

/**
 * User Story Mapping — o OUTLINE: ações no nível 0, passos recuados, stories mais fundo. A forma que
 * o olho tem de reconhecer é a ESCADA (a árvore), não mais a grade de células por release.
 */
function StorymapThumb() {
  const row = (indent: number, ink: Ink, w: string) => (
    <span className="flex items-center gap-1">
      {indent > 0 && <span className="block" style={{ width: indent * 6 }} />}
      <B ink={ink} className={cn("h-1.5", w)} />
    </span>
  );
  return (
    <div className="flex flex-1 flex-col justify-center gap-[5px]">
      {row(0, "accent", "w-[62%]")}
      {row(1, "mid", "w-[46%]")}
      {row(2, "soft", "w-[38%]")}
      {row(2, "soft", "w-[30%]")}
      {row(1, "mid", "w-[42%]")}
      {row(0, "accent", "w-[54%]")}
    </div>
  );
}

/** Ideias — uma ideia no topo abrindo nas stories que ela agrupa. */
function IdeasThumb() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5">
      <Bar ink="accent" className="h-2.5 w-11" />
      <span className="block h-2 w-px bg-fg/20" />
      <span className="block h-px w-full bg-fg/20" />
      <div className="flex w-full gap-1">
        <B ink="mid" className="h-2.5 flex-1" />
        <B ink="mid" className="h-2.5 flex-1" />
        <B ink="mid" className="h-2.5 flex-1" />
      </div>
      <div className="flex w-full gap-1">
        <B ink="faint" className="h-2.5 flex-1" />
        <B ink="faint" className="h-2.5 flex-1" />
        <B ink="faint" className="h-2.5 flex-1" />
      </div>
    </div>
  );
}

/** Personas & Sistemas — a lista de fichas: avatar redondo (persona) e quadrado (sistema). */
function PersonasThumb() {
  return (
    <div className="flex flex-1 flex-col justify-center gap-2.5">
      <div className="flex items-center gap-[7px]">
        <span className={cn("block h-4 w-4 shrink-0 rounded-full", INK.accent)} />
        <span className="flex flex-1 flex-col gap-1">
          <Bar ink="mid" className="h-[5px] w-full" />
          <Bar ink="soft" className="h-[5px] w-[62%]" />
        </span>
      </div>
      <div className="flex items-center gap-[7px]">
        <span className={cn("block h-4 w-4 shrink-0 rounded-full", INK.strong)} />
        <span className="flex flex-1 flex-col gap-1">
          <Bar ink="mid" className="h-[5px] w-[86%]" />
          <Bar ink="soft" className="h-[5px] w-[48%]" />
        </span>
      </div>
      <div className="flex items-center gap-[7px]">
        <span className={cn("block h-4 w-4 shrink-0 rounded", INK.strong)} />
        <Bar ink="soft" className="h-[5px] flex-1" />
      </div>
    </div>
  );
}

/** Priorização — a fila ordenada, o topo mais forte que a cauda. */
function PriorityThumb() {
  return (
    <div className="flex flex-1 flex-col justify-center gap-[7px]">
      <div className="flex items-center gap-1.5">
        <B ink="accent" className="h-3 w-3 shrink-0 rounded-[3px]" />
        <Bar ink="strong" className="h-[7px] w-full" />
      </div>
      <div className="flex items-center gap-1.5">
        <B ink="strong" className="h-3 w-3 shrink-0 rounded-[3px]" />
        <Bar ink="mid" className="h-[7px] w-[82%]" />
      </div>
      <div className="flex items-center gap-1.5">
        <B ink="soft" className="h-3 w-3 shrink-0 rounded-[3px]" />
        <Bar ink="soft" className="h-[7px] w-[64%]" />
      </div>
      <div className="flex items-center gap-1.5">
        <B ink="faint" className="h-3 w-3 shrink-0 rounded-[3px]" />
        <Bar ink="faint" className="h-[7px] w-[44%]" />
      </div>
    </div>
  );
}

/** Guia de Estilo — a régua de cores e a escala tipográfica embaixo. */
function StyleguideThumb() {
  return (
    <div className="flex flex-1 flex-col justify-center gap-2">
      <div className="grid grid-cols-4 gap-1">
        <B ink="accent" className="h-4 rounded-[3px]" />
        <B ink="strong" className="h-4 rounded-[3px]" />
        <B ink="mid" className="h-4 rounded-[3px]" />
        <B ink="soft" className="h-4 rounded-[3px]" />
      </div>
      <div className="flex flex-col gap-1">
        <Bar ink="strong" className="h-2 w-[60%]" />
        <Bar ink="soft" className="h-1 w-full" />
        <Bar ink="soft" className="h-1 w-[78%]" />
      </div>
    </div>
  );
}

/** Kanban — as colunas de status com os cards, um deles em foco. */
function KanbanThumb() {
  return (
    <div className="flex flex-1 gap-1.5">
      <div className="flex flex-1 flex-col gap-1">
        <Bar ink="strong" className="h-[5px] w-full" />
        <B ink="accent" className="h-[17px] rounded-[3px]" />
        <B ink="mid" className="h-[17px] rounded-[3px]" />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <Bar ink="strong" className="h-[5px] w-full" />
        <B ink="mid" className="h-[17px] rounded-[3px]" />
        <B ink="soft" className="h-6 rounded-[3px]" />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <Bar ink="strong" className="h-[5px] w-full" />
        <B ink="soft" className="h-[17px] rounded-[3px]" />
      </div>
    </div>
  );
}

// Os desenhos de Métricas (barras), Orquestração (nós+arestas) e Configurações (interruptores) foram
// REMOVIDOS junto com a saída dessas telas do bloco Software: elas viraram o grupo Sistema, cuja
// superfície é o MENU do ⚙ (lista), não o popover de miniaturas. Sem tela que os renderize, os três
// eram desenho morto — o defeito que o teste "nenhuma miniatura fica ÓRFÃ" existe para pegar. Estão
// no git (`git log -S MetricsThumb`) se o Sistema um dia ganhar popover visual.

/** O mapa KIND → desenho. Exaustivo por construção (Record): `ThumbKind` novo sem desenho não compila. */
const THUMBS: Record<ThumbKind, () => ReactNode> = {
  canvas: CanvasThumb,
  prd: PrdThumb,
  storymap: StorymapThumb,
  ideas: IdeasThumb,
  personas: PersonasThumb,
  priority: PriorityThumb,
  styleguide: StyleguideThumb,
  kanban: KanbanThumb,
  delivery: DeliveryThumb,
};

/** Esteira — os quatro degraus do caminho até produção, o último aceso. */
function DeliveryThumb() {
  return (
    <div className="flex flex-1 flex-col justify-center gap-1.5">
      <div className="flex items-center gap-1">
        <B ink="mid" className="h-1.5 flex-1 rounded-full" />
        <B ink="mid" className="h-1.5 flex-1 rounded-full" />
        <B ink="soft" className="h-1.5 flex-1 rounded-full" />
        <B ink="accent" className="h-1.5 flex-1 rounded-full" />
      </div>
      <div className="flex gap-1">
        <B ink="soft" className="h-3 flex-1 rounded-[2px]" />
        <B ink="soft" className="h-3 flex-1 rounded-[2px]" />
        <B ink="mid" className="h-3 flex-1 rounded-[2px]" />
        <B ink="accent" className="h-3 flex-1 rounded-[2px]" />
      </div>
    </div>
  );
}

/** A miniatura de uma tela. Preenche o quadrado que o chamador dá (o tile do popover). */
export function LayoutThumb({ kind }: { kind: ThumbKind }) {
  const Thumb = THUMBS[kind];
  return <Thumb />;
}
