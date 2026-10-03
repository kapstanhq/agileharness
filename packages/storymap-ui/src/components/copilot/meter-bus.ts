"use client";

// meter-bus.ts — a INVALIDAÇÃO do medidor da sessão do Jido.
//
// O PROBLEMA que ele resolve: "Nova conversa" já limpava as duas pontas do ESTADO (o cliente zera o
// sessionStorage; o servidor grava o tombstone e passa a devolver `meter: null`), mas ninguém mandava a UI
// RE-LER. Os dois consumidores do medidor só liam sozinhos:
//   • CopilotSession.useSessionMeter — no mount e quando `active` mudava (fim de turno);
//   • BoardHeader.CopilotChip       — num poll de 60s.
// Resultado: o operador descartava a conversa e a barra de contexto, o custo e a contagem de turnos seguiam
// exibindo a sessão MORTA por até um minuto — a UI contradizendo um ato explícito dele.
//
// POR QUE UM BUS E NÃO UM CONTEXT: os dois consumidores vivem em ÁRVORES DIFERENTES (o chip mora no
// BoardHeader; o rail e o menu moram dentro do drawer do chat). Um provider comum teria de envolver a página
// inteira para carregar um único booleano de invalidação. O bus é um sinal só, sem estado, e qualquer
// superfície futura que mostre o medidor entra assinando uma linha.
//
// Contrato: quem MUTA a sessão (limpar/compactar) chama `notifyCopilotSessionChanged(boardId)`; quem EXIBE
// assina com `onCopilotSessionChanged`. O boardId vai junto porque o mesmo bus serve várias abas de board.

type Listener = (boardId: string) => void;

const listeners = new Set<Listener>();

/** Avisa que a sessão de `boardId` mudou fora do ciclo normal de turno (limpar/compactar) — todos re-leem. */
export function notifyCopilotSessionChanged(boardId: string): void {
  for (const l of [...listeners]) {
    try {
      l(boardId);
    } catch {
      // um assinante quebrado nunca pode impedir os outros de atualizar (nem derrubar o clique de limpar).
    }
  }
}

/** Assina as mudanças de sessão. Devolve o unsubscribe (chame no cleanup do effect). */
export function onCopilotSessionChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
