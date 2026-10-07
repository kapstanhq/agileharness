// AS CORES DO QUADRO NOVO por estado do desenho (kanban-features.ts `FlowState`) — strings de classe sobre os tokens
// de globals.css (`--st-*`, `--board`, `--well`, `--crate-*`), nunca hex nem matiz cru do Tailwind. Cada estado tem a
// forma (bolinha/borda), a TINTA do texto (AA nos dois temas) e o fundo claro do bloco de ação. PURO.

import { FLOW_STATE_LABEL, type FlowState } from "@/lib/storymap/kanban-features";

export interface StateTone {
  label: string;
  /** a cor da forma: bolinha, barra de progresso, borda. */
  dot: string;
  /** a tinta do rótulo (o texto colorido). */
  ink: string;
  /** o fundo do bloco de ação / de destaque. */
  tint: string;
  /** a bolinha estática do rodapé (6px): cheia, tracejada (fila) ou vazada (pausado). */
  quietDot: string;
}

const FILLED = "h-1.5 w-1.5 shrink-0 rounded-full";

export const STATE_TONE: Readonly<Record<FlowState, StateTone>> = {
  running: { label: FLOW_STATE_LABEL.running, dot: "bg-st-run", ink: "text-st-run", tint: "bg-st-run/[0.08]", quietDot: `${FILLED} bg-st-run` },
  delivering: { label: FLOW_STATE_LABEL.delivering, dot: "bg-st-run", ink: "text-st-run", tint: "bg-st-run/[0.08]", quietDot: `${FILLED} bg-st-run` },
  error: { label: FLOW_STATE_LABEL.error, dot: "bg-st-err", ink: "text-st-err-ink", tint: "bg-st-err/[0.08]", quietDot: `${FILLED} bg-st-err` },
  attention: { label: FLOW_STATE_LABEL.attention, dot: "bg-st-attn", ink: "text-st-attn-ink", tint: "bg-st-attn/10", quietDot: `${FILLED} bg-st-attn` },
  queued: {
    label: FLOW_STATE_LABEL.queued,
    dot: "bg-st-queued",
    ink: "text-fg-muted",
    tint: "bg-inset",
    quietDot: `${FILLED} border-[1.5px] border-dashed border-state-idle bg-transparent`,
  },
  waiting: {
    label: FLOW_STATE_LABEL.waiting,
    dot: "bg-st-queued",
    ink: "text-fg-muted",
    tint: "bg-inset",
    quietDot: `${FILLED} border-[1.5px] border-dashed border-state-idle bg-transparent`,
  },
  paused: { label: FLOW_STATE_LABEL.paused, dot: "bg-fg", ink: "text-fg", tint: "bg-inset", quietDot: `${FILLED} border-[1.5px] border-fg bg-transparent` },
  forgotten: { label: FLOW_STATE_LABEL.forgotten, dot: "bg-st-forgot", ink: "text-fg-subtle", tint: "bg-inset", quietDot: `${FILLED} bg-st-forgot` },
  live: { label: FLOW_STATE_LABEL.live, dot: "bg-st-new", ink: "text-fg-muted", tint: "bg-inset", quietDot: `${FILLED} bg-st-new` },
};

/** A sombra dos popovers do quadro (a do protótipo), uma vez. */
export const POPOVER_CLS = "rounded-xl border border-line bg-surface shadow-[0_14px_36px_rgba(15,15,15,.16)]";

/** O botão primário escuro e o secundário de borda dos blocos de ação e dos popovers (28px). */
export const PRIMARY_BTN =
  "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg bg-fg px-3 text-[12px] font-semibold text-surface transition hover:bg-fg/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const SECONDARY_BTN =
  "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 text-[12px] font-semibold text-fg transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** A chave do localStorage da última visita à raia No ar, por board. */
export const liveSeenKey = (boardId: string) => `ah.kanban.liveSeen.${boardId}`;
