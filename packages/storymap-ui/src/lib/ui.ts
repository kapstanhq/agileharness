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

// (A casca da barra de topo antiga — `topBarShell` e os três slots — saiu na fase 1: a barra de 52px mora em
// shell/AppBar, e as medidas que o esqueleto de carregamento divide com ela, em shell/app-bar-shell.ts.)

// ── O rodapé: o compositor do Jido ──────────────────────────────────────────────────────
// Desde a fase 1 o rodapé de toda tela de board é o compositor do Jido (chat/JidoComposer): FIXO, em toda largura,
// e ele publica a própria altura em `--jido-composer-h` no <html>. Quem rola embaixo dele reserva essa altura; quem
// gruda no fundo (barra de salvar, barra de decisão, barra de lote) gruda logo ACIMA dele. Sem compositor montado
// (tela com o chat ancorado, ou fora de um board) a variável não existe e vale 0 — a folga comum. Era a nav inferior
// do celular (`pb-24` / `bottom-14`), que saiu.

/** A folga do FIM de uma tela de board: o último item nunca fica atrás do compositor. */
export const composerGutter = "pb-[calc(var(--jido-composer-h,0px)_+_2rem)]";

/** O `bottom` de quem gruda no fundo da tela (sticky/fixed): logo acima do compositor. */
export const aboveComposer = "bottom-[var(--jido-composer-h,0px)]";

/** O `bottom` de um botão flutuante no canto: acima do compositor, com o respiro de antes. */
export const floatAboveComposer = "bottom-[calc(var(--jido-composer-h,0px)_+_1.5rem)]";

// ── Card typographic primitives (exact design spec) ─────────────────────────────────────
// One place for the recurring card micro-styles so a card can't drift from the spec.

/** The uppercase TYPE eyebrow atop a card — design spec: 10px / 700 / 0.07em tracking, subtle ink. */
export const cardEyebrow = "text-[10px] font-bold uppercase tracking-[0.07em] text-fg-subtle";

/** The mono ID chip (e.g. `story-ex9206`) — a faint recessed pill set in JetBrains Mono. */
export const idChip =
  "truncate rounded-[5px] bg-fg/[0.045] px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-fg-subtle";

/** Column COUNT chip — a soft recessed pill carrying the card count (design spec: 11.5px / 600). */
export const countChipCls =
  "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-fg/[0.05] px-1 text-[11.5px] font-semibold tabular-nums text-fg-subtle";

// (`actionBannerGradient`/`actionBannerClip` — o preenchimento e o recorte em seta da faixa "Ações"
// da GRADE do Story Map — saíram com ela. O mapa é um outline: a ação é um TÍTULO, e a hierarquia
// vem de tamanho/peso/recuo, não de uma faixa colorida.)
