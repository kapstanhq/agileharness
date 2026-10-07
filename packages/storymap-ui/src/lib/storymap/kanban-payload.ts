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
  return terminal ? terminalFace(slim) : slim;
}

/**
 * O card no FIM do fluxo (a raia «No ar»), reduzido ao que a face dele mostra. Num board maduro eles são a maioria dos
 * cards e quase todo o peso da página — e a face de um card terminal só lê título, tipo, etapa, o porquê (soThat), o selo
 * de bloqueio aberto, a severidade do bug e o resumo do diff. Os critérios, as tarefas, o custo e as provas (que a
 * face não mostra num card terminal) ficam no disco: abrir o card lê o card inteiro.
 * O quadro nunca devolve o objeto card ao servidor (as actions recebem ids), então nada daqui se perde por escrita.
 */
function terminalFace(card: Card): Card {
  // `acceptance`/`tasks` são obrigatórios no tipo: vão VAZIOS (nenhuma leitura do quadro quebra), os opcionais saem
  const face: Card = { ...card, acceptance: [], tasks: [] };
  for (const k of ["costImpact", "deployProof", "qaEvidence", "refinement", "retirement"] as const) {
    delete (face as Partial<Card>)[k];
  }
  if (card.narrative) face.narrative = { role: null, want: null, soThat: card.narrative.soThat ?? null };
  if (card.bugReport) face.bugReport = { ...card.bugReport, brief: "", expected: null, actual: null, steps: [] };
  return face;
}


/**
 * As funcionalidades do PRD como o quadro as lê: só o id e o nome (a chave e o título do card). A descrição de cada
 * uma fica no servidor — quem a mostra é a página da funcionalidade.
 */
export function kanbanFeatures(features: readonly { id: string; name: string }[]): { id: string; name: string }[] {
  return features.map((f) => ({ id: f.id, name: f.name }));
}

/** O board enxuto para o Kanban (os cards, só). A config segue inteira — é pequena e o quadro a usa toda. */
export function kanbanBoard(board: Board): Board {
  const terminal = new Set(board.config.statuses.filter((s) => s.terminal).map((s) => s.id));
  return { ...board, cards: board.cards.map((c) => kanbanCard(c, terminal.has(c.status ?? ""))) };
}
