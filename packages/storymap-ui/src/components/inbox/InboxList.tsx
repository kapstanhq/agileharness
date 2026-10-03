"use client";

// A LISTA de itens do Inbox — linhas (InboxItemCard `row`) que abrem o item numa folha (InboxSheet). Serve a tela do
// Inbox e o bloco da home: a mesma linha, o mesmo toque, a mesma folha.
//
// `?item=<id>` (B11) abre a folha direto no item — o link de um item leva ao ITEM, nunca ao primeiro do card.

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { findInboxItem } from "@/lib/storymap/deep-links";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { InboxItemCard, type InboxBoardCtx, type InboxReceipt } from "./InboxItemCard";
import { CardLiveStatusLine } from "@/components/CardLiveStatus";
import { InboxSheet } from "./InboxSheet";

export function InboxList({
  entries,
  boards,
  now,
  showBoard = false,
  sectionLabel,
  onDone,
  className,
  deepLink = true,
}: {
  entries: InboxEntry[];
  boards: Record<string, InboxBoardCtx>;
  now: number;
  showBoard?: boolean;
  /** o que a numeração da folha conta («Decidir», «Acompanhar»). */
  sectionLabel: string;
  onDone?: (r: InboxReceipt) => void;
  className?: string;
  /** lê `?item=` para abrir a folha no item — só UMA lista da tela deve ler (a de Decidir, ou a única). */
  deepLink?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const params = useSearchParams();
  const wanted = deepLink ? params.get("item") : null;
  useEffect(() => {
    if (!wanted) return;
    const hit = findInboxItem(
      entries.map((e) => ({ id: e.itemId, key: e.key })),
      wanted,
    );
    if (hit) setOpen(hit.key);
  }, [wanted, entries]);

  if (entries.length === 0) return null;
  // Em Acompanhar, cada linha de card diz QUEM age nele agora — a MESMA linha do card do Kanban (CardLiveStatus.tsx).
  const acompanhar = sectionLabel === "Acompanhar";
  const liveLine = (e: InboxEntry) => {
    const ctx = boards[e.boardId];
    const card = e.cardId ? ctx?.cardsById.get(e.cardId) : undefined;
    return card && ctx ? <CardLiveStatusLine boardId={e.boardId} card={card} config={ctx.config} variant="row" /> : undefined;
  };
  return (
    <>
      <ul className={cn("divide-y divide-line-muted overflow-hidden rounded-xl border border-line bg-surface", className)}>
        {entries.map((e) => (
          <li key={e.key}>
            <InboxItemCard entry={e} density="row" now={now} showBoard={showBoard} onOpen={() => setOpen(e.key)} live={acompanhar ? liveLine(e) : undefined} />
          </li>
        ))}
      </ul>
      {open && (
        <InboxSheet
          entries={entries}
          startKey={open}
          sectionLabel={sectionLabel}
          boards={boards}
          now={now}
          showBoard={showBoard}
          onClose={() => setOpen(null)}
          onDone={onDone}
        />
      )}
    </>
  );
}
