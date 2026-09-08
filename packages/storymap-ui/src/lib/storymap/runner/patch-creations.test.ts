// patch-creations.test.ts — o defeito que estes testes REPRODUZEM antes de provar o conserto:
// um patch que CRIA um arquivo num caminho que o worktree-alvo ainda gitignora (vendoring) deixa,
// depois de um `reset --hard`, um resíduo que faz `git apply --check` morrer com «already exists in
// working directory». O train lia isso como «código conflita com stage» — e o patch aplica limpo num
// worktree fresco. Git REAL num diretório temporário: a régua é a do incidente, não um mock.
import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitResult, GitRunner } from "./git";
import { patchCreatedPaths, sweepPatchCreations } from "./patch-creations";

const GIT_ID = "-c user.name=t -c user.email=t@t -c commit.gpgsign=false";

/** Um GitRunner de verdade sobre o shell — `quote()` do módulo produz aspas de shell, então é `git <args>` mesmo. */
function realGit(): GitRunner {
  return async (args: string, cwd?: string): Promise<GitResult> => {
    try {
      const stdout = execSync(`git ${GIT_ID} ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { ok: false, code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  };
}

const dirs: string[] = [];
function tmpRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-patch-creations-"));
  dirs.push(dir);
  execSync(`git ${GIT_ID} init -q -b main`, { cwd: dir });
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function commitAll(dir: string, msg: string) {
  execSync(`git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m ${JSON.stringify(msg)}`, { cwd: dir });
}

describe("patchCreatedPaths — o que um patch CRIA", () => {
  it("distingue criação (new file mode) de modificação e deleção; caminho com espaço é pulado", () => {
    const patch = [
      "diff --git a/src/mod.js b/src/mod.js",
      "index 1111111..2222222 100644",
      "--- a/src/mod.js",
      "+++ b/src/mod.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/public/novo.js b/public/novo.js",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/public/novo.js",
      "@@ -0,0 +1 @@",
      "+x",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      'diff --git "a/com espaco.js" "b/com espaco.js"',
      "new file mode 100644",
      "diff --git a/outro novo.js b/outro novo.js",
      "new file mode 100644",
    ].join("\n");
    expect(patchCreatedPaths(patch)).toEqual(["public/novo.js"]);
  });

  it("patch vazio ⇒ lista vazia (não inventa caminho)", () => {
    expect(patchCreatedPaths("")).toEqual([]);
  });
});

describe("sweepPatchCreations — git real: o resíduo que mascara o veredito", () => {
  it("[PRODUTOR] reproduz o «already exists», varre SÓ o resíduo ignorado, e o mesmo patch passa a aplicar", async () => {
    const repo = tmpRepo();
    mkdirSync(path.join(repo, "public"), { recursive: true });
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, ".gitignore"), "/public/x.js\n");
    writeFileSync(path.join(repo, "src/a.js"), "tracked\n");
    commitAll(repo, "base: ignora public/x.js");

    // a branch que VENDORIZA: tira a regra do ignore e cria o arquivo (o commit de preparo do incidente)
    execSync(`git ${GIT_ID} checkout -q -b vendor`, { cwd: repo });
    writeFileSync(path.join(repo, ".gitignore"), "");
    writeFileSync(path.join(repo, "public/x.js"), "vendorizado\n");
    commitAll(repo, "vendoriza public/x.js");
    execSync(`git ${GIT_ID} checkout -q main`, { cwd: repo });

    // o resíduo: a tentativa anterior criou o arquivo, o reset --hard não o removeu (é ignorado na main).
    // (o checkout de volta à main apagou o `public/` vazio — o resíduo recria o diretório, como no incidente)
    mkdirSync(path.join(repo, "public"), { recursive: true });
    writeFileSync(path.join(repo, "public/x.js"), "residuo da tentativa anterior\n");
    const patch = execSync(`git ${GIT_ID} diff --binary --no-renames main..vendor`, { cwd: repo, encoding: "utf8" });
    const patchFile = path.join(repo, "..", path.basename(repo) + ".patch");
    writeFileSync(patchFile, patch);
    dirs.push(patchFile);

    // 1) a REPRODUÇÃO: com o resíduo, o degrau 1 do applyPatch morre exatamente como no incidente
    let checkBefore = "";
    try {
      execSync(`git ${GIT_ID} apply --check ${JSON.stringify(patchFile)}`, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      checkBefore = String((err as { stderr?: string }).stderr ?? "");
    }
    expect(checkBefore).toContain("already exists in working directory");

    // 2) o parse acha exatamente o caminho criado
    const created = patchCreatedPaths(patch);
    expect(created).toEqual(["public/x.js"]);

    // 3) a varredura remove o resíduo e nada mais
    const swept = await sweepPatchCreations(realGit(), repo, created);
    expect(swept).toEqual(["public/x.js"]);
    expect(existsSync(path.join(repo, "public/x.js"))).toBe(false);
    expect(readFileSync(path.join(repo, "src/a.js"), "utf8")).toBe("tracked\n");

    // 4) o CONSERTO: o mesmo patch aplica limpo — o veredito «conflita» era o resíduo, não o código
    expect(() => execSync(`git ${GIT_ID} apply --check ${JSON.stringify(patchFile)}`, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })).not.toThrow();
    // e varrer de novo é idempotente: não havia mais nada
    expect(await sweepPatchCreations(realGit(), repo, created)).toEqual([]);
  });

  it("NUNCA toca caminho RASTREADO — «already exists» ali é conflito real, do applyPatch", async () => {
    const repo = tmpRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src/a.js"), "tracked\n");
    commitAll(repo, "base");
    const swept = await sweepPatchCreations(realGit(), repo, ["src/a.js", "nao/existe.js"]);
    expect(swept).toEqual([]);
    expect(readFileSync(path.join(repo, "src/a.js"), "utf8")).toBe("tracked\n");
  });

  it("varre também o NÃO-RASTREADO não-ignorado (o vendor/snapdom.mjs de julho no worktree do train)", async () => {
    const repo = tmpRepo();
    writeFileSync(path.join(repo, "README.md"), "x\n");
    commitAll(repo, "base");
    mkdirSync(path.join(repo, "public/vendor"), { recursive: true });
    writeFileSync(path.join(repo, "public/vendor/snapdom.mjs"), "residuo\n");
    const swept = await sweepPatchCreations(realGit(), repo, ["public/vendor/snapdom.mjs"]);
    expect(swept).toEqual(["public/vendor/snapdom.mjs"]);
    expect(existsSync(path.join(repo, "public/vendor/snapdom.mjs"))).toBe(false);
  });
});
