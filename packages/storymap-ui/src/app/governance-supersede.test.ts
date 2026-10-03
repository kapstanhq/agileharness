// Um rascunho novo sobre as MESMAS seções substitui os pendentes mais velhos,
// e a substituição fica REGISTRADA nos dois lados (o velho sabe quem o substituiu; o novo sabe quem ele substitui).
// Antes os três rascunhos do PRD do board de produto ficavam pendentes lado a lado.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GovernanceDraft } from "@/lib/storymap/types";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storymap/runner/engine", () => ({ getRunnerEngine: vi.fn() }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: vi.fn() }));

let onDisk: GovernanceDraft[] = [];
vi.mock("@/lib/storymap/sidecars", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/sidecars")>();
  return {
    ...actual,
    listGovernanceDrafts: async () => onDisk.map((d) => ({ ...d })),
    readGovernanceDraft: async (_b: string, id: string) => onDisk.find((d) => d.id === id) ?? null,
    writeGovernanceDraft: async (_b: string, draft: GovernanceDraft) => {
      onDisk = [...onDisk.filter((d) => d.id !== draft.id), draft];
    },
  };
});

import { proposeChangeAction } from "./actions";

const old: GovernanceDraft = {
  id: "d-velho",
  board: "b",
  status: "pending",
  reason: "primeira versão",
  origin: null,
  changes: [{ artifact: "prd", field: "resumo", before: "", after: "v1" }],
  createdAt: "2026-09-23",
  decidedAt: null,
};

beforeEach(() => {
  onDisk = [{ ...old }];
});

describe("proposeChangeAction — o rascunho novo substitui o pendente que ele cobre (B8)", () => {
  it("o velho vira `rejected` com `supersededBy`; o novo registra `supersedes`", async () => {
    const res = await proposeChangeAction({
      boardId: "b",
      draftId: "d-novo",
      reason: "segunda versão",
      changes: [
        { artifact: "prd", field: "resumo", before: "", after: "v2" },
        { artifact: "prd", field: "problema", before: "", after: "p" },
      ],
    });
    expect(res.ok).toBe(true);
    const velho = onDisk.find((d) => d.id === "d-velho")!;
    expect(velho).toMatchObject({ status: "rejected", supersededBy: "d-novo" });
    expect(velho.decidedAt).toBeTruthy();
    expect(onDisk.find((d) => d.id === "d-novo")).toMatchObject({ status: "pending", supersedes: ["d-velho"] });
  });

  it("um rascunho que NÃO cobre o velho inteiro não o substitui", async () => {
    await proposeChangeAction({ boardId: "b", draftId: "d-outro", reason: "x", changes: [{ artifact: "prd", field: "glossario", before: "", after: "g" }] });
    expect(onDisk.find((d) => d.id === "d-velho")?.status).toBe("pending");
    expect(onDisk.find((d) => d.id === "d-outro")?.supersedes).toBeUndefined();
  });
});
