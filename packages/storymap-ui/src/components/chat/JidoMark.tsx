"use client";

// O JIDO do compositor — o desenho da referência de mascote do design ("Mascote e agentes"): o MESMO quadrado de
// todos os agentes, e o ÚNICO com antena (quem trabalha nos cards não tem). Ele só aparece onde se conversa com ele.
//
// O humor aqui é pouco e é de propósito: ele diz o estado do BOARD, não o da conversa (a conversa já se diz sozinha
// quando está aberta).
//   • a PONTA da antena acende verde e pulsa quando há agente trabalhando de fato neste board (ou o próprio Jido
//     respondendo) — e vermelha quando a conversa deu erro;
//   • os OLHOS viram dois traços quando o board está pausado ("dormindo");
//   • fora isso, repouso.
// O pulso é a classe `state-pulse` (globals.css), que já fica parada sob `prefers-reduced-motion`.
//
// Tinta, não cor: corpo em `currentColor` (a tinta `fg`, herdada) e olhos na cor da SUPERFÍCIE — o mesmo desenho
// vale nos dois temas sem segunda paleta.

import { cn } from "@/lib/cn";

export interface JidoMood {
  /** há agente trabalhando de fato (ou o Jido respondendo) → ponta verde pulsando. */
  working?: boolean;
  /** o board está pausado → olhos em traço. */
  paused?: boolean;
  /** a conversa deu erro → ponta vermelha, parada. */
  error?: boolean;
}

/** O que o mascote diz, para leitor de tela e tooltip — UMA frase, a do estado mais importante. Pura. */
export function jidoMoodLabel(m: JidoMood): string {
  if (m.error) return "Jido — a conversa deu erro";
  if (m.paused && m.working) return "Jido — board pausado, terminando o que já estava rodando";
  if (m.paused) return "Jido — board pausado";
  if (m.working) return "Jido — há agentes trabalhando neste board";
  return "Jido";
}

export function JidoMark({ size = 28, mood = {}, className }: { size?: number; mood?: JidoMood; className?: string }) {
  const tip = mood.error ? "fill-danger" : mood.working ? "fill-state-live state-pulse" : "fill-current";
  return (
    <svg
      width={size}
      height={(size * 22) / 16}
      viewBox="0 -6 16 22"
      role="img"
      aria-label={jidoMoodLabel(mood)}
      className={cn("block shrink-0 overflow-visible text-fg", className)}
      data-jido-working={mood.working ? "" : undefined}
      data-jido-paused={mood.paused ? "" : undefined}
    >
      <title>{jidoMoodLabel(mood)}</title>
      {/* a haste e a ponta da antena */}
      <rect x={7.25} y={-3.5} width={1.5} height={3.5} className="fill-current" />
      <rect x={6.25} y={-6} width={3.5} height={3} rx={1} className={tip} />
      {/* a cabeça */}
      <rect width={16} height={16} rx={4} className="fill-current" />
      {mood.paused ? (
        <>
          <rect x={4} y={7} width={3} height={1.5} className="fill-surface" />
          <rect x={9} y={7} width={3} height={1.5} className="fill-surface" />
        </>
      ) : (
        <>
          <rect x={4} y={6} width={2} height={3} className="fill-surface" />
          <rect x={10} y={6} width={2} height={3} className="fill-surface" />
        </>
      )}
    </svg>
  );
}
