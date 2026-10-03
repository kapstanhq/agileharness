// O RECORTE DE UM BOARD sobre os inputs do relatório de saúde — PURO, zero IO.
//
// POR QUE EXISTE. Os 12 sinais medem a INSTALAÇÃO: um sinal como o S6 «horas sem nada no ar» misturava a fila de publicação de um
// board com a de qualquer outro, e a validação de um conserto («o S1 deste board caiu?») não conseguia separar o efeito
// do ruído dos demais. `ah_health({board})` mede só a fatia daquele board: cada lista de
// `HealthInputs` que carrega um board é filtrada por ele, e a conta dos sinais segue EXATAMENTE a mesma.
//
// O QUE NÃO SE DIVIDE POR BOARD (e por isso fica como está, dito no recorte):
//   • terminais de condutor sem linha no registro — por definição não têm board (o S4 do recorte não os conta);
//   • as ações MCP atribuídas e os toques do dono — o S11 mede a instalação inteira (a atribuição é uma propriedade do
//     ledger de ações, não de um board).

import type { HealthInputs } from "./ah-health";

/** O que o recorte NÃO divide por board — vai junto da resposta, para ninguém ler o número como se o dividisse. */
export const BOARD_SCOPE_CAVEAT =
  "S4 não conta terminais órfãos (não têm board) e S11 mede a instalação inteira (atribuição e toques do dono não se dividem por board).";

/** Os inputs de UM board: o que carrega board é filtrado; o que não carrega fica como está (ver o cabeçalho). PURA. */
export function scopeHealthInputs(inputs: HealthInputs, board: string): HealthInputs {
  const mine = <T extends { board: string }>(rows: readonly T[]): T[] => rows.filter((r) => r.board === board);
  return {
    ...inputs,
    inbox: mine(inputs.inbox),
    demandLanes: mine(inputs.demandLanes),
    cards: mine(inputs.cards),
    transitions: mine(inputs.transitions),
    deliveredStatuses: inputs.deliveredStatuses[board] ? { [board]: inputs.deliveredStatuses[board] } : {},
    publishWaiting: mine(inputs.publishWaiting),
    publishHeld: mine(inputs.publishHeld),
    // agente sem board (livre, sem card) não é «deste board»: fica de fora do recorte
    fleet: inputs.fleet.filter((r) => r.board === board),
    orphanTerminals: [],
    claims: mine(inputs.claims),
    conductorQueue: mine(inputs.conductorQueue),
    // a chave do vigia é `board/card@status`
    stall: inputs.stall.filter((r) => r.key.startsWith(`${board}/`)),
    toolFailures: mine(inputs.toolFailures),
    openTechnicalQuestions: mine(inputs.openTechnicalQuestions),
  };
}
