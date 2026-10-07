"use client";

// A BUSCA da 2ª barra do Kanban — procura no título da funcionalidade e do item (a regra é a de `matchesCardQuery`,
// aplicada pelo Kanban, que guarda o texto). Controlada: aqui só o campo e o teclado:
//   «/» em qualquer lugar da página foca a busca (menos quando a pessoa já está escrevendo num campo, ou quando um
//   modal — a conversa do Jido — cobre o quadro);
//   Esc limpa e sai.

import { useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { SEARCH_ARIA_LABEL, SEARCH_NARROW_QUERY, searchPlaceholder } from "./search-words";

/** O alvo de uma tecla é um lugar onde a pessoa escreve? Lá, «/» é um caractere, não um atalho. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== "string") return false;
  const node = el as HTMLElement;
  const tag = node.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable === true;
}

export interface KanbanSearchBoxProps {
  value: string;
  onChange: (q: string) => void;
  className?: string;
}

export function KanbanSearchBox({ value, onChange, className }: KanbanSearchBoxProps) {
  const input = useRef<HTMLInputElement>(null);
  // a frase inteira não cabe no campo do celular («… ou i»): lá o placeholder é «Buscar». Começa na frase inteira (o
  // render do servidor e o computador não mudam) e troca no mount, só abaixo do `md`.
  const narrow = useMediaQuery(SEARCH_NARROW_QUERY);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      // Com um modal aberto por cima (a conversa do Jido deixa o resto da página `inert`), a busca está atrás do véu:
      // a tecla não é dela — nada de engolir o «/» nem de focar um campo escondido.
      if (!input.current || input.current.closest("[inert]")) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <label
      className={cn(
        "flex h-10 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-fg-subtle focus-within:border-line-emphasis focus-within:ring-2 focus-within:ring-accent/40 md:h-8",
        className,
      )}
    >
      <Search className="h-3.5 w-3.5 flex-none" aria-hidden />
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onChange("");
            e.currentTarget.blur();
          }
        }}
        placeholder={searchPlaceholder(narrow)}
        aria-label={SEARCH_ARIA_LABEL}
        className="min-w-0 flex-1 border-0 bg-transparent text-[16px] text-fg md:text-[13px] outline-none placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:hidden"
      />
      <kbd aria-hidden className="hidden flex-none rounded-md border border-line px-1 font-mono text-[11px] leading-4 md:inline">
        /
      </kbd>
    </label>
  );
}
