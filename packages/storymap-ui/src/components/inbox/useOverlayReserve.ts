"use client";

// A pílula flutuante do feedback visual («Marcar ajuste» — public/ah-overlay.js `.ah-bar`) mora no canto de baixo à
// esquerda e lê do host quanto espaço reservar embaixo (`--ah-bottom-reserve`). A barra de decisão presa embaixo do item
// aberto (as opções) ocupa exatamente esse canto no celular: a pílula cobria o botão principal. Enquanto a barra estiver
// na tela e passar por baixo da pílula, o item reserva a altura dela — a pílula sobe e pousa logo acima das opções.

import { useEffect, type RefObject } from "react";

/** Até onde (em px a partir da esquerda) a pílula alcança — ela nasce em `left:16px` e cabe em ~200px. */
const PILL_REACH_PX = 220;

/**
 * Quanto reservar embaixo para a pílula não cobrir a barra de decisão — ou null quando a barra não está sob ela (fora
 * da tela, ou começando à direita da pílula, como no desktop com a coluna centralizada). PURA.
 */
export function overlayReserve(bar: { top: number; bottom: number; left: number }, viewportHeight: number): number | null {
  if (bar.left >= PILL_REACH_PX || bar.top >= viewportHeight || bar.bottom <= 0) return null;
  return Math.max(0, Math.round(viewportHeight - bar.top));
}

/** Mantém `--ah-bottom-reserve` no <body> igual à altura da barra de decisão enquanto ela estiver sob a pílula. */
export function useOverlayReserve(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const body = document.body;
    let raf = 0;
    const update = () => {
      raf = 0;
      const px = overlayReserve(el.getBoundingClientRect(), window.innerHeight);
      if (px == null) body.style.removeProperty("--ah-bottom-reserve");
      else body.style.setProperty("--ah-bottom-reserve", `${px}px`);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    window.addEventListener("resize", schedule);
    // captura: a folha rola o próprio contêiner, não a janela
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      body.style.removeProperty("--ah-bottom-reserve");
    };
  }, [ref]);
}
