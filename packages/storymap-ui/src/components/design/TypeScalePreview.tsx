"use client";

// 🟥 Style Guide (bloco de Design, WS-2) — renders the type SCALE as live samples (classes applied to
// sample text, per the WS-2 spec) rather than a bare table: the size/weight/tracking ride as inline
// style (declared values are DATA, per board — never a Tailwind class). Type-only import from
// style-guide.ts (see StyleSwatches.tsx's header note — never a runtime import in a client bundle).
import type { TypeLevel } from "@/lib/storymap/style-guide";

/** "32/48px" → the numeric px of the FIRST number (the size, not the line-height). */
function firstPx(size: string): number | undefined {
  const n = parseFloat(size);
  return Number.isFinite(n) ? n : undefined;
}

export function TypeScalePreview({ scale }: { scale: TypeLevel[] }) {
  if (scale.length === 0) {
    return <p className="text-[11.5px] italic text-fg-subtle">Nenhum nível de escala ainda.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {scale.map((lvl) => {
        const px = firstPx(lvl.size);
        return (
          <div key={lvl.id} className="flex items-baseline gap-2 border-b border-line-muted pb-1.5 last:border-0">
            <span
              className="min-w-0 truncate text-fg"
              style={{
                fontSize: px ? `${Math.min(px, 36)}px` : undefined,
                fontWeight: lvl.weight,
                letterSpacing: lvl.tracking,
              }}
            >
              Aa
            </span>
            <span className="shrink-0 font-mono text-[10px] text-fg-subtle">{lvl.id}</span>
            <span className="shrink-0 text-[10px] text-fg-subtle">
              {lvl.size} · {lvl.weight}
            </span>
            {lvl.rule && (
              <span className="min-w-0 flex-1 truncate text-[10px] text-fg-subtle" title={lvl.rule}>
                {lvl.rule}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
