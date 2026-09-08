// 🟥 Style Guide — the pure domain kernel (no React/IO/fs/spawn → fully unit-testable). D2/D3/D4.
//
// Two invariants the rest of the system leans on (mirrors canvas.ts's own two):
//   1. THE CANONICAL IS NEVER A BYTE OF THE LLM. `compileStyleGuideMd` deterministically regrows the
//      whole .md from a COERCED doc — never the model's raw text. `parseStyleGuideMd` reads the
//      frontmatter back out; the prose body is a DERIVED projection, never re-parsed as data (D3).
//   2. EMPTY IS NULL. `isEmptyStyleGuideDoc` is the single answer to "is there anything here?" — the
//      same emptiness-canonical discipline as `isEmptyCanvasValue`, so a board's FIRST fill never
//      reads as a phantom conflict against an absent guide.
//
// Bounds anti-runaway (00-conteudo-do-guia.md): the board is read on every request; an LLM without a
// ceiling wedges every subsequent read (the exact lesson of canvas.ts MAX_ITEMS_PER_BLOCK). Coerce
// TRUNCATES by these bounds — it never throws.

import { createHash } from "node:crypto";
import yaml from "js-yaml";
// `yaml` fica SÓ para `dump` (serializar o que nós mesmos construímos). LER bytes de board é pelo
// chokepoint — ver `parseStyleGuideMd`. O import arrasta `gray-matter` (que faz `require('fs')`), então
// vale a MESMA restrição que o `node:crypto` do topo já impõe: este módulo é server-only, e as views
// client importam dele apenas TIPOS (documentado em EstiloView.tsx / StyleSwatches.tsx).
import { FrontmatterError, describeFrontmatterError, parseYamlMap } from "./frontmatter";
import { STYLE_SECTIONS, type StyleSectionDef } from "./style-guide-blocks";

// ── Bounds ───────────────────────────────────────────────────────────────────

export const STYLE_GUIDE_BOUNDS = {
  MAX_COLOR_ROLES: 32,
  MAX_TYPE_LEVELS: 12,
  MAX_SECTION_PROSE: 4000,
  MAX_LIST_ITEMS: 40,
  MAX_REFS: 12,
} as const;

// ── Shape (00-conteudo-do-guia.md "StyleGuideDoc") ──────────────────────────

export interface ColorToken {
  /** primary | accent | surface | foreground | muted | danger… — a ROLE, never a bare value used raw. */
  role: string;
  /** hex | hsl(…) — oklch is converted-or-rejected on read (see contrastRatio). */
  value: string;
  /** the paired contrast colour (text over this fill), when this token is a fill role. */
  on?: string;
  /** the engagement rule in one sentence — every role MUST have one (00 quality bar). */
  usage: string;
  /** a quantified budget rule, e.g. "≤ 10% da área" — required for accent-class roles. */
  budget?: string;
}

export interface TypeLevel {
  /** hero | h1 | h2 | body | caption… */
  id: string;
  /** "32/48px" (size/line-height) — a bare size with no line-height fails the quality bar. */
  size: string;
  weight: number;
  tracking?: string;
  /** e.g. "1 hero por view, no topo". */
  rule?: string;
}

export interface StyleGuideDoc {
  meta: {
    /** bumped by the approve chokepoint (WS-1) — NEVER by a direct edit here. */
    version: number;
    updatedAt: string;
    /**
     * NO `hash` field here on purpose: the hash is computed OVER the compiled .md and lives ONLY in
     * the `StyleGuidePointer` on board.yaml — embedding it in the bytes it hashes is an unsolvable
     * self-reference and would break the D3 fixed point (parse(compile(doc)) ≡ doc).
     */
    sources: { prompt?: string; refs: string[] };
    /** D11 — an AA-blocking pair was overridden by a human; auditable, never silent. */
    aaOverride?: { by: string; reason: string; at: string };
    /**
     * WHO promoted this version, and why (2026-07-17 — style-autonomy). `actor` is the HONEST label from
     * `transitionActorLabel()`: `human` (operator/UI) or `run:orch` (the Autônomo tick). An agent NEVER
     * writes `human` here — the whole point of the field is that a machine-made choice is legible as one
     * afterwards. `reason` is required of the agent (it decides AND registers); the human's is optional,
     * because a human clicking approve is already the record.
     */
    approvedBy?: { actor: string; at: string; reason?: string };
  };
  identity: { school: string; personality: string[]; prose: string };
  /** ORDERED by priority — index 0 wins a conflict between two principles. */
  principles: { items: string[]; prose: string };
  color: { tokens: ColorToken[]; budgetRules: string[]; prose: string };
  typography: {
    fonts: { family: string; role: "display" | "body" | "mono"; source?: string }[];
    scale: TypeLevel[];
    rules: string[];
    prose: string;
  };
  spacing: { base: number; steps: number[]; prose: string };
  shape: { radii: Record<string, string>; depth: string; borders: string; prose: string };
  motion: { durations: Record<string, string>; easings: Record<string, string>; prose: string };
  voice: {
    lexicon: { preferred: { use: string; avoid: string }[]; forbidden: string[]; exceptions: string[] };
    prose: string;
  };
  /** symptom → fix, concrete and observable. */
  antiPatterns: { symptom: string; fix: string }[];
  /** known visual debt — so an agent doesn't re-report the resquício as a new bug (D-target-vs-debt). */
  debt: { knownIssues: string[] };
  /**
   * D6 — role → {file, cssVar} declared IN the guide. Turns the drift-check (style-drift.ts) and the
   * future `sincronizar` mode into a mechanical diff instead of a path guessed in a prompt.
   */
  tokenBindings?: Record<string, { file: string; cssVar: string }>;
}

/** The board.yaml pointer — {@link StyleGuidePointer}. Path-FREE by design (the canonical path is
 *  always derivable from the board slug), so the pointer can never carry a path-traversal payload. */
export interface StyleGuidePointer {
  /** mirrors the compiled doc's `meta.version` at the moment it was approved. */
  version: number;
  /** sha256 of the COMPILED .md bytes (computeStyleGuideHash) — never of the raw doc/JSON. */
  hash: string;
  updatedAt?: string;
}

export interface AAReport {
  pairs: { role: string; ratio: number; level: "AA" | "AA-large" | "fail" }[];
}

// ── Small tolerant primitives (shared by every section coercer) ────────────

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function str(raw: unknown, max: number = STYLE_GUIDE_BOUNDS.MAX_SECTION_PROSE): string {
  return typeof raw === "string" || typeof raw === "number" ? String(raw).trim().slice(0, max) : "";
}

function optStr(raw: unknown, max: number): string | undefined {
  const s = str(raw, max);
  return s ? s : undefined;
}

function strList(
  raw: unknown,
  max: number = STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS,
  itemMax = 300,
): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : ""))
    .filter(Boolean)
    .slice(0, max)
    .map((s) => s.slice(0, itemMax));
}

// A record key straight from parsed JSON/YAML must never be trusted as an object-key: `__proto__`
// assigned via bracket notation retargets the LOCAL object's own [[Prototype]] instead of creating a
// normal property (a malicious guide payload could otherwise smuggle one past `Object.keys`/JSON
// round-trips undetected). Reject the 3 reserved names everywhere a raw key becomes an output key.
const UNSAFE_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A bounded `Record<string,string>` (radii/durations/easings) — drops non-string values + empty keys. */
function strRecord(raw: unknown, maxEntries: number, keyMax = 40, valueMax = 80): Record<string, string> {
  const r = obj(raw);
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(r)) {
    if (n >= maxEntries) break;
    const key = String(k ?? "").trim().slice(0, keyMax);
    if (!key || UNSAFE_RECORD_KEYS.has(key) || (typeof v !== "string" && typeof v !== "number")) continue;
    const val = String(v).trim();
    if (!val) continue;
    out[key] = val.slice(0, valueMax);
    n++;
  }
  return out;
}

// ── Section coercers ─────────────────────────────────────────────────────────

function coerceMeta(raw: unknown): StyleGuideDoc["meta"] {
  const r = obj(raw);
  const version = Number(r.version);
  const sourcesRaw = obj(r.sources);
  const refs = strList(sourcesRaw.refs, STYLE_GUIDE_BOUNDS.MAX_REFS, 300);
  const prompt = optStr(sourcesRaw.prompt, STYLE_GUIDE_BOUNDS.MAX_SECTION_PROSE);
  const meta: StyleGuideDoc["meta"] = {
    version: Number.isFinite(version) && version > 0 ? Math.floor(version) : 0,
    updatedAt: str(r.updatedAt, 40),
    sources: { refs, ...(prompt ? { prompt } : {}) },
  };
  const ov = obj(r.aaOverride);
  const by = str(ov.by, 200);
  const reason = str(ov.reason, STYLE_GUIDE_BOUNDS.MAX_SECTION_PROSE);
  const at = str(ov.at, 40);
  if (by && reason && at) meta.aaOverride = { by, reason, at };
  // Fixed key order (actor, at, reason) like every coercer here — the D3 fixed point rides on yaml.dump of
  // this object, so the order must be built, not inherited from the raw input.
  const ap = obj(r.approvedBy);
  const actor = str(ap.actor, 200);
  const apAt = str(ap.at, 40);
  const apReason = optStr(ap.reason, STYLE_GUIDE_BOUNDS.MAX_SECTION_PROSE);
  if (actor && apAt) meta.approvedBy = { actor, at: apAt, ...(apReason ? { reason: apReason } : {}) };
  return meta;
}

function coerceIdentity(raw: unknown): StyleGuideDoc["identity"] {
  const r = obj(raw);
  return { school: str(r.school, 200), personality: strList(r.personality, 8, 60), prose: str(r.prose) };
}

function coercePrinciples(raw: unknown): StyleGuideDoc["principles"] {
  const r = obj(raw);
  return { items: strList(r.items, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS, 300), prose: str(r.prose) };
}

function coerceColorToken(raw: unknown): ColorToken | null {
  const r = obj(raw);
  const role = str(r.role, 60);
  const value = str(r.value, 80);
  if (!role || !value) return null;
  const token: ColorToken = { role, value, usage: str(r.usage, 300) };
  const on = optStr(r.on, 80);
  if (on) token.on = on;
  const budget = optStr(r.budget, 200);
  if (budget) token.budget = budget;
  return token;
}

function coerceColor(raw: unknown): StyleGuideDoc["color"] {
  const r = obj(raw);
  const tokens = (Array.isArray(r.tokens) ? r.tokens : [])
    .map(coerceColorToken)
    .filter((t): t is ColorToken => t != null)
    .slice(0, STYLE_GUIDE_BOUNDS.MAX_COLOR_ROLES);
  return {
    tokens,
    budgetRules: strList(r.budgetRules, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS, 200),
    prose: str(r.prose),
  };
}

const FONT_ROLES = ["display", "body", "mono"] as const;

function coerceFont(raw: unknown): StyleGuideDoc["typography"]["fonts"][number] | null {
  const r = obj(raw);
  const family = str(r.family, 100);
  if (!family) return null;
  const role = (FONT_ROLES as readonly string[]).includes(r.role as string)
    ? (r.role as (typeof FONT_ROLES)[number])
    : "body";
  const font: StyleGuideDoc["typography"]["fonts"][number] = { family, role };
  const source = optStr(r.source, 200);
  if (source) font.source = source;
  return font;
}

function coerceTypeLevel(raw: unknown): TypeLevel | null {
  const r = obj(raw);
  const id = str(r.id, 40);
  const size = str(r.size, 40);
  const weight = Number(r.weight);
  if (!id || !size || !Number.isFinite(weight)) return null;
  const level: TypeLevel = { id, size, weight: Math.round(weight) };
  const tracking = optStr(r.tracking, 20);
  if (tracking) level.tracking = tracking;
  const rule = optStr(r.rule, 200);
  if (rule) level.rule = rule;
  return level;
}

function coerceTypography(raw: unknown): StyleGuideDoc["typography"] {
  const r = obj(raw);
  const fonts = (Array.isArray(r.fonts) ? r.fonts : [])
    .map(coerceFont)
    .filter((f): f is NonNullable<typeof f> => f != null)
    .slice(0, 12);
  const scale = (Array.isArray(r.scale) ? r.scale : [])
    .map(coerceTypeLevel)
    .filter((l): l is TypeLevel => l != null)
    .slice(0, STYLE_GUIDE_BOUNDS.MAX_TYPE_LEVELS);
  return {
    fonts,
    scale,
    rules: strList(r.rules, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS, 200),
    prose: str(r.prose),
  };
}

function coerceSpacing(raw: unknown): StyleGuideDoc["spacing"] {
  const r = obj(raw);
  const base = Number(r.base);
  const steps = Array.isArray(r.steps)
    ? r.steps
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .slice(0, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS)
    : [];
  return { base: Number.isFinite(base) && base > 0 ? base : 0, steps, prose: str(r.prose) };
}

function coerceShape(raw: unknown): StyleGuideDoc["shape"] {
  const r = obj(raw);
  return {
    radii: strRecord(r.radii, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS),
    depth: str(r.depth, 300),
    borders: str(r.borders, 300),
    prose: str(r.prose),
  };
}

function coerceMotion(raw: unknown): StyleGuideDoc["motion"] {
  const r = obj(raw);
  return {
    durations: strRecord(r.durations, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS, 40, 20),
    easings: strRecord(r.easings, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS, 40, 60),
    prose: str(r.prose),
  };
}

function coercePreferredPair(raw: unknown): { use: string; avoid: string } | null {
  const r = obj(raw);
  const use = str(r.use, 100);
  const avoid = str(r.avoid, 100);
  if (!use && !avoid) return null;
  return { use, avoid };
}

function coerceVoice(raw: unknown): StyleGuideDoc["voice"] {
  const r = obj(raw);
  const lex = obj(r.lexicon);
  const preferred = (Array.isArray(lex.preferred) ? lex.preferred : [])
    .map(coercePreferredPair)
    .filter((p): p is { use: string; avoid: string } => p != null)
    .slice(0, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS);
  return {
    lexicon: {
      preferred,
      forbidden: strList(lex.forbidden, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS, 60),
      exceptions: strList(lex.exceptions, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS, 200),
    },
    prose: str(r.prose),
  };
}

function coerceAntiPattern(raw: unknown): StyleGuideDoc["antiPatterns"][number] | null {
  const r = obj(raw);
  const symptom = str(r.symptom, 200);
  const fix = str(r.fix, 200);
  if (!symptom && !fix) return null;
  return { symptom, fix };
}

function coerceAntiPatterns(raw: unknown): StyleGuideDoc["antiPatterns"] {
  return (Array.isArray(raw) ? raw : [])
    .map(coerceAntiPattern)
    .filter((a): a is NonNullable<typeof a> => a != null)
    .slice(0, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS);
}

function coerceDebt(raw: unknown): StyleGuideDoc["debt"] {
  const r = obj(raw);
  return { knownIssues: strList(r.knownIssues, STYLE_GUIDE_BOUNDS.MAX_LIST_ITEMS, 300) };
}

function coerceTokenBindings(raw: unknown): Record<string, { file: string; cssVar: string }> | undefined {
  const r = obj(raw);
  const out: Record<string, { file: string; cssVar: string }> = {};
  let n = 0;
  for (const [role, v] of Object.entries(r)) {
    if (n >= STYLE_GUIDE_BOUNDS.MAX_COLOR_ROLES) break;
    const vv = obj(v);
    const file = str(vv.file, 300);
    const cssVar = str(vv.cssVar, 80);
    if (!file || !cssVar) continue;
    const key = String(role ?? "").trim().slice(0, 60);
    if (!key || UNSAFE_RECORD_KEYS.has(key)) continue;
    out[key] = { file, cssVar };
    n++;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Coerce an UNKNOWN value into a {@link StyleGuideDoc} — tolerant, NEVER throws, truncates every
 * list/record by {@link STYLE_GUIDE_BOUNDS}. Every section is ALWAYS present (unlike the canvas's
 * null-block model): an absent/malformed section simply coerces to its own empty shape, so a reader
 * never branches on a missing key. Idempotent: `coerceStyleGuideDoc(coerceStyleGuideDoc(x))` is a
 * no-op — required for the D3 fixed point (parseStyleGuideMd ∘ compileStyleGuideMd ≡ coerce).
 */
export function coerceStyleGuideDoc(raw: unknown): StyleGuideDoc {
  const r = obj(raw);
  const tokenBindings = coerceTokenBindings(r.tokenBindings);
  return {
    meta: coerceMeta(r.meta),
    identity: coerceIdentity(r.identity),
    principles: coercePrinciples(r.principles),
    color: coerceColor(r.color),
    typography: coerceTypography(r.typography),
    spacing: coerceSpacing(r.spacing),
    shape: coerceShape(r.shape),
    motion: coerceMotion(r.motion),
    voice: coerceVoice(r.voice),
    antiPatterns: coerceAntiPatterns(r.antiPatterns),
    debt: coerceDebt(r.debt),
    ...(tokenBindings ? { tokenBindings } : {}),
  };
}

/**
 * Is this doc "nothing"? Emptiness-canonical (mirrors `isEmptyCanvasValue`): a freshly-coerced blank
 * doc, `undefined`, and a doc parsed from an absent file must all read the SAME — so a board's FIRST
 * approve is never a phantom conflict against "an empty guide that already existed".
 */
export function isEmptyStyleGuideDoc(doc: StyleGuideDoc): boolean {
  return (
    !doc.identity.school &&
    !doc.identity.prose &&
    doc.identity.personality.length === 0 &&
    doc.principles.items.length === 0 &&
    !doc.principles.prose &&
    doc.color.tokens.length === 0 &&
    !doc.color.prose &&
    doc.color.budgetRules.length === 0 &&
    doc.typography.fonts.length === 0 &&
    doc.typography.scale.length === 0 &&
    !doc.typography.prose &&
    !doc.spacing.base &&
    doc.spacing.steps.length === 0 &&
    !doc.spacing.prose &&
    Object.keys(doc.shape.radii).length === 0 &&
    !doc.shape.depth &&
    !doc.shape.borders &&
    !doc.shape.prose &&
    Object.keys(doc.motion.durations).length === 0 &&
    Object.keys(doc.motion.easings).length === 0 &&
    !doc.motion.prose &&
    doc.voice.lexicon.preferred.length === 0 &&
    doc.voice.lexicon.forbidden.length === 0 &&
    doc.voice.lexicon.exceptions.length === 0 &&
    !doc.voice.prose &&
    doc.antiPatterns.length === 0 &&
    doc.debt.knownIssues.length === 0 &&
    !doc.tokenBindings
  );
}

// ── WCAG (00-conteudo-do-guia.md "Regras WCAG computáveis") ─────────────────

function parseHex(raw: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const num = parseInt(hex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hh < 60) rgb = [c, x, 0];
  else if (hh < 120) rgb = [x, c, 0];
  else if (hh < 180) rgb = [0, c, x];
  else if (hh < 240) rgb = [0, x, c];
  else if (hh < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

/** `hsl(h s% l%)` or `hsl(h, s%, l%)`, with an optional alpha (ignored — contrast is opaque-pair only). */
function parseHsl(raw: string): [number, number, number] | null {
  const m = /^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*[^)]+)?\)$/i.exec(
    raw.trim(),
  );
  if (!m) return null;
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  if (![h, s, l].every(Number.isFinite)) return null;
  return hslToRgb(h, s, l);
}

/**
 * `oklch(L C H)` per CSS Color 4 — L/C accept a `%` (L% of 100 = 1; C% of 100% = chroma 0.4, the spec
 * reference range), H in degrees (`deg` suffix optional). Alpha (`/ A`) is accepted but ignored.
 */
function parseOklchTriplet(raw: string): { l: number; c: number; h: number } | null {
  const m = /^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)(%)?\s+([\d.]+)(?:deg)?\s*(?:\/[^)]+)?\)$/i.exec(raw.trim());
  if (!m) return null;
  const l = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  const c = m[4] ? (Number(m[3]) / 100) * 0.4 : Number(m[3]);
  const h = Number(m[5]);
  if (![l, c, h].every(Number.isFinite)) return null;
  return { l, c, h };
}

function encodeSrgbChannel(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  return (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
}

/** OKLCH → sRGB 0-255, via OKLab (Björn Ottosson's reference conversion — the CSS Color 4 formula). */
function oklchToRgb({ l, c, h }: { l: number; c: number; h: number }): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  const rLin = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
  return [encodeSrgbChannel(rLin), encodeSrgbChannel(gLin), encodeSrgbChannel(bLin)];
}

/** hex | hsl(…) | oklch(…) → sRGB 0-255, or throws with a clear message (never a silent NaN ratio). */
function parseColorToRgb(raw: string): [number, number, number] {
  const hex = parseHex(raw);
  if (hex) return hex;
  const hsl = parseHsl(raw);
  if (hsl) return hsl;
  const oklch = parseOklchTriplet(raw);
  if (oklch) return oklchToRgb(oklch);
  if (/^oklch\(/i.test(raw.trim())) {
    throw new Error(`contrastRatio: oklch(…) malformado ou não suportado: "${raw}"`);
  }
  throw new Error(`contrastRatio: formato de cor não suportado (use hex ou hsl(…)): "${raw}"`);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG 2.1 relative-luminance contrast ratio between two colours. Accepts hex and `hsl(…)`;
 * `oklch(…)` is converted when parseable, or throws with a clear message when it isn't (00 §WCAG).
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseColorToRgb(a));
  const lb = relativeLuminance(parseColorToRgb(b));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Heuristic: does this usage sentence declare a LARGE/UI-text context (3:1 bar) vs normal text (4.5:1)? */
function isLargeUsage(usage: string): boolean {
  return /\b(cta|bot[aã]o|button|large|grande|hero|t[ií]tulo|heading|display|ui)\b/i.test(usage);
}

function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}

/**
 * Compute the AA report for every colour token that declares a paired `on` — normal text needs
 * ≥4.5:1, large/UI text ≥3:1 (heuristic on `usage`). An unparseable pair fails closed (`ratio: 0`,
 * `level: "fail"`) rather than throwing — checkAA itself never throws.
 */
export function checkAA(doc: StyleGuideDoc): AAReport {
  const pairs: AAReport["pairs"] = [];
  for (const token of doc.color.tokens) {
    if (!token.on) continue;
    let ratio: number;
    try {
      ratio = contrastRatio(token.value, token.on);
    } catch {
      pairs.push({ role: token.role, ratio: 0, level: "fail" });
      continue;
    }
    const large = isLargeUsage(token.usage);
    const threshold = large ? 3 : 4.5;
    pairs.push({
      role: token.role,
      ratio: roundRatio(ratio),
      level: ratio >= threshold ? (large ? "AA-large" : "AA") : "fail",
    });
  }
  return { pairs };
}

// ── Compiler (D3 — the canonical is never a byte of the LLM) ────────────────

const COMPILED_HEADER =
  "<!-- GERADO — edite pela view Estilo ou via refine; edição manual será sobrescrita no próximo approve. -->";
const FRONTMATTER_DELIM = "---";

function renderSectionBody(doc: StyleGuideDoc, key: string): string {
  switch (key) {
    case "identity": {
      const { school, personality, prose } = doc.identity;
      const lines: string[] = [];
      if (school) lines.push(`Escola: ${school}`);
      if (personality.length) lines.push(`Personalidade: ${personality.join(", ")}`);
      if (prose) lines.push("", prose);
      return lines.join("\n");
    }
    case "principles": {
      const lines = doc.principles.items.map((it, i) => `${i + 1}. ${it}`);
      if (doc.principles.prose) lines.push("", doc.principles.prose);
      return lines.join("\n");
    }
    case "color": {
      const lines: string[] = [];
      if (doc.color.tokens.length) {
        lines.push("| papel | valor | on | uso | budget |", "|---|---|---|---|---|");
        for (const t of doc.color.tokens) {
          lines.push(`| ${t.role} | ${t.value} | ${t.on ?? ""} | ${t.usage} | ${t.budget ?? ""} |`);
        }
      }
      if (doc.color.budgetRules.length) lines.push("", ...doc.color.budgetRules.map((r) => `- ${r}`));
      if (doc.color.prose) lines.push("", doc.color.prose);
      return lines.join("\n");
    }
    case "typography": {
      const lines: string[] = [];
      if (doc.typography.fonts.length) {
        lines.push(...doc.typography.fonts.map((f) => `- ${f.family} (${f.role}${f.source ? `, ${f.source}` : ""})`));
      }
      if (doc.typography.scale.length) {
        lines.push("", "| nível | tamanho | peso | tracking | regra |", "|---|---|---|---|---|");
        for (const l of doc.typography.scale) {
          lines.push(`| ${l.id} | ${l.size} | ${l.weight} | ${l.tracking ?? ""} | ${l.rule ?? ""} |`);
        }
      }
      if (doc.typography.rules.length) lines.push("", ...doc.typography.rules.map((r) => `- ${r}`));
      if (doc.typography.prose) lines.push("", doc.typography.prose);
      return lines.join("\n");
    }
    case "spacing": {
      const lines: string[] = [];
      if (doc.spacing.base) lines.push(`Base: ${doc.spacing.base}`);
      if (doc.spacing.steps.length) lines.push(`Steps: ${doc.spacing.steps.join(", ")}`);
      if (doc.spacing.prose) lines.push("", doc.spacing.prose);
      return lines.join("\n");
    }
    case "shape": {
      const lines: string[] = [];
      const radii = Object.entries(doc.shape.radii);
      if (radii.length) lines.push(...radii.map(([k, v]) => `- ${k}: ${v}`));
      if (doc.shape.depth) lines.push(`Profundidade: ${doc.shape.depth}`);
      if (doc.shape.borders) lines.push(`Bordas: ${doc.shape.borders}`);
      if (doc.shape.prose) lines.push("", doc.shape.prose);
      return lines.join("\n");
    }
    case "motion": {
      const lines: string[] = [];
      const durations = Object.entries(doc.motion.durations);
      const easings = Object.entries(doc.motion.easings);
      if (durations.length) lines.push(...durations.map(([k, v]) => `- ${k}: ${v}`));
      if (easings.length) lines.push(...easings.map(([k, v]) => `- easing ${k}: ${v}`));
      if (doc.motion.prose) lines.push("", doc.motion.prose);
      return lines.join("\n");
    }
    case "voice": {
      const lines: string[] = [];
      const preferred = doc.voice.lexicon.preferred;
      if (preferred.length) {
        lines.push("| use | evite |", "|---|---|", ...preferred.map((p) => `| ${p.use} | ${p.avoid} |`));
      }
      if (doc.voice.lexicon.forbidden.length) lines.push("", `Proibido: ${doc.voice.lexicon.forbidden.join(", ")}`);
      if (doc.voice.lexicon.exceptions.length) lines.push("", `Exceções: ${doc.voice.lexicon.exceptions.join(", ")}`);
      if (doc.voice.prose) lines.push("", doc.voice.prose);
      return lines.join("\n");
    }
    case "antiPatterns":
      return doc.antiPatterns.map((a) => `- ${a.symptom} → ${a.fix}`).join("\n");
    case "debt":
      return doc.debt.knownIssues.map((d) => `- ${d}`).join("\n");
    default:
      return "";
  }
}

function frontmatterOf(doc: StyleGuideDoc): string {
  return yaml.dump(doc, { sortKeys: false, lineWidth: -1 }).trimEnd();
}

/**
 * Deterministically regrow the whole .md from a COERCED doc (D3): header, frontmatter (stable key
 * order — the coerce functions build the object in a FIXED order), then one `##` heading per
 * STYLE_SECTIONS entry, in registry order. Same input → same bytes (snapshot-tested).
 */
export function compileStyleGuideMd(doc: StyleGuideDoc): string {
  const coerced = coerceStyleGuideDoc(doc);
  const frontmatter = frontmatterOf(coerced);
  const body = STYLE_SECTIONS.map((s: StyleSectionDef) => {
    const content = renderSectionBody(coerced, s.key).trim();
    return `## ${s.label} [${s.key}]\n\n${content || "_(vazio)_"}`;
  }).join("\n\n");
  return `${COMPILED_HEADER}\n\n${FRONTMATTER_DELIM}\n${frontmatter}\n${FRONTMATTER_DELIM}\n\n${body}\n`;
}

/**
 * Frontmatter → doc (coerce embedded). The prose BODY is never re-parsed as data — it is a DERIVED
 * projection of the frontmatter (D3), so re-reading it would be reading a copy of the same truth
 * through a lossier format. Tolerant: an unparseable/absent frontmatter block coerces to the empty doc.
 *
 * SEGURANÇA — o parse passa pelo chokepoint (`parseYamlMap`), não por `yaml.load` direto. Este arquivo
 * vive em `storymap/boards/<board>/design/style-guide.md`: é dado de BOARD, o mesmo corpus que atravessa
 * a fronteira do OSS (um PR de contribuidor, um `git pull`, uma releitura por mtime) — e era o segundo
 * sítio que parseava board SEM teto de bytes/nós/profundidade e SEM guard de `__proto__`, o que deixava
 * o invariante do chokepoint falso. `parseYamlMap` RECUSA (lança) o documento hostil; a tolerância desta
 * função (recusa → doc vazio) é mantida de propósito, porque o ponto fixo D3 exige que ela nunca lance.
 */
export function parseStyleGuideMd(text: string): StyleGuideDoc {
  const parts = String(text ?? "").split(`\n${FRONTMATTER_DELIM}\n`);
  if (parts.length < 3) return coerceStyleGuideDoc(null);
  try {
    return coerceStyleGuideDoc(parseYamlMap(parts[1], "design/style-guide.md"));
  } catch (err) {
    // Um guia TORTO (YAML malformado / não-mapa) é rotina — degrada calado, como sempre. Uma recusa de
    // CONTROLE DE SEGURANÇA (bomba de alias, acima do teto, `__proto__`) não pode desaparecer junto: o
    // guia sumir da UI sem motivo no log deixaria a tentativa invisível para o operador.
    if (err instanceof FrontmatterError && err.reason !== "invalid-yaml" && err.reason !== "not-a-map") {
      console.error("[storymap] style-guide.md recusado:", describeFrontmatterError(err));
    }
    return coerceStyleGuideDoc(null);
  }
}

/** sha256 of the COMPILED .md bytes — lives ONLY in the board.yaml pointer (never the frontmatter). */
export function computeStyleGuideHash(compiledMd: string): string {
  return createHash("sha256").update(compiledMd, "utf8").digest("hex");
}

// ── Diff (structural, per section + per colour token) ───────────────────────

export interface StyleGuideDiff {
  changedSections: string[];
  colorTokenChanges: { role: string; kind: "added" | "removed" | "changed" }[];
}

/** Structural diff between two (already coerced-shaped) docs — per section + a finer per-token pass
 *  over `color` (the section most likely to matter token-by-token to a reviewer). */
export function diffStyleGuide(a: StyleGuideDoc, b: StyleGuideDoc): StyleGuideDiff {
  const ca = coerceStyleGuideDoc(a);
  const cb = coerceStyleGuideDoc(b);
  const changedSections = STYLE_SECTIONS.map((s) => s.key).filter((key) => {
    const av = (ca as unknown as Record<string, unknown>)[key];
    const bv = (cb as unknown as Record<string, unknown>)[key];
    return JSON.stringify(av) !== JSON.stringify(bv);
  });
  const aRoles = new Map(ca.color.tokens.map((t) => [t.role, t]));
  const bRoles = new Map(cb.color.tokens.map((t) => [t.role, t]));
  const colorTokenChanges: StyleGuideDiff["colorTokenChanges"] = [];
  for (const role of new Set([...aRoles.keys(), ...bRoles.keys()])) {
    const av = aRoles.get(role);
    const bv = bRoles.get(role);
    if (!av && bv) colorTokenChanges.push({ role, kind: "added" });
    else if (av && !bv) colorTokenChanges.push({ role, kind: "removed" });
    else if (av && bv && JSON.stringify(av) !== JSON.stringify(bv)) colorTokenChanges.push({ role, kind: "changed" });
  }
  return { changedSections, colorTokenChanges };
}

// ── Prompt serializer (the agent's view of the current guide — for refine/regeneration) ────────────

/** The whole guide serialized for an agent's regeneration prompt — every section (even empty ones,
 *  so the agent sees what's missing), shows everything, even blanks — the same reading the canvas board gives. */
export function styleGuideToPrompt(doc: StyleGuideDoc): string {
  const coerced = coerceStyleGuideDoc(doc);
  const lines: string[] = [`Guia de estilo — versão ${coerced.meta.version || "(rascunho)"}`, ""];
  for (const s of STYLE_SECTIONS) {
    lines.push(`## ${s.label}  [key: ${s.key}]`);
    const body = renderSectionBody(coerced, s.key).trim();
    lines.push(body || "(vazio)");
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── StyleGuidePointer (board.yaml — D10) ─────────────────────────────────────

/**
 * Coerce the board.yaml pointer. Tolerant: an invalid/incomplete shape drops the whole pointer
 * (undefined = "no guide yet"). Fixed key order (version, hash, updatedAt) — used on BOTH sides of
 * `deriveBoardConfigForPersist`'s delta-compare so a re-save never re-inlines a differently-ordered
 * (but semantically identical) pointer as a spurious diff.
 */
export function coerceStyleGuidePointer(raw: unknown): StyleGuidePointer | undefined {
  const r = obj(raw);
  const version = Number(r.version);
  const hash = str(r.hash, 128);
  if (!Number.isFinite(version) || version <= 0 || !hash) return undefined;
  const pointer: StyleGuidePointer = { version: Math.floor(version), hash };
  const updatedAt = optStr(r.updatedAt, 40);
  if (updatedAt) pointer.updatedAt = updatedAt;
  return pointer;
}
