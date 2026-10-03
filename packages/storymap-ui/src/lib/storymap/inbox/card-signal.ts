// O SINAL de um card — o item de DECIDIR que ele carrega agora, dito pelo modelo do Inbox. Onda 2 (passo 4): o Kanban
// (a pílula do card, o «Resolver» do rodapé) e o push liam o modelo LEGADO (`cardDemands` → `Demand`), que discordava
// do Inbox — o Kanban dizia «Aprovar design» sem item no Inbox, o push nunca via uma aprovação e, no só-negócio,
// cobrava do dono o que era do sistema. Agora os três perguntam ao mesmo modelo: um card só «pede você» quando o
// Inbox mostra uma decisão dele em Decidir. PURO (só os campos do card — o que o legado também via).
//
// Sem os fatos do board (contract.ts), o sinal é CONSERVADOR: o que depende do board (a causa de publicação que espera a
// decisão de outro card, o pedido de agente que já aconteceu) não vira Decidir aqui — a regra B tira o item que não tem
// o que mudar. A raia do dono no Kanban lê o coletor inteiro (decidir-ids.ts); este sinal serve o push e a linha do card.

import type { BoardConfig, Card } from "../types";
import { cardCockpitItems, type CockpitItemKind, type DemandSeverity } from "../demands";
import { primaryOption } from "./decision";
import { foldByCause, settleItems } from "./entries";
import { INBOX_KIND_NOUN } from "./copy";

export interface CardInboxSignal {
  /** o kind do item que lidera o card em Decidir. */
  kind: CockpitItemKind;
  /** o id do item — os links abrem o ITEM (B11). */
  itemId: string;
  /** a decisão, inteira (o push). */
  ask: string;
  /** a ação que resolve, curta (a pílula do Kanban): o rótulo da opção principal. */
  label: string;
  /** O QUE espera o dono, num substantivo curto (≤ 24 caracteres) — «Precisa de você: Aprovação». Nunca o rótulo de
   *  uma opção: «Pedir ao Jido…» é um botão, não o que espera. */
  what: string;
  severity: DemandSeverity;
}

/**
 * O item de Decidir que lidera este card, ou null. `exclude` tira kinds antes da dobra (o Kanban não repete, na
 * pílula, o gate da raia de entrega — o botão da própria raia já é essa decisão). PURA.
 */
export function cardInboxSignal(
  card: Card,
  config: BoardConfig,
  boardId: string,
  opts: { now: number; exclude?: (kind: CockpitItemKind) => boolean },
): CardInboxSignal | null {
  const items = cardCockpitItems(card, config, boardId, { now: opts.now }).filter((i) => !opts.exclude?.(i.kind));
  const { entries } = settleItems(items, { boardId, boardName: config.name, config, cardsById: new Map([[card.id, card]]), now: opts.now });
  const lead = foldByCause(entries).find((e) => e.decision.bucket === "decidir");
  if (!lead?.item) return null;
  return {
    kind: lead.item.kind,
    itemId: lead.itemId,
    ask: lead.decision.ask,
    label: primaryOption(lead.decision)?.label ?? lead.decision.askVerb ?? "Decidir",
    what: INBOX_KIND_NOUN[lead.item.kind],
    severity: lead.item.severity,
  };
}
