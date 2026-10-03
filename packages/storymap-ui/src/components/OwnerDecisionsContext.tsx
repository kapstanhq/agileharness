"use client";

// O DECIDIR do board aberto e as LINHAS DE ESTADO dos cards dele, como contexto da tela do Kanban.
//
// Um módulo à parte porque três lados o leem — a linha de estado do card (CardLiveStatus), o botão de resolver do
// rodapé (RunnerStatusProvider) e o próprio Kanban, que os fornece — e os dois primeiros já se importam um ao outro.

import { createContext, useContext } from "react";
import type { CardLiveStatus } from "@/lib/storymap/card-live-status";
import type { OwnerCardDecision, OwnerDecisions } from "@/lib/storymap/inbox/decidir-set";

/**
 * O Decidir do board aberto (inbox/decidir-set.ts), quando a tela o tem — o Kanban. Presente, ele é a ÚNICA fonte de
 * «precisa de você» do card: a pílula aparece exatamente nos cards da raia do dono. Ausente (a página do card, a linha
 * do Inbox), cada card pergunta ao modelo do Inbox sozinho (cardInboxSignal).
 */
export const OwnerDecisionsContext = createContext<ReadonlyMap<string, OwnerCardDecision> | undefined>(undefined);

/** As linhas de estado de TODOS os cards do board, calculadas uma vez (useBoardLiveStatuses) — a legenda, o pulso, as
 *  seções da raia e o próprio card leem a MESMA linha, no mesmo instante. */
export const BoardLiveContext = createContext<ReadonlyMap<string, CardLiveStatus | null> | undefined>(undefined);

/** O Decidir do board indexado por card. `null` (o Inbox ilegível) = ninguém em Decidir — nunca um palpite. PURA. */
export function ownerByCard(d: OwnerDecisions | null): ReadonlyMap<string, OwnerCardDecision> {
  return new Map((d?.cards ?? []).map((c) => [c.cardId, c] as const));
}

export function OwnerDecisionsProvider({ value, children }: { value: ReadonlyMap<string, OwnerCardDecision>; children: React.ReactNode }) {
  return <OwnerDecisionsContext.Provider value={value}>{children}</OwnerDecisionsContext.Provider>;
}

export function BoardLiveProvider({ value, children }: { value: ReadonlyMap<string, CardLiveStatus | null>; children: React.ReactNode }) {
  return <BoardLiveContext.Provider value={value}>{children}</BoardLiveContext.Provider>;
}

/** A decisão do dono que o card carrega no board aberto — null fora de Decidir, undefined sem o Kanban em volta. */
export function useOwnerDecisionFor(cardId: string): OwnerCardDecision | null | undefined {
  const byCard = useContext(OwnerDecisionsContext);
  return byCard ? (byCard.get(cardId) ?? null) : undefined;
}

