"use client";

import { cn } from "@/lib/cn";

/**
 * A confirmação de uma ação destrutiva presa a UMA LINHA — a faixa que toma o lugar dos controles
 * daquela linha até o operador responder.
 *
 * QUANDO USAR ESTA E QUANDO USAR O {@link ConfirmDialog} (modal). A régua é "de quem é a ação":
 *
 *   • Uma ação de LINHA numa lista de coisas parecidas (encerrar ESTE terminal, matar ESTE processo,
 *     liberar ESTE claim) pede a faixa. Três terminais se parecem; um modal centralizado pergunta
 *     "Encerrar?" no meio da tela, longe da linha que o operador armou, e ele responde de memória —
 *     que é exatamente como se encerra o terminal errado. A faixa nasce ONDE o gesto começou.
 *   • Uma ação sobre um objeto ÚNICO e já em foco (apagar o card aberto, mover de coluna), sobretudo
 *     quando a confirmação precisa mostrar CONTEXTO (o preview "de → para"), pede o modal.
 *
 * Não é um terceiro padrão: é o segundo, e estes dois cobrem a casa. `window.confirm` não é opção em
 * nenhum dos dois casos — ele tira o operador da página, não sabe dizer QUAL linha perguntou, e no
 * terminal web ele nem chega a ser uma escolha (ver `confirmInline` em public/terminal/index.html,
 * que é esta mesma gramática escrita à mão porque aquela página não tem React).
 *
 * `error` ocupa o lugar da pergunta de propósito: quando o servidor RECUSA (o kill-guard é
 * fail-closed), o motivo é a informação mais útil da interação inteira — ele diz por que aquilo não
 * pode ser destruído. Mandá-lo para um toast enquanto a faixa some deixaria o operador com um clique
 * que aparentemente não fez nada.
 */
export function InlineConfirm({
  question,
  confirmLabel = "Confirmar",
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  className,
}: {
  /** a pergunta INTEIRA, incluindo o que se perde ao confirmar — ela quebra em várias linhas se precisar */
  question: string;
  confirmLabel?: string;
  /** ação em voo: trava o confirmar e diz que está acontecendo */
  busy?: boolean;
  /** a recusa do servidor — toma o lugar da pergunta, e só sobra o "ok" */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const btn =
    "shrink-0 rounded px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-[0.06em] transition disabled:opacity-50";
  return (
    // O clique morre aqui: a linha em volta costuma abrir/navegar, e confirmar não é navegar.
    <span
      role="group"
      aria-label={error ?? question}
      onClick={(e) => e.stopPropagation()}
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
    >
      <span className={cn("min-w-0 flex-1 text-[11.5px] leading-tight", error ? "text-danger" : "text-fg")}>
        {error ?? question}
      </span>
      {!error && (
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={cn(btn, "bg-danger/15 text-danger ring-1 ring-inset ring-danger/30 hover:bg-danger/25")}
        >
          {busy ? "…" : confirmLabel}
        </button>
      )}
      <button type="button" onClick={onCancel} className={cn(btn, "text-fg-muted hover:bg-surface-hover")}>
        {error ? "ok" : "cancelar"}
      </button>
    </span>
  );
}
