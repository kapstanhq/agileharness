import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card } from "@/lib/storymap/types";

// «Fazer antes» / «Pode esperar» — a ORDEM DO TRABALHO é a posição na coluna. A action grava só o `order` do card
// movido (pelo mesmo caminho de um arrastar: moveCardAction sem status), relativo à COLUNA do Kanban — a raia inteira
// quando o board declara raias.

vi.mock("@/lib/auth/action-guard", () => ({ requireSession: async () => "operator-session" }));

const lanesBoard = {
  id: "b",
  name: "B",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "pronta", name: "A fazer" },
    { id: "desenvolver", name: "Desenvolver" },
  ],
  view: {
    lanes: [
      { id: "triagem", label: "Triagem", statuses: ["triage", "pronta"] },
      { id: "construindo", label: "Construindo", statuses: ["desenvolver"] },
    ],
  },
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
} as unknown as BoardConfig;
let board: BoardConfig = lanesBoard;

let cards: Card[] = [];
const moves: Array<{ cardId: string; order?: number; status?: string | null }> = [];

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readBoardConfig: async () => board, readCards: async () => cards };
});

// O arquivo do card, num diretório temporário: a action devolve a hora do arquivo depois de gravar a posição.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ah-card-order-"));
const fileOf = (cardId: string) => path.join(tmpDir, `${cardId}.md`);
vi.mock("@/lib/storymap/paths", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/paths")>();
  return { ...actual, cardPath: (_board: string, cardId: string) => fileOf(cardId) };
});

vi.mock("./actions", () => ({
  moveCardAction: async (input: { cardId: string; order?: number; status?: string | null }) => {
    moves.push({ cardId: input.cardId, order: input.order, status: input.status });
    if (existsSync(fileOf(input.cardId))) writeFileSync(fileOf(input.cardId), `order: ${input.order}\n`); // a escrita real toca a hora
    return { ok: true, data: {} };
  },
}));

import { placeCardInColumnAction } from "./card-order-actions";
import { coerceCard } from "@/lib/storymap/repo";

const c = (id: string, status: string, order: number) => coerceCard(id, { type: "story", status, order }, "");

describe("placeCardInColumnAction — «Fazer antes» / «Pode esperar»", () => {
  beforeEach(() => {
    moves.length = 0;
    board = lanesBoard;
    cards = [c("story-ex9101", "pronta", 10), c("story-ex9102", "pronta", 20), c("story-ex9103", "triage", -30), c("story-ex9104", "desenvolver", -500)];
  });

  it("«Fazer antes» põe o card no topo da RAIA (todas as colunas dela), gravando só o order — sem status", async () => {
    const r = await placeCardInColumnAction({ boardId: "b", cardId: "story-ex9102", where: "top" });
    expect(r).toEqual({ ok: true, data: { order: -40, changed: true } });
    expect(moves).toEqual([{ cardId: "story-ex9102", order: -40, status: undefined }]);
  });

  it("«Pode esperar» põe o card no fim da raia", async () => {
    const r = await placeCardInColumnAction({ boardId: "b", cardId: "story-ex9103", where: "bottom" });
    expect(r).toEqual({ ok: true, data: { order: 30, changed: true } });
  });

  it("já está lá ⇒ nada é gravado", async () => {
    const r = await placeCardInColumnAction({ boardId: "b", cardId: "story-ex9103", where: "top" });
    expect(r).toEqual({ ok: true, data: { order: -30, changed: false } });
    expect(moves).toEqual([]);
  });

  it("outra raia não conta: sozinho na coluna, não há posição a mudar", async () => {
    const r = await placeCardInColumnAction({ boardId: "b", cardId: "story-ex9104", where: "top" });
    expect(r).toEqual({ ok: true, data: { order: -500, changed: false } });
  });

  it("posição inválida e card inexistente são recusados com o motivo", async () => {
    expect(await placeCardInColumnAction({ boardId: "b", cardId: "story-ex9101", where: "meio" as never })).toMatchObject({ ok: false });
    expect(await placeCardInColumnAction({ boardId: "b", cardId: "story-ex9999", where: "top" })).toMatchObject({ ok: false, error: expect.stringMatching(/não encontrado/) });
  });

  // A coluna é a que o Kanban DESENHA (kanbanColumnStatusesOf): num board sem raias declaradas, as raias derivadas do
  // pipeline — antes a action comparava só com o mesmo status e respondia «já está no topo» para um card que o dono via
  // no meio da coluna.
  it("board sem raias declaradas: a coluna é a raia derivada que o Kanban mostra, não só o status", async () => {
    board = { ...lanesBoard, view: undefined } as unknown as BoardConfig;
    const { kanbanColumnStatusesOf } = await import("@/lib/storymap/kanban-features");
    const column = kanbanColumnStatusesOf(board, "pronta");
    expect(column.length).toBeGreaterThan(1);
    const r = await placeCardInColumnAction({ boardId: "b", cardId: "story-ex9102", where: "top" });
    const others = cards.filter((x) => x.id !== "story-ex9102" && column.includes(x.status as string)).map((x) => x.order);
    expect(r).toEqual({ ok: true, data: { order: Math.min(...others) - 10, changed: true } });
    expect(Math.min(...others)).toBeLessThan(10); // havia na coluna um card de outro status mais acima
  });

  // Mudar a vez não é atividade: a hora do arquivo (o «há quanto tempo» do Kanban) continua a de antes.
  it("«Fazer antes» não faz o card parecer recém-mexido: a hora do arquivo volta à de antes", async () => {
    const old = new Date("2026-09-01T10:00:00Z");
    writeFileSync(fileOf("story-ex9102"), "order: 20\n");
    utimesSync(fileOf("story-ex9102"), old, old);
    const r = await placeCardInColumnAction({ boardId: "b", cardId: "story-ex9102", where: "top" });
    expect(r).toMatchObject({ ok: true, data: { changed: true } });
    expect(statSync(fileOf("story-ex9102")).mtimeMs).toBe(old.getTime());
  });
});
