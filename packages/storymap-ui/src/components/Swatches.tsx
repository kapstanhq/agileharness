"use client";

// THE colour picker of the platform — a row of swatches + the dot that shows the chosen hue.
//
// It existed twice (VocabularyManager had the component, the card form had a copy of the palette),
// so a third copy for the Lean Canvas would have made "which palette is the real one?" unanswerable.
// One component, PALETTE passed in: a persona and a canvas tag can honestly want different families
// without the picker itself forking.

import { cn } from "@/lib/cn";

/**
 * Personas / systems — the calm, muted family (same tones as the framework labels). Kept exactly as
 * it was, so no existing vocabulary entry changes colour.
 */
export const VOCAB_PALETTE = [
  "#7e9ac2", "#9889c6", "#b08fc0", "#c389ab", "#cc8585",
  "#cc8d63", "#c4a261", "#9bab69", "#7daa76", "#5fa6a0",
];

/**
 * Lean Canvas tags — a SATURATED family, on purpose. A canvas tag is not a quiet label: it is the
 * thread that stitches an item to its segment across Problema → Solução → Canais, and it has to be
 * legible at a glance, as a 8px dot, from across the room. Anchored on the product's own accent
 * (amber) and spaced around the wheel so two neighbouring notes never read as the same hue.
 */
export const CANVAS_TAG_PALETTE = [
  "#E8A13C", // âmbar (o acento do produto)
  "#D9683E", // terracota
  "#5285CF", // azul
  "#4FA873", // verde
  "#8B72C4", // violeta
  "#3FA9A0", // teal
  "#C9628A", // rosa
  "#7C7A73", // grafite (o neutro proposital)
];

export function ColorDot({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      className={cn("h-3 w-3 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color ?? "#cbd5e1" }}
    />
  );
}

export function Swatches({
  color,
  onColor,
  palette = VOCAB_PALETTE,
}: {
  color?: string;
  onColor: (c: string) => void;
  palette?: readonly string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {palette.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`cor ${c}`}
          aria-pressed={color?.toLowerCase() === c.toLowerCase()}
          title={c}
          onClick={() => onColor(c)}
          // O PONTO continua com 14px (o desenho), mas o ALVO tem 24px — o mínimo do WCAG 2.5.8, e o
          // que torna o seletor usável no toque (o gerenciador de tags é explicitamente mobile).
          className="flex h-6 w-6 items-center justify-center rounded-full transition hover:bg-surface-hover"
        >
          <span
            className={cn(
              "h-3.5 w-3.5 rounded-full ring-offset-1 ring-offset-[color:rgb(var(--surface))] transition",
              color?.toLowerCase() === c.toLowerCase() ? "ring-2 ring-accent" : "hover:scale-110",
            )}
            style={{ backgroundColor: c }}
          />
        </button>
      ))}
    </div>
  );
}
