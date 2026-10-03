"use client";

// A LINHA DE ESTADO do card na tela — a MESMA no card do Kanban, no cabeçalho da página do card e na linha de
// «Acompanhar» do Inbox. Quem decide o texto é a régua pura (lib/storymap/card-live-status.ts); aqui só se juntam as
// fontes vivas (o SSE do RunnerStatusProvider), o tamanho do trabalho e o fuso do dono, e se desenha.

import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { cn } from "@/lib/cn";
import {
  cardLiveFactsFor,
  cardLiveText,
  diffWords,
  projectCardLiveStatus,
  type CardLiveFacts,
  type CardLiveStatus,
  type DiffStat,
} from "@/lib/storymap/card-live-status";
import { presenceTone, STATE_PULSE } from "@/lib/storymap/presence-tone";
import { cardInboxSignal } from "@/lib/storymap/inbox/card-signal";
import type { OwnerCardDecision } from "@/lib/storymap/inbox/decidir-set";
import { inboxItemHref } from "@/lib/storymap/deep-links";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { getCardsDiffStatsAction } from "@/app/actions";
import { useOwnerTimeZone } from "./OwnerTimeZone";
import { CardDiffModal, useCardLiveSources } from "./RunnerStatusProvider";
import { BoardLiveContext, OwnerDecisionsContext } from "./OwnerDecisionsContext";

// ── o tamanho do trabalho já integrado: UMA chamada por board, agrupada ───────────────────────────────

type DiffKey = string; // `${board}/${cardId}@${versão das fontes}`
const diffResults = new Map<DiffKey, DiffStat | null>();
const diffPending = new Map<string, Map<string, DiffKey>>(); // board → cardId → key
const diffListeners = new Set<() => void>();
let diffTimer: ReturnType<typeof setTimeout> | null = null;
let diffVersion = 0;

function flushDiffs() {
  diffTimer = null;
  const batches = [...diffPending];
  diffPending.clear();
  for (const [board, byCard] of batches) {
    void getCardsDiffStatsAction({ board, cardIds: [...byCard.keys()] }).then((res) => {
      for (const [cardId, key] of byCard) diffResults.set(key, res.ok ? (res.data?.[cardId] ?? null) : null);
      diffVersion++;
      for (const fn of diffListeners) fn();
    });
  }
}

function requestDiff(board: string, cardId: string, key: DiffKey) {
  if (diffResults.has(key)) return;
  let byCard = diffPending.get(board);
  if (!byCard) diffPending.set(board, (byCard = new Map()));
  if (byCard.get(cardId) === key) return;
  byCard.set(cardId, key);
  if (!diffTimer) diffTimer = setTimeout(flushDiffs, 80);
}

const subscribeDiffs = (fn: () => void) => {
  diffListeners.add(fn);
  return () => diffListeners.delete(fn);
};

/**
 * O tamanho do trabalho durável do card (execução no diário, revisão ou integração) — agrupado com todos os cards
 * montados do board numa chamada só. `null` enquanto não mediu ou quando não há trabalho. A chave carrega a versão das
 * fontes: um card que integrou de novo é remedido.
 */
function useIntegratedDiff(boardId: string, card: Card, hasRunSession: boolean): DiffStat | null {
  const want = hasRunSession || !!card.commitRange || !!card.diffSnapshot;
  const key = `${boardId}/${card.id}@${card.diffSnapshot?.mergeCommit ?? ""}|${card.commitRange?.head ?? ""}|${hasRunSession ? card.status : ""}`;
  useSyncExternalStore(subscribeDiffs, () => diffVersion, () => 0);
  useEffect(() => {
    if (want) requestDiff(boardId, card.id, key);
  }, [want, boardId, card.id, key]);
  return want ? (diffResults.get(key) ?? null) : null;
}

// ── a projeção, com as fontes vivas ────────────────────────────────────────────────────────────────────

type LiveSources = Pick<ReturnType<typeof useCardLiveSources>, "snapshot" | "mergeQueue" | "cardLive" | "terminals">;

/**
 * A linha de UM card, dos fatos vivos (sem o tamanho do trabalho já integrado, que é por card e chega depois). A
 * decisão do dono vem do Decidir do board quando a tela o tem; senão do MESMO modelo do Inbox (cardInboxSignal), com a
 * exceção de sempre: numa etapa da entrega (ou já no ar) a decisão ROTINEIRA de avançar é o botão da própria etapa.
 */
function liveStatusOf(
  boardId: string,
  card: Card,
  config: BoardConfig,
  src: LiveSources,
  owner: ReadonlyMap<string, OwnerCardDecision> | undefined,
  now: number,
): CardLiveStatus | null {
  let ownerDecision: CardLiveFacts["ownerDecision"] = null;
  if (owner) {
    const d = owner.get(card.id);
    ownerDecision = d ? { label: d.what, itemId: d.itemId } : null;
  } else if (card.type === "story") {
    const def = config.statuses.find((s) => s.id === card.status);
    const laneRoutine = !!def?.terminal || !!def?.laneStep;
    const signal = cardInboxSignal(card, config, boardId, { now, exclude: (kind) => laneRoutine && kind === "gate" });
    ownerDecision = signal ? { label: signal.label, itemId: signal.itemId } : null;
  }
  const facts = cardLiveFactsFor(boardId, card.id, {
    running: src.snapshot.running,
    failures: src.snapshot.failures,
    mergeEntries: src.mergeQueue?.entries,
    feed: src.cardLive,
    terminals: src.terminals,
  });
  return projectCardLiveStatus(card, config, { ...facts, ownerDecision }, now);
}

/** O relógio da linha: anda a cada 30 s só quando há hora para mostrar («há 12 min»). */
function useLiveClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
}

/**
 * As linhas de estado de todos os `cards` do board, de UMA vez e no MESMO instante — a fonte da legenda, do pulso do
 * Kanban, das seções da raia e de cada card (via {@link BoardLiveProvider}). Duas contas separadas (uma na raia, uma no
 * card) discordavam na fronteira dos 2 min.
 */
export function useBoardLiveStatuses(
  boardId: string,
  cards: readonly Card[],
  config: BoardConfig,
  owner: ReadonlyMap<string, OwnerCardDecision>,
): ReadonlyMap<string, CardLiveStatus | null> {
  const { snapshot, mergeQueue, cardLive, terminals } = useCardLiveSources();
  const [ticking, setTicking] = useState(false);
  const now = useLiveClock(ticking);
  const map = useMemo(() => {
    const src = { snapshot, mergeQueue, cardLive, terminals };
    return new Map(cards.map((c) => [c.id, liveStatusOf(boardId, c, config, src, owner, now)] as const));
  }, [boardId, cards, config, snapshot, mergeQueue, cardLive, terminals, owner, now]);
  const anyClock = useMemo(() => [...map.values()].some((s) => s != null && (s.since != null || s.until != null)), [map]);
  useEffect(() => setTicking(anyClock), [anyClock]);
  return map;
}

/**
 * A linha de estado de um card. Dentro do Kanban ela vem pronta do board ({@link useBoardLiveStatuses}); fora dele
 * (a página do card, a linha do Inbox) é calculada aqui. Nos dois casos, o tamanho do trabalho já integrado entra por
 * cima, agrupado com os outros cards montados numa chamada só.
 */
export function useCardLiveStatus(boardId: string, card: Card, config: BoardConfig): CardLiveStatus | null {
  const board = useContext(BoardLiveContext);
  const { snapshot, mergeQueue, cardLive, terminals, sessionByKey } = useCardLiveSources();
  const owner = useContext(OwnerDecisionsContext);
  const integratedDiff = useIntegratedDiff(boardId, card, !!sessionByKey[`${boardId}/${card.id}`]);
  const fromBoard = board?.has(card.id) ? board.get(card.id)! : undefined;
  const [ticking, setTicking] = useState(false);
  const now = useLiveClock(fromBoard === undefined && ticking);
  const own = useMemo(
    () => (fromBoard === undefined ? liveStatusOf(boardId, card, config, { snapshot, mergeQueue, cardLive, terminals }, owner, now) : null),
    [fromBoard, boardId, card, config, snapshot, mergeQueue, cardLive, terminals, owner, now],
  );
  const status = fromBoard === undefined ? own : fromBoard;
  useEffect(() => setTicking(status != null && (status.since != null || status.until != null)), [status]);
  return useMemo(() => (status && !status.diff && integratedDiff ? { ...status, diff: integratedDiff } : status), [status, integratedDiff]);
}

/** O ponto da linha, na forma e na cor da presença (presence-tone.ts) — a única cor operacional do card. */
function PresenceDot({ status, className }: { status: CardLiveStatus; className?: string }) {
  const tone = presenceTone(status);
  if (tone.mark === "none") return null;
  return <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", tone.dot, tone.pulse && STATE_PULSE, className)} aria-hidden />;
}

/** O filete à esquerda do card do Kanban, pela MESMA presença (transparente quando nada vive). */
export function cardLiveRail(status: CardLiveStatus | null): string {
  return status ? presenceTone(status).rail : "bg-transparent";
}

/** «+442 −8 · 14 arquivos» — abre o diff (a mesma janela de sempre). */
function DiffChip({ boardId, cardId, diff }: { boardId: string; cardId: string; diff: DiffStat }) {
  const [open, setOpen] = useState(false);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <button
        type="button"
        title="Ver o que mudou no código"
        aria-label={`Ver o que mudou: ${diff.additions} linhas a mais, ${diff.deletions} a menos, em ${diff.files} arquivos`}
        onPointerDown={stop}
        onClick={(e) => {
          stop(e);
          setOpen(true);
        }}
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded font-semibold tabular-nums text-fg-subtle transition hover:text-fg"
      >
        {/* Sem verde/vermelho: verde é só «No ar» e terracota só «falhou» — o sinal +/− já diz o que é. */}
        <span className="text-fg-muted">+{diff.additions}</span>
        <span className="text-fg-muted">−{diff.deletions}</span>
        <span className="font-normal">· {diff.files === 1 ? "1 arquivo" : `${diff.files} arquivos`}</span>
      </button>
      {open && createPortal(<CardDiffModal board={boardId} cardId={cardId} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/**
 * A linha desenhada. `card` = o card do Kanban (compacta, a nota numa segunda linha discreta); `header` = o cabeçalho
 * da página do card (maior); `row` = a linha do Inbox (uma linha só). Nada vivo e nada provado ⇒ nada.
 */
export function CardLiveStatusLine({
  boardId,
  card,
  config,
  variant = "card",
  status: given,
  className,
}: {
  boardId: string;
  card: Card;
  config: BoardConfig;
  variant?: "card" | "header" | "row";
  /** a linha já resolvida pelo host (o card do Kanban a usa também para o filete) — evita resolver duas vezes. */
  status?: CardLiveStatus | null;
  className?: string;
}) {
  if (given !== undefined) return <CardLiveStatusView boardId={boardId} card={card} status={given} variant={variant} className={className} />;
  return <CardLiveStatusLive boardId={boardId} card={card} config={config} variant={variant} className={className} />;
}

function CardLiveStatusLive({ boardId, card, config, variant, className }: { boardId: string; card: Card; config: BoardConfig; variant: "card" | "header" | "row"; className?: string }) {
  const status = useCardLiveStatus(boardId, card, config);
  return <CardLiveStatusView boardId={boardId} card={card} status={status} variant={variant} className={className} />;
}

function CardLiveStatusView({
  boardId,
  card,
  status,
  variant,
  className,
}: {
  boardId: string;
  card: Card;
  status: CardLiveStatus | null;
  variant: "card" | "header" | "row";
  className?: string;
}) {
  const timeZone = useOwnerTimeZone();
  const [now, setNow] = useState(() => Date.now());
  const ticking = status != null && (status.since != null || status.until != null);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [ticking, status]);
  if (!status) return null;
  const line = cardLiveText(status, now, timeZone);
  const full = [line, status.note, status.diff ? diffWords(status.diff) : null].filter(Boolean).join("\n");
  const big = variant === "header";

  // A linha do Inbox mora DENTRO do botão da linha: nada interativo aqui (nem link, nem o botão do diff).
  if (variant === "row") {
    return (
      <span className={cn("flex min-w-0 items-center gap-1.5 text-[12px]", className)} title={full}>
        <PresenceDot status={status} />
        <span className={cn("min-w-0 truncate font-medium", presenceTone(status).text)}>{line}</span>
        {status.diff && <span className="shrink-0 tabular-nums text-fg-subtle">{diffWords(status.diff)}</span>}
      </span>
    );
  }

  // PRECISA DE VOCÊ — o âmbar PREENCHIDO, o mesmo do chip do Inbox no nav (era uma pílula preta, que nenhuma outra
  // tela usava). A frase QUEBRA em até duas linhas em vez de cortar: «Publicar a parte de «…»» cortada no meio não
  // dizia o quê.
  if (status.kind === "owner" && status.itemId) {
    return (
      <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
        <Link
          href={inboxItemHref(boardId, status.itemId)}
          onClick={(e) => e.stopPropagation()}
          title={`${status.label}\nResolver no Inbox`}
          className={cn(
            "inline-flex max-w-full items-center rounded-md bg-state-owner font-semibold leading-snug text-state-owner-fg transition hover:bg-state-owner/85",
            big ? "px-2.5 py-1 text-[12px]" : "px-2 py-1 text-[11px]",
          )}
        >
          <span className="line-clamp-2 break-words">{status.label}</span>
        </Link>
        {status.diff && <DiffChip boardId={boardId} cardId={card.id} diff={status.diff} />}
      </div>
    );
  }

  return (
    // Sem `role=status` por card: com 60 cards na tela, 60 regiões vivas faziam o leitor de tela anunciar o board inteiro
    // a cada quadro do SSE. A contagem viva do board (KanbanPulse) é o único anúncio.
    <div className={cn("min-w-0", big ? "text-[12.5px]" : "text-[11.5px]", className)} title={full}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        {/* a frase QUEBRA em vez de cortar: no celular o card tem ~160px, e «Esperando a janela de ações · volta às…» cortado
            esconde justamente a hora da volta */}
        <span className="flex min-w-0 items-start gap-1.5">
          <PresenceDot status={status} className="mt-[5px]" />
          <span className={cn("min-w-0 break-words font-medium leading-snug", presenceTone(status).text)}>{line}</span>
        </span>
        {status.diff && <DiffChip boardId={boardId} cardId={card.id} diff={status.diff} />}
      </div>
      {status.note && (
        <p className={cn("mt-0.5 text-fg-subtle", big ? "text-[12px]" : "line-clamp-1 pl-[13px] text-[11px]")}>{status.note}</p>
      )}
    </div>
  );
}
