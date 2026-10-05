"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Info, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useBoardDragSensors } from "@/lib/drag-sensors";
import { countChipCls } from "@/lib/ui";
import { byUpdatedDesc, midpoint } from "@/lib/storymap/order";
import { makeDraftCard } from "@/lib/storymap/draft";
import {
  entryStatusId,
  KANBAN_LOOSE_COLUMN,
  kanbanColumnOf,
  kanbanColumnStatuses,
  kanbanStories,
} from "@/lib/storymap/views";
import { boardLanes, groupStoriesByLane, laneDropStatus, laneSections, laneStatusTags, laneViewProblems, type ResolvedLane } from "@/lib/storymap/lanes";
import { ownerDecisionsFromEntries, type OwnerDecisions } from "@/lib/storymap/inbox/decidir-set";
import type { CardLiveStatus, CardPresence } from "@/lib/storymap/card-live-status";
import { filterCardGroups, isKanbanFilterActive, kanbanTypeFacets, matchesKanbanFilter } from "@/lib/storymap/kanban-filter";
import { useLocalToggle } from "@/lib/useLocalToggle";
import { navItemForView, type BoardView, type NavItem } from "@/components/nav/nav-groups";
import type { Board, BoardConfig, BoardSummary, Card, ColumnDef, StatusDef } from "@/lib/storymap/types";
import { evaluateGate, GATE_LABELS, placementViolation } from "@/lib/storymap/gates";
// WS-2 — the move-rejected toast escalation (?copilot=move-blocked).
import { encodeEscalationRef } from "@/lib/storymap/copilot/escalation";
import { forceReleaseRunAction, moveCardAction, updateBoardConfigAction } from "@/app/actions";
import { cardHref, inboxHref } from "@/lib/storymap/deep-links";
import { BoardHeader } from "./BoardHeader";
import { useBoardLiveStatuses } from "./CardLiveStatus";
import { BoardLiveProvider, OwnerDecisionsProvider, ownerByCard } from "./OwnerDecisionsContext";
import { KanbanPulse } from "./KanbanPulse";
import { useInboxSummary } from "./useInboxSummary";
import { ColumnPolicyPopover } from "./ColumnPolicyControls";
import { KanbanCard } from "./KanbanCard";
import { KanbanSearchBar, useKanbanFilter } from "./KanbanSearchBar";
import { ToastProvider, UNDO_TOAST_MS, useToast } from "./Toast";

// Q2 — SmartCaptureModal renders only behind a runtime guard ({smartOpen}),
// so load their chunks lazily (client-only) instead of eagerly with the board. Behavior is unchanged — the
// guards already gate mounting; this just defers the download/parse until the modal is actually opened.
const SmartCaptureModal = dynamic(() => import("./SmartCaptureModal").then((m) => m.SmartCaptureModal), { ssr: false });

const NO_STATUS = KANBAN_LOOSE_COLUMN;

// story-ex0160: a terminal lane (No ar) accumulates dozens of cards. Render only the N most-recent
// (already byUpdatedDesc-sorted) and move the rest behind a "ver todas" drawer so the column stays legible.
const TERMINAL_LANE_CAP = 10;

// NOTE: Focus mode (1st-click column-highlight) was DELIBERATELY REMOVED — one click now
// opens the card directly. The 6-column redesign then folded the per-step automation pills (auto/manual ·
// gate · skip · policy) into the discreet per-phase `ColumnAutomationMenu`, so columns read Notion-clean.

/** Rótulo curto de cada gate — DERIVADO de GATES (gates.ts), não mais um Record paralelo aqui. */
const GATE_LABEL = GATE_LABELS;

export function KanbanBoard({ board, boards, owner }: { board: Board; boards: BoardSummary[]; owner: OwnerDecisions | null }) {
  // RunnerStatusProvider now wraps the whole board via app/board/[boardId]/layout.tsx
  // (one SSE connection for every view + the navbar runner menu). Only Toast is local.
  return (
    <ToastProvider>
      <KanbanBoardInner board={board} boards={boards} initialOwner={owner} />
    </ToastProvider>
  );
}

/**
 * O DECIDIR deste board, vivo: o que a página server leu do coletor do Inbox (boardDecidirCardIds) até a primeira
 * leitura do cliente, e depois a MESMA leitura do chip do Inbox (useInboxSummary, que relê a cada `inbox.changed`),
 * pela MESMA função pura. A raia do dono, a pílula do card e o botão do rodapé leem daqui — nunca por status.
 */
function useOwnerDecisions(boardId: string, initial: OwnerDecisions | null): OwnerDecisions | null {
  const summary = useInboxSummary();
  return useMemo(() => (summary ? ownerDecisionsFromEntries(summary.entries, boardId) : initial), [summary, boardId, initial]);
}

function KanbanBoardInner({ board, boards, initialOwner }: { board: Board; boards: BoardSummary[]; initialOwner: OwnerDecisions | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [cards, setCards] = useState<Card[]>(board.cards);
  const [config, setConfig] = useState<BoardConfig>(board.config);
  const [smartOpen, setSmartOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showMeta, toggleMeta] = useLocalToggle("storymap.showMeta", false);

  // C2 — a STABLE onOpen passed to every column/card: an inline `(id) => router.push(...)` per render
  // would give each card a new prop identity, defeating KanbanCard's React.memo. Deps: router + board id.
  const handleOpen = useCallback((id: string) => router.push(cardHref(config.id, id)), [router, config.id]);

  useEffect(() => {
    setCards(board.cards);
    setConfig(board.config);
  }, [board]);

  useEffect(() => {
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router]);

  const sensors = useBoardDragSensors();

  // Which statuses render as COLUMNS: everything except (a) `system`-column statuses (the archive
  // tombstones, reached via the header trash drawer) and (b) `hidden` statuses (the reentry executors
  // refinar/corrigir/descontinuar + the capture/style container lanes). This keeps the reentry column
  // ELIMINATED (story-ex0118) — but it no longer decides which CARDS render.
  const visibleStatuses = useMemo(() => kanbanColumnStatuses(config), [config]);
  const columnStatusIds = useMemo(() => new Set(visibleStatuses.map((s) => s.id)), [visibleStatuses]);

  // Only stories flow through the kanban (activities/steps are backbone-only). A story is dropped ONLY
  // when it is an archived terminal (trash drawer) or an ephemeral capture/style container (own surface);
  // a story in a HIDDEN reentry status (a bug being fixed in `corrigir`) or an unknown/future status is
  // KEPT — it lands in the loose lane below rather than vanishing. `kanbanStories` is the single source of
  // that "never lose an active card" rule (unit-tested in views.test.ts).
  const stories = useMemo(() => kanbanStories(cards, config), [cards, config]);
  // story-ex0160 widget: how many stories are HOMOLOGATED but not yet live — i.e. sitting in a delivery
  // step (laneStep, the Entrega column) on the way to `concluida`. Shown atop the No ar lane as the
  // stage↔main signal ("o que está em stage/homologado vs já no ar"). 0 when nothing is mid-delivery.
  const stagedCount = useMemo(() => {
    const laneStepIds = new Set(config.statuses.filter((s) => s.laneStep).map((s) => s.id));
    return stories.filter((c) => c.status && laneStepIds.has(c.status)).length;
  }, [stories, config.statuses]);
  // Lookup so a card resolves the backbone node it serves (servesTarget = serves ?? parent) for the
  // story↔item breadcrumb — ALL cards (steps/activities too), not just stories, so a served step resolves.
  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  const byStatus = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const s of visibleStatuses) m.set(s.id, []);
    m.set(NO_STATUS, []);
    // A story whose status has no rendered column (hidden reentry, unknown/future, or none)
    // resolves to the loose lane instead of being dropped — see kanbanColumnOf.
    for (const c of stories) m.get(kanbanColumnOf(c, columnStatusIds))!.push(c);
    // Each column shows the most-recently-updated card on top (file mtime, bumped by
    // every edit/drag/skill run). `updated` desc, not the manual `order` key.
    for (const list of m.values()) list.sort(byUpdatedDesc);
    return m;
  }, [stories, visibleStatuses, columnStatusIds]);

  const hasUnstatused = (byStatus.get(NO_STATUS)?.length ?? 0) > 0;

  const columns: { id: string; def: StatusDef | null }[] = useMemo(() => {
    const cols: { id: string; def: StatusDef | null }[] = visibleStatuses.map((def) => ({
      id: def.id,
      def,
    }));
    if (hasUnstatused) cols.push({ id: NO_STATUS, def: null });
    return cols;
  }, [visibleStatuses, hasUnstatused]);

  // STAGE grouping (Stage→Step): when board.yaml declares `columns`, group the
  // step-columns under their stage header (`StatusDef.column` → `ColumnDef.id`).
  // Steps with no/unknown column (and the synthetic NO_STATUS) fall into a trailing
  // headerless group. No `columns` declared → one flat headerless group (legacy).
  const stageGroups = useMemo(() => {
    type Col = { id: string; def: StatusDef | null };
    type Group = { stage: ColumnDef | null; cols: Col[] };
    const stages = config.columns ?? [];
    if (stages.length === 0) return [{ stage: null, cols: columns }] as Group[];
    const known = new Set(stages.map((s) => s.id));
    const byStage = new Map<string, Col[]>();
    const ungrouped: Col[] = [];
    for (const c of columns) {
      const cid = c.def?.column;
      if (cid && known.has(cid)) {
        const arr = byStage.get(cid) ?? [];
        arr.push(c);
        byStage.set(cid, arr);
      } else {
        ungrouped.push(c);
      }
    }
    const groups: Group[] = [];
    for (const stage of stages) {
      const gc = byStage.get(stage.id);
      if (gc && gc.length) groups.push({ stage, cols: gc });
    }
    if (ungrouped.length) groups.push({ stage: null, cols: ungrouped });
    return groups;
  }, [config.columns, columns]);

  // O DECIDIR do board (a raia do dono, a pílula e o botão de resolver dos cards) — o MESMO do Inbox.
  const owner = useOwnerDecisions(config.id, initialOwner);
  const ownerMap = useMemo(() => ownerByCard(owner), [owner]);
  // The LANE VIEW (board.yaml `view.lanes`, lanes.ts): when declared, the board renders lanes instead of the
  // status/phase columns — a VIEW, the cards keep their statuses (shown as tags). Absent ⇒ null and nothing below
  // changes: the legacy Kanban renders exactly as before.
  const declaredLanes = useMemo(() => boardLanes(config), [config]);
  const laneView = useMemo(
    () => (declaredLanes ? groupStoriesByLane(stories, declaredLanes, { owner }) : null),
    [declaredLanes, stories, owner],
  );
  // As LINHAS DE ESTADO de todos os cards, uma vez: o pulso, a legenda, as seções das raias e cada card leem esta.
  const live = useBoardLiveStatuses(config.id, stories, config, ownerMap);
  // A legenda filtra por presença (um toque em «Agindo» mostra só quem age).
  const [presenceFilter, setPresenceFilter] = useState<CardPresence | null>(null);
  const laneProblems = useMemo(() => (declaredLanes ? laneViewProblems(config) : []), [declaredLanes, config]);

  // A BUSCA (KanbanSearchBar) recorta o que se DESENHA, nunca o que se calcula: colunas, raias, o arrasto e a
  // ordem de destino continuam sobre o board inteiro (byStatus/laneView). Só as listas passam pelo filtro — e
  // a coluna que ele esvazia fica no lugar dizendo "nenhum card", para o board não pular enquanto se digita.
  const [filter, setFilter] = useKanbanFilter();
  const filtering = isKanbanFilterActive(filter) || presenceFilter != null;
  const matchCtx = useMemo(() => ({ cardsById }), [cardsById]);
  const shownIds = useMemo(
    () =>
      filtering
        ? new Set(
            stories
              .filter((c) => matchesKanbanFilter(c, filter, matchCtx))
              .filter((c) => presenceFilter == null || live.get(c.id)?.presence === presenceFilter)
              .map((c) => c.id),
          )
        : null,
    [filtering, stories, filter, matchCtx, presenceFilter, live],
  );
  const shownByStatus = useMemo(
    () => (shownIds ? filterCardGroups(byStatus, (c) => shownIds.has(c.id)) : byStatus),
    [shownIds, byStatus],
  );
  const shownByLane = useMemo(
    () => (laneView && shownIds ? filterCardGroups(laneView.byLane, (c) => shownIds.has(c.id)) : (laneView?.byLane ?? null)),
    [laneView, shownIds],
  );
  const typeFacets = useMemo(
    () => kanbanTypeFacets(stories, filter.q, matchCtx, filter.types),
    [stories, filter.q, filter.types, matchCtx],
  );

  const activeCard = activeId ? cards.find((c) => c.id === activeId) ?? null : null;
  // The ColumnDef id of the card being dragged — so a phase can suppress its "valid drop" highlight when
  // the dragged card already belongs to it (a same-phase drop is a no-op; don't promise a drop we won't honor).
  const activeColumnId = activeCard?.status
    ? (config.statuses.find((s) => s.id === activeCard.status)?.column ?? null)
    : null;

  const columnOfOver = (overId: string): string | null => {
    if (byStatus.has(overId)) return overId; // dropped on the column itself
    const card = stories.find((c) => c.id === overId); // dropped on another card
    if (card) return kanbanColumnOf(card, columnStatusIds);
    return null;
  };

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
  };
  const onDragCancel = () => setActiveId(null);

  // WS-2 (cenário move-gate-blocked) — a move rejected by a GATE gets an ACTIONABLE toast (2 buttons) instead
  // of a mute reason. Discrimination is MACHINE-LEGIBLE (never the error text): the gate is isomorphic, so if
  // the target reproves in the client the server rejection WAS the gate. A non-gate failure (runner off / IO)
  // keeps the plain toast. Used by BOTH the drag (onDragEnd) and the DeliveryStepper (onAdvance).
  const moveRejectedToast = (card: Card, toStatus: string | null, error: string) => {
    // A recusa por HIERARQUIA vem do chokepoint de escrita, não de um gate: sair da quarentena (Triagem)
    // exige que o card tenha finalmente um lugar. Discriminação MACHINE-LEGIBLE (nunca pelo texto do erro),
    // igual ao ramo do gate: a invariante é pura, então reavaliá-la aqui com o board na mão diz se FOI ela.
    // Sem esta ação o operador lia "falta parent" e tinha de caçar o card para decidir — a decisão fica a
    // um clique de onde ela é cobrada.
    const placement = placementViolation(card, (id) => cards.find((c) => c.id === id) ?? null, config);
    if (placement) {
      return toast(placement.message, "error", {
        label: "Definir o lugar",
        // Direto na visão CAMPOS da página: é lá que Pai/Release moram, e mandar para a leitura
        // deixaria a decisão que o erro cobra a mais um clique de distância.
        onClick: () => router.push(cardHref(config.id, card.id, { view: "campos" })),
      });
    }
    // um card que estava no FIM do fluxo chega ao quadro reduzido à face (sem critérios/tarefas — kanban-payload.ts):
    // avaliar o gate com ele mentiria sobre o que falta; o servidor já disse o motivo.
    const fromTerminal = config.statuses.find((s) => s.id === card.status)?.terminal === true;
    const verdict = toStatus && !fromTerminal ? evaluateGate(card, toStatus, config) : null;
    if (!verdict || !toStatus) return toast(error);
    toast(error, "error", [
      // B11 — o que falta para o gate está no CARD (os campos), não num item do Inbox (esta recusa não gera um).
      { label: "Ver o que falta", onClick: () => router.push(cardHref(config.id, card.id, { view: "campos" })) },
      {
        label: "Destravar com o Jido",
        onClick: () => {
          // Sobre a query ATUAL: a busca do Kanban (?q=/?tipo=) não pode sumir porque o Jido foi chamado.
          const next = new URLSearchParams(window.location.search);
          next.set(
            "copilot",
            encodeEscalationRef({ kind: "move-blocked", boardId: config.id, cardId: card.id, target: toStatus, templateId: "move-gate-blocked" }),
          );
          router.replace(`${pathname}?${next}`);
        },
      },
    ]);
  };

  // DESFAZER um move que DEU CERTO. Sem isto, o arrasto acidental (a queixa que originou o ajuste dos
  // sensores) é irreversível pelo operador: o status mudou, o gate aprovou e um run pode já ter sido
  // spawnado. A reversão vai pela MESMA action, marcada `isUndo` — restaura o status SEM re-disparar
  // autorun/entry-effects — e depois libera o run que a entrada porventura criou.
  const offerUndo = (card: Card, snapshot: Card[], toStatus: string | null) => {
    const nameOf = (id: string | null) =>
      id ? (config.statuses.find((s) => s.id === id)?.name ?? id) : "Sem fase";
    const fromName = nameOf(card.status ?? null);
    toast(
      `“${card.title}” foi para ${nameOf(toStatus)}.`,
      "success",
      {
        label: "Desfazer",
        onClick: async () => {
          const back = await moveCardAction({
            boardId: config.id,
            cardId: card.id,
            status: card.status ?? null,
            order: card.order,
            isUndo: true,
          });
          if (!back.ok) return toast(`Não consegui devolver para ${fromName}: ${back.error}`);
          setCards(snapshot);
          // A ida pode ter spawnado/enfileirado um run na coluna de destino; a volta não o mata.
          // Best-effort: sem run para liberar, a action apenas responde que não havia nada.
          void forceReleaseRunAction({ boardId: config.id, cardId: card.id });
          toast(`“${card.title}” voltou para ${fromName}.`, "success");
        },
      },
      UNDO_TOAST_MS,
    );
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const card = cards.find((c) => c.id === String(active.id));
    if (!card || card.type !== "story") return;

    // LANE VIEW: a drop means "put this card in this LANE" ⇒ the lane's first droppable status (the gate still
    // decides, in moveCardAction). A same-lane drop is a no-op; "Outros" accepts no drop.
    if (laneView) {
      const overId = String(over.id);
      const laneOf = (id: string): string | null => {
        if (id.startsWith(LANE_DROP_PREFIX)) return id.slice(LANE_DROP_PREFIX.length);
        for (const [laneId, list] of laneView.byLane) if (list.some((c) => c.id === id)) return laneId;
        return null;
      };
      const toLane = laneView.lanes.find((l) => l.id === laneOf(overId));
      if (!toLane || toLane.id === laneOf(card.id)) return;
      const laneStatus = laneDropStatus(toLane, config);
      if (!laneStatus || laneStatus === card.status) return;
      const siblings = (laneView.byLane.get(toLane.id) ?? []).filter((c) => c.id !== card.id);
      const laneOrder = midpoint(siblings[siblings.length - 1]?.order, undefined);
      const moved: Card = { ...card, status: laneStatus, order: laneOrder, updatedMs: Date.now() };
      const before = cards;
      setCards((cs) => cs.map((c) => (c.id === moved.id ? moved : c)));
      const r = await moveCardAction({ boardId: config.id, cardId: moved.id, status: laneStatus, order: laneOrder });
      if (!r.ok) {
        setCards(before);
        moveRejectedToast(card, laneStatus, r.error);
        return;
      }
      offerUndo(card, before, laneStatus);
      return;
    }

    const overCol = columnOfOver(String(over.id));
    if (!overCol) return;
    const overStatus = overCol === NO_STATUS ? null : overCol;

    // 6-column kanban: a column is ONE flat list (its steps are shown on the card, not as sub-lanes), so a
    // drop means "put this card in this PHASE". Map a cross-column drop to the destination column's ENTRY
    // step; a same-column drop keeps the card's current step (autorun/runs drive intra-column progress — use
    // "Mover para" for a precise step). The entry step's gate is still enforced by moveCardAction.
    let destStatus = overStatus;
    if (overStatus) {
      const destColumnId = config.statuses.find((s) => s.id === overStatus)?.column ?? null;
      const curColumnId = card.status ? (config.statuses.find((s) => s.id === card.status)?.column ?? null) : null;
      if (destColumnId && destColumnId === curColumnId) {
        destStatus = card.status ?? null; // same phase → no step change
      } else if (destColumnId) {
        destStatus = visibleStatuses.find((s) => s.column === destColumnId)?.id ?? overStatus;
      }
    }

    if (destStatus === (card.status ?? null)) return; // no phase change → nothing to persist (sort is by mtime)

    // Append to the destination column + stamp recency so the moved card jumps to the top immediately
    // (Date.now() and stat().mtimeMs share the epoch-ms unit, matching the server's fresh mtime).
    const dest = (byStatus.get(destStatus ?? NO_STATUS) ?? []).filter((c) => c.id !== card.id);
    const order = midpoint(dest[dest.length - 1]?.order, undefined);
    const updated: Card = { ...card, status: destStatus, order, updatedMs: Date.now() };
    const snapshot = cards;
    setCards((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));

    const res = await moveCardAction({
      boardId: config.id,
      cardId: updated.id,
      status: destStatus,
      order,
    });
    if (!res.ok) {
      // Gate blocked the move: roll back optimistic update + show the reason (with the 2 unblock actions).
      setCards(snapshot);
      moveRejectedToast(card, destStatus, res.error);
      return;
    }
    offerUndo(card, snapshot, destStatus);
  };

  // Delivery stepper: advance a card to the next delivery step — Aprovar (revisao→merge) and
  // Publicar (release→deploy, which fires onEnter promote-and-deploy + autoEnterTerminal→concluida). Reuses
  // the SAME moveCardAction path as drag/MoveToPopover (gate-validated, dispatches ENTRY_EFFECTS), with the
  // optimistic update + rollback. ZERO deploy logic in the UI — the button is just a gated status move.
  const onAdvance = async (cardId: string, toStatus: string) => {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const siblings = (byStatus.get(toStatus) ?? []).filter((c) => c.id !== cardId);
    const order = midpoint(siblings[siblings.length - 1]?.order, undefined);
    const updated: Card = { ...card, status: toStatus, order, updatedMs: Date.now() };
    const snapshot = cards;
    setCards((cs) => cs.map((c) => (c.id === cardId ? updated : c)));
    const res = await moveCardAction({ boardId: config.id, cardId, status: toStatus, order });
    if (!res.ok) {
      setCards(snapshot);
      moveRejectedToast(card, toStatus, res.error);
    }
  };

  // Per-column auto-pilot toggle: flip a status's `autorun` and persist to
  // board.yaml. The trigger-runner channel reads it to decide run-skill / forward.
  const toggleAutorun = async (statusId: string) => {
    const prev = config;
    const next: BoardConfig = {
      ...config,
      statuses: config.statuses.map((s) =>
        s.id === statusId ? { ...s, autorun: !(s.autorun === true) } : s,
      ),
    };
    setConfig(next); // optimistic
    const res = await updateBoardConfigAction({ boardId: config.id, config: next });
    if (!res.ok) {
      setConfig(prev);
      toast(res.error);
    }
  };

  // Per-column automation POLICY (model/effort/maxTurns/costGuard): patch a status
  // and persist board.yaml. A cleared field arrives as undefined → delete the key
  // so the YAML stays clean (the column then falls back to the global defaults).
  const updateColumnPolicy = async (statusId: string, patch: Partial<StatusDef>) => {
    const prev = config;
    const next: BoardConfig = {
      ...config,
      statuses: config.statuses.map((s) => {
        if (s.id !== statusId) return s;
        const ns: StatusDef = { ...s, ...patch };
        (Object.keys(patch) as (keyof StatusDef)[]).forEach((k) => {
          if (patch[k] === undefined) delete ns[k];
        });
        return ns;
      }),
    };
    setConfig(next); // optimistic
    const res = await updateBoardConfigAction({ boardId: config.id, config: next });
    if (!res.ok) {
      setConfig(prev);
      toast(res.error);
    }
  };

  return (
    <OwnerDecisionsProvider value={ownerMap}>
    <BoardLiveProvider value={live}>
    <div className="flex h-screen flex-col">
      <BoardHeader
        boards={boards}
        config={config}
        view="kanban"
        onSmartCapture={() => setSmartOpen(true)}
        showMeta={showMeta}
        onToggleMeta={toggleMeta}
        subnav
      />

      <KanbanSearchBar
        filter={filter}
        onChange={setFilter}
        facets={typeFacets}
        shown={shownIds?.size ?? stories.length}
        total={stories.length}
      />

      <KanbanPulse boardId={config.id} statuses={live} ownerTotal={owner?.total ?? null} filter={presenceFilter} onFilter={setPresenceFilter} />

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="board-scroll flex-1 overflow-auto bg-canvas p-4">
          {/* Fit-to-screen: phases FLEX to share the width (empty ones collapse to compact strips), so on
              desktop all columns fit without horizontal scroll; it still scrolls on narrow/many-column boards. */}
          {laneView ? (
            <LaneBoard
              lanes={laneView.lanes}
              byLane={shownByLane ?? laneView.byLane}
              boardByLane={laneView.byLane}
              filtering={filtering}
              problems={laneProblems}
              config={config}
              cardsById={cardsById}
              onOpen={handleOpen}
              onAdvance={onAdvance}
              showMeta={showMeta}
              activeLaneId={activeId ? ([...laneView.byLane].find(([, l]) => l.some((c) => c.id === activeId))?.[0] ?? null) : null}
              owner={owner}
              outside={laneView.outside}
              live={live}
            />
          ) : (
          <div className="flex h-full gap-4">
            {stageGroups.map((group, gi) =>
              group.stage ? (
                <StageColumn
                  key={group.stage.id}
                  group={{ stage: group.stage, cols: group.cols }}
                  byStatus={shownByStatus}
                  boardByStatus={byStatus}
                  filtering={filtering}
                  config={config}
                  cardsById={cardsById}
                  onOpen={handleOpen}
                  onToggleAutorun={toggleAutorun}
                  onUpdatePolicy={updateColumnPolicy}
                  onAdvance={onAdvance}
                  stagedCount={stagedCount}
                  showMeta={showMeta}
                  activeColumnId={activeColumnId}
                />
              ) : (
                // Loose group (NO_STATUS / steps with no declared column) — keep flat columns.
                <section key={`loose-${gi}`} className="flex h-full min-w-0 flex-1 gap-4">
                  {group.cols.map((col) => (
                    <KanbanColumn
                      key={col.id}
                      columnId={col.id}
                      def={col.def}
                      cards={shownByStatus.get(col.id) ?? []}
                      boardCount={byStatus.get(col.id)?.length ?? 0}
                      filtering={filtering}
                      config={config}
                      cardsById={cardsById}
                      onOpen={handleOpen}
                      onToggleAutorun={toggleAutorun}
                      onUpdatePolicy={updateColumnPolicy}
                      showMeta={showMeta}
                    />
                  ))}
                </section>
              ),
            )}
          </div>
          )}
        </div>

        <DragOverlay>
          {activeCard ? (
            <div className="w-[248px] rotate-1">
              <KanbanCard card={activeCard} config={config} onOpen={() => {}} overlay />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>


      {smartOpen && (
        <SmartCaptureModal
          boardId={config.id}
          config={config}
          cards={cards}
          onClose={() => {
            setSmartOpen(false);
            router.refresh();
          }}
          // the modal owns the success UI now (it stays open showing what was created); here we just
          // refresh the board behind it so the new cards/ideas show through.
          onCreated={() => router.refresh()}
          onOpenCard={(id) => router.push(`/board/${config.id}/card/${id}`)}
          onOpenIdeas={() => router.push(`/board/${config.id}/ideias`)}
        />
      )}
    </div>
    </BoardLiveProvider>
    </OwnerDecisionsProvider>
  );
}

/** Droppable ids of the lane view are namespaced so a lane id can never collide with a status or card id. */
const LANE_DROP_PREFIX = "lane:";

/**
 * The LANE VIEW (board.yaml `view.lanes`): one flat column per lane, each card tagged with its REAL status. The step
 * detail lives on the card as a tag, not as a column. The owner's lane holds exactly the Inbox's Decidir (lanes.ts),
 * in the Inbox's order. A declared map that is wrong (a status in no lane, in two, unknown, a status in the owner's
 * lane…) is SAID here, above the lanes, in the lint's own words — the cards it strands sit in the visible "Outros" lane.
 */
function LaneBoard({
  lanes,
  byLane,
  boardByLane,
  filtering,
  problems,
  config,
  cardsById,
  onOpen,
  onAdvance,
  showMeta,
  activeLaneId,
  owner,
  outside,
  live,
}: {
  lanes: ResolvedLane[];
  /** os cards DESENHADOS por raia (o recorte da busca) */
  byLane: Map<string, Card[]>;
  /** todos os cards por raia — decide se a raia está vazia de fato (compacta) ou só sem resultado */
  boardByLane: Map<string, Card[]>;
  filtering?: boolean;
  problems: string[];
  config: BoardConfig;
  cardsById?: Map<string, Card>;
  onOpen: (id: string) => void;
  onAdvance?: (cardId: string, toStatus: string) => void;
  showMeta?: boolean;
  activeLaneId: string | null;
  /** o Decidir do board (null = o Inbox não pôde ser lido). */
  owner: OwnerDecisions | null;
  /** as decisões de Decidir que não põem card na raia do dono (lanes.ts `outside`). */
  outside: number;
  /** as linhas de estado dos cards — as seções por atividade. */
  live: ReadonlyMap<string, CardLiveStatus | null>;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      {problems.length > 0 && <LaneProblems problems={problems} />}
      <div className="flex min-h-0 flex-1 gap-4">
        {lanes.map((lane) => (
          <LaneColumn
            key={lane.id}
            lane={lane}
            cards={byLane.get(lane.id) ?? []}
            boardCount={boardByLane.get(lane.id)?.length ?? 0}
            filtering={filtering}
            config={config}
            cardsById={cardsById}
            onOpen={onOpen}
            onAdvance={onAdvance}
            showMeta={showMeta}
            acceptsActive={!lane.others && !lane.demand && activeLaneId !== lane.id}
            owner={lane.demand ? owner : undefined}
            outside={lane.demand ? outside : 0}
            live={live}
          />
        ))}
      </div>
    </div>
  );
}

/** The lint of the lane map, legible to whoever declared it (collapsed to one line; opens to the list). */
function LaneProblems({ problems }: { problems: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 rounded-lg border border-line bg-inset px-3 py-2 text-[12px] text-fg-muted">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left font-medium text-fg">
        {problems.length === 1 ? "1 problema" : `${problems.length} problemas`} no mapa de raias (board.yaml `view.lanes`){open ? "" : " — ver"}
      </button>
      {open && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LaneColumn({
  lane,
  cards,
  boardCount,
  filtering,
  config,
  cardsById,
  onOpen,
  onAdvance,
  showMeta,
  acceptsActive,
  owner,
  outside,
  live,
}: {
  lane: ResolvedLane;
  cards: Card[];
  boardCount: number;
  filtering?: boolean;
  config: BoardConfig;
  cardsById?: Map<string, Card>;
  onOpen: (id: string) => void;
  onAdvance?: (cardId: string, toStatus: string) => void;
  showMeta?: boolean;
  acceptsActive?: boolean;
  /** só a raia do dono: o Decidir do board (null = ilegível). */
  owner?: OwnerDecisions | null;
  outside: number;
  live: ReadonlyMap<string, CardLiveStatus | null>;
}) {
  const dropId = `${LANE_DROP_PREFIX}${lane.id}`;
  const { setNodeRef, isOver } = useDroppable({ id: dropId, disabled: lane.others === true || lane.demand });
  // A raia do dono segue a ORDEM DO INBOX (já vem assim de groupStoriesByLane); as outras, o mais recente primeiro.
  const sorted = useMemo(() => (lane.demand ? cards : [...cards].sort(byUpdatedDesc)), [cards, lane.demand]);
  // As SEÇÕES por atividade (lanes.ts): «Construindo 9» passa a dizer quem age, quem parou e quem espera vaga. A raia
  // do dono não se divide — ela inteira espera você, na ordem do Inbox.
  const sections = useMemo(
    () => (lane.demand ? [] : laneSections(sorted, (id) => live.get(id)?.kind ?? null)),
    [lane.demand, sorted, live],
  );
  const [openFila, setOpenFila] = useState(false);
  // A raia do FIM do fluxo («No ar») acumula centenas de cards num board maduro e, desenhada inteira, era a maior parte
  // da página (HTML do servidor e hidratação). Mostra os mais recentes; o resto abre no lugar. Uma busca mostra tudo o
  // que casou.
  const terminalLane =
    !lane.demand && !lane.others && lane.statuses.length > 0 && lane.statuses.every((id) => config.statuses.find((st) => st.id === id)?.terminal === true);
  const [showAllDone, setShowAllDone] = useState(false);
  const capDone = terminalLane && !filtering && !showAllDone && sorted.length > TERMINAL_LANE_CAP;
  const shown = capDone ? sorted.slice(0, TERMINAL_LANE_CAP) : sorted;
  const showSections = !terminalLane && (sections.length > 1 || sections.some((s) => s.collapsed));
  const rendered = showSections ? sections.flatMap((s) => (s.collapsed && !openFila ? [] : s.cards)) : shown;
  const ownerTotal = owner?.total ?? null;
  // Compacta só a raia vazia DE FATO; a que a busca esvaziou fica larga, dizendo "nenhum card". A raia do dono vazia
  // fica larga também quando há decisão fora do quadro — senão o «+K» sumiria com ela.
  if (boardCount === 0 && !lane.others && !(lane.demand && outside > 0)) {
    return <CompactColumn name={lane.label} dropId={dropId} acceptsActive={acceptsActive} />;
  }
  const card = (c: Card) => (
    <KanbanCard key={c.id} card={c} config={config} cardsById={cardsById} onOpen={onOpen} onAdvance={onAdvance} showMeta={showMeta} laneTags={laneStatusTags(c, config)} />
  );
  return (
    <section className="group flex h-full min-w-[180px] max-w-[420px] flex-1 flex-col px-1">
      <header className="mb-2 shrink-0 px-0.5">
        <div className="flex items-center gap-1.5">
          {lane.demand && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-state-owner" />}
          <span className="min-w-0 shrink truncate text-[13.5px] font-semibold tracking-tight text-fg">{lane.label}</span>
          <CountChip n={sorted.length} of={filtering ? boardCount : undefined} />
        </div>
        <div className="mt-2 flex min-h-[26px] flex-wrap items-start gap-x-1.5 text-[11.5px] leading-snug text-fg-subtle">
          {lane.deferred ? (
            <span>Guardado para depois — nada daqui roda sozinho nem aparece no Inbox.</span>
          ) : lane.others ? (
            <span>Cards cujo status nenhuma raia declara — confira o mapa de raias.</span>
          ) : lane.demand ? (
            <>
              {/* «N decisões suas · ver no Inbox» — o MESMO número do Inbox; o que Decidir conta sem card aqui é dito. */}
              <Link href={inboxHref(config.id)} className="font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                {ownerTotal == null
                  ? "Inbox indisponível · ver no Inbox"
                  : `${ownerTotal} ${ownerTotal === 1 ? "decisão sua" : "decisões suas"} · ver no Inbox`}
              </Link>
              {outside > 0 && (
                <span title="Decisões que não estão num card deste quadro: uma proposta, um pedido de agente, ou uma segunda decisão de um card que já está aqui.">
                  · +{outside} fora do quadro
                </span>
              )}
            </>
          ) : (
            <span className="truncate" title={lane.statuses.join(", ") || undefined}>
              {lane.statuses.length} etapa{lane.statuses.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          "col-scroll flex min-h-[56px] flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1.5 transition",
          isOver && acceptsActive !== false && "bg-accent/10 ring-1 ring-inset ring-accent/40",
        )}
      >
        {sorted.length === 0 && (lane.demand && outside > 0 ? <p className="px-1 py-4 text-center text-[11px] text-fg-subtle">nenhum card aqui — veja no Inbox</p> : <NoMatch />)}
        <SortableContext id={dropId} items={rendered.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {showSections
            ? sections.map((sec) => (
                <Fragment key={sec.id}>
                  {sec.collapsed ? (
                    <button
                      type="button"
                      onClick={() => setOpenFila((o) => !o)}
                      aria-expanded={openFila}
                      className="mt-1 flex min-h-8 items-center gap-1.5 px-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle transition hover:text-fg"
                    >
                      <span aria-hidden>{openFila ? "▾" : "▸"}</span>
                      {sec.label} · {sec.cards.length}
                    </button>
                  ) : (
                    <p className="mt-1 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                      {sec.label} · {sec.cards.length}
                    </p>
                  )}
                  {(!sec.collapsed || openFila) && sec.cards.map(card)}
                </Fragment>
              ))
            : shown.map(card)}
        </SortableContext>
        {capDone && (
          <button
            type="button"
            onClick={() => setShowAllDone(true)}
            className="mt-1 min-h-8 rounded-md px-1 text-left text-[12px] font-medium text-fg-muted underline-offset-2 transition hover:text-fg hover:underline"
          >
            Mostrar todos ({sorted.length})
          </button>
        )}
      </div>
    </section>
  );
}

/** Stage ownership as a quiet text label (Notion-clean — no icon): who acts in this phase. */
const OWNER_LABEL: Record<"human" | "agent" | "system", string> = {
  human: "você",
  agent: "agente",
  system: "sistema",
};

/**
 * The phase's STEP TRAIL — the internal steps (etapas) of a phase as a LINEAR row of compact CHIPS, in
 * pipeline order. Each chip shows the step's `short` sigla (DEV/QA/SPEC…, falling back to `name`); a chip
 * holding ≥1 card is FILLED (bg-fg) — where the work currently sits — the rest are quiet outlines. One
 * line, scrollable if it overflows a narrow column (no wrap → the header stays short). The full step name
 * is on each chip's tooltip. Renders only when the phase has >1 visible step (Triagem has none to draw).
 */
function StepTrail({
  cols,
  byStatus,
}: {
  cols: { id: string; def: StatusDef | null }[];
  byStatus: Map<string, Card[]>;
}) {
  const steps = cols.filter((c): c is { id: string; def: StatusDef } => !!c.def);
  if (steps.length <= 1) return null;
  // Trilha de NÓS (um ponto + a sigla do passo embaixo). A tinta responde à pergunta "onde está o
  // trabalho?" — e ela estava INVERTIDA: o passo VAZIO desenhava `bg-fg` (~12:1 sobre papel, o
  // aglomerado mais escuro da tela) e o passo COM trabalho saía em âmbar a 2.19:1. Numa captura do
  // Kanban com quatro colunas zeradas, treze pontos pretos gritavam "nada aqui" e o que importava
  // quase desaparecia. Agora: OCUPADO = ponto cheio + sigla em `fg` semibold; VAZIO = anel vazado +
  // sigla `fg-subtle`. A diferença passa a ser MASSA DE TINTA, que é o que se lê de longe — e é a
  // regra que a identidade do pacote já declarava ("hierarquia por tamanho/peso/espaço, não por cor").
  return (
    <div className="flex w-full items-start px-0.5">
      {steps.map((s, i) => {
        const has = (byStatus.get(s.id)?.length ?? 0) > 0;
        return (
          <Fragment key={s.id}>
            {i > 0 && <div className="mt-[6px] h-0.5 flex-1 bg-line" />}
            <div className="flex shrink-0 flex-col items-center gap-1" title={s.def.name}>
              <span
                className={cn(
                  "h-3.5 w-3.5 rounded-full transition",
                  has ? "bg-fg" : "border border-line-emphasis bg-transparent",
                )}
              />
              <span
                className={cn(
                  "text-[8px] uppercase leading-none tracking-wide transition",
                  has ? "font-bold text-fg" : "font-semibold text-fg-subtle",
                )}
              >
                {s.def.short ?? s.def.name}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Notion-style count chip — a soft recessed pill carrying a column's card count (design-system primitive).
 *  `of` = o total da coluna enquanto a busca recorta: o chip mostra o que passou, o tooltip diz de quantos. */
function CountChip({ n, of }: { n: number; of?: number }) {
  return (
    // o número da raia conta CARDS (user stories e entregas) — o mapa conta só os itens do mapa, e a Esteira, publicações
    <span className={countChipCls} title={of != null ? `${n} de ${of} cards` : `${n} ${n === 1 ? "card" : "cards"} (user stories e entregas)`}>
      {n}
    </span>
  );
}

/** A coluna/raia que a BUSCA esvaziou — continua no lugar (o board não pula), só diz que nada passou. */
function NoMatch() {
  return <p className="px-1 py-4 text-center text-[11px] text-fg-subtle">nenhum card</p>;
}

/**
 * The discreet ⓘ that reveals a phase's authored description in a popover — the board.yaml `description`
 * was rendered only on the legacy KanbanColumn, so on the 6-column StageColumn the single best IA artefact
 * (what each phase means + its steps) was invisible. Also documents who acts (owner) in plain words.
 */
function PhaseInfo({
  name,
  text,
  owner,
}: {
  name: string;
  text?: string;
  owner?: "human" | "agent" | "system";
}) {
  const [open, setOpen] = useState(false);
  if (!text && !owner) return null;
  return (
    <div className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Sobre a fase ${name}`}
        aria-label={`Sobre a fase ${name}`}
        className="text-fg-subtle transition hover:text-fg"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[65]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-[70] mt-1 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg">
            <p className="text-[12px] font-semibold text-fg">{name}</p>
            {owner && (
              <p className="mt-0.5 text-[11px] text-fg-subtle">Quem atua: {OWNER_LABEL[owner]}</p>
            )}
            {text && <p className="mt-1.5 text-[11px] leading-snug text-fg-muted">{text}</p>}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * An EMPTY column/phase, collapsed to a SLIM HORIZONTAL strip (story-IA redesign): keeps the
 * left→right reading rhythm and symmetry (the rotated vertical strip broke it), reclaiming most of the
 * width while still reading like a phase. Stays a live droppable (drop here → the phase's entry step);
 * the dashed body is the drop affordance. Shared by the StageColumn (storymap) and KanbanColumn
 * (loose / product boards) empty states.
 */
function CompactColumn({
  name,
  dropId,
  acceptsActive,
  info,
  automation,
  trail,
}: {
  name: string;
  dropId: string;
  acceptsActive?: boolean;
  info?: ReactNode;
  /** o ⚙ da fase — o MESMO nó da coluna cheia. Ver o comentário do slot no header. */
  automation?: ReactNode;
  /** a trilha de steps da fase — idem. */
  trail?: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  const active = isOver && acceptsActive !== false;
  // Design-faithful empty PHASE: a FULL-width column (not a collapsed strip) whose body is a dashed
  // "solte aqui" drop affordance — so an empty column reads like the others, just waiting for a card.
  return (
    <section className="group flex h-full min-w-[110px] max-w-[260px] flex-[0.6] flex-col px-1">
      <header className="mb-2 shrink-0 px-0.5">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 shrink truncate text-[13.5px] font-semibold tracking-tight text-fg">{name}</span>
          <CountChip n={0} />
          <span className="flex-1" />
          {/* O ⚙ da automação vive aqui TAMBÉM. Ele sumia quando a fase esvaziava — e é exatamente aí que se
              precisa dele: configurar o autorun de uma etapa é o que faz a fase COMEÇAR a receber trabalho.
              Ter de arrastar um card para dentro só para poder abrir a engrenagem era um ovo-e-galinha. */}
          {automation}
          {info}
        </div>
        {/* ROW 2 — o MESMO slot de altura fixa das colunas cheias (mantém o alinhamento). A trilha de steps é
            desenhada aqui também: os steps de uma fase são a ESTRUTURA do pipeline, não um resumo de onde os
            cards estão. Escondê-los na fase vazia apagava justamente a informação de que aquela fase TEM
            etapas — com zero card, todos os nós ficam quietos, que é a leitura correta. */}
        <div className="mt-2 flex h-[26px] items-start">{trail}</div>
      </header>
      {/* The drop affordance is a fixed-height dashed well at the top of the column (design spec ~120px) —
          NOT a full-height box; the rest of the empty column is just whitespace, like the reference. */}
      <div
        ref={setNodeRef}
        className={cn(
          "flex h-[120px] shrink-0 items-center justify-center rounded-[10px] border border-dashed text-center text-[12px] transition",
          active ? "border-accent/50 bg-accent/5 text-accent" : "border-line text-fg-subtle",
        )}
      >
        solte aqui
      </div>
    </section>
  );
}

function KanbanColumn(props: {
  columnId: string;
  def: StatusDef | null;
  cards: Card[];
  /** quantos cards a coluna tem sem a busca — só a coluna vazia DE FATO compacta */
  boardCount: number;
  filtering?: boolean;
  config: BoardConfig;
  cardsById?: Map<string, Card>;
  onOpen: (id: string) => void;
  onToggleAutorun?: (statusId: string) => void;
  onUpdatePolicy?: (statusId: string, patch: Partial<StatusDef>) => void;
  showMeta?: boolean;
}) {
  // The loose lane (def === null) is the safe catch-all: it holds any story whose status maps to no
  // rendered column — a hidden reentry executor (corrigir/refinar/descontinuar), an unknown/future
  // status, or none. Labelled so it reads as "needs attention / out of the normal flow", never hidden.
  const name = props.def?.name ?? "Fora do fluxo";
  // Empty → compact vertical strip (droppable). Non-empty → the full bordered panel. Splitting avoids
  // registering two droppables with the same id (the empty strip owns its own useDroppable).
  if (props.boardCount === 0) return <CompactColumn name={name} dropId={props.columnId} />;
  return <KanbanColumnFull {...props} name={name} />;
}

function KanbanColumnFull({
  columnId,
  def,
  cards,
  boardCount,
  filtering,
  name,
  config,
  cardsById,
  onOpen,
  onToggleAutorun,
  onUpdatePolicy,
  showMeta,
}: {
  columnId: string;
  def: StatusDef | null;
  cards: Card[];
  boardCount: number;
  filtering?: boolean;
  name: string;
  config: BoardConfig;
  cardsById?: Map<string, Card>;
  onOpen: (id: string) => void;
  onToggleAutorun?: (statusId: string) => void;
  onUpdatePolicy?: (statusId: string, patch: Partial<StatusDef>) => void;
  showMeta?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });
  return (
    <div className="group flex h-full min-w-[180px] max-w-[420px] flex-1 flex-col px-1">
      <div className="mb-2 px-0.5">
        {/* Notion-clean header (same language as StageColumn): black name + count + the automação ⚙. */}
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 shrink truncate text-[13.5px] font-semibold tracking-tight text-fg">{name}</span>
          <CountChip n={cards.length} of={filtering ? boardCount : undefined} />
          <span className="flex-1" />
          {def && (def.trigger || def.gate) && (
            <ColumnAutomationMenu steps={[{ id: def.id, def }]} onToggleAutorun={onToggleAutorun} onUpdatePolicy={onUpdatePolicy} />
          )}
        </div>
        <ColumnDescription text={def?.description ?? ""} />
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "col-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1.5 transition",
          isOver && "bg-accent/10 ring-1 ring-inset ring-accent/40",
        )}
      >
        {cards.length === 0 && <NoMatch />}
        <SortableContext id={columnId} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((c) => (
            <KanbanCard key={c.id} card={c} config={config} cardsById={cardsById} onOpen={onOpen} showMeta={showMeta} />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/**
 * STAGE column = ONE phase (Triagem/Descoberta/Design/Construção/Entrega/No ar). The phase's steps are
 * NOT stacked sub-lanes anymore: the column is a SINGLE flat card list and each card shows its own active
 * step (the status line). Header = black name + count + who acts (owner) + a folded "automação" menu. The
 * entrega phase renders the DeliveryStepperLane (per-card 2-touch stepper); other phases the flat list. A
 * drop = "put this card in this phase" (onDragEnd maps it to the entry step); a same-phase drop is a no-op,
 * so the phase suppresses its drop highlight when the dragged card already belongs to it (`acceptsActive`).
 */
function StageColumn({
  group,
  byStatus,
  boardByStatus,
  filtering,
  config,
  cardsById,
  onOpen,
  onToggleAutorun,
  onUpdatePolicy,
  onAdvance,
  stagedCount,
  showMeta,
  activeColumnId,
}: {
  group: { stage: ColumnDef; cols: { id: string; def: StatusDef | null }[] };
  /** os cards DESENHADOS por status (o recorte da busca) */
  byStatus: Map<string, Card[]>;
  /** todos os cards por status — decide se a fase está vazia de fato (compacta) ou só sem resultado */
  boardByStatus: Map<string, Card[]>;
  filtering?: boolean;
  config: BoardConfig;
  cardsById?: Map<string, Card>;
  onOpen: (id: string) => void;
  onToggleAutorun?: (statusId: string) => void;
  onUpdatePolicy?: (statusId: string, patch: Partial<StatusDef>) => void;
  onAdvance?: (cardId: string, toStatus: string) => void;
  stagedCount?: number;
  showMeta?: boolean;
  /** ColumnDef id of the card currently being dragged (null when none) — drives `acceptsActive`. */
  activeColumnId?: string | null;
}) {
  const { stage, cols } = group;
  const total = cols.reduce((a, c) => a + (byStatus.get(c.id)?.length ?? 0), 0);
  const boardTotal = cols.reduce((a, c) => a + (boardByStatus.get(c.id)?.length ?? 0), 0);
  // a design decision entrega colapsada: a phase whose EVERY step is `laneStep` renders as the per-card delivery
  // stepper lane. The No ar (terminal) phase shows the homologation signal. Every other phase is a single
  // FLAT card list — the steps live on the cards (status line), not as stacked sub-lanes.
  const isTerminalStage = cols.some((c) => c.def?.terminal === true);
  const isStepperZone = cols.length > 1 && cols.every((c) => c.def?.laneStep === true);
  // A ferramenta DECLARADA pela fase (board.yaml), quando ela resolve para uma view real. Um id
  // desconhecido não vira porta quebrada — some (ver ColumnDef.tool).
  const stageTool = stage.tool ? (navItemForView(stage.tool as BoardView) ?? null) : null;
  // The phase entry step (first visible step) — the droppable target for "drop into this phase".
  const entryId = cols[0]?.id ?? "";
  // Suppress the "valid drop" highlight when the dragged card is already in THIS phase (same-phase drop is
  // a no-op — don't promise a drop we won't honor). True when nothing is dragging or it's another phase.
  const acceptsActive = !activeColumnId || activeColumnId !== stage.id;

  // An EMPTY phase collapses to a compact vertical strip (title rotated) so it reclaims width — the board
  // fits all phases on one screen. It stays a live droppable (drop into an empty phase → its entry step).
  // Vazia DE FATO (boardTotal): a fase que só a busca esvaziou fica larga, com "nenhum card".
  if (boardTotal === 0) {
    return (
      <CompactColumn
        name={stage.name}
        dropId={entryId}
        acceptsActive={acceptsActive}
        info={<PhaseInfo name={stage.name} text={stage.description} owner={stage.owner} />}
        // Os MESMOS nós da coluna cheia — a fase vazia não é uma fase diferente, só está sem card agora.
        automation={<ColumnAutomationMenu steps={cols} onToggleAutorun={onToggleAutorun} onUpdatePolicy={onUpdatePolicy} />}
        // Mesma guarda da coluna cheia (>1 step visível e não é a lane do stepper), para as duas nunca divergirem
        // — inclusive a PORTA da ferramenta, que vem antes da trilha aqui pelo mesmo motivo de lá. E ela importa
        // MAIS com a fase vazia: sem card em Entrega, "onde está o meu código" continua sendo uma pergunta viva
        // (pode haver trabalho no train ou parado no stage), e esta seria a única tela sem resposta à mão.
        trail={
          stageTool ? (
            <PhaseToolLink tool={stageTool} boardId={config.id} />
          ) : !isStepperZone && cols.filter((c) => c.def).length > 1 ? (
            <StepTrail cols={cols} byStatus={byStatus} />
          ) : null
        }
      />
    );
  }

  // Non-empty phase: FLEX to share the available width (fit-to-screen), bounded so it stays readable. A
  // bordered, filled panel for clear contrast against the canvas; the cards (border-2) pop on top.
  return (
    <section className="group flex h-full min-w-[180px] max-w-[420px] flex-1 flex-col px-1">
      <header className="mb-2 shrink-0 px-0.5">
        {/* Linear, 2-line header: ROW 1 = phase name + count + the automação ⚙ + the ⓘ (description +
            who acts). ROW 2 = the step-trail CHIPS. The verbose "agente · automação" text line is gone —
            owner folds into the ⓘ popover, automação into the ⚙ icon. */}
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 shrink truncate text-[13.5px] font-semibold tracking-tight text-fg">{stage.name}</span>
          <CountChip n={total} of={filtering ? boardTotal : undefined} />
          <span className="flex-1" />
          <ColumnAutomationMenu steps={cols} onToggleAutorun={onToggleAutorun} onUpdatePolicy={onUpdatePolicy} />
          <PhaseInfo name={stage.name} text={stage.description} owner={stage.owner} />
        </div>
        {/* ROW 2 — a FIXED-HEIGHT slot present on EVERY phase so all card lists ALIGN (mesma altura de
            cabeçalho em toda coluna), mesmo quando a fase não tem trilha de steps. Comporta a trilha, o
            sinal "No ar" (terminal), ou nada — mas sempre reserva o espaço. */}
        <div className="mt-2 flex h-[26px] items-start">
          {/* A porta para a FERRAMENTA da fase (board.yaml `columns[].tool`) — hoje só a Entrega tem
              uma, a Esteira. Ela vem ANTES dos outros ocupantes do slot de propósito: numa fase que
              declara ferramenta, "onde isto está de verdade" é a pergunta mais forte que o cabeçalho
              pode responder. E cabe sem empurrar nada — a Entrega é toda `laneStep` (stepper), então
              este slot de altura fixa estava reservado e VAZIO justamente nela. */}
          {stageTool ? (
            <PhaseToolLink tool={stageTool} boardId={config.id} />
          ) : isTerminalStage ? (
            <span
              title="O que está na fase Entrega (aprovado/integrando, ainda não no ar) vs já em produção (No ar)."
              className="truncate text-[11.5px] leading-snug text-fg-subtle"
            >
              {stagedCount && stagedCount > 0 ? (
                <span>
                  <span className="font-semibold text-fg-muted">{stagedCount}</span> em entrega · {total} no ar
                </span>
              ) : (
                <span>tudo no ar — nada em entrega</span>
              )}
            </span>
          ) : !isStepperZone && cols.filter((c) => c.def).length > 1 ? (
            <StepTrail cols={cols} byStatus={byStatus} />
          ) : null}
        </div>
      </header>
      <div className="col-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isStepperZone ? (
          <DeliveryStepperLane
            cols={cols}
            byStatus={byStatus}
            config={config}
            cardsById={cardsById}
            onOpen={onOpen}
            onAdvance={onAdvance}
            showMeta={showMeta}
            acceptsActive={acceptsActive}
            filtering={filtering}
          />
        ) : (
          <ColumnCardList
            dropId={entryId}
            cols={cols}
            byStatus={byStatus}
            config={config}
            cardsById={cardsById}
            onOpen={onOpen}
            isTerminal={isTerminalStage}
            stageName={stage.name}
            showMeta={showMeta}
            acceptsActive={acceptsActive}
            filtering={filtering}
          />
        )}
      </div>
    </section>
  );
}

/**
 * The flat card list of a PHASE (Triagem/Descoberta/Design/Construção/No ar): the UNION of every step's
 * cards in the column, newest on top — the steps are shown on each card (status line), not as sub-lanes.
 * One droppable whose id is the phase's ENTRY step, so a drop = "put this card in this phase" (onDragEnd
 * maps it). A terminal phase (No ar) caps to the N most-recent + a "ver todas" drawer.
 */
function ColumnCardList({
  dropId,
  cols,
  byStatus,
  config,
  cardsById,
  onOpen,
  isTerminal,
  stageName,
  showMeta,
  acceptsActive,
  filtering,
}: {
  dropId: string;
  cols: { id: string; def: StatusDef | null }[];
  byStatus: Map<string, Card[]>;
  config: BoardConfig;
  cardsById?: Map<string, Card>;
  onOpen: (id: string) => void;
  isTerminal?: boolean;
  stageName: string;
  showMeta?: boolean;
  /** false when the dragged card already belongs to this phase → suppress the (no-op) drop highlight */
  acceptsActive?: boolean;
  filtering?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  const [overflowOpen, setOverflowOpen] = useState(false);
  const cards = cols.flatMap((c) => byStatus.get(c.id) ?? []).sort(byUpdatedDesc);
  const capped = isTerminal ? cards.slice(0, TERMINAL_LANE_CAP) : cards;
  const overflow = cards.length - capped.length;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-[56px] flex-1 flex-col gap-2 rounded-lg p-1.5 transition",
        isOver && acceptsActive !== false && "bg-accent/10 ring-1 ring-inset ring-accent/40",
      )}
    >
      {cards.length === 0 ? (
        filtering ? <NoMatch /> : <p className="px-1 py-4 text-center text-[11px] text-fg-subtle">Vazio</p>
      ) : (
        <>
          <SortableContext id={dropId} items={capped.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            {capped.map((c) => (
              <KanbanCard key={c.id} card={c} config={config} cardsById={cardsById} onOpen={onOpen} showMeta={showMeta} />
            ))}
          </SortableContext>
          {overflow > 0 && (
            <button
              type="button"
              onClick={() => setOverflowOpen(true)}
              className="mt-0.5 rounded-md border border-dashed border-line px-2 py-1.5 text-[11px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
            >
              ver todas as {cards.length} →
            </button>
          )}
          {overflowOpen && (
            <TerminalOverflowDrawer cards={cards} title={stageName} onOpen={onOpen} onClose={() => setOverflowOpen(false)} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The folded per-phase automation menu (Notion-clean): a quiet "automação" trigger that reveals the phase's
 * automatable steps (those with a trigger/gate), each with an auto/manual toggle + the run-policy popover.
 * Replaces the per-step pill wall the stacked lanes used to show — control on demand, clean by default.
 */
function ColumnAutomationMenu({
  steps,
  onToggleAutorun,
  onUpdatePolicy,
}: {
  steps: { id: string; def: StatusDef | null }[];
  onToggleAutorun?: (statusId: string) => void;
  onUpdatePolicy?: (statusId: string, patch: Partial<StatusDef>) => void;
}) {
  const [open, setOpen] = useState(false);
  const automatable = steps.map((s) => s.def).filter((d): d is StatusDef => !!d && (!!d.trigger || !!d.gate));
  if (automatable.length === 0) return null;
  return (
    <div className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Automação dos steps desta fase"
        aria-label="Automação dos steps desta fase"
        className="text-fg-subtle transition hover:text-fg"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[65]" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-[70] mt-1 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
            {automatable.map((def) => {
              const auto = def.autorun === true;
              return (
                <div key={def.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={def.gate ? `Gate: ${GATE_LABEL[def.gate] ?? def.gate}` : undefined}>
                    {def.name}
                  </span>
                  {def.trigger && onToggleAutorun && (
                    <button
                      type="button"
                      onClick={() => onToggleAutorun(def.id)}
                      title={auto ? `Automático (${def.trigger}) — clique para tornar manual` : `Manual (${def.trigger}) — clique para automatizar`}
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition",
                        auto ? "bg-fg text-surface hover:bg-fg/85" : "bg-surface-hover text-fg-muted hover:bg-line",
                      )}
                    >
                      {auto ? "auto" : "manual"}
                    </button>
                  )}
                  {def.trigger && onUpdatePolicy && (
                    <ColumnPolicyPopover def={def} onChange={(patch) => onUpdatePolicy(def.id, patch)} />
                  )}
                  {!def.trigger && def.gate && <span className="shrink-0 text-[10px] text-fg-subtle">gate</span>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The collapsed DELIVERY lane: the entrega column's 5 delivery steps (revisao→merge→stage→
 * release→deploy) rendered as ONE droppable list of cards — each card carries its own stepper (the
 * evolving step text + counter + the Aprovar/Publicar buttons live on the KanbanCard). Unions the cards
 * of every step (so the operator sees one "Entrega" pile), newest on top. Drag is NOT a delivery affordance
 * here (the 2 human touches are the on-card buttons), but the lane stays a droppable so a stray card can be
 * recovered by dropping it back into the flow. Each step is also registered as a SortableContext id so
 * dnd-kit can still resolve a drop onto the lane.
 */
function DeliveryStepperLane({
  cols,
  byStatus,
  config,
  cardsById,
  onOpen,
  onAdvance,
  showMeta,
  acceptsActive,
  filtering,
}: {
  cols: { id: string; def: StatusDef | null }[];
  byStatus: Map<string, Card[]>;
  config: BoardConfig;
  cardsById?: Map<string, Card>;
  onOpen: (id: string) => void;
  onAdvance?: (cardId: string, toStatus: string) => void;
  showMeta?: boolean;
  /** false when the dragged card already belongs to this phase → suppress the (no-op) drop highlight */
  acceptsActive?: boolean;
  filtering?: boolean;
}) {
  // The lane's primary droppable is the FIRST delivery step (revisao) — a drop onto the bare lane lands a
  // card at the start of delivery (Aprovar). Cards keep their own status; the stepper drives the rest.
  const dropId = cols[0]?.id ?? "";
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  const cards = cols.flatMap((c) => byStatus.get(c.id) ?? []).sort(byUpdatedDesc);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-[48px] flex-1 flex-col gap-1.5 rounded-lg p-1.5 transition",
        isOver && acceptsActive !== false ? "bg-accent/10 ring-1 ring-accent/40" : "bg-surface/40",
      )}
    >
      {cards.length === 0 ? (
        filtering ? <NoMatch /> : <p className="px-1 py-3 text-center text-[11px] text-fg-subtle">Vazio</p>
      ) : (
        <SortableContext id={dropId} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((c) => (
            <KanbanCard
              key={c.id}
              card={c}
              config={config}
              cardsById={cardsById}
              onOpen={onOpen}
              onAdvance={onAdvance}
              showMeta={showMeta}
            />
          ))}
        </SortableContext>
      )}
    </div>
  );
}

/**
 * story-ex0160 — the "ver todas" overflow drawer for a capped terminal lane (No ar). A right-side
 * slide-over listing EVERY card of the lane (search + click-to-open), so the rest of the concluded
 * cards are reachable without polluting the column (only the 10 most-recent render inline).
 */
function TerminalOverflowDrawer({
  cards,
  title,
  onOpen,
  onClose,
}: {
  cards: Card[];
  title: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const needle = q.trim().toLowerCase();
  const filtered = needle ? cards.filter((c) => `${c.title} ${c.id}`.toLowerCase().includes(needle)) : cards;
  return (
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-sm flex-col border-l border-line bg-surface shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="flex-1 text-sm font-semibold text-fg">{title}</span>
          <span className="text-[11px] text-fg-subtle">{cards.length} cards</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="border-b border-line px-3 py-2">
          <div className="flex items-center gap-2 rounded-md border border-line bg-inset px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar…"
              className="h-8 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-8 text-center text-[12px] text-fg-subtle">Nenhum resultado.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpen(c.id);
                    }}
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-surface-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-fg">{c.title}</span>
                      <span className="block truncate text-[10px] text-fg-subtle">{c.id}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A PORTA de uma fase para a ferramenta que a aprofunda — declarada em `board.yaml`
 * (`columns[].tool`), nunca cravada aqui: o Kanban não sabe que existe uma "Entrega", ele sabe que
 * uma fase pode apontar para uma view.
 *
 * O rótulo, o ícone e o texto de ajuda vêm do REGISTRO de navegação (`nav-groups`) — a mesma fonte
 * que desenha o item no menu do bloco. Renomear a view num lugar renomeia a porta junto; foi
 * exatamente a divergência de nomes ("Entrega" a coluna × "Entrega" a página) que motivou tudo isto.
 * O verbo é o mesmo dos rodapés de popover ("Abrir Inbox →"), e não uma variante nova.
 */
function PhaseToolLink({ tool, boardId }: { tool: NavItem; boardId: string }) {
  const Icon = tool.icon;
  return (
    <Link
      href={tool.href(boardId)}
      title={tool.hint}
      className="group/tool -ml-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-[11.5px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-accent"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Abrir {tool.label}</span>
      <span aria-hidden className="shrink-0 transition-transform group-hover/tool:translate-x-0.5">
        →
      </span>
    </Link>
  );
}

/**
 * Column description with a UNIFORM footprint so every column's card list starts
 * at the same Y. Collapsed, the text occupies a fixed 3-line box (the same height
 * whether the description is one line or ten) and the "ver mais" affordance is an
 * overlay pinned to the bottom-right — it adds NO layout height, so columns stay
 * aligned regardless of which ones overflow. Clicking expands that column in place.
 */
function ColumnDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  const canToggle = overflowing || expanded;

  return (
    <div className="relative mt-1">
      <p
        ref={ref}
        onClick={() => canToggle && setExpanded((v) => !v)}
        title={expanded ? undefined : text}
        className={cn(
          "text-[11px] leading-snug text-fg-muted transition-all",
          // collapsed: a fixed 3-line box — identical height on every column
          expanded ? "" : "line-clamp-3 h-[2.85rem]",
          canToggle && "cursor-pointer",
        )}
      >
        {text}
      </p>
      {canToggle &&
        (expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mt-0.5 text-[10px] font-medium text-fg-subtle transition hover:text-fg-muted"
          >
            ver menos
          </button>
        ) : (
          // overlay: pinned bottom-right, matches the canvas bg so it reads over
          // the clamped last line WITHOUT consuming any header height
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="absolute bottom-0 right-0 rounded bg-canvas pl-2 text-[10px] font-medium text-fg-subtle transition hover:text-fg-muted"
          >
            ver mais
          </button>
        ))}
    </div>
  );
}
