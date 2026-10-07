"use client";

// 🟥 Style Guide (bloco de Design, WS-2) — a thin presentational grid of colour-role swatches. The
// colour VALUES are DATA (per board), so they ride as inline `style` — never a Tailwind class (the
// scanner can't generate a computed class from board data; Tailwind scans source text only).
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

/**
 * The colour-role swatches — 2 columns on a phone, 4 from `sm`. EVERY swatch reads the same way: the sample, the role
 * and a TEXT badge — the AA level when the token declares the text colour on top of it (`on`), else «sem par de
 * texto» (a background or a line has nothing to measure; a blank where the others carry a badge read as missing data).
 */
export function StyleSwatches({ tokens, aa }: { tokens: ColorToken[]; aa?: AAReport }) {
  if (tokens.length === 0) {
    return <p className="text-[13px] italic text-fg-subtle">Nenhum papel de cor ainda.</p>;
  }
  const byRole = new Map((aa?.pairs ?? []).map((p) => [p.role, p] as const));
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tokens.map((t) => {
        const pair = byRole.get(t.role);
        return (
          <div key={t.role} className="flex min-w-0 flex-col gap-1 rounded-lg border border-line-muted p-1.5">
            <div
              className="flex h-10 items-center justify-center rounded-md border border-line-muted text-[13px] font-medium"
              style={{ backgroundColor: t.value, color: t.on || undefined }}
              title={`${t.role}: ${t.value}${t.on ? ` sobre ${t.on}` : ""}`}
            >
              {t.on ? "Aa" : ""}
            </div>
            <span className="truncate text-[12px] font-semibold text-fg" title={t.role}>
              {t.role}
            </span>
            {pair ? (
              <span
                title={`contraste ${pair.ratio.toFixed(2)}:1`}
                className={cn(
                  "inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[12px] font-semibold",
                  AA_BADGE_CLS[pair.level],
                )}
              >
                {AA_BADGE_LABEL[pair.level]}
              </span>
            ) : (
              <span className="inline-flex w-fit items-center rounded bg-inset px-1.5 py-0.5 text-[12px] text-fg-muted">
                sem par de texto
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
