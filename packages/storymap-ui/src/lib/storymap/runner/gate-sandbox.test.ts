// O SELO do gate — duas metades, e as duas precisam existir:
//
//   1. a FORMA (pura, roda em qualquer host): a argv que o gate monta carrega cada propriedade que a
//      medição exigiu. Cada `expect` aqui corresponde a um furo MEDIDO neste host (ver o cabeçalho de
//      gate-sandbox.ts) — tirar a propriedade reabre o furo, e o teste reprova.
//   2. a CONTENÇÃO (real, só onde o systemd sobe o selo): um fixture HOSTIL tenta ler uma credencial, ler o
//      environ de um processo root, escrever fora da árvore, falar com o PID 1 e abrir um socket — dentro
//      do selo tudo falha; FORA dele (o controle) tudo passa, o que prova que o teste discrimina. E uma
//      suíte de REFERÊNCIA (loopback, /tmp, subprocesso, git) passa selada: o selo não quebra teste normal.
//
// A metade real é pulada onde o host não roda UNIDADE TRANSIENTE nenhuma (CI sem root, macOS, container
// sem systemd, ou esta suíte rodando DENTRO do selo do gate). Nunca pela sonda do selo — ver TRANSIENT_OK.
import { exec as execCb, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSealedInvocation,
  defaultInaccessiblePaths,
  gateUnitName,
  isGateUnit,
  probeGateSandbox,
  probeScript,
  resolveGateIsolation,
  sealProperties,
  stopUnitCommand,
  withSealedVitestFlags,
  type GateSeal,
} from "./gate-sandbox";
import { parseJunitReport } from "./gate-reporters";
import { makeDefaultGateRunner } from "./merge-queue";
import { defaultExec, defaultWorktreeFs, type ExecFn } from "./worktree";

const execP = promisify(execCb);

const seal = (over: Partial<GateSeal> = {}): GateSeal => ({
  mode: "systemd",
  reason: "teste",
  treePath: "/repo/.worktrees/gate-r1",
  repoRoot: "/repo",
  inaccessiblePaths: ["/root/.ssh", "/etc/agileharness"],
  writablePaths: [],
  runId: "r1",
  ...over,
});

describe("a FORMA do selo — cada propriedade é um furo medido", () => {
  const props = sealProperties(seal(), "deny", 300_000).props;

  it("root SEM capability (senão ele desmonta o InaccessiblePaths e remonta / rw — medido)", () => {
    expect(props).toContain("CapabilityBoundingSet=");
    expect(props).toContain("AmbientCapabilities=");
    expect(props).toContain("NoNewPrivileges=yes");
  });

  it("FS read-only E o HOME read-only (strict sozinho deixa /root gravável — medido)", () => {
    expect(props).toContain("ProtectSystem=strict");
    expect(props).toContain("ProtectHome=read-only");
  });

  it("/run VAZIO (o socket do PID 1 e do dbus seriam uma saída como root — medido) e /tmp privado", () => {
    expect(props).toContain("TemporaryFileSystem=/run:ro");
    expect(props).toContain("PrivateTmp=yes");
  });

  it("sem rede quando `deny`; com o resolv.conf quando `allow`", () => {
    expect(props).toContain("PrivateNetwork=yes");
    const allow = sealProperties(seal(), "allow", 300_000).props;
    expect(allow).not.toContain("PrivateNetwork=yes");
    expect(allow).toContain("BindReadOnlyPaths=-/run/systemd/resolve");
  });

  it("a árvore é o ÚNICO bind gravável obrigatório; a raiz do repo só read-only; credenciais inacessíveis", () => {
    expect(props).toContain("BindPaths=/repo/.worktrees/gate-r1");
    expect(props).toContain("BindReadOnlyPaths=-/repo");
    expect(props).toContain("InaccessiblePaths=-/root/.ssh");
    expect(props).toContain("InaccessiblePaths=-/etc/agileharness");
  });

  it("o relógio de parede é do SYSTEMD (matar o cliente não para a unidade — medido)", () => {
    expect(props).toContain("RuntimeMaxSec=300");
    expect(sealProperties(seal(), "deny", 1).props).toContain("RuntimeMaxSec=1");
  });

  it("um caminho que o systemd não aceita sem escape NÃO entra — e é devolvido para o aviso", () => {
    const r = sealProperties(seal({ inaccessiblePaths: ["/ok/path", "/com espaço", "/a:b", "relativo"] }), "deny", 1000);
    expect(r.props).toContain("InaccessiblePaths=-/ok/path");
    expect(r.skipped).toEqual(["/com espaço", "/a:b", "relativo"]);
  });

  it("as credenciais default cobrem as CLIs de nuvem, o ssh, o Claude e o shadow", () => {
    const d = defaultInaccessiblePaths("/home/op");
    for (const p of [".ssh", ".aws", ".azure", ".config/gcloud", ".claude", ".claude.json", ".docker", ".kube", ".gnupg", ".npmrc"]) {
      expect(d).toContain(path.join("/home/op", p));
    }
    expect(d).toContain("/etc/shadow");
  });
});

describe("buildSealedInvocation — a argv que o exec roda", () => {
  it("`none` é o comando de antes, byte a byte (/bin/sh -c)", () => {
    const inv = buildSealedInvocation({ command: "vitest run", cwd: "/t", env: { A: "1" } as never, timeoutMs: 1000, seal: undefined, nonce: "n" });
    expect(inv).toMatchObject({ command: "vitest run", argv: ["/bin/sh", "-c", "vitest run"], isolation: "none" });
    expect(inv.unit).toBeUndefined();
  });

  it("selado: systemd-run --wait --pipe --collect, sem expansão de ${VAR}, env por NOME, comando intacto no fim", () => {
    const env = { PATH: "/usr/bin", SEGREDO: "nao-na-argv", "NOME INVALIDO": "x" } as unknown as NodeJS.ProcessEnv;
    const inv = buildSealedInvocation({ command: "echo '${HOME}' $X", cwd: "/repo/.worktrees/gate-r1/pkg", env, timeoutMs: 5000, seal: seal(), nonce: "abc" });
    expect(inv.argv.slice(0, 6)).toEqual(["systemd-run", "--wait", "--pipe", "--collect", "--quiet", "--expand-environment=no"]);
    expect(inv.argv).toContain("--working-directory=/repo/.worktrees/gate-r1/pkg");
    expect(inv.argv).toContain("--slice=agileharness-gate.slice");
    expect(inv.argv).toContain("--setenv=SEGREDO");
    expect(inv.argv).toContain("--setenv=TMPDIR");
    expect(inv.argv.some((a) => a.includes("nao-na-argv"))).toBe(false);
    expect(inv.argv.some((a) => a.includes("NOME INVALIDO"))).toBe(false);
    expect(inv.argv.slice(-4)).toEqual(["--", "/bin/sh", "-c", "echo '${HOME}' $X"]);
    expect(inv.env.TMPDIR).toBe("/tmp");
    expect(inv.unit).toBe("ah-gate-r1-abc.service");
    // a linha de shell cita cada palavra: o `$X` e o `'${HOME}'` chegam ao /bin/sh de DENTRO intactos
    expect(inv.command).toContain(`'echo '\\''\${HOME}'\\'' $X'`);
  });

  it("o nome da unidade é saneado e só uma unidade do gate pode ser PARADA", () => {
    expect(gateUnitName("Run/../X Y", "N0!")).toMatch(/^ah-gate-[a-z0-9-]+-n0\.service$/);
    expect(isGateUnit("ah-gate-r1-abc.service")).toBe(true);
    for (const bad of ["agileharness.service", "claude-runs.slice", "ah-gate-x.service; reboot", "", undefined]) {
      expect(isGateUnit(bad as string)).toBe(false);
      expect(stopUnitCommand(bad as string)).toBeNull();
    }
    expect(stopUnitCommand("ah-gate-r1-abc.service")).toBe("systemctl stop 'ah-gate-r1-abc.service'");
  });
});

describe("withSealedVitestFlags — vitest selado sem escrita em node_modules", () => {
  it("anexa o loader em memória e desliga o cache de resultados", () => {
    expect(withSealedVitestFlags("bunx vitest run --reporter=json")).toBe("bunx vitest run --reporter=json --configLoader runner --no-cache");
  });
  it("nunca repete o que o comando já declarou (`--configLoader x`, `--configLoader=x`, `--cache`/`--no-cache`)", () => {
    expect(withSealedVitestFlags("vitest run --configLoader native")).toBe("vitest run --configLoader native --no-cache");
    expect(withSealedVitestFlags("vitest run --configLoader=bundle --no-cache")).toBe("vitest run --configLoader=bundle --no-cache");
    expect(withSealedVitestFlags("vitest run --cache")).toBe("vitest run --cache --configLoader runner");
  });
  it("um caminho que só CONTÉM a palavra não conta como a flag", () => {
    expect(withSealedVitestFlags("vitest run --config x--configLoader.ts")).toBe("vitest run --config x--configLoader.ts --configLoader runner --no-cache");
  });
});

describe("resolveGateIsolation — o fallback de portabilidade nunca é silencioso", () => {
  it("pedido systemd + sonda ok ⇒ systemd", () => {
    expect(resolveGateIsolation("systemd", () => ({ ok: true, detail: "ok" })).mode).toBe("systemd");
    expect(resolveGateIsolation(undefined, () => ({ ok: true, detail: "ok" })).mode).toBe("systemd");
  });
  it("pedido systemd + sonda falha ⇒ none, e o motivo DIZ o que se perdeu", () => {
    const r = resolveGateIsolation("systemd", () => ({ ok: false, detail: "plataforma darwin" }));
    expect(r.mode).toBe("none");
    expect(r.reason).toMatch(/SEM SELO.*plataforma darwin.*rede do host/);
  });
  it("pedido none ⇒ none declarado, sem sondar", () => {
    let sondou = false;
    const r = resolveGateIsolation("none", () => ((sondou = true), { ok: true, detail: "" }));
    expect(r.mode).toBe("none");
    expect(sondou).toBe(false);
  });
});

describe("probeGateSandbox — presença de binário não é prova", () => {
  it("fora do Linux: sem systemd, sem executar nada", () => {
    let ran = false;
    const r = probeGateSandbox({ platform: "darwin", run: () => ((ran = true), null) });
    expect(r.ok).toBe(false);
    expect(ran).toBe(false);
  });
  it("systemd-run que executa mas não prova o selo ⇒ falha, com o motivo que o script imprimiu", () => {
    const r = probeGateSandbox({ platform: "linux", run: () => ({ code: 12, stdout: "rede do host visível\n", stderr: "" }) });
    expect(r).toEqual({ ok: false, detail: expect.stringContaining("rede do host visível") });
  });
  it("exit 0 SEM a marca não é prova (um systemd-run falso que só devolve 0)", () => {
    expect(probeGateSandbox({ platform: "linux", run: () => ({ code: 0, stdout: "", stderr: "" }) }).ok).toBe(false);
  });
  it("o script da sonda checa cada propriedade sem deixar resíduo (nenhum touch fora da árvore)", () => {
    const s = probeScript("/t/tree", "/home/op");
    expect(s).toMatch(/CapEff/);
    expect(s).toMatch(/\/proc\/self\/net\/dev/);
    expect(s).toMatch(/\[ -w \/etc \]/);
    expect(s).toMatch(/\/run\/systemd\/private/);
    expect(s).not.toMatch(/touch/);
  });
});

// ── A CONTENÇÃO DE VERDADE ────────────────────────────────────────────────────────────────────────────
// O critério de PULAR não pode ser a sonda do selo: isso seria um teste que se desliga exatamente quando o
// que ele testa quebra (uma mutação que tira uma propriedade do selo faria a sonda falhar, e os testes
// reais seriam PULADOS em vez de reprovar). O critério é só "este host roda unidade transiente?" — e, onde
// roda, a sonda do selo TEM de passar (o primeiro teste abaixo).
const TRANSIENT_OK = (() => {
  if (process.platform !== "linux") return false;
  try {
    const r = spawnSync("systemd-run", ["--wait", "--pipe", "--collect", "--quiet", "--", "/bin/true"], { timeout: 20_000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!TRANSIENT_OK)("contenção REAL no systemd deste host", () => {
  let root: string;
  let tree: string;
  let home: string;
  let cred: string;
  let visible: string;
  let server: net.Server;
  let port = 0;
  let canary: ReturnType<typeof spawn>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "ah-gate-hostil-"));
    tree = path.join(root, "tree");
    home = path.join(root, "home");
    mkdirSync(tree);
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    cred = path.join(home, ".ssh", "id_fake");
    visible = path.join(home, "visivel.txt");
    writeFileSync(cred, "CREDENCIAL-FALSA");
    writeFileSync(visible, "CONTROLE");
    server = net.createServer((s) => s.end("oi"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as net.AddressInfo).port;
    // um processo ROOT com um segredo no env — o que o serviço é, visto de dentro do gate
    canary = spawn("sleep", ["120"], { env: { ...process.env, AH_HOSTILE_CANARY: "segredo-do-servico" }, stdio: "ignore" });
  });
  afterAll(() => {
    canary?.kill("SIGKILL");
    server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("num host que roda unidade transiente, a SONDA do selo passa — senão o gate cairia para `none` aqui", () => {
    const p = probeGateSandbox();
    expect(p.detail).toMatch(/selo provado/);
    expect(p.ok).toBe(true);
  });

  const hostileScript = () => `
const fs = require("fs"), net = require("net");
const out = {};
const tryRead = (k, p) => { try { out[k] = fs.readFileSync(p, "utf8"); } catch (e) { out[k] = "ERR:" + e.code; } };
tryRead("cred", ${JSON.stringify(cred)});
tryRead("visible", ${JSON.stringify(visible)});
try { out.environ = fs.readFileSync("/proc/${canary.pid}/environ", "utf8").includes("segredo-do-servico") ? "LEAK" : "sem-canario"; } catch (e) { out.environ = "ERR:" + e.code; }
try { fs.writeFileSync(${JSON.stringify(path.join(tree, "dentro.txt"))}, "ok"); out.treeWrite = "ok"; } catch (e) { out.treeWrite = "ERR:" + e.code; }
try { fs.writeFileSync(${JSON.stringify(path.join(home, "fuga.txt"))}, "x"); out.outsideWrite = "ok"; } catch (e) { out.outsideWrite = "ERR:" + e.code; }
out.pid1Socket = fs.existsSync("/run/systemd/private") ? "visivel" : "oculto";
let done = false;
const fim = () => { if (done) return; done = true; console.log(JSON.stringify(out)); process.exit(0); };
const s = net.connect(${port}, "127.0.0.1");
s.on("data", () => { out.socket = "conectou"; fim(); });
s.on("error", (e) => { out.socket = "ERR:" + e.code; fim(); });
setTimeout(() => { out.socket = out.socket || "timeout"; fim(); }, 4000);
`;

  const runHostile = async (sealed: boolean, network: "deny" | "allow" = "deny") => {
    const script = path.join(tree, "hostil.js");
    writeFileSync(script, hostileScript());
    const command = `${process.execPath} ${script}`;
    const inv = buildSealedInvocation({
      command,
      cwd: tree,
      env: { ...process.env },
      timeoutMs: 30_000,
      network,
      // a raiz "do repositório" aqui é o HOME falso: visível read-only, com a credencial dentro dele escondida
      seal: sealed ? seal({ treePath: tree, repoRoot: home, inaccessiblePaths: [path.join(home, ".ssh")], runId: "hostil" }) : undefined,
      nonce: Math.random().toString(36).slice(2, 8),
    });
    const { stdout } = await execP(inv.command, { env: inv.env, cwd: tree, timeout: 60_000 });
    return JSON.parse(stdout.trim().split("\n").pop()!) as Record<string, string>;
  };

  it("[CONTROLE] SEM o selo o fixture hostil lê a credencial, o environ root, escreve fora e abre o socket — o teste discrimina", async () => {
    const out = await runHostile(false);
    expect(out.cred).toBe("CREDENCIAL-FALSA");
    expect(out.environ).toBe("LEAK");
    expect(out.outsideWrite).toBe("ok");
    expect(out.socket).toBe("conectou");
    rmSync(path.join(home, "fuga.txt"), { force: true });
  });

  it("[SELADO] a credencial some, o environ do root é ilegível, fora da árvore é read-only, o PID 1 é invisível e o socket não abre", async () => {
    const out = await runHostile(true);
    expect(out.cred).toMatch(/^ERR:/);
    expect(out.visible).toBe("CONTROLE"); // só o que está na deny-list some — o resto segue legível
    expect(out.environ).toMatch(/^ERR:/);
    expect(out.treeWrite).toBe("ok");
    expect(out.outsideWrite).toBe("ERR:EROFS");
    expect(out.pid1Socket).toBe("oculto");
    expect(out.socket).toMatch(/^ERR:/);
    expect(existsSync(path.join(home, "fuga.txt"))).toBe(false);
  });

  it("[SELADO, network: allow] a rede volta — mas a credencial e o environ continuam fechados", async () => {
    const out = await runHostile(true, "allow");
    expect(out.socket).toBe("conectou");
    expect(out.cred).toMatch(/^ERR:/);
    expect(out.environ).toMatch(/^ERR:/);
  });

  it("[REFERÊNCIA] uma suíte normal — loopback, /tmp, subprocesso, git — passa SELADA, lida por junit", async () => {
    const suite = path.join(tree, "ref.test.mjs");
    writeFileSync(
      suite,
      `
import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
test("servidor em loopback PRIVADO", async () => {
  const srv = net.createServer((s) => s.end("pong"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const got = await new Promise((r, j) => { const c = net.connect(srv.address().port, "127.0.0.1"); c.on("data", (d) => r(String(d))); c.on("error", j); });
  srv.close();
  assert.equal(got, "pong");
});
test("escreve no /tmp privado", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "t-"));
  fs.writeFileSync(path.join(d, "f"), "x");
  assert.equal(fs.readFileSync(path.join(d, "f"), "utf8"), "x");
});
test("subprocesso + git init/commit numa pasta temporária", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "g-"));
  execFileSync("git", ["init", "-q", d]);
  fs.writeFileSync(path.join(d, "a"), "1");
  execFileSync("git", ["-C", d, "add", "a"]);
  execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "m"]);
  assert.match(execFileSync("git", ["-C", d, "log", "--oneline"], { encoding: "utf8" }), /m/);
});
`,
    );
    const inv = buildSealedInvocation({
      command: `${process.execPath} --test --test-reporter=junit --test-reporter-destination=junit.xml ref.test.mjs`,
      cwd: tree,
      env: { ...process.env },
      timeoutMs: 60_000,
      seal: seal({ treePath: tree, repoRoot: home, inaccessiblePaths: [], runId: "referencia" }),
      nonce: Math.random().toString(36).slice(2, 8),
    });
    await execP(inv.command, { env: inv.env, cwd: tree, timeout: 90_000 });
    const rep = parseJunitReport(readFileSync(path.join(tree, "junit.xml"), "utf8"));
    expect(rep.parsed).toBe(true);
    expect(rep.failures).toEqual([]);
    expect(rep.tests).toBe(3);
  });
});

// ── vitest SELADO de verdade: o node_modules da árvore é LINK para o checkout (read-only no selo) ─────────
describe.skipIf(!TRANSIENT_OK)("vitest REAL sob o selo — o config carrega sem gravar em node_modules", () => {
  let root: string;
  let tree: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ah-gate-vitest-"));
    tree = path.join(root, "tree");
    mkdirSync(tree);
    // a MESMA forma da árvore do gate: node_modules é um link para o checkout (aqui, o deste pacote — sob
    // /root, que o selo monta read-only), e o config usa import.meta.url como o de um alvo real.
    symlinkSync(path.resolve(process.cwd(), "node_modules"), path.join(tree, "node_modules"));
    writeFileSync(path.join(tree, "package.json"), JSON.stringify({ name: "gate-vitest-fixture", private: true, type: "module" }));
    writeFileSync(
      path.join(tree, "vitest.config.ts"),
      `import { fileURLToPath } from "node:url";\nimport { defineConfig } from "vitest/config";\n` +
        `export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["*.test.ts"] } });\n`,
    );
    writeFileSync(path.join(tree, "a.test.ts"), `import { expect, it } from "vitest";\nit("soma", () => { expect(1 + 1).toBe(2); });\n`);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const runSealed = async (command: string): Promise<{ ok: boolean; out: string }> => {
    const inv = buildSealedInvocation({
      command,
      cwd: tree,
      env: { ...process.env },
      timeoutMs: 90_000,
      seal: seal({ treePath: tree, repoRoot: root, inaccessiblePaths: [], runId: "vitest" }),
      nonce: Math.random().toString(36).slice(2, 8),
    });
    try {
      const r = await execP(inv.command, { env: inv.env, cwd: tree, timeout: 120_000 });
      return { ok: true, out: `${r.stdout}${r.stderr}` };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const vitest = () => `${path.resolve(process.cwd(), "node_modules", ".bin", "vitest")} run --reporter=json`;

  it("[CONTROLE] o loader default morre em EROFS no node_modules read-only — o teste discrimina", async () => {
    const r = await runSealed(vitest());
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/EROFS|read-only file system/i);
  }, 150_000);

  it("[SELADO] com as flags do selo o MESMO config carrega e a suíte roda, medida pelo relatório", async () => {
    const r = await runSealed(withSealedVitestFlags(vitest()));
    expect(r.ok, r.out.slice(-600)).toBe(true);
    expect(r.out).toContain('"numPassedTests":1');
  }, 150_000);
});

// ── E O GATE INTEIRO, selado, contra um repositório git real ────────────────────────────────────────────
describe.skipIf(!TRANSIENT_OK)("o gate de ponta a ponta SELADO — árvore real, unidade junit + unidade exit-code", () => {
  let root: string;
  let repo: string;
  const git = (args: string, cwd: string) =>
    execP(`git ${args}`, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: root } });

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "ah-gate-e2e-"));
    repo = path.join(root, "repo");
    mkdirSync(path.join(repo, "packages", "app", "test"), { recursive: true });
    mkdirSync(path.join(repo, "tools", "check"), { recursive: true });
    writeFileSync(
      path.join(repo, "packages", "app", "test", "a.test.mjs"),
      `import test from "node:test"; import assert from "node:assert"; test("base", () => assert.ok(true));\n`,
    );
    writeFileSync(path.join(repo, "tools", "check", "ok.txt"), "ok\n");
    await git("init -q -b main", repo);
    await git("-c user.name=t -c user.email=t@t add -A", repo);
    await git("-c user.name=t -c user.email=t@t commit -q -m base", repo);
    await git("checkout -q -b run/e2e", repo);
    writeFileSync(
      path.join(repo, "packages", "app", "test", "b.test.mjs"),
      `import test from "node:test"; import assert from "node:assert"; test("novo 1", () => assert.ok(true)); test("novo 2", () => assert.ok(true));\n`,
    );
    writeFileSync(path.join(repo, "tools", "check", "x.txt"), "x\n");
    await git("-c user.name=t -c user.email=t@t add -A", repo);
    await git("-c user.name=t -c user.email=t@t commit -q -m delta", repo);
    await git("checkout -q main", repo);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("aprova, com N>0 testes executados SELADOS e a argv do systemd-run registrada por unidade", async () => {
    // o git do gate não pode ler a config do operador (mesma disciplina de git-test-env.ts)
    const exec: ExecFn = (cmd, o) =>
      cmd.startsWith("git ")
        ? defaultExec(cmd, { ...o, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: root, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
        : defaultExec(cmd, o);
    const res = await makeDefaultGateRunner(defaultWorktreeFs)({
      exec,
      repoRoot: repo,
      branch: "run/e2e",
      runId: "e2e",
      checkCommand: "false",
      timeoutMs: 60_000,
      scope: {
        packages: {
          "packages/app": { command: `${process.execPath} --test --test-reporter=junit --test-reporter-destination=junit.xml test/*.test.mjs`, reporter: "junit-xml", junitPath: "junit.xml" },
        },
        units: { "tools/check": { command: "test -f ok.txt", reporter: "exit-code" } },
      },
      isolation: { mode: "systemd", reason: "sonda ok (e2e)" },
    });
    expect(res.passed, res.log).toBe(true);
    expect(res.report?.isolation).toBe("systemd");
    expect(res.report?.testsExecuted).toBe(3);
    expect(res.report?.uncountedUnits).toBe(1);
    for (const u of res.report!.units) {
      expect(u.isolation).toBe("systemd");
      expect(u.argv[0]).toBe("systemd-run");
      expect(u.argv).toContain("--property=PrivateNetwork=yes");
    }
    expect(res.log).toContain("3 teste(s) executado(s)");
    // a árvore do gate foi descartada
    expect(existsSync(path.join(repo, ".worktrees", "gate-e2e"))).toBe(false);
  });
});
