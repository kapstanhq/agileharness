"use client";

// The full-page detail of ONE Inbox item — the "página individual e página inteira" the Início
// Agêntico feed links to, styled like the card page (BoardHeader shell + a single reading column). The
// body is the REAL per-kind cockpit renderer with its inline actions (CockpitItemDetail), so answering
// / approving / resolving here does exactly what the cockpit does. A resolved/absent item shows a
// graceful "resolvido" state instead of a 404.

import Link from "next/link";
import { ArrowLeft, ExternalLink, Inbox } from "lucide-react";
import { BackButton } from "@/components/nav/NavShell";
import { BoardHeader } from "@/components/BoardHeader";
import { CockpitItemDetail } from "@/components/CockpitView";
import { inboxFocusHref } from "@/lib/storymap/deep-links";
import {
  COCKPIT_DEMAND_LABEL,
  cockpitItemShowsStatus,
  cockpitItemTitle,
} from "@/components/inicio/cockpit-labels";
import { cardSurface } from "@/lib/ui";
import { cn } from "@/lib/cn";
import type { CockpitItem } from "@/lib/storymap/demands";
import type { Board, BoardSummary } from "@/lib/storymap/types";

export function InboxItemScreen({
  board,
  boards,
  item,
}: {
  board: Board;
  boards: BoardSummary[];
  item: CockpitItem | null;
}) {
  const config = board.config;
  // Mesma régua do cartão aberto: o status do pipeline só aparece quando descreve MESMO um card
  // (nunca o "Capturando" do contêiner efêmero de uma proposta).
  const statusName =
    item && cockpitItemShowsStatus(item) && item.status
      ? (config.statuses.find((s) => s.id === item.status)?.name ?? null)
      : null;

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <BoardHeader boards={boards} config={config} view="inbox" />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-6">
        <div className="mb-5">
          <BackButton
            fallbackHref={`/board/${config.id}/inbox`}
            className="inline-flex items-center gap-1 text-[12px] text-fg-muted transition hover:text-fg"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Voltar
          </BackButton>
        </div>

        {item ? (
          <>
            <header className="mb-5">
              {/* O PEDIDO, não a categoria — a mesma frase que o cartão aberto do Inbox usa. */}
              <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-fg-subtle">
                {COCKPIT_DEMAND_LABEL[item.kind]}
              </p>
              <h1 className="mt-1.5 text-2xl font-bold leading-tight tracking-tight text-fg">
                {cockpitItemTitle(item)}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-fg-muted">
                {statusName && (
                  <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-fg-subtle">
                    {statusName}
                  </span>
                )}
                {item.cardId && (
                  <Link
                    href={`/board/${config.id}/card/${item.cardId}`}
                    prefetch={false}
                    className="inline-flex items-center gap-1 text-accent transition hover:underline"
                  >
                    Abrir card <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
                {item.cardId && (
                  <Link
                    href={inboxFocusHref(config.id, item.cardId)}
                    prefetch={false}
                    className="inline-flex items-center gap-1 transition hover:text-fg"
                  >
                    <Inbox className="h-3 w-3" /> Ver no fluxo do Inbox
                  </Link>
                )}
              </div>
            </header>

            <CockpitItemDetail config={config} boardId={config.id} item={item} cards={board.cards} />
          </>
        ) : (
          <div className={cn(cardSurface, "px-5 py-12 text-center")}>
            <p className="text-[14px] font-semibold text-fg">Este item já foi resolvido.</p>
            <p className="mt-1 text-[13px] text-fg-muted">Nada mais te espera aqui.</p>
            <Link
              href={`/board/${config.id}/inbox`}
              prefetch={false}
              className="mt-5 inline-flex items-center gap-1 text-[13px] font-semibold text-accent transition hover:underline"
            >
              Voltar para o Inbox
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
