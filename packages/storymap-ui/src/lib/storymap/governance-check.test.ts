// A pré-checagem do Inbox para «Aprovar» uma proposta de governança só olhava o
// conflito de CONFIG (`governanceConflicts`, que pula o PRD); o servidor também recusa o conflito de DOCUMENTO. Um
// segundo rascunho pendente do PRD mostrava «Aprovar» habilitado — e falhava depois do clique. Uma checagem só,
// chamada pelo Inbox e pela ação.

import { describe, expect, it } from "vitest";
import { checkGovernanceApproval, type GovernanceCheckDeps } from "./governance-check";
import type { BoardConfig, GovernanceDraft } from "./types";

const config = { id: "b", name: "B", statuses: [], desiredOutcome: "atual" } as unknown as BoardConfig;
const draft = (changes: GovernanceDraft["changes"]): GovernanceDraft => ({
  id: "d1", board: "b", status: "pending", reason: "r", origin: null, changes, createdAt: "2026-09-25", decidedAt: null,
});
const deps = (docNow: Record<string, string>): GovernanceCheckDeps => ({
  docIsCanonical: async (_b, artifact) => artifact === "prd",
  readGovernedValue: async (_b, _a, field) => docNow[field ?? ""] ?? "",
});

describe("checkGovernanceApproval — a MESMA régua do servidor, para o Inbox e para a ação", () => {
  it("o documento mudou desde a proposta ⇒ conflito + a recusa que a ação devolveria", async () => {
    const d = draft([{ artifact: "prd", field: "resumo", label: "Resumo", before: "texto antigo", after: "novo" }]);
    const r = await checkGovernanceApproval("b", d, config, deps({ resumo: "texto que outra proposta aprovou" }));
    expect(r.conflicts).toEqual(["Resumo"]);
    expect(r.refusal).toMatch(/O documento mudou desde a proposta \(Resumo\)/);
  });

  it("o valor canônico do board.yaml mudou ⇒ conflito de config, a recusa de sempre", async () => {
    const d = draft([{ artifact: "desiredOutcome", field: null, before: "antigo", after: "novo" }]);
    const r = await checkGovernanceApproval("b", d, config, deps({}));
    expect(r.conflicts.length).toBe(1);
    expect(r.refusal).toMatch(/O valor canônico mudou desde a proposta/);
  });

  it("nada mudou ⇒ sem conflito, sem recusa; as mudanças saem separadas entre documento e config", async () => {
    const d = draft([
      { artifact: "prd", field: "resumo", label: "Resumo", before: "igual", after: "novo" },
      { artifact: "desiredOutcome", field: null, before: "atual", after: "novo" },
    ]);
    const r = await checkGovernanceApproval("b", d, config, deps({ resumo: "igual" }));
    expect(r).toMatchObject({ conflicts: [], refusal: null });
    expect(r.paraDoc.map((c) => c.artifact)).toEqual(["prd"]);
    expect(r.paraConfig.map((c) => c.artifact)).toEqual(["desiredOutcome"]);
  });
});
