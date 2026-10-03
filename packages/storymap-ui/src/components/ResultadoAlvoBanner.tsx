"use client";

// 🟩 Produto · ResultadoAlvoBanner — o Resultado-alvo renderizado ACIMA do User Story Mapping: é o
// vértice ao qual as stories sobem (story → ideia → Resultado-alvo).
//
// Ele LÊ e não escreve, e a mudança é deliberada. O Resultado-alvo era um campo do `board.yaml`
// editável aqui pela bancada (propose→approve); hoje é a seção `resultadoAlvo` do PRD. Manter a
// edição aqui teria criado uma SEGUNDA porta de escrita para o mesmo conteúdo — exatamente o defeito
// que o Lean Canvas carrega hoje, em que um `propose_change` aprovado grava um campo YAML que
// `loadDoc` não lê mais depois da migração, e nada reconcilia os dois. Uma tira que mostra e leva ao
// documento não tem como divergir dele.
//
// O que se perde: um clique. O que se ganha: o resultado-alvo tem UM lugar onde muda, e é o mesmo
// lugar de onde todo agente o lê.

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

export function ResultadoAlvoBanner({ boardId, outcome }: { boardId: string; outcome: string | null }) {
  return (
    // A mesma tira fina sobre o plano recuado: rótulo discreto · o resultado numa linha · a saída.
    <div className="flex items-center gap-3 border-b border-line bg-inset px-4 py-2">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
        Resultado-alvo
      </span>
      <p className={`min-w-0 flex-1 truncate text-[13px] ${outcome ? "text-fg" : "text-fg-subtle"}`} title={outcome ?? undefined}>
        {outcome ?? "Ainda não declarado — escreva-o em «Objetivos e métricas», no PRD."}
      </p>
      <Link
        href={`/board/${boardId}/prd`}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
      >
        {outcome ? "Editar no PRD" : "Abrir o PRD"}
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
