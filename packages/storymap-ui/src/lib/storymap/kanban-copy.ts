// AS PALAVRAS DO KANBAN NOVO — os textos fixos que o quadro mostra (o motivo do popover da caixinha, os pedidos escritos
// das ações do card, os rótulos do trem). Num módulo PURO para que o glossário do Inbox (inbox/copy.ts BANNED_TERMS:
// nada de «train», «merge», «run»… na tela do dono) os varra num teste só (kanban-copy.test.ts), como o activity-feed.
// Os pedidos são os do protótipo; as frases com número montam aqui também.

/** O motivo de cada estado no popover da caixinha, quando a linha viva não diz nada melhor. */
export const CRATE_REASON = {
  running: "Trabalhando nesta etapa.",
  paused: "Terminou o passo atual e parou com o board.",
  error: "Parou com erro.",
  attention: "Esperando sua decisão.",
  delivering: "O sistema leva sozinho pela integração.",
  live: "No ar.",
} as const;

/** «Sem atividade há 6 dias. Não está bloqueado: …» — o esquecido. */
export function forgottenReason(age: string): string {
  return `Sem atividade há ${age}. Não está bloqueado: ficou para trás enquanto os outros passavam.`;
}

/**
 * O motivo do item NA FILA: o que acontece a seguir (quem o pega e quando), não o estado de novo — o rótulo «Na fila»
 * já está logo acima no popover. Pelo que o board sabe de verdade: se um agente roda neste passo (`auto`) e se o
 * board está ligado.
 */
export function queuedReason(input: { auto: boolean; off: boolean; paused: boolean }): string {
  if (!input.auto) return "Nenhum agente trabalha neste passo: ele anda quando alguém o leva para o próximo.";
  if (input.off) return "Um agente pega este item quando o board for ligado. Desligado, nada começa sozinho.";
  if (input.paused) return "Um agente pega este item quando o board for retomado.";
  return "Um agente pega este item quando chegar a vez dele, na ordem da coluna.";
}

/** O motivo do «esperando condutor», pelas vagas do board. */
export function waitingReason(slots: number): string {
  return slots <= 1
    ? "Pronto para construir. O board está com 1 condutor e ele está ocupado."
    : `Pronto para construir. Os ${slots} condutores estão ocupados.`;
}

/** Os pedidos escritos que as ações abrem no chat do Jido (sem enviar) — os textos do protótipo. */
export const DRAFT = {
  talk: "",
  ask: "O que você está fazendo agora e quanto falta?",
  investigate: "Investigar por que parou e propor o conserto.",
  answer: "Responder a pergunta: ",
  follow: "Como está a entrega deste card?",
  resumeCard: "Retomar só este card.",
  move: "Mover para a etapa: ",
  run: "Rodar a etapa atual agora.",
  stop: "Parar o condutor deste card e guardar o trabalho.",
  defer: "Adiar este card. Motivo: ",
  bug: "Reportar um bug: ",
  sync: "Sincronizar este card com o repositório.",
  remove: "Excluir este card. Motivo: ",
} as const;

/** Os rótulos das ações (os botões do popover e do bloco de ação, e o menu do card). */
export const ACTION_LABEL = {
  ask: "Perguntar",
  investigate: "Investigar",
  answer: "Responder",
  // A ordem do trabalho é a POSIÇÃO na coluna (fase 5, sem nota de prioridade): estas duas gravam a posição direto.
  doFirst: "Fazer antes",
  canWait: "Pode esperar",
  orderHint: "A vez do card nesta coluna",
  follow: "Acompanhar",
  resume: "Retomar",
  resumeBoard: "Retomar o board",
  secondSlot: "Liberar 2º condutor",
  defer: "Adiar",
  findOnBoard: "Ver no board",
  askJido: "Perguntar ao Jido",
  menuHint: "Abre na central de comando, com o pedido escrito",
  // curto: o menu do card tem linhas de uma linha só (28px) no computador
  talk: "Falar com o Jido",
  move: "Mover para outra etapa…",
  run: "Rodar a etapa agora",
  stop: "Parar o condutor",
  deferMenu: "Adiar (não agora)",
  bug: "Reportar um bug",
  sync: "Sincronizar o card",
  remove: "Excluir o card",
} as const;

/** Os estados de uma entrada do trem (a coluna Entrega). */
export const TRAIN_LABEL = {
  stage: "No stage",
  fila: "Na fila",
  travado: "Travado",
  voce: "Precisa de você",
  pausado: "Pausado",
  head: "No trem · 1º",
  /** o cabeçalho do trem VAZIO: sem «1º» (não há primeiro). */
  headEmpty: "No trem",
  empty: "Nada esperando para entrar",
  emptyNote: "As entregas prontas aparecem aqui.",
  // a Esteira saiu (fase 3): a fila aberta leva ao Inbox, onde fica o que espera alguém
  openInbox: "O que espera alguém está no Inbox",
  end: "Fim da fila",
  seeQueue: "Ver fila",
  queue: "Fila do trem",
} as const;

/**
 * O aviso depois de «Fazer antes» (`top`) / «Pode esperar» (`bottom`): o que mudou — ou que nada precisou mudar
 * (o card já era o primeiro / o último da coluna).
 */
export function placementWords(where: "top" | "bottom", changed: boolean): string {
  if (where === "top") return changed ? "Feito: o card foi para o topo da coluna e vai antes." : "O card já é o primeiro da coluna.";
  return changed ? "Feito: o card foi para o fim da coluna e pode esperar." : "O card já é o último da coluna.";
}

/** Toda frase fixa deste módulo (com os números montados de exemplo) — o que o teste do glossário varre. */
export function kanbanCopyStrings(): string[] {
  return [
    ...Object.values(CRATE_REASON),
    forgottenReason("6 dias"),
    ...[true, false].flatMap((auto) => [true, false].map((off) => queuedReason({ auto, off, paused: !off }))),
    waitingReason(1),
    waitingReason(2),
    ...Object.values(DRAFT).filter(Boolean),
    ...Object.values(ACTION_LABEL),
    ...Object.values(TRAIN_LABEL),
    ...(["top", "bottom"] as const).flatMap((w) => [placementWords(w, true), placementWords(w, false)]),
  ];
}
