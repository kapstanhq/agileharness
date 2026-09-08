"use client";

// AS OPÇÕES de uma escolha HITL — a lista de caminhos que o agente ofereceu.
//
// Forma: linhas de LARGURA CHEIA, sem contorno, num véu de tinta (SOFT/CHOICE_ROW em copilot/ui.ts). Antes
// cada opção era um retângulo com borda dentro de um painel com borda, com um rádio de 3.5px na frente e o
// rótulo a 12px — parecia um formulário de configuração espremido, e formulário é exatamente o que ela NÃO é.
//
// Três decisões que valem o comentário:
//
//  • O RÁDIO SAIU do modo `single`. Ele mentia: no single um toque JÁ responde e envia (regra do AskChoices),
//    então nunca existiu um estado "marcado, aguardando confirmar" para o círculo mostrar. Um controle que só
//    pisca no instante do clique é decoração que pede um segundo passo inexistente. Só o `multi` — onde a
//    seleção é um conjunto e precisa de um "Responder" — mantém marcador, e ali ele é uma CAIXA (a forma
//    universal de "marque quantas quiser").
//  • A DESCRIÇÃO é a matéria da linha, não uma nota de rodapé. É o campo em que o agente diz o que acontece
//    se você escolher aquilo (ver HitlOption). `pros`/`cons` continuam desenhados como bullets +/− porque é o
//    shape das perguntas de CARD, que a fila /perguntas escreve — mas quando há descrição, ela vem primeiro.
//  • RECOMENDADO é uma PALAVRA, não um ★. A estrela exigia decifrar (e o `title` que a explicava não existe
//    no celular); e ficava em âmbar sobre papel branco, a pior combinação de contraste da paleta. A pílula
//    diz "recomendado" com a tinta normal sobre um véu âmbar — legível nos dois temas.

import { cn } from "@/lib/cn";
import { CHOICE_ROW, CHOICE_ROW_ON, TXT } from "@/components/copilot/ui";
import type { HitlOption } from "@/lib/storymap/hitl/types";

/** A linha de apoio da opção: a descrição do agente, ou os bullets pros/cons de uma pergunta de card. */
function optionDetail(o: HitlOption): string {
  if (o.description) return o.description;
  const bits = [...(o.pros ?? []).map((p) => `+ ${p}`), ...(o.cons ?? []).map((c) => `− ${c}`)];
  return bits.join(" · ");
}

export function OptionChips({
  options,
  mode = "single",
  selected,
  onToggle,
  disabled,
}: {
  options: HitlOption[];
  mode?: "single" | "multi";
  selected: Set<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  const single = mode === "single";
  return (
    <div className="space-y-1.5" role={single ? "radiogroup" : undefined}>
      {options.map((o) => {
        const on = selected.has(o.id);
        const detail = optionDetail(o);
        return (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(o.id)}
            role={single ? "radio" : undefined}
            aria-checked={single ? on : undefined}
            aria-pressed={single ? undefined : on}
            className={cn(CHOICE_ROW, on && CHOICE_ROW_ON)}
          >
            {/* MULTI: a caixa de marcação. No single não há marcador — o toque já é a resposta. */}
            {!single && (
              <span
                aria-hidden
                className={cn(
                  "mt-[3px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] text-[10px] font-bold leading-none transition",
                  on ? "bg-accent text-[#37352F]" : "bg-fg/10 text-transparent",
                )}
              >
                ✓
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn("min-w-0 font-medium text-fg", TXT.body)}>{o.label}</span>
                {o.recommended && (
                  <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10.5px] font-semibold text-fg">
                    recomendado
                  </span>
                )}
              </span>
              {detail && (
                <span className={cn("mt-1 block leading-relaxed text-fg-muted", TXT.label)}>{detail}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
