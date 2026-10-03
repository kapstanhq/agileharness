import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { coerceTargetProfileDetailed } from "@/lib/storymap/target-profile";

// As telas do cliente (o documento do card) não recebem o settings: perguntam ao servidor o nome humano das lentes de
// revisão do alvo. Alvo INVENTADO (oficina de bicicletas) declarando uma lente de domínio e renomeando uma embutida.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/action-guard", () => ({ requireSession: async () => ({}) }));

let target: ReturnType<typeof coerceTargetProfileDetailed>["profile"] = undefined;
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/config")>();
  return { ...actual, loadRunnerConfig: () => ({ autorun: { enabled: false }, target }) };
});

import { getReviewLensNamesAction } from "./actions";

beforeEach(() => {
  target = undefined;
});

describe("getReviewLensNamesAction", () => {
  it("sem perfil declarado: só as lentes embutidas, com os nomes de fábrica", async () => {
    const r = await getReviewLensNamesAction();
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r.data?.lensNames ?? {}).sort()).toEqual(["design", "general", "perf", "security", "testing"]);
  });

  it("com perfil: as declaradas entram e a sobrescrita da embutida vale", async () => {
    target = coerceTargetProfileDetailed({ reviewLenses: { freios: { name: "Freios e pinças", description: "folga de cabo" }, security: { name: "Segurança da oficina" } } }).profile;
    const r = await getReviewLensNamesAction();
    expect(r.ok && r.data?.lensNames).toMatchObject({ freios: "Freios e pinças", security: "Segurança da oficina" });
  });
});

describe("CardDocument mostra a lente pelo nome do alvo, não pelo id cru", () => {
  const src = readFileSync(new URL("../components/CardDocument.tsx", import.meta.url), "utf8");
  it("busca os nomes no servidor, passa-os às linhas e usa lensLabel", () => {
    expect(src).toContain("getReviewLensNamesAction()");
    expect(src).toMatch(/lensLabel\(finding\.lens, lensNames\)/);
    expect(src).not.toMatch(/·\s*\{finding\.lens\}/);
  });
});
