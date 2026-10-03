"use client";

// 💬 ViewChat — a conversa de UMA TELA, montada a partir da superfície declarada em copilot/chat-surfaces.
//
// Ele não desenha chat nenhum: quem desenha é o {@link ChatPanel}, o MESMO núcleo que o cockpit do board usa —
// mascote, anel de contexto, comandos de barra, histórico, fila, anexos, técnicas. O papel deste módulo é só
// casar a tela com o que o registro diz sobre ela (rótulo, convite, atalhos, métodos) e passar o contexto.
//
// Antes daqui existir assim, este arquivo era um SEGUNDO chat: reusava o transporte e redesenhava uma moldura
// mais pobre. A diferença aparecia na tela — a conversa da bancada de Ideias não tinha `/compact`, não mostrava
// quanto de contexto já tinha ido, não deixava trocar o modelo, e o mascote não escrevia junto com o texto.
// O argumento de que o cockpit "traria o estado do orquestrador junto" continua correto e é exatamente por isso
// que o que se compartilha é o NÚCLEO, e não o cockpit: aprovações, tick e escalação entram lá por slots.
//
// A conversa é a da RAIA (`view`): sessão, histórico, medidor e cache local próprios. Ela não trava o Jido do
// board nem é travada por ele — nem pelo tick autônomo.
//
// FAIL-CLOSED, como a rota do turno: tela sem entrada no registro não ganha um chat genérico com persona padrão —
// não ganha chat nenhum. Se você montou isto e não apareceu nada, falta a entrada em `CHAT_SURFACES`.

import { ChatPanel } from "@/components/chat/ChatPanel";
import type { ChatContextRef } from "@/components/chat/ChatContext";
import { chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import type { HitlTurn } from "@/lib/storymap/hitl/types";

export function ViewChat({
  boardId,
  view,
  context,
  getContext,
  greeting,
  contextRefs,
  onClose,
  className,
}: {
  boardId: string;
  /** a tela dona desta conversa — tem de ter entrada em copilot/chat-surfaces (o servidor recusa o resto). */
  view: string;
  /** contexto de abertura (fallback); `getContext` re-resolve fresco a cada turno. */
  context: string;
  getContext?: () => Promise<string | undefined>;
  /** a primeira fala do agente. Só vale quando não há conversa persistida nesta raia. */
  greeting?: string;
  /** o que está PRESO à conversa nesta rota (a ideia aberta) — vira anexo acima do composer. */
  contextRefs?: readonly ChatContextRef[];
  /** presente ⇒ o host oferece saída (gaveta/folha). Ausente ⇒ painel ancorado, que não fecha. */
  onClose?: () => void;
  className?: string;
}) {
  const surface = chatSurfaceFor(view);
  if (!surface) return null;

  const initialTurns: HitlTurn[] | undefined = greeting
    ? [{ role: "agent", message: greeting, segments: [{ type: "text", segId: "greet", text: greeting }] } as HitlTurn]
    : undefined;

  return (
    <ChatPanel
      boardId={boardId}
      view={view}
      label={surface.label}
      context={context}
      getContext={getContext}
      greeting={initialTurns}
      placeholder={surface.placeholder}
      quickActions={surface.quickActions}
      techniques={surface.techniques}
      contextRefs={contextRefs}
      onClose={onClose}
      className={className}
    />
  );
}
