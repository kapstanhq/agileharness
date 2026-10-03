"use client";

// 🟥 Style Guide (bloco de Design, WS-2) — a thin presentational grid of colour-role swatches. The
// colour VALUES are DATA (per board), so they ride as inline `style` — never a Tailwind class (the
// scanner can't generate a computed class from board data; canonical comment `canvas-blocks.ts:30-39`).
// AA badges carry TEXT (never colour-only, accessibility of the view itself) and read an AAReport that
// was ALREADY computed server-side (checkAA) — this component never recomputes contrast.
//
// Type-only import from style-guide.ts on purpose (see derive-estilo-state.ts's header note): that
// module pulls in `node:crypto` at runtime, which must never enter a "use client" bundle.
import { cn } from "@/lib/cn";
import type { AAReport, ColorToken } from "@/lib/storymap/style-guide";

type AALevel = AAReport["pairs"][number]["level"];

const AA_BADGE_CLS: Record<AALevel, string> = {
  AA: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "AA-large": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  fail: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

const AA_BADGE_LABEL: Record<AALevel, string> = {
  AA: "AA",
  "AA-large": "AA large",
  fail: "falha AA",
};

/** A 4-column grid of colour-role swatches (mobile 375px included — spec calls for 4-col there too). */
export function StyleSwatches({ tokens, aa }: { tokens: ColorToken[]; aa?: AAReport }) {
  if (tokens.length === 0) {
    return <p className="text-[11.5px] italic text-fg-subtle">Nenhum papel de cor ainda.</p>;
  }
  const byRole = new Map((aa?.pairs ?? []).map((p) => [p.role, p] as const));
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {tokens.map((t) => {
        const pair = byRole.get(t.role);
        return (
          <div key={t.role} className="flex min-w-0 flex-col gap-1 rounded-lg border border-line-muted p-1.5">
            <div
              className="flex h-9 items-center justify-center rounded-md text-[11px] font-medium"
              style={{ backgroundColor: t.value, color: t.on || undefined }}
              title={`${t.role}: ${t.value}${t.on ? ` sobre ${t.on}` : ""}`}
            >
              {t.on ? "Aa" : ""}
            </div>
            <span className="truncate text-[10.5px] font-semibold text-fg" title={t.role}>
              {t.role}
            </span>
            {pair && (
              <span
                title={`contraste ${pair.ratio.toFixed(2)}:1`}
                className={cn(
                  "inline-flex w-fit items-center rounded px-1 py-0.5 text-[9px] font-semibold",
                  AA_BADGE_CLS[pair.level],
                )}
              >
                {AA_BADGE_LABEL[pair.level]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
