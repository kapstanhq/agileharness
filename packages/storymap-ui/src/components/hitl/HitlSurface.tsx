"use client";

// <HitlSurface variant> — embrulha um conteúdo HITL (ou qualquer conteúdo) em diferentes shells, reusando
// os tokens e a convenção de z-index dos overlays existentes: "popover" (ancorado, portal), "drawer" (painel
// lateral; bottom-sheet no mobile), "modal" (centrado) e "inline" (bloco emoldurado, sem overlay). O Escape/
// scroll/foco vem do useDismissable. O host controla `open`.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useDismissable } from "@/components/hitl/useDismissable";

const PANEL = "rounded-2xl border border-line bg-surface shadow-2xl";

export function HitlSurface({
  variant,
  open,
  onClose,
  anchorRef,
  title,
  width = 360,
  children,
}: {
  variant: "popover" | "drawer" | "modal" | "inline";
  open: boolean;
  onClose: () => void;
  /** popover only — elemento âncora para posicionar. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  title?: string;
  /** popover width (px). */
  width?: number;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => setMounted(true), []);
  useDismissable({ open, onClose, closeOnScroll: variant === "popover" });

  // popover: posiciona abaixo da âncora, preso à viewport.
  useEffect(() => {
    if (variant !== "popover" || !open || !anchorRef?.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    const top = Math.min(r.bottom + 6, window.innerHeight - 120);
    setPos({ top, left });
  }, [variant, open, anchorRef, width]);

  const header = title ? (
    <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
      <span className="text-[13px] font-semibold text-fg">{title}</span>
      <button
        type="button"
        onClick={onClose}
        className="rounded p-0.5 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
        title="Fechar"
        aria-label="Fechar"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  ) : null;

  // INLINE — bloco emoldurado, sem overlay (o host gerencia visibilidade).
  if (variant === "inline") {
    if (!open) return null;
    return (
      <div className={cn(PANEL, "overflow-hidden")}>
        {header}
        <div className="p-3">{children}</div>
      </div>
    );
  }

  if (!open || !mounted) return null;

  // POPOVER — portal ancorado.
  if (variant === "popover") {
    return createPortal(
      <>
        <div className="fixed inset-0 z-[90]" onClick={onClose} />
        <div
          className={cn(PANEL, "fixed z-[91] overflow-hidden")}
          style={{ top: pos?.top ?? 80, left: pos?.left ?? 80, width }}
          onClick={(e) => e.stopPropagation()}
        >
          {header}
          <div className="p-3">{children}</div>
        </div>
      </>,
      document.body,
    );
  }

  // DRAWER — painel lateral (desktop) / bottom-sheet (mobile).
  if (variant === "drawer") {
    return createPortal(
      <div className="fixed inset-0 z-[92]">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div
          className={cn(
            "absolute border-line bg-surface shadow-2xl",
            "inset-x-0 bottom-0 rounded-t-2xl border-t md:inset-y-0 md:right-0 md:left-auto md:w-[420px] md:rounded-none md:border-l md:border-t-0",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {header}
          <div className="board-scroll max-h-[70vh] overflow-y-auto p-3 md:max-h-none md:h-[calc(100%-44px)]">{children}</div>
        </div>
      </div>,
      document.body,
    );
  }

  // MODAL — centrado.
  return createPortal(
    <div className="fixed inset-0 z-[93] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={cn(PANEL, "relative w-full max-w-md overflow-hidden")} onClick={(e) => e.stopPropagation()}>
        {header}
        <div className="p-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
