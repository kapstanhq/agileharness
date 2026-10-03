import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `contrib/ah-publish` é o único caminho da ferramenta até o repositório público. O teste o roda de verdade, numa cópia
// mínima do repositório (o script + o gate) com um remoto `--bare` ao lado: o que importa é o que CHEGA ao remoto.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

type Sandbox = { dir: string; remote: string; env: NodeJS.ProcessEnv; git: (...a: string[]) => string; remoteGit: (...a: string[]) => string; publish: (...a: string[]) => { status: number | null; out: string } };

const COPIED = "A vendedora confere cada pedido de reposição antes de fechar o caixa da loja";

function sandbox({ emptyRemote = false } = {}): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ah-publish-"));
  const dir = path.join(base, "tool");
  const remote = path.join(base, "public.git");
  fs.mkdirSync(path.join(dir, "contrib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts/oss"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "contrib/ah-publish"), path.join(dir, "contrib/ah-publish"));
  fs.chmodSync(path.join(dir, "contrib/ah-publish"), 0o755);
  fs.copyFileSync(path.join(ROOT, "scripts/oss/publication-gate.mjs"), path.join(dir, "scripts/oss/publication-gate.mjs"));
  fs.copyFileSync(path.join(ROOT, "scripts/oss/derivation-check.mjs"), path.join(dir, "scripts/oss/derivation-check.mjs"));
  const terms = path.join(base, "terms");
  fs.writeFileSync(terms, "AcmeCorp\n");
  // a «fonte privada» do operador: uma pasta com um card
  const priv = path.join(base, "fonte-privada");
  fs.mkdirSync(path.join(priv, "cards"), { recursive: true });
  fs.writeFileSync(path.join(priv, "cards", "story-a.md"), `# Card\n\n${COPIED}.\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, AH_OSS_PRIVATE_TERMS: terms, AH_OSS_PRIVATE_SOURCES: priv, XDG_CONFIG_HOME: path.join(base, "sem-config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  delete env.AH_PUBLISH_AUTHOR_NAME;
  delete env.AH_PUBLISH_AUTHOR_EMAIL;
  const run = (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const git = (...a: string[]) => run(dir, a);
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Dev");
  git("config", "user.email", "dev@example.test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", remote);
  fs.writeFileSync(path.join(dir, "README.md"), "# tool\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base pública");
  if (!emptyRemote) {
    git("push", "-q", "origin", "main");
    git("tag", "v0.1.0");
    git("push", "-q", "origin", "v0.1.0");
  }
  return {
    dir,
    remote,
    env,
    git,
    remoteGit: (...a: string[]) => run(remote, a),
    publish: (...a: string[]) => {
      const r = spawnSync("bash", [path.join(dir, "contrib/ah-publish"), ...a], { cwd: dir, encoding: "utf8", env });
      return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
    },
  };
}

/** Um commit privado a mais, a tag da versão e (por padrão) o recibo de verificação da árvore. */
function release(s: Sandbox, { text = "export const ok = 1;\n", receipt = true, tag = "v0.2.0" } = {}) {
  fs.writeFileSync(path.join(s.dir, "novo.ts"), text);
  s.git("add", "-A");
  s.git("commit", "-q", "-m", "feat: trabalho privado, com mensagem que não vai");
  s.git("tag", tag);
  if (receipt) {
    const tree = s.git("rev-parse", "HEAD^{tree}");
    const d = path.join(s.dir, ".git/ah-verified");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${tree}.json`), JSON.stringify({ tree, at: "2026-01-01T00:00:00Z", checks: ["gate", "typecheck", "suite"] }));
  }
}

describe("ah-publish — um commit limpo por release, nunca o histórico privado", { timeout: 60_000 }, () => {
  it("sem --yes é ensaio: mostra o plano e o remoto não muda", () => {
    const s = sandbox();
    const before = s.remoteGit("rev-parse", "main");
    release(s);
    const r = s.publish();
    expect(r.out).toMatch(/DRY-RUN: nada foi enviado/);
    expect(r.status).toBe(0);
    expect(s.remoteGit("rev-parse", "main")).toBe(before);
  });

  it("--yes: o remoto avança UM commit (pai = o público, árvore = a do HEAD), a tag vai, e o local passa a conter o público", () => {
    const s = sandbox();
    const before = s.remoteGit("rev-parse", "main");
    release(s);
    const r = s.publish("--yes");
    expect(r.status, r.out).toBe(0);
    const pub = s.remoteGit("rev-parse", "main");
    expect(s.remoteGit("rev-parse", "main^")).toBe(before);
    expect(s.remoteGit("rev-parse", "main^{tree}")).toBe(s.git("rev-parse", "HEAD^{tree}"));
    expect(s.remoteGit("rev-parse", "v0.2.0^{commit}")).toBe(pub);
    expect(s.remoteGit("log", "--format=%s", "main")).not.toMatch(/trabalho privado/);
    expect(s.git("merge-base", "--is-ancestor", pub, "HEAD")).toBe("");
  });

  it("sem recibo de verificação da árvore sai 4; com termo privado na árvore sai 3 — e nada é enviado", () => {
    const a = sandbox();
    release(a, { receipt: false });
    expect(a.publish("--yes").status).toBe(4);
    const b = sandbox();
    release(b, { text: "// feito para a AcmeCorp\n" });
    const before = b.remoteGit("rev-parse", "main");
    expect(b.publish("--yes").status).toBe(3);
    expect(b.remoteGit("rev-parse", "main")).toBe(before);
  });

  it("texto copiado das fontes privadas na árvore, ou nenhuma fonte declarada: sai 3 e nada é enviado", () => {
    const a = sandbox();
    release(a);
    fs.mkdirSync(path.join(a.dir, "docs"), { recursive: true });
    const beforeA = a.remoteGit("rev-parse", "main");
    fs.writeFileSync(path.join(a.dir, "docs/exemplo.md"), `${COPIED}.\n`);
    a.git("add", "-A");
    a.git("commit", "-q", "-m", "docs: exemplo");
    a.git("tag", "-f", "v0.2.0");
    const tree = a.git("rev-parse", "HEAD^{tree}");
    fs.writeFileSync(path.join(a.dir, ".git/ah-verified", `${tree}.json`), JSON.stringify({ tree, at: "2026-01-01T00:00:00Z", checks: ["gate", "typecheck", "suite"] }));
    const copied = a.publish("--yes");
    expect(copied.status, copied.out).toBe(3);
    expect(copied.out).toMatch(/cruzamento com as fontes privadas/);
    expect(a.remoteGit("rev-parse", "main")).toBe(beforeA);

    const b = sandbox();
    release(b);
    const beforeB = b.remoteGit("rev-parse", "main");
    delete b.env.AH_OSS_PRIVATE_SOURCES;
    const none = b.publish("--yes");
    expect(none.status, none.out).toBe(3);
    expect(b.remoteGit("rev-parse", "main")).toBe(beforeB);
  });

  it("a identidade do projeto assina o commit público quando declarada (o e-mail de quem publica não vai)", () => {
    const s = sandbox();
    release(s);
    s.env.AH_PUBLISH_AUTHOR_NAME = "Projeto";
    s.env.AH_PUBLISH_AUTHOR_EMAIL = "projeto@example.test";
    expect(s.publish("--yes").status).toBe(0);
    expect(s.remoteGit("log", "-1", "--format=%an <%ae> / %cn <%ce>", "main")).toBe("Projeto <projeto@example.test> / Projeto <projeto@example.test>");
  });
});

describe("ah-publish --new-history — o histórico público sai, a árvore fica", { timeout: 60_000 }, () => {
  it("com o branch JÁ público, substituir exige uma pessoa num terminal: sem terminal recusa (2) e o remoto não muda", () => {
    const s = sandbox();
    const before = s.remoteGit("rev-parse", "main");
    release(s);
    const dry = s.publish("--new-history");
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toMatch(/SEM PAI/);
    expect(dry.out).toMatch(/SUBSTITUI/);
    const r = s.publish("--new-history", "--yes");
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/exige uma pessoa num terminal/);
    expect(s.remoteGit("rev-parse", "main")).toBe(before);
    expect(s.remoteGit("tag", "-l")).toBe("v0.1.0");
  });

  it("num repositório VAZIO é um push comum: um commit sem pai com a árvore do HEAD, a tag, e o próximo release avança dele", () => {
    const s = sandbox({ emptyRemote: true });
    release(s);
    const r = s.publish("--new-history", "--yes");
    expect(r.status, r.out).toBe(0);
    const root = s.remoteGit("rev-parse", "main");
    expect(s.remoteGit("rev-list", "--count", "main")).toBe("1");
    expect(s.remoteGit("rev-parse", "main^{tree}")).toBe(s.git("rev-parse", "HEAD^{tree}"));
    expect(s.remoteGit("rev-parse", "v0.2.0^{commit}")).toBe(root);
    expect(s.remoteGit("log", "--format=%B", "main")).not.toMatch(/trabalho privado|base pública/);

    release(s, { text: "export const ok = 2;\n", tag: "v0.3.0" });
    const next = s.publish("--yes");
    expect(next.status, next.out).toBe(0);
    expect(s.remoteGit("rev-parse", "main^")).toBe(root);
    expect(s.remoteGit("rev-list", "--count", "main")).toBe("2");
  });

  it("sem --new-history, um remoto sem o branch é erro de uso (2) — nunca um push às cegas", () => {
    const s = sandbox({ emptyRemote: true });
    release(s);
    const r = s.publish("--yes");
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/--new-history/);
  });
});
