// O enxerto da resolução do juiz no `stage` — contra um repositório git DE VERDADE.
//
// Este teste existe por um defeito medido em produção (2026-07-20): o caminho de release apontava o ref do
// `stage` para a árvore do juiz, que é cortada de `main` e só contém os arquivos divergentes. Como `stage` é
// compartilhada por TODO o repo, isso descartava o código não-liberado de todos os outros cards e sessões. Na
// medição real o stage carregava 10+ commits de dois pacotes distintos. Mock não pega isso — só git pega.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { graftResolvedFilesOntoStage } from "./entry-effects";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec("git", args, { cwd });

/**
 * Um repo com a topologia REAL do defeito:
 *   main   — a branch liberada
 *   stage  — main + o trabalho de OUTRA sessão (outro pacote) + o código do card em conflito
 *   judge  — cortada de MAIN, com só o arquivo divergente resolvido (NÃO conhece o trabalho da outra sessão)
 */
async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "graft-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "t@t.t"]);
  await git(root, ["config", "user.name", "t"]);

  await fs.mkdir(path.join(root, "pkg-a"), { recursive: true });
  await fs.writeFile(path.join(root, "pkg-a/service.js"), "versao-da-main\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "main: base"]);

  await git(root, ["checkout", "-qb", "stage"]);
  // O trabalho de OUTRA sessão, em OUTRO pacote — é exatamente isto que o bug apagava.
  await fs.mkdir(path.join(root, "pkg-b"), { recursive: true });
  await fs.writeFile(path.join(root, "pkg-b/outra-sessao.ts"), "trabalho nao-liberado de outra sessao\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "stage: trabalho de outra sessao"]);
  await fs.writeFile(path.join(root, "pkg-a/service.js"), "versao-do-card-em-stage\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "stage: codigo do card"]);

  // A árvore do juiz: cortada de MAIN (não de stage), com só o arquivo divergente resolvido.
  await git(root, ["checkout", "-q", "-b", "judge", "main"]);
  await fs.writeFile(path.join(root, "pkg-a/service.js"), "versao-RESOLVIDA-pelo-juiz\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "judge: resolucao"]);
  await git(root, ["checkout", "-q", "stage"]);
  return root;
}

const show = async (root: string, ref: string, file: string): Promise<string | null> =>
  git(root, ["show", `${ref}:${file}`]).then((r) => r.stdout, () => null);

describe("graftResolvedFilesOntoStage — a resolução ENTRA no stage sem apagar o resto", () => {
  it("aplica o arquivo resolvido E preserva o trabalho não-liberado de outra sessão", async () => {
    const root = await makeRepo();
    try {
      const before = (await git(root, ["rev-parse", "stage"])).stdout.trim();
      await graftResolvedFilesOntoStage(root, "stage", "judge", ["pkg-a/service.js"]);

      // 1 — o arquivo divergente ficou com a versão do juiz.
      expect(await show(root, "stage", "pkg-a/service.js")).toBe("versao-RESOLVIDA-pelo-juiz\n");
      // 2 — O PONTO DO TESTE: o trabalho da outra sessão SOBREVIVEU. Com o `update-ref` antigo isto sumia.
      expect(await show(root, "stage", "pkg-b/outra-sessao.ts")).toBe("trabalho nao-liberado de outra sessao\n");
      // 3 — a história não foi reescrita: o commit novo tem o tip anterior do stage como PAI.
      expect((await git(root, ["rev-parse", "stage^"])).stdout.trim()).toBe(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("um arquivo que a resolução DELETOU sai do stage (não fica para trás)", async () => {
    const root = await makeRepo();
    try {
      await git(root, ["checkout", "-q", "judge"]);
      await fs.rm(path.join(root, "pkg-a/service.js"));
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-qm", "judge: remove o arquivo"]);
      await git(root, ["checkout", "-q", "stage"]);

      await graftResolvedFilesOntoStage(root, "stage", "judge", ["pkg-a/service.js"]);
      expect(await show(root, "stage", "pkg-a/service.js")).toBeNull();
      expect(await show(root, "stage", "pkg-b/outra-sessao.ts")).toBe("trabalho nao-liberado de outra sessao\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uma ref de resolução inexistente FALHA e deixa o stage intacto (fail-closed)", async () => {
    const root = await makeRepo();
    try {
      const before = (await git(root, ["rev-parse", "stage"])).stdout.trim();
      await expect(graftResolvedFilesOntoStage(root, "stage", "nao-existe", ["pkg-a/service.js"])).rejects.toThrow();
      expect((await git(root, ["rev-parse", "stage"])).stdout.trim()).toBe(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
