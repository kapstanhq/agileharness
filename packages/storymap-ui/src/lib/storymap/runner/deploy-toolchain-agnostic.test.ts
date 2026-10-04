// O RATCHET DO DEPLOY AGNÓSTICO — o motor de publicação não supõe o ferramental de publicação de nenhum alvo.
//
// POR QUE EXISTE. Um motor de deploy escrito ao lado de UM alvo tende a herdar os defaults dele: o executor de tarefas, o
// verbo do orquestrador, a receita de publicar um app, o caminho do arquivo de estado, o prefixo de pasta de pacotes. Tudo
// isso é DECLARAÇÃO do alvo (settings.yaml → `deploy:`, ver deploy-policy.ts), e sem declaração o motor RECUSA dizendo a
// chave. Duas varreduras: o CÓDIGO do motor (por linha, comentários fora) contra literais de ferramental, com exceções
// NOMEADAS; e TODO o `src` (código, comentário, título de teste, fixture) contra os nomes de um ferramental alheio —
// comparados por sha256 (__fixtures__/origin-toolchain-words.ts — a lista não traz os nomes), com exceções VAZIA.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORIGIN_STATE_PATH_HASHES, ORIGIN_TOOLCHAIN_HASHES, adjacentPairs, hitsHashed } from "./__fixtures__/origin-toolchain-words";

/** o código SEM comentários de bloco, de linha inteira nem de fim de linha (`  // …`). */
function codeLines(abs: string): { n: number; text: string }[] {
  const semBloco = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return semBloco
    .split("\n")
    .map((text, i) => ({ n: i + 1, text: text.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, "") }))
    .filter((l) => l.text.trim().length > 0);
}

const RUNNER = (f: string) => path.join(__dirname, f);
const DEV_TOOLS = path.join(__dirname, "..", "mcp", "dev-tools.ts");

/** Os arquivos do motor de deploy que NÃO podem supor o ferramental do alvo. */
const ARQUIVOS = [
  "deploy-command-guard.ts",
  "product-deploy.ts",
  "deploy.ts",
  "deploy-reconcile.ts",
  "deploy-freshness.ts",
  "deploy-proof.ts",
  "deploy-needs-human.ts",
  "deploy-blocks.ts",
  "face-probe.ts",
  "entry-effects.ts",
  // As mensagens ao operador também são código que publica: elas mandam rodar «o comando de deploy do alvo», nunca uma
  // receita de um alvo em particular.
  "pending-effects.ts",
  "findings.ts",
];

/** O que nenhuma linha de código dos arquivos acima pode conter. */
const PROIBIDOS: { nome: string; hit: (line: string) => boolean }[] = [
  { nome: "o nome de um ferramental de publicação alheio", hit: (l) => hitsHashed(l, ORIGIN_TOOLCHAIN_HASHES) },
  { nome: "um caminho de estado de orquestrador como literal", hit: (l) => hitsHashed(l, ORIGIN_STATE_PATH_HASHES) },
  { nome: "um executor de tarefas como literal", hit: (l) => /["'`]just["'`]/.test(l) },
  { nome: "um prefixo de pasta de pacotes como literal", hit: (l) => /["'`]packages\//.test(l) },
];

/**
 * As EXCEÇÕES, por arquivo e por padrão de linha — cada uma com o porquê:
 *  - `KNOWN_TASK_RUNNERS` (deploy-command-guard.ts): a lista de NOMES que alimenta só o LINT de segurança (aviso alto quando
 *    um lançador declarado é task runner conhecido e não está em `recipeRunners`). Não é default nem allow-list: nenhum
 *    lançador entra na política por estar nela — a ferramenta continua sem supor o executor do alvo.
 *  - `TOOL_PACKAGE_REL`: o acoplamento da ferramenta ao layout do alvo para o self-deploy — pertence ao item de layout do
 *    lote D, não ao ferramental de deploy; fica nomeado aqui para não ser esquecido.
 */
const EXCECOES: Record<string, RegExp[]> = {
  "deploy-command-guard.ts": [/KNOWN_TASK_RUNNERS: ReadonlySet<string> = new Set\(/],
  "deploy.ts": [/TOOL_PACKAGE_REL = "packages\/storymap-ui"/],
};

describe("deploy agnóstico: nenhum literal do ferramental de origem no CÓDIGO do motor", () => {
  it("a varredura enxerga código (não é vácua)", () => {
    for (const f of ARQUIVOS) expect(codeLines(RUNNER(f)).length, f).toBeGreaterThan(20);
    // a identidade observável do caminho do comando declarado é um nome NEUTRO da ferramenta — nunca o lançador do alvo
    const deploy = codeLines(RUNNER("deploy.ts")).filter((l) => /tool: "legacy-command"/.test(l.text));
    expect(deploy.length, "a identidade `tool: \"legacy-command\"` sumiu do deploy.ts ⇒ a varredura perdeu a âncora").toBeGreaterThan(0);
  });

  it("a varredura cobre as mensagens ao operador (pending-effects.ts e findings.ts) — tirá-los da lista reabre o buraco", () => {
    expect(ARQUIVOS).toEqual(expect.arrayContaining(["pending-effects.ts", "findings.ts"]));
  });

  for (const { nome, hit } of PROIBIDOS) {
    it(`proíbe ${nome}`, () => {
      const achados: string[] = [];
      for (const f of ARQUIVOS) {
        for (const l of codeLines(RUNNER(f))) {
          if (!hit(l.text)) continue;
          if ((EXCECOES[f] ?? []).some((ex) => ex.test(l.text))) continue;
          achados.push(`${f}:${l.n}: ${l.text.trim().slice(0, 120)}`);
        }
      }
      expect(achados, `${nome} voltou ao código — declare em settings.yaml → deploy.… e leia de deployPolicyOf`).toEqual([]);
    });
  }

  it("as tools de deploy do MCP (deploy_plan, deploy, deploy_status) também não supõem o ferramental", () => {
    // a seção de deploy do dev-tools vai de «===== DEPLOY» até «===== SELF-UPDATE»; o resto do arquivo (run_check, git…) é de outros itens
    const todas = codeLines(DEV_TOOLS);
    const bruto = readFileSync(DEV_TOOLS, "utf8").split("\n");
    const ini = bruto.findIndex((l) => l.includes("===== DEPLOY"));
    const fim = bruto.findIndex((l) => l.includes("===== SELF-UPDATE"));
    expect(ini).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(ini);
    const secao = todas.filter((l) => l.n > ini && l.n <= fim);
    expect(secao.length, "a seção de deploy sumiu da varredura").toBeGreaterThan(40);
    const achados = secao.flatMap((l) => PROIBIDOS.filter((p) => p.hit(l.text)).map((p) => `dev-tools.ts:${l.n}: ${p.nome}`));
    expect(achados).toEqual([]);
  });
});

// TODO o src — código, comentário, título de teste, fixture: um nome de ferramental alheio não entra em lugar nenhum.
describe("deploy agnóstico: nenhum nome de ferramental alheio em TODO o src (comentários e testes inclusive)", () => {
  const SRC = path.join(__dirname, "..", "..", "..");
  /** os arquivos de texto do src (o módulo dos hashes não contém os nomes, então não é exceção). */
  function arquivos(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(p);
      return /\.(ts|tsx|js|mjs|json|txt|md|jsonl|yaml|yml)$/.test(e.name) ? [p] : [];
    });
  }
  const EXCECOES_SRC: readonly string[] = [];

  it("a varredura enxerga o src inteiro e o comparador funciona (não é vácua)", () => {
    expect(arquivos(SRC).length).toBeGreaterThan(500);
    expect(ORIGIN_TOOLCHAIN_HASHES.size).toBe(3);
    // os pares adjacentes saem de tokens compostos, em qualquer posição do token
    expect(adjacentPairs("rode ship-cli push-app agora; ops/estado/x")).toEqual(["ship-cli", "push-app", "ops/estado", "estado/x"]);
    expect(adjacentPairs("a-b-c")).toEqual(["a-b", "b-c"]);
    // um par inventado não casa; o comparador é por hash exato do par
    expect(hitsHashed("deploy-autonomy e relay-push", ORIGIN_TOOLCHAIN_HASHES)).toBe(false);
  });

  it("nenhum arquivo do src contém um desses nomes — e a lista de exceções está vazia", () => {
    expect(EXCECOES_SRC).toEqual([]);
    const achados: string[] = [];
    for (const f of arquivos(SRC)) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((l, i) => {
          if (hitsHashed(l, ORIGIN_TOOLCHAIN_HASHES)) achados.push(`${path.relative(SRC, f)}:${i + 1}`);
        });
    }
    expect(achados, "troque por «o comando de deploy declarado» (ou um nome inventado de fixture)").toEqual([]);
  });
});
