import type { Card } from "./types";

export const ORDER_STEP = 10;

/**
 * Return an order value placing a card between neighbours `a` and `b`.
 * Either may be undefined (start/end of a list). Drag-and-drop uses this so a
 * single move rewrites only one card file.
 */
export function midpoint(a: number | undefined, b: number | undefined): number {
  if (a == null && b == null) return ORDER_STEP;
  if (a == null) return (b as number) - ORDER_STEP;
  if (b == null) return a + ORDER_STEP;
  return (a + b) / 2;
}

/**
 * Stable comparator: by `order`, then by id for determinism.
 *
 * É também a ORDEM DO TRABALHO: dentro de uma coluna do Kanban, o card de `order` menor está mais acima e vai antes
 * (o condutor e o `suggest_work` leem a mesma régua). Não há nota de prioridade — quem decide a vez é a posição.
 * Esta é a normalização ÚNICA: um `order` repetido ou fora de sequência (cards antigos, ou um board que nunca foi
 * arrumado) é lido por esta comparação, empatando pelo id, sem reescrever nenhum arquivo; só o card que se move é
 * regravado ({@link placementOrder}).
 *
 * DUPLO USO, de propósito: o mesmo `order` é a posição do card entre os IRMÃOS no mapa (debaixo do passo, na árvore do
 * Produto e nos prompts da captura). No mapa de histórias a altura sob o passo já é a ordem de importância, então a
 * mesma régua serve às duas leituras: «Fazer antes» (que pode gravar valor negativo) também sobe a story sob o passo
 * dela, e a chegada numa coluna (kanban-features.ts `arrivalOrder`) a leva para o fim. Separar as duas exigiria um
 * campo próprio da coluna — não feito enquanto ninguém precisar de ordens divergentes.
 */
export function byOrder(a: Card, b: Card): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.id.localeCompare(b.id);
}

/** Onde pôr um card na sua coluna: «Fazer antes» = `top`, «Pode esperar» = `bottom`. */
export type ColumnPlacement = "top" | "bottom";
export const COLUMN_PLACEMENTS: readonly ColumnPlacement[] = ["top", "bottom"];

/**
 * PURA — o `order` que põe `cardId` no TOPO (`top`) ou no FIM (`bottom`) dos cards cujo status está em `statuses` (a
 * coluna do Kanban: a raia inteira quando o board declara raias, senão o status). Só o card movido muda: o topo é o
 * menor `order` dos OUTROS menos {@link ORDER_STEP}, o fim é o maior mais o passo. `null` quando o card já está lá
 * (estritamente antes/depois de todos — nada a gravar) ou não existe. Coluna sem outros cards: o `order` atual fica.
 */
export function placementOrder(
  cards: readonly Pick<Card, "id" | "status" | "order">[],
  statuses: readonly string[],
  cardId: string,
  where: ColumnPlacement,
): number | null {
  const me = cards.find((c) => c.id === cardId);
  if (!me) return null;
  const scope = new Set(statuses);
  const others = cards.filter((c) => c.id !== cardId && c.status != null && scope.has(c.status)).map((c) => c.order);
  if (!others.length) return null;
  if (where === "top") {
    const min = Math.min(...others);
    return me.order < min ? null : min - ORDER_STEP;
  }
  const max = Math.max(...others);
  return me.order > max ? null : max + ORDER_STEP;
}

/**
 * Recency comparator for the kanban columns: the most-recently-touched card on top.
 * Primary signal is the file mtime (`updatedMs`, set by readCards) — sub-second and
 * bumped by EVERY write (human edit, drag, or harness-* skill run), so a card rises the
 * instant anything touches it, even several times the same day. Falls back, for cards
 * with no mtime yet (in-memory drafts, or a fresh git clone that reset file mtimes),
 * to the day-granular `updated` frontmatter date, then to `order`, then `id` — every
 * tier deterministic so the sort is stable.
 */
export function byUpdatedDesc(a: Card, b: Card): number {
  const ams = a.updatedMs ?? 0;
  const bms = b.updatedMs ?? 0;
  if (ams !== bms) return bms - ams; // larger ms (more recent) first
  const ad = a.updated ?? "";
  const bd = b.updated ?? "";
  if (ad !== bd) return ad < bd ? 1 : -1; // later YYYY-MM-DD first; missing date sinks
  if (a.order !== b.order) return a.order - b.order;
  return a.id.localeCompare(b.id);
}
