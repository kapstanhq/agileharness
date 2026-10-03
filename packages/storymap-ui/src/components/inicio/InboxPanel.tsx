"use client";

// O INBOX na home — as linhas de DECIDIR da tela do Inbox (InboxItemCard `row`), até quatro, e o toque abre a MESMA
// folha. Onda 2 do redesenho (F18 da auditoria de UX): os dois cartões pautados de 150 px mostravam só dois itens,
// 60% de pauta vazia no celular, e o «+1» que escondia a decisão real era um alvo de 23 px na borda. Agora: as
// decisões em linhas compactas, e o resto dito em palavras («+2 para decidir · 3 acompanhando»).

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { inboxHref } from "@/lib/storymap/deep-links";
import { inboxSections, inboxSummary, type InboxEntry } from "@/lib/storymap/inbox/entries";
import { InboxItemCard } from "@/components/inbox/InboxItemCard";
import { InboxSheet } from "@/components/inbox/InboxSheet";
import type { BoardConfig, Card } from "@/lib/storymap/types";

/** Quantas linhas ficam à vista na home antes do «ver todos». */
const VISIBLE_ROWS = 4;

export function InboxPanel({
  boardId,
  config,
  cards,
  entries,
  now,
}: {
  boardId: string;
  config: BoardConfig;
  cards: Card[];
  /** as entradas do Inbox (collectBoardInbox) — a home mostra as de Decidir e conta o resto. */
  entries: InboxEntry[];
  now: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const boards = useMemo(() => ({ [boardId]: { config, cardsById: new Map(cards.map((c) => [c.id, c])) } }), [boardId, config, cards]);
  const { decidir } = useMemo(() => inboxSections(entries), [entries]);
  const summary = useMemo(() => inboxSummary(entries), [entries]);
  const shown = decidir.slice(0, VISIBLE_ROWS);

  return (
    <section aria-label="Inbox" className="min-w-0">
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <Link href={inboxHref(boardId)} prefetch={false} className="group inline-flex min-h-11 items-center gap-2">
          <span className="text-[15.5px] font-semibold tracking-tight text-fg transition group-hover:text-accent-ink">Inbox</span>
          {summary.decidir > 0 && (
            <span className="inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-[5px] bg-brand px-1.5 text-[11px] font-bold tabular-nums text-white">{summary.decidir}</span>
          )}
          <ChevronRight className="h-3.5 w-3.5 text-fg-subtle transition group-hover:translate-x-0.5" />
        </Link>
      </div>

      {decidir.length === 0 ? (
        <div className="flex min-h-[96px] items-center justify-center rounded-xl border border-dashed border-line px-6 text-center">
          <p className="text-[14px] text-fg-muted">
            Nada para você decidir.{summary.acompanhar > 0 ? ` ${config.name} tem ${summary.acompanhar} em Acompanhar.` : ""}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line-muted overflow-hidden rounded-xl border border-line bg-surface">
          {shown.map((e) => (
            <li key={e.key}>
              <InboxItemCard entry={e} density="row" now={now} onOpen={() => setOpen(e.key)} />
            </li>
          ))}
        </ul>
      )}
      {(decidir.length > shown.length || summary.acompanhar > 0) && (
        <Link href={inboxHref(boardId)} prefetch={false} className="mt-1.5 inline-flex min-h-11 items-center gap-1 px-1 text-[13.5px] font-semibold text-accent-ink hover:underline">
          {decidir.length > shown.length ? `+${decidir.length - shown.length} para decidir · ` : ""}
          {summary.acompanhar} acompanhando <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      )}

      {open && <InboxSheet entries={decidir} startKey={open} sectionLabel="Decidir" boards={boards} now={now} showBoard={false} onClose={() => setOpen(null)} />}
    </section>
  );
}
