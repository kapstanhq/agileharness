import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGit, type GitRunner } from "./git";
import { defaultExec } from "./worktree";
import { captureTrainPreimages, restoreDataPaths } from "./merge-queue";

// WP5-F1 — o «desfazer» da metade de dados do train devolve SÓ os caminhos que ele escreveu, ao que eram ANTES dele.
// (REESCRITO de propósito: a versão anterior deste arquivo travava o desenho WS1.2 — `reset`/`checkout HEAD`/`clean -fd`
// em TODO storymap/boards —, que foi exatamente o que apagou cards aceitos na triagem: eles só existiam
// fora do git, porque o flush do board estava travado pelo secret-scan.)
// Provado contra git DE VERDADE num repositório descartável: a semântica que importa é a do índice e da árvore reais.
async function initRepo(): Promise<{ dir: string; git: GitRunner }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "restore-board-"));
  const git = makeGit(defaultExec, { cwd: dir, timeoutMs: 30_000 });
  await git(`init -q`);
  await git(`config user.email t@example.test`);
  await git(`config user.name tester`);
  await fsp.mkdir(path.join(dir, "storymap/boards/b/cards"), { recursive: true });
  await fsp.mkdir(path.join(dir, "packages/foo"), { recursive: true });
  await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/x.md"), "orig card\n");
  await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/live.md"), "live card HEAD\n");
  await fsp.writeFile(path.join(dir, "packages/foo/code.ts"), "export const A = 1;\n");
  await git(`add -A`);
  await git(`commit -q -m seed --no-verify`);
  return { dir, git };
}

const read = (dir: string, rel: string) => fsp.readFile(path.join(dir, rel), "utf8");
const exists = (p: string) => fsp.access(p).then(() => true).catch(() => false);

describe("restoreDataPaths (WP5-F1) — o train só desfaz o que ELE escreveu", () => {
  let dir: string;
  let git: GitRunner;
  beforeEach(async () => {
    ({ dir, git } = await initRepo());
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("devolve os caminhos do train ao estado ANTERIOR e não toca em NADA fora deles (o cenário real da triagem)", async () => {
    // Estado vivo antes do train: um card NOVO não rastreado (escrita MCP), um card modificado não commitado, código WIP.
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/novo.md"), "aceito na triagem, ainda fora do git\n");
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/live.md"), "live card MOVIDO por MCP\n");
    await fsp.writeFile(path.join(dir, "packages/foo/code.ts"), "export const A = 999; // WIP\n");
    // …e o failed flush deixou o board STAGED (o `git add` antes do scan recusar).
    await git(`add -- storymap/boards/`);

    // O train escreve x.md (modifica, stage) e cria train-new.md (novo, stage), depois falha.
    const pre = await captureTrainPreimages(dir, ["storymap/boards/b/cards/x.md", "storymap/boards/b/cards/train-new.md"]);
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/x.md"), "<<<<<<< marcador de conflito\n");
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/train-new.md"), "criado pelo patch do run\n");
    await git(`add -- storymap/boards/b/cards/x.md storymap/boards/b/cards/train-new.md`);

    const res = await restoreDataPaths(git, dir, pre);

    expect(res).toEqual({ ok: true });
    // o que o train escreveu voltou ao que era
    expect(await read(dir, "storymap/boards/b/cards/x.md")).toBe("orig card\n");
    expect(await exists(path.join(dir, "storymap/boards/b/cards/train-new.md"))).toBe(false);
    // o que ele NÃO escreveu sobrevive byte a byte — inclusive o card novo fora do git
    expect(await read(dir, "storymap/boards/b/cards/novo.md")).toBe("aceito na triagem, ainda fora do git\n");
    expect(await read(dir, "storymap/boards/b/cards/live.md")).toBe("live card MOVIDO por MCP\n");
    expect(await read(dir, "packages/foo/code.ts")).toContain("999");
    // e o índice dos caminhos do train voltou ao HEAD (nenhum resto staged do train)
    const staged = (await git(`diff --cached --name-only`)).stdout;
    expect(staged).not.toContain("x.md");
    expect(staged).not.toContain("train-new.md");
  });

  it("um caminho do train que tinha escrita viva por baixo volta à escrita VIVA, não ao HEAD", async () => {
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/live.md"), "status movido por MCP, não commitado\n");
    const pre = await captureTrainPreimages(dir, ["storymap/boards/b/cards/live.md"]);
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/live.md"), "fundido pelo train\n");
    await git(`add -- storymap/boards/b/cards/live.md`);

    expect(await restoreDataPaths(git, dir, pre)).toEqual({ ok: true });
    expect(await read(dir, "storymap/boards/b/cards/live.md")).toBe("status movido por MCP, não commitado\n");
  });

  it("depois de um `reset --soft` (o secret no commit do train): o commit sai, os bytes voltam, o resto fica", async () => {
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/novo.md"), "fora do git\n");
    const pre = await captureTrainPreimages(dir, ["storymap/boards/b/cards/x.md"]);
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/x.md"), "conteúdo do run com segredo\n");
    await git(`add -- storymap/boards/b/cards/x.md`);
    await git(`commit -q --no-verify -m board-do-train`);
    await git(`reset --soft HEAD^1`);

    expect(await restoreDataPaths(git, dir, pre)).toEqual({ ok: true });
    expect(await read(dir, "storymap/boards/b/cards/x.md")).toBe("orig card\n");
    expect(await read(dir, "storymap/boards/b/cards/novo.md")).toBe("fora do git\n");
    expect((await git(`status --porcelain -- storymap/boards/b/cards/x.md`)).stdout.trim()).toBe("");
  });

  it("sem nada escrito é no-op (ok) e não chama git", async () => {
    expect(await restoreDataPaths(git, dir, [])).toEqual({ ok: true });
  });

  it("acusa (ok:false) quando um caminho não volta ao estado anterior — o chamador estaciona alto", async () => {
    const pre = await captureTrainPreimages(dir, ["storymap/boards/b/cards/x.md"]);
    const failingGit: GitRunner = async (args, cwd) => {
      const r = await git(args, cwd);
      // um diretório no lugar do arquivo: a escrita do estado anterior falha
      await fsp.rm(path.join(dir, "storymap/boards/b/cards/x.md"), { force: true });
      await fsp.mkdir(path.join(dir, "storymap/boards/b/cards/x.md"), { recursive: true });
      return r;
    };
    const res = await restoreDataPaths(failingGit, dir, pre);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toMatch(/x\.md/);
  });

  it("captureTrainPreimages: ausente ⇒ null; presente ⇒ os bytes exatos", async () => {
    const pre = await captureTrainPreimages(dir, ["storymap/boards/b/cards/x.md", "storymap/boards/b/cards/nao-existe.md"]);
    expect(pre[0].bytes?.toString("utf8")).toBe("orig card\n");
    expect(pre[1].bytes).toBeNull();
  });
  // WP5-F2 — o caminho cujo disco já não tem o que o train escreveu mudou por OUTRO escritor: fica como está.
  it("com os bytes que o train deixou: caminho mexido depois por outro escritor é MANTIDO (e dito); o resto volta", async () => {
    const pre = await captureTrainPreimages(dir, ["storymap/boards/b/cards/x.md", "storymap/boards/b/cards/live.md"]);
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/x.md"), "escrito pelo train\n");
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/live.md"), "escrito pelo train\n");
    await git(`add -- storymap/boards/b/cards/x.md storymap/boards/b/cards/live.md`);
    const trainWrote = new Map([
      ["storymap/boards/b/cards/x.md", Buffer.from("escrito pelo train\n")],
      ["storymap/boards/b/cards/live.md", Buffer.from("escrito pelo train\n")],
    ]);
    // um update_card grava live.md DEPOIS do train (durante a regeneração)
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/live.md"), "movido por MCP depois do train\n");

    expect(await restoreDataPaths(git, dir, pre, { trainWrote })).toEqual({ ok: true, kept: ["storymap/boards/b/cards/live.md"] });
    expect(await read(dir, "storymap/boards/b/cards/live.md")).toBe("movido por MCP depois do train\n");
    expect(await read(dir, "storymap/boards/b/cards/x.md")).toBe("orig card\n");
    expect((await git(`diff --cached --name-only`)).stdout.trim()).toBe(""); // o índice dos dois voltou ao HEAD
  });
});
