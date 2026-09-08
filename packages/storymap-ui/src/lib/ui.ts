// Shared visual primitives for the AgileHarness warm-neutral identity — class strings the
// dnd-wrapped cards reuse so their surface language stays in ONE place (a card can't drift
// from another). Tokens do the colour; these constants do the SHAPE (radius/border/elevation).
//
// The cards are draggable (each owns its own ref + listeners), so they can't be wrapped in a
// shared component without breaking dnd — a shared className constant is the right seam.

/**
 * The Notion-grade card surface: warm paper-white, a hairline graphite border and a barely-there
 * lift. Compose with `cn(cardSurface, …)`; add `cardSurfaceHover` on interactive (draggable) cards.
 */
export const cardSurface =
  "rounded-[10px] border border-fg/[0.09] bg-surface shadow-[0_1px_1px_rgba(15,15,15,0.025)] transition";

/** Hover treatment for an interactive card — the border firms up and the lift deepens softly. */
export const cardSurfaceHover =
  "hover:border-fg/[0.17] hover:shadow-[0_2px_10px_rgba(15,15,15,0.07)]";

/** A slightly tighter surface for nested/compact cards (story cells, density-compact). */
export const cardSurfaceSm =
  "rounded-lg border border-line bg-surface shadow-[0_1px_1px_rgba(15,15,15,0.035)] transition";

// ── A casca da barra de topo ────────────────────────────────────────────────────────────
// Mora AQUI, e não no `nav/TopBar.tsx`, por um motivo mecânico: o TopBar é `"use client"`
// (publica a própria altura por ResizeObserver) e quem mais precisa destas medidas é o
// ESQUELETO da barra — que é server-side justamente para não custar JS. Importar a string do
// módulo client arrastaria o grafo dele (HealthPill e seu poll) para dentro da tela de
// carregamento; copiá-la à mão deixaria o esqueleto sair do lugar no dia em que a barra mudar.
// Um módulo neutro resolve os dois: UMA definição, nenhum cliente a reboque.

/** O `<header>`: mesma altura, borda, superfície e grade em TODA página. */
export const topBarShell =
  "flex items-center gap-2 border-b border-line bg-surface px-4 py-2.5 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]";

/** Slot da ESQUERDA — a árvore de contexto (app › board › view). */
export const topBarSlotLeft =
  "flex min-w-0 flex-1 items-center gap-1 md:flex-none md:justify-self-start";

/** Slot do CENTRO — os blocos com o Jido no meio. */
export const topBarSlotCenter = "flex shrink-0 items-center md:justify-self-center";

/** Slot da DIREITA — os medidores + a ação primária. */
export const topBarSlotRight = "flex items-center gap-1 md:justify-self-end";

// ── Card typographic primitives (exact design spec) ─────────────────────────────────────
// One place for the recurring card micro-styles so a card can't drift from the spec.

/** The uppercase TYPE eyebrow atop a card — design spec: 10px / 700 / 0.07em tracking, subtle ink. */
export const cardEyebrow = "text-[10px] font-bold uppercase tracking-[0.07em] text-fg-subtle";

/** The mono ID chip (e.g. `story-recs`) — a faint recessed pill set in JetBrains Mono. */
export const idChip =
  "truncate rounded-[5px] bg-fg/[0.045] px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-fg-subtle";

/** Column COUNT chip — a soft recessed pill carrying the card count (design spec: 11.5px / 600). */
export const countChipCls =
  "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-fg/[0.05] px-1 text-[11.5px] font-semibold tabular-nums text-fg-subtle";

// (`actionBannerGradient`/`actionBannerClip` — o preenchimento e o recorte em seta da faixa "Ações"
// da GRADE do Story Map — saíram com ela. O mapa é um outline: a ação é um TÍTULO, e a hierarquia
// vem de tamanho/peso/recuo, não de uma faixa colorida.)
