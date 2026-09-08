// WS-9 (D15) — the STRUCTURED capture never MINTS an idea.
//
// Decisão de produto do Operador (2026-07-16, ver docs/adr/ADR-064): quando o capturador já sabe o que
// precisa ser feito, a ideia (◆) é cerimônia — nas 2 opps geradas no incidente de 07-15 nenhuma
// exercitou candidateSolutions/sizing/rastreabilidade; cada uma foi direto a "Gerar stories" 1:1. Então a
// captura estruturada (harness-capture / o modal / usm_capture MCP) NÃO classifica mais como
// `type:"idea"` — bug/technical/chore/user story, direto. `idea` fica reservada à bancada
// (create_idea / a view de Ideias), o ponto de entrada leve e deliberado.
//
// O prompt de classificação já não oferece o caminho ◆, mas o prompt é HEURÍSTICO e sidecars de proposta
// LEGADOS ainda carregam itens ◆. Por isso o cinto-e-suspensório mora AQUI, no chokepoint de escrita
// (commitProposalAction): um item `type:"idea"` é IGNORADO (nunca materializa card) com um warning
// apontando a bancada. NUNCA lança sobre um ◆ legado — só o materializar é barrado (o parse dele continua).

import type { CardCommitWarning } from "../types";
import type { ProposedItem } from "./types";

export interface IdeaGuardResult {
  /** the items that DO materialize into cards — ◆ ideas removed, and any story `addresses` pointing
   *  at an in-batch ◆ (which will never be minted) cleared so it can't hang the readiness loop. */
  items: ProposedItem[];
  /** one `idea-ignored` warning per barred ◆ (cardId is always absent — nothing was minted). */
  warnings: CardCommitWarning[];
}

/**
 * Split a proposal's items into the ones to materialize and the ◆ ideas to IGNORE. Pure/testable.
 * Belt-and-suspenders for the accept chokepoint: capture never creates ideas (WS-9). Legacy ◆ items
 * (from an older sidecar) are dropped with a warning, never thrown on; a story that declared `addresses` to
 * such an in-batch ◆ loses that edge (the target can't resolve once the ◆ is barred).
 */
export function guardCaptureIdeas(items: ProposedItem[]): IdeaGuardResult {
  const ignoredTempIds = new Set(items.filter((it) => it.type === "idea").map((it) => it.tempId));
  if (ignoredTempIds.size === 0) return { items, warnings: [] };

  const warnings: CardCommitWarning[] = items
    .filter((it) => it.type === "idea")
    .map((it) => ({
      tempId: it.tempId,
      code: "idea-ignored" as const,
      detail:
        "item ignorado: a captura não cria ideias — registre esta dor na bancada de Ideias",
    }));

  const kept = items
    .filter((it) => it.type !== "idea")
    .map((it) => (it.addresses && ignoredTempIds.has(it.addresses) ? { ...it, addresses: null } : it));

  return { items: kept, warnings };
}
