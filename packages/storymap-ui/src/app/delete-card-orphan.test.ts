import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";

// A deleção não pode fabricar card fora da hierarquia. Antes, apagar um backbone node re-orfanava os
// filhos (parent → null) e carimbava um ack sistêmico para o lint não ficar vermelho — ou seja, a própria
// deleção produzia a dívida. Agora ela RECUSA enquanto alguém depender do node. Sobre store em memória.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let store: Card[] = [];
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readCards: async () => store.map((c) => ({ ...c })) };
});
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    deleteCardFile: async (_b: string, id: string) => {
      store = store.filter((c) => c.id !== id);
    },
    updateCardOnDisk: async (_b: string, id: string, mutate: (c: Card) => Card | null) => {
      const idx = store.findIndex((c) => c.id === id);
      if (idx < 0) return null;
      const next = mutate({ ...store[idx] });
      if (next) store[idx] = next;
      return next;
    },
  };
});
vi.mock("@/lib/storymap/smart-capture/proposal", () => ({ deleteProposal: async () => {} }));
vi.mock("@/lib/storymap/runner/engine", () => ({ getRunnerEngine: vi.fn() }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: vi.fn() }));

import { deleteCardAction } from "@/app/actions";

const mk = (over: Partial<Card>): Card => ({ id: "x", type: "story", title: "t", parent: null, links: [], ...over } as Card);

beforeEach(() => {
  store = [];
});

describe("deleteCardAction — a hierarquia não se apaga por baixo", () => {
  it("RECUSA apagar um node que ancora outros cards, e não toca em nada", async () => {
    store = [
      mk({ id: "step-1", type: "step" }),
      mk({ id: "story-a", type: "story", parent: "step-1" }),
      mk({ id: "story-b", type: "story", parent: "step-1" }),
      mk({ id: "story-c", type: "story", parent: "other-step" }), // não depende deste
    ];
    const r = await deleteCardAction({ boardId: "b", cardId: "step-1" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/2 card\(s\) vivem ancorados/);
    // e a deleção é ATÔMICA no sentido que importa: nada foi apagado nem re-parenteado
    expect(store.map((c) => c.id).sort()).toEqual(["step-1", "story-a", "story-b", "story-c"]);
    expect(store.find((c) => c.id === "story-a")?.parent).toBe("step-1");
  });

  it("conta também quem depende por `serves` (o eixo dual-track), não só por `parent`", async () => {
    store = [
      mk({ id: "story-base", type: "story" }),
      mk({ id: "story-entrega", type: "story", storyType: "technical", serves: "story-base" }),
    ];
    const r = await deleteCardAction({ boardId: "b", cardId: "story-base" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/1 card\(s\) vivem ancorados/);
  });

  it("apaga quando ninguém depende — e limpa os LINKS laterais, que não são ancoragem", async () => {
    store = [
      mk({ id: "story-alvo", type: "story", parent: "step-1" }),
      mk({ id: "story-vizinha", type: "story", parent: "step-1", links: [{ rel: "relates-to", to: "story-alvo" }] }),
    ];
    const r = await deleteCardAction({ boardId: "b", cardId: "story-alvo" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data?.unlinked).toEqual(["story-vizinha"]);
    expect(store.find((c) => c.id === "story-vizinha")?.links).toEqual([]);
  });

  it("INVARIANTE: nenhuma deleção consegue produzir um card sem âncora", async () => {
    store = [
      mk({ id: "step-1", type: "step" }),
      mk({ id: "story-a", type: "story", parent: "step-1" }),
      mk({ id: "story-b", type: "story", parent: "step-1" }),
    ];
    await deleteCardAction({ boardId: "b", cardId: "step-1" });
    const semAncora = store.filter((c) => c.type === "story" && c.parent == null && c.serves == null);
    expect(semAncora).toEqual([]);
  });
});
