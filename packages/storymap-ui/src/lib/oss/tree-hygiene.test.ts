// A ÁRVORE VERSIONADA não carrega sobra de teste nem de execução.
//
// Um teste que chamava a guarda de verdade gravou um pedido de aprovação em `storymap/boards/acme/approvals/`
// — dentro do checkout —, e o arquivo foi commitado junto com a mudança (a leitura independente antes de publicar o
// achou). Não trazia nada privado, mas é a classe de sobra que um dia traz. Os boards que a ferramenta versiona são o
// molde e os de demonstração; qualquer outro diretório ali é resto de execução.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../../../..");

function tracked(prefix: string): string[] | null {
  try {
    return execFileSync("git", ["ls-files", "--", prefix], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return null; // sem git (um tarball): não há árvore versionada para medir
  }
}

describe("a árvore versionada", () => {
  const boards = tracked("storymap/boards");

  it.skipIf(boards === null)("os boards versionados são só o molde e os de demonstração", () => {
    const dirs = [...new Set((boards ?? []).map((p) => p.split("/")[2]))].sort();
    expect(dirs).toEqual(["_base", "demo", "demo-legado"]);
  });

  it.skipIf(boards === null)("nenhum estado de execução está versionado (aprovações, lixeira, estado do runner)", () => {
    const strays = (tracked("storymap") ?? []).filter((p) => /\/(approvals|\.trash|\.runner)\//.test(p));
    expect(strays).toEqual([]);
  });
});
