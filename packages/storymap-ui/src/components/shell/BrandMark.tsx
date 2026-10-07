// Sem "use client": puro desenho, usado também pelo esqueleto server-side da barra.

import { cn } from "@/lib/cn";

/**
 * A marca compacta — o ícone do app (o quadrado com o rosto em pixel, `public/icon.svg`), em `currentColor`
 * para seguir o tema. Pura, server-safe.
 *
 * ⚠️ `display` vai na CLASSE (`block`), nunca no `style`: um `display` inline vence qualquer utilitário
 * responsivo do consumidor (`md:hidden`) e a marca compacta aparecia COLADA ao lockup no desktop.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="22" height="22" aria-hidden className={cn("block", className)} style={{ flex: "none" }}>
      <rect width="16" height="16" rx="3" fill="currentColor" />
      <path
        fill="rgb(var(--surface))"
        fillRule="nonzero"
        d="M7 3H9V5H7ZM1 7H3V9H1ZM13 7H15V9H13ZM3 5H13V12H3ZM5 12H7V14H5ZM9 12H11V14H9ZM5 7V10H7V7ZM9 7V10H11V7Z"
      />
    </svg>
  );
}
