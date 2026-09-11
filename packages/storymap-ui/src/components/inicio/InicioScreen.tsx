"use client";

// The "Início Agêntico" home body. Board-scoped (the design's header IS BoardHeader — board switcher,
// view nav, Runs + Claude% meters, Capturar, and the Jido copilot chip). Three groups, each a slim
// read-only projection over an existing subsystem, each item clicking through to its own dedicated
// page: the attention inbox (Inbox) → a per-item page, the terminals → /processes or ttyd, the
// kanban feed → the card page. On a wide screen the Jido sits DOCKED in a permanent right rail
// instead of behind the drawer. The board layout already wraps this in ONE RunnerStatusProvider, so
// the live badges/hooks share a single SSE.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sharedEventSource } from "@/lib/sse-bus";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useRouter } from "next/navigation";
import { BoardHeader } from "@/components/BoardHeader";
import { ToastProvider } from "@/components/Toast";
import { CopilotChatPanel } from "@/components/CopilotChat";
import { SmartCaptureModal } from "@/components/SmartCaptureModal";
import { InboxPanel } from "@/components/inicio/InboxPanel";
import { TerminalsPanel } from "@/components/inicio/TerminalsPanel";
import { KanbanFeed } from "@/components/inicio/KanbanFeed";
import { JidoRailGhost } from "@/components/inicio/JidoRailGhost";
import type { CopilotSeed } from "@/lib/storymap/copilot/escalation-seed";
import type { CockpitItem } from "@/lib/storymap/demands";
import type { Board, BoardSummary } from "@/lib/storymap/types";
import type { RunningService } from "@/lib/vps/types";

/** `lg` in tailwind.config — the width below which the rail gives way to the drawer. */
const RAIL_MIN_WIDTH = "(min-width: 1024px)";

/** Quanto tempo depois de a rolagem parar a barra apaga. Longo o bastante para atravessar a pausa
 *  entre dois giros da roda (apagar no meio de uma rolagem contínua pisca), curto o bastante para a
 *  tela em repouso ser uma tela em repouso. */
const SCROLL_FADE_MS = 900;

// Q6 — the coarse 30s `now` clock below re-renders InicioScreen every tick, but only InboxPanel reads `now`.
// InboxPanel lives in its own file (so the clock can't be pushed down INTO it from here), so we memo the two
// heavy neighbours instead: their props are stable across a tick (services / config / cards / attentionCardIds
// don't change when only `now` does), so memo spares them the clock's re-render. They still re-render when the
// real data changes — router.refresh() hands them new props.
const TerminalsPanelMemo = memo(TerminalsPanel);
const KanbanFeedMemo = memo(KanbanFeed);

// A regra "o rail MONTA por JS, o layout reserva por CSS" mora em `lib/useMediaQuery` — uma definição só.
// Ela existia em triplicata (aqui, no BoardHeader e no ChatDock): três cópias da MESMA régua de breakpoint,
// que é exatamente como o esqueleto e a página real acabam reservando larguras diferentes (o `loading.tsx`
// desta rota já avisava disso a respeito do fantasma).

export function InicioScreen({
  board,
  boards,
  cockpitItems,
  seenItemIds,
  services,
}: {
  board: Board;
  boards: BoardSummary[];
  /** TODOS os itens que pedem o operador — o Inbox da home nunca esconde (ver inbox-seen.ts). */
  cockpitItems: CockpitItem[];
  /** os que ele já folheou no carrossel: vira o ✓ do cartão, nunca um filtro. */
  seenItemIds: string[];
  services: RunningService[];
}) {
  const router = useRouter();
  const config = board.config;
  const railVisible = useMediaQuery(RAIL_MIN_WIDTH);
  const mainRef = useRef<HTMLElement>(null);
  const [railSeed, setRailSeed] = useState<CopilotSeed | null>(null);
  // "Capturar" is the header's PRIMARY action in the design, and CaptureMenu renders nothing unless a
  // host wires it — so without this the home was the one view whose main button silently vanished.
  const [smartOpen, setSmartOpen] = useState(false);

  // ONE coarse clock for the whole screen, stamped on mount (0 during SSR, so a local-timezone age
  // is never computed on the server and hydration can't mismatch) and nudged every 30s so the "8min"
  // ages don't rot while the operator reads. The terminals group keeps its own 1s clock — only its
  // elapsed counters need sub-minute resolution, and ticking everything at 1Hz would be wasteful.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Com o rail docado é o CONTEÚDO que rola, e a barra nativa ficava acesa a viagem toda ao lado do
  // filete que separa a home do Jido — duas réguas verticais para uma divisão só. `data-scrolling`
  // acende a barra no evento e apaga depois da pausa; o desenho dela mora em `.quiet-scroll`
  // (globals.css). Aqui fica só o RELÓGIO — o CSS não tem como saber que a rolagem parou.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      el.dataset.scrolling = "true";
      clearTimeout(t);
      t = setTimeout(() => delete el.dataset.scrolling, SCROLL_FADE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Any board mutation (ask/answer/move/finding, a run starting/finishing) may change any of the three
  // groups; ONE debounced router.refresh() re-runs the server page and re-seeds all of them at once —
  // the same shared-SSE refresh CockpitView uses. The terminals group additionally self-polls for the
  // sub-second liveness the SSE bus doesn't carry.
  useEffect(() => {
    const es = sharedEventSource("/api/notifications/stream");
    let t: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(t);
      t = setTimeout(() => router.refresh(), 400);
    };
    es.addEventListener("agileharness", refresh as EventListener);
    return () => {
      clearTimeout(t);
      es.close();
    };
  }, [router]);

  // The feed's "aguardando você" state is the SAME truth the inbox shows — derived from one list, so a
  // card can never be amber in one group and grey in the other.
  const attentionCardIds = useMemo(
    () => new Set(cockpitItems.map((it) => it.cardId).filter((id): id is string => !!id)),
    [cockpitItems],
  );

  // Handed to BoardHeader ONLY while the rail is really mounted: it is what tells the header to stand
  // down and route a `?copilot=` escalation here instead of opening its own drawer. Memoized because
  // the header keys an effect on this object.
  const focusRail = useCallback(() => {
    document.getElementById("jido-rail")?.scrollIntoView({ block: "nearest" });
  }, []);
  const dockedCopilot = useMemo(
    () => (railVisible ? { onSeed: setRailSeed, onFocus: focusRail } : undefined),
    [railVisible, focusRail],
  );

  return (
    // ToastProvider, like every other view: the feed's row actions (mover, rodar) report through it.
    <ToastProvider>
      {/* With the rail docked the page owns the viewport and the CONTENT scrolls, so the chat's pinned
          composer stays put; without it, the document scrolls as before.

          Isto é decidido por CSS (`lg:`), não por `railVisible`, embora as duas réguas sejam a MESMA
          largura (RAIL_MIN_WIDTH === o breakpoint `lg`). O motivo é que `railVisible` só fica verdadeiro
          DEPOIS do mount, e até lá o contêiner ficava com altura indefinida (`min-h-screen`) — contra a
          qual o `h-full` do rail não resolve, então ele nascia do tamanho do conteúdo e esticava para a
          tela inteira um instante depois. Layout por CSS, montagem por JS: o `railVisible` continua
          mandando em QUEM MONTA (o chat não pode existir duas vezes), que é a razão de ele existir. */}
      <div className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:overflow-hidden">
        <BoardHeader
          boards={boards}
          config={config}
          view="inicio"
          dockedCopilot={dockedCopilot}
          onSmartCapture={() => setSmartOpen(true)}
        />

        <div className="flex min-h-0 flex-1">
          <main
            ref={mainRef}
            className="quiet-scroll mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-24 md:px-6 md:pb-8 lg:overflow-y-auto"
          >
            {/* Top zone — o que pede você + os terminais, lado a lado no desktop, empilhados no mobile. */}
            {/* `minmax(0,1fr)` TAMBÉM na base (não só no lg): um item de grid nasce com
                `min-width:auto`, então uma linha de log nowrap dentro dos Terminais esticava a
                coluna única do celular para 441px — a home inteira rolava na horizontal (e o
                `truncate` dos filhos, sem pai limitado, nunca truncava). */}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
              <InboxPanel
                boardId={config.id}
                config={config}
                cards={board.cards}
                items={cockpitItems}
                seenItemIds={seenItemIds}
                now={now}
              />
              {/* `boards` é o vocabulário do seletor de board dos terminais — a MESMA lista que o
                  switcher do cabeçalho já recebe do servidor, então vincular um terminal não custa
                  nenhuma busca extra. */}
              <TerminalsPanelMemo
                boardId={config.id}
                boardName={config.name}
                boards={boards}
                initialServices={services}
              />
            </div>

            {/* O fluxo do kanban, agrupado por estágio — cada card abre sua página dedicada. */}
            <div className="mt-8">
              <KanbanFeedMemo
                boardId={config.id}
                config={config}
                cards={board.cards}
                attentionCardIds={attentionCardIds}
              />
            </div>
          </main>

          {/* Antes do rail existir, o LUGAR dele. `railVisible` só pode ser lido depois do mount
              (`matchMedia`), então no primeiro quadro o desktop desenhava a home com a largura
              inteira e, um instante depois, os 492px entravam e empurravam tudo para a esquerda —
              a home "assentando" a cada visita. O fantasma reserva a coluna por CSS (`hidden
              lg:flex`, sem esperar hidratação) e não monta chat nenhum, que é justamente por que o
              rail é decidido por JS e não por CSS. */}
          {!railVisible && <JidoRailGhost />}

          {/* O Jido, ancorado. Sem `onClose`: é painel permanente, não gaveta — não tem X nem ESC. */}
          {railVisible && (
            <aside
              id="jido-rail"
              aria-label="Jido"
              // `py-3` (era `p-4`): a moldura do rail é a última coisa que pode gastar altura numa tela de
              // notebook — o conteúdo do chat é que tem de crescer. Nas laterais o respiro fica.
              className="flex h-full w-[492px] shrink-0 flex-col border-l border-line bg-canvas px-4 py-3"
            >
              {/* O chat é um CARTÃO dentro do rail (como no design), não uma parede colada: a moldura
                  é o que o separa do feed à esquerda sem precisar de uma segunda régua vertical. */}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-line shadow-[0_1px_3px_rgba(15,15,15,0.05)]">
                <CopilotChatPanel
                  boardId={config.id}
                  boardName={config.name}
                  seed={railSeed ?? undefined}
                />
              </div>
            </aside>
          )}
        </div>

        {smartOpen && (
          <SmartCaptureModal
            boardId={config.id}
            config={config}
            cards={board.cards}
            onClose={() => {
              setSmartOpen(false);
              router.refresh();
            }}
            onCreated={() => router.refresh()}
            onOpenCard={(id) => router.push(`/board/${config.id}/card/${id}`)}
            onOpenIdeas={() => router.push(`/board/${config.id}/ideias`)}
          />
        )}
      </div>
    </ToastProvider>
  );
}
