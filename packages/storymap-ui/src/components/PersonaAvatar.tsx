"use client";

import { cn } from "@/lib/cn";
import type { Persona } from "@/lib/storymap/types";

/** 1–2 letter monogram from a persona name ("operador" → "Op", "Bruno PM" → "BP"). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0]?.slice(0, 2) ?? "?").toUpperCase();
}

/**
 * Round actor token for a persona on the Story Map. Shows the persona's avatar image
 * (a Notion-style hand-drawn doodle, set in the persona panel) inside a white circle with
 * a thick border (matching the Notion-grade card language). With no avatar it falls back to
 * the persona's coloured initials — never an empty hole, so a freshly-created persona still
 * renders a token. `editable` adds a subtle hover ring so the panel can signal "click to set".
 */
export function PersonaAvatar({
  persona,
  size = 40,
  className,
  ring = false,
  shape = "circle",
  solid = false,
}: {
  persona: Pick<Persona, "name" | "color" | "avatar">;
  /** diameter (circle) / side (square) in px */
  size?: number;
  className?: string;
  /** hover ring affordance (used in the editor) */
  ring?: boolean;
  /** circle (default) — the Story Map actor pill uses `square` (Notion-style rounded chip). */
  shape?: "circle" | "square";
  /** solid persona-colour fill + white initials (the Story Map actor chip) instead of a tinted token. */
  solid?: boolean;
}) {
  const color = persona.color ?? "#9B9A93";
  const dim = { width: size, height: size };
  const base = cn(
    "inline-flex shrink-0 items-center justify-center overflow-hidden transition",
    shape === "square" ? "rounded-md" : "rounded-full",
    solid ? "" : cn("bg-surface", shape === "square" ? "border border-line" : "border-2 border-line"),
    ring && "hover:ring-2 hover:ring-accent/30",
    className,
  );

  if (persona.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={persona.avatar}
        alt={persona.name}
        title={persona.name}
        width={size}
        height={size}
        className={cn(base, "object-cover")}
        style={dim}
      />
    );
  }

  return (
    <span
      title={persona.name}
      className={base}
      style={solid ? { ...dim, backgroundColor: color, color: "#fff" } : { ...dim, backgroundColor: `${color}1f`, color }}
    >
      <span className="font-semibold leading-none" style={{ fontSize: Math.round(size * 0.36) }}>
        {initials(persona.name)}
      </span>
    </span>
  );
}
