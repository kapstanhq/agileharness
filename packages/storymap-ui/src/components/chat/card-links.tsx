"use client";

// Os ids de card na resposta do Jido viram o TÍTULO do card (link) na TELA — o provedor lê os títulos do board uma vez
// (getCardTitlesAction) e entrega a função de troca (copilot/card-links `linkCardIds`) a quem pinta a prosa do agente
// (hitl/HitlConversation `AgentProse`). Sem provedor, ou antes da leitura, o texto aparece como veio.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getCardTitlesAction } from "@/app/activity-actions";
import { linkCardIds } from "@/lib/storymap/copilot/card-links";
import { cardHref } from "@/lib/storymap/deep-links";

type Linkify = (text: string) => string;

const CardLinksContext = createContext<Linkify | null>(null);

/** A troca de ids por títulos desta conversa (null = sem board em volta, ou os títulos ainda não chegaram). */
export function useCardLinks(): Linkify | null {
  return useContext(CardLinksContext);
}

export function CardLinksProvider({ boardId, children }: { boardId: string; children: ReactNode }) {
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    getCardTitlesAction(boardId)
      .then((r) => {
        if (alive && r.ok) setTitles(new Map(Object.entries(r.data)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [boardId]);
  const linkify = useMemo<Linkify | null>(
    () => (titles.size ? (text: string) => linkCardIds(text, titles, (id) => cardHref(boardId, id)) : null),
    [titles, boardId],
  );
  return <CardLinksContext.Provider value={linkify}>{children}</CardLinksContext.Provider>;
}
