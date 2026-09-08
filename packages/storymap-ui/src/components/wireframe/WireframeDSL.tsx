"use client";

// WireframeDSL — the deterministic React renderer for the Wireframe DSL tree (the premium visual
// the human sees in the card document + the Inbox cockpit). Layout is pure flexbox/grid, so the
// BROWSER guarantees alignment — the failure mode of hand-typed ASCII (scrambled right edge) cannot
// happen here. Low-fidelity by design: outline boxes, system font, grayscale (one subtle accent),
// no brand assets — a wireframe, not a mockup.
//
// MODULAR CONTRACT: RENDERERS is an EXHAUSTIVE Record<WireframePrimitiveType, …> — adding a primitive
// to PRIMITIVE_SPECS without a renderer here is a COMPILE ERROR (no runtime surprise). Static Tailwind
// class lookups (GAP/PAD/…) keep the JIT happy (no constructed class names).

import { Fragment } from "react";
import {
  Bell, Calendar, Camera, Check, ChevronLeft, ChevronRight, Circle, Clock, Filter, Heart, Home,
  Image as ImageIcon, MapPin, Menu, MoreHorizontal, Plus, Search, Send, Settings, Share2, Square,
  Star, Ticket, User, Users, X, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  CONTAINER_TYPES,
  type WireframeNode,
  type WireframePrimitiveType,
  type WireframePropValue,
} from "@/lib/storymap/wireframe-dsl";

// ── prop readers ────────────────────────────────────────────────────────────
function str(v: WireframePropValue | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
const p = (node: WireframeNode, k: string) => str(node.props?.[k]);
const flag = (node: WireframeNode, k: string) => node.props?.[k] === true || node.props?.[k] === "true";

// ── static class maps (JIT-safe — never construct class strings) ──────────────
const GAP: Record<string, string> = { "0": "gap-0", "1": "gap-1", "2": "gap-2", "3": "gap-3", "4": "gap-4", "5": "gap-5", "6": "gap-6" };
const PAD: Record<string, string> = { "0": "p-0", "1": "p-1", "2": "p-2", "3": "p-3", "4": "p-4", "5": "p-5", "6": "p-6" };
const COLS: Record<string, string> = { "1": "grid-cols-1", "2": "grid-cols-2", "3": "grid-cols-3", "4": "grid-cols-4" };
const ALIGN: Record<string, string> = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" };
const JUSTIFY: Record<string, string> = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between", around: "justify-around" };
const AVATAR: Record<string, string> = { sm: "h-6 w-6", md: "h-9 w-9", lg: "h-12 w-12" };

const g = (node: WireframeNode, def: string) => GAP[p(node, "gap") ?? def] ?? GAP[def];
const pd = (node: WireframeNode, def: string) => PAD[p(node, "pad") ?? def] ?? PAD[def];
const aspectStyle = (aspect?: string) => {
  if (!aspect) return undefined;
  const m = /^(\d+)\s*[:/x]\s*(\d+)$/.exec(aspect.trim());
  return m ? { aspectRatio: `${m[1]} / ${m[2]}` } : undefined;
};

// ── icons ──────────────────────────────────────────────────────────────────
const ICONS: Record<string, LucideIcon> = {
  menu: Menu, back: ChevronLeft, arrowleft: ChevronLeft, next: ChevronRight, chevron: ChevronRight,
  close: X, x: X, search: Search, plus: Plus, add: Plus, heart: Heart, like: Heart, star: Star,
  bell: Bell, notification: Bell, user: User, avatar: User, users: Users, mappin: MapPin, location: MapPin,
  check: Check, home: Home, calendar: Calendar, image: ImageIcon, share: Share2, more: MoreHorizontal,
  settings: Settings, camera: Camera, send: Send, filter: Filter, clock: Clock, ticket: Ticket,
};
function iconFor(name?: string): LucideIcon {
  if (!name) return Circle;
  return ICONS[name.toLowerCase().replace(/[^a-z]/g, "")] ?? Square;
}
function Glyph({ name, className }: { name?: string; className?: string }) {
  const I = iconFor(name);
  return <I className={cn("h-4 w-4 shrink-0", className)} strokeWidth={1.75} />;
}

// ── text variants ────────────────────────────────────────────────────────────
const TEXT_VARIANT: Record<string, string> = {
  h1: "text-lg font-semibold text-fg",
  h2: "text-base font-semibold text-fg",
  h3: "text-sm font-semibold text-fg",
  body: "text-[13px] text-fg-muted",
  caption: "text-[11px] text-fg-subtle",
  eyebrow: "text-[10px] font-medium uppercase tracking-wide text-fg-subtle",
};

// ── the exhaustive renderer registry ─────────────────────────────────────────
type NodeRenderer = (node: WireframeNode, kids: React.ReactNode) => React.ReactNode;

const RENDERERS: Record<WireframePrimitiveType, NodeRenderer> = {
  screen: (node, kids) => <div className="flex flex-col">{kids}</div>,
  stack: (node, kids) => (
    <div className={cn("flex flex-col", g(node, "2"), pd(node, "0"), ALIGN[p(node, "align") ?? "stretch"])}>{kids}</div>
  ),
  row: (node, kids) => (
    <div className={cn("flex flex-row flex-wrap", g(node, "2"), ALIGN[p(node, "align") ?? "center"], JUSTIFY[p(node, "justify") ?? "start"])}>
      {kids}
    </div>
  ),
  section: (node, kids) => {
    const eyebrow = p(node, "eyebrow");
    const title = p(node, "title");
    return (
      <section className="flex flex-col gap-1.5">
        {eyebrow && <span className={TEXT_VARIANT.eyebrow}>{eyebrow}</span>}
        {title && <span className={TEXT_VARIANT.h3}>{title}</span>}
        <div className="flex flex-col gap-2">{kids}</div>
      </section>
    );
  },
  card: (node, kids) => (
    <div className={cn("rounded-lg border border-line bg-surface", pd(node, "3"))} style={aspectStyle(p(node, "aspect"))}>
      {kids}
    </div>
  ),
  grid: (node, kids) => (
    <div className={cn("grid", COLS[p(node, "cols") ?? "2"] ?? COLS["2"], g(node, "2"))}>{kids}</div>
  ),
  list: (node, kids) => <div className="flex flex-col divide-y divide-line-muted">{kids}</div>,

  appbar: (node) => (
    <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
      {p(node, "leading") && <Glyph name={p(node, "leading")} className="text-fg-muted" />}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{p(node, "title")}</span>
      {p(node, "trailing") &&
        (p(node, "trailing")!.toLowerCase() === "avatar" ? (
          <span className="grid h-7 w-7 place-items-center rounded-full border border-line bg-inset text-fg-subtle"><User className="h-4 w-4" strokeWidth={1.75} /></span>
        ) : (
          <Glyph name={p(node, "trailing")} className="text-fg-muted" />
        ))}
    </div>
  ),
  tabbar: (node) => {
    const items = Array.isArray(node.props?.items) ? (node.props!.items as WireframePropValue[]) : [];
    return (
      <div className="flex items-stretch justify-around border-t border-line px-1 py-1.5">
        {items.map((it, i) => {
          const o = it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, WireframePropValue>) : {};
          const active = o.active === true || o.active === "true";
          return (
            <div key={i} className={cn("flex flex-1 flex-col items-center gap-0.5 py-0.5", active ? "text-fg" : "text-fg-subtle")}>
              <Glyph name={str(o.icon)} className={active ? "text-fg" : "text-fg-subtle"} />
              {str(o.label) && <span className="text-[9px]">{str(o.label)}</span>}
            </div>
          );
        })}
      </div>
    );
  },
  listItem: (node) => (
    <div className="flex items-center gap-3 py-2.5">
      {p(node, "leading") &&
        (p(node, "leading")!.toLowerCase() === "avatar" ? (
          <span className={cn("grid shrink-0 place-items-center rounded-full border border-line bg-inset text-fg-subtle", AVATAR.sm)}><User className="h-3.5 w-3.5" strokeWidth={1.75} /></span>
        ) : (
          <Glyph name={p(node, "leading")} className="text-fg-muted" />
        ))}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{p(node, "title")}</span>
        {p(node, "subtitle") && <span className="block truncate text-[11px] text-fg-subtle">{p(node, "subtitle")}</span>}
      </span>
      {p(node, "trailing") && <span className="shrink-0 text-[11px] text-fg-subtle">{p(node, "trailing")}</span>}
    </div>
  ),
  text: (node) => {
    const variant = p(node, "variant") ?? "body";
    return <span className={cn(TEXT_VARIANT[variant] ?? TEXT_VARIANT.body, flag(node, "muted") && "text-fg-subtle")}>{p(node, "value")}</span>;
  },
  button: (node) => {
    const variant = p(node, "variant") ?? "primary";
    const cls =
      variant === "primary" ? "border-fg-muted bg-fg-muted/15 font-medium text-fg"
      : variant === "ghost" ? "border-transparent text-fg-muted"
      : "border-line text-fg-muted";
    return (
      <button type="button" disabled className={cn("inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-[12px]", flag(node, "full") && "w-full", cls)}>
        {p(node, "label") ?? "Button"}
      </button>
    );
  },
  input: (node) => (
    <div className="flex flex-col gap-1">
      {p(node, "label") && <span className={TEXT_VARIANT.caption}>{p(node, "label")}</span>}
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2 text-[12px] text-fg-subtle">
        {p(node, "icon") && <Glyph name={p(node, "icon")} className="text-fg-subtle" />}
        <span className="truncate">{p(node, "placeholder") ?? ""}</span>
      </div>
    </div>
  ),
  image: (node) => (
    <div
      className="relative grid place-items-center overflow-hidden rounded-md border border-dashed border-line bg-inset text-fg-subtle"
      style={aspectStyle(p(node, "aspect")) ?? { minHeight: 72 }}
    >
      {/* diagonal cross — the universal "image" low-fi mark */}
      <span aria-hidden className="pointer-events-none absolute inset-0" style={{ backgroundImage: "linear-gradient(to top right, transparent 49.5%, currentColor 49.5%, currentColor 50.5%, transparent 50.5%), linear-gradient(to bottom right, transparent 49.5%, currentColor 49.5%, currentColor 50.5%, transparent 50.5%)", opacity: 0.18 }} />
      <span className="z-10 flex flex-col items-center gap-0.5">
        <ImageIcon className="h-5 w-5" strokeWidth={1.5} />
        {p(node, "label") && <span className="px-1 text-center text-[10px]">{p(node, "label")}</span>}
      </span>
    </div>
  ),
  avatar: (node) => (
    <span className={cn("grid shrink-0 place-items-center rounded-full border border-line bg-inset text-fg-subtle", AVATAR[p(node, "size") ?? "md"] ?? AVATAR.md)}>
      <User className="h-1/2 w-1/2" strokeWidth={1.75} />
    </span>
  ),
  chip: (node) => {
    const accent = p(node, "tone") === "accent";
    return (
      <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px]", accent ? "border-accent/40 text-accent" : "border-line text-fg-subtle")}>
        {p(node, "label")}
      </span>
    );
  },
  icon: (node) => <Glyph name={p(node, "name")} className="text-fg-muted" />,
  divider: () => <div className="my-1 border-t border-line-muted" />,
  spacer: (node) => <div style={{ height: Math.min(64, Math.max(4, Number(p(node, "size") ?? 2) * 6)) }} />,
  placeholder: (node) => (
    <div className="grid place-items-center rounded-md border border-dashed border-line bg-inset px-2 py-3 text-center text-[11px] text-fg-subtle" style={{ minHeight: Number(p(node, "height")) || undefined }}>
      {p(node, "label") ?? "…"}
    </div>
  ),
};

function renderNode(node: WireframeNode, key: string): React.ReactNode {
  const kids = CONTAINER_TYPES.has(node.type)
    ? (node.children ?? []).map((c, i) => renderNode(c, `${key}.${i}`))
    : null;
  const render = RENDERERS[node.type] ?? RENDERERS.placeholder;
  return <Fragment key={key}>{render(node, kids)}</Fragment>;
}

/**
 * Render a coerced WireframeNode tree inside a low-fi device frame.
 * `viewport` sets the frame width (mobile 375 / desktop full). The tree itself is already bounded by
 * coerceNode, so this is safe to render untrusted LLM output.
 */
export function WireframeDSL({
  node,
  viewport = "mobile",
  className,
}: {
  node: WireframeNode;
  viewport?: "mobile" | "desktop";
  className?: string;
}) {
  return (
    <div className={cn("not-prose w-full", className)}>
      <div
        className={cn(
          "mx-auto overflow-hidden rounded-xl border border-line bg-bg shadow-sm",
          viewport === "mobile" ? "max-w-[375px]" : "max-w-full",
        )}
      >
        {renderNode(node, "0")}
      </div>
    </div>
  );
}
