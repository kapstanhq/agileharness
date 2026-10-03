// A ARQUITETURA DE NAVEGAÇÃO por GRUPOS — a fonte única do modelo de seções do board.
//
// DOIS PLANOS, e a diferença entre eles é a régua desta arquitetura:
//
//   • O PRODUTO (o que você constrói) → os quatro BLOCOS do fluxo, Negócio → Produto → Design →
//     Software, no centro do topnav ao redor do Jido. CLICAR num bloco abre a sua ferramenta DEFAULT
//     (a primeira de `items`) e as irmãs viram ABAS na segunda barra (`BlockTabs`); o POPOVER do bloco
//     mostra a seção INTEIRA como MINIATURAS de layout clicáveis (`nav/GroupNav` + `nav/LayoutThumb`).
//   • A MÁQUINA (o que constrói) → o grupo SISTEMA, que NÃO é bloco e NÃO tem miniatura: mora atrás do
//     ⚙ da barra (`nav/BoardMenu`), em lista. São ajustes e telemetria — consulta, não etapa do fluxo.
//
// Foi essa mistura que a reorganização desfez: Métricas (telemetria), Orquestração (os prompts do
// pipeline) e Configurações (os knobs do runner) moravam DENTRO do bloco Software, entre o Kanban e a
// Esteira — cinco miniaturas onde o operador procurava o trabalho e encontrava a oficina. Pior, a
// mesma Configuração tinha três portas (popover do bloco, ⚙ e uns cartões de atalho dentro da própria
// Configuração). Software ficou com as DUAS telas do trabalho andando (Kanban · Esteira); as três
// outras viraram o Sistema, com UMA porta. O nível 2 (`BlockTabs`) atende os dois planos igual — é o
// que faz o Sistema navegar como qualquer seção, com as irmãs à mão.
//
// Início e Inbox são TRANSVERSAIS — ficam fora dos grupos.
//
// Isto é NAVEGAÇÃO de UI (constante app-level) — NÃO é board data: nunca toca board.yaml / StatusDef /
// o pipeline. O kanban continua fluindo por status; estes grupos só organizam as VIEWS.

import type { LucideIcon } from "lucide-react";
import {
  Coins,
  ClipboardList,
  FileText,
  Home,
  Inbox,
  KanbanSquare,
  Lightbulb,
  ListOrdered,
  Map,
  Palette,
  Rocket,
  SlidersHorizontal,
  Users,
  Workflow,
} from "lucide-react";

/**
 * Toda view navegável do board.
 *
 * Duas delas são TRANSVERSAIS de um jeito particular — estão no union mas NÃO têm `NavItem` e não
 * moram em grupo nenhum: `processes` (app-level, fora de board) e `card` (a página de UM card).
 * Isso é deliberado e é o que faz a página de detalhe ficar NEUTRA DE BLOCO: `groupForView` devolve
 * `undefined` ⇒ nenhum bloco acende no centro da barra. Antes o `/card/<id>` se declarava
 * `view="kanban"`, então abrir uma story a partir do Mapa acendia o bloco **Software** — o realce
 * saltava de bloco no meio da navegação, dizendo que você tinha trocado de seção sem ter trocado.
 * Sem `NavItem`, `viewHref` cai no Início pelo guard `if (!item)` (trocar de board com um card aberto
 * não tem para onde ir — o id é do board de origem); COM um item ela emitiria `/board/<b>/card`, 404.
 */
export type BoardView =
  | "inicio"
  | "prd"
  | "canvas"
  | "mapa"
  | "ideias"
  | "vocabulario"
  | "priorizacao"
  | "estilo"
  | "kanban"
  | "metricas"
  | "entrega"
  | "orquestracao"
  | "config"
  | "processes"
  | "inbox"
  | "card";

/**
 * O RETRATO de uma tela — qual miniatura de layout a representa no popover do bloco (o desenho vive
 * em `nav/LayoutThumb.tsx`). É um KIND declarativo, não um arquivo de imagem: a miniatura é o
 * esqueleto da tela em divs (grid do canvas, colunas do kanban, barras das métricas…), então segue o
 * tema e não apodrece quando a tela muda de cor.
 *
 * Só as telas de BLOCO têm retrato: o popover de miniaturas é a superfície dos blocos, e o Sistema
 * (⚙) é lista. Os desenhos de `metrics`/`orchestration`/`settings` saíram junto com as telas — sem
 * consumidor eles seriam desenho morto, que é exatamente o que `nav-groups.test.ts` cobra. Estão no
 * git se um dia o Sistema ganhar popover visual.
 */
export const THUMB_KINDS = [
  "canvas",
  "prd",
  "mapa",
  "ideas",
  "personas",
  "priority",
  "styleguide",
  "kanban",
  "delivery",
] as const;

export type ThumbKind = (typeof THUMB_KINDS)[number];

export interface NavItem {
  id: BoardView;
  label: string;
  href: (boardId: string) => string;
  icon: LucideIcon;
  hint: string;
  /** A miniatura de layout no popover do bloco. Opcional porque os itens TRANSVERSAIS (Início,
   *  Inbox) não moram em bloco nenhum — mas toda ferramenta de `NAV_GROUPS` tem a sua (garantido
   *  por `nav-groups.test.ts`); sem ela o popover cai no ícone do item. */
  thumb?: ThumbKind;
}

export interface NavGroup {
  id: string;
  label: string;
  /** classe de fundo do quadradinho de cor da seção (a mnemônica que sobrevive quando o rótulo some). */
  dot: string;
  /** token tailwind de cor do rótulo/realce da seção. */
  tone: string;
  /** As ferramentas da seção (cada uma uma view/aba). A PRIMEIRA é a DEFAULT — o destino do clique no
   *  bloco. Um grupo de uma ferramenta só (Design) não mostra barra de abas. */
  items: NavItem[];
}

export const INICIO_ITEM: NavItem = {
  id: "inicio",
  label: "Início",
  href: (b) => `/board/${b}/inicio`,
  icon: Home,
  hint: "Painel inicial — o que pede você, os terminais e o fluxo do kanban num lugar só",
};

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
    dot: "bg-amber-400",
    tone: "text-amber-500 dark:text-amber-300",
    items: [
      // O PRD é o PRIMEIRO — logo, a DEFAULT do bloco. É o documento mais alto: o canvas, o
      // backbone do mapa e as personas descem dele, e quem chega no bloco Negócio sem saber o que
      // procurar deve cair no que explica os outros.
      { id: "prd", label: "PRD", href: (b) => `/board/${b}/prd`, icon: ClipboardList, thumb: "prd", hint: "O documento de produto — problema, público, escopo, métricas e o que já está decidido" },
      { id: "canvas", label: "Lean Canvas", href: (b) => `/board/${b}/canvas`, icon: FileText, thumb: "canvas", hint: "O modelo de negócio numa página — a destilação do PRD" },
    ],
  },
  {
    id: "produto",
    label: "Produto",
    dot: "bg-emerald-500",
    tone: "text-emerald-700 dark:text-emerald-400",
    items: [
      { id: "mapa", label: "User Story Mapping", href: (b) => `/board/${b}/mapa`, icon: Map, thumb: "mapa", hint: "User Story Map (Jeff Patton) em outline — ação › passo › story › entrega, um nível por vez" },
      { id: "ideias", label: "Ideias", href: (b) => `/board/${b}/ideias`, icon: Lightbulb, thumb: "ideas", hint: "Espaço do problema — ideias agrupando as stories" },
      // O hint dizia "RICE · KANO · funil AAARRR" — três coisas que a tela deixou de renderizar (hoje
      // ela é WSJF puro, e o contrato dela PROÍBE os quatro gráficos de classificação de voltarem).
      // Drift de metadado é bug: este texto é o tooltip da aba, o da miniatura no popover e a linha do
      // sheet no celular — três lugares prometendo uma tela que não existe mais.
      { id: "priorizacao", label: "Priorização", href: (b) => `/board/${b}/priorizacao`, icon: ListOrdered, thumb: "priority", hint: "A ordem do backlog por WSJF — valor, urgência e desbloqueio sobre tamanho" },
      { id: "vocabulario", label: "Personas & Sistemas", href: (b) => `/board/${b}/vocabulario`, icon: Users, thumb: "personas", hint: "Vocabulário do board (personas e sistemas)" },
    ],
  },
  {
    id: "design",
    label: "Design",
    dot: "bg-red-400",
    tone: "text-red-600 dark:text-red-400",
    // Ferramenta única → o clique vai direto ao Guia de Estilo (sem barra de abas).
    items: [
      { id: "estilo", label: "Guia de Estilo", href: (b) => `/board/${b}/estilo`, icon: Palette, thumb: "styleguide", hint: "A fonte da verdade de estética do board — cores, tipografia, voz, anti-padrões" },
    ],
  },
  {
    id: "software",
    label: "Software",
    dot: "bg-sky-500",
    tone: "text-sky-600 dark:text-sky-400",
    // As DUAS telas do trabalho andando: onde ele está no fluxo (Kanban) e onde ele está no caminho
    // até o ar (Esteira). Telemetria e ajustes NÃO moram aqui — ver SISTEMA_GROUP.
    items: [
      { id: "kanban", label: "Kanban", href: (b) => `/board/${b}/kanban`, icon: KanbanSquare, thumb: "kanban", hint: "Fluxo das stories por status" },
      // "Esteira" (e não "Entrega"): a fase do Kanban JÁ se chama Entrega, e o mesmo nome para uma
      // coluna e para uma tela fazia o operador procurar a tela dentro da coluna. São níveis
      // diferentes — a coluna é a FASE de UMA story (aprovar e publicar); esta tela é a máquina por
      // baixo, o código de todos os cards andando de ponta a ponta. A ROTA segue /entrega (mudá-la
      // quebra links). O Kanban aponta para cá pelo `columns[].tool` do board.yaml.
      { id: "entrega", label: "Esteira", href: (b) => `/board/${b}/entrega`, icon: Rocket, thumb: "delivery", hint: "Onde cada trabalho está — em curso, no train, no stage e no ar; e o que segura uma publicação" },
    ],
  },
];

/**
 * O SISTEMA — a máquina por baixo do produto. Mesma anatomia de um grupo (para o nível 2 tratá-lo
 * igual: `BlockTabs` mostra as irmãs quando você está numa delas), mas FORA de `NAV_GROUPS`:
 *
 *  • não vira bloco no centro da barra (o centro é do produto, e um 5º bloco desequilibraria o Jido);
 *  • não tem miniatura (a superfície dele é o menu do ⚙ — lista, com o alcance de cada item escrito);
 *  • a cor é NEUTRA de propósito: as quatro cores do topnav são a mnemônica das quatro fases do
 *    produto, e dar uma quinta ao Sistema o faria parecer mais uma delas.
 *
 * A porta é UMA: o ⚙ ao lado do board (`nav/BoardMenu`). Antes eram três para o mesmo lugar —
 * o popover do bloco Software, o ⋯ e uns cartões "Acompanhamento" dentro da própria Configuração.
 */
export const SISTEMA_GROUP: NavGroup = {
  id: "sistema",
  label: "Sistema",
  dot: "bg-fg-subtle",
  tone: "text-fg-muted",
  // Os `hint` são CURTOS de propósito: aqui eles não são só tooltip — viram a linha de baixo de cada
  // item no menu do ⚙ (`nav/BoardMenu`), lado a lado com Lixeira e os avisos. Frase longa ali empurra
  // o menu para duas linhas por item e some com a densidade que ele acabou de ganhar.
  items: [
    { id: "config", label: "Configurações", href: (b) => `/board/${b}/config`, icon: SlidersHorizontal, hint: "Autopilot · Jido · Toolkit & MCP" },
    { id: "orquestracao", label: "Orquestração", href: (b) => `/board/${b}/orquestracao`, icon: Workflow, hint: "Os prompts do pipeline — skills, assistentes e rotas" },
    { id: "metricas", label: "Métricas", href: (b) => `/board/${b}/metricas`, icon: Coins, hint: "Custo e turns por card — telemetria dos runs" },
  ],
};

/** Todos os grupos navegáveis — os blocos do produto MAIS o Sistema. É a lista que o nível 2
 *  (`BlockTabs`, via {@link groupForView}) e o sheet do celular percorrem; o centro da barra usa só
 *  `NAV_GROUPS`. */
export const ALL_NAV_GROUPS: NavGroup[] = [...NAV_GROUPS, SISTEMA_GROUP];

/** Os dois lados do centro da barra: os blocos são partidos ao MEIO ao redor do Jido (nada de índices
 *  cravados — entrar/sair um bloco não exige mexer no header). */
export function splitGroupsAroundCenter(groups: NavGroup[] = NAV_GROUPS): [NavGroup[], NavGroup[]] {
  const half = Math.ceil(groups.length / 2);
  return [groups.slice(0, half), groups.slice(half)];
}

/** Todo item navegável, achatado (Início + Inbox + ferramentas de TODO grupo, Sistema incluso) — para
 *  route lookup / rótulo da view ativa / `columns[].tool` do board.yaml. */
export const ALL_NAV_ITEMS: NavItem[] = [
  INICIO_ITEM,
  INBOX_ITEM,
  ...ALL_NAV_GROUPS.flatMap((g) => g.items),
];

/** O grupo dono de uma view — bloco do produto OU o Sistema. undefined p/ transversais
 *  (inicio/inbox/processes), que não pertencem a nenhuma seção. */
export function groupForView(view: BoardView): NavGroup | undefined {
  return ALL_NAV_GROUPS.find((g) => g.items.some((i) => i.id === view));
}

/** O grupo aparece como BLOCO no centro da barra? (o Sistema não — ele mora no ⚙.) Quem pergunta é
 *  a barra de abas: sem bloco aceso lá em cima, ela precisa dizer de quem são as abas. */
export function isBlockGroup(group: NavGroup): boolean {
  return NAV_GROUPS.some((g) => g.id === group.id);
}

/** O item navegável de uma view (para rótulo/ícone da view ativa). */
export function navItemForView(view: BoardView): NavItem | undefined {
  return ALL_NAV_ITEMS.find((i) => i.id === view);
}

/** O destino do CLIQUE num bloco: a ferramenta DEFAULT da seção (a primeira de `items`). */
export function groupRadicalHref(group: NavGroup, boardId: string): string {
  return group.items[0].href(boardId);
}

/** Preserva a view ao trocar de board (fica no Kanban ao pular pro outro board); cai na home quando a
 *  view não tem equivalente. */
export function viewHref(view: BoardView, boardId: string): string {
  const item = navItemForView(view);
  if (!item || view === "processes") return INICIO_ITEM.href(boardId);
  return item.href(boardId);
}
