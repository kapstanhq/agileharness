// A CONTAGEM do teto (review-rounds-deps.ts) contra um agente que apaga ou um board que não se lê (M2):
//   · um conserto na LIXEIRA continua contando na árvore;
//   · um board ilegível não conta a menos: a pergunta vai ao dono (uma só) e nada nasce.
// Disco falso; fixtures inventadas (uma oficina de bicicletas).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";

let cards: Card[] = [];
let trashed: Card[] = [];
let failBoard = false;
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("../repo")>();
  return {
    ...actual,
    listBoards: async () => [{ id: "oficina", name: "Oficina" }],
    readCards: async () => {
      if (failBoard) throw new Error("EIO");
      return cards;
    },
    readTrashedCards: async () => trashed,
    readCard: async (_b: string, id: string) => cards.find((c) => c.id === id) ?? null,
  };
});

import { coerceCard } from "@/lib/storymap/repo";
import { readAllBoardCards, reviewRoundsGate } from "./review-rounds-deps";

const card = (id: string, over: Partial<Card> = {}): Card => ({ ...coerceCard(id, { type: "story", title: `Freios ${id}` }, ""), labels: [], links: [], ...over }) as Card;

beforeEach(() => {
  cards = [card("story-ex7401")];
  trashed = [];
  failBoard = false;
});

describe("contagem do teto", () => {
  it("a LIXEIRA conta: apagar um conserto não abre uma rodada a mais", async () => {
    trashed = [card("story-ex7402", { reviewChain: { root: "oficina/story-ex7401", round: 2 } } as Partial<Card>)];
    expect((await readAllBoardCards()).map((x) => x.card.id)).toEqual(["story-ex7401", "story-ex7402"]);
    const ask = vi.fn(async () => {});
    const r = await reviewRoundsGate("oficina", "story-ex7401", "a pinça raspa", 2, ask, undefined, { answers: async () => [] });
    expect(r.gate).toBe("asked");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("board ILEGÍVEL ⇒ pergunta ao dono (não conta a menos) e nada nasce", async () => {
    failBoard = true;
    const ask = vi.fn(async () => {});
    const r = await reviewRoundsGate("oficina", "story-ex7401", "a pinça raspa", 2, ask, undefined, { answers: async () => [] });
    expect(r).toEqual({ gate: "asked", mark: null });
    expect(ask).toHaveBeenCalledTimes(1);
    expect((ask.mock.calls[0] as unknown[])[2]).toMatchObject({ text: expect.stringMatching(/não consegui conferir/) });
  });

  it("board ilegível com a pergunta do teto JÁ aberta no card ⇒ não pergunta de novo", async () => {
    failBoard = true;
    const open = card("story-ex7401", {
      questions: [{ id: "q1", text: "Teto de rodadas de revisão: … Como seguir?", status: "open" }],
    } as Partial<Card>);
    const ask = vi.fn(async () => {});
    const r = await reviewRoundsGate("oficina", "story-ex7401", "x", 2, ask, undefined, { answers: async () => [], readOne: async () => open });
    expect(r.gate).toBe("asked");
    expect(ask).not.toHaveBeenCalled();
  });
});
