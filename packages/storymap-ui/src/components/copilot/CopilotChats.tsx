"use client";

// AS CONVERSAS do painel, no cabeçalho: retomar uma anterior (histórico) e começar uma nova.
//
// Por que aqui, e por que dois botões separados:
//  • COMEÇAR UMA NOVA morava dentro de dois popovers (o anel do composer e a engrenagem), atrás de um ícone de
//    "desfazer" (↺). Era o gesto mais frequente do painel escondido em dois menus, com um símbolo que promete
//    reverter algo. Agora é um botão só, à DIREITA do cabeçalho (onde todo chat moderno o põe) e com o ícone
//    de COMPOR — o mesmo vocabulário do Claude/ChatGPT, sem ambiguidade com "desfazer".
//  • RETOMAR é novo: fechar uma conversa deixou de perdê-la. O ↺ (agora com o sentido certo: voltar no tempo)
//    abre as anteriores; um toque reabre. A lista é curta por desenho (ver MAX_RECOVERABLE_CHATS) — um menu
//    que se lê de relance, não um arquivo de sessões.
//
// A lista é carregada QUANDO ABRE (o corpo do Popover só monta aberto): o cabeçalho não paga leitura de disco
// em toda abertura do chat, e o que aparece é sempre o estado de agora — nunca um cache de dois cliques atrás.

import { useEffect, useState } from "react";
import { Check, History, Loader2, SquarePen } from "lucide-react";
import { cn } from "@/lib/cn";
import { BTN_ICON, DOT, ICON, TXT } from "./ui";
import { Popover } from "./Popover";
import { copilotChatsAction, type CopilotChatRef } from "@/app/copilot-actions";
import { MAX_RECOVERABLE_CHATS, chatSubtitle, chatTitle } from "@/lib/storymap/copilot/chat-roster";

export function CopilotChatActions({
  boardId,
  view,
  busy,
  onNewChat,
  onResume,
}: {
  boardId: string;
  /** a RAIA: o histórico é POR TELA (a bancada de Ideias não lista as conversas do Jido do board, e vice-versa).
   *  Ausente ⇒ o chat do board, o caminho de sempre. */
  view?: string;
  /** um turno está em voo ⇒ trocar de conversa o abortaria: as duas ações esperam ele terminar. */
  busy: boolean;
  onNewChat: () => void;
  onResume: (sessionId: string) => void;
}) {
  return (
    <>
      <Popover
        label="Conversas anteriores"
        title={`Retomar uma conversa anterior (as últimas ${MAX_RECOVERABLE_CHATS})`}
        align="right"
        direction="down"
        className="w-72"
        trigger={<History className={ICON.action} />}
      >
        {(close) => (
          <ChatList
            boardId={boardId}
            view={view}
            busy={busy}
            onPick={(sessionId) => {
              close();
              onResume(sessionId);
            }}
          />
        )}
      </Popover>
      <button
        type="button"
        onClick={onNewChat}
        disabled={busy}
        className={cn(BTN_ICON, "disabled:cursor-not-allowed disabled:opacity-40")}
        aria-label="Nova conversa"
        title={busy ? "Espere o turno terminar para começar outra conversa" : "Nova conversa — a atual fica no histórico"}
      >
        <SquarePen className={ICON.action} />
      </button>
    </>
  );
}

/** O corpo do menu — monta (e lê) só quando o popover abre. */
function ChatList({
  boardId,
  view,
  busy,
  onPick,
}: {
  boardId: string;
  view?: string;
  busy: boolean;
  onPick: (sessionId: string) => void;
}) {
  const [chats, setChats] = useState<CopilotChatRef[] | null>(null);
  const [now] = useState(() => Date.now()); // congelado na abertura: a idade não precisa contar segundos aqui

  useEffect(() => {
    let alive = true;
    copilotChatsAction(boardId, view)
      .then((c) => alive && setChats(c))
      .catch(() => alive && setChats([]));
    return () => {
      alive = false;
    };
  }, [boardId, view]);

  if (chats === null) {
    return (
      <div className={cn("flex items-center gap-2 px-2 py-2 text-fg-subtle", TXT.meta)}>
        <Loader2 className={cn(ICON.inline, "animate-spin")} /> Lendo as conversas…
      </div>
    );
  }

  const previous = chats.filter((c) => !c.active);
  if (!previous.length) {
    // Só a aberta (ou nenhuma): dizer o que ACONTECE vale mais que um "vazio" — o operador aprende aqui
    // que fechar uma conversa não a perde.
    return (
      <div className={cn("px-2 py-2 leading-snug text-fg-subtle", TXT.meta)}>
        Nenhuma conversa anterior. Ao começar uma nova, esta fica aqui — as {MAX_RECOVERABLE_CHATS} últimas.
      </div>
    );
  }

  return (
    <>
      <p className={cn("px-2 pb-1 pt-0.5 font-semibold uppercase tracking-wide text-fg-subtle", TXT.meta)}>Conversas</p>
      {chats.map((c) => (
        <ChatRow key={c.sessionId} chat={c} now={now} disabled={busy} onPick={() => onPick(c.sessionId)} />
      ))}
    </>
  );
}

/** Uma conversa na lista: o que ela é (a 1ª fala) em cima, o que ela pesa (idade/turnos/custo) embaixo. */
function ChatRow({
  chat,
  now,
  disabled,
  onPick,
}: {
  chat: CopilotChatRef;
  now: number;
  disabled: boolean;
  onPick: () => void;
}) {
  // A ABERTA aparece na lista (é o "você está aqui") mas não é um alvo: retomá-la não faria nada.
  return (
    <button
      type="button"
      role="menuitem"
      disabled={chat.active || disabled}
      onClick={onPick}
      title={chat.active ? "Esta é a conversa aberta" : disabled ? "Espere o turno terminar" : "Retomar esta conversa"}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition",
        "hover:bg-surface-hover disabled:hover:bg-transparent",
        chat.active ? "bg-inset" : "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      <span className={cn("flex w-full items-center gap-1.5 font-medium text-fg", TXT.label)}>
        {chat.active && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT.accent)} />}
        <span className="min-w-0 flex-1 truncate">{chatTitle(chat)}</span>
        {chat.active && <Check className={cn(ICON.inline, "text-accent")} />}
      </span>
      <span className={cn("truncate text-fg-subtle", TXT.meta)}>
        {chat.active ? "aberta · " : ""}
        {chatSubtitle(chat, now)}
      </span>
    </button>
  );
}
