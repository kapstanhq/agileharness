import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import {
  ROOT_MARKERS,
  TOOL_PACKAGE_NAME,
  ToolRootUnresolvedError,
  findRepoRoot,
  findToolPackageDir,
  findToolRoot,
  resetRepoRootCache,
  resetToolRootCache,
} from "./paths";

// ── A PERGUNTA QUE ESTES CASOS MEDEM ────────────────────────────────────────────────────────────────
// `findRepoRoot()` responde "onde mora o código do usuário" e obedece a AGILEHARNESS_TARGET.
// `findToolPackageDir()` responde "onde mora o código que está rodando" e NÃO obedece a nada disso.
// Enquanto a ferramenta viveu dentro do repositório que ela opera, as duas coincidiram e nenhum teste
// conseguia distingui-las — a suíte inteira de deploy rodava com UMA raiz literal. É essa cegueira que
// deixou passar o defeito de o self-deploy reconstruir a árvore errada.

function comEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetRepoRootCache();
  resetToolRootCache();
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetRepoRootCache();
    resetToolRootCache();
  }
}

afterEach(() => {
  resetRepoRootCache();
  resetToolRootCache();
});

describe("findToolPackageDir — a raiz da FERRAMENTA", () => {
  it("resolve para um pacote que se chama como a ferramenta", () => {
    const dir = comEnv({}, () => findToolPackageDir());
    const nome = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name: string }).name;
    expect(nome).toBe(TOOL_PACKAGE_NAME);
  });

  // ── O INVARIANTE CENTRAL ──────────────────────────────────────────────────────────────────────────
  // Apontar o ALVO para outro lugar não muda qual código está no ar. Um `findToolPackageDir()` que se
  // mexesse aqui reintroduziria, inteiro, o defeito C1: o self-deploy reconstruindo a árvore do alvo.
  it("NÃO se move quando AGILEHARNESS_TARGET aponta para outra árvore", () => {
    const semAlvo = comEnv({ AGILEHARNESS_TARGET: undefined }, () => findToolPackageDir());

    const alheio = mkdtempSync(path.join(tmpdir(), "alvo-alheio-"));
    mkdirSync(path.join(alheio, "storymap", "boards"), { recursive: true }); // marcador de RAIZ do alvo

    const comAlvo = comEnv({ AGILEHARNESS_TARGET: alheio }, () => {
      // a raiz do ALVO obedece — é o contrato dela
      expect(findRepoRoot()).toBe(path.resolve(alheio));
      // a da FERRAMENTA, não
      return findToolPackageDir();
    });

    expect(comAlvo).toBe(semAlvo);
  });

  it("AGILEHARNESS_TOOL_ROOT declarado vence — e é VALIDADO, nunca degradando em silêncio", () => {
    const real = comEnv({}, () => findToolPackageDir());
    expect(comEnv({ AGILEHARNESS_TOOL_ROOT: real }, () => findToolPackageDir())).toBe(path.resolve(real));

    // Um declarado que não é o pacote da ferramenta tem de FALHAR aqui — não virar um `cd` para o
    // lugar errado dentro do script destacado do self-deploy, dezenas de chamadas depois.
    const vazio = mkdtempSync(path.join(tmpdir(), "nao-e-a-ferramenta-"));
    expect(() => comEnv({ AGILEHARNESS_TOOL_ROOT: vazio }, () => findToolPackageDir())).toThrow(
      ToolRootUnresolvedError,
    );
    // e o erro diz ONDE procurou e o que procurou — um erro mudo obriga o operador a adivinhar
    try {
      comEnv({ AGILEHARNESS_TOOL_ROOT: vazio }, () => findToolPackageDir());
      expect.unreachable("deveria ter lançado");
    } catch (e) {
      expect(String((e as Error).message)).toContain(vazio);
      expect(String((e as Error).message)).toContain(TOOL_PACKAGE_NAME);
    }
  });
});

describe("findToolRoot — o REPOSITÓRIO da ferramenta", () => {
  it("é uma raiz de repositório de verdade, e contém o pacote", () => {
    const raiz = comEnv({}, () => findToolRoot());
    const pacote = comEnv({}, () => findToolPackageDir());
    expect(ROOT_MARKERS.some((m) => existsSync(path.join(raiz, ...m.split("/"))))).toBe(true);
    expect(path.resolve(pacote).startsWith(path.resolve(raiz))).toBe(true);
  });

  it("também ignora AGILEHARNESS_TARGET", () => {
    const semAlvo = comEnv({ AGILEHARNESS_TARGET: undefined }, () => findToolRoot());
    const alheio = mkdtempSync(path.join(tmpdir(), "alvo-alheio2-"));
    mkdirSync(path.join(alheio, "storymap", "boards"), { recursive: true });
    expect(comEnv({ AGILEHARNESS_TARGET: alheio }, () => findToolRoot())).toBe(semAlvo);
  });
});

describe("o marcador é a auto-identificação da ferramenta", () => {
  // Se o pacote for renomeado (Fase 5 do plano da inversão) e a constante não acompanhar, a busca tem
  // de FALHAR ALTO — nunca resolver para um vizinho. Provado por reintrodução: uma árvore forjada em que
  // NENHUM ancestral se chama como a ferramenta.
  it("uma árvore sem o pacote da ferramenta falha ALTO, em vez de resolver para o vizinho", () => {
    const forjada = mkdtempSync(path.join(tmpdir(), "sem-ferramenta-"));
    const fundo = path.join(forjada, "a", "b");
    mkdirSync(fundo, { recursive: true });
    writeFileSync(path.join(forjada, "package.json"), JSON.stringify({ name: "outra-coisa" }));
    expect(() => comEnv({ AGILEHARNESS_TOOL_ROOT: fundo }, () => findToolPackageDir())).toThrow(
      ToolRootUnresolvedError,
    );
  });
});

// ── A GUARDA DA CLASSE ──────────────────────────────────────────────────────────────────────────────
// Consertar os sítios que hoje derivam a árvore da ferramenta a partir da raiz do ALVO não impede o
// próximo. E o próximo nasce exatamente igual: alguém escreve `${repoRoot}/packages/storymap-ui` porque
// hoje isso resolve certo, e a suíte inteira concorda — porque as duas raízes coincidem na árvore em que
// ela roda. Esta varredura mede a FORMA, não o sítio: qualquer linha de produção que concatene uma raiz
// com o caminho do pacote da ferramenta é a reintrodução do defeito, e é nomeada aqui.
describe("nenhum sítio de produção deriva a árvore da FERRAMENTA da raiz do alvo", () => {
  it("varre src/ e nomeia arquivo:linha", () => {
    const raizPacote = findToolPackageDir();
    const src = path.join(raizPacote, "src");

    const arquivos: string[] = [];
    const ande = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) ande(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) arquivos.push(p);
      }
    };
    ande(src);

    // Não-vacuidade: uma varredura que não leu nada passa feliz e não mede coisa alguma.
    expect(arquivos.length, "a varredura não encontrou fonte de produção").toBeGreaterThan(200);

    const RAIZES = /\b(repoRoot|findRepoRoot\(\)|targetRoot|opts\.repoRoot|d\.repoRoot)\b/;
    const PACOTE = /packages\/storymap-ui/;
    const ofensores: string[] = [];
    for (const f of arquivos) {
      const linhas = readFileSync(f, "utf8").split("\n");
      linhas.forEach((linha, i) => {
        if (linha.trimStart().startsWith("//") || linha.trimStart().startsWith("*")) return;
        if (RAIZES.test(linha) && PACOTE.test(linha)) {
          ofensores.push(`${path.relative(raizPacote, f)}:${i + 1}  ${linha.trim().slice(0, 120)}`);
        }
      });
    }

    expect(
      ofensores,
      "uma raiz do ALVO concatenada com o pacote da FERRAMENTA. Use findToolPackageDir() — " +
        "sob o cutover essa concatenação aponta para uma cópia que não roda:\n" +
        ofensores.join("\n"),
    ).toEqual([]);
  });
});
