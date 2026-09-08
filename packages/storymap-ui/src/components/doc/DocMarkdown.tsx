"use client";

// DocMarkdown — o documento em MARKDOWN CRU, para ler e (quando a superfície deixa) editar.
//
// Por que existe: o editor rico é uma superfície de ESCRITA; o markdown é a fonte que o agente lê e
// escreve, e é o que o `git diff` mostra. Quem trabalha com os dois lados precisa ver o texto real —
// e, às vezes, é simplesmente mais rápido corrigir a fonte (colar uma tabela, reordenar uma lista,
// arrumar um link) do que caçar o gesto equivalente no editor. Não é um modo "avançado" escondido:
// é a MESMA verdade, na outra representação, alcançável pelo alternador do sub-topnav.
//
// O dialeto é o canônico do pacote (md-codec.ts): GFM + as duas convenções de upgrade (`> **Rótulo**`
// = uma seção ancorada, `<details><summary>` = um bloco alternável). O que se digita aqui volta pelo
// MESMO commit da entidade que o editor rico usa, então uma região ancorada continua ancorada — e,
// como uma seção hoje LÊ como título, `## Rótulo` também reancora (ver reattachSections).
//
// Estado: o texto é sedeado UMA vez (na montagem) e daí em diante é do componente. Re-sedear a cada
// render brigaria com o cursor — o texto que sobe vira modelo, o modelo re-serializa canonicalizado,
// e a diferença de bytes voltaria por baixo de quem está digitando. Quem quer re-sedear troca a
// `key` (o `epoch` das telas, o mesmo gesto do editor rico).

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface DocMarkdownProps {
  /** O markdown inicial (serializeDocMd do documento). */
  value: string;
  /** Ausente ⇒ somente leitura (a superfície não tem caminho de volta para a entidade). */
  onChange?: (markdown: string) => void;
  className?: string;
}

/** Debounce igual ao do editor rico: uma rajada de teclas não precisa reparsear a cada tecla. */
const DEBOUNCE_MS = 200;

export function DocMarkdown({ value, onChange, className }: DocMarkdownProps) {
  const [source, setSource] = useState(value);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Altura = conteúdo (a barra de rolagem é a da página, não a de uma caixinha dentro dela).
  const autoGrow = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(autoGrow, [source]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!onChange) {
    return (
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.7] text-fg-muted",
          className,
        )}
      >
        {value}
      </pre>
    );
  }

  return (
    <div className={className}>
      <textarea
        ref={areaRef}
        value={source}
        spellCheck={false}
        onChange={(e) => {
          const next = e.target.value;
          setSource(next);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => onChangeRef.current?.(next), DEBOUNCE_MS);
        }}
        onBlur={() => {
          if (timer.current) clearTimeout(timer.current);
          onChangeRef.current?.(source);
        }}
        className="w-full resize-none overflow-hidden border-none bg-transparent font-mono text-[13px] leading-[1.7] text-fg outline-none placeholder:text-fg-subtle"
        placeholder={"# Título\n\nEscreva em markdown…"}
      />
      <p className="mt-6 border-t border-line pt-3 text-[12px] leading-relaxed text-fg-subtle">
        Markdown GFM. <code className="font-mono">## Título</code> abre uma seção ·{" "}
        <code className="font-mono">- item</code> lista · <code className="font-mono">1. item</code> numeração ·{" "}
        <code className="font-mono">---</code> divisor · <code className="font-mono">&gt; texto</code> destaque ·{" "}
        <code className="font-mono">- [ ] tarefa</code> checklist.
      </p>
    </div>
  );
}
