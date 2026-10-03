// A PRÉ-CONDIÇÃO de aprovar uma proposta de governança, UMA só: a ação de
// aprovar recusa por ela, e o Inbox desabilita «Aprovar» com a mesma frase antes do clique.
//
// Antes o Inbox calculava só `governanceConflicts(draft, config)` — o conflito do `board.yaml`, que pula o PRD —, e
// `approveGovernanceDraftAction` também recusava o conflito de DOCUMENTO (o PRD/canvas em disco mudou desde a
// proposta). Um segundo rascunho pendente do PRD aparecia com «Aprovar» habilitado e falhava depois do clique.
//
// SERVER-ONLY (lê o documento em disco); os leitores são injetáveis para teste.

import { docIsCanonical, readGovernedValue } from "./doc/doc-governance";
import { governanceConflicts } from "./governance";
import type { BoardConfig, GovernanceChange, GovernanceDraft } from "./types";

export interface GovernanceCheckDeps {
  docIsCanonical(boardId: string, artifact: string): Promise<boolean>;
  readGovernedValue(boardId: string, artifact: string, field: string | null | undefined, config: BoardConfig): Promise<unknown>;
}

const defaultDeps: GovernanceCheckDeps = {
  docIsCanonical: (b, a) => docIsCanonical(b, a),
  readGovernedValue: (b, a, f, c) => readGovernedValue(b, a, f, c),
};

export interface GovernanceApprovalCheck {
  /** os rótulos em conflito (config + documento) — o que o Inbox mostra e o título conta. */
  conflicts: string[];
  /** a recusa que a ação de aprovar devolve, ou null quando aprovar passaria. */
  refusal: string | null;
  /** as mudanças canônicas num DOCUMENTO (gravadas por `applyGovernedChange`)… */
  paraDoc: GovernanceChange[];
  /** …e as canônicas no `board.yaml` (aplicadas pelo núcleo puro). */
  paraConfig: GovernanceChange[];
}

const labelOf = (c: GovernanceChange) => c.label ?? `${c.artifact}${c.field ? `.${c.field}` : ""}`;

/**
 * O que aprovar `draft` agora faria: onde cada mudança é canônica (a mesma pergunta que `loadDoc` responde ao LER) e
 * se o `before` da proposta ainda é o valor atual — no `board.yaml` e no documento. A ordem das recusas é a da ação:
 * o conflito de config primeiro.
 */
export async function checkGovernanceApproval(
  boardId: string,
  draft: GovernanceDraft,
  config: BoardConfig,
  deps: GovernanceCheckDeps = defaultDeps,
): Promise<GovernanceApprovalCheck> {
  const configConflicts = governanceConflicts(draft, config);
  const paraDoc: GovernanceChange[] = [];
  const paraConfig: GovernanceChange[] = [];
  for (const change of draft.changes) {
    ((await deps.docIsCanonical(boardId, change.artifact)) ? paraDoc : paraConfig).push(change);
  }
  const docConflicts: string[] = [];
  for (const change of paraDoc) {
    const atual = await deps.readGovernedValue(boardId, change.artifact, change.field, config);
    if (JSON.stringify(atual ?? "") !== JSON.stringify(change.before ?? "")) docConflicts.push(labelOf(change));
  }
  const refusal =
    configConflicts.length > 0
      ? `O valor canônico mudou desde a proposta (${configConflicts.join(", ")}). A proposta precisa ser refeita sobre o valor atual antes de aprovar.`
      : docConflicts.length > 0
        ? `O documento mudou desde a proposta (${docConflicts.join(", ")}). A proposta precisa ser refeita sobre o texto atual antes de aprovar.`
        : null;
  return { conflicts: [...configConflicts, ...docConflicts.filter((l) => !configConflicts.includes(l))], refusal, paraDoc, paraConfig };
}
