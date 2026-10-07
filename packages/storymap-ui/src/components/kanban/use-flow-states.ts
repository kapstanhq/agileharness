// O ESTADO DO DESENHO de cada item — a régua que o Kanban e a página da funcionalidade dividem (fase 7).
//
// O estado sai de UMA conta: a linha de estado viva (useBoardLiveStatuses → card-live-status.ts), o Decidir do Inbox
// (a única fonte de «precisa de você») e o ritmo do board, reduzidos por kanban-features `designState`; depois a RAIA
// ajusta a vez (`laneDesignState`: a vez em Construindo espera condutor, a da Entrega é do sistema). As duas telas
// leem daqui, então um item nunca está «Rodando» no quadro e «Na fila» na página dele.
//
//   • `flowStatesOf` — a redução, pura: o Kanban a chama com o que já tem em mão (a linha viva e o Decidir dele);
//   • `useOwnerDecisions` — o Decidir vivo deste board (o que a página server leu, depois a leitura do chip do Inbox);
//   • `useFlowStates` — tudo junto, para a tela que só precisa dos estados (a página da funcionalidade).

import { useCallback, useMemo } from "react";
import { ownerDecisionsFromEntries, type OwnerDecisions } from "@/lib/storymap/inbox/decidir-set";
import { designState, kanbanLanes, laneDesignState, laneIndexOf, type DesignStateInput, type FlowState, type KanbanLane } from "@/lib/storymap/kanban-features";
import { resolveConductorPolicy } from "@/lib/storymap/driver";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { useBoardLiveStatuses } from "@/components/CardLiveStatus";
import { ownerByCard } from "@/components/OwnerDecisionsContext";
import { useAgentPresence } from "@/components/RunnerStatusProvider";
import { useInboxSummary } from "@/components/useInboxSummary";
import { useKanbanBoardPace } from "./KanbanPaceControl";

/** O que a redução precisa saber de cada item além do card: a linha viva e se o dono tem decisão nele. */
export interface FlowStateFacts {
  live: DesignStateInput["live"];
  owner: boolean;
}

export interface FlowStatesInput {
  boardPaused: boolean;
  pauseMode: "drain" | "stop";
  now: number;
  /** as raias do quadro e a raia de cada item (o índice em `lanes`, -1 fora do quadro). */
  lanes: readonly KanbanLane[];
  laneOf: (card: Card, index: number) => number;
  /** as vagas de condutor do board (0 = sem condutor: a vez em Construindo é só «na fila»). */
  slots: number;
}

/** O estado do desenho de cada item. PURA (a mesma conta nas duas telas). */
export function flowStatesOf(items: readonly Card[], factsOf: (card: Card) => FlowStateFacts, input: FlowStatesInput): Map<string, FlowState> {
  const m = new Map<string, FlowState>();
  items.forEach((c, k) => {
    const facts = factsOf(c);
    const base = designState({
      live: facts.live,
      owner: facts.owner,
      boardPaused: input.boardPaused,
      pauseMode: input.pauseMode,
      updatedMs: c.updatedMs,
      deferred: !!c.deferred,
      blocked: (c.findings ?? []).some((f) => f.severity === "blocker" && (f.status ?? "open") === "open"),
      now: input.now,
    });
    // o estado pela RAIA (laneDesignState): a vez em Construindo espera condutor; a vez na Entrega é do sistema
    const lane = input.lanes[input.laneOf(c, k)];
    m.set(c.id, lane ? laneDesignState(base, lane.role, input.slots) : base);
  });
  return m;
}

/**
 * O DECIDIR deste board, vivo: o que a página server leu do coletor do Inbox (boardDecidirCardIds) até a primeira
 * leitura do cliente, e depois a MESMA leitura do chip do Inbox (useInboxSummary, que relê a cada `inbox.changed`),
 * pela MESMA função pura. O estado «precisa de você» do card e o botão primário dele leem daqui — nunca por status.
 */
export function useOwnerDecisions(boardId: string, initial: OwnerDecisions | null): OwnerDecisions | null {
  const summary = useInboxSummary();
  return useMemo(() => (summary ? ownerDecisionsFromEntries(summary.entries, boardId) : initial), [summary, boardId, initial]);
}

/**
 * Os estados do desenho dos itens dados, com tudo o que a conta lê (a linha viva, o Decidir, o ritmo, as vagas de
 * condutor e as raias do board). Para a tela que mostra itens sem ser o quadro — a página da funcionalidade.
 */
export function useFlowStates(config: BoardConfig, items: readonly Card[], initialOwner: OwnerDecisions | null, now: number) {
  const owner = useOwnerDecisions(config.id, initialOwner);
  const ownerMap = useMemo(() => ownerByCard(owner), [owner]);
  const live = useBoardLiveStatuses(config.id, items, config, ownerMap);
  const pace = useKanbanBoardPace(config.id);
  const paused = pace.view?.level === "paused" && pace.view.source !== "disarmed" && pace.view.source !== "organize-only";
  const pauseMode = pace.view?.mode ?? "drain";
  const { presence } = useAgentPresence();
  const slots = presence.slots.find((s) => s.board === config.id)?.max ?? resolveConductorPolicy(config)?.maxSessions ?? 0;
  const lanes = useMemo(() => kanbanLanes(config), [config]);
  const states = useMemo(
    () =>
      flowStatesOf(
        items,
        (c) => {
          const l = live.get(c.id) ?? null;
          return { live: l ? { kind: l.kind, presence: l.presence } : null, owner: ownerMap.has(c.id) };
        },
        { boardPaused: paused, pauseMode, now, lanes, laneOf: (c) => laneIndexOf(c.status, lanes, config), slots },
      ),
    [items, live, ownerMap, paused, pauseMode, now, lanes, config, slots],
  );
  const stateOf = useCallback((id: string): FlowState => states.get(id) ?? "queued", [states]);
  return { stateOf, live, ownerMap, lanes };
}
