// 🚦 O BARRAMENTO DO RITMO — quem muda o ritmo do board avisa quem o mostra, na mesma tela.
//
// O ritmo tem vários pontos de mudança (a pílula da 2ª barra do Kanban, o «Retomar o board» do popover da caixinha, os
// comandos `/pausar` e `/retomar` do compositor do Jido) e vários leitores (o quadro, que pinta «Pausado» e para a
// esteira; o mascote do compositor, de olhos em traço). Cada leitor lê o ritmo sozinho (a cada minuto); sem este aviso,
// uma mudança feita num ponto só aparecia nos outros na próxima leitura — até 60 s com o quadro dizendo o contrário.
//
// Módulo leve, como o chat/jido-bus: quem mudou publica a vista nova (`notifyBoardPaceChanged`), quem mostra assina
// (`onBoardPaceChanged`) e troca a sua. Sem vista (o aviso só diz «mudou»), o leitor relê.

import type { BoardPaceView } from "@/lib/storymap/runner/board-pace";

export interface BoardPaceChange {
  boardId: string;
  /** a vista nova que a action devolveu; ausente ⇒ quem assina relê. */
  view?: BoardPaceView;
}

type Listener = (change: BoardPaceChange) => void;
const listeners = new Set<Listener>();

/** Avisa que o ritmo de um board mudou. Sem assinante, nada acontece (é aviso, não fila). */
export function notifyBoardPaceChanged(change: BoardPaceChange): void {
  for (const fn of [...listeners]) fn(change);
}

/** Assina os avisos de mudança de ritmo. Devolve a função que desfaz a assinatura. */
export function onBoardPaceChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
