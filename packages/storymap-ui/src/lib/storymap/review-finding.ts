// review-finding — o que conta como ACHADO DE REVISÃO (o que abre e mantém uma cadeia de conserto). Mora sozinho para
// que o teto de rodadas (runner/review-rounds.ts) e o merge do card vindo de um run (card-merge.ts) usem a MESMA régua
// sem um importar o outro. PURO.

import type { Card } from "./types";

/** Achado de uma lente de revisão (não a geral) com severidade que pede conserto: blocker, high ou medium. PURA. */
export function isReviewFinding(f: NonNullable<Card["findings"]>[number]): boolean {
  return f.lens !== "general" && (f.severity === "blocker" || f.severity === "high" || f.severity === "medium");
}
