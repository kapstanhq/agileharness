// O RATCHET DO DEPLOY AGNÓSTICO — o motor de publicação não supõe o ferramental do repositório onde a ferramenta nasceu.
//
// POR QUE EXISTE. O deploy carregava defaults daquele repositório: o executor de tarefas (`just`), o verbo do orquestrador
// de deploy, a receita de publicar um app, o caminho do arquivo de estado (`scripts/deploy/state/…`), o prefixo `packages/`.
// Tudo isso agora é DECLARAÇÃO do alvo (settings.yaml → `deploy:`, ver deploy-policy.ts), e sem declaração o motor RECUSA
// dizendo a chave. Este teste varre o CÓDIGO (comentários não contam: prosa não publica nada) e reprova se um desses
// literais voltar — é a catraca que impede o suposto de crescer de novo por acréscimo.
//
// A varredura é por LINHA DE CÓDIGO e a lista de exceções é NOMEADA e mínima: cada uma diz por que continua.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
  // As mensagens ao operador também são código que publica: duas delas ainda mandavam «harness-ship / just orch-deploy»
  // (a receita do repositório de origem) em vez de «o comando de deploy do alvo».
  "pending-effects.ts",
  "findings.ts",
];

/** O que nenhuma linha de código dos arquivos acima pode conter. */
const PROIBIDOS: { nome: string; re: RegExp }[] = [
  { nome: "o verbo do orquestrador de deploy do repositório de origem", re: /orch-deploy/ },
  { nome: "o verbo do plano do orquestrador de origem", re: /orch-plan/ },
  { nome: "o caminho do estado do orquestrador de origem", re: /scripts\/deploy/ },
  { nome: "o executor de tarefas do repositório de origem como literal", re: /["'`]just["'`]/ },
  { nome: "o prefixo de pasta de pacotes do repositório de origem", re: /["'`]packages\// },
];

/**
 * As EXCEÇÕES, por arquivo e por padrão de linha — cada uma com o porquê:
 *  - `tool: "orch-deploy"` / a união de `tool?:` em deploy.ts: é uma IDENTIDADE OPACA e observável (eventos, testes,
 *    deploy_status), não um comando; renomeá-la é um card à parte. O que deixou de ser suposto é o COMANDO.
 *  - `KNOWN_TASK_RUNNERS` (deploy-command-guard.ts): a lista de NOMES que alimenta só o LINT de segurança (aviso alto quando
 *    um lançador declarado é task runner conhecido e não está em `recipeRunners`). Não é default nem allow-list: nenhum
 *    lançador entra na política por estar nela — a ferramenta continua sem supor o executor do alvo.
 *  - `TOOL_PACKAGE_REL`: o acoplamento da ferramenta ao layout do alvo para o self-deploy — pertence ao item de layout do
 *    lote D, não ao ferramental de deploy; fica nomeado aqui para não ser esquecido.
 */
const EXCECOES: Record<string, RegExp[]> = {
  "deploy-command-guard.ts": [/KNOWN_TASK_RUNNERS: ReadonlySet<string> = new Set\(/],
  "deploy.ts": [/tool\??: .*"orch-deploy"/, /\{ tool: "orch-deploy"/, /^\s*tool: "orch-deploy",?\s*$/, /TOOL_PACKAGE_REL = "packages\/storymap-ui"/],
};

describe("deploy agnóstico: nenhum literal do ferramental de origem no CÓDIGO do motor", () => {
  it("a varredura enxerga código (não é vácua)", () => {
    for (const f of ARQUIVOS) expect(codeLines(RUNNER(f)).length, f).toBeGreaterThan(20);
    // a prova de que o filtro de comentário funciona e a exceção nomeada é a única presença: a identidade opaca existe
    const deploy = codeLines(RUNNER("deploy.ts")).filter((l) => /orch-deploy/.test(l.text));
    expect(deploy.length, "a identidade opaca `tool: \"orch-deploy\"` some do deploy.ts ⇒ atualize as exceções").toBeGreaterThan(0);
  });

  it("a varredura cobre as mensagens ao operador (pending-effects.ts e findings.ts) — tirá-los da lista reabre o buraco", () => {
    expect(ARQUIVOS).toEqual(expect.arrayContaining(["pending-effects.ts", "findings.ts"]));
  });

  for (const { nome, re } of PROIBIDOS) {
    it(`proíbe ${nome}`, () => {
      const achados: string[] = [];
      for (const f of ARQUIVOS) {
        for (const l of codeLines(RUNNER(f))) {
          if (!re.test(l.text)) continue;
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
    const achados = secao.flatMap((l) => PROIBIDOS.filter((p) => p.re.test(l.text)).map((p) => `dev-tools.ts:${l.n}: ${p.nome}`));
    expect(achados).toEqual([]);
  });
});
