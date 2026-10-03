"use client";

// A UI DE ESCOLHA — como o agente pergunta sem obrigar o operador a digitar a resposta por extenso.
//
// Ela desenha um {@link AskSpec} (hitl/ask.ts), que é a forma ÚNICA de "escolha" do chat: tanto o bloco
// ```jido-ask que o próprio agente escreve quanto as escolhas montadas pelo cliente (as perguntas de card,
// o menu de ações do greeting) chegam aqui na mesma forma. Um só desenho na tela — se um dia houver dois,
// será porque alguém montou um segundo caminho de dados.
//
// Quatro regras de produto que estão CODIFICADAS aqui, não deixadas ao modelo:
//
//  • A ÚLTIMA opção é sempre a ABERTA ("escrever a minha") quando há opções. Uma lista fechada de 3 botões
//    é uma armadilha na hora em que a resposta certa é a quarta — e o operador não deve ter de descobrir
//    que o composer continuava lá embaixo. Ela não envia nada: foca o campo, que é onde a resposta nasce.
//    E é um LINK, não um botão emoldurado: ela não é uma resposta, é a porta de saída da lista — desenhá-la
//    com o mesmo peso das opções (era um retângulo tracejado, do tamanho delas) dava a uma não-resposta a
//    aparência de uma quarta escolha.
//  • ESCOLHER UMA (single) RESOLVE. Sem passo de confirmação: um toque responde, como no terminal. Só o
//    modo `multi` ganha o botão "Responder", porque aí a seleção é um conjunto e precisa de um fim.
//  • ESCOLHA **OU** ATALHO, nunca os dois na mesma resposta. Quem faz valer é o núcleo (hitl/ask.ts,
//    invariante 4) — aqui a leitura é só defensiva, para que um AskSpec montado à mão não reintroduza a
//    parede de botões parecidos que fazem coisas diferentes.
//  • A PERGUNTA só é escrita aqui quando a prosa acima NÃO a fez (o núcleo tira o eco). Sem isso o operador
//    lia a mesma frase duas vezes seguidas, em dois tamanhos — o que parece defeito de renderização.
//
// Este componente é BURRO: sem estado próprio, sem fetch, sem regra de negócio. O host decide o que cada
// gesto significa (o mesmo `onSend` do composer), e é por isso que ele serve ao chat do Jido e a qualquer
// consumidor HITL futuro sem fork.

import { PenLine } from "lucide-react";
import { cn } from "@/lib/cn";
import { OptionChips } from "@/components/hitl/OptionChips";
import { BTN_SOLID, ICON, QUICK_CHIP, TXT } from "@/components/copilot/ui";
import type { AskSpec } from "@/lib/storymap/hitl/ask";

export function AskChoices({
  ask,
  selected,
  onToggle,
  onWriteOwn,
  onSuggestion,
  onSubmit,
  disabled,
  className,
}: {
  ask: AskSpec;
  /** ids marcados (o host é dono da seleção — a mesma que o botão Enviar do composer consome). */
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** a saída ABERTA: foca o composer (não envia nada). */
  onWriteOwn: () => void;
  /** um chip de resposta rápida: ENVIA o texto na hora. */
  onSuggestion: (text: string) => void;
  /** modo `multi`: confirma o conjunto escolhido. Ausente ⇒ sem botão (single resolve no toque). */
  onSubmit?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const hasOptions = ask.options.length > 0;
  const multi = ask.mode === "multi";
  const suggestions = hasOptions ? [] : ask.suggestions;
  return (
    <div className={cn("w-full", className)}>
      {/* A pergunta, quando a prosa acima não a fez. Ela é o TÍTULO da escolha — em tinta cheia e no corpo
          do texto (não num rótulo de 12px): é a única linha que o operador PRECISA ler antes de decidir. */}
      {ask.question && (
        <p className={cn("mb-2 font-semibold leading-snug text-fg", TXT.body)}>{ask.question}</p>
      )}

      {hasOptions && (
        <OptionChips options={ask.options} mode={ask.mode} selected={selected} onToggle={onToggle} disabled={disabled} />
      )}

      {/* O RODAPÉ da escolha: o fim explícito do `multi` (o single resolve no toque) e a saída aberta.
          Numa linha só porque são a mesma pergunta — "confirmo o que marquei" e "nenhuma destas". */}
      {(ask.openAnswer || (multi && hasOptions && onSubmit)) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* O botão só ACENDE com algo escolhido — um "Responder" clicável sem seleção mandaria vazio. */}
          {multi && hasOptions && onSubmit && (
            <button type="button" onClick={onSubmit} disabled={disabled || selected.size === 0} className={BTN_SOLID}>
              Responder{selected.size > 1 ? ` (${selected.size})` : ""}
            </button>
          )}
          {ask.openAnswer && (
            <button
              type="button"
              onClick={onWriteOwn}
              disabled={disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-fg-subtle transition",
                "hover:text-fg disabled:cursor-not-allowed disabled:opacity-50",
                TXT.label,
              )}
            >
              <PenLine className={ICON.inline} />
              <span className="min-w-0 font-medium">{ask.openLabel}</span>
            </button>
          )}
        </div>
      )}

      {/* RESPOSTAS RÁPIDAS — a outra família: não respondem escolha nenhuma, só poupam digitação. Um toque
          ENVIA. Aparecem SOZINHAS (sem opções na tela), o que é o que as torna legíveis: quando eram os
          dois grupos ao mesmo tempo, a pílula parecia a versão pequena da opção. */}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onSuggestion(s)}
              disabled={disabled}
              className={QUICK_CHIP}
              title={s}
            >
              <span className="truncate">{s}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
