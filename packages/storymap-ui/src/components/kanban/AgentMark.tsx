// AS MARCAS de quem atua no board — a família de quadrados da referência «Mascote e agentes» do design:
//   condutor  — quadrado CHEIO com olhos (ocupa vaga; olha e pisca enquanto age);
//   execucao  — o mesmo rosto, só o CONTORNO (é do mesmo tipo, mas não fica);
//   juiz      — auxiliar: contorno cinza, olhos FECHADOS em traço;
//   motor     — o código que orquestra: três linhas num quadrado claro, sem rosto;
//   jido      — o agente com quem você conversa: o ÚNICO com antena ({@link JidoMark});
//   voce      — o dono: um círculo com «V».
// Todos usam o mesmo quadrado 16×16, então ninguém confunde quem fala com você e quem constrói. As cores são os tokens
// do tema (claro/escuro), e `prefers-reduced-motion` desliga toda animação.

import type { CSSProperties } from "react";
import type { ActivityWho } from "@/lib/storymap/activity-feed";

/** Quem a marca desenha (o mesmo vocabulário da atividade). */
export type AgentMarkKind = ActivityWho;

/** O humor do Jido: a ponta da antena e os olhos dizem o estado do board. */
export type JidoMood = "idle" | "running" | "paused" | "attention" | "error";

const INK = "rgb(var(--fg))";
const PAPER = "rgb(var(--surface))";
const AUX = "rgb(var(--state-idle))";
const AUX_EYES = "rgb(var(--fg-muted))";
const WELL = "rgb(var(--surface-hover))";

/**
 * As animações das marcas. Uma folha só, deduplicada e içada pelo React 19 (`href` + `precedence`): montar cem
 * marcas não cria cem `<style>`.
 */
function MarkStyles() {
  return (
    <style href="ah-agent-mark" precedence="default">{`
@keyframes ahMarkBlink{0%,90%,100%{transform:scaleY(1)}95%{transform:scaleY(.15)}}
@keyframes ahMarkLook{0%,100%{transform:translateX(0)}30%{transform:translateX(1px)}65%{transform:translateX(-1px)}}
@keyframes ahMarkPulse{0%,100%{opacity:.2}50%{opacity:1}}
@keyframes ahMarkBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
.ah-mark-blink{transform-box:fill-box;transform-origin:center;animation:ahMarkBlink 3.6s infinite}
.ah-mark-look{animation:ahMarkLook 3s ease-in-out infinite}
.ah-mark-pulse{animation:ahMarkPulse 1.4s ease-in-out infinite}
.ah-mark-bob{animation:ahMarkBob 1.6s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.ah-mark-blink,.ah-mark-look,.ah-mark-pulse,.ah-mark-bob{animation:none!important}}
`}</style>
  );
}

const SVG_STYLE: CSSProperties = { flex: "none", display: "block" };

/** Os dois olhos abertos (2×3) — a mesma geometria em todos os rostos. */
function Eyes({ fill, blink }: { fill: string; blink: boolean }) {
  return (
    <g className={blink ? "ah-mark-blink" : undefined}>
      <rect x={4} y={6} width={2} height={3} style={{ fill }} />
      <rect x={10} y={6} width={2} height={3} style={{ fill }} />
    </g>
  );
}

/**
 * A marca de quem agiu. `size` em px (16 no chip da atividade, 18 na lista, 20 no card). `animated` = o agente está
 * agindo AGORA (o condutor olha e pisca); fora disso a marca fica parada — uma lista de eventos passados não pisca.
 */
export function AgentMark({ kind, size = 16, animated = false, title }: { kind: AgentMarkKind; size?: number; animated?: boolean; title?: string }) {
  if (kind === "jido") return <JidoMark mood="idle" size={size + 2} title={title} />;
  const label = title ? { role: "img" as const, "aria-label": title } : { "aria-hidden": true as const };
  if (kind === "voce") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" style={SVG_STYLE} {...label}>
        {title && <title>{title}</title>}
        <circle cx={8} cy={8} r={7.25} style={{ fill: PAPER, stroke: INK }} strokeWidth={1.5} />
        <text x={8} y={11.4} textAnchor="middle" fontSize={8.5} fontWeight={700} style={{ fill: INK, fontFamily: "inherit" }}>
          V
        </text>
      </svg>
    );
  }
  return (
    <>
      {/* a folha fica FORA do <svg>: dentro dele o <style> é do namespace SVG e o React não o iça */}
      {animated && <MarkStyles />}
      <svg width={size} height={size} viewBox="0 0 16 16" style={SVG_STYLE} {...label}>
        {title && <title>{title}</title>}
        {kind === "condutor" && (
          <>
            <rect width={16} height={16} rx={4} style={{ fill: INK }} />
            <g className={animated ? "ah-mark-look" : undefined}>
              <Eyes fill={PAPER} blink={animated} />
            </g>
          </>
        )}
        {kind === "execucao" && (
          <>
            <rect x={0.75} y={0.75} width={14.5} height={14.5} rx={3.5} strokeWidth={1.5} style={{ fill: PAPER, stroke: INK }} />
            <Eyes fill={INK} blink={animated} />
          </>
        )}
        {kind === "juiz" && (
          <>
            <rect x={0.75} y={0.75} width={14.5} height={14.5} rx={3.5} strokeWidth={1.5} style={{ fill: PAPER, stroke: AUX }} />
            <rect x={4} y={7} width={3} height={1.5} style={{ fill: AUX_EYES }} />
            <rect x={9} y={7} width={3} height={1.5} style={{ fill: AUX_EYES }} />
          </>
        )}
        {kind === "motor" && (
          <>
            <rect width={16} height={16} rx={4} style={{ fill: WELL }} />
            <rect x={4} y={5} width={8} height={1.5} style={{ fill: INK }} />
            <rect x={4} y={7.25} width={8} height={1.5} style={{ fill: INK }} />
            <rect x={4} y={9.5} width={5} height={1.5} style={{ fill: INK }} />
          </>
        )}
      </svg>
    </>
  );
}

/**
 * O Jido — o quadrado com ANTENA (o único). A ponta da antena diz o estado: verde pulsando quando há agente rodando,
 * terracota no erro; os olhos viram traço com o board pausado; com algo esperando você ele balança de leve.
 * `size` é a LARGURA; a altura inclui a antena (22/16 da largura).
 */
export function JidoMark({ mood = "idle", size = 16, title }: { mood?: JidoMood; size?: number; title?: string }) {
  const tip = mood === "error" ? "rgb(var(--danger))" : mood === "running" ? "rgb(var(--primary))" : INK;
  const animated = mood === "running" || mood === "attention";
  const label = title ? { role: "img" as const, "aria-label": title } : { "aria-hidden": true as const };
  return (
    <>
      {animated && <MarkStyles />}
      <svg
        width={size}
        height={(size * 22) / 16}
        viewBox="0 -6 16 22"
        className={mood === "attention" ? "ah-mark-bob" : undefined}
        style={{ ...SVG_STYLE, overflow: "visible" }}
        {...label}
      >
        {title && <title>{title}</title>}
        <rect x={7.25} y={-3.5} width={1.5} height={3.5} style={{ fill: INK }} />
        <rect x={6.25} y={-6} width={3.5} height={3} rx={1} className={mood === "running" ? "ah-mark-pulse" : undefined} style={{ fill: tip }} />
        <rect width={16} height={16} rx={4} style={{ fill: INK }} />
        {mood === "paused" ? (
          <>
            <rect x={4} y={7} width={3} height={1.5} style={{ fill: PAPER }} />
            <rect x={9} y={7} width={3} height={1.5} style={{ fill: PAPER }} />
          </>
        ) : (
          <Eyes fill={PAPER} blink={false} />
        )}
      </svg>
    </>
  );
}
