import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// O gate é um script .mjs: o teste o carrega como módulo e declara só o que usa.
import * as gate from "../../../../../scripts/oss/publication-gate.mjs";

type Line = { file: string; line: number; text: string };
const g = gate as unknown as {
  GENERIC_RULES: Array<{ id: string; re: RegExp; addedOnly?: boolean; allow?: RegExp | ((m: string, ctx?: unknown) => boolean) }>;
  DEFAULT_EXCLUDES: RegExp[];
  addedLines: (diff: string, o?: { exclude?: RegExp[] }) => Line[];
  scanAdded: (lines: Line[], rules: unknown[], ctx?: { knownNames?: Set<string> }) => Array<{ file: string; line: number; rule: string; match: string }>;
  loadPrivateTerms: (file: string) => Array<{ id: string; re: RegExp; term: string }> | null;
};

const at = (text: string, file = "src/a.ts", line = 1): Line => ({ file, line, text });
const scan = (text: string, extra: unknown[] = [], ctx = {}) => g.scanAdded([at(text)], [...g.GENERIC_RULES, ...extra], ctx);

describe("publication-gate — regras genéricas (valem para qualquer instalação)", () => {
  it("id de card de board privado", () => {
    expect(scan("// veio de story-ab12cd, medido ontem")[0]).toMatchObject({ rule: "card-id", match: "story-ab12cd" });
    expect(scan("coerceCard('step-zz99aa')")[0]).toMatchObject({ rule: "card-id" });
    expect(scan("const id = 'story-fx12'")).toEqual([]); // id de fixture: curto, não é o formato de um card real
    expect(scan("// o caso de story-ex0042, medido ontem")).toEqual([]); // o espaço reservado para ids de EXEMPLO
    expect(scan("coerceCard('story-ex004a')")).toHaveLength(1); // quatro dígitos, exatamente
    expect(scan("a história do usuário")).toEqual([]);
  });

  it("um nome com a FORMA de id que é arquivo do repositório passa (um módulo, não um card)", () => {
    expect(scan('import x from "./step-rollup"')).toHaveLength(1);
    expect(scan('import x from "./step-rollup"', [], { knownNames: new Set(["step-rollup"]) })).toEqual([]);
  });

  it("o diretório de um usuário COM NOME; `/root/…` e os nomes genéricos passam", () => {
    expect(scan("cd /home/joana/trabalho")[0]).toMatchObject({ rule: "home-path" });
    expect(scan("open /Users/joana/Projects/x")[0]).toMatchObject({ rule: "home-path" });
    expect(scan("nega /root/.ssh/id_ed25519 e /root/projeto/x")).toEqual([]); // o mesmo em qualquer host
    expect(scan("/home/user/app e /home/runner/work")).toEqual([]);
    expect(scan("/usr/local/bin e /srv/app")).toEqual([]);
    expect(scan("https://example.com/home/joana/x")).toEqual([]);
  });

  it("e-mail e host/IP de máquina, com as exceções que não identificam ninguém", () => {
    expect(scan("contato: fulano@empresa.com.br")[0]).toMatchObject({ rule: "email" });
    expect(scan("Co-Authored-By: Claude <noreply@anthropic.com>")).toEqual([]);
    expect(scan("user@example.com")).toEqual([]);
    expect(scan("fetch('http://203.0.114.7/x')")[0]).toMatchObject({ rule: "machine-host" });
    expect(scan("bind 127.0.0.1 e 0.0.0.0 e 192.0.2.10")).toEqual([]);
    expect(scan("loopback 127.0.0.9, rede privada 10.0.0.4, 192.168.1.10 e 172.16.5.1")).toEqual([]);
    expect(scan("172.32.0.1 já é endereço público")[0]).toMatchObject({ rule: "machine-host" });
    expect(scan('placeholder="voce@exemplo.com"')[0]).toMatchObject({ rule: "email" }); // «cara de falso» não é reservado
    expect(scan("git config user.email t@t.dev")[0]).toMatchObject({ rule: "email" });
    expect(scan("git config user.email t@example.test e x@algo.invalid")).toEqual([]);
    expect(scan("systemctl status agente@1.service")).toEqual([]);
    expect(scan("o host app.sslip.io responde")[0]).toMatchObject({ rule: "machine-host" });
  });

  it("`oss-allow: <motivo>` na linha ou na anterior libera; sem motivo não", () => {
    expect(scan("/home/joana/x // oss-allow: exemplo da documentação")).toEqual([]);
    const two = g.scanAdded([at("// oss-allow: o exemplo do README", "d.md", 1), at("rode em /home/joana/x", "d.md", 2)], g.GENERIC_RULES);
    expect(two).toEqual([]);
    expect(scan("/home/joana/x // oss-allow:")).toHaveLength(1);
    // a liberação da linha anterior vale no MESMO arquivo, não no seguinte
    const other = g.scanAdded([at("// oss-allow: motivo", "a.md", 1), at("/home/joana/x", "b.md", 1)], g.GENERIC_RULES);
    expect(other).toHaveLength(1);
  });
});

describe("publication-gate — termos privados do operador (ficam FORA do repositório)", () => {
  const tmp = (text: string) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), "terms");
    fs.writeFileSync(f, text);
    return f;
  };

  it("um termo por linha; # comenta; palavra inteira e sem diferenciar caixa; /regex/ vale", () => {
    const terms = g.loadPrivateTerms(tmp("# produtos\nAcmeCorp\n\n/vendor-\\d+/i\nponto.final\n"))!;
    expect(terms.map((t) => t.term)).toEqual(["AcmeCorp", "/vendor-\\d+/i", "ponto.final"]);
    expect(scan("trabalha na acmecorp", terms)[0]).toMatchObject({ rule: "private-term", match: "acmecorp" });
    expect(scan("o AcmeCorporation não conta", terms)).toEqual([]);
    expect(scan("pedido Vendor-42", terms)[0]).toMatchObject({ rule: "private-term" });
    expect(scan("ponto-final", terms)).toEqual([]); // o ponto do termo é literal
  });

  it("o termo colado numa sequência de escape (`\\nfulano` numa string) é achado — a fronteira de palavra não o esconde", () => {
    const terms = g.loadPrivateTerms(tmp("AcmeCorp\n"))!;
    expect(scan('const out = "primeira linha\\nacmecorp segunda";', terms)[0]).toMatchObject({ rule: "private-term", match: "acmecorp" });
    expect(scan('stdout: "ok\\tAcmeCorp\\n"', terms)).toHaveLength(1);
  });

  it("regex SEM a flag i diferencia caixa — para a marca que também é palavra comum", () => {
    const terms = g.loadPrivateTerms(tmp("/\\bOrbit\\b/\n"))!;
    expect(scan("o produto Orbit", terms)[0]).toMatchObject({ rule: "private-term", match: "Orbit" });
    expect(scan("the satellite is in orbit", terms)).toEqual([]);
  });

  it("arquivo ausente ⇒ null (o modo de publicação reprova); regex inválida na lista é ignorada, não derruba o gate", () => {
    expect(g.loadPrivateTerms(path.join(os.tmpdir(), "nao-existe-gate-terms"))).toBeNull();
    const terms = g.loadPrivateTerms(tmp("/(/\nvalido\n"))!;
    expect(terms.map((t) => t.term)).toEqual(["valido"]);
  });
});

describe("publication-gate — só as linhas ADICIONADAS entram (catraca: o passado público não trava)", () => {
  const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +10,3 @@",
    " contexto antigo com /home/joana/velho",
    "-removida com /home/joana/removida",
    "+nova linha limpa",
    "+nova com /home/joana/suja",
    "diff --git a/bun.lock b/bun.lock",
    "--- a/bun.lock",
    "+++ b/bun.lock",
    "@@ -0,0 +1 @@",
    "+resolved /home/joana/cache",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-/home/joana/apagado",
    "",
  ].join("\n");

  it("lê arquivo e número da linha; ignora contexto, remoção, arquivo apagado e caminho excluído", () => {
    const lines = g.addedLines(DIFF, { exclude: g.DEFAULT_EXCLUDES });
    expect(lines).toEqual([
      { file: "src/a.ts", line: 10, text: "nova linha limpa" },
      { file: "src/a.ts", line: 11, text: "nova com /home/joana/suja" },
    ]);
    const found = g.scanAdded(lines, g.GENERIC_RULES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "src/a.ts", line: 11, rule: "home-path" });
  });

  it("sem a lista de exclusão o lockfile entra (a exclusão é escolha de quem chama)", () => {
    expect(g.addedLines(DIFF).some((l) => l.file === "bun.lock")).toBe(true);
  });
});

describe("publication-gate — a ÁRVORE inteira passa pelas regras exatas; as de forma só valem para o que é novo", () => {
  const tmpRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-tree-"));
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    return { dir, git };
  };
  const GATE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scripts/oss/publication-gate.mjs");

  it("as regras de forma (id de card, caminho de máquina) são só da catraca; termo, e-mail e host valem para tudo", () => {
    expect(g.GENERIC_RULES.filter((r) => r.addedOnly).map((r) => r.id).sort()).toEqual(["card-id", "home-path"]);
  });

  it("--tree reprova o termo privado que JÁ estava na base; sem --tree a catraca não o vê", () => {
    const { dir, git } = tmpRepo();
    fs.writeFileSync(path.join(dir, "antigo.ts"), "// feito para a AcmeCorp\nconst casa = '/home/joana/x/y';\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    fs.writeFileSync(path.join(dir, "novo.ts"), "export const ok = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "novo");
    const terms = path.join(dir, ".terms");
    fs.writeFileSync(terms, "AcmeCorp\n");
    const run = (...args: string[]) => spawnSync("node", [GATE_CLI, "--base", base, "--terms", terms, ...args], { cwd: dir, encoding: "utf8" });

    expect(run().status).toBe(0);
    const tree = run("--tree", "--json");
    expect(tree.status).toBe(1);
    const findings = (JSON.parse(tree.stdout) as { findings: Array<{ file: string; rule: string; scope?: string }> }).findings;
    // o termo privado antigo é achado; o caminho de máquina antigo NÃO (regra de forma: só o que é novo)
    expect(findings).toEqual([expect.objectContaining({ file: "antigo.ts", rule: "private-term", scope: "tree" })]);
  });

  it("--tree lê também o NOME dos arquivos: um termo privado num caminho é publicado igual a um numa linha", () => {
    const { dir, git } = tmpRepo();
    fs.writeFileSync(path.join(dir, "notas-acmecorp.md"), "texto limpo\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const terms = path.join(dir, ".terms");
    fs.writeFileSync(terms, "/acmecorp/i\n");
    const r = spawnSync("node", [GATE_CLI, "--base", "HEAD", "--tree", "--terms", terms, "--json"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    const findings = (JSON.parse(r.stdout) as { findings: Array<{ file: string; why: string }> }).findings;
    expect(findings).toEqual([expect.objectContaining({ file: "notas-acmecorp.md", why: expect.stringContaining("NOME do arquivo") })]);
  });
});

describe("publication-gate — o código do gate não carrega nome privado (se a lista morasse aqui, ela seria o vazamento)", () => {
  it("o próprio fonte passa nas regras genéricas", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scripts/oss/publication-gate.mjs"), "utf8");
    const lines = src.split("\n").map((text, i) => at(text, "scripts/oss/publication-gate.mjs", i + 1));
    expect(g.scanAdded(lines, g.GENERIC_RULES)).toEqual([]);
  });
});

describe("publication-gate — a linha de comando (o que o ah-publish usa)", () => {
  const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scripts/oss/publication-gate.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cli-"));
  const write = (name: string, text: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const run = (...args: string[]) => spawnSync("node", [GATE, ...args], { encoding: "utf8" });

  it("--text: texto limpo sai 0; texto com contexto privado sai 1 e aponta a linha", () => {
    const terms = write("terms", "AcmeCorp\n");
    expect(run("--text", write("ok.txt", "release v1.0.0\n\n- feat: algo genérico\n"), "--terms", terms).status).toBe(0);
    const bad = run("--text", write("bad.txt", "release v1.0.0\n\n- fix: veio da AcmeCorp\n"), "--terms", terms);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/bad\.txt:3 \[private-term\]/);
  });

  it("--require-terms sem o arquivo de termos é fail-closed (2), com mensagem que diz o que declarar", () => {
    const r = run("--text", write("t.txt", "x\n"), "--terms", path.join(dir, "nao-existe"), "--require-terms");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/faltam os termos privados/);
  });

  it("uma base que não existe é erro de configuração (2), não «limpo»", () => {
    const terms = write("terms2", "AcmeCorp\n");
    expect(run("--base", "ref-que-nao-existe-xyz", "--terms", terms).status).toBe(2);
  });
});
