// Wireframe DSL — the structured low-fi UI tree the harness-ui skill emits INSTEAD of free-hand ASCII.
//
// WHY: an LLM cannot reliably align monospace columns — transformers reason sequentially, not
// spatially (GPT-4 scores ~25% on single-char ASCII recognition), so hand-typed box art scrambles
// on the right edge and double-width glyphs (emoji) desync every trailing column. Here the model
// emits SEMANTIC STRUCTURE (a stack with an appbar, a search input, a section with a card carousel)
// and CODE does the pixel plumbing — exactly the project's "LLM does reasoning, code does plumbing"
// contract:
//   • the React renderer (components/wireframe/WireframeDSL) lays it out with flexbox — the browser
//     guarantees alignment, not the model;
//   • the pure text projection (to-text) renders a CODE-generated, always-aligned ASCII outline for
//     markdown / terminal / copilot / the legacy `content` field.
//
// MODULAR CONTRACT: adding a primitive is ONE entry in PRIMITIVE_SPECS below + one render case
// (WireframeDSL RENDERERS) + one to-text case (to-text NODE_TEXT), kept in lockstep by
// wireframe-dsl.contract.test.ts. Never branch on `type` outside those three registries.

/** A JSON-safe prop value (the sidecar is JSON; the tree nests directly, human-diffable). */
export type WireframePropValue =
  | string
  | number
  | boolean
  | null
  | WireframePropValue[]
  | { [key: string]: WireframePropValue };

/** A node in the wireframe tree. `type` is a known primitive (unknown coerces to a labeled
 *  placeholder — nothing renders blank). Leaf primitives ignore `children`. */
export interface WireframeNode {
  type: WireframePrimitiveType;
  props?: Record<string, WireframePropValue>;
  children?: WireframeNode[];
}

/** One primitive's contract: whether it nests children + a short doc + its documented props.
 *  `props` maps propName → a one-line human doc (drives the skill vocabulary AND the /docs page).
 *  It is intentionally loose (coercion is tolerant) — the doc is the spec, not a rigid validator. */
export interface PrimitiveSpec {
  container: boolean;
  doc: string;
  props: Record<string, string>;
}

// THE single source of truth for the vocabulary. Ordered container-first, then content primitives.
export const PRIMITIVE_SPECS = {
  // ── containers ──────────────────────────────────────────────────────────────
  screen: {
    container: true,
    doc: "root device frame — the outermost node of a screen; children stack vertically",
    props: {},
  },
  stack: {
    container: true,
    doc: "vertical stack of children",
    props: { gap: "spacing between children 0-6", pad: "inner padding 0-6", align: "start|center|end|stretch" },
  },
  row: {
    container: true,
    doc: "horizontal row of children",
    props: { gap: "0-6", align: "start|center|end", justify: "start|center|end|between|around" },
  },
  section: {
    container: true,
    doc: "titled group — an optional eyebrow + heading above its children",
    props: { eyebrow: "small uppercase kicker", title: "section heading" },
  },
  card: {
    container: true,
    doc: "elevated surface wrapping children",
    props: { pad: "inner padding 0-6", aspect: "fixed aspect e.g. 3:4, 16:9" },
  },
  grid: {
    container: true,
    doc: "N-column grid of children",
    props: { cols: "columns 2-4", gap: "0-6" },
  },
  list: {
    container: true,
    doc: "vertical list — children are listItem",
    props: { gap: "0-4" },
  },
  // ── content ─────────────────────────────────────────────────────────────────
  appbar: {
    container: false,
    doc: "top app bar with an optional leading icon, title and trailing icon",
    props: { title: "center/left title", leading: "icon name or 'back'/'menu'", trailing: "icon name or 'avatar'" },
  },
  tabbar: {
    container: false,
    doc: "bottom navigation bar",
    props: { items: "array of {icon, label, active?}" },
  },
  listItem: {
    container: false,
    doc: "a single list row",
    props: { title: "primary text", subtitle: "secondary text", leading: "icon name or 'avatar'", trailing: "icon name or short text" },
  },
  text: {
    container: false,
    doc: "a run of text",
    props: { value: "the text", variant: "h1|h2|h3|body|caption|eyebrow", muted: "true to de-emphasise" },
  },
  button: {
    container: false,
    doc: "a button",
    props: { label: "text", variant: "primary|secondary|ghost", full: "true = full width" },
  },
  input: {
    container: false,
    doc: "a text field / search box",
    props: { placeholder: "hint text", icon: "leading icon name", label: "field label above" },
  },
  image: {
    container: false,
    doc: "an image / media placeholder box (drawn as an outlined box with a diagonal)",
    props: { aspect: "e.g. 1:1, 3:4, 16:9", label: "caption shown inside" },
  },
  avatar: {
    container: false,
    doc: "a circular avatar placeholder",
    props: { size: "sm|md|lg" },
  },
  chip: {
    container: false,
    doc: "a chip / tag / badge",
    props: { label: "text", tone: "neutral|accent" },
  },
  icon: {
    container: false,
    doc: "a single icon glyph",
    props: { name: "icon name (see the icon set)" },
  },
  divider: {
    container: false,
    doc: "a horizontal divider line",
    props: {},
  },
  spacer: {
    container: false,
    doc: "vertical empty space",
    props: { size: "1-8" },
  },
  placeholder: {
    container: false,
    doc: "a generic labeled box — the fallback for anything not covered above",
    props: { label: "text inside", height: "px height hint" },
  },
} as const satisfies Record<string, PrimitiveSpec>;

export type WireframePrimitiveType = keyof typeof PRIMITIVE_SPECS;

export const PRIMITIVE_TYPES = Object.keys(PRIMITIVE_SPECS) as WireframePrimitiveType[];

/** The set of primitive types allowed to nest children (drives coercion + rendering). */
export const CONTAINER_TYPES = new Set<WireframePrimitiveType>(
  PRIMITIVE_TYPES.filter((t) => PRIMITIVE_SPECS[t].container),
);

export function isPrimitiveType(t: unknown): t is WireframePrimitiveType {
  return typeof t === "string" && Object.prototype.hasOwnProperty.call(PRIMITIVE_SPECS, t);
}
