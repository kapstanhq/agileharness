import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardGateNow, boardPaceFile, holdBoardEntry, mutateBoardPace, paceAllowsBackground, readBoardPace } from "./board-pace-store";
import { serializePaceFile, type BoardPaceRow } from "./board-pace";

const at = "2026-03-10T12:00:00.000Z";
const NOW = Date.parse(at) + 1000;
const paused: BoardPaceRow = { board: "acme", owner: { level: "paused", by: { kind: "owner" }, at } };

describe("o arquivo de ritmo em disco — board-pace-store", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "board-pace-"));
    prev = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("sem arquivo: nenhum board segurado, e o portão responde só pela configuração", () => {
    expect(readBoardPace()).toEqual({ rows: [], unreadable: false });
    expect(boardGateNow("acme", {}, NOW)).toMatchObject({ level: "normal", held: false });
    expect(boardGateNow("acme", { autorunDisabled: true }, NOW)).toMatchObject({ held: true, source: "disarmed" });
    expect(boardGateNow("acme", null, NOW)).toMatchObject({ held: true });
  });

  it("gravar e ler: o portão vê a pausa na leitura seguinte (o cache cai na escrita)", async () => {
    expect(boardGateNow("acme", {}, NOW).held).toBe(false); // popula o cache com «sem arquivo»
    await mutateBoardPace(() => [paused]);
    expect(boardGateNow("acme", {}, NOW)).toMatchObject({ level: "paused", held: true, source: "pace" });
    expect(boardGateNow("other", {}, NOW).held).toBe(false);
    expect(paceAllowsBackground("acme", NOW)).toBe(false);
    expect(paceAllowsBackground("other", NOW)).toBe(true);
    await mutateBoardPace((rows) => rows.filter((r) => r.board !== "acme"));
    expect(boardGateNow("acme", {}, NOW).held).toBe(false);
  });

  it("uma mudança feita POR FORA no arquivo é vista (a assinatura do arquivo mudou)", async () => {
    await mutateBoardPace(() => [paused]);
    expect(boardGateNow("acme", {}, NOW).held).toBe(true);
    writeFileSync(boardPaceFile(), serializePaceFile([]) + "\n", "utf8");
    expect(boardGateNow("acme", {}, NOW).held).toBe(false);
  });

  it("ILEGÍVEL NÃO É VAZIO: arquivo quebrado segura todos os boards, e regravar guarda o quebrado ao lado", async () => {
    writeFileSync(boardPaceFile(), "{ isto não é json", "utf8");
    expect(readBoardPace()).toEqual({ rows: [], unreadable: true });
    expect(boardGateNow("acme", {}, NOW)).toMatchObject({ held: true, source: "unreadable" });
    expect(boardGateNow("other", {}, NOW)).toMatchObject({ held: true, source: "unreadable" });
    // o copiloto obedece ao ilegível também
    expect(paceAllowsBackground("acme", NOW)).toBe(false);
    const written = await mutateBoardPace((rows, unreadable) => {
      expect(unreadable).toBe(true);
      expect(rows).toEqual([]);
      return [];
    });
    expect(written).toEqual([]);
    expect(readFileSync(`${boardPaceFile()}.ilegivel`, "utf8")).toBe("{ isto não é json");
    expect(boardGateNow("acme", {}, NOW).held).toBe(false);
  });

  it("`fn` que devolve null não grava; uma gravação que falha REJEITA (quem pausou precisa saber)", async () => {
    expect(await mutateBoardPace(() => null)).toBeNull();
    expect(existsSync(boardPaceFile())).toBe(false);
    // um ARQUIVO no lugar do diretório: o mkdir da gravação falha
    writeFileSync(path.join(dir, "arquivo.txt"), "x");
    await expect(mutateBoardPace(() => [paused], path.join(dir, "arquivo.txt", "dentro", "board-pace.json"))).rejects.toBeTruthy();
    // a cadeia segue viva depois de uma rejeição
    expect(await mutateBoardPace(() => [paused])).toEqual([paused]);
  });

  it("holdBoardEntry anota só em board pausado, uma vez por card, e nunca lança", async () => {
    await holdBoardEntry("acme", "c1", "entry", NOW); // sem linha: nada
    expect(readBoardPace().rows).toEqual([]);
    await mutateBoardPace(() => [paused]);
    await holdBoardEntry("acme", "c1", "entry", NOW);
    await holdBoardEntry("acme", "c1", "entry", NOW);
    await holdBoardEntry("other", "c9", "entry", NOW);
    expect(readBoardPace().rows[0].held).toEqual([{ cardId: "c1", why: "entry", at: new Date(NOW).toISOString() }]);
    writeFileSync(boardPaceFile(), "quebrado", "utf8");
    await expect(holdBoardEntry("acme", "c2", "entry", NOW)).resolves.toBeUndefined();
    expect(readFileSync(boardPaceFile(), "utf8")).toBe("quebrado"); // a anotação não regrava um arquivo ilegível
  });
});
