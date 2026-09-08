"use client";

// DocTitle — o título do documento em EDIÇÃO. Três telas o repetiam como um `<input>` de
// `text-3xl` cravado, e isso trazia dois defeitos: um input de UMA linha CORTA um título longo (a
// maioria dos títulos deste board são frases inteiras — "Operador não consegue localizar
// rapidamente bugs/cards…" sumia no meio), e a escala própria não era a do documento, então o
// título encolhia ao entrar em edição. Aqui é um textarea que cresce com o conteúdo, na escala
// `DOC.title` — o mesmo tamanho que o `<h1>` da leitura.

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { DOC } from "@/components/doc/typography";

export interface DocTitleProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function DocTitle({ value, onChange, placeholder, className }: DocTitleProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      // Enter não quebra linha: o título é UMA frase, e a quebra viraria um `\n` no campo do card.
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, " "))}
      className={cn(
        "w-full resize-none overflow-hidden border-none bg-transparent p-0 text-fg outline-none placeholder:text-fg-subtle",
        DOC.title,
        className,
      )}
    />
  );
}
