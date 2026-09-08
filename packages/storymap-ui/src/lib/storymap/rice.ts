// rice.ts — typed barrel. riceScore now lives in gate-core.js (the isomorphic single-source
// shared verbatim with the pre-write hook), so the gate's RICE math and the app's RICE math can
// never drift. This preserves the `from "./rice"` / `from "@/lib/storymap/rice"` import path for
// the ~10 consumers (badges, prioritization view, watcher…). See B4 / ADR-057.
export { riceScore } from "./gate-core";

/**
 * A NOTA de RICE em texto (≤1 decimal, separador de milhar pt-BR). Vive aqui, ao lado do cálculo,
 * porque era a MESMA função escrita três vezes — em `RiceBadge.tsx` (React), em `card-document.ts` e em
 * `step-rollup.ts`, as duas últimas com um comentário admitindo "mirrors RiceBadge". Três cópias de uma
 * formatação de número é uma piada até o dia em que uma delas muda de casas decimais e duas telas
 * passam a discordar sobre o mesmo card. Pura e sem React — de propósito, para que os módulos de
 * servidor possam importá-la (foi o que motivou as cópias em primeiro lugar).
 */
export function formatRiceScore(score: number | null): string | null {
  if (score == null) return null;
  const rounded = Math.round(score * 10) / 10;
  return rounded.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}
