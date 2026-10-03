import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card } from "@/lib/storymap/types";

// A decisão do SISTEMA que a ação persiste («Aceitou o aumento de custo… (+X/mês)») fala a moeda do veredito, não um
// símbolo fixo. Para BRL o texto é o de sempre, byte a byte; para outra moeda sai o símbolo dela. Sobre store em memória,
// com board/card INVENTADOS (oficina de bicicletas / livraria).

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/action-guard", () => ({ requireSession: async () => ({}) }));

let config: Pick<BoardConfig, "autonomy">;
let cardOnDisk: Card;
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readBoardConfig: async () => config, readCard: async () => cardOnDisk };
});
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    updateCardOnDisk: async (_b: string, _id: string, mutate: (c: Card) => Card | null) => {
      const next = mutate(cardOnDisk);
      if (next) cardOnDisk = next;
      return next;
    },
  };
});
const decisions: Array<{ what: string; why: string; kind: string }> = [];
vi.mock("@/lib/storymap/runner/decision-log", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/decision-log")>();
  return { ...actual, appendSystemDecision: async (e: { what: string; why: string; kind: string }) => void decisions.push(e) };
});

import { recordCostImpactAction } from "./actions";

const mk = (): Card => ({ id: "story-ex9984", type: "story", title: "Vitrine de peças", parent: null, links: [] }) as unknown as Card;

beforeEach(() => {
  decisions.length = 0;
  cardOnDisk = mk();
});

describe("recordCostImpactAction — o texto persistido da decisão do sistema", () => {
  it("BRL (chamada legada, só monthlyBRL): «+R$20/mês», byte a byte como sempre", async () => {
    config = { autonomy: { mode: "ultra", budget: { infraMonthlyBRL: 75 } } } as Pick<BoardConfig, "autonomy">;
    const r = await recordCostImpactAction({ boardId: "oficina", cardId: "story-ex9984", impact: { monthlyBRL: 20, scope: "infra", assumptions: "uma instância a mais" } });
    expect(r.ok && r.data?.verdict.owner).toBe(false);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].what).toBe("Aceitou o aumento de custo de «Vitrine de peças» (+R$20/mês)");
  });

  it("outra moeda (entrada neutra em USD): o símbolo é o da moeda do veredito, nunca R$", async () => {
    config = { autonomy: { mode: "ultra", budget: { currency: "USD", infraMonthly: 75 } } } as Pick<BoardConfig, "autonomy">;
    const r = await recordCostImpactAction({
      boardId: "livraria",
      cardId: "story-ex9984",
      impact: { monthlyAmount: 20, scope: "infra", assumptions: "uma instância a mais", currency: { code: "USD", locale: "en-US" } },
    });
    expect(r.ok && r.data?.verdict.owner).toBe(false);
    expect(decisions[0].what).toBe("Aceitou o aumento de custo de «Vitrine de peças» (+$20/mês)");
    expect(decisions[0].what).not.toContain("R$");
  });
});
