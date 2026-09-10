import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPrefs, setPref } from "@/lib/terminal/prefs-store";

// O vínculo terminal↔board é a única alavanca que o operador tem para fazer um tmux aberto à mão
// (`shell`, `term-2`) aparecer na home de um board — `servesBoard` é estrita e sem board a linha
// some de TODOS os recortes. Estes testes prendem as duas travas do servidor, porque a UI é só
// display: (1) o board precisa existir, (2) um vínculo ESTRUTURAL não se troca.
//
// `listBoards` e `listRunningServices` são mockados: o primeiro varreria o `storymap/boards` real
// (a resposta mudaria com o repo), o segundo faz fan-out de tmux/ps na máquina.
const listBoards = vi.hoisted(() => vi.fn());
const listRunningServices = vi.hoisted(() => vi.fn());

vi.mock("@/lib/storymap/repo", () => ({ listBoards }));
vi.mock("@/lib/vps/processes", () => ({ listRunningServices }));

import { PATCH } from "./route";

function patch(body: unknown): Request {
  return new Request("http://localhost:3008/api/terminal/sessions", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// prefs-store persiste em runnerStateDir(), que honra AGILEHARNESS_RUNNER_STATE_DIR — um dir POR TESTE
// (e não por arquivo, como o vitest.setup faz) para que uma gravação não vaze para a asserção da
// próxima: metade destes testes afirma justamente que NADA foi gravado.
let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  dir = mkdtempSync(path.join(os.tmpdir(), "termsessions-"));
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = dir;
  listBoards.mockResolvedValue([
    { id: "storymap", name: "AgileHarness" },
    { id: "acme", name: "Nest" },
  ]);
  listRunningServices.mockResolvedValue([]);
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("PATCH /api/terminal/sessions — vínculo de board", () => {
  it("vincula um terminal solto a um board existente", async () => {
    const res = await PATCH(patch({ name: "term-2", board: "storymap" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, prefs: { board: "storymap" } });
    expect(loadPrefs()["term-2"]?.board).toBe("storymap");
  });

  it("RECUSA um board que não existe — um vínculo pendurado filtraria para nada em silêncio", async () => {
    const res = await PATCH(patch({ name: "term-2", board: "board-fantasma" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
    expect(loadPrefs()["term-2"]).toBeUndefined();
  });

  it("board null desvincula (sem board é um estado legítimo)", async () => {
    await setPref("term-2", { board: "acme" });
    const res = await PATCH(patch({ name: "term-2", board: null }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ prefs: { board: null } });
    expect(loadPrefs()["term-2"]).toBeUndefined();
  });

  it("RECUSA reapontar um terminal de CARD — a home de um board listaria o card de outro", async () => {
    listRunningServices.mockResolvedValue([
      {
        tmuxSession: "card-acme__story-4k2p",
        board: "acme",
        boardSource: "card",
        cardId: "story-4k2p",
      },
    ]);
    const res = await PATCH(patch({ name: "card-acme__story-4k2p", board: "storymap" }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ ok: false, board: "acme", boardSource: "card" });
    expect(loadPrefs()["card-acme__story-4k2p"]).toBeUndefined();
  });

  it("RECUSA reapontar uma sessão da FROTA — o board vem do claim", async () => {
    listRunningServices.mockResolvedValue([
      { tmuxSession: "agent-a91f", board: "acme", boardSource: "fleet" },
    ]);
    const res = await PATCH(patch({ name: "agent-a91f", board: "storymap" }));
    expect(res.status).toBe(409);
    expect(loadPrefs()["agent-a91f"]).toBeUndefined();
  });

  it("a trava é FAIL-CLOSED: vale também para DESVINCULAR um estrutural", async () => {
    listRunningServices.mockResolvedValue([
      { tmuxSession: "agent-a91f", board: "acme", boardSource: "fleet" },
    ]);
    expect((await PATCH(patch({ name: "agent-a91f", board: null }))).status).toBe(409);
  });

  it("um patch SEM `board` não passa pela validação nem toca o vínculo", async () => {
    await setPref("term-2", { board: "acme" });
    const res = await PATCH(patch({ name: "term-2", alias: "build" }));
    expect(res.status).toBe(200);
    expect(listBoards).not.toHaveBeenCalled();
    expect(loadPrefs()["term-2"]).toEqual({ board: "acme", alias: "build" });
  });

  it("recusa um nome de sessão inválido antes de qualquer escrita", async () => {
    const res = await PATCH(patch({ name: "../etc/passwd", board: "acme" }));
    expect(res.status).toBe(400);
    expect(loadPrefs()).toEqual({});
  });
});
