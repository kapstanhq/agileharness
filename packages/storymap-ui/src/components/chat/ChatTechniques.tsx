"use client";

// 🎛️ As TÉCNICAS da conversa — o MÉTODO com que o agente ataca o que vem a seguir.
//
// Uma técnica não é um atalho. O atalho manda UMA pergunta e acaba (é datilografia poupada); a técnica é um
// REGIME que vale até ser trocado — "estamos brainstormando" descreve os próximos dez turnos, não o próximo.
// Por isso ela mora onde o MODO mora (a barra flutuante do topo, ao lado dos controles do agente) e não junto
// dos chips do composer, e por isso ela é PEGAJOSA: sobrevive à recarga, por raia.
//
// O repertório é DADO (copilot/chat-surfaces `techniques`), não código: uma técnica nova numa tela é uma entrada
// no registro. Este módulo só desenha o seletor e lembra a escolha.

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Wand2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { ICON, TXT } from "@/components/copilot/ui";
import { MenuBlock, MenuItem, MenuSep, Popover } from "@/components/copilot/Popover";
import type { ChatTechnique } from "@/lib/storymap/copilot/chat-surfaces";

/**
 * A técnica ligada nesta raia + a instrução que ela injeta.
 *
 * Guardada em `localStorage` por raia: trocar de técnica é uma decisão de trabalho, não um estado de render —
 * quem ligou "Validação" e recarregou a página continua validando. A leitura acontece num efeito (e não no
 * `useState` inicial) porque o primeiro render é do SERVIDOR: ler `localStorage` ali quebra a hidratação.
 *
 * Uma técnica que sumiu do registro (renomeada, removida num deploy) é DESCARTADA na leitura — a preferência
 * aponta para um id que não existe mais, e o certo é voltar ao modo livre em vez de injetar `undefined` ou
 * segurar um rótulo fantasma no seletor.
 */
export function useTechnique(lane: string, techniques?: readonly ChatTechnique[]) {
  const key = `copilot-technique-${lane}`;
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!techniques?.length) return;
    try {
      const saved = window.localStorage.getItem(key);
      if (saved && techniques.some((t) => t.id === saved)) setId(saved);
    } catch {
      /* preferência ilegível nunca pode impedir a conversa de abrir */
    }
  }, [key, techniques]);

  const setTechnique = useCallback(
    (next: string | null) => {
      setId(next);
      try {
        if (next) window.localStorage.setItem(key, next);
        else window.localStorage.removeItem(key);
      } catch {
        /* modo privado / cota — a escolha ainda vale nesta sessão */
      }
    },
    [key],
  );

  const technique = techniques?.find((t) => t.id === id) ?? null;
  return { technique, setTechnique, instruction: technique?.prompt };
}

/**
 * O SELETOR — um chip que diz por escrito em que método a conversa está.
 *
 * Ele mostra o rótulo (e não só um ícone) pela mesma razão que o seletor de modo do board mostra: um estado que
 * muda o comportamento de TODO turno seguinte não pode viver escondido atrás de um ícone mudo — o operador
 * precisa saber que ainda está em "Validação" três turnos depois, sem abrir nada.
 *
 * Abre para BAIXO e ancorado à esquerda: o gatilho vive na barra do TOPO, e um menu que abrisse para cima dali
 * sairia da janela.
 */
export function TechniquePicker({
  techniques,
  active,
  onPick,
}: {
  techniques: readonly ChatTechnique[];
  active: ChatTechnique | null;
  onPick: (id: string | null) => void;
}) {
  return (
    <Popover
      label="Técnica de trabalho"
      title={active ? `Técnica: ${active.label} — ${active.hint}` : "Escolher uma técnica de trabalho"}
      align="left"
      direction="down"
      className="w-72"
      // O MESMO vocabulário do seletor de modo, que é o vizinho dele nesta barra: dois controles que governam a
      // conversa inteira, lado a lado, não podem ter duas gramáticas de botão.
      triggerClassName={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 font-medium transition hover:bg-surface-hover hover:text-fg",
        active ? "text-fg" : "text-fg-muted",
        TXT.label,
      )}
      trigger={
        <>
          <Wand2 className={cn(ICON.inline, active && "text-accent")} />
          <span className="max-w-[7rem] truncate">{active ? active.label : "Técnica"}</span>
          <ChevronDown className={ICON.inline} />
        </>
      }
    >
      {(close) => (
        <>
          <MenuBlock>
            <div className={cn("leading-snug text-fg-subtle", TXT.meta)}>
              Como o agente deve trabalhar daqui em diante. Vale para os próximos turnos, até você trocar.
            </div>
          </MenuBlock>
          <MenuSep />
          {techniques.map((t) => (
            <TechniqueRow
              key={t.id}
              technique={t}
              on={t.id === active?.id}
              onClick={() => {
                // Tocar na técnica ATIVA a desliga — o caminho de volta ao modo livre é o mesmo gesto, e não um
                // item "Nenhuma" competindo por espaço com os métodos de verdade.
                onPick(t.id === active?.id ? null : t.id);
                close();
              }}
            />
          ))}
          {active && (
            <>
              <MenuSep />
              <MenuItem
                icon={<span className={ICON.inline} />}
                onClick={() => {
                  onPick(null);
                  close();
                }}
                title="Volta ao modo livre — sem instrução de método."
              >
                Sem técnica
              </MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  );
}

/**
 * Uma técnica na lista: o NOME em cima, o que ela muda embaixo.
 *
 * Não é um `MenuItem`: o `hint` dele é `shrink-0` porque foi desenhado para um VALOR curto à direita
 * ("padrão", "curto") — com uma frase ali, ele reservava a linha inteira e o rótulo truncava até virar uma
 * letra só ("B…", "P…"). Duas linhas é a forma certa para rótulo + explicação, e é a mesma que a lista de
 * conversas já usa (ver CopilotChats.ChatRow).
 */
function TechniqueRow({
  technique,
  on,
  onClick,
}: {
  technique: ChatTechnique;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      title={on ? `Desligar «${technique.label}»` : technique.hint}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-hover",
        on && "bg-inset",
      )}
    >
      <span className={cn("flex w-full items-center gap-1.5 font-medium", on ? "text-fg" : "text-fg-muted", TXT.label)}>
        <span className="min-w-0 flex-1 truncate">{technique.label}</span>
        {on && <Check className={cn(ICON.inline, "shrink-0 text-accent")} />}
      </span>
      <span className={cn("text-fg-subtle", TXT.meta)}>{technique.hint}</span>
    </button>
  );
}
