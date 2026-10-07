// As PALAVRAS da busca do Kanban — PURO (o teste lê daqui; `KanbanSearchBox` as desenha).
//
// Em 390px o campo tem ~220px: «Buscar funcionalidade ou item…» virava «Buscar funcionalidade ou i». No celular o
// placeholder é a palavra curta; a frase inteira segue no computador e, sempre, no `aria-label`.

/** O placeholder no computador (o campo tem 260px). */
export const SEARCH_PLACEHOLDER = "Buscar funcionalidade ou item…";
/** O placeholder no celular (abaixo do `md`). */
export const SEARCH_PLACEHOLDER_SHORT = "Buscar";
/** O nome do campo para o leitor de tela — o mesmo em toda largura. */
export const SEARCH_ARIA_LABEL = "Buscar funcionalidade ou item (atalho: /)";
/** Abaixo do `md` do Tailwind (768px) — o celular. */
export const SEARCH_NARROW_QUERY = "(max-width: 767px)";

/** O placeholder para a largura atual: `narrow` = o celular. */
export function searchPlaceholder(narrow: boolean): string {
  return narrow ? SEARCH_PLACEHOLDER_SHORT : SEARCH_PLACEHOLDER;
}
