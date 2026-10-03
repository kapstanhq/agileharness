// POR QUE este arquivo existe.
//
// O scan de segredo bloqueou 26 releases seguidos com FALSO POSITIVO — e o que ele acusava era
// COMENTÁRIO EM PORTUGUÊS falando sobre credenciais. A causa: os delimitadores de string eram duas
// classes INDEPENDENTES, então a expressão aceitava ABRIR numa crase e FECHAR numa aspa dupla. Numa
// string literal isso nunca acontece; em prosa acontece o tempo todo, porque a crase é markdown de
// trecho de código:
//
//   it("COMPATIBILIDADE: `?secret=` continua funcionando e ANUNCIA a depreciação…", …)
//
// O "valor" capturado virava a frase inteira. Num repositório cuja documentação de segurança fala
// sobre segredos em quase toda página, isso reprova tudo — e a saída natural de quem topa com um gate
// assim é DESLIGAR o gate. Precisão não é conforto: é o que mantém o controle ligado.
//
// O QUE ESTE ARQUIVO PROVA — e o que NÃO prova. Ele crava que a versão ATUAL do scanner ignora prosa
// E pega credencial real no mesmo lance. Ele NÃO isola a correção de simetria de aspas: medido, os
// casos aqui ficam verdes com e sem ela, porque a régua de forma do `looksLikeSecretValue` já barra
// prosa a jusante. Quem reprovou os 26 releases foi `main` rodando uma versão DEFASADA do scanner.
// Dito explicitamente para ninguém ler estes casos como prova de uma causa que eles não medem.
//
// CONSTRUÇÃO DOS CASOS — cada arquivo de prosa vai junto com uma credencial REAL de controle, e o
// teste exige que a credencial seja PEGA no mesmo lance em que a prosa é ignorada. Sem esse controle
// positivo, um scanner que simplesmente não rodasse (repo sem HEAD, diff vazio, caminho errado)
// deixaria todos os `not.toContain` verdes sem medir nada — foi o que aconteceu na primeira versão
// deste arquivo.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCANNER = path.resolve(__dirname, "../../../../../../scripts/git-hooks/scan-secrets.mjs");

// Credenciais sintéticas com a FORMA do real — sorteio de mentira, válidas em lugar nenhum.
//
// Elas NÃO podem carregar um marcador `FAKE`/`EXAMPLE` no valor (o caminho normal para fixture),
// porque a função destas constantes é ser o CONTROLE POSITIVO: o scanner precisa detectá-las para o
// teste provar que ignorou a prosa sem ter ficado cego. Um marcador as tornaria invisíveis e devolveria
// a vacuidade que este arquivo existe para evitar. Daí o pragma — é exatamente o caso que ele serve.
const CRED_APIKEY = "Xq7RmT2vB9nLpK4wZa8YcE3sH6dJ1fGu"; // pragma: allowlist secret
const CRED_TOKEN = "Zb4Nq8Wp2Ke6Ty1Ru9Mx3Vd7Hj5Lf0Ac"; // pragma: allowlist secret

/**
 * Repo temporário NOVO a cada chamada, com um commit inicial — sem HEAD o `--staged` compara contra
 * nada e a saída sai vazia, que é precisamente como um teste destes passa sem medir.
 */
function escanear(arquivos: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), "scan-prose-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q", ".");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(path.join(repo, ".keep"), "");
    git("add", "-A");
    git("commit", "-q", "-m", "base", "--no-verify");

    for (const [nome, conteudo] of Object.entries(arquivos)) writeFileSync(path.join(repo, nome), conteudo);
    git("add", "-A");
    // O scanner é um HOOK: o relatório sai em stderr, não em stdout. `execFileSync` devolve só o
    // stdout, então ler apenas ele dá string VAZIA — e uma string vazia faz todo `not.toContain`
    // passar sem medir nada. Foi assim que a primeira versão deste arquivo ficou verde por vacuidade.
    const r = spawnSync(process.execPath, [SCANNER, "--staged"], { cwd: repo, encoding: "utf8" });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("scan de segredo — precisão sobre PROSA (o que reprovou 26 releases)", () => {
  it("um comentário que MENCIONA `?secret=` não é achado — e a credencial ao lado É", () => {
    const saida = escanear({
      "route.ts":
        "// `?secret=` segue aceito e DEPRECADO — a query vaza em log de acesso, em `Referer` e em\n" +
        "// histórico de proxy. A query permanece porque o EventSource nativo não manda header.\n",
      "cfg.js": `const a = { apiKey: "${CRED_APIKEY}" };\n`,
    });
    expect(saida, "o controle positivo não disparou — o scanner não rodou e o caso passaria vazio").toContain("cfg.js");
    expect(saida, "comentário em PT-BR sobre credenciais virou achado — o gate reprova a própria documentação").not.toContain("route.ts");
  });

  it("o NOME de um teste que cita `?secret=` não é achado — e a credencial ao lado É", () => {
    const saida = escanear({
      "route.test.ts":
        'it("COMPATIBILIDADE: `?secret=` continua funcionando e ANUNCIA a depreciação uma vez, sem o valor", () => {});\n',
      "t.js": `const t = { AGILEHARNESS_MCP_TOKEN: "${CRED_TOKEN}" };\n`,
    });
    expect(saida, "o controle positivo não disparou").toContain("t.js");
    expect(saida).not.toContain("route.test.ts");
  });

  it("[ATAQUE] a correção NÃO afrouxou: credencial entre aspas SIMÉTRICAS segue sendo pega", () => {
    expect(escanear({ "cfg.js": `const a = { apiKey: "${CRED_APIKEY}" };\n` })).toContain("hardcoded-secret");
  });

  it("[ATAQUE] o token do PRÓPRIO produto segue sendo pego", () => {
    expect(escanear({ "t.js": `const t = { AGILEHARNESS_MCP_TOKEN: "${CRED_TOKEN}" };\n` })).toContain("env-credential");
  });

  it("[ATAQUE] a régua é a SIMETRIA, não a crase: abrir e fechar na mesma crase segue sendo credencial", () => {
    expect(escanear({ "tpl.js": `const apiKey = \`${CRED_APIKEY}\`;\n` })).toContain("hardcoded-secret");
  });
});
