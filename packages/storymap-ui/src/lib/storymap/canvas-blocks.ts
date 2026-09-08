// 🟨 Lean Canvas — THE block registry (Ash Maurya). One source for the 9 main blocks + the 3
// sub-blocks, shared by the VIEW (which lays them out) and the SERVER (which prompts the agent with
// the key list and validates what it proposes back). Duplicating this list is how the agent starts
// hallucinating block keys the UI can't render — so it lives here, once.
//
// The `order` is the canonical FILL order (segments first, unfair advantage last), not the visual
// order. Ref.: medium.com/lean-stack/what-is-the-right-fill-order-for-a-lean-canvas-f8071d0c6c8c

/** How a block paints its items. */
export type CanvasItemStyle =
  /** full note: tag header + body text (Problema, Solução, UVP, Segmentos). */
  | "note"
  /** compact chip: colour dot + one line (Métricas, Canais, Custos, Receita). */
  | "chip";

export interface CanvasBlockDef {
  /** the key inside board.config.canvas — also the governance `field`. */
  key: string;
  label: string;
  /** what goes in the block — becomes the empty-state placeholder. */
  hint: string;
  /** 1–9 fill order. Absent = a SUB-block (it refines its parent and has no number of its own). */
  order?: number;
  /** for a sub-block: the key of the block it renders inside (as the dashed footer note). */
  parent?: string;
  /** lucide icon name for the doc view's section heading (render-time lookup). */
  icon?: string;
  /** how the items are painted. Sub-blocks always render as a quiet note. */
  itemStyle?: CanvasItemStyle;
  /** items side by side instead of stacked — the wide bottom band (Custos / Receita). */
  row?: boolean;
  /**
   * The block's cell in the 5-column canvas grid (lg+). Static class strings on purpose: Tailwind
   * scans source text, so a computed `lg:col-start-${n}` would never be generated.
   *
   * It also carries the STACKED order (`order-N`, no breakpoint): below lg the canvas becomes a single
   * column, and the visual left-to-right order of the grid (2,4,8,3,9,5,1,7,6) would read as nonsense
   * next to the fill-order badge the block itself teaches. Stacked, the canvas is read in the order it
   * is FILLED — Segmentos (1) first, Vantagem injusta (9) last — and `lg:order-none` hands the layout
   * back to the grid on the desktop.
   */
  cell?: string;
}

export const CANVAS_BLOCKS: readonly CanvasBlockDef[] = [
  {
    key: "problem",
    icon: "circle-alert",
    label: "Problema",
    order: 2,
    hint: "As 3 principais dores do cliente, ditas do ponto de vista dele.",
    itemStyle: "note",
    cell: "order-2 lg:order-none lg:col-start-1 lg:row-start-1 lg:row-span-2",
  },
  {
    key: "existingAlternatives",
    icon: "search",
    label: "Alternativas existentes",
    parent: "problem",
    hint: "Como o cliente resolve essas dores hoje (concorrentes, gambiarras, fazer na mão).",
  },
  {
    key: "solution",
    icon: "lightbulb",
    label: "Solução",
    order: 4,
    hint: "O mínimo que resolve cada problema — em poucas palavras.",
    itemStyle: "note",
    cell: "order-4 lg:order-none lg:col-start-2 lg:row-start-1",
  },
  {
    key: "keyMetrics",
    icon: "trending-up",
    label: "Métricas-chave",
    order: 8,
    hint: "Os poucos números que dizem se o negócio vai bem (idealmente um).",
    itemStyle: "chip",
    cell: "order-8 lg:order-none lg:col-start-2 lg:row-start-2",
  },
  {
    key: "uniqueValueProposition",
    icon: "gem",
    label: "Proposta de valor única",
    order: 3,
    hint: "Uma frase clara do BENEFÍCIO que torna o produto diferente e desejável — não a lista de funcionalidades.",
    itemStyle: "note",
    cell: "order-3 lg:order-none lg:col-start-3 lg:row-start-1 lg:row-span-2",
  },
  {
    key: "highLevelConcept",
    icon: "sparkles",
    label: "Conceito de alto nível",
    parent: "uniqueValueProposition",
    hint: 'A analogia "X para Y" (ex.: "YouTube = Flickr de vídeos").',
  },
  {
    key: "unfairAdvantage",
    icon: "shield",
    label: "Vantagem injusta",
    order: 9,
    hint: 'O que não pode ser copiado nem comprado. Se ainda não tiver, escreva "nenhuma ainda".',
    itemStyle: "chip",
    cell: "order-9 lg:order-none lg:col-start-4 lg:row-start-1",
  },
  {
    key: "channels",
    icon: "radio",
    label: "Canais",
    order: 5,
    hint: "Os caminhos até o cliente.",
    itemStyle: "chip",
    cell: "order-5 lg:order-none lg:col-start-4 lg:row-start-2",
  },
  {
    key: "customerSegments",
    icon: "users",
    label: "Segmentos de clientes",
    order: 1,
    hint: "Para quem é: os públicos-alvo e usuários.",
    itemStyle: "note",
    cell: "order-1 lg:order-none lg:col-start-5 lg:row-start-1 lg:row-span-2",
  },
  {
    key: "earlyAdopters",
    icon: "target",
    label: "Early adopters",
    parent: "customerSegments",
    hint: "O cliente ideal — quem sente a dor mais aguda hoje.",
  },
  {
    key: "costStructure",
    icon: "wallet",
    label: "Estrutura de custos",
    order: 7,
    hint: "Os custos fixos e variáveis.",
    itemStyle: "chip",
    row: true,
    cell: "order-7 lg:order-none lg:col-start-1 lg:col-span-3 lg:row-start-3",
  },
  {
    key: "revenueStreams",
    icon: "coins",
    label: "Fontes de receita",
    order: 6,
    hint: "Como o produto ganha dinheiro (um modelo e uma faixa de preço a testar).",
    itemStyle: "chip",
    row: true,
    cell: "order-6 lg:order-none lg:col-start-4 lg:col-span-2 lg:row-start-3",
  },
] as const;

/** Every valid canvas key — the allowlist the agent proposal is validated against. */
export const CANVAS_BLOCK_KEYS: readonly string[] = CANVAS_BLOCKS.map((b) => b.key);

export const CANVAS_BLOCK_BY_KEY: ReadonlyMap<string, CanvasBlockDef> = new Map(
  CANVAS_BLOCKS.map((b) => [b.key, b]),
);

/** The 9 blocks that own a cell in the grid (a sub-block renders inside its parent). */
export const CANVAS_GRID_BLOCKS: readonly CanvasBlockDef[] = CANVAS_BLOCKS.filter((b) => b.cell != null);

/** The sub-blocks of a block (the dashed footer notes), in registry order. */
export function subBlocksOf(key: string): CanvasBlockDef[] {
  return CANVAS_BLOCKS.filter((b) => b.parent === key);
}

/** Human label of a block key — falls back to the key so an unknown key is still legible in a diff. */
export function canvasBlockLabel(key: string): string {
  return CANVAS_BLOCK_BY_KEY.get(key)?.label ?? key;
}

/** The governance label of a canvas block change, e.g. "Canvas · Problema". */
export function canvasChangeLabel(key: string): string {
  return `Canvas · ${canvasBlockLabel(key)}`;
}
