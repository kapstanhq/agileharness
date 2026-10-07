// O BARRAMENTO do chat do Jido — a porta única para abrir a conversa a partir de qualquer superfície
// (o card do Kanban, uma caixinha do fluxo, a atividade, o deep-link `?copilot=`). Barramento leve em módulo,
// como o `face-bus`: quem chama não sabe onde o compositor está montado, e o compositor não sabe quem chamou.
//
// Duas entradas, um só ouvinte:
//   • `openJidoChat({ cardId, cardTitle, draft })` — abre a conversa com o card em contexto ("Sobre <card>") e o
//     pedido ESCRITO no compositor, sem enviar. Sem compositor montado é um no-op (a tela que tem o chat em trilho
//     lateral não monta o compositor — e um clique não deve "acordar" uma conversa numa tela futura).
//   • `seedJidoChat(seed)` — o receptor do `?copilot=<ref>` (uma escalação do Inbox/notificação). Diferente do
//     clique, o deep-link chega no CARREGAMENTO da página, possivelmente antes de o compositor (carregado sob
//     demanda) se inscrever: por isso ele fica GUARDADO até o primeiro ouvinte chegar, e é entregue uma vez só.

import type { CopilotSeed } from "@/lib/storymap/copilot/escalation-seed";
import type { Card } from "@/lib/storymap/types";

export interface OpenJidoChatInput {
  /** O card em contexto ("Sobre <card>"). */
  cardId?: string;
  cardTitle?: string;
  /**
   * O card INTEIRO, quando quem abre o tem em mão (o Kanban tem). Opcional: só o `/bug` precisa dele — o fluxo de
   * reportar bug (BugModal) reabre ESTE card; sem ele, o `/bug` cai na captura ("Algo quebrado").
   */
  card?: Card;
  /**
   * A FUNCIONALIDADE do PRD em contexto (fase 7 — «Pedir item novo» na página da funcionalidade): o chat diz «Sobre a
   * funcionalidade …» e o `create_card` do chat grava `feature: id` no item novo.
   */
  feature?: { id: string; title: string };
  /** O pedido já escrito no compositor — NÃO é enviado; a pessoa revisa e envia. */
  draft?: string;
  /** Uma escalação `?copilot=` (item + instrução-modelo). Preenchido por `seedJidoChat`, não por quem abre do card. */
  seed?: CopilotSeed;
  /**
   * Para onde o foco VOLTA quando a conversa fecha (o chevron do card, a caixinha do fluxo que abriu o popover).
   * Ausente ⇒ o que estava focado ao abrir; sem nada, o foco sai do campo.
   */
  returnFocus?: HTMLElement | null;
}

type Listener = (input: OpenJidoChatInput) => void;
const listeners = new Set<Listener>();
/** A semente que chegou sem ninguém ouvindo — entregue ao primeiro ouvinte e descartada. */
let pendingSeed: CopilotSeed | null = null;

/** Abre o chat do Jido com o contexto e o rascunho dados. Sem compositor montado, é um no-op. */
export function openJidoChat(input: OpenJidoChatInput = {}): void {
  for (const l of listeners) l(input);
}

/**
 * Abre o chat do Jido SEMEADO por uma escalação (`?copilot=<ref>`): o rascunho é a instrução da escalação e o
 * contexto é o item dela. Nunca envia. Sem compositor montado, a semente espera o primeiro (uma vez só).
 */
export function seedJidoChat(seed: CopilotSeed): void {
  const input: OpenJidoChatInput = { seed, draft: seed.instruction };
  if (listeners.size === 0) {
    pendingSeed = seed;
    return;
  }
  pendingSeed = null;
  for (const l of listeners) l(input);
}

/** O compositor se inscreve aqui; devolve a função que cancela a inscrição. */
export function onOpenJidoChat(l: Listener): () => void {
  listeners.add(l);
  if (pendingSeed) {
    const seed = pendingSeed;
    pendingSeed = null;
    l({ seed, draft: seed.instruction });
  }
  return () => {
    listeners.delete(l);
  };
}

/** Só para testes: zera ouvintes e semente guardada (o módulo é um singleton entre casos). */
export function __resetJidoBusForTests(): void {
  listeners.clear();
  pendingSeed = null;
}
