import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPrefs, prunePrefs, setPref } from "./prefs-store";

// prefs-store persists into runnerStateDir(), which honors AGILEHARNESS_RUNNER_STATE_DIR — so we redirect
// it to a throwaway dir per test and never touch the live runner state.
let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  dir = mkdtempSync(path.join(os.tmpdir(), "termprefs-"));
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = dir;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("terminal prefs-store", () => {
  it("começa vazio e nunca lança em arquivo ausente", () => {
    expect(loadPrefs()).toEqual({});
  });

  it("grava e lê um apelido, por nome de sessão", async () => {
    await setPref("shell", { alias: "meu shell" });
    expect(loadPrefs()).toEqual({ shell: { alias: "meu shell" } });
  });

  it("fixa e desafixa (pinned), preservando o apelido", async () => {
    await setPref("agent-x", { alias: "trabalho" });
    await setPref("agent-x", { pinned: true });
    expect(loadPrefs()["agent-x"]).toEqual({ alias: "trabalho", pinned: true });
    await setPref("agent-x", { pinned: false });
    expect(loadPrefs()["agent-x"]).toEqual({ alias: "trabalho" });
  });

  it("alias null/vazio limpa o apelido; a entrada some quando fica vazia", async () => {
    await setPref("s", { alias: "x" });
    await setPref("s", { alias: "" });
    expect(loadPrefs()).toEqual({});
    await setPref("s", { alias: "y" });
    await setPref("s", { alias: null });
    expect(loadPrefs()).toEqual({});
  });

  it("só mexe nas chaves presentes no patch (pinned não apaga alias e vice-versa)", async () => {
    await setPref("s", { alias: "nome", pinned: true });
    await setPref("s", { alias: "outro" });
    expect(loadPrefs()["s"]).toEqual({ alias: "outro", pinned: true });
  });

  it("trunca apelidos muito longos (<= 80)", async () => {
    await setPref("s", { alias: "a".repeat(200) });
    expect(loadPrefs()["s"].alias?.length).toBe(80);
  });

  it("grava o vínculo de board de um terminal aberto à mão", async () => {
    // O DEFEITO que isto fecha: um tmux aberto à mão (`shell`, `term-2`) não tem board por nenhum
    // caminho automático, então `servesBoard` o filtrava para fora da home de TODOS os boards e o
    // operador não tinha alavanca nenhuma. Agora ele tem.
    await setPref("term-2", { board: "storymap" });
    expect(loadPrefs()["term-2"]).toEqual({ board: "storymap" });
  });

  it("board null/vazio desvincula; a entrada some quando fica vazia", async () => {
    await setPref("term-2", { board: "acme" });
    await setPref("term-2", { board: null });
    expect(loadPrefs()).toEqual({});
    await setPref("term-2", { board: "acme" });
    await setPref("term-2", { board: "" });
    expect(loadPrefs()).toEqual({});
  });

  it("board e apelido são independentes — um patch não apaga o outro", async () => {
    await setPref("term-2", { alias: "build", board: "storymap" });
    await setPref("term-2", { board: "acme" });
    expect(loadPrefs()["term-2"]).toEqual({ alias: "build", board: "acme" });
    await setPref("term-2", { board: null });
    expect(loadPrefs()["term-2"]).toEqual({ alias: "build" });
  });
});

describe("prunePrefs — o apelido não sobrevive ao terminal", () => {
  it("derruba a entrada de uma sessão que não existe mais e devolve quais foram", async () => {
    // O DEFEITO: a rota DELETE já apagava a pref, mas matar pela app é UM dos caminhos de morte. `exit`,
    // `tmux kill-session` e um reboot deixavam a entrada órfã — e a lista de Terminais passava a exibir
    // o nome de um terminal que não existe (a queixa literal do operador), herdado por qualquer sessão
    // futura que reusasse o nome.
    await setPref("shell", { alias: "Terminal do servidor" });
    await setPref("morta", { alias: "Mascote e no" });
    expect(await prunePrefs(["shell"])).toEqual(["morta"]);
    expect(loadPrefs()).toEqual({ shell: { alias: "Terminal do servidor" } });
  });

  it("NUNCA poda com a lista vazia — `[]` é 'o tmux não respondeu', não 'não há terminal'", async () => {
    // A trava que não pode sair: listSessions() devolve [] nos dois casos, e um engano desses levaria
    // TODOS os apelidos do operador de uma vez, sem desfazer.
    await setPref("shell", { alias: "meu shell" });
    expect(await prunePrefs([])).toEqual([]);
    expect(loadPrefs()).toEqual({ shell: { alias: "meu shell" } });
  });

  it("não escreve nada quando está tudo vivo (o vigia chama isto a cada ciclo)", async () => {
    await setPref("shell", { alias: "meu shell" });
    expect(await prunePrefs(["shell", "outra"])).toEqual([]);
    expect(loadPrefs()).toEqual({ shell: { alias: "meu shell" } });
  });

  it("leva o `pinned` junto — a entrada inteira morre com a sessão", async () => {
    await setPref("morta", { pinned: true });
    expect(await prunePrefs(["viva"])).toEqual(["morta"]);
    expect(loadPrefs()).toEqual({});
  });

  it("leva o VÍNCULO DE BOARD junto — um nome reusado não herda o board do morto", async () => {
    // Mesma razão do apelido: a chave é o NOME tmux. Um `term-2` futuro apareceria na home de um
    // board que o operador nunca escolheu para ELE.
    await setPref("morta", { board: "storymap" });
    expect(await prunePrefs(["viva"])).toEqual(["morta"]);
    expect(loadPrefs()).toEqual({});
  });
});
