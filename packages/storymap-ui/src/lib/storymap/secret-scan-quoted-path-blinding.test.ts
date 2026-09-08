// ATAQUE: apagar o scanner de segredo INTEIRO com um caractere NO NOME do arquivo.
//
// Quando o caminho tem um caractere não-ASCII (ou `"`/`\`/controle), o git QUOTA o nome e escapa os
// bytes em octal — e faz isso com sintaxes DIFERENTES nos dois lugares que o scanner lê:
//   `git diff --name-only`  → "pkg/configura\303\247\303\243o.ts"
//   cabeçalho do diff       → +++ "b/pkg/configura\303\247\303\243o.ts"   (a aspa cai FORA do `b/`)
// O regex do cabeçalho exigia `+++ b/…`, então `file` ficava vazio e NENHUMA linha daquele arquivo era
// varrida pelas quatro camadas de regra; a régua de arquivo PROIBIDO comparava `.env.produção"` (com a
// aspa) contra o padrão e não casava; e a rede de COBERTURA do byte NUL — que julga pela ausência de
// linhas no resgate `--text` — recebia o nome com as aspas como pathspec, não casava arquivo nenhum e
// concluía "benigno", o mesmo desfecho de um rename puro.
//
// MEDIDO antes do conserto, nos três casos abaixo: exit 0, commit VERDE, com `AKIA…` no índice. Nenhum
// byte do CONTEÚDO precisava ser especial — bastava renomear o arquivo. É o interruptor geral do
// scanner por outra porta que não o NUL (story-denyvc / story-jxwrsk fecharam a do NUL).
//
// Os testes descrevem o ATAQUE (o nome do arquivo), não a implementação, e vêm com as duas
// não-regressões que fariam o conserto virar pior que a doença: nome com ESPAÇO (que o git separa com
// TAB em vez de quotar) e nome CRU (`core.quotePath=false`, onde desfazer o escape tem de ser no-op).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SCANNER = path.join(REPO_ROOT, "scripts/git-hooks/scan-secrets.mjs");

/** Credencial PLANTADA, montada em pedaços para o literal DESTA fonte não casar com a regra que ela
 *  exercita — senão este arquivo trancaria o pre-commit do próprio repositório. */
const PLANTADO = ["AK", "IA", "R7MQ4XZ2WH9TVBND"].join("");

/** O byte que cega o pre-commit pelo OUTRO caminho (o do NUL). Construído em runtime: um NUL literal
 *  nesta fonte tornaria ESTE arquivo um dos que o git diffa como binário. */
const NUL = String.fromCharCode(0);

/** Nome NÃO-ASCII — é o que faz o git quotar o caminho nas duas saídas. */
const NOME_ACENTUADO = "pkg/configuração.ts";

// Git determinístico: sem config global/de sistema do dono da máquina (que poderia declarar
// `core.quotePath=false` e emprestar ao teste um verde que a instalação do operador não tem), e sem as
// válvulas de bypass ligadas no ambiente de quem roda a suíte (elas fariam o scanner sair 0 antes de
// olhar o diff, e TODO teste daqui passaria por vacuidade).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  SKIP_SECRET_SCAN: "",
  SKIP_PRECOMMIT: "",
  HUSKY_SKIP_HOOKS: "",
};

let temporarios: string[] = [];

afterEach(() => {
  for (const dir of temporarios) rmSync(dir, { recursive: true, force: true });
  temporarios = [];
});

function repo(arquivos: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-quoted-"));
  temporarios.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { env: GIT_ENV });
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo);
  }
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function commit(dir: string, mensagem: string): void {
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", mensagem]);
}

function preCommit(dir: string, args: string[] = ["--staged"]) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], { cwd: dir, encoding: "utf8", env: GIT_ENV });
  return { code: r.status, err: r.stderr ?? "" };
}

describe("[ATAQUE] o NOME do arquivo cega o scanner de segredo (quoting de caminho do git)", () => {
  it("credencial num arquivo de nome NÃO-ASCII REPROVA o commit", () => {
    // Antes do conserto: exit 0. O conteúdo é trivial — a única coisa "especial" é a cedilha no nome.
    const dir = repo({ [NOME_ACENTUADO]: `const chave = "${PLANTADO}";\n` });
    git(dir, ["add", "-A"]);

    const r = preCommit(dir);
    expect(r.code, `esperava REPROVAR; stderr:\n${r.err}`).toBe(2);
    // O relatório precisa nomear o arquivo COMO ELE SE ABRE — um caminho escapado em octal
    // (`configura\303\247\303\243o.ts`) manda o operador procurar um arquivo que não existe.
    expect(r.err, "o caminho saiu escapado, não legível").toContain(NOME_ACENTUADO);
  });

  it("a rede de cobertura do byte NUL não pode concluir 'benigno' por causa do nome", () => {
    // O pior dos dois mundos: o nome quotado esconde o arquivo das quatro camadas, E o NUL faz o git
    // diffá-lo como binário. O resgate `--text` recebia um pathspec inexistente, devolvia vazio, e a
    // ausência de linhas era lida como rename/arquivo vazio — os dois casos benignos.
    const dir = repo({ "pkg/segredo-ção.ts": `const a = 1;\n${NUL}\nconst apiKey = "${PLANTADO}";\n` });
    git(dir, ["add", "-A"]);

    const r = preCommit(dir);
    expect(r.code, `esperava REPROVAR; stderr:\n${r.err}`).toBe(2);
    expect(r.err).toContain("pkg/segredo-ção.ts");
    expect(r.err, "o achado de COBERTURA do NUL não saiu para o arquivo de nome quotado").toContain(
      "nul-in-text-file",
    );
  });

  it("arquivo PROIBIDO por nome (`.env.local`) não escapa por estar numa pasta com acento", () => {
    // Esta régua é por NOME, não por conteúdo: ela existe porque `.gitignore` se contorna com `add -f`.
    // O basename é ASCII e casa o padrão — mas basta um acento em QUALQUER componente do caminho para o
    // git quotar a linha inteira, e aí o `basename` que a régua compara terminava numa ASPA.
    const dir = repo({ "configuração/.env.local": "X=1\n" });
    git(dir, ["add", "-f", "configuração/.env.local"]);

    const r = preCommit(dir);
    expect(r.code, `esperava REPROVAR; stderr:\n${r.err}`).toBe(2);
    expect(r.err).toContain("secret-file");
  });

  it("merge train (--range): o mesmo bypass num commit JÁ FEITO também reprova", () => {
    // O train varre um RANGE commitado. Se só o `--staged` fechasse, bastaria commitar com
    // SKIP_SECRET_SCAN=1 localmente para a credencial atravessar a integração.
    const dir = repo({ "README.md": "# base\n" });
    git(dir, ["add", "-A"]);
    commit(dir, "base");
    mkdirSync(path.join(dir, path.dirname(NOME_ACENTUADO)), { recursive: true });
    writeFileSync(path.join(dir, NOME_ACENTUADO), `const chave = "${PLANTADO}";\n`);
    git(dir, ["add", "-A"]);
    commit(dir, "ataque");

    const r = preCommit(dir, ["--range", "HEAD~1..HEAD"]);
    expect(r.code, `esperava REPROVAR; stderr:\n${r.err}`).toBe(2);
    expect(r.err).toContain(NOME_ACENTUADO);
  });
});

describe("desfazer o quoting não pode quebrar os nomes que o git NÃO quota", () => {
  it("nome com ESPAÇO (que o git separa com TAB) reprova e sai com o caminho abrível", () => {
    // Para um caminho com espaço o git não quota: ele emite `+++ b/my cfg.ts\t`. O tab não pode viajar
    // para o relatório (ninguém abre `my cfg.ts\t`) nem virar um segundo nome para o mesmo arquivo.
    const dir = repo({ "pkg/my cfg.ts": `const chave = "${PLANTADO}";\n` });
    git(dir, ["add", "-A"]);

    const r = preCommit(dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("pkg/my cfg.ts:1");
  });

  it("com `core.quotePath=false` (nome já cru) o scanner segue reprovando", () => {
    // A régua é a FORMA da saída do git, não uma config: se o operador desliga o quoting, desfazer o
    // escape tem de ser no-op — e não pode comer as aspas de um nome que legitimamente as tenha.
    const dir = repo({ [NOME_ACENTUADO]: `const chave = "${PLANTADO}";\n` });
    git(dir, ["config", "core.quotePath", "false"]);
    git(dir, ["add", "-A"]);

    const r = preCommit(dir);
    expect(r.code, `esperava REPROVAR; stderr:\n${r.err}`).toBe(2);
    expect(r.err).toContain(NOME_ACENTUADO);
  });

  it("uma árvore de nomes ASCII e limpa continua VERDE (o controle não é um `exit 2` fixo)", () => {
    const dir = repo({ "src/util.ts": "export const soma = (a: number, b: number) => a + b;\n" });
    git(dir, ["add", "-A"]);
    expect(preCommit(dir).code).toBe(0);
  });
});
