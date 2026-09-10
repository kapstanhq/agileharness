// ATAQUE: esconder a credencial no ÚNICO diretório que o scanner se recusa a ler.
//
// As regras do pre-commit pulam por desenho o diretório das próprias definições (`scripts/git-hooks/`),
// senão os padrões se auto-acusariam. O gate do snapshot DESCOBRIA essa cegueira (manda um token sintético
// pelo caminho e vê se o achado volta) e a classificava como ponto cego ESTRUTURAL — "não existe texto para
// varrer, e nenhuma ação do operador muda isso". Mas ali o texto EXISTE: foram as REGRAS que decidiram não
// olhar. Efeito medido: um `AKIA…` plantado em `scripts/git-hooks/scan-secrets.mjs` — arquivo que VIAJA para
// o repo público, porque a antiga lista de extração o re-incluía explicitamente — não produzia achado nenhum e o gate
// liberava com exit 0, INCLUSIVE com `--fail-on-unscanned`. Era o único caminho cego do artefato, e
// justamente aquele onde um segredo ficaria mais invisível: quem lê o diff vê um arquivo de padrões.
//
// O remédio não é reclassificar o pulo (isso só trocaria um verde silencioso por um vermelho permanente que
// ninguém consegue resolver): é VARRER. A cegueira é uma régua de PREFIXO DE CAMINHO, e quem monta o caminho
// do diff sintético é o próprio gate — então ele re-apresenta o mesmo conteúdo sob um rótulo que a régua não
// pula e mapeia o achado de volta para o caminho real.
//
// Estes testes medem pelo DESFECHO do gate (exit code + o caminho que ele nomeia), nunca pela existência do
// rótulo: o rótulo é detalhe interno e trocá-lo não pode quebrar o teste — esconder um segredo, sim.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const GATE = path.join(REPO_ROOT, "scripts/security/scan-snapshot-secrets.mjs");

/** O diretório que as regras do pre-commit pulam (`SELF_DIR` em scan-secrets.mjs). */
const DIR_CEGO = "scripts/git-hooks";

// Credencial PLANTADA, montada em pedaços para o literal desta fonte não casar com a regra que ela
// exercita (senão este arquivo trancaria o pre-commit do repositório).
const PLANTADO = ["AK", "IA", "R4XD9TM2VQ7WZBNK"].join("");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

let snapshots: string[] = [];

afterEach(() => {
  for (const dir of snapshots) rmSync(dir, { recursive: true, force: true });
  snapshots = [];
});

/** Um snapshot de publicação de mentira: repo git novo (como a extração o monta) com os arquivos dados. */
function snapshot(arquivos: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-cego-"));
  snapshots.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { env: GIT_ENV });
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo, "utf8");
  }
  return dir;
}

interface Relatorio {
  ok: boolean;
  scannedFiles: number;
  findings: { rule: string; file: string; line: number }[];
  unscanned: { file: string; reason: string; structural: boolean }[];
  unscannedAccidental: number;
}

function roda(dir: string, args: string[] = []): { code: number | null; rel: Relatorio } {
  const r = spawnSync(process.execPath, [GATE, dir, "--json", ...args], { encoding: "utf8", env: GIT_ENV });
  return { code: r.status, rel: JSON.parse(r.stdout) as Relatorio };
}

describe("gate do snapshot: o caminho que as REGRAS pulam continua sendo varrido", () => {
  it("[ATAQUE] segredo plantado no diretório cego REPROVA a publicação", () => {
    const dir = snapshot({
      [`${DIR_CEGO}/scan-secrets.mjs`]: `// regras\nconst chave = '${PLANTADO}';\nexport { chave };\n`,
      "app/index.ts": "export const nome = 'ferramenta';\n",
    });

    const { code, rel } = roda(dir);

    expect(code, "o segredo escondido no diretório das próprias regras passou pelo gate de publicação").toBe(2);
    // O achado nomeia o caminho REAL: o operador precisa saber qual arquivo rotacionar, e a allowlist casa
    // por `path` — um rótulo interno vazando aqui tornaria o baseline inexpressável.
    expect(rel.findings.map((f) => f.file)).toContain(`${DIR_CEGO}/scan-secrets.mjs`);
    expect(rel.findings.every((f) => !f.file.includes("__")), "o rótulo interno vazou para o relatório").toBe(true);
  });

  it("o arquivo do caminho cego deixou de ser 'não varrido' — ele passou a ser CONTADO como varrido", () => {
    const limpo = snapshot({
      [`${DIR_CEGO}/scan-secrets.mjs`]: "// só padrões, nada de segredo\nexport const RE = /x/;\n",
      "app/index.ts": "export const nome = 'ferramenta';\n",
    });

    const { code, rel } = roda(limpo, ["--fail-on-unscanned"]);

    expect(code, "um arquivo LIMPO no caminho cego não pode reprovar — isso seria vermelho permanente").toBe(0);
    expect(
      rel.unscanned.map((u) => u.file),
      "o caminho cego voltou a ser reportado como não varrido em vez de ser varrido sob rótulo",
    ).not.toContain(`${DIR_CEGO}/scan-secrets.mjs`);
    expect(rel.scannedFiles).toBe(2);
  });

  it("a régua do NOME também alcança o caminho cego (um `.env` plantado ali não escapa)", () => {
    // A regra de arquivo-proibido é por NOME, e ela pulava o mesmo diretório. Sem apresentar o nome sob o
    // rótulo, um `.env` plantado no diretório das regras entraria no commit único que É o artefato.
    const dir = snapshot({
      [`${DIR_CEGO}/.env`]: "TOKEN=qualquer-coisa\n",
      "app/index.ts": "export const nome = 'ferramenta';\n",
    });

    const { code, rel } = roda(dir);

    expect(code).toBe(2);
    expect(rel.findings.map((f) => f.file)).toContain(`${DIR_CEGO}/.env`);
  });

  it("nenhum pulo do relatório se declara ESTRUTURAL por 'as regras não olham' (a definição não admite)", () => {
    // ESTRUTURAL significa "não existe texto para varrer" (um PNG é um PNG). Um caminho que as regras
    // escolheram não ler tem texto — chamá-lo de estrutural era o que fazia `--fail-on-unscanned` liberar
    // em silêncio. Se algum dia um caminho ficar cego mesmo sob rótulo, ele é ACIDENTAL e reprova.
    const dir = snapshot({
      [`${DIR_CEGO}/scan-secrets.mjs`]: "export const RE = /x/;\n",
      "app/logo.png": "PNG-de-mentira-sem-NUL\n",
    });

    const { rel } = roda(dir);

    expect(rel.unscanned.filter((u) => u.structural && /regras|desenho/.test(u.reason))).toEqual([]);
  });
});
