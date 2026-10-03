import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardGateNow, boardPaceFile, holdBoardEntry, holdBoardScopeEntry, mutateBoardPace, paceAllowsBackground, readBoardPace } from "./board-pace-store";
import { gateAdmitsCard, serializePaceFile, type BoardPaceRow } from "./board-pace";

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
  // ── o escopo de tipos em disco ─────────────────────────────────────────────────────────────────────

  const scoped: BoardPaceRow = { board: "acme", ownerScope: { types: ["bug", "technical", "chore", "spike"], by: { kind: "owner" }, at } };
  const feature = { id: "story-ex9901", type: "story" as const, storyType: "user" as const, mode: "build" as const, status: "desenvolver" };

  it("o portão da produção traz o escopo, e a pergunta por card responde (cache cai na escrita)", async () => {
    expect(boardGateNow("acme", {}, NOW).scope).toBeNull();
    await mutateBoardPace(() => [scoped]);
    const gate = boardGateNow("acme", {}, NOW);
    expect(gate).toMatchObject({ level: "normal", held: false, background: true });
    expect(gateAdmitsCard(gate, feature).admit).toBe(false);
    expect(gateAdmitsCard(gate, { ...feature, storyType: "bug" }).admit).toBe(true);
    expect(gateAdmitsCard(boardGateNow("other", {}, NOW), feature).admit).toBe(true); // outro board: sem limite
    await mutateBoardPace(() => []);
    expect(gateAdmitsCard(boardGateNow("acme", {}, NOW), feature).admit).toBe(true);
  });

  it("a VERSÃO do arquivo: 1 sem escopo (o binário antigo lê), 2 assim que algum board tem escopo; o escopo que sai volta à 1", async () => {
    await mutateBoardPace(() => [paused]);
    expect(JSON.parse(readFileSync(boardPaceFile(), "utf8")).version).toBe(1);
    await mutateBoardPace(() => [paused, scoped]);
    expect(JSON.parse(readFileSync(boardPaceFile(), "utf8")).version).toBe(2);
    expect(readBoardPace()).toEqual({ rows: [paused, scoped], unreadable: false });
    await mutateBoardPace((rows) => rows.map((r) => (r.board === "acme" && r.ownerScope ? { board: "acme" } : r)));
    expect(JSON.parse(readFileSync(boardPaceFile(), "utf8")).version).toBe(1);
  });

  it("um arquivo antigo (versão 1, sem o campo) lê como «todos os tipos»; um arquivo incoerente (v1 com escopo) é ilegível e segura tudo", () => {
    writeFileSync(boardPaceFile(), JSON.stringify({ version: 1, rows: [paused] }), "utf8");
    expect(boardGateNow("acme", {}, NOW)).toMatchObject({ held: true, source: "pace" });
    expect(boardGateNow("acme", {}, NOW).scope).toBeNull();
    writeFileSync(boardPaceFile(), JSON.stringify({ version: 1, rows: [scoped] }), "utf8");
    expect(readBoardPace()).toEqual({ rows: [], unreadable: true });
    expect(boardGateNow("other", {}, NOW)).toMatchObject({ held: true, source: "unreadable" });
    writeFileSync(boardPaceFile(), JSON.stringify({ version: 2, rows: [{ ...scoped, ownerScope: { ...scoped.ownerScope, types: [] } }] }), "utf8");
    expect(readBoardPace().unreadable).toBe(true);
  });

  it("holdBoardScopeEntry anota só com escopo em vigor, uma vez por card, e nunca lança", async () => {
    await mutateBoardPace(() => [{ board: "acme" }]);
    await holdBoardScopeEntry("acme", "story-ex9901", NOW); // sem escopo: nada
    expect(readBoardPace().rows[0].held).toBeUndefined();
    await mutateBoardPace(() => [scoped]);
    await holdBoardScopeEntry("acme", "story-ex9901", NOW);
    await holdBoardScopeEntry("acme", "story-ex9901", NOW);
    await holdBoardScopeEntry("other", "story-ex9902", NOW);
    expect(readBoardPace().rows[0].held).toEqual([{ cardId: "story-ex9901", why: "scope", at: new Date(NOW).toISOString() }]);
    expect(JSON.parse(readFileSync(boardPaceFile(), "utf8")).version).toBe(2);
    writeFileSync(boardPaceFile(), "quebrado", "utf8");
    await expect(holdBoardScopeEntry("acme", "story-ex9903", NOW)).resolves.toBeUndefined();
  });

  it("o escopo vencido já não barra, mesmo antes de a varredura gravar", async () => {
    await mutateBoardPace(() => [{ ...scoped, ownerScope: { ...scoped.ownerScope!, until: new Date(NOW - 1).toISOString() } }]);
    expect(gateAdmitsCard(boardGateNow("acme", {}, NOW), feature).admit).toBe(true);
  });
});
