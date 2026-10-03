"use client";

// O Inbox de TODOS os boards, lido UMA vez por página e repartido entre quem o mostra: o chip do Inbox, a aba do
// celular, a fala do Jido, o seletor de boards — e a raia do dono no Kanban (decidir-set.ts). Antes a barra tinha a sua
// cópia local deste hook; com a raia lendo o MESMO Decidir, duas cópias seriam duas varreduras caras (collectInbox lê
// todos os boards) a cada `inbox.changed`, e dois números que podem divergir por um instante.
//
// `null` até a PRIMEIRA resposta: «0» é uma medida («nada para decidir»), e mostrá-lo antes de medir afirmava ao dono
// que não havia nada — exatamente quando ainda não se sabia.

import { useEffect, useSyncExternalStore } from "react";
import { getInboxSummaryAction } from "@/app/actions";
import { useInboxChanged } from "@/components/inbox/useInboxChanged";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";

export interface InboxSummary {
  /** Decidir em todos os boards — o único número do badge. */
  total: number;
  acompanhar: number;
  byBoard: Record<string, number>;
  /** as entradas de Decidir (sem o item cru), na ordem do Inbox. */
  entries: InboxEntry[];
}

let current: InboxSummary | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Relê o Inbox — uma leitura em voo por vez, por mais consumidores que peçam juntos. */
function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = getInboxSummaryAction()
    .then((r) => {
      if (!r.ok || !r.data) return;
      current = r.data;
      for (const fn of listeners) fn();
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** O Inbox de todos os boards (ou null antes da 1ª resposta); relê sozinho quando um `inbox.changed` chega. */
export function useInboxSummary(): InboxSummary | null {
  const snap = useSyncExternalStore(subscribe, () => current, () => null);
  useEffect(() => {
    void load();
  }, []);
  // Sem poll: o número relê quando o Inbox de QUALQUER board muda (cards, sidecars, ledgers, a fila do train).
  useInboxChanged(() => void load(), { delayMs: 600 });
  return snap;
}
