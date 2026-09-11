import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findToolPackageDir } from "./paths";
import { selfBoardId } from "./self-board";

describe("board próprio da instalação", () => {
  it("declarado ⇒ é ele", () => {
    expect(selfBoardId({ AGILEHARNESS_SELF_BOARD: "storymap" })).toBe("storymap");
    expect(selfBoardId({ AGILEHARNESS_SELF_BOARD: "  meu-board  " })).toBe("meu-board");
  });

  it("ausente ou vazio ⇒ null, que é estado legítimo e não erro", () => {
    expect(selfBoardId({})).toBeNull();
    expect(selfBoardId({ AGILEHARNESS_SELF_BOARD: "" })).toBeNull();
    expect(selfBoardId({ AGILEHARNESS_SELF_BOARD: "   " })).toBeNull();
  });
});

// ── A GUARDA DE CLASSE ────────────────────────────────────────────────────────────────────────────
// O defeito não era o literal `"storymap"` numa linha; era um id do NOSSO alvo fixado dentro do
// produto, onde ele não significa nada para mais ninguém. Uma correção que só troque as três linhas
// deixa a classe aberta: a próxima rota que precise "do board daqui" volta a digitar o literal.
// Esta varredura mede a CLASSE — nenhum id de board deste alvo pode aparecer no código do produto.
describe("nenhum id de board do alvo vive dentro do produto", () => {
  const SRC = path.join(findToolPackageDir(), "src");
  // Os boards que o ARTEFATO publica como fixture são legítimos (demo/_base): eles descrevem o que
  // ESTE repositório distribui. O proibido é o id que só existe no alvo de quem desenvolve.
  const DO_ALVO = ["storymap", "nook", "playpack", "citygo", "tribify", "tickify"];

  const arquivosDeProduto = (): string[] => {
    const out: string[] = [];
    const varrer = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) varrer(full);
        // Só o CÓDIGO DE PRODUTO: testes declaram ids de alvo em fixture por necessidade, e a
        // varredura de identidade (oss-identity-hygiene) é quem cobre aquele lado.
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
      }
    };
    varrer(SRC);
    return out;
  };

  it("nenhuma rota fixa um id de board do alvo (use selfBoardId)", () => {
    const achados: string[] = [];
    for (const arquivo of arquivosDeProduto()) {
      if (arquivo.endsWith("self-board.ts")) continue; // é quem documenta a regra
      const texto = readFileSync(arquivo, "utf8");
      for (const linha of texto.split("\n")) {
        const t = linha.trim();
        // Comentário é PROSA: `storymap` entre crases numa explicação não é destino de nada.
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        // O SEGMENTO do diretório de dados (`path.join(raiz, "storymap")`) é o nome da pasta, não um
        // board — ele cai na Fase 5 do rename de caminhos, deliberadamente fora deste recorte.
        if (/\bpath(\.\w+)?\.join\(/.test(t)) continue;
        for (const id of DO_ALVO) {
          if (new RegExp(`["']${id}["']`).test(linha)) achados.push(`${path.relative(SRC, arquivo)}: "${id}"`);
        }
      }
    }
    expect(
      achados,
      "id de board do alvo fixado no produto — leia-o de selfBoardId(), ou o código só funciona nesta máquina",
    ).toEqual([]);
  });

  it("a varredura de fato olha o produto (não-vacuidade)", () => {
    expect(arquivosDeProduto().length).toBeGreaterThan(200);
  });
});
