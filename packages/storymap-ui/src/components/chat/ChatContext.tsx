"use client";

// 📎 O CONTEXTO ANEXADO — o que esta conversa está olhando AGORA, dito na tela.
//
// O problema que ele resolve (relatado pelo Operador, 2026-07-31): abrir uma ideia específica passava a
// injetar o documento dela no contexto de cada turno, e a tela não dizia NADA. O chat continuava exibindo a
// primeira fala da bancada ("estou vendo a bancada inteira") — que é verdadeira, mas incompleta e, ali,
// enganosa: o agente já estava lendo aquele documento, e o operador não tinha como saber.
//
// A tentação era trocar a saudação por outra ("estou com esta ideia aberta"). Errado por dois motivos:
//   • a saudação é a PRIMEIRA FALA de uma conversa — ela é escrita uma vez e vira história. Reescrevê-la a
//     cada navegação mentiria sobre o que foi dito, e numa conversa que CONTINUA (a raia é a mesma da
//     bancada) ela nem aparece: quem já tem transcript nunca veria o aviso.
//   • o que mudou não é o que ele DISSE, é o que ele está VENDO. Estado presente não se conta em prosa
//     passada — se conta com um indicador que acompanha o estado.
//
// Então é um ANEXO, a gramática que Gemini e ChatGPT usam para a mesma ideia: uma pilha logo acima do
// composer, com o que está preso à conversa, e um ✕ para soltar. Ele fica visível o tempo todo (não some
// quando a conversa começa, como as ações rápidas) porque descreve o que TODO turno enxerga — não é um
// convite de página em branco.

import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { GUTTER, ICON, TXT } from "@/components/copilot/ui";

/** Uma coisa presa à conversa — o que o agente lê a cada turno além do escopo largo da tela. */
export interface ChatContextRef {
  /** estável: a chave do React e o que o host usa para soltar este item. */
  id: string;
  /** que TIPO de coisa é ("Ideia", "Card", "Persona") — o operador precisa saber o que ele anexou. */
  kind: string;
  /** o nome do item. Truncado na tela; o title carrega o inteiro. */
  label: string;
  icon?: ReactNode;
  /**
   * Está PRESO agora? Default `true`.
   *
   * `false` desenha o MESMO chip apagado, com um `+` — a oferta de re-anexar. Existe porque soltar não pode
   * ser porta de mão única: sem ela, o operador que tira o anexo só o recupera recarregando a página, e não
   * há nada na tela que diga isso. O item continua listado porque a ROTA continua sendo a dele; o que mudou
   * é se o documento vai no prompt.
   */
  attached?: boolean;
  /** Presente ⇒ o toque alterna preso/solto. Ausente ⇒ o anexo é informativo (a rota impõe, o toque não desfaz). */
  onToggle?: () => void;
}

/** A pilha de anexos da conversa. Vazia ⇒ não renderiza nada (nem o espaço). */
export function ChatContextBar({ refs }: { refs: readonly ChatContextRef[] }) {
  if (!refs.length) return null;
  return (
    // Sem padding VERTICAL próprio: quem dá o ritmo da pilha acima do composer é ela (ChatPanel), e uma
    // faixa que também espaça a si mesma soma dois respiros que ninguém consegue prever de fora.
    // `GUTTER` é o mesmo do texto das mensagens e da caixa do composer — as três colunas nascem na mesma
    // vertical.
    <div className={cn("flex flex-wrap gap-1.5", GUTTER)} aria-label="Contexto desta conversa">
      {refs.map((r) => {
        const on = r.attached !== false;
        return (
          <span
            key={r.id}
            // Fundo `inset` + borda: diferente do chip de ação (véu de tinta, sem contorno). Um anexo não é
            // ação — é um objeto PRESO, e a forma de objeto é o que o distingue dos atalhos logo abaixo.
            // Solto, ele perde a tinta: a mesma forma, apagada, dizendo "está aqui, mas não vai no prompt".
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-lg border py-1 pl-2",
              on ? "border-line bg-inset" : "border-dashed border-line bg-transparent opacity-70",
              r.onToggle ? "pr-1" : "pr-2",
              TXT.meta,
            )}
            title={
              on
                ? `${r.kind}: ${r.label} — o agente lê isto a cada turno desta conversa`
                : `${r.kind}: ${r.label} — SOLTO: não vai no contexto dos próximos turnos`
            }
          >
            {r.icon && <span className="shrink-0 text-fg-subtle">{r.icon}</span>}
            <span className="shrink-0 text-fg-subtle">{r.kind}</span>
            <span className={cn("min-w-0 flex-1 truncate font-medium", on ? "text-fg-muted" : "text-fg-subtle")}>
              {r.label}
            </span>
            {r.onToggle && (
              <button
                type="button"
                onClick={r.onToggle}
                aria-label={on ? `Soltar ${r.kind.toLowerCase()} do contexto` : `Anexar ${r.kind.toLowerCase()} ao contexto`}
                title={
                  on
                    ? "Soltar do contexto — a conversa volta a ver só a tela inteira"
                    : "Anexar de volta — o agente volta a ler este documento a cada turno"
                }
                className="shrink-0 rounded p-0.5 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
              >
                {on ? <X className={ICON.inline} /> : <Plus className={ICON.inline} />}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
