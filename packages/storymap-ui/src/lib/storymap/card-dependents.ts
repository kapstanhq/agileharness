// QUEM DEPENDE DE UM CARD — e se dá para descartar tudo junto, sem perder trabalho. PURO (sem IO, sem React).
//
// O PROBLEMA (visto numa tela do Inbox): uma pergunta «Aceitar «<título da sugestão>…» como trabalho?»
// oferecia «Descartar». O dono decidiu que NÃO queria — e o clique voltou com «Não dá para
// apagar: 1 card(s) vivem ancorados neste — … Reancore-os primeiro (arraste no mapa ou troque o Pai/Serve no card)».
// Jargão, sem botão para fazer isso, e uma decisão de negócio que o dono já tinha tomado ficou travada por
// uma regra de estrutura do mapa. A recusa é CERTA (apagar por baixo fabricaria órfão); o defeito era descobri-la só
// DEPOIS do clique e não oferecer a saída que o próprio sistema sabe executar.
//
// A SAÍDA: o card que o dono descarta leva junto, para a lixeira (recuperável por 7 dias, com «Desfazer» de tudo), o
// que só existe por causa dele — contanto que nada disso tenha PRODUZIDO trabalho (código, tarefa feita, prova) e que
// ninguém esteja trabalhando agora. Se algum dependente já produziu algo, a recusa continua, mas dita em palavras do
// dono e apontando o card que segura — nunca em «ancorados / Pai / Serve».

import type { BoardConfig, Card } from "./types";

/** Quem ancora em quem: `parent` (o passo/pai) ou `serves` (a história que o card serve). */
export const anchoredTo = (c: Pick<Card, "parent" | "serves">, cardId: string): boolean => c.parent === cardId || c.serves === cardId;

/**
 * Os cards que dependem de `cardId`, TRANSITIVAMENTE (quem ancora nele, quem ancora nesses…), em ordem de largura —
 * o mais perto primeiro. Nunca inclui o próprio card nem repete um (ciclo de ancoragem não trava). PURA.
 */
export function dependentsOf(cardId: string, cards: readonly Card[]): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>([cardId]);
  let frontier = [cardId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of cards) {
        if (seen.has(c.id) || !anchoredTo(c, id)) continue;
        seen.add(c.id);
        out.push(c);
        next.push(c.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * O card já PRODUZIU algo que se perderia no descarte? O motivo, ou null quando só tem texto (que a lixeira guarda por
 * 7 dias). Trabalho = código no repositório (`commitRange`/`stagedAt`), prova de publicação, tarefa feita, QA carimbado,
 * ou um card que já chegou ao fim do fluxo. PURA.
 */
export function workProductOf(card: Card, config: Pick<BoardConfig, "statuses">): string | null {
  const status = config.statuses.find((s) => s.id === card.status);
  if (status?.terminal) return "já chegou ao fim do fluxo";
  if (card.commitRange || card.stagedAt) return "já tem código feito";
  if (card.deployProof) return "já foi publicado";
  if (card.qaPassed) return "já passou pela verificação";
  if ((card.tasks ?? []).some((t) => t.done)) return "já tem tarefa concluída";
  return null;
}

/** O que descartar um card significa para quem depende dele. */
export interface DiscardPlan {
  /** todos os que dependem do card (transitivo), do mais perto para o mais longe. */
  dependents: Card[];
  /**
   * Dá para levar todos junto? `ok: true` = nenhum produziu trabalho nem está em andamento agora. Senão, quem segura
   * e por quê — para o texto do dono e para o botão «abrir».
   */
  cascade: { ok: true } | { ok: false; blocker: Card; why: string };
}

/**
 * O plano de descarte de `cardId`. `busyIds` são os cards com alguém trabalhando AGORA (sessão viva, reserva): só o
 * servidor os conhece, então a decisão do Inbox (sem esse fato) planeja sem eles e o servidor RECONFERE antes de agir.
 * PURA.
 */
export function discardPlan(
  cardId: string,
  cards: readonly Card[],
  config: Pick<BoardConfig, "statuses">,
  busyIds: ReadonlySet<string> = new Set(),
): DiscardPlan {
  const dependents = dependentsOf(cardId, cards);
  for (const d of dependents) {
    if (busyIds.has(d.id)) return { dependents, cascade: { ok: false, blocker: d, why: "tem um agente trabalhando nele agora" } };
    const work = workProductOf(d, config);
    if (work) return { dependents, cascade: { ok: false, blocker: d, why: work } };
  }
  return { dependents, cascade: { ok: true } };
}

/** Quantos cards um descarte em grupo leva de uma vez. Acima disso não é um descarte do Inbox: é uma limpeza do mapa. */
export const DISCARD_GROUP_MAX = 25;

/** A marca que une os cards de UM descarte em grupo na lixeira (o card descartado + o instante). PURA. */
export function discardGroupKey(rootId: string, atIso: string): string {
  return `${rootId}@${atIso}`;
}

/**
 * Por que o descarte de `cardId` JUNTO com o que depende dele não pode acontecer — nas palavras do dono, apontando o
 * card que segura — ou null quando pode. A mesma frase no botão desabilitado do Inbox e na recusa do servidor. PURA.
 */
export function discardGroupRefusal(plan: DiscardPlan): string | null {
  if (!plan.cascade.ok) {
    return `Não dá para descartar junto: «${plan.cascade.blocker.title}», que depende deste card, ${plan.cascade.why}. Abra esse card e decida o que fazer com ele; depois descarte este.`;
  }
  if (plan.dependents.length > DISCARD_GROUP_MAX) {
    return `Este card tem ${plan.dependents.length} cards que dependem dele — é uma limpeza do mapa, não um descarte: use «Adiar — não agora» (leva todos junto e dá para trazer de volta).`;
  }
  return null;
}

/** «“A”, “B” e mais 2» — os dependentes em palavras, no máximo `max` nomes. PURA. */
export function dependentsSample(cards: readonly Pick<Card, "title">[], max = 3): string {
  const names = cards.slice(0, max).map((c) => `«${c.title}»`);
  const rest = cards.length - names.length;
  return `${names.join(", ")}${rest > 0 ? ` e mais ${rest}` : ""}`;
}
