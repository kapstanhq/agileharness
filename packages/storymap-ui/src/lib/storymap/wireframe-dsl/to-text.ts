// dslToText — render a WireframeNode tree to a CODE-generated, always-aligned ASCII outline.
//
// This is the graceful-degradation path: the rich visual is the React renderer, but every text
// surface (the markdown projection, the terminal, a copilot reading the sidecar, the legacy
// `content` field) gets a monospace outline whose columns ALWAYS line up — because widths are
// computed here by counting code points, not guessed by an LLM. Box-drawing chars (┌─│) are width-1
// in the app's mono stack and we never emit emoji/double-width glyphs, so the right edge stays true.
//
// Pure + bounded (the input tree is already capped by coerceNode; we also cap output lines).

import { CONTAINER_TYPES, PRIMITIVE_SPECS, type WireframeNode, type WireframePropValue } from "./types";

const DEFAULT_WIDTH: Record<string, number> = { mobile: 40, desktop: 60 };
const MIN_WIDTH = 16;
const MAX_LINES = 400;

// ── small helpers ─────────────────────────────────────────────────────────────
function str(v: WireframePropValue | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
function prop(node: WireframeNode, key: string): string | undefined {
  return str(node.props?.[key]);
}
function boolProp(node: WireframeNode, key: string): boolean {
  const v = node.props?.[key];
  return v === true || v === "true";
}
/** hard-clip to n cols (single-char marker when truncated) */
function clip(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "·";
}
function pad(s: string, width: number): string {
  return clip(s, width).padEnd(width, " ");
}

function iconTag(name: string | undefined): string {
  if (!name) return "";
  const n = name.toLowerCase();
  if (n === "avatar") return "(o)";
  if (n === "back" || n === "arrowleft") return "[<]";
  if (n === "menu") return "[=]";
  if (n === "close" || n === "x") return "[x]";
  if (n === "search") return "[q]";
  if (n === "plus" || n === "add") return "[+]";
  return `[${clip(n, 8)}]`;
}

// ── box drawing (every returned line is EXACTLY `width` wide) ───────────────────
function box(title: string, body: string[], width: number): string[] {
  const lines: string[] = [];
  let top = `┌─ ${clip(title, Math.max(0, width - 4))} `;
  top = top + "─".repeat(Math.max(0, width - 1 - top.length)) + "┐";
  lines.push(top.length === width ? top : pad(top, width));
  const inner = width - 4;
  if (!body.length) lines.push("│ " + pad("", inner) + " │");
  for (const b of body) lines.push("│ " + pad(b, inner) + " │");
  lines.push("└" + "─".repeat(Math.max(0, width - 2)) + "┘");
  return lines;
}

// ── container titles + leaf tokens ─────────────────────────────────────────────
function containerTitle(node: WireframeNode): string {
  const t = node.type;
  if (t === "section") {
    const eyebrow = prop(node, "eyebrow");
    const title = prop(node, "title");
    return ["section", eyebrow || title].filter(Boolean).join(" · ");
  }
  if (t === "grid") return `grid ${prop(node, "cols") ?? ""}col`.trim();
  if (t === "card") {
    const aspect = prop(node, "aspect");
    return aspect ? `card ${aspect}` : "card";
  }
  return t;
}

/** A leaf node → one or more raw token lines (unpadded; the caller pads to width). */
function leafTokens(node: WireframeNode, width: number): string[] {
  switch (node.type) {
    case "text": {
      const value = prop(node, "value") ?? "";
      const variant = prop(node, "variant") ?? "body";
      if (variant === "eyebrow") return [value.toUpperCase()];
      if (variant === "h1") return [`# ${value}`];
      if (variant === "h2") return [`## ${value}`];
      if (variant === "h3") return [`### ${value}`];
      return [value];
    }
    case "button": {
      const label = prop(node, "label") ?? "Button";
      const variant = prop(node, "variant") ?? "primary";
      const inner = variant === "ghost" ? `( ${label} )` : `[ ${label} ]`;
      if (boolProp(node, "full")) return [inner.padEnd(width, variant === "ghost" ? " " : " ")];
      return [inner];
    }
    case "input": {
      const ph = prop(node, "placeholder") ?? prop(node, "label") ?? "";
      const lead = prop(node, "icon") ? `${iconTag(prop(node, "icon"))} ` : "";
      const body = `${lead}${ph}`;
      const fill = Math.max(1, width - body.length - 4);
      return [`[ ${body}${"_".repeat(fill)} ]`];
    }
    case "image": {
      const aspect = prop(node, "aspect") ?? "";
      const label = prop(node, "label") ?? "";
      return [`[img${aspect ? " " + aspect : ""}${label ? " · " + label : ""}]`];
    }
    case "avatar":
      return ["(o)"];
    case "chip":
      return [`< ${prop(node, "label") ?? ""} >`];
    case "icon":
      return [iconTag(prop(node, "name"))];
    case "divider":
      return ["─".repeat(Math.max(1, width))];
    case "spacer": {
      const n = Math.min(4, Math.max(1, Number(prop(node, "size") ?? 1)));
      return Array.from({ length: n }, () => "");
    }
    case "appbar": {
      const lead = iconTag(prop(node, "leading"));
      const title = prop(node, "title") ?? "";
      const trail = iconTag(prop(node, "trailing"));
      const left = [lead, title].filter(Boolean).join("  ");
      const gap = Math.max(1, width - left.length - trail.length);
      return [`${left}${" ".repeat(gap)}${trail}`];
    }
    case "tabbar": {
      const items = Array.isArray(node.props?.items) ? (node.props!.items as WireframePropValue[]) : [];
      const labels = items.map((it) => {
        const o = it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, WireframePropValue>) : {};
        const label = str(o.label) ?? str(o.icon) ?? "·";
        return o.active === true || o.active === "true" ? `*${label}*` : label;
      });
      return [`[ ${labels.join(" | ")} ]`];
    }
    case "listItem": {
      const lead = prop(node, "leading") ? `${iconTag(prop(node, "leading"))} ` : "";
      const title = prop(node, "title") ?? "";
      const trail = prop(node, "trailing");
      const subtitle = prop(node, "subtitle");
      const head = `${lead}${title}${trail ? "  " + trail : ""}`;
      const out = [head];
      if (subtitle) out.push(`  ${subtitle}`);
      return out;
    }
    case "placeholder":
    default: {
      const label = prop(node, "label") ?? node.type;
      return [`[ ${label} ]`];
    }
  }
}

// ── recursion ───────────────────────────────────────────────────────────────
function renderNode(node: WireframeNode, width: number, budget: { lines: number }): string[] {
  if (budget.lines >= MAX_LINES) return [];
  const w = Math.max(MIN_WIDTH, width);

  if (CONTAINER_TYPES.has(node.type)) {
    const inner = w - 4;
    const body: string[] = [];
    for (const child of node.children ?? []) {
      if (budget.lines >= MAX_LINES) break;
      const childLines = renderNode(child, inner, budget);
      body.push(...childLines);
      budget.lines += childLines.length;
    }
    return box(containerTitle(node), body, w);
  }

  const tokens = leafTokens(node, w);
  budget.lines += tokens.length;
  return tokens.map((t) => pad(t, w));
}

/** Render a WireframeNode tree to an aligned ASCII outline string. */
export function dslToText(root: WireframeNode, opts?: { viewport?: string; width?: number }): string {
  const width = opts?.width ?? DEFAULT_WIDTH[opts?.viewport ?? "mobile"] ?? DEFAULT_WIDTH.mobile;
  // The root is conventionally a `screen`; if it's a bare leaf/other container we still render it.
  const budget = { lines: 0 };
  const label = root.type === "screen" ? (opts?.viewport ?? "mobile").toUpperCase() : containerTitle(root);
  if (CONTAINER_TYPES.has(root.type)) {
    const inner = Math.max(MIN_WIDTH, width) - 4;
    const body: string[] = [];
    for (const child of root.children ?? []) {
      const childLines = renderNode(child, inner, budget);
      body.push(...childLines);
      budget.lines += childLines.length;
    }
    return box(label, body, Math.max(MIN_WIDTH, width)).join("\n");
  }
  return renderNode(root, width, budget).join("\n");
}

// Re-export the spec doc for the vocabulary generator (skill/docs) — keeps one import site.
export { PRIMITIVE_SPECS };
