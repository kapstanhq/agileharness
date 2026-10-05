// O BOARD que a página do Kanban manda ao navegador — sem o que o Kanban não lê.
//
// A página server passava o board INTEIRO ao componente cliente: num board de algumas centenas de cards são megabytes
// de JSON (o corpo markdown de cada card, os avisos já resolvidos, o histórico de decisões e de triagem, as perguntas já
// respondidas) — serializados, transmitidos e hidratados a cada abertura, para um quadro
// que mostra título, tipo, etapa, tarefas e o selo de estado. Abrir um card navega para a página dele, que lê o card
// fresco do disco: nada que sai daqui some da tela de detalhe.
//
// O que fica é o que o Kanban usa: os campos de exibição, os do filtro (id/título/tipo) e os que os GATES leem quando
// se arrasta um card (gate-core.js: narrativa, critérios, tarefas, avisos ABERTOS, criteriaSpecs de card vivo…).
// PURA.

import type { Board, Card } from "./types";

/** Avisos/perguntas que ainda contam: os abertos (os gates e os selos só olham esses). */
const openOnly = <T extends { status?: string | null }>(xs: readonly T[] | undefined): T[] | undefined =>
  xs ? xs.filter((x) => (x.status ?? "open") === "open") : xs;

export function kanbanCard(card: Card, terminal: boolean): Card {
  const slim: Card = {
    ...card,
    body: "",
    findings: openOnly(card.findings) ?? card.findings,
    questions: openOnly(card.questions) ?? card.questions,
  };
  // histórico — nenhuma superfície do quadro o mostra (o card aberto lê o seu)
  delete (slim as Partial<Card>).decisions;
  delete (slim as Partial<Card>).triageDecision;
  // card no fim do fluxo não passa mais por gate de QA: o mapa critério→spec não serve ao quadro
  if (terminal) delete (slim as Partial<Card>).criteriaSpecs;
  return slim;
}

/** O board enxuto para o Kanban (os cards, só). A config segue inteira — é pequena e o quadro a usa toda. */
export function kanbanBoard(board: Board): Board {
  const terminal = new Set(board.config.statuses.filter((s) => s.terminal).map((s) => s.id));
  return { ...board, cards: board.cards.map((c) => kanbanCard(c, terminal.has(c.status ?? ""))) };
}
