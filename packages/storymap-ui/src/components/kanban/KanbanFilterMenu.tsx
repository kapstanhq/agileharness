"use client";

// O «Mostrar ▾» da 2ª barra do Kanban: o recorte dos cards. O padrão é EXCEÇÕES — só o que está rodando, com erro,
// precisando de você ou pausado; o resto aparece como caixinha no fluxo. «Tudo» mostra o board inteiro, e cada estado
// pode ser visto sozinho, com a bolinha e a contagem dele. Controlado: o Kanban guarda o modo e as contagens.
//
// Aqui também mora `useDismiss`, o fechamento comum dos painéis da barra (Esc e clique fora).

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { queuedIncludesWords } from "@/lib/storymap/kanban-features";
import type { KanbanShowMode } from "./KanbanToolbar";

/**
 * Fecha o painel aberto com Esc ou com um toque/clique fora de `ref`. Fechado pelo Esc com o foco DENTRO do painel, o
 * foco volta ao gatilho (o que `returnFocus` devolve; sem ele, o botão `[aria-expanded]` de dentro de `ref`) — senão o
 * item focado some e o teclado cai no <body>.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  ref: RefObject<HTMLElement | null>,
  returnFocus?: () => HTMLElement | null,
): void {
  const cb = useRef(close);
  cb.current = close;
  const back = useRef(returnFocus);
  back.current = returnFocus;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const root = ref.current;
      const hadFocus = !!root && root.contains(document.activeElement);
      const trigger = back.current?.() ?? root?.querySelector<HTMLElement>("[aria-expanded]") ?? null;
      cb.current();
      if (hadFocus && trigger) requestAnimationFrame(() => trigger.isConnected && trigger.focus());
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) cb.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, ref]);
}

/** O nome de cada recorte, como o botão e a lista o dizem. */
export const SHOW_MODE_LABEL: Record<KanbanShowMode, string> = {
  exc: "Exceções",
  all: "Tudo",
  running: "Rodando",
  attention: "Precisa de você",
  error: "Erro",
  queued: "Na fila",
  delivering: "Sistema entregando",
  paused: "Pausado",
};

/** A bolinha do estado (forma + cor: nunca só cor). */
export function StateDot({ state }: { state: KanbanShowMode }): ReactNode {
  if (state === "queued") return <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full border-[1.5px] border-dashed border-state-idle" />;
  if (state === "paused") return <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full border-[1.5px] border-fg" />;
  const bg = state === "error" ? "bg-danger" : state === "attention" ? "bg-state-owner" : "bg-primary";
  return <span aria-hidden className={cn("h-1.5 w-1.5 flex-none rounded-full", bg)} />;
}

export interface KanbanFilterMenuProps {
  mode: KanbanShowMode;
  onMode: (m: KanbanShowMode) => void;
  /** a contagem de cada recorte; `waiting`/`forgotten` = o que «Na fila» junta além da fila (o menu diz por extenso). */
  counts: Partial<Record<KanbanShowMode | "waiting" | "forgotten", number>>;
  /** o board está pausado: a linha «Rodando» vira «Pausado». */
  paused: boolean;
  className?: string;
}

export function KanbanFilterMenu({ mode, onMode, counts, paused, className }: KanbanFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const states: KanbanShowMode[] = [paused ? "paused" : "running", "attention", "error", "queued", "delivering"];
  const options: Array<{ id: KanbanShowMode; sep?: boolean }> = [{ id: "all" }, { id: "exc", sep: true }, ...states.map((id) => ({ id }))];
  const choose = (m: KanbanShowMode) => {
    onMode(m);
    setOpen(false);
  };

  return (
    <div ref={ref} className={cn("relative flex-none", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Escolher o que o Kanban mostra"
        className={cn(
          "flex h-10 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] text-fg-muted transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:h-8",
          open ? "bg-surface-hover" : "bg-surface",
        )}
      >
        Mostrar
        <b className="font-semibold text-fg">{SHOW_MODE_LABEL[mode]}</b>
        <ChevronDown className="h-3 w-3 text-fg-subtle" aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="Mostrar" className="absolute right-0 top-full z-40 mt-1.5 flex max-h-[calc(100dvh-var(--ah-topbar-h,52px)-var(--jido-composer-h,0px)-60px)] w-[250px] flex-col overflow-y-auto rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_14px_36px_rgba(15,15,15,.16)]">
          {options.map((o) => {
            const on = mode === o.id;
            const n = o.id === "exc" ? undefined : counts[o.id];
            // «Na fila» junta a fila, quem espera condutor e o esquecido: o card diz «Esquecido», então o menu diz que o
            // número os inclui — senão «13 na fila» não batia com os cards que dizem outra coisa
            const sub = o.id === "queued" ? queuedIncludesWords(counts) : "";
            return (
              <div key={o.id} className="contents">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => choose(o.id)}
                  className={cn(
                    "flex min-h-10 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-fg transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:min-h-8",
                    sub && "py-1",
                    on ? "bg-surface-hover font-semibold" : "font-medium",
                  )}
                >
                  {o.id !== "exc" && o.id !== "all" && <StateDot state={o.id} />}
                  <span className="flex min-w-0 flex-1 flex-col">
                    {SHOW_MODE_LABEL[o.id]}
                    {sub && <span className="text-[11.5px] font-normal leading-snug text-fg-subtle">{sub}</span>}
                  </span>
                  {n != null && <span className="tabular-nums text-fg-subtle">{n}</span>}
                </button>
                {o.sep && <span aria-hidden className="mx-1.5 my-1 h-px bg-surface-hover" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
