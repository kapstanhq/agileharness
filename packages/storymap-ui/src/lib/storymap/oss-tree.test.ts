// A árvore é uma só (issue #1). Este arquivo cobra o que restou do módulo e o que a limpeza prometeu.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALVO_DA_PUBLICACAO,
  comandoDe,
  GATE_DE_PUBLICACAO,
  OSS_TREE_ROOT,
  produtoresDaPublicacao,
  receitaDoJustfile,
  REPO_ROOT,
  WORKFLOWS_DIR,
} from "./oss-tree";

describe("a camada de extração saiu de verdade (issue #1)", () => {
  it("não há segunda cópia do CI nem régua de corte na árvore", () => {
    for (const rel of ["oss", ".ossignore", "oss/extract.sh"]) {
      expect(existsSync(path.join(OSS_TREE_ROOT, rel)), `${rel} voltou — a árvore é uma só`).toBe(false);
    }
  });
  it("a raiz resolvida é a deste repositório, e o sinônimo aponta para o mesmo lugar", () => {
    expect(existsSync(path.join(OSS_TREE_ROOT, "package.json"))).toBe(true);
    expect(existsSync(path.join(OSS_TREE_ROOT, WORKFLOWS_DIR))).toBe(true);
    expect(REPO_ROOT).toBe(OSS_TREE_ROOT);
  });
});

describe("produtoresDaPublicacao() — o gate tem quem o execute NESTA árvore", () => {
  const produtores = produtoresDaPublicacao();
  it("existe ao menos um produtor, todos em .github/workflows, e todos invocam o gate", () => {
    expect(produtores.length).toBeGreaterThan(0);
    for (const p of produtores) {
      expect(p.nome.startsWith(`${WORKFLOWS_DIR}/`), p.nome).toBe(true);
      expect(p.corpo, p.nome).toContain(GATE_DE_PUBLICACAO);
      expect(existsSync(path.join(OSS_TREE_ROOT, GATE_DE_PUBLICACAO))).toBe(true);
    }
  });
  it("o passo que executa o gate se chama pelo nome do alvo", () => {
    expect(produtores.some((p) => p.nome.includes(ALVO_DA_PUBLICACAO))).toBe(true);
  });
  it("cada produtor traz um comando executável de uma linha, sem recorte de árvore", () => {
    for (const p of produtores) {
      expect(p.comando[0]).toBe("sh");
      expect(p.comando[2]).not.toContain("\n");
      expect(p.comando[2]).toContain(GATE_DE_PUBLICACAO);
      expect(p.comando[2], `${p.nome} recorta a árvore — nesta árvore não há o que cortar`).not.toContain("--exclude-from");
    }
  });
  it("um diretório sem workflows devolve lista vazia (e é o teste de produtor que reprova, não este)", () => {
    expect(produtoresDaPublicacao("/nao/existe")).toEqual([]);
  });
});

describe("os desdobradores de texto", () => {
  it("comandoDe desdobra um escalar de bloco num comando de uma linha", () => {
    expect(comandoDe("run: >-\n  node a.mjs\n  --x 1\n  --y")).toBe("node a.mjs --x 1 --y");
    expect(comandoDe("  @node a.mjs {{ARGS}}")).toBe("node a.mjs");
  });
  it("receitaDoJustfile devolve o corpo indentado do alvo, e vazio para alvo ausente", () => {
    const jf = "outro:\n  echo x\nalvo *ARGS:\n  node a.mjs\n  --z\nfim:\n  true\n";
    expect(receitaDoJustfile(jf, "alvo")).toBe("  node a.mjs\n  --z");
    expect(receitaDoJustfile(jf, "nada")).toBe("");
  });
});
