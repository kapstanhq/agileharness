"use client";

// O FLUXO COMO CABEÇALHO — cada raia do Kanban tem em cima o seu trecho do fluxo (150px, fundo do quadro; 100px no
// computador baixo — a geometria inteira são as variáveis `--flow-*` da classe `.ah-flow` em globals.css): o nome e o
// total da raia, um poço onde cada item é uma CAIXINHA de 16px posicionada pelo progresso dentro da raia (o encaixe
// `p5place` do protótipo: 7 colunas × até 3 de altura; os solos não empilham), e uma legenda curta embaixo.
//
// A caixinha diz o estado pela FORMA, nunca só pela cor (o `p5box` do protótipo): enche de baixo para cima pela posição
// no pipeline (a ordem da raia + o passo dentro dela); tracejada na 1ª raia (ainda nem entrou no fluxo) ou esquecida;
// vermelha no erro; bolinha no canto quando precisa de você ou deu erro; anel verde pulsando + a marca do
// agente em cima quando roda; um quadradinho tracejado em cima quando espera condutor. A raia Entrega tem a esteira
// tracejada (parada com o board pausado); toda raia mostra «+N» quando o poço não desenhou um item (acima de 14 na
// Entrega, ou o solo sem coluna livre); a raia No ar, a pilha de quadradinhos (até 24, um por item no ar, os de hoje em
// azul) e, na legenda, o resumo das últimas 24 horas.
//
// Passar o mouse numa caixinha acende o card correspondente e vice-versa (quem guarda o «aceso» é o Kanban). Clicar
// abre o popover da caixinha (CratePopover).

import { useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { displayTitle } from "@/lib/storymap/display-title";
import { captionParts, decimalWords, type FlowCaption, type FlowState, type KanbanLane, type LaneStep } from "@/lib/storymap/kanban-features";
import type { CardLiveStatus } from "@/lib/storymap/card-live-status";
import type { Card } from "@/lib/storymap/types";
import { AgentMark } from "./AgentMark";
import { CratePopover } from "./CratePopover";
import { POPOVER_CLS, STATE_TONE } from "./kanban-tokens";

/**
 * Frases curtas separadas por «·» que QUEBRAM linha sem deixar o «·» sobrando no fim (nem no começo) de uma linha — o
 * texto corrido deixava «2 itens ·» no fim da 1ª linha e a frase seguinte sozinha na 2ª. Cada frase leva o seu «·» num
 * recuo de 14px à esquerda; a lista começa 14px antes da borda, e a caixa (`className`: `overflow-hidden`, ou
 * `overflow-x-clip` quando há botão dentro, para o anel de foco não ser cortado em cima e embaixo) corta o que passa
 * dela — então o «·» da frase que ABRE uma linha cai fora da vista. Uma frase longa quebra dentro do próprio recuo.
 * Na legenda do fluxo e nas linhas quietas do Kanban (a coluna e a linha do board sem exceção).
 */
export function DotList({ parts, className, ...rest }: { parts: ReactNode[] } & HTMLAttributes<HTMLSpanElement>) {
  const shown = parts.filter((p) => p != null && p !== false && p !== "");
  return (
    <span className={cn("block", className)} {...rest}>
      <span className="-ml-[14px] flex flex-wrap items-baseline">
        {shown.map((p, i) => (
          <span key={i} className="min-w-0 pl-[14px]">
            {/* na linha do texto (não `absolute top-0`): ao lado de um botão com folga de toque, o «·» subia */}
            <span aria-hidden className="-ml-[14px] inline-block w-[14px] text-center text-line-emphasis">
              ·
            </span>
            {p}
          </span>
        ))}
      </span>
    </span>
  );
}

/** As frases da legenda: o negrito colado à 1ª frase do resto («Pausado 2 sem condutor»), depois uma por «·». */
function captionNodes(lead: string, rest: string | undefined): ReactNode[] {
  const [first, ...more] = captionParts(rest);
  return [
    <>
      <b className="font-semibold text-fg">{lead}</b>
      {first ? ` ${first}` : ""}
    </>,
    ...more,
  ];
}

/** O `bottom` de uma caixinha no nível `lvl`: o chão (a partir de baixo) + um degrau por nível — `.ah-flow` em globals.css. */
const crateBottom = (lvl: number) => `calc(var(--flow-floor) + ${lvl} * var(--flow-level))`;
/** A caixinha (16px; 12px no computador baixo). */
const CRATE_BOX = "h-[var(--flow-crate)] w-[var(--flow-crate)]";
/** O que fica EM CIMA da caixinha (a marca do agente, a vaga do condutor): 6px acima dela. */
const ABOVE_CRATE = "top-[calc(-1*(var(--flow-crate)_+_6px))]";

export interface FlowCrate {
  card: Card;
  state: FlowState;
  step: LaneStep;
  live: CardLiveStatus | null;
  /** o card é conduzido (a marca em cima é a do condutor; senão a da execução de coluna). */
  conducted: boolean;
  /** quanto a caixinha está cheia, 0..1 (kanban-features `crateFill`). */
  fill: number;
  /** contorno tracejado (kanban-features `crateDashed`). */
  dashed: boolean;
  /** o item vira CARD na coluna dele (a busca o revela) — fora do trem e fora do No ar. */
  findable: boolean;
  /** um agente roda no passo do item (o status tem gatilho) — o «o que vem a seguir» do popover de quem está na fila. */
  auto: boolean;
  slot: number;
  lvl: number;
}

export interface LiveSummary {
  /** quantos chegaram ao ar hoje (o dia do dono) e nas últimas 24 h. */
  today: number;
  last24: number;
  /** a média por dia nos últimos 7 dias (null = sem como medir). */
  perDay: number | null;
  /** a mistura do que chegou nas 24 h («2 novidades · 1 correção»). */
  mix: string;
  total: number;
}

export interface FlowSegmentProps {
  boardId: string;
  lane: KanbanLane;
  total: number;
  crates: FlowCrate[];
  /** a legenda: a parte em negrito, o resto e o resto CURTO do computador baixo (kanban-features `flowCaption`). */
  caption: FlowCaption;
  paused: boolean;
  /** o board está desligado (nunca armado) ou só de organização: nada começa sozinho. */
  off: boolean;
  /** quantos itens da raia o poço não desenhou (além das 14 da Entrega, ou o solo sem coluna livre) — o «+N». */
  extra?: number;
  /** a raia No ar: a pilha e o resumo das 24 h. */
  live?: LiveSummary;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  popId: string | null;
  onPop: (id: string | null) => void;
  onFind: (title: string) => void;
  /** a faixa está na metade direita do quadro: o popover abre para a esquerda da caixinha. */
  flip: boolean;
  slots: number;
  now: number;
}

/** O `left` de uma coluna de encaixe: 18px + slot × (até 26px), espremido em faixa estreita. */
const slotLeft = (slot: number) => `calc(18px + ${slot} * min(26px, (100% - 52px) / 6))`;

export function FlowSegment(props: FlowSegmentProps) {
  const { boardId, lane, total, crates, caption, paused, off, extra, live, hoverId, onHover, popId, onPop, onFind, flip, slots, now } = props;
  const [dayOpen, setDayOpen] = useState(false);
  const isLive = lane.role === "live";
  const popped = popId ? crates.find((c) => c.card.id === popId) : undefined;

  return (
    <div className={cn("ah-flow relative h-[var(--flow-h)] min-w-0 shrink-0 border-b border-r border-line-muted bg-board md:border-r-surface-hover", (popped || dayOpen) && "z-20")}>
      <span className="absolute left-[14px] right-3 top-[var(--flow-label-top)] flex items-baseline gap-1.5">
        <span className="truncate text-[13px] font-semibold text-fg-strong">{lane.label}</span>
        <span className="text-[13px] tabular-nums text-fg-subtle">{total}</span>
      </span>
      <div aria-hidden className="absolute left-2 right-2 top-[var(--flow-well-top)] h-[var(--flow-well-h)] rounded-lg bg-well" />
      {lane.role === "delivery" && <span aria-hidden data-paused={paused ? "" : undefined} className="ah-belt absolute left-4 right-4 top-[var(--flow-belt-top)] h-[2px]" />}
      {/* «+N»: DENTRO do poço, no canto de cima à direita (o desenho: right 16, top 44), ao lado das caixinhas que ele
          completa. Por cima delas (z-[2]) e com o fundo do poço: numa raia estreita a pilha da última coluna encosta nele. */}
      {!isLive && extra != null && extra > 0 && (
        <span
          title={`Mais ${extra} ${extra === 1 ? "item" : "itens"} nesta raia além das caixinhas`}
          className="absolute right-4 top-[var(--flow-extra-top)] z-[2] rounded bg-well px-0.5 text-[11px] leading-4 tabular-nums text-fg-muted"
        >
          +{extra}
        </span>
      )}
      {isLive && live && <LivePile total={live.total} today={live.today} />}
      {crates.map((c) => {
        const tone = STATE_TONE[c.state];
        const title = `${displayTitle(c.card.title)} · ${tone.label}`;
        return (
          <button
            key={c.card.id}
            type="button"
            title={title}
            aria-label={title}
            aria-expanded={popId === c.card.id}
            data-crate={c.card.id}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              onPop(popId === c.card.id ? null : c.card.id);
              // clique de MOUSE/toque (detail > 0) não deixa o foco na caixinha: senão a próxima tecla (o Esc que fecha o
              // popover) a acenderia com o anel de foco, que ficava lá depois de tudo fechado. O teclado (Enter/Espaço,
              // detail 0) mantém o foco — e o anel.
              if (e.detail > 0) e.currentTarget.blur();
            }}
            // O ELO caixinha ↔ card acende só com MOUSE (no toque o mouseenter emulado grudava) e com o foco do TECLADO
            // (`:focus-visible`): o foco que o clique deixa na caixinha não pode virar um anel de seleção que fica
            // depois de o popover fechar.
            onPointerEnter={(e) => e.pointerType === "mouse" && onHover(c.card.id)}
            onPointerLeave={(e) => e.pointerType === "mouse" && onHover(null)}
            onFocus={(e) => e.currentTarget.matches(":focus-visible") && onHover(c.card.id)}
            onBlur={() => onHover(null)}
            style={{ left: slotLeft(c.slot), bottom: crateBottom(c.lvl) }}
            className="absolute z-[1] block h-[var(--flow-crate)] w-[var(--flow-crate)] rounded-[4px] transition-transform after:absolute after:-inset-[5px] max-md:after:-inset-3 hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            <Crate crate={c} highlighted={hoverId === c.card.id || popId === c.card.id} />
          </button>
        );
      })}
      <div
        // A legenda pode QUEBRAR em duas linhas (o resto conta «11 itens · 2 funcionalidades» — numa raia estreita do
        // computador, cortado em «2 funciona…», o número do cabeçalho voltava a brigar com os cards). Duas linhas de 16px
        // cabem entre o poço (acaba em 110) e a borda (150); no computador baixo cabe UMA (`short:max-h-4`). Quebra
        // ENTRE as frases (`DotList`: o «·» nunca sobra no fim da linha). A frase inteira fica no `title`.
        title={caption[1] ? `${caption[0]} · ${caption[1]}` : undefined}
        className={cn(
          "absolute left-[14px] right-[10px] min-w-0 text-[12px] text-fg-subtle",
          isLive
            ? "top-[var(--flow-live-caption-top)] flex cursor-default items-baseline gap-1.5 whitespace-nowrap"
            : "top-[var(--flow-caption-top)] leading-4",
        )}
        // Hover só para MOUSE: no toque o mouseenter emulado abriria e o clique logo em seguida fecharia.
        onPointerEnter={isLive ? (e) => e.pointerType === "mouse" && setDayOpen(true) : undefined}
        onPointerLeave={isLive ? (e) => e.pointerType === "mouse" && setDayOpen(false) : undefined}
      >
        {isLive ? (
          <button
            type="button"
            onClick={() => setDayOpen((o) => !o)}
            onBlur={() => setDayOpen(false)}
            aria-expanded={dayOpen}
            className="relative shrink-0 border-b border-dotted border-st-forgot font-semibold text-fg after:absolute after:-inset-y-3 after:inset-x-0 after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {caption[0]}
          </button>
        ) : caption[2] != null ? (
          // no computador baixo a legenda tem UMA linha: o resto sem o «11 itens · 2 funcionalidades» (fica no `title`).
          // A frase inteira só some da VISTA (sr-only): o leitor de tela continua lendo-a; a curta é só visual.
          <>
            <DotList className="max-h-8 overflow-hidden short:sr-only" parts={captionNodes(caption[0], caption[1])} />
            <DotList aria-hidden="true" className="hidden max-h-4 overflow-hidden short:block" parts={captionNodes(caption[0], caption[2])} />
          </>
        ) : (
          <DotList className="max-h-8 overflow-hidden short:max-h-4" parts={captionNodes(caption[0], caption[1])} />
        )}
        {isLive && caption[1] && <span className="min-w-0 truncate">{caption[1]}</span>}
      </div>
      {isLive && live && dayOpen && <DayPopover live={live} />}
      {popped && (
        <CratePopover
          boardId={boardId}
          card={popped.card}
          state={popped.state}
          live={popped.live}
          lane={lane}
          step={popped.step}
          findable={popped.findable}
          now={now}
          slots={slots}
          next={{ auto: popped.auto, off, paused }}
          style={popoverPlace(popped, flip)}
          onClose={() => onPop(null)}
          onFind={onFind}
        />
      )}
    </div>
  );
}

/** Onde o popover pousa: à direita da caixinha, ou à esquerda dela na metade direita do quadro; na altura dela. */
function popoverPlace(c: FlowCrate, flip: boolean): CSSProperties {
  const top = `max(6px, calc(var(--flow-h) - ${crateBottom(c.lvl)} - var(--flow-crate) - 6px))`;
  return flip ? { top, right: `calc(100% - ${slotLeft(c.slot)} + 14px)` } : { top, left: `calc(${slotLeft(c.slot)} + 30px)` };
}

/** A caixinha (16px; 12px no computador baixo) com o que fica em cima dela. */
function Crate({ crate, highlighted }: { crate: FlowCrate; highlighted: boolean }) {
  const { state, fill, dashed } = crate;
  const error = state === "error";
  const dusty = state === "forgotten";
  const over: ReactNode[] = [];
  if (state === "running" || state === "paused") {
    if (state === "running") over.push(<span key="ring" aria-hidden className="ah-dot absolute -inset-1 rounded-[7px] shadow-[0_0_0_1.5px_rgb(var(--st-run)/0.75)]" />);
    over.push(
      <span key="mark" aria-hidden className={cn("absolute left-px", ABOVE_CRATE, state === "paused" && "opacity-[.45]")}>
        <AgentMark kind={crate.conducted ? "condutor" : "execucao"} size={14} animated={state === "running"} />
      </span>,
    );
  }
  if (state === "waiting") {
    over.push(<span key="w" aria-hidden title="Vaga de condutor livre" className={cn("absolute left-px h-3.5 w-3.5 rounded-[4px] border-[1.5px] border-dashed border-crate-line", ABOVE_CRATE)} />);
  }
  if (state === "attention" || error) {
    over.push(<span key="dot" aria-hidden className={cn("absolute -right-1 -top-1 h-[9px] w-[9px] rounded-full ring-2 ring-well", error ? "bg-st-err" : "bg-st-attn")} />);
  }
  if (highlighted) over.push(<span key="hl" aria-hidden className="absolute -inset-[5px] rounded-[7px] shadow-[0_0_0_2px_rgb(var(--fg))]" />);
  return (
    <span className={cn("relative block", CRATE_BOX)}>
      <span
        className={cn(
          "relative block overflow-hidden rounded-[4px] border-[1.5px]",
          CRATE_BOX,
          dashed ? "border-dashed" : "border-solid",
          error ? "border-st-err bg-st-err/10" : dashed ? "border-crate-line/80 bg-surface" : "border-crate-line bg-surface",
          dusty && "opacity-[.55]",
        )}
      >
        {!dusty && fill > 0 && (
          <span aria-hidden className={cn("absolute inset-x-0 bottom-0", error ? "bg-st-err/35" : "bg-crate-fill")} style={{ height: `${fill * 100}%` }} />
        )}
      </span>
      {over}
    </span>
  );
}

/** A pilha do No ar: um quadradinho por item no ar, até 24 (os de hoje em azul, os últimos); raia vazia = poço vazio.
 *  12px no computador alto e no celular, 8px no baixo — sempre 8 por fileira, no chão das caixinhas. */
function LivePile({ total, today }: { total: number; today: number }) {
  const N = Math.min(24, Math.max(0, total));
  if (!N) return null;
  const fresh = Math.min(N, today);
  return (
    <span
      title={`${total} no ar`}
      className="absolute bottom-[var(--flow-floor)] left-[18px] grid grid-cols-[repeat(8,var(--flow-pile))] gap-[var(--flow-pile-gap)]"
    >
      {Array.from({ length: N }, (_, i) => (
        <span key={i} aria-hidden className={cn("h-[var(--flow-pile)] w-[var(--flow-pile)] rounded-[3px]", i >= N - fresh ? "bg-st-new" : "bg-crate-pile")} />
      ))}
    </span>
  );
}

/** «Últimas 24 horas» — só as células com métrica real do board (o que não existe é omitido, nunca inventado). */
function DayPopover({ live }: { live: LiveSummary }) {
  return (
    <div className={cn(POPOVER_CLS, "absolute right-2 top-[var(--flow-day-top)] z-[15] flex w-[340px] max-w-[calc(100%-16px)] flex-col gap-3 p-3.5")}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[14px] font-semibold text-fg">Últimas 24 horas</span>
        {live.perDay != null && <span className="text-[12px] text-fg-subtle">vs. média de 7 dias</span>}
      </span>
      <div className="grid grid-cols-2 gap-3">
        <Cell label="Entrega" value={`${live.last24} no ar`} sub={live.perDay != null ? `média ${decimalWords(live.perDay)}/dia` : undefined} />
        {live.mix && <Cell label="Concluído" value={live.mix} />}
      </div>
    </div>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-[.04em] text-fg-subtle">{label}</span>
      <b className="text-[18px] font-semibold leading-tight text-fg">{value}</b>
      {sub && <span className="text-[12px] text-fg-muted">{sub}</span>}
    </span>
  );
}
