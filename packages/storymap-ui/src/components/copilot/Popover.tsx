"use client";

// O MENU do painel do Jido — um popover só, usado por todo gatilho (a engrenagem do board, o ⋯ da conversa).
//
// Por que existe: cada popover do painel era montado à mão (backdrop + painel absoluto + classes repetidas), e
// por isso cada um fechava de um jeito e tinha um raio/sombra diferente. Aqui o comportamento é UM: fecha no
// Esc, no clique fora e ao escolher um item — e o item que escolhe já sabe se fecha (o `close` vem por render-prop).
//
// Este é o mecanismo que devolve ALTURA ao chat: o que é ação rara (compactar, começar de novo, verbosidade) e
// o que é número consultável (contexto, turnos, custo) sai da régua permanente e entra aqui — sem perder nada.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { BTN_ICON, TXT } from "./ui";

export function Popover({
  label,
  title,
  trigger,
  children,
  align = "right",
  direction = "up",
  className,
  triggerClassName,
}: {
  /** aria-label do gatilho (e o title, quando não há um mais informativo). */
  label: string;
  /** tooltip do gatilho, quando ele MOSTRA algo além de abrir (o anel de contexto: os tokens exatos). */
  title?: string;
  /** o conteúdo do botão (um ícone). */
  trigger: ReactNode;
  /** o conteúdo do painel. Recebe `close` — todo item que age deve fechar. */
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  /** para onde o painel ABRE. Default `up` (o gatilho vive na barra do composer, no rodapé); `down`
   *  quando o gatilho está no TOPO do painel — abrir para cima ali jogaria o menu para fora da janela. */
  direction?: "up" | "down";
  className?: string;
  /** estilo do GATILHO. Default `BTN_ICON` (um ícone só). Passe quando o gatilho for ícone + rótulo — como o
   *  seletor de modo, que precisa mostrar por escrito em que estado o Jido está sem ninguém abrir nada. */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Esc fecha. (O clique fora é o backdrop abaixo — um botão transparente que cobre a tela.)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName ?? BTN_ICON}
        aria-label={label}
        title={title ?? label}
        aria-expanded={open}
      >
        {trigger}
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-40 cursor-default" aria-label="Fechar menu" onClick={() => setOpen(false)} />
          <div
            className={cn(
              "absolute z-50 w-64 max-w-[80vw] rounded-lg border border-line bg-surface p-1.5 shadow-lg",
              direction === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5",
              align === "right" ? "right-0" : "left-0",
              className,
            )}
            role="menu"
          >
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}

/** Uma linha do menu: ícone + rótulo + (opcional) o número que a justifica, à direita. */
export function MenuItem({
  icon,
  children,
  onClick,
  disabled,
  hint,
  title,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** o valor atual, à direita (ex.: "padrão") — é o que faz um menu ser informativo, não só clicável. */
  hint?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium text-fg-muted transition",
        "hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40",
        TXT.label,
      )}
    >
      <span className="shrink-0 text-fg-subtle">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className={cn("shrink-0 tabular-nums text-fg-subtle", TXT.meta)}>{hint}</span>}
    </button>
  );
}

/** Um bloco de leitura dentro do menu (os números da sessão). */
export function MenuBlock({ children }: { children: ReactNode }) {
  return <div className={cn("space-y-1 rounded-md bg-inset px-2 py-1.5", TXT.meta)}>{children}</div>;
}

/** Divisor entre grupos do menu. */
export function MenuSep() {
  return <div className="my-1 border-t border-line-muted" />;
}
