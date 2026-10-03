"use client";

// face-bus.ts — o que o TURNO sente, do chat para o mascote do topnav.
//
// O PROBLEMA que ele resolve: o humor do Jido nasce em dois lugares. O REPOUSO (o board vai acordá-lo? um
// tick está rodando? houve conversa recente?) o topnav lê sozinho, dos próprios polls. Mas o TURNO — está
// falando, rodando uma tool, engasgou na API, parou pedindo aprovação — só existe DENTRO do chat, no hook da
// conversa. Enquanto o painel tinha rosto próprio no header, cada superfície mostrava o que sabia e ninguém
// reparava na diferença. Com o mascote morando SÓ no topnav, o sinal mais vivo que o produto tem ficaria sem
// renderizador: o Jido responderia uma pergunta inteira de cara parada.
//
// POR QUE UM BUS E NÃO UM CONTEXT: o mesmo motivo do meter-bus (ver o doc dele) — o chip mora no BoardHeader e
// o chat mora no rail/gaveta, árvores DIFERENTES; um provider comum teria de envolver a página inteira para
// carregar um punhado de booleanos.
//
// Contrato: o chat PUBLICA os sinais do turno (`publishCopilotFace`) e limpa no desmonte (`{}`); o topnav
// ASSINA e mescla POR CIMA dos sinais de repouso dele. O último valor fica guardado por board para que uma
// superfície que monte depois (troca de rota) já nasça com a cara certa, sem esperar o próximo evento.

import type { FaceSignals } from "@/lib/storymap/copilot/face";

/**
 * O que o bus carrega. `open` não é decoração: com uma conversa NA TELA, o mascote não deve abrir balão
 * sozinho a cada turno ("Estou te respondendo…" enquanto você lê a resposta chegando é ruído puro). O balão
 * automático é para quem NÃO está olhando a conversa; com o painel montado, sobra o hover.
 */
export interface CopilotFaceState {
  readonly signals: FaceSignals;
  /** há um painel de conversa montado para este board agora. */
  readonly open: boolean;
}

const CLOSED: CopilotFaceState = { signals: {}, open: false };

type Listener = (boardId: string, state: CopilotFaceState) => void;

const listeners = new Set<Listener>();
const latest = new Map<string, CopilotFaceState>();

/** O chat anuncia o que o turno dele sente AGORA. O desmonte publica `{signals:{}, open:false}`. */
export function publishCopilotFace(boardId: string, signals: FaceSignals, open = true): void {
  const state: CopilotFaceState = { signals, open };
  latest.set(boardId, state);
  for (const l of [...listeners]) {
    try {
      l(boardId, state);
    } catch {
      // um assinante quebrado nunca pode impedir os outros de atualizar (nem travar o render do chat).
    }
  }
}

/** O último estado conhecido do board — para quem monta depois do evento. */
export function currentCopilotFace(boardId: string): CopilotFaceState {
  return latest.get(boardId) ?? CLOSED;
}

/** Assina o estado do rosto. Devolve o unsubscribe (chame no cleanup do effect). */
export function onCopilotFace(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
