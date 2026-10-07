"use client";

// A página de UM item do Inbox — o MESMO item da lista (InboxItem), sozinho, com «Mais detalhes» aberto, dentro da
// casca do board. Um item já resolvido mostra um estado digno em vez de um 404, dizendo o desfecho que se sabe (o recibo
// do dono, com o «Desfazer» quando ainda vale; a decisão do sistema; o prazo; onde o card está) — e só então «não sei».

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { BackButton } from "@/components/nav/NavShell";
import { BoardHeader } from "@/components/BoardHeader";
import { ToastProvider } from "@/components/Toast";
import { InboxItem } from "@/components/inbox/InboxItem";
import { UndoControl } from "@/components/inbox/UndoControl";
import { useNow } from "@/components/inbox/useNow";
import { formatDecisionText, localTimeFormatter } from "@/lib/storymap/inbox/copy";
import { useOwnerTimeZone } from "@/components/OwnerTimeZone";
import { inboxAbsentState, type InboxAbsentState } from "@/components/inbox/cockpit-labels";
import { inboxHref } from "@/lib/storymap/deep-links";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { cardSurface, composerGutter } from "@/lib/ui";
import { cn } from "@/lib/cn";
import type { Board, BoardSummary } from "@/lib/storymap/types";

export function InboxItemScreen({
  board,
  boards,
  entry,
  absent,
}: {
  board: Board;
  boards: BoardSummary[];
  entry: InboxEntry | null;
  /** o que dizer quando `entry` é null — resolvido no servidor (o desfecho que o disco sabe). */
  absent?: InboxAbsentState | null;
}) {
  const config = board.config;
  const now = useNow();
  const missing = absent ?? inboxAbsentState(null);
  const boardCtx = useMemo(() => ({ config, cardsById: new Map(board.cards.map((c) => [c.id, c])) }), [config, board.cards]);
  const tz = useOwnerTimeZone();
  const fmt = useMemo(() => localTimeFormatter(now, tz), [now, tz]);

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-canvas">
        <BoardHeader boards={boards} config={config} view="inbox" />
        <main className={`mx-auto w-full max-w-3xl flex-1 px-4 pt-5 md:px-6 ${composerGutter}`}>
          <div className="mb-4">
            <BackButton fallbackHref={inboxHref(config.id)} className="inline-flex min-h-11 items-center gap-1 text-[13px] text-fg-muted transition hover:text-fg">
              <ArrowLeft className="h-4 w-4" /> Voltar
            </BackButton>
          </div>

          {entry ? (
            // Um cabeçalho só: o do item (o contexto e o que o agente precisa) — F17. O recibo fica (sem `onExpired`).
            // O que o SISTEMA decide (Acompanhar) abre na forma curta, como na lista: o que acontece e quem cuida, só os
            // botões de desfazer/reabrir — «O que eu preciso de você» ali convidava o dono a passar por cima do pipeline.
            entry.decision.bucket === "acompanhar" ? (
              <section aria-labelledby="inbox-item-caring">
                <p id="inbox-item-caring" className="mb-2 text-[13px] font-semibold text-fg-subtle">
                  Os agentes estão cuidando
                </p>
                <div className={cn(cardSurface, "overflow-hidden")}>
                  <InboxItem entry={entry} now={now} board={boardCtx} variant="short" detailsOpen />
                </div>
              </section>
            ) : (
              <div className={cn(cardSurface, "overflow-hidden")}>
                <InboxItem entry={entry} now={now} board={boardCtx} detailsOpen />
              </div>
            )
          ) : (
            <div className={cn(cardSurface, "px-5 py-12 text-center")}>
              <p className="text-[15px] font-semibold text-fg">{missing.title}</p>
              <p className="mt-1 text-[14px] text-fg-muted">{formatDecisionText(missing.detail, fmt)}</p>
              {missing.undo && (
                <div className="mt-4 flex justify-center">
                  <UndoControl boardId={config.id} undo={{ source: "receipt", id: missing.undo.receiptId, label: missing.undo.label }} />
                </div>
              )}
              {missing.href && (
                <Link href={missing.href} prefetch={false} className="mt-5 flex min-h-11 items-center justify-center text-[14px] font-semibold text-accent-ink hover:underline">
                  {missing.hrefLabel ?? "Abrir"}
                </Link>
              )}
              <Link href={inboxHref(config.id)} prefetch={false} className="mt-5 inline-flex min-h-11 items-center gap-1 text-[14px] font-semibold text-accent-ink hover:underline">
                Abrir o Inbox
              </Link>
            </div>
          )}
        </main>
      </div>
    </ToastProvider>
  );
}
