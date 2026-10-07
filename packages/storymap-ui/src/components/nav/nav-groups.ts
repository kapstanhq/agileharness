// A ARQUITETURA DE NAVEGAÇÃO por GRUPOS — a fonte única do modelo de seções do board.
//
// DOIS PLANOS, e a diferença entre eles é a régua desta arquitetura:
//
//   • O PRODUTO (o que você constrói) → os quatro GRUPOS do fluxo, Negócio → Produto → Design →
//     Software, no SELETOR DE GRUPO da barra do topo (`shell/GroupSwitcher`). Desde a fase 2 cada grupo
//     tem UMA página, e cada página mostra e edita UM arquivo do board:
//       Negócio  → /negocio  → docs/business-model-canvas.md
//       Produto  → /produto  → docs/prd.md
//       Design   → /design   → design/style-guide.md
//       Software → /kanban   → os cards
//     Grupo de uma página só não tem barra de abas — e por isso a barra de abas deixou de existir.
//   • A MÁQUINA (o que constrói) → o grupo SISTEMA, que NÃO entra no seletor: mora atrás da engrenagem
//     da barra (`shell/SettingsMenu` → `nav/BoardMenu`), em lista. Numa tela dele, o seletor diz "Sistema".
//
// Saíram de vez (fase 2, decisão do dono): Mapa (USM), Ideias, Personas & Sistemas, Métricas e Orquestração.
// As rotas delas REDIRECIONAM (Mapa/Ideias/Métricas/Orquestração → Kanban; Personas → Produto). A Esteira saiu
// na fase 3 (`/entrega` → Inbox); a Priorização saiu na fase 5 (`/priorizacao` → Kanban: a ordem do trabalho é a
// posição do card na coluna).
//
// O Início deixou de existir: a casa do board é o Kanban (`boardHomeHref`). Inbox é TRANSVERSAL — fica
// fora dos grupos.
//
// Isto é NAVEGAÇÃO de UI (constante app-level) — NÃO é board data: nunca toca board.yaml / StatusDef /
// o pipeline. O kanban continua fluindo por status; estes grupos só organizam as VIEWS.

import type { LucideIcon } from "lucide-react";
import { ClipboardList, Inbox, KanbanSquare, LayoutGrid, Palette, SlidersHorizontal } from "lucide-react";

/**
 * Toda view navegável do board.
 *
 * Duas delas são TRANSVERSAIS de um jeito particular — estão no union mas NÃO têm `NavItem` e não
 * moram em grupo nenhum: `processes` (app-level, fora de board) e `card` (a página de UM card).
 * Isso é deliberado e é o que faz a página de detalhe ficar NEUTRA DE GRUPO: `groupForView` devolve
 * `undefined` ⇒ o seletor de grupo não afirma seção nenhuma. Sem `NavItem`, `viewHref` cai na casa do
 * board (o Kanban) pelo guard `if (!item)` (trocar de board com um card aberto não tem para onde ir — o id
 * é do board de origem); COM um item ela emitiria `/board/<b>/card`, 404.
 */
export type BoardView =
  | "negocio"
  | "produto"
  | "design"
  | "kanban"
  | "config"
  | "processes"
  | "inbox"
  | "card";

export interface NavItem {
  id: BoardView;
  label: string;
  href: (boardId: string) => string;
  icon: LucideIcon;
  hint: string;
}

export interface NavGroup {
  id: string;
  label: string;
  /** As páginas do grupo. A PRIMEIRA é a DEFAULT — o destino do seletor de grupo. Desde a fase 2, uma só. */
  items: NavItem[];
}

/** A CASA do board — para onde vão o logo, a raiz `/board/<b>`, a porta `/` e todo fallback de navegação.
 *  Era o Início; desde a fase 1 é o Kanban (o Início foi eliminado). */
export function boardHomeHref(boardId: string): string {
  return `/board/${boardId}/kanban`;
}

export const INBOX_ITEM: NavItem = {
  id: "inbox",
  label: "Inbox",
  href: (b) => `/board/${b}/inbox`,
  icon: Inbox,
  hint: "Cockpit de automação — tudo que precisa de você neste board",
};

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "negocio",
    label: "Negócio",
    items: [
      { id: "negocio", label: "Business Model Canvas", href: (b) => `/board/${b}/negocio`, icon: LayoutGrid, hint: "O modelo de negócio em nove blocos — para quem, o que entrega, como ganha e quanto custa" },
    ],
  },
  {
    id: "produto",
    label: "Produto",
    items: [
      { id: "produto", label: "PRD", href: (b) => `/board/${b}/produto`, icon: ClipboardList, hint: "O documento de produto — problema, personas, proposta de valor, funcionalidades e o que fica de fora" },
    ],
  },
  {
    id: "design",
    label: "Design",
    items: [
      { id: "design", label: "Guia de estilo", href: (b) => `/board/${b}/design`, icon: Palette, hint: "Tom, cores, tipografia, estética e componentes do produto" },
    ],
  },
  {
    id: "software",
    label: "Software",
    // A tela do trabalho andando: onde ele está no fluxo, do pedido até o ar (Kanban). Telemetria e ajustes NÃO
    // moram aqui — ver SISTEMA_GROUP.
    items: [
      { id: "kanban", label: "Kanban", href: (b) => `/board/${b}/kanban`, icon: KanbanSquare, hint: "Fluxo das stories por status" },
      // A Esteira saiu na fase 3: o trem mora na coluna Entrega do Kanban; as alavancas dela, no Inbox.
    ],
  },
];

/**
 * O SISTEMA — a máquina por baixo do produto. Mesma anatomia de um grupo, mas FORA de `NAV_GROUPS`: não entra
 * no seletor de grupo (a porta dele é a engrenagem da barra, em lista, com o alcance de cada item escrito).
 * Métricas e Orquestração saíram na fase 2: o custo mora no painel da cota e os prompts de skill se mudam pelo chat.
 */
export const SISTEMA_GROUP: NavGroup = {
  id: "sistema",
  label: "Sistema",
  // Os `hint` são CURTOS de propósito: aqui eles não são só tooltip — viram a linha de baixo de cada
  // item no menu da engrenagem (`nav/BoardMenu`), lado a lado com Lixeira e os avisos.
  items: [{ id: "config", label: "Configurações", href: (b) => `/board/${b}/config`, icon: SlidersHorizontal, hint: "Autopilot · Jido · Toolkit & MCP" }],
};

/**
 * Telas que ainda EXISTEM mas saíram da navegação: sem grupo e sem link — só por URL (e pelos links que já
 * apontam para elas). Têm `NavItem` para continuar trocando de board sem cair no Kanban e para o rótulo da
 * view; o seletor de grupo nelas diz «Grupos». Hoje nenhuma: a Esteira saiu na fase 3 e a Priorização na fase 5
 * (as rotas delas redirecionam). A lista fica como o lugar declarado para a próxima tela que sair do menu.
 */
export const URL_ONLY_ITEMS: NavItem[] = [];

/** Todos os grupos navegáveis — os do produto MAIS o Sistema. O seletor de grupo usa só `NAV_GROUPS`. */
export const ALL_NAV_GROUPS: NavGroup[] = [...NAV_GROUPS, SISTEMA_GROUP];

/** Todo item navegável, achatado (Inbox + páginas de TODO grupo, Sistema incluso, + as só-por-URL) — para route
 *  lookup / rótulo da view ativa / troca de board. */
export const ALL_NAV_ITEMS: NavItem[] = [INBOX_ITEM, ...ALL_NAV_GROUPS.flatMap((g) => g.items), ...URL_ONLY_ITEMS];

/** O grupo dono de uma view — do produto OU o Sistema. undefined p/ transversais (inbox/processes/card),
 *  que não pertencem a nenhuma seção. */
export function groupForView(view: BoardView): NavGroup | undefined {
  return ALL_NAV_GROUPS.find((g) => g.items.some((i) => i.id === view));
}

/** O item navegável de uma view (para rótulo/ícone da view ativa). */
export function navItemForView(view: BoardView): NavItem | undefined {
  return ALL_NAV_ITEMS.find((i) => i.id === view);
}

/** O rótulo do SELETOR DE GRUPO para uma view: o grupo dela ("Sistema" nas telas da máquina). Uma tela SEM grupo (o
 *  Inbox do board, a página de um card) diz «Grupos» — o convite para escolher um, nunca o nome da tela («Inbox» no
 *  lugar do grupo lia como se o Inbox fosse um quinto grupo). */
export function groupLabelForView(view: BoardView): string {
  return groupForView(view)?.label ?? NO_GROUP_LABEL;
}

/** O gatilho do seletor numa tela sem grupo. */
export const NO_GROUP_LABEL = "Grupos";

/** O destino do seletor de grupo: a página DEFAULT da seção (a primeira de `items`). */
export function groupRadicalHref(group: NavGroup, boardId: string): string {
  return group.items[0].href(boardId);
}

/** Preserva a view ao trocar de board (fica no Kanban ao pular pro outro board); cai na casa do board
 *  (o Kanban) quando a view não tem equivalente. */
export function viewHref(view: BoardView, boardId: string): string {
  const item = navItemForView(view);
  if (!item || view === "processes") return boardHomeHref(boardId);
  return item.href(boardId);
}
