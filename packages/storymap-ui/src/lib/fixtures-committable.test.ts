// GUARDA: toda fixture que um teste lê tem de poder ir para o git.
//
// O incidente (v0.9.9): as fixtures do item 9 eram `*.log`, que o `.gitignore` do pacote ignora. No worktree de quem
// as criou a suíte ficava verde (o arquivo estava no disco); o commit saiu sem elas, e em todo checkout limpo os dois
// testes quebravam com ENOENT. Suíte verde num worktree não prova que o que ela lê foi versionado.
//
// Três leituras, da mais concreta à mais ampla — nenhuma aceita um caminho que o git ignora (um arquivo já
// VERSIONADO passa: o `git check-ignore` padrão não reporta arquivo rastreado):
//   1. todo arquivo que EXISTE sob um `__fixtures__/` do pacote (pega o erro no worktree de quem cria a fixture);
//   2. todo caminho `__fixtures__/<arquivo>` escrito por extenso num teste (pega em checkout limpo);
//   3. todo nome de arquivo solto num teste que lê `__fixtures__` (o helper `fixture("x.json")`), resolvido no
//      `__fixtures__/` ao lado do teste.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(PKG, "src");
const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: PKG, encoding: "utf8" }).stdout?.trim() === "true";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Os caminhos (relativos ao pacote) que o git IGNORA — rastreados nunca aparecem. */
function ignoredByGit(paths: string[]): string[] {
  if (!paths.length) return [];
  const r = spawnSync("git", ["check-ignore", "--", ...paths], { cwd: PKG, encoding: "utf8" });
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(`git check-ignore falhou: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

const rel = (p: string) => path.relative(PKG, p).split(path.sep).join("/");
const files = walk(SRC);
const tests = files.filter((f) => /\.test\.tsx?$/.test(f) && !f.endsWith("fixtures-committable.test.ts"));
const readers = tests.map((f) => ({ file: f, text: readFileSync(f, "utf8") })).filter((t) => t.text.includes("__fixtures__"));

const EXPLICIT = /["'`]((?:\.\/|src\/[\w./-]*?)?__fixtures__\/[\w./-]+\.[A-Za-z0-9]+)["'`]/g;
const BARE = /["'`]([\w.-]+\.(?:log|txt|json|jsonl|md|xml|out|csv|ya?ml|html|snap))["'`]/g;
const HOW = "renomeie para uma extensão que o git não ignora (.txt, .jsonl, .json) e versione — ou force com `git add -f`";

describe.skipIf(!inGit)("fixtures de teste podem ir para o git", () => {
  it("nenhum arquivo sob `__fixtures__/` é ignorado pelo git", () => {
    const present = files.filter((f) => f.includes(`${path.sep}__fixtures__${path.sep}`)).map(rel);
    expect(present.length).toBeGreaterThan(0);
    expect(ignoredByGit(present), HOW).toEqual([]);
  });

  it("nenhum caminho `__fixtures__/…` escrito num teste aponta para um arquivo ignorado", () => {
    const refs = new Set<string>();
    for (const t of readers) {
      for (const m of t.text.matchAll(EXPLICIT)) {
        // `src/…/__fixtures__/x` é relativo ao pacote; `./__fixtures__/x`, ao teste
        refs.add(m[1].startsWith("src/") ? m[1] : rel(path.join(path.dirname(t.file), m[1])));
      }
    }
    expect(refs.size).toBeGreaterThan(0);
    expect(ignoredByGit([...refs]), HOW).toEqual([]);
  });

  it("nenhum nome de fixture solto num teste que lê `__fixtures__` é um nome que o git ignora", () => {
    const refs = new Set<string>();
    for (const t of readers) {
      for (const m of t.text.matchAll(BARE)) refs.add(rel(path.join(path.dirname(t.file), "__fixtures__", m[1])));
    }
    expect(ignoredByGit([...refs]), HOW).toEqual([]);
  });
});
