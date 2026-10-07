"use client";

// O INBOX na barra do topo — o ícone e o NÚMERO de decisões (Decidir: a MESMA leitura do `useInboxSummary`, que é a
// única fonte desse número na página). Numa página de BOARD (`scope="board"`) o número e o painel são SÓ desse board —
// o «precisa de você» do projeto aberto, como no desenho; nas páginas do app (/inbox, /semana…) é o de todos os boards.
// Leva ao Inbox; no hover (ou no 1º toque) mostra as primeiras decisões na LINHA do item do Inbox (InboxItemRow: o
// contexto e «o que eu preciso de você», as mesmas palavras da lista), cada uma levando ao item na lista.
//
// DESVIO CONSCIENTE do desenho (que tem só o ícone + o número, sem painel): sem o painel, as decisões só se veem
// saindo da tela. Ele usa a linha do item (inbox-anatomy.test.ts) e a mesma contagem (inbox-badge.test.ts).
//
// O número é tinta (`text-fg`, 600), não âmbar: na barra nova o âmbar ficou só para o ESTADO do card («precisa
// de você»), e um contador âmbar fixo no topo de toda tela ensinava a ignorá-lo.

import type { PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { useHoverPopover, NavPopoverEmpty, NavPopoverTitle } from "@/components/nav/NavShell";
import { InboxItemRow } from "@/components/inbox/InboxItem";
import { appBarIconButton, appBarPopover } from "@/components/shell/app-bar-shell";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";

/** Quantas decisões o painel lista antes de mandar para o Inbox inteiro (o resto é ANUNCIADO no rodapé). */
const POPOVER_TOP = 5;

export function InboxIconLink({
  href,
  total,
  acompanhar,
  entries,
  scope = "all",
}: {
  href: string;
  /** Decidir (do board, ou de todos); null antes da 1ª resposta (o ícone não afirma «0» sem ter medido). */
  total: number | null;
  acompanhar: number;
  entries: InboxEntry[];
  /** `board` = o número é só do board aberto (a frase diz «neste board»); `all` = de todos os boards. */
  scope?: "board" | "all";
}) {
  const where = scope === "board" ? " neste board" : "";
  const { open, setOpen, openNow, closeSoon, ref } = useHoverPopover();
  // O relógio é lido UMA vez por render: as linhas mostram idades que batem entre si.
  const now = Date.now();
  const top = entries.slice(0, POPOVER_TOP);
  // No TOQUE o 1º toque abre o painel em vez de navegar (sem hover, a lista seria inalcançável); o rodapé leva
  // ao mesmo destino. Mouse, caneta e teclado seguem o link.
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType !== "touch") return;
    e.preventDefault();
    setOpen((o) => !o);
  };

  return (
    <div ref={ref} className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <Link
        href={href}
        onPointerDown={onPointerDown}
        title={total == null ? "Inbox — lendo…" : total > 0 ? `Inbox: ${total} precisa${total === 1 ? "" : "m"} de você${where}` : `Inbox: nada precisa de você${where} agora`}
        aria-label={total == null ? "Inbox — lendo" : `Inbox — ${total} precisa${total === 1 ? "" : "m"} de você${where}`}
        className={cn(appBarIconButton, open && "bg-surface-hover")}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
        <b className="font-semibold tabular-nums text-fg">{total == null ? "" : total}</b>
      </Link>
      {open && (
        <div
          role="dialog"
          aria-label="Inbox"
          className={cn(
            appBarPopover,
            "fixed right-2 top-[56px] w-[min(20rem,calc(100vw-1rem))] p-2 md:absolute md:right-0 md:top-[calc(100%+6px)] md:w-80",
          )}
        >
          <NavPopoverTitle meta={total == null ? "lendo…" : `${total} precisa${total === 1 ? "" : "m"} de você · ${acompanhar} com os agentes`}>Inbox</NavPopoverTitle>
          {top.length === 0 ? (
            <NavPopoverEmpty>{`Nada precisa de você${where} agora.`}</NavPopoverEmpty>
          ) : (
            <ul className="flex max-h-[min(60vh,24rem)] flex-col overflow-y-auto overscroll-contain" onClick={() => setOpen(false)}>
              {top.map((e) => (
                <li key={e.key}>
                  <InboxItemRow entry={e} now={now} showBoard={scope !== "board"} />
                </li>
              ))}
            </ul>
          )}
          <Link
            href={href}
            onClick={() => setOpen(false)}
            className="mt-1 flex min-h-10 w-full items-center rounded-md px-1.5 text-[12px] font-medium text-accent-ink transition hover:bg-surface-hover md:min-h-9"
          >
            {entries.length > top.length ? `Ver os ${entries.length} itens →` : "Abrir o Inbox →"}
          </Link>
        </div>
      )}
    </div>
  );
}
