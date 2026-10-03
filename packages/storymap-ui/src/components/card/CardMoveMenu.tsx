"use client";

// CardMoveMenu — "Mover para", a ação PRIMÁRIA da página de um card: é o gesto que faz o card andar
// no pipeline. Fica no sub-topnav, ao lado do alternador de visões — não no menu "…", porque um
// overflow é para o que se usa de vez em quando, e mover é o trabalho.
//
// Lista só os destinos que passam no GATE deste card (moveTargets), com o SUGERIDO no topo (✦).
// Escolher não move: entrega ao diálogo de confirmação de quem chamou — mover é irreversível pelo
// caminho normal (a cascata pode disparar um agente na entrada do passo).

import { ArrowRight, ChevronDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { NavPopover, useHoverPopover } from "@/components/nav/NavShell";
import type { MoveTarget } from "@/lib/storymap/move-targets";

export function CardMoveMenu({
  targets,
  disabled,
  onPick,
}: {
  targets: MoveTarget[];
  disabled?: boolean;
  onPick: (status: MoveTarget["status"]) => void;
}) {
  const menu = useHoverPopover();
  if (targets.length === 0) return null;

  return (
    <div ref={menu.ref} className="relative" onMouseEnter={menu.openNow} onMouseLeave={menu.closeSoon}>
      <button
        type="button"
        onClick={() => menu.setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-60",
          menu.open && "bg-surface-hover text-fg",
        )}
      >
        <ArrowRight className="h-3.5 w-3.5" />
        Mover para
        <ChevronDown className={cn("h-3 w-3 transition", menu.open && "rotate-180")} />
      </button>
      {menu.open && (
        <NavPopover align="right" label="Mover para" className="w-60">
          {targets.map((t) => (
            <button
              key={t.status.id}
              type="button"
              onClick={() => {
                menu.setOpen(false);
                onPick(t.status);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12px] transition hover:bg-surface-hover",
                t.recommended ? "font-medium text-fg" : "text-fg-muted",
              )}
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: t.status.color ?? "rgb(var(--fg-subtle))" }}
              />
              <span className="min-w-0 flex-1 truncate">{t.status.name}</span>
              {t.recommended && (
                <Sparkles className="h-3 w-3 shrink-0 text-accent" aria-label="sugerido" />
              )}
            </button>
          ))}
        </NavPopover>
      )}
    </div>
  );
}
