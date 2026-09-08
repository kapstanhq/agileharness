"use client";

// THE platform label/chip primitive. Every inline label & chip across AgileHarness —
// persona/system chips, framework badges (RICE / KANO / funnel / type / status),
// task progress — renders through MetaBadge so they read as one visual family:
// identical geometry, one treatment language. Colour = soft tinted fill + subtle
// same-hue border + coloured text; neutral = surface-hover + hairline. No mixed
// outline/fill/dot styles. Metrics stay neutral; only semantic categories carry hue.

import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { KANO_BY_ID, FUNNEL_BY_ID } from "@/lib/storymap/frameworks";
import type { KanoCategory, FunnelStage } from "@/lib/storymap/frameworks";

export function MetaBadge({
  color,
  label,
  icon: Icon,
  prefix,
  onRemove,
  size = "sm",
  title,
  className,
}: {
  /** A semantic hue → tinted pill; omitted → a neutral pill (metrics, counts). */
  color?: string;
  label: React.ReactNode;
  /** Optional leading icon (e.g. a task check). */
  icon?: LucideIcon;
  /** Small muted leading prefix rendered before the label (e.g. "RICE"). */
  prefix?: string;
  /** When set, renders a trailing × that calls this (for editable chips). */
  onRemove?: () => void;
  /** sm = dense (card footers); md = standalone chips (actor band, drawer). */
  size?: "sm" | "md";
  title?: string;
  className?: string;
}) {
  const style = color ? { backgroundColor: `${color}1a`, borderColor: `${color}40`, color } : undefined;
  return (
    <span
      title={title}
      style={style}
      className={cn(
        "inline-flex items-center gap-1 rounded border font-semibold leading-none",
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]",
        !color && "border-line bg-surface-hover text-fg-muted",
        className,
      )}
    >
      {Icon && <Icon className="h-3 w-3 shrink-0" />}
      {prefix && <span className="font-bold uppercase tracking-wide opacity-60">{prefix}</span>}
      <span className="min-w-0 truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 shrink-0 opacity-50 transition hover:opacity-100"
          aria-label="Remover"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

// `KanoBadge`, `FunnelBadge` e o `RiceBadge` (arquivo próprio) foram REMOVIDOS: nenhum dos três era
// montado em lugar algum — a "cirurgia minimalista" do card os tirou da face do Kanban e nada os
// readotou. `kanban-card-footer.test.ts` chega a proibir que voltem por nome. Componente que não
// renderiza é pior que código morto comum: ele parece uma opção de desenho disponível, e o próximo a
// desenhar um chip acha que a decisão de mostrar KANO/funil no card ainda está de pé. `MetaBadge`
// FICA — é a primitiva, e tem consumidores de verdade (Chip, StoryCard). A fórmula do RiceBadge
// sobreviveu como `formatRiceScore` em `lib/storymap/rice.ts`, onde deixou de ter três cópias.
// `git log -S KanoBadge` traz os três de volta.
