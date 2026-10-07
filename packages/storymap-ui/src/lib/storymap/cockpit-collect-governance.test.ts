// O item de governança do Inbox recebe a MESMA checagem que o servidor faz ao
// aprovar (config E documento). Medido: um segundo rascunho pendente do PRD aparecia com «Aprovar» habilitado — o
// conflito de documento só existia na ação, e a recusa chegava depois do clique.

import { describe, expect, it, vi } from "vitest";
import type { BoardConfig, GovernanceDraft } from "./types";

const draft: GovernanceDraft = {
  id: "d2",
  board: "b",
  status: "pending",
  reason: "segunda versão",
  origin: null,
  changes: [{ artifact: "prd", field: "propostaValor", label: "Proposta de valor", before: "texto de 23/09", after: "texto novo" }],
  createdAt: new Date().toISOString().slice(0, 10),
  decidedAt: null,
};
const config = { id: "b", name: "B", statuses: [], releases: [], personas: [], systems: [], linkTypes: [] } as unknown as BoardConfig;

vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("./repo")>()),
  getBoard: async () => ({ config, cards: [] }),
  readBoardConfig: async () => config,
}));
vi.mock("@/lib/storymap/doc/doc-governance", () => ({
  docIsCanonical: async (_b: string, artifact: string) => artifact === "prd",
  // o PRD em disco já tem OUTRO texto (uma proposta anterior foi aprovada)
  readGovernedValue: async () => "texto que a primeira proposta aprovou",
}));
vi.mock("@/lib/storymap/runner/telemetry", () => ({ getTelemetryStore: () => ({ boardSummary: async () => ({ cards: [] }) }) }));
vi.mock("@/lib/storymap/runner/registry", () => ({ getRunnerRegistry: () => ({ mergeQueueSnapshot: () => ({ entries: [] }) }) }));
vi.mock("@/lib/storymap/sidecars", () => ({ listGovernanceDrafts: async () => [draft], readProposal: async () => null, readWireframe: async () => null }));
vi.mock("@/lib/storymap/approvals", () => ({ listApprovalRequests: async () => [] }));
vi.mock("@/lib/storymap/runner/capacity-service", () => ({ getCapacityGovernor: () => ({ snapshot: () => ({}) }) }));

import { collectBoardCockpitItems } from "./cockpit-collect";

describe("collectBoardCockpitItems — governança com conflito de DOCUMENTO (B8)", () => {
  it("o item traz o conflito e a mesma recusa que a ação de aprovar devolveria", async () => {
    const items = await collectBoardCockpitItems("b");
    const gov = items.find((i) => i.kind === "governance");
    expect(gov).toMatchObject({ kind: "governance", conflicts: ["Proposta de valor"] });
    expect(gov && gov.kind === "governance" && gov.conflictMessage).toMatch(/O documento mudou desde a proposta/);
  });
});
