"use client";

// O ITEM ABERTO — uma folha de altura inteira no celular (painel central no computador), com a navegação no alto
// («‹ 1 de 5 · Decidir ›») e as opções presas embaixo (InboxItemCard densidade `sheet`). Substitui o carrossel da
// home (InboxOverlay): ali o rodapé fixo era o de NAVEGAR e cobria justamente a ação do item.
//
// Três cuidados de acessibilidade (F24 da auditoria de UX):
//   • a página ATRÁS fica `inert` enquanto a folha está aberta — fora do foco e da árvore de acessibilidade (o
//     `aria-modal` sozinho deixava o Kanban de trás no tab);
//   • o foco entra na folha ao abrir e volta para quem a abriu ao fechar;
//   • Esc fecha; ← e → trocam de item.
//
// O RECIBO fica: depois de uma ação a lista recarrega e o item some dela, mas a folha segura o retrato do item até o
// dono tocar «Próximo» ou fechar — o «Feito — …» nunca some debaixo do dedo.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { formatDecisionText, localTimeFormatter } from "@/lib/storymap/inbox/copy";
import { useOwnerTimeZone } from "@/components/OwnerTimeZone";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { InboxItemCard, type InboxBoardCtx, type InboxReceipt } from "./InboxItemCard";

/** Marca o resto da página como `inert` enquanto `active` — e devolve como estava ao fechar. */
function useInertBackground(host: HTMLElement | null, active: boolean): void {
  useEffect(() => {
    if (!active || !host) return;
    const touched: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || !(el instanceof HTMLElement) || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      touched.push(el);
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.dataset.inboxSheet = "open";
    return () => {
      for (const el of touched) el.removeAttribute("inert");
      document.body.style.overflow = prevOverflow;
      delete document.body.dataset.inboxSheet;
    };
  }, [host, active]);
}

export function InboxSheet({
  entries,
  startKey,
  sectionLabel,
  boards,
  now,
  showBoard,
  onClose,
  onDone,
}: {
  /** a lista na ordem em que a tela a mostra — a navegação anda por ela. */
  entries: InboxEntry[];
  /** o item que abriu a folha. */
  startKey: string;
  /** «Decidir» / «Acompanhar» — o que a numeração conta. */
  sectionLabel: string;
  boards: Record<string, InboxBoardCtx>;
  now: number;
  showBoard: boolean;
  onClose: () => void;
  onDone?: (r: InboxReceipt) => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [key, setKey] = useState(startKey);
  // o retrato do item mostrado — sobrevive à lista recarregar sem ele (o recibo precisa ficar à vista)
  const snapshot = useRef<InboxEntry | null>(entries.find((e) => e.key === startKey) ?? null);
  const lastIndex = useRef(Math.max(0, entries.findIndex((e) => e.key === startKey)));
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.dataset.inboxSheetHost = "";
    document.body.appendChild(el);
    setHost(el);
    opener.current = document.activeElement;
    return () => {
      el.remove();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  useInertBackground(host, true);

  const live = entries.find((e) => e.key === key) ?? null;
  if (live) snapshot.current = live;
  const current = live ?? snapshot.current;
  const index = live ? entries.findIndex((e) => e.key === key) : lastIndex.current;
  if (live) lastIndex.current = index;
  const total = entries.length;

  const neighbor = useCallback(
    (delta: number): InboxEntry | null => {
      if (total === 0) return null;
      if (live) return total > 1 ? entries[(index + delta + total) % total] : null;
      // o item mostrado saiu da lista: o «próximo» é quem ocupa o lugar dele agora
      const at = delta > 0 ? Math.min(index, total - 1) : (index - 1 + total) % total;
      return entries[at] ?? null;
    },
    [entries, index, live, total],
  );
  const go = useCallback(
    (delta: number) => {
      const n = neighbor(delta);
      if (n) setKey(n.key);
      else onClose();
    },
    [neighbor, onClose],
  );

  useEffect(() => {
    dialogRef.current?.focus();
  }, [host, key]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) go(1);
      else if (e.key === "ArrowLeft" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  const tz = useOwnerTimeZone();
  const fmt = useMemo(() => localTimeFormatter(now, tz), [now, tz]);
  const next = neighbor(1);
  if (!host || !current) return null;

  const position = live ? `${index + 1} de ${total}` : total > 0 ? `feito · ${total} restantes` : "feito";

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-stretch justify-center sm:items-center sm:p-6" role="presentation">
      <button type="button" aria-label="Fechar" tabIndex={-1} onClick={onClose} className="absolute inset-0 hidden cursor-default bg-canvas/70 backdrop-blur-sm sm:block" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={formatDecisionText(current.decision.ask, fmt)}
        className="relative flex h-full w-full flex-col bg-surface outline-none sm:h-auto sm:max-h-[90vh] sm:max-w-[680px] sm:rounded-2xl sm:border sm:border-line sm:shadow-2xl"
      >
        <div className="flex flex-none items-center gap-1 border-b border-line px-2 py-1.5" style={{ paddingTop: "max(0.375rem, env(safe-area-inset-top))" }}>
          <button type="button" onClick={() => go(-1)} disabled={total < 2 && Boolean(live)} aria-label="Item anterior" className="flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-hover disabled:opacity-30">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="min-w-0 flex-1 text-center text-[13px] font-medium tabular-nums text-fg-subtle">
            {position} · {sectionLabel}
          </span>
          <button type="button" onClick={() => go(1)} disabled={!next} aria-label="Próximo item" className="flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-hover disabled:opacity-30">
            <ChevronRight className="h-5 w-5" />
          </button>
          <button type="button" onClick={onClose} aria-label="Fechar" className="flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted transition hover:bg-surface-hover">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 sm:px-5" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <InboxItemCard
            key={current.key}
            entry={current}
            density="sheet"
            now={now}
            board={boards[current.boardId]}
            showBoard={showBoard}
            onDone={onDone}
            onNext={next ? () => go(1) : undefined}
            nextLabel={next ? formatDecisionText(next.decision.ask, fmt) : null}
          />
        </div>
      </div>
    </div>,
    host,
  );
}
