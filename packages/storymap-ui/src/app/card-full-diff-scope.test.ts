import { beforeEach, describe, expect, it, vi } from "vitest";

// O diff completo do card (getCardFullDiffAction) precisa levar ao diff.ts o escopo DECLARADO do alvo (branch de
// integração + prefixos de código): diff.ts é puro e não lê config, então sem o escopo ele cai no branch/pathspec
// neutros e o diff de código do card some/encolhe num alvo que declara os seus. Settings INVENTADO (oficina de bicicletas).

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/action-guard", () => ({ requireSession: async () => ({}) }));

const staging: { branch?: string; codePrefixes?: string[]; declared?: { branch?: boolean; codePrefixes?: boolean } } = {};
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/config")>();
  return { ...actual, loadRunnerConfig: () => ({ autorun: { enabled: false, staging } }) };
});

const cumulative = vi.fn(async () => ({ board: null, code: null }));
vi.mock("@/lib/storymap/runner/diff", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/diff")>();
  return { ...actual, cardCumulativeDiff: (...a: unknown[]) => (cumulative as unknown as (...x: unknown[]) => unknown)(...a) };
});

import { getCardFullDiffAction } from "./actions";

beforeEach(() => {
  cumulative.mockClear();
  for (const k of Object.keys(staging)) delete (staging as Record<string, unknown>)[k];
});

const scopeOfLastCall = () => (cumulative.mock.calls[0] as unknown as unknown[])[3];

describe("getCardFullDiffAction — passa o escopo declarado ao diff do card", () => {
  it("alvo que DECLARA branch e prefixos: o diff recebe exatamente esses", async () => {
    Object.assign(staging, { branch: "integracao", codePrefixes: ["oficina/", "pecas/"], declared: { branch: true, codePrefixes: true } });
    const r = await getCardFullDiffAction({ board: "oficina", cardId: "story-ex9983" });
    expect(r.ok).toBe(true);
    expect(scopeOfLastCall()).toEqual({ stageBranch: "integracao", codePrefixes: ["oficina/", "pecas/"] });
  });

  it("alvo que NÃO declara prefixos: o escopo leva `undefined` (tudo fora de storymap/boards/), nunca o default preenchido", async () => {
    Object.assign(staging, { branch: "stage", codePrefixes: ["packages/"], declared: { branch: false, codePrefixes: false } });
    await getCardFullDiffAction({ board: "oficina", cardId: "story-ex9983" });
    expect(scopeOfLastCall()).toEqual({ stageBranch: "stage", codePrefixes: undefined });
  });
});
