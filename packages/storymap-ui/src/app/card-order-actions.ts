"use server";

// A ORDEM DO TRABALHO é a POSIÇÃO do card na coluna — não há nota de prioridade. «Fazer antes» leva o card ao topo da
// coluna, «Pode esperar» ao fim; o condutor (runner/conductor.ts `compareConductorQueue`) e o `suggest_work` leem a
// mesma posição. Esta action é a ponte: a régua (qual `order` põe o card lá) é pura e mora em `lib/storymap/order.ts`
// (`placementOrder`), e a escrita passa pelo MESMO caminho de um arrastar no Kanban (`moveCardAction`, só o `order`:
// sem troca de status, sem gate, sem autorun). Quem chega pelo navegador é o operador; um agente chega pela tool MCP
// `move_card` (`position`), que exige a permissão de mover.

import { promises as fs } from "node:fs";
import { requireSession } from "@/lib/auth/action-guard";
import { cardPath } from "@/lib/storymap/paths";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { kanbanColumnStatusesOf } from "@/lib/storymap/kanban-features";
import { COLUMN_PLACEMENTS, placementOrder, type ColumnPlacement } from "@/lib/storymap/order";
import { moveCardAction } from "./actions";

type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/**
 * «Fazer antes» (`top`) / «Pode esperar» (`bottom`): grava o `order` que põe o card no topo ou no fim da sua coluna —
 * a coluna que o Kanban desenha (`kanbanColumnStatusesOf`: a raia declarada ou derivada, com os status que caem nela).
 * Só o card movido é regravado. Já está lá ⇒ `changed: false`, nada é escrito.
 */
export async function placeCardInColumnAction(input: {
  boardId: string;
  cardId: string;
  where: ColumnPlacement;
}): Promise<Result<{ order: number | null; changed: boolean }>> {
  await requireSession("placeCardInColumnAction");
  if (!COLUMN_PLACEMENTS.includes(input.where)) return { ok: false, error: `posição inválida: ${String(input.where)} (use top ou bottom)` };
  try {
    const [config, cards] = await Promise.all([readBoardConfig(input.boardId), readCards(input.boardId)]);
    const card = cards.find((c) => c.id === input.cardId);
    if (!card) return { ok: false, error: `card não encontrado: ${input.boardId}/${input.cardId}` };
    if (!card.status) return { ok: false, error: "o card não está em nenhuma coluna — não há posição para mudar" };
    const order = placementOrder(cards, kanbanColumnStatusesOf(config, card.status), card.id, input.where);
    if (order == null) return { ok: true, data: { order: card.order, changed: false } };
    // Mudar a VEZ não é atividade no card: a hora do arquivo é o «há quanto tempo» do Kanban e a régua de recência
    // (order.ts `byUpdatedDesc`), e um «Fazer antes» a punha em «agora», como se alguém tivesse trabalhado nele. A hora
    // de antes volta depois da escrita (melhor esforço: sem ela, só a idade fica fresca).
    const file = (() => {
      try {
        return cardPath(input.boardId, input.cardId);
      } catch {
        return null;
      }
    })();
    const before = file ? await fs.stat(file).catch(() => null) : null;
    const r = await moveCardAction({ boardId: input.boardId, cardId: input.cardId, order });
    if (!r.ok) return { ok: false, error: r.error };
    if (file && before) await fs.utimes(file, before.atime, before.mtime).catch(() => undefined);
    return { ok: true, data: { order, changed: true } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
