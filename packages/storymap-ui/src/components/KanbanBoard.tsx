"use client";

// O KANBAN — o quadro por FUNCIONALIDADE com o fluxo como cabeçalho (desenho 6a da fase 1).
//
// Três faixas, de cima para baixo: os controles (a barra do topo + a 2ª barra do Kanban: ritmo · atividade · busca ·
// Mostrar), ONDE está cada coisa (o trecho do fluxo em cima de cada raia, com uma caixinha por item) e O QUE FAZER (os
// cards). Cada informação aparece uma vez só: o nome e o total da raia moram no trecho do fluxo, que é o cabeçalho
// da coluna; o card mostra a funcionalidade e o item que anda nela; «precisa de você» é estado do card, não raia.
//
// As raias são as do board (`view.lanes`; o `_base` declara as seis do desenho; quem não declara ganha uma raia por
// coluna). A Entrega mostra o TREM — o que está nele fica só no fluxo e no trem; o que espera FORA dele (a aprovação
// do dono, um erro) aparece como card embaixo — e o No ar mostra o que chegou desde a sua última visita (a chegada é a
// transição para o status terminal, do ledger — nunca a última escrita do card). O padrão do «Mostrar» é
// EXCEÇÕES: cards só para o que roda, deu erro, precisa de você ou está pausado — o resto são caixinhas no fluxo.
//
// O ESTADO de cada item sai de UMA régua: a linha de estado viva (useBoardLiveStatuses → card-live-status.ts), o
// Decidir do Inbox (useOwnerDecisions) e o ritmo do board — reduzidos em kanban-features.ts `designState`. O quadro só
// guarda o que é da tela: a busca (na URL), o recorte, o item aceso e o popover aberto. Sem arrastar nesta fase: mover
// um card é pedido ao Jido pelo menu do card.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { kanbanStories } from "@/lib/storymap/views";
import type { OwnerDecisions } from "@/lib/storymap/inbox/decidir-set";
import { matchesCardQuery } from "@/lib/storymap/kanban-filter";
import {
  crateDashed,
  crateFill,
  crateProgress,
  DELIVERY_CRATES,
  featureTitleHref,
  flowCaption,
  groupByFeature,
  kanbanLanes,
  kindOf,
  laneIndexOf,
  laneStep,
  matchesShowMode,
  mixLabel,
  p5place,
  quietBoardWords,
  quietLaneWords,
  showModeCounts,
  visibleEntries,
  type FlowState,
  type KanbanLane as LaneDef,
} from "@/lib/storymap/kanban-features";
import { isConducted, resolveConductorPolicy } from "@/lib/storymap/driver";
import { agentPulse } from "@/lib/storymap/agent-presence";
import { cardHref, inboxHref } from "@/lib/storymap/deep-links";
import { featureCtx, type FeatureNameRef } from "@/lib/storymap/feature-key";
import type { CardMetrics } from "@/lib/storymap/runner/telemetry";
import type { Board, BoardSummary, Card } from "@/lib/storymap/types";
import { getBoardMetricsAction } from "@/app/actions";
import { getLiveArrivalsAction } from "@/app/activity-actions";
import { BoardHeader } from "./BoardHeader";
import { useBoardLiveStatuses } from "./CardLiveStatus";
import { BoardLiveProvider, OwnerDecisionsProvider, ownerByCard } from "./OwnerDecisionsContext";
import { useOwnerTimeZone } from "./OwnerTimeZone";
import { useAgentPresence, useMergeQueue } from "./RunnerStatusProvider";
// O relógio do quadro (o «há X», o esquecido, o «hoje» do No ar): 0 no servidor e no 1º render — a hidratação não
// discorda de um «3 min» × «4 min» —, carimbado no mount. Com 0, as idades somem e ninguém é «esquecido».
import { useNow } from "./inbox/useNow";
import { useKanbanFilter } from "./KanbanSearchBar";
import { ToastProvider } from "./Toast";
import { FeatureCard } from "./kanban/FeatureCard";
import { DotList, FlowSegment, type FlowCrate, type LiveSummary } from "./kanban/FlowBand";
import { KanbanLane } from "./kanban/KanbanLane";
import { KANBAN_DEFAULT_MODE, KanbanToolbar, isKanbanShowMode, type KanbanShowMode } from "./kanban/KanbanToolbar";
import { useKanbanBoardPace } from "./kanban/KanbanPaceControl";
import { LiveColumn } from "./kanban/LiveColumn";
import { boardTrain, TrainColumn, trainAvgMinutes } from "./kanban/TrainColumn";
import { flowStatesOf, useOwnerDecisions } from "./kanban/use-flow-states";

// Q2 — SmartCaptureModal renders only behind a runtime guard ({capture}), so load its chunk lazily (client-only)
// instead of eagerly with the board. The guard already gates mounting; this just defers the download until it opens.
// Quem a abre é o `/criar` do compositor do Jido (via BoardHeader `onSmartCapture`): este modal leva os cards do board.
const SmartCaptureModal = dynamic(() => import("./SmartCaptureModal").then((m) => m.SmartCaptureModal), { ssr: false });

const DAY = 86_400_000;
const METRICS_POLL_MS = 5 * 60_000;

/** As funcionalidades do PRD do board (id + nome) e se a 1ª passada da âncora já terminou — a chave dos cards. */
export interface KanbanFeatures {
  /** vazio ⇒ o board não tem funcionalidades no PRD: os cards se agrupam pelo passo do mapa (o modo antigo). */
  list: FeatureNameRef[];
  anchoredOnce: boolean;
}

const NO_FEATURES: KanbanFeatures = { list: [], anchoredOnce: false };

export function KanbanBoard({
  board,
  boards,
  owner,
  features = NO_FEATURES,
}: {
  board: Board;
  boards: BoardSummary[];
  owner: OwnerDecisions | null;
  features?: KanbanFeatures;
}) {
  // RunnerStatusProvider wraps the whole board via app/board/[boardId]/layout.tsx (one SSE connection for every view).
  // Only Toast is local.
  return (
    <ToastProvider>
      <KanbanBoardInner board={board} boards={boards} initialOwner={owner} features={features} />
    </ToastProvider>
  );
}

/** O custo e os turnos de cada card (a telemetria do board, UMA leitura em lote). Falhou ⇒ sem números, nunca erro. */
function useBoardMetrics(boardId: string): ReadonlyMap<string, CardMetrics> {
  const [byCard, setByCard] = useState<ReadonlyMap<string, CardMetrics>>(new Map());
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await getBoardMetricsAction({ boardId }).catch(() => null);
      if (alive && r?.ok && r.data) setByCard(new Map(r.data.summary.cards.map((m) => [m.cardId, m] as const)));
    };
    void load();
    const t = setInterval(() => void load(), METRICS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [boardId]);
  return byCard;
}

/**
 * QUANDO cada card chegou ao ar (a transição para o status terminal, do ledger — getLiveArrivalsAction), relido a
 * cada mudança do conjunto de cards no ar e a cada 5 min. Sem leitura ainda (ou falhou) ⇒ mapa vazio: a raia No ar e o
 * resumo omitem os números em vez de usar a última escrita do card.
 */
function useLiveArrivals(boardId: string, liveKey: string): ReadonlyMap<string, number> {
  const [byCard, setByCard] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await getLiveArrivalsAction(boardId).catch(() => null);
      if (alive && r?.ok) setByCard(new Map(Object.entries(r.data)));
    };
    void load();
    const t = setInterval(() => void load(), METRICS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [boardId, liveKey]);
  return byCard;
}

const dayKey = (at: number, timeZone?: string) => new Date(at).toLocaleDateString("pt-BR", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

/** O resumo da raia No ar: hoje, nas 24 h, a média dos 7 dias e a mistura do que chegou. A chegada é a transição para
 *  o status terminal (`arrivals`, do ledger). Sem nenhum card datado, a média é omitida. */
function liveSummaryOf(cards: readonly Card[], arrivals: ReadonlyMap<string, number>, now: number, timeZone?: string): LiveSummary {
  const today = dayKey(now, timeZone);
  const dated = cards.flatMap((c) => {
    const at = arrivals.get(c.id);
    return at != null ? [{ c, at }] : [];
  });
  const last24 = dated.filter((d) => now - d.at <= DAY).map((d) => d.c);
  const week = dated.filter((d) => now - d.at <= 7 * DAY).length;
  const kinds = { n: 0, c: 0, k: 0 };
  for (const c of last24) {
    const k = kindOf(c);
    if (k === "Correção") kinds.c++;
    else if (k === "Manutenção") kinds.k++;
    else kinds.n++;
  }
  return {
    today: dated.filter((d) => dayKey(d.at, timeZone) === today).length,
    last24: last24.length,
    perDay: dated.length ? week / 7 : null,
    mix: mixLabel(kinds.n, kinds.c, kinds.k),
    total: cards.length,
  };
}

function KanbanBoardInner({
  board,
  boards,
  initialOwner,
  features,
}: {
  board: Board;
  boards: BoardSummary[];
  initialOwner: OwnerDecisions | null;
  features: KanbanFeatures;
}) {
  const router = useRouter();
  const timeZone = useOwnerTimeZone();
  const [cards, setCards] = useState<Card[]>(board.cards);
  const [config, setConfig] = useState(board.config);
  const [capture, setCapture] = useState<{ initialText?: string } | null>(null);

  useEffect(() => {
    setCards(board.cards);
    setConfig(board.config);
  }, [board]);

  useEffect(() => {
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router]);

  const now = useNow(60_000);
  // Só as STORIES andam no quadro (passos e atividades são as funcionalidades); o adiado («não agora») fica fora.
  const stories = useMemo(() => kanbanStories(cards, config).filter((c) => !c.deferred), [cards, config]);
  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c] as const)), [cards]);

  const owner = useOwnerDecisions(config.id, initialOwner);
  const ownerMap = useMemo(() => ownerByCard(owner), [owner]);
  // As LINHAS DE ESTADO de todos os cards, uma vez: o estado do desenho, as caixinhas e cada card leem esta.
  const live = useBoardLiveStatuses(config.id, stories, config, ownerMap);
  const pace = useKanbanBoardPace(config.id);
  const paused = pace.view?.level === "paused" && pace.view.source !== "disarmed" && pace.view.source !== "organize-only";
  // desligado (nunca armado) ou só de organização: nada começa sozinho — o «o que vem a seguir» de quem está na fila
  const paceOff = pace.view?.source === "disarmed" || pace.view?.source === "organize-only";
  const pauseMode = pace.view?.mode ?? "drain";

  // Condutores trabalhando DE FATO neste board (a régua única da presença) e as vagas — do despacho, senão da config.
  const { presence } = useAgentPresence();
  const agentsUsed = agentPulse({ ...presence, agents: presence.agents.filter((a) => a.kind === "conductor") }, config.id).working;
  const slotFact = presence.slots.find((s) => s.board === config.id);
  const slots = slotFact?.max ?? resolveConductorPolicy(config)?.maxSessions ?? 0;

  const lanes = useMemo(() => kanbanLanes(config), [config]);
  const laneOfCard = useMemo(() => stories.map((c) => laneIndexOf(c.status, lanes, config)), [stories, lanes, config]);
  const byLane = useMemo(() => {
    const out: Card[][] = lanes.map(() => []);
    stories.forEach((c, k) => {
      const i = laneOfCard[k];
      if (i >= 0) out[i].push(c);
    });
    return out;
  }, [stories, lanes, laneOfCard]);

  // O estado do desenho de cada item: a MESMA redução da página da funcionalidade (kanban/use-flow-states.ts) — a
  // linha viva, o Decidir do Inbox e o ritmo, depois a vez pela raia.
  const states = useMemo(
    () =>
      flowStatesOf(
        stories,
        (c) => {
          const l = live.get(c.id) ?? null;
          return { live: l ? { kind: l.kind, presence: l.presence } : null, owner: ownerMap.has(c.id) };
        },
        { boardPaused: paused, pauseMode, now, lanes, laneOf: (_c, k) => laneOfCard[k], slots },
      ),
    [stories, live, ownerMap, paused, pauseMode, now, lanes, laneOfCard, slots],
  );
  const stateOf = useCallback((id: string): FlowState => states.get(id) ?? "queued", [states]);

  // A FUNCIONALIDADE de cada card: a do PRD (com «Outros (fora do PRD)» para o que não cabe em nenhuma); board sem
  // funcionalidades no PRD ⇒ o passo do mapa (feature-key.ts `featureKeyOf`, a MESMA chave do despacho do condutor).
  const featCtx = useMemo(() => featureCtx(cardsById, features.list, features.anchoredOnce), [cardsById, features]);
  const entries = useMemo(() => byLane.map((list) => groupByFeature(list, stateOf, featCtx)), [byLane, stateOf, featCtx]);

  // A BUSCA (na URL, a mesma de antes) procura no título do item e da funcionalidade; com texto, ela vence o recorte.
  const [filter, setFilter] = useKanbanFilter();
  const query = filter.q;
  const onQuery = useCallback((q: string) => setFilter({ ...filter, q }), [filter, setFilter]);
  // O RECORTE «Mostrar». O padrão é TUDO (decisão do dono, 07/10): abrir o board em «Exceções» deixava as colunas vazias
  // num board parado ou sem nada fora do trilho — estranho e inesperado. A escolha da pessoa fica lembrada por board,
  // neste navegador (preferência de quem vê, nunca estado do board); lida DEPOIS da montagem para não divergir do SSR.
  const [mode, setModeState] = useState<KanbanShowMode>(KANBAN_DEFAULT_MODE);
  const modeKey = `ah.kanban.mode.${config.id}`;
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(modeKey);
      if (saved && isKanbanShowMode(saved)) setModeState(saved);
    } catch {
      // armazenamento bloqueado (aba privada, política do navegador): segue o padrão
    }
  }, [modeKey]);
  const setMode = useCallback(
    (m: KanbanShowMode) => {
      setModeState(m);
      try {
        window.localStorage.setItem(modeKey, m);
      } catch {
        // idem: a escolha vale só nesta visita
      }
    },
    [modeKey],
  );
  const searching = query.trim().length > 0;
  const matchCtx = useMemo(() => ({ cardsById }), [cardsById]);
  const pass = useCallback(
    (c: Card) => (searching ? matchesCardQuery(c, query, matchCtx) : matchesShowMode(stateOf(c.id), mode)),
    [searching, query, matchCtx, stateOf, mode],
  );
  // O que está NO TREM não vira card (o trem o mostra na coluna Entrega): fica fora das contagens do «Mostrar», para o
  // número de cada recorte ser o que o recorte mostra.
  const mq = useMergeQueue();
  const trainIds = useMemo(() => new Set(boardTrain(mq?.entries, config.id).flatMap((e) => (e.cardId ? [e.cardId] : []))), [mq, config.id]);
  const counts = useMemo(() => showModeCounts(byLane.flat().filter((c) => !trainIds.has(c.id)).map((c) => stateOf(c.id))), [byLane, stateOf, trainIds]);
  // No recorte «Exceções», um board sem exceção nenhuma (pausado, ou tudo andando) parecia VAZIO — «Nada fora do
  // trilho» em toda coluna. Uma linha só, sob a barra, diz quantos itens andam e leva ao «Tudo». O No ar não conta
  // (já chegou); o que está no trem conta — ele anda. Com decisão do BOARD no Inbox (uma proposta para o PRD — o ícone
  // do Inbox diz «1»), a linha diz que nada nos CARDS precisa do dono e leva ao Inbox, em vez de «nada precisa de você».
  const inboxDecisions = owner?.total ?? 0;
  const quiet = useMemo(
    () =>
      mode === "exc" && !searching
        ? quietBoardWords(
            byLane.flatMap((list, i) => (lanes[i]?.role === "live" ? [] : list.map((c) => stateOf(c.id)))),
            inboxDecisions,
          )
        : null,
    [mode, searching, byLane, lanes, stateOf, inboxDecisions],
  );
  const showAll = useCallback(() => setMode("all"), [setMode]);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [popId, setPopId] = useState<string | null>(null);
  const metrics = useBoardMetrics(config.id);
  const terminalIds = useMemo(() => new Set(config.statuses.filter((s) => s.terminal === true).map((s) => s.id)), [config]);
  const liveKey = useMemo(
    () => stories.filter((c) => c.status != null && terminalIds.has(c.status)).map((c) => c.id).sort().join(","),
    [stories, terminalIds],
  );
  const arrivals = useLiveArrivals(config.id, liveKey);
  const avgTrain = useMemo(() => trainAvgMinutes(mq?.entries, config.id), [mq, config.id]);

  const hrefOf = useCallback((id: string) => cardHref(config.id, id), [config.id]);

  return (
    <OwnerDecisionsProvider value={ownerMap}>
      <BoardLiveProvider value={live}>
        {/* `--jido-fade`: o degradê do compositor do Jido (fixo no rodapé) sobe da cor do QUADRO, não da do papel. */}
        <div className="flex h-[100dvh] flex-col bg-board" style={{ "--jido-fade": "var(--board)" } as React.CSSProperties}>
          <BoardHeader
            boards={boards}
            config={config}
            view="kanban"
            onSmartCapture={(initialText) => setCapture({ initialText })}
            toolbar={
              <KanbanToolbar
                boardId={config.id}
                config={config}
                query={query}
                onQuery={onQuery}
                mode={mode}
                onMode={setMode}
                counts={counts}
                agentsUsed={agentsUsed}
                slots={slots}
                pace={pace}
                onFocusCard={(_id, title) => onQuery(title)}
              />
            }
          />

          {quiet && lanes.length > 0 && (
            <div className="flex-none border-b border-line-muted bg-board px-4 py-1.5 text-[12px] text-fg-subtle max-md:py-0.5">
              <DotList
                className={QUIET_CLIP}
                parts={[
                  <b key="t" className="font-semibold text-fg">
                    {quiet.text}
                  </b>,
                  quiet.inbox && (
                    <Link key="i" href={inboxHref(config.id)} className={QUIET_LINK}>
                      {quiet.inbox} <span aria-hidden>→</span>
                    </Link>
                  ),
                  quiet.rest,
                  <button key="a" type="button" onClick={showAll} className={QUIET_LINK}>
                    {quiet.link}
                  </button>,
                ]}
              />
            </div>
          )}

          {lanes.length === 0 ? (
            <p className="m-4 rounded-lg border border-dashed border-line p-4 text-[13px] text-fg-subtle">
              Este board não tem nenhum passo para o Kanban (board.yaml `statuses`) — o quadro não tem onde pôr os cards.
            </p>
          ) : (
            // Mais de seis raias declaradas (um `view.lanes` próprio e longo) não se espremem: cada coluna tem 220px no
            // mínimo e o quadro rola de lado. As derivadas nunca passam de seis (kanban-features `derivedLanes`).
            <div
              className={`flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden md:grid md:snap-none ${lanes.length > 6 ? "md:overflow-x-auto" : "md:overflow-x-hidden"}`}
              style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(${lanes.length > 6 ? "220px" : "0"}, 1fr))` }}
            >
              {lanes.map((lane, i) => (
                <LaneView
                  key={lane.id}
                  boardId={config.id}
                  lane={lane}
                  index={i}
                  lanes={lanes}
                  cards={byLane[i]}
                  entries={entries[i]}
                  config={config}
                  stateOf={stateOf}
                  live={live}
                  pass={pass}
                  searching={searching}
                  mode={mode}
                  onShowAll={showAll}
                  paused={paused}
                  paceOff={paceOff}
                  slots={slots}
                  now={now}
                  timeZone={timeZone}
                  avgTrain={avgTrain}
                  hoverId={hoverId}
                  onHover={setHoverId}
                  popId={popId}
                  onPop={setPopId}
                  onFind={onQuery}
                  hrefOf={hrefOf}
                  metrics={metrics}
                  cardsById={cardsById}
                  ownerMap={ownerMap}
                  query={matchCtx}
                  queryText={query}
                  trainIds={trainIds}
                  arrivals={arrivals}
                />
              ))}
            </div>
          )}

          {capture && (
            <SmartCaptureModal
              boardId={config.id}
              config={config}
              cards={cards}
              initialText={capture.initialText}
              onClose={() => {
                setCapture(null);
                router.refresh();
              }}
              // the modal owns the success UI (it stays open showing what was created); here we just refresh the board
              // behind it so the new cards show through.
              onCreated={() => router.refresh()}
              onOpenCard={(id) => router.push(`/board/${config.id}/card/${id}`)}
            />
          )}
        </div>
      </BoardLiveProvider>
    </OwnerDecisionsProvider>
  );
}

type LiveMap = ReturnType<typeof useBoardLiveStatuses>;

/** O atalho de texto (sublinhado, na tinta do texto) das linhas quietas — o mesmo na coluna e na linha do board. */
const QUIET_LINK =
  "rounded-sm text-fg underline decoration-line-emphasis underline-offset-2 transition hover:decoration-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-md:py-2.5";
/** A caixa das linhas quietas (DotList): corta o «·» do começo da linha só na horizontal, com 4px de folga para o anel
 *  de foco do atalho não ser cortado. */
const QUIET_CLIP = "-ml-1 overflow-x-clip pl-1";

/** Uma raia: o trecho do fluxo (as caixinhas, a legenda) em cima e, embaixo, os cards / o trem / o No ar. */
function LaneView({
  boardId,
  lane,
  index,
  lanes,
  cards,
  entries,
  config,
  stateOf,
  live,
  pass,
  searching,
  mode,
  onShowAll,
  paused,
  paceOff,
  slots,
  now,
  timeZone,
  avgTrain,
  hoverId,
  onHover,
  popId,
  onPop,
  onFind,
  hrefOf,
  metrics,
  cardsById,
  ownerMap,
  query,
  queryText,
  trainIds,
  arrivals,
}: {
  boardId: string;
  lane: LaneDef;
  index: number;
  lanes: readonly LaneDef[];
  cards: Card[];
  entries: ReturnType<typeof groupByFeature>;
  config: Board["config"];
  stateOf: (id: string) => FlowState;
  live: LiveMap;
  pass: (c: Card) => boolean;
  searching: boolean;
  mode: KanbanShowMode;
  /** troca o recorte global para «Tudo» (o atalho «ver os N itens» da coluna sem exceção). */
  onShowAll: () => void;
  paused: boolean;
  paceOff: boolean;
  slots: number;
  now: number;
  timeZone?: string;
  avgTrain: number | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  popId: string | null;
  onPop: (id: string | null) => void;
  onFind: (title: string) => void;
  hrefOf: (id: string) => string;
  metrics: ReadonlyMap<string, CardMetrics>;
  cardsById: ReadonlyMap<string, Card>;
  ownerMap: ReturnType<typeof ownerByCard>;
  query: { cardsById: ReadonlyMap<string, Card> };
  queryText: string;
  /** os cards que estão no trem deste board (a coluna Entrega os mostra no trem, não como card). */
  trainIds: ReadonlySet<string>;
  /** quando cada card chegou ao ar (epoch ms). */
  arrivals: ReadonlyMap<string, number>;
}) {
  const stepOf = useCallback((c: Card) => laneStep(c.status, lane, config), [lane, config]);

  // As caixinhas: a Entrega desenha as 14 primeiras, espalhadas, em 2 de altura; o No ar, a pilha; as outras, cada item
  // no seu progresso dentro da raia (7 colunas × até 3). O que não coube vira «+N» — nunca quem tem bolinha (precisa de
  // você, erro): a Entrega os põe primeiro nas 14, e o encaixe (p5place) os desenha antes dos quietos.
  const { crates, extra } = useMemo(() => {
    if (lane.role === "live") return { crates: [] as FlowCrate[], extra: 0 };
    const mk = (c: Card, p: number) => ({ id: c.id, p, state: stateOf(c.id), card: c, step: stepOf(c) });
    const dot = (c: Card) => (stateOf(c.id) === "attention" || stateOf(c.id) === "error" ? 0 : 1);
    const list =
      lane.role === "delivery"
        ? [...cards]
            .sort((a, b) => dot(a) - dot(b) || stepOf(b).index - stepOf(a).index || a.id.localeCompare(b.id))
            .slice(0, DELIVERY_CRATES)
            .map((c, k) => mk(c, 1 - k / (DELIVERY_CRATES - 1)))
        : cards.map((c) => mk(c, crateProgress(stepOf(c), stateOf(c.id))));
    const placed = p5place(list, 7, lane.role === "delivery" ? 2 : 3).map(
      (p): FlowCrate => ({
        card: p.item.card,
        state: p.item.state,
        step: p.item.step,
        live: live.get(p.item.id) ?? null,
        conducted: isConducted(p.item.card),
        fill: crateFill(index, p.item.step, lanes),
        dashed: crateDashed(index, p.item.state),
        findable: lane.role !== "live" && !(lane.role === "delivery" && trainIds.has(p.item.id)),
        auto: !!config.statuses.find((s) => s.id === p.item.card.status)?.trigger,
        slot: p.slot,
        lvl: p.lvl,
      }),
    );
    // «+N»: todo item que o poço não desenhou (além das 14 da Entrega, ou o solo que não achou coluna livre) — o fluxo
    // nunca some com um item calado.
    return { crates: placed, extra: Math.max(0, cards.length - placed.length) };
  }, [lane.role, cards, stateOf, stepOf, live, index, lanes, trainIds, config]);

  const liveSummary = useMemo(
    () => (lane.role === "live" ? liveSummaryOf(cards, arrivals, now, timeZone) : undefined),
    [lane.role, cards, arrivals, now, timeZone],
  );
  const caption = useMemo(() => {
    const count = (s: FlowState) => cards.filter((c) => stateOf(c.id) === s).length;
    return flowCaption(lane.role, {
      count,
      total: cards.length,
      paused,
      avgMinutes: avgTrain,
      today: liveSummary?.today,
      perDay: liveSummary?.perDay,
      // um card por FUNCIONALIDADE: com menos cards que itens, a legenda conta os dois («11 itens · 2 funcionalidades»)
      features: entries.length,
    });
  }, [lane.role, cards, stateOf, paused, avgTrain, liveSummary, entries.length]);

  // Na Entrega, o que está no trem fica no trem: os cards da coluna são só o que espera FORA dele (a aprovação do
  // dono, um erro, a publicação) — no recorte atual, como em toda coluna.
  const lanePass = useCallback((c: Card) => (lane.role === "delivery" ? !trainIds.has(c.id) && pass(c) : pass(c)), [lane.role, trainIds, pass]);
  const shown = useMemo(() => visibleEntries(entries, stateOf, lanePass), [entries, stateOf, lanePass]);
  const shownIds = useMemo(() => new Set(shown.map((e) => e.item.id)), [shown]);
  const livePass = useCallback((c: Card) => !queryText.trim() || matchesCardQuery(c, queryText, query), [queryText, query]);

  const segment = (
    <FlowSegment
      boardId={boardId}
      lane={lane}
      total={cards.length}
      crates={crates}
      caption={caption}
      paused={paused}
      off={paceOff}
      extra={extra}
      live={liveSummary}
      hoverId={hoverId}
      onHover={onHover}
      popId={crates.some((c) => c.card.id === popId) ? popId : null}
      onPop={onPop}
      onFind={onFind}
      flip={index >= lanes.length - 2}
      slots={slots}
      now={now}
    />
  );

  const cardsOf = (list: typeof shown) =>
    list.map((e) => (
      <FeatureCard
        key={e.key}
        config={config}
        entry={e}
        step={stepOf(e.item)}
        href={featureTitleHref(boardId, e.feature, hrefOf(e.item.id))}
        hrefOf={hrefOf}
        now={now}
        metrics={metrics.get(e.item.id)}
        highlighted={hoverId === e.item.id || popId === e.item.id}
        onHover={onHover}
      />
    ));
  let body: React.ReactNode;
  if (lane.role === "delivery") {
    body = (
      <>
        <TrainColumn
          boardId={boardId}
          cardsById={cardsById}
          owner={ownerMap}
          paused={paused}
          now={now}
          outside={cards.filter((c) => !trainIds.has(c.id) && !shownIds.has(c.id))}
        />
        {cardsOf(shown)}
      </>
    );
  } else if (lane.role === "live") {
    body = <LiveColumn boardId={boardId} cards={cards} arrivals={arrivals} now={now} query={livePass} searching={searching} />;
  } else if (shown.length === 0) {
    // o texto do desenho para TODA coluna vazia num recorte ou numa busca (no «Tudo» sem busca a coluna vazia fica muda).
    // No «Exceções», a coluna que TEM itens (só nenhum fora do trilho) diz quantos e leva ao «Tudo» — calada, ela
    // parecia vazia ao lado de um cabeçalho que conta 11.
    const words = quietLaneWords(mode === "exc" && !searching ? cards.length : 0);
    body =
      mode !== "all" || searching ? (
        // em DotList: numa coluna estreita o atalho quebra para a linha de baixo sem deixar «Nada fora do trilho ·»
        <DotList
          className={`py-0.5 pr-0.5 text-[13px] text-fg-subtle ${QUIET_CLIP}`}
          parts={[
            words.text,
            words.link && (
              <button key="a" type="button" onClick={onShowAll} className={QUIET_LINK}>
                {words.link}
              </button>
            ),
          ]}
        />
      ) : null;
  } else {
    body = cardsOf(shown);
  }

  return (
    <KanbanLane label={lane.label} segment={segment}>
      {body}
    </KanbanLane>
  );
}
