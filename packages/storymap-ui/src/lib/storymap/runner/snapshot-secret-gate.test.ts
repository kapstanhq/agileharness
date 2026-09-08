// Testes do GATE DO SNAPSHOT DE PUBLICAÇÃO (`scripts/security/scan-snapshot-secrets.mjs`, story-jxwrsk).
//
// O que está sob teste é um ATAQUE, não uma implementação: o único controle de segredo do repo hoje é
// `pre-commit.sh` → `scan-secrets.mjs --staged`, que vê **o índice**. Num repo OSS novo (1 commit,
// `git init`, zero hooks) o artefato publicado é a ÁRVORE — e tudo que já está na árvore/no histórico é
// invisível para `--staged`. Cada teste abaixo planta o segredo na ÁRVORE e cobra do gate o que o
// controle de commit estruturalmente não entrega.
//
// Colocado sob storymap-ui (como `scan-secrets.test.ts`) porque é `just test-storymap` que roda os testes
// dos scripts compartilhados da raiz.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GATE = fileURLToPath(new URL("../../../../../../scripts/security/scan-snapshot-secrets.mjs", import.meta.url));
const PRE_COMMIT_SCANNER = fileURLToPath(
  new URL("../../../../../../scripts/git-hooks/scan-secrets.mjs", import.meta.url),
);

// Credencial PLANTADA, montada em pedaços: o literal desta fonte NÃO casa com a regra que ela exercita,
// senão este próprio arquivo trancaria o pre-commit do repo. 20 chars → máscara esperada `(20 chars)`.
const PLANTADO = ["AK", "IA", "ZQ7X4M2LP9WT6BND"].join("");
const PLANTADO_2 = ["AK", "IA", "H4T8VC3RN6KQ2MZY"].join("");
// O miolo (sem o prefixo de 4 e o sufixo de 2 que a máscara revela de propósito): NADA disso pode
// aparecer em stdout/stderr — a saída do gate vai para log de CI.
const MIOLO = PLANTADO.slice(4, -2);

// git isolado da config global/sistema da máquina, senão um `core.excludesFile` do usuário mudaria o
// que `--exclude-standard` considera ignorado e o teste passaria/falharia por acidente de ambiente.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

// O contrato de `--json` que o CI consome. Achado carrega SÓ o valor mascarado (`preview`) — não existe
// campo com o valor bruto, e é isso que impede o segredo de vazar para log por descuido de formatação.
type Achado = { rule: string; file: string; line: number; preview: string; hash: string; reason?: string };
type Relatorio = {
  ok: boolean;
  root: string;
  today: string;
  totalFiles: number;
  scannedFiles: number;
  allowlist: string;
  allowlistExists: boolean;
  findings: Achado[];
  allowlisted: Achado[];
  staleAllowlist: { path: string; rule: string | null; hash: string; reason: string }[];
  // `structural` é a régua que `--fail-on-unscanned` julga: ESTRUTURAL = não existe texto para ler e
  // nenhuma ação do operador muda isso (um PNG é um PNG); ACIDENTAL = o gate TERIA lido e algo
  // atravessou (teto de `--max-bytes`, não-regular, só no índice). A flag reprova só o acidental.
  unscanned: { file: string; reason: string; structural: boolean }[];
  unscannedAccidental: number;
};

let repo = "";

function write(rel: string, content: string) {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

/** Roda o gate sobre o snapshot. Nunca lança: o exit code É a asserção. */
function gate(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [GATE, repo, ...args], {
    encoding: "utf8",
    env: { ...GIT_ENV, ...extraEnv },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function gateJson(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const r = gate(["--json", ...args], extraEnv);
  let parsed: Relatorio;
  try {
    parsed = JSON.parse(r.out) as Relatorio;
  } catch {
    throw new Error(`--json não devolveu JSON. code=${r.code}\nstdout:${r.out}\nstderr:${r.err}`);
  }
  return { ...r, json: parsed };
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "snapshot-gate-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { env: GIT_ENV });
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = "";
});

describe("gate do snapshot — o que o pre-commit --staged não vê", () => {
  it("ATAQUE: segredo que JÁ ESTÁ na árvore passa batido no scanner --staged e é BLOQUEADO pelo gate", () => {
    write("src/config.ts", `export const cfg = { k: "${PLANTADO}" };\n`);

    // O controle existente olha o ÍNDICE: com nada staged, o diff é vazio → verde, sem ver a árvore.
    const preCommit = spawnSync(process.execPath, [PRE_COMMIT_SCANNER, "--staged"], {
      cwd: repo,
      encoding: "utf8",
      env: GIT_ENV,
    });
    expect(preCommit.status).toBe(0);

    // O gate do snapshot varre a ÁRVORE → bloqueia.
    const r = gateJson();
    expect(r.code).toBe(2);
    expect(r.json.ok).toBe(false);
    expect(r.json.findings.map((f) => f.file)).toContain("src/config.ts");
    expect(r.json.findings[0].line).toBe(1);
  });

  it("MASCARA o valor: nem stdout nem stderr contêm o segredo (a saída vai para log)", () => {
    write("src/config.ts", `export const cfg = { k: "${PLANTADO}" };\n`);

    const texto = gate();
    expect(texto.code).toBe(2);
    expect(texto.out + texto.err).not.toContain(PLANTADO);
    expect(texto.out + texto.err).not.toContain(MIOLO);
    expect(texto.out).toContain("(20 chars)"); // prefixo + comprimento, o suficiente para achar à mão

    const j = gateJson();
    expect(JSON.stringify(j.json)).not.toContain(PLANTADO);
    expect(JSON.stringify(j.json)).not.toContain(MIOLO);
    expect(j.json.findings[0].preview).toMatch(/\(20 chars\)$/);
  });

  it("uma linha de conteúdo que começa com `++` NÃO esconde o segredo do gate", () => {
    // `+`-prefixar essa linha produziria `+++…`, que o parser de diff do scanner descarta — um cego
    // onde caberia um segredo e que também desalinharia a numeração do resto do arquivo.
    write("docs/notas.md", `linha um\n++ acrescentado: ${PLANTADO}\nlinha tres\n`);
    const r = gateJson();
    expect(r.code).toBe(2);
    expect(r.json.findings.map((f) => f.file)).toContain("docs/notas.md");
    expect(r.json.findings[0].line).toBe(2);
  });

  it("um .env NA ÁRVORE é bloqueado por nome (não só quando alguém o stageia)", () => {
    write(".env", "FOO=bar\n");
    const r = gateJson();
    expect(r.code).toBe(2);
    expect(r.json.findings.some((f) => f.rule === "secret-file" && f.file === ".env")).toBe(true);
  });

  it("árvore limpa → exit 0", () => {
    write("src/util.ts", "export const sum = (a: number, b: number) => a + b;\n");
    write("README.md", "# projeto\n");
    const r = gateJson();
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.findings).toHaveLength(0);
    expect(r.json.scannedFiles).toBeGreaterThan(0);
  });
});

describe("gate do snapshot — não pode ser silenciado nem cegado", () => {
  it("SKIP_SECRET_SCAN=1 (a válvula de bypass do commit) NÃO silencia o gate de publicação", () => {
    write("src/config.ts", `export const cfg = { k: "${PLANTADO}" };\n`);
    expect(gate([], { SKIP_SECRET_SCAN: "1" }).code).toBe(2);
    expect(gate([], { SKIP_PRECOMMIT: "1" }).code).toBe(2);
    expect(gate([], { HUSKY_SKIP_HOOKS: "1" }).code).toBe(2);
  });

  it("blindar contra a válvula de bypass não pode CEGAR as regras que leem o ambiente", () => {
    // As regras casam também os LITERAIS das credenciais do próprio produto, lendo o VALOR delas do
    // ambiente (`selfSecretLiterals`, scan-secrets.mjs). Se o gate zerasse o ambiente para ficar imune a
    // SKIP_SECRET_SCAN, desarmaria em silêncio exatamente a regra que pega o token do produto nu na
    // árvore — trocaria um bypass explícito por um ponto cego invisível. Ele remove só as válvulas.
    const LITERAL = ["correct", "horse", "battery", "staple"].join(""); // 25 chars, inócuo por FORMA
    write("docs/exemplo-curl.md", `curl -H "x-ah: ${LITERAL}" http://localhost:3008/api\n`);

    expect(gate().code).toBe(0); // sem o valor no ambiente é só uma string qualquer

    const r = gateJson([], { AGILEHARNESS_AUTH_TOKEN: LITERAL });
    expect(r.code).toBe(2);
    expect(r.json.findings.some((f) => f.rule === "self-secret-literal")).toBe(true);
    expect(JSON.stringify(r.json)).not.toContain(LITERAL); // nomeia a variável, nunca ecoa o valor

    // e a imunidade continua: a válvula não desliga o gate nem com o ambiente inteiro herdado
    expect(gate([], { AGILEHARNESS_AUTH_TOKEN: LITERAL, SKIP_SECRET_SCAN: "1" }).code).toBe(2);
  });

  it("alvo que não é worktree git → exit 1 (fail-CLOSED), nunca 0", () => {
    const soltos = mkdtempSync(path.join(tmpdir(), "sem-git-"));
    try {
      const r = spawnSync(process.execPath, [GATE, soltos, "--json"], { encoding: "utf8", env: GIT_ENV });
      expect(r.status).toBe(1);
      // e diz POR QUE recusou (sem isso, um exit 1 por script quebrado passaria por gate funcionando)
      expect(r.stderr).toContain("git");
    } finally {
      rmSync(soltos, { recursive: true, force: true });
    }
  });

  it("respeita .gitignore — mas só o .gitignore: o MESMO arquivo, não ignorado, é bloqueado", () => {
    write(".gitignore", "segredos/\n");
    write("segredos/prod.ts", `export const k = "${PLANTADO}";\n`);
    expect(gate().code).toBe(0); // não entra no snapshot publicado

    write("visivel/prod.ts", `export const k = "${PLANTADO}";\n`);
    expect(gate().code).toBe(2); // a mesma linha, rastreável → bloqueia
  });

  it("arquivo que o gate NÃO consegue varrer (binário) é reportado, nunca contado como limpo", () => {
    const abs = path.join(repo, "assets/blob.bin");
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    const r = gateJson();
    expect(r.json.unscanned.some((u) => u.file === "assets/blob.bin")).toBe(true);
    expect(r.json.scannedFiles).toBe(0); // e NÃO entra na conta de varridos
    expect(gate().out).toContain("não varrid"); // visível no relatório humano também

    // Blob de extensão binária é ponto cego ESTRUTURAL: não existe texto para ler. Ele continua NOMEADO
    // no relatório — é essa listagem que cobre o risco residual assumido pelas extensões de blob genérico
    // (`.bin`/`.dat`/`.db`, ver BINARIO_POR_CONSTRUCAO) —, mas `--fail-on-unscanned` NÃO reprova por ele:
    // se reprovasse, cada PNG/ICO do artefato reprovaria a publicação, a flag sairia do alvo do justfile
    // na primeira semana e o bucket ACIDENTAL (o único onde um segredo de texto de fato se esconde)
    // voltaria a não ser cobrado por ninguém. Gate que ninguém roda não protege publicação nenhuma.
    expect(r.json.unscanned.find((u) => u.file === "assets/blob.bin")?.structural).toBe(true);
    expect(r.json.unscannedAccidental).toBe(0);
    expect(gate(["--fail-on-unscanned"]).code).toBe(0);
  });

  it("ATAQUE: esconder um segredo de TEXTO no bucket 'não varri' — --fail-on-unscanned reprova", () => {
    // O ponto cego ACIDENTAL é o que "não varri" contado como "está limpo" custa de verdade: o arquivo É
    // texto, o gate LERIA, e só um limite operacional (aqui o teto de leitura) o deixou atravessar com a
    // credencial dentro. Sem a flag isso sai como AVISO e a publicação segue; o modo do runbook de
    // publicação (`just oss-snapshot-gate`) carrega a flag justamente para que atravessar não seja opção.
    write("src/gigante.ts", `export const k = "${PLANTADO}";\n`);

    const semFlag = gateJson(["--max-bytes", "8"]);
    expect(semFlag.json.findings).toHaveLength(0); // o segredo NÃO foi visto — é este o ponto cego
    expect(semFlag.json.scannedFiles).toBe(0);
    expect(semFlag.json.unscanned.some((u) => u.file === "src/gigante.ts" && !u.structural)).toBe(true);
    expect(semFlag.json.unscannedAccidental).toBe(1);
    expect(semFlag.code).toBe(0); // e o gate liberaria a publicação

    // A MESMA árvore, o MESMO teto: só a flag muda, e ela reprova. Nomeia o arquivo no relatório humano,
    // senão o operador recebe um vermelho sem saber qual arquivo tirar do caminho.
    const comFlag = gate(["--max-bytes", "8", "--fail-on-unscanned"]);
    expect(comFlag.code).toBe(2);
    expect(comFlag.out).toContain("src/gigante.ts");
    expect(comFlag.out + comFlag.err).not.toContain(PLANTADO); // nem ao reprovar o gate ecoa o valor
  });
});

describe("gate do snapshot — allowlist versionada por caminho + hash do achado", () => {
  function writeAllowlist(entries: unknown[]) {
    write("scripts/security/secret-baseline-allowlist.json", JSON.stringify({ entries }, null, 2) + "\n");
  }

  it("uma entrada caminho+hash suprime AQUELE achado — e só ele", () => {
    write("src/config.ts", `export const cfg = { k: "${PLANTADO}" };\n`);
    const antes = gateJson();
    expect(antes.code).toBe(2);
    const achado = antes.json.findings[0];
    expect(achado.hash).toMatch(/^[0-9a-f]{16}$/);

    writeAllowlist([
      { path: "src/config.ts", rule: achado.rule, hash: achado.hash, reason: "chave de exemplo do teste", addedAt: "2026-07-29" },
    ]);
    const depois = gateJson();
    expect(depois.code).toBe(0);
    expect(depois.json.allowlisted).toHaveLength(1);

    // A allowlist NÃO é um mute geral: um SEGUNDO segredo, diferente, no MESMO arquivo, ainda bloqueia.
    // (Em OUTRA linha de propósito: as regras importadas casam no máximo UMA vez por regra por linha
    // — `text.match` sem /g, scan-secrets.mjs — então dois segredos na MESMA linha rendem um só achado.
    // Esse limite é das regras, não do gate; está registrado como risco residual da story.)
    write("src/config.ts", `export const cfg = {\n  k: "${PLANTADO}",\n  j: "${PLANTADO_2}",\n};\n`);
    const r = gateJson();
    expect(r.code).toBe(2);
    expect(r.json.findings).toHaveLength(1); // só o NÃO reconhecido
    expect(r.json.findings[0].line).toBe(3);
    expect(r.json.allowlisted).toHaveLength(1);
  });

  it("a mesma entrada NÃO cobre o segredo em OUTRO caminho (a allowlist é por caminho)", () => {
    write("src/config.ts", `export const cfg = { k: "${PLANTADO}" };\n`);
    const achado = gateJson().json.findings[0];
    writeAllowlist([{ path: "src/config.ts", rule: achado.rule, hash: achado.hash, reason: "fp", addedAt: "2026-07-29" }]);
    expect(gateJson().code).toBe(0);

    write("outro/lugar.ts", `export const k = "${PLANTADO}";\n`);
    const r = gateJson();
    expect(r.code).toBe(2);
    expect(r.json.findings.map((f) => f.file)).toEqual(["outro/lugar.ts"]);
  });

  it("a allowlist versionada NÃO guarda o valor nem hash do valor bruto — só do achado MASCARADO", () => {
    write("src/config.ts", `export const cfg = { k: "${PLANTADO}" };\n`);
    const achado = gateJson().json.findings[0];
    writeAllowlist([{ path: "src/config.ts", rule: achado.rule, hash: achado.hash, reason: "fp", addedAt: "2026-07-29" }]);

    const conteudo = readFileSync(path.join(repo, "scripts/security/secret-baseline-allowlist.json"), "utf8");
    expect(conteudo).not.toContain(PLANTADO);
    expect(conteudo).not.toContain(MIOLO);
    // o hash publicado é do achado mascarado, então não serve de oráculo de confirmação do segredo
    expect(achado.hash).not.toBe(createHash("sha256").update(PLANTADO).digest("hex").slice(0, 16));
  });

  it("entrada de allowlist que não casa com nada é reportada como baseline podre (stale)", () => {
    write("src/util.ts", "export const sum = (a: number, b: number) => a + b;\n");
    writeAllowlist([{ path: "src/foi-embora.ts", rule: "aws-access-key-id", hash: "0123456789abcdef", reason: "fp", addedAt: "2026-07-29" }]);
    const r = gateJson();
    expect(r.code).toBe(0);
    expect(r.json.staleAllowlist).toHaveLength(1);
  });

  it("allowlist corrompida → exit 1 (fail-CLOSED), nunca vira 'sem achados'", () => {
    write("src/config.ts", `export const cfg = { k: "${PLANTADO}" };\n`);
    write("scripts/security/secret-baseline-allowlist.json", "{ isso não é json\n");
    const r = gate();
    expect(r.code).toBe(1);
    expect(r.err.toLowerCase()).toContain("allowlist"); // e nomeia a causa, não morre genérico
  });
});

describe("gate do snapshot — contrato de CLI", () => {
  it("--help documenta que ele é o gate do snapshot de publicação", () => {
    const r = spawnSync(process.execPath, [GATE, "--help"], { encoding: "utf8", env: GIT_ENV });
    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("snapshot");
    expect(r.stdout.toLowerCase()).toContain("publica");
  });
});
