// ATAQUE: apagar o scanner de segredo INTEIRO com um byte.
//
// Um único byte NUL nos primeiros ~8000 bytes de um arquivo faz o `git diff` desistir de apresentá-lo
// como texto: a saída passa a ser só `Binary files … differ`, sem cabeçalho `+++` e sem NENHUMA linha
// `+`. As quatro camadas de regra do pre-commit (prefixo conhecido, atribuição com palavra-chave, nome
// de env que declara credencial, token nu de alta entropia) varrem linhas adicionadas — logo, viram
// no-op de uma vez, e o commit sai VERDE com a credencial sentada depois do NUL. No gate de publicação
// o mesmo byte fazia o arquivo cair na lista de "não varridos", que NÃO reprovava.
//
// A classe não é hipotética neste repositório: `git ls-files --eol | grep '^i/-text'` devolve arquivos
// `.ts`/`.js` de TEXTO que o git JÁ classifica como binários hoje (packages/acmeapp/…/recentSearches.ts,
// intelligent-parser.js, e o packages/storymap-ui/src/lib/auth/next-path.ts que o orquestrador limpou).
// Plantar o byte é uma edição de um caractere.
//
// Os testes abaixo descrevem o ATAQUE, não a implementação: plantam o NUL + um segredo DEPOIS dele e
// exigem que os dois scanners REPROVEM nomeando o arquivo. As não-regressões que os acompanham são as
// duas maneiras de o conserto virar pior que a doença: reprovar binário LEGÍTIMO (png/ico/woff), e
// impedir o commit que REMOVE um NUL já existente (o git reporta binário quando QUALQUER um dos dois
// lados o é — inclusive o lado antigo).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { produtoresDaPublicacao } from "./oss-tree";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SCANNER = path.join(REPO_ROOT, "scripts/git-hooks/scan-secrets.mjs");
const GATE = path.join(REPO_ROOT, "scripts/security/scan-snapshot-secrets.mjs");

/**
 * Credencial PLANTADA, montada em pedaços para o literal DESTA fonte não casar com a regra que ela
 * exercita — senão este arquivo trancaria o pre-commit do próprio repositório.
 */
const PLANTADO = ["AK", "IA", "H4TQ6WZ2XR9MVBND"].join("");

/**
 * O byte que cega o scanner. Construído em RUNTIME de propósito: um NUL literal nesta fonte tornaria
 * ESTE arquivo um dos que o git diffa como binário — o split do merge train já quebrou uma vez por
 * isso. O teste planta o byte no fixture, nunca em si mesmo.
 */
const NUL = String.fromCharCode(0);

// Ambiente de git determinístico: sem config global/sistema do dono da máquina, que poderia declarar
// `*.ts -diff` (ou o contrário) e emprestar ao teste um verde que o artefato não tem.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  // As válvulas de bypass do commit não podem estar ligadas no ambiente de quem roda a suíte, senão
  // TODO teste daqui passa por vacuidade (o scanner devolve 0 antes de olhar o diff).
  SKIP_SECRET_SCAN: "",
  SKIP_PRECOMMIT: "",
  HUSKY_SKIP_HOOKS: "",
};

let temporarios: string[] = [];

afterEach(() => {
  for (const dir of temporarios) rmSync(dir, { recursive: true, force: true });
  temporarios = [];
});

function escreve(dir: string, arquivos: Record<string, string | Buffer>): void {
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo);
  }
}

/** Um repo git novo com os arquivos dados (conteúdo string ou Buffer, para poder conter o NUL). */
function repo(arquivos: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-nul-"));
  temporarios.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { env: GIT_ENV });
  escreve(dir, arquivos);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function commit(dir: string, mensagem: string): void {
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", mensagem]);
}

/** Roda o scanner de pre-commit sobre o repo dado (o mesmo caminho do hook). */
function preCommit(dir: string, args: string[] = ["--staged"]) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], { cwd: dir, encoding: "utf8", env: GIT_ENV });
  return { code: r.status, err: r.stderr ?? "", out: r.stdout ?? "" };
}

/** Roda o gate do snapshot sobre a ÁRVORE do repo dado, devolvendo o relatório JSON. */
function gate(dir: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [GATE, dir, "--json", ...args], { encoding: "utf8", env: GIT_ENV });
  return { code: r.status, rel: JSON.parse(r.stdout || "{}"), err: r.stderr ?? "" };
}

/** PNG de mentira: assinatura real (para a extensão não ser a única pista) + NUL + o segredo. */
function pngComSegredo(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`${NUL}IDAT ${PLANTADO}${NUL}`, "binary"),
  ]);
}

describe("[ATAQUE] byte NUL num arquivo de texto cega o scanner de segredo (story-denyvc)", () => {
  it("pre-commit: `.ts` com NUL e a credencial DEPOIS dele REPROVA o commit", () => {
    // Antes do conserto, este commit saía VERDE (exit 0): o git emite só `Binary files … differ`, então
    // não existe linha `+` para nenhuma das regras olhar.
    const dir = repo({ "src/evil.ts": `const inocente = 1;\n${NUL}\nconst apiKey = "${PLANTADO}";\n` });
    git(dir, ["add", "-A"]);

    const r = preCommit(dir);
    expect(r.code, `esperava REPROVAR; stderr:\n${r.err}`).toBe(2);
    expect(r.err, "o relatório tem de NOMEAR o arquivo — 'algo deu errado' não é acionável").toContain(
      "src/evil.ts",
    );
  });

  it("pre-commit: o NOME do arquivo não-varrido aparece MESMO quando não há segredo nenhum nele", () => {
    // A semântica correta: um arquivo que o scanner não consegue varrer com confiança é um arquivo NÃO
    // VARRIDO, e um gate não pode chamar não-varrido de limpo. Sem isto, o NUL continuaria sendo um
    // pulo silencioso — e bastaria plantar o byte hoje e o segredo no commit seguinte.
    const dir = repo({ "src/mudo.ts": `export const a = 1;\n${NUL}\nexport const b = 2;\n` });
    git(dir, ["add", "-A"]);

    const r = preCommit(dir);
    expect(r.code, `esperava REPROVAR; stderr:\n${r.err}`).toBe(2);
    expect(r.err).toContain("src/mudo.ts");
  });

  it("pre-commit: `pragma: allowlist secret` NÃO desculpa o NUL", () => {
    // O pragma existe para desculpar FALSO-POSITIVO de heurística. Um arquivo que o scanner não pôde
    // ler não é falso-positivo — e se o pragma valesse aqui, o bypass voltaria com um comentário de uma
    // linha escrito por qualquer um (inclusive por um agente tentando destravar o próprio commit).
    const dir = repo({
      "src/evil.ts": `const x = 1; // pragma: allowlist secret\n${NUL}\nconst apiKey = "${PLANTADO}";\n`,
    });
    git(dir, ["add", "-A"]);

    expect(preCommit(dir).code).toBe(2);
  });

  it("merge train (--range): o mesmo bypass num commit JÁ FEITO também reprova", () => {
    // O train varre um RANGE commitado (worktree.ts / release.ts). Se só o caminho `--staged` fechasse,
    // bastaria commitar com SKIP_SECRET_SCAN=1 localmente para o segredo atravessar a integração.
    const dir = repo({ "README.md": "# base\n" });
    git(dir, ["add", "-A"]);
    commit(dir, "base");
    escreve(dir, { "src/evil.ts": `const a = 1;\n${NUL}\nconst apiKey = "${PLANTADO}";\n` });
    git(dir, ["add", "-A"]);
    commit(dir, "ataque");

    const r = preCommit(dir, ["--range", "HEAD~1..HEAD"]);
    expect(r.code, `esperava REPROVAR; stderr:\n${r.err}`).toBe(2);
    expect(r.err).toContain("src/evil.ts");
  });

  it("gate do snapshot: a árvore com o `.ts` envenenado REPROVA nomeando o arquivo e o motivo", () => {
    // Antes do conserto o arquivo caía em `unscanned` com o motivo "binário (byte NUL)" e o gate
    // imprimia "✓ snapshot liberado para publicação".
    const dir = repo({ "src/evil.ts": `const a = 1;\n${NUL}\nconst apiKey = "${PLANTADO}";\n` });

    const { code, rel } = gate(dir);
    expect(code, `esperava REPROVAR; relatório:\n${JSON.stringify(rel, null, 1)}`).toBe(2);
    expect(rel.ok).toBe(false);
    const achados = rel.findings as Array<{ file: string; rule: string }>;
    expect(achados.map((f) => f.file)).toContain("src/evil.ts");
    expect(
      achados.some((f) => /nul/i.test(f.rule)),
      `nenhum achado explica o NUL; regras vistas: ${achados.map((f) => f.rule).join(", ")}`,
    ).toBe(true);
  });

  it("gate do snapshot: o segredo DEPOIS do NUL também é achado (não basta reprovar o arquivo)", () => {
    // Reprovar sem varrer deixaria o operador sem saber se há credencial ali. O conserto varre o
    // conteúdo com as regras normais E reprova pelo NUL — os dois, não um ou outro.
    const dir = repo({ "src/evil.ts": `const a = 1;\n${NUL}\nconst apiKey = "${PLANTADO}";\n` });
    const achados = gate(dir).rel.findings as Array<{ rule: string }>;
    expect(
      achados.some((f) => f.rule === "aws-access-key-id"),
      `a credencial depois do NUL passou batido; achados: ${JSON.stringify(achados)}`,
    ).toBe(true);
  });
});

describe("o conserto do NUL não pode reprovar binário LEGÍTIMO nem travar a limpeza", () => {
  it("um PNG de verdade (com NUL e até com forma de credencial dentro) NÃO gera achado de NUL", () => {
    // A régua é a EXTENSÃO: `.png` é binário POR CONSTRUÇÃO, e reprová-lo tornaria o gate
    // permanentemente vermelho — gate que ninguém roda não protege publicação nenhuma.
    const dir = repo({ "public/icone.png": pngComSegredo() });
    git(dir, ["add", "-A"]);

    expect(preCommit(dir).code, "um PNG bloqueou o commit").toBe(0);
    const { code, rel } = gate(dir);
    expect(code, `um PNG reprovou o gate:\n${JSON.stringify(rel, null, 1)}`).toBe(0);
    // ...e continua REPORTADO como não varrido: o gate não afirma nada sobre o conteúdo dele.
    expect((rel.unscanned as Array<{ file: string }>).map((u) => u.file)).toContain("public/icone.png");
  });

  it("REMOVER um NUL existente continua commitável (o git chama de binário pelo lado ANTIGO)", () => {
    // Medido: com o blob antigo carregando NUL e o novo limpo, `git diff` ainda diz
    // `Binary files a/… and b/… differ`. Um controle que reprovasse "arquivo diffado como binário" sem
    // olhar o conteúdo NOVO tornaria o próprio conserto impossível de commitar.
    const dir = repo({ "src/f.ts": `const a = 1;\n${NUL}\nconst b = 2;\n` });
    git(dir, ["add", "-A"]);
    commit(dir, "sujo");
    escreve(dir, { "src/f.ts": "const a = 1;\nconst b = 2;\n" });
    git(dir, ["add", "-A"]);

    const r = preCommit(dir);
    expect(r.code, `o commit que LIMPA o NUL foi bloqueado; stderr:\n${r.err}`).toBe(0);
  });

  it("uma árvore de texto limpa continua verde nos dois scanners (o controle não é um `exit 2` fixo)", () => {
    const dir = repo({
      "src/util.ts": "export const soma = (a: number, b: number) => a + b;\n",
      "README.md": "# ferramenta\n",
      "vazio.ts": "",
    });
    git(dir, ["add", "-A"]);
    expect(preCommit(dir).code).toBe(0);
    expect(gate(dir).code).toBe(0);
  });
});

describe("`--fail-on-unscanned` distingue ponto cego ESTRUTURAL de ACIDENTAL (story-jxwrsk)", () => {
  it("um arquivo grande demais para o teto de leitura REPROVA sob a flag (é onde um segredo se esconde)", () => {
    const dir = repo({ "src/grande.ts": `export const t = "${"a".repeat(4000)}";\n` });
    const semFlag = gate(dir, ["--max-bytes", "100"]);
    expect(semFlag.code, "sem a flag o não-varrido não reprova (comportamento preservado)").toBe(0);
    expect((semFlag.rel.unscanned as Array<{ file: string }>).map((u) => u.file)).toContain("src/grande.ts");

    const comFlag = gate(dir, ["--max-bytes", "100", "--fail-on-unscanned"]);
    expect(comFlag.code, "a flag tem de reprovar um arquivo que o gate NÃO leu").toBe(2);
  });

  it("binário POR CONSTRUÇÃO não reprova sob a flag — senão a flag é inutilizável e ninguém a liga", () => {
    // É o que destrava o ACHADO B: sem esta distinção, `--fail-on-unscanned` no alvo da publicação
    // nasceria vermelho pelos 21 PNG/ICO do artefato e seria removido na primeira semana.
    const dir = repo({ "public/icone.png": pngComSegredo(), "src/util.ts": "export const a = 1;\n" });
    const r = gate(dir, ["--fail-on-unscanned"]);
    expect(r.code, `PNG reprovou sob a flag:\n${JSON.stringify(r.rel, null, 1)}`).toBe(0);
    // O relatório continua listando o PNG — reconhecido como estrutural, não escondido.
    const png = (r.rel.unscanned as Array<{ file: string; structural?: boolean }>).find(
      (u) => u.file === "public/icone.png",
    );
    expect(png?.structural, "o PNG tem de estar marcado como ponto cego ESTRUTURAL").toBe(true);
  });

  it("[PRODUTOR] TODO produtor de `oss-snapshot-gate` carrega `--fail-on-unscanned`", () => {
    // Sem a flag no produtor, o passo que o runbook nomeia antes do primeiro push público imprime
    // "✓ snapshot liberado para publicação" incluindo arquivos que ele MESMO declara não ter varrido.
    // Confiança falsa exatamente no momento irreversível — pior que gate nenhum.
    //
    // Este caso lia o `justfile` direto — e o justfile NÃO viaja na extração, enquanto este arquivo
    // viaja. No repo público ele morria em ENOENT, e a "correção" óbvia (tolerar a ausência) deixaria o
    // artefato publicado sem NENHUMA cobrança da flag no produtor que ele de fato usa: o passo do
    // workflow em oss/ci/workflows/ci.yml. `produtoresDaPublicacao()` enumera os produtores DA ÁRVORE,
    // então aqui o umbrella passa a cobrar os DOIS e o repo extraído continua cobrando o dele.
    const produtores = produtoresDaPublicacao(REPO_ROOT);
    expect(
      produtores.length,
      `nenhum produtor do gate de publicação nesta árvore — a flag não tem onde estar`,
    ).toBeGreaterThan(0);
    for (const p of produtores) {
      expect(
        p.corpo,
        `${p.nome}: o gate da publicação libera o que não varreu — a flag existe no script e não está ` +
          `no produtor`,
      ).toContain("--fail-on-unscanned");
    }
  });
});
