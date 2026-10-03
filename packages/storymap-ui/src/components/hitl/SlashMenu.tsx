"use client";

// A PALETA de comandos — a lista que aparece sobre o composer quando o campo começa com `/`.
//
// Ela é BURRA de propósito: recebe as entradas já filtradas, qual está destacada, e avisa quando o operador
// escolhe. Quem decide o que existe, o que casa e o que cada um faz é o host (ver hitl/slash.ts e o registro
// do painel do Jido). É o que permite um comando novo custar uma linha de dados, e não um toque aqui.
//
// Forma: ela nasce ANCORADA ao campo (encostada nele, mesmo raio, mesma largura) porque é uma extensão do
// que se está digitando — não um popover flutuante que aparece "em algum lugar" da tela. É assim que o
// Claude Code, o Slack e o VS Code desenham a mesma coisa: a lista cresce PARA CIMA a partir do cursor.

import { cn } from "@/lib/cn";
import { TXT } from "@/components/copilot/ui";
import type { SlashCommand } from "@/lib/storymap/hitl/slash";

export function SlashMenu({
  commands,
  activeIndex,
  onPick,
  onHover,
  busy,
}: {
  /** já filtradas pela consulta — vazio ⇒ o host não deve montar a paleta. */
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  /** um turno está em voo: os comandos que mexem no contexto ficam fora de alcance (e dizem por quê). */
  busy?: boolean;
}) {
  if (!commands.length) return null;
  return (
    <div
      className="overflow-hidden rounded-2xl border border-line bg-surface p-1 shadow-lg"
      role="listbox"
      aria-label="Comandos"
    >
      {commands.map((c, i) => {
        const blocked = Boolean(busy) && !c.whileBusy;
        return (
          <button
            key={c.name}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            disabled={blocked}
            // `onMouseDown` + preventDefault: o clique NÃO pode tirar o foco do campo antes de rodar —
            // senão o composer perde o cursor e o operador tem de clicar de novo para continuar escrevendo.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            onMouseEnter={() => onHover(i)}
            title={blocked ? "Espere o turno atual terminar" : c.hint}
            className={cn(
              "flex w-full items-baseline gap-2 rounded-xl px-2.5 py-1.5 text-left transition",
              i === activeIndex && !blocked ? "bg-surface-hover" : "hover:bg-surface-hover",
              blocked && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            <span className={cn("shrink-0 font-mono font-semibold text-fg", TXT.label)}>/{c.name}</span>
            <span className={cn("min-w-0 flex-1 truncate text-fg-subtle", TXT.meta)}>{c.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
