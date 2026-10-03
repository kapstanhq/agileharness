// «ADIADO — NÃO AGORA»: a marca que as automações respeitam. PURO (sem IO, sem React).
//
// O PROBLEMA: quando o dono adia um módulo inteiro e depois muda de ideia, a automação pode CONSTRUIR o que ele tinha
// guardado, por três buracos:
//   • apagar/arquivar vale para UM card — o que nasce dele depois (verificação, conserto, proposta de continuação) não herda;
//   • guardar «de propósito» e «esquecido» eram a mesma coisa para o sistema: ao adotar todo card parado numa etapa sem
//     ninguém (os «órfãos»), o módulo adiado inteiro entrava na fila do condutor;
//   • o juiz da triagem aceita o que serve ao PRD, e o PRD ainda tratava o módulo como aposta ativa.
//
// A SAÍDA: um adiamento é uma MARCA no card (`Card.deferred`: motivo, desde quando, quando rever). Adiar um card ESTAMPA a
// marca nele e em tudo que depende dele (`parent`/`serves`, transitivo, exceto o que já terminou); o que nascer depois dele
// nasce adiado (triagem). Um card adiado fica INERTE: fora da fila do condutor, fora da adoção de órfãos, sem skill de
// coluna, sem item no Inbox, sem filho aceito pelo juiz. Trazer de volta tira a marca de quem foi adiado POR causa dele.

import { dependentsOf } from "./card-dependents";
import type { BoardConfig, Card, Deferral } from "./types";

/** O card está adiado? PURA. */
export const isDeferred = (card: Pick<Card, "deferred"> | null | undefined): boolean => !!card?.deferred;

/**
 * O ancestral ADIADO mais perto do card (por `parent`/`serves`), ou null. É o que o juiz da triagem consulta para um card
 * recém-nascido: se o que ele serve está adiado, ele nasce adiado também. Seguro contra ciclo de ancoragem. PURA.
 */
export function deferredAnchor(card: Pick<Card, "parent" | "serves">, byId: ReadonlyMap<string, Card>): Card | null {
  const seen = new Set<string>();
  let frontier = [card.parent, card.serves].filter((x): x is string => !!x);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const a = byId.get(id);
      if (!a) continue;
      if (a.deferred) return a;
      next.push(...[a.parent, a.serves].filter((x): x is string => !!x));
    }
    frontier = next;
  }
  return null;
}

/** O que adiar `rootId` estampa: ele e tudo que depende dele e ainda não terminou e ainda não está adiado. PURA. */
export function deferTargets(rootId: string, cards: readonly Card[], config: Pick<BoardConfig, "statuses">): Card[] {
  const root = cards.find((c) => c.id === rootId);
  if (!root) return [];
  const live = (c: Card) => !c.deferred && !config.statuses.find((s) => s.id === c.status)?.terminal;
  return [root, ...dependentsOf(rootId, cards)].filter(live);
}

/** A marca de um card adiado direto (`root` ausente) ou por depender do `rootId`. PURA. */
export function deferralFor(input: { reason: string; today: string; by: string; reviewOn?: string | null; rootId: string; cardId: string }): Deferral {
  return {
    reason: input.reason.trim(),
    since: input.today,
    ...(input.reviewOn ? { reviewOn: input.reviewOn } : {}),
    by: input.by,
    ...(input.cardId !== input.rootId ? { root: input.rootId } : {}),
  };
}

/** Quem volta quando `rootId` volta: ele mesmo e os adiados POR causa dele (os que o dono adiou à parte ficam). PURA. */
export function liftTargets(rootId: string, cards: readonly Card[]): Card[] {
  return cards.filter((c) => c.deferred && (c.id === rootId || c.deferred.root === rootId));
}

/** O adiamento venceu a data de rever? (YYYY-MM-DD) PURA. */
export function reviewDue(card: Pick<Card, "deferred">, today: string): boolean {
  return !!card.deferred?.reviewOn && card.deferred.reviewOn <= today;
}

/** Uma linha em palavras do dono: «Adiado desde 14/03 — o módulo de relatórios espera o próximo trimestre (rever em 02/05)». PURA. */
export function deferralText(d: Deferral): string {
  const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : iso);
  return `Adiado desde ${day(d.since)} — ${d.reason}${d.reviewOn ? ` (rever em ${day(d.reviewOn)})` : ""}`;
}
