// Toda escrita de CARD agenda o versionamento do board-data (flush debounced com teto).
//
// Card é board-data, e era o ÚNICO tipo de escrita que não agendava o flush — config, sidecars e lixeira agendam. Resultado
// medido: cards sujos no checkout de runtime por horas, porque o serviço só os versionava incidentalmente quando
// um run ou o merge train passava por um limite — e a automação estava retida. Fora do versionamento, o estado vivo do
// board (status, findings, carimbos de deploy) existe só no disco de uma máquina: nada nas outras cópias, nada no git.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { flush, state } = vi.hoisted(() => ({
  flush: vi.fn(),
  state: { cardsDir: "", card: null as unknown },
}));

vi.mock("./runner/board-data-flush", () => ({ scheduleBoardDataFlush: flush }));
vi.mock("./atomic-write", () => ({ atomicWriteFile: vi.fn(async () => {}) }));
vi.mock("./paths", async (orig) => {
  const actual = await orig<typeof import("./paths")>();
  return { ...actual, cardsDir: () => state.cardsDir, cardPath: (_b: string, id: string) => path.join(state.cardsDir, `${id}.md`) };
});
vi.mock("./repo", () => ({
  // sem config: o alarme de colocação segue (não derruba a escrita)
  readBoardConfig: vi.fn(async () => {
    throw new Error("sem board");
  }),
  readCard: vi.fn(async () => state.card),
  deriveBoardConfigForPersist: vi.fn(),
}));

import { updateCardOnDisk, writeCard } from "./write";
import type { Card } from "./types";

const card = (over: Partial<Card> = {}): Card => ({ id: "story-x", type: "story", title: "T", status: "desenvolver", ...over }) as Card;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "card-write-flush-"));
  state.cardsDir = path.join(dir, "cards");
  state.card = card();
  flush.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("toda escrita de card agenda o versionamento do board-data", () => {
  it("writeCard (o salvar do drawer) agenda o flush", async () => {
    await writeCard("b", card({ title: "novo" }));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("updateCardOnDisk (forward, revert, settle, MCP update_card…) agenda o flush", async () => {
    await updateCardOnDisk("b", "story-x", (c) => ({ ...c, status: "release" }));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("[NÃO-VACUIDADE] uma mutação que desiste (null) NÃO escreve, e portanto NÃO agenda — o flush não gira à toa", async () => {
    const r = await updateCardOnDisk("b", "story-x", () => null);
    expect(r).toBeNull();
    expect(flush).not.toHaveBeenCalled();
  });

  it("[NÃO-VACUIDADE] card que não existe mais: nada escrito, nada agendado", async () => {
    state.card = null;
    expect(await updateCardOnDisk("b", "story-x", (c) => ({ ...c }))).toBeNull();
    expect(flush).not.toHaveBeenCalled();
  });

  it("uma mutação que LANÇA (gate recusado) não agenda nada e o erro continua chegando ao chamador", async () => {
    await expect(
      updateCardOnDisk("b", "story-x", () => {
        throw new Error("gate recusou");
      }),
    ).rejects.toThrow("gate recusou");
    expect(flush).not.toHaveBeenCalled();
  });
});
