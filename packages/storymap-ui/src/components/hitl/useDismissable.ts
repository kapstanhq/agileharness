"use client";

// Hook MÍNIMO de overlay reutilizável — Escape + (opcional) fechar no scroll/resize + autofocus. É a UNIÃO
// exata dos handlers que ConfirmDialog/MoveToPopover/HealthPill já reimplementam; usado pelo HitlSurface por
// ora (adotável pelos outros depois, sem refatorar agora). Fecha a lacuna "cada overlay reimplementa shell".

import { useEffect } from "react";

// O próprio clique que ABRE um popover ancorado costuma focar o botão e disparar um scrollIntoView → um
// evento de scroll síncrono que fecharia o popover na hora. Ignoramos scroll/resize nesta janela de carência
// após abrir (a abertura é estável; só scroll DELIBERADO do usuário depois disso deve fechar).
const OPEN_SETTLE_MS = 350;

export function useDismissable(opts: {
  open: boolean;
  onClose: () => void;
  /** fechar quando a página rola/redimensiona (típico de popover ancorado). */
  closeOnScroll?: boolean;
  /** foco inicial ao abrir (acessibilidade). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}): void {
  const { open, onClose, closeOnScroll, initialFocusRef } = opts;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const openedAt = Date.now();
    const onScroll = closeOnScroll
      ? () => {
          if (Date.now() - openedAt < OPEN_SETTLE_MS) return; // ignora o scroll induzido pela própria abertura
          onClose();
        }
      : null;
    if (onScroll) {
      // capture-phase: pega scroll de qualquer container, não só window.
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onScroll);
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      if (onScroll) {
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onScroll);
      }
    };
  }, [open, onClose, closeOnScroll]);

  useEffect(() => {
    if (open && initialFocusRef?.current) initialFocusRef.current.focus();
  }, [open, initialFocusRef]);
}
