"use client";

// A LISTA DE COMANDOS do compositor do Jido — o que o botão `/` (ou digitar `/`) abre, 340px ACIMA da caixa.
//
// Burra de propósito, como a paleta do núcleo (hitl/SlashMenu): recebe as entradas já filtradas, qual está
// destacada, e avisa quando a pessoa escolhe. O que existe e o que cada um faz é do compositor (jido-commands.ts).
// O desenho é o do design: duas colunas — o comando em mono (84px) e o que ele faz.

import { cn } from "@/lib/cn";
import type { JidoCommand } from "@/components/chat/jido-commands";

export function JidoCommandMenu({
  commands,
  activeIndex,
  onPick,
  onHover,
  busy,
  id,
}: {
  commands: readonly JidoCommand[];
  activeIndex: number;
  onPick: (command: JidoCommand) => void;
  onHover: (index: number) => void;
  /** um turno do Jido em voo: os comandos que mexem na conversa ficam fora de alcance (e dizem por quê). */
  busy?: boolean;
  /** o id do listbox — o textarea aponta para ele (`aria-controls`). */
  id: string;
}) {
  if (!commands.length) return null;
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Comandos do Jido"
      className="absolute bottom-[calc(100%+8px)] left-0 z-30 flex w-[340px] max-w-full flex-col rounded-xl border border-line bg-surface p-1.5 shadow-[0_14px_36px_rgba(15,15,15,0.16)]"
    >
      {commands.map((c, i) => {
        const blocked = Boolean(busy) && !c.whileBusy;
        // a régua entre os do board e os da conversa — duas famílias, quem resolve é diferente
        const firstCore = c.group === "conversa" && commands[i - 1]?.group === "board";
        return (
          <div key={c.name} className="contents">
            {firstCore && <div role="presentation" className="mx-2 my-1 h-px bg-line-muted" />}
            <button
              type="button"
              role="option"
              id={`${id}-${c.name}`}
              aria-selected={i === activeIndex}
              disabled={blocked}
              // Fora da ordem do Tab: a navegação é a do campo (↑↓ + `aria-activedescendant`). O `onMouseDown` só
              // impede o clique de tirar o foco do campo; quem escolhe é o `onClick` (vale também para Enter/Espaço
              // de um leitor de tela que pouse aqui).
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!blocked) onPick(c);
              }}
              onMouseEnter={() => onHover(i)}
              title={blocked ? "Espere o Jido terminar a resposta atual" : c.label}
              className={cn(
                "grid h-[34px] min-h-[34px] grid-cols-[84px_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2 text-left transition max-md:h-10",
                i === activeIndex && !blocked ? "bg-inset" : "hover:bg-inset",
                blocked && "cursor-not-allowed opacity-40 hover:bg-transparent",
              )}
            >
              <span className="font-mono text-[12px] text-fg">/{c.name}</span>
              <span className="truncate text-[13px] font-medium text-fg-strong">{c.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
