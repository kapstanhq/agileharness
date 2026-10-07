// A FRONTEIRA de um board: o que a raia "No stage" conta como "ainda não no ar".
//
// Regressão de um número ERRADO em produção, não de um crash. A base do delta é a fronteira do board
// (`refs/promoted/<board>`), e `base..stage` significa "alcançável do stage e não da fronteira" — o que
// inclui commits que voltaram de `main` para o stage no refluxo. Com o pathspec do `acme` cobrindo
// `packages/commons*` (sharedPackages), o commit `release:` de OUTRO board caiu dentro do escopo e a
// página anunciou por dias uma entrega "ainda não no ar" que era ancestral de HEAD.
//
// O objeto do teste são os ARGUMENTOS do git: a exclusão tem de existir nas DUAS consultas (a lista e a
// contagem), senão o contador e a raia divergem — e é o contador que decide publicar.

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describePosix } from "./test-platform";
import { isolatedGitExec } from "./git-test-env";
import type { ExecFn } from "./worktree";

vi.mock("@/lib/storymap/paths", () => ({ findRepoRoot: () => "/repo" }));
vi.mock("./config", () => ({
  loadRunnerConfig: () => ({
    autorun: {
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      publishQueue: { enabled: true },
    },
  }),
}));
vi.mock("@/lib/storymap/repo", () => ({
  listBoards: vi.fn(async () => [{ id: "acme" }]),
  readBoardConfig: vi.fn(async () => ({
    package: "packages/acmeapp",
    sharedPackages: ["packages/commons/", "packages/acme-shared/"],
    // Sem `release` declarado ⇒ o default seguro (`manual`), que é o que o teste abaixo espera.
  })),
}));

import { frontierOf } from "./delivery-deps";

const LIVE = "3c9a5d172aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STAGE = "a81f06e2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FRONTIER = "5d27b9c4accccccccccccccccccccccccccccccc";

/** Um `exec` que registra os comandos e responde por casamento de prefixo. */
function fakeExec(responses: Array<[RegExp, string]>, seen: string[]) {
  return vi.fn(async (cmd: string) => {
    seen.push(cmd);
    for (const [re, out] of responses) if (re.test(cmd)) return { stdout: out, stderr: "" };
    throw new Error(`comando não esperado: ${cmd}`);
  });
}

const BLOB_STAGE = "b".repeat(40);
const BLOB_LIVE = "c".repeat(40);
const MB = "d".repeat(40);

function baseResponses(count: string, log: string): Array<[RegExp, string]> {
  return [
    [/log -1 --format=/, `${LIVE} 2026-02-11T09:15:42+00:00`],
    [/rev-parse --verify --quiet "stage\^\{commit\}"/, STAGE],
    [/rev-parse --verify --quiet "refs\/promoted\/acme"/, FRONTIER],
    [/merge-base --is-ancestor/, ""],
    // a régua por CONTEÚDO (stage-content.ts): um arquivo do escopo difere entre main e stage, a stage o mudou desde a
    // base e o conteúdo dela nunca esteve na main
    [/diff --name-only --no-renames/, "packages/acmeapp/a.ts"],
    [/^git merge-base "/, MB],
    [/^git ls-tree -r "stage"/, `100644 blob ${BLOB_STAGE}\tpackages/acmeapp/a.ts`],
    [/^git ls-tree -r "d+"/, `100644 blob ${BLOB_LIVE}\tpackages/acmeapp/a.ts`],
    [/^git log --raw/, ""],
    [/rev-list --no-merges --count/, count],
    [/^git log --no-merges --max-count=/, log],
  ];
}

describe("frontierOf — o que já está NO AR não conta como entrega pendente", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exclui o sha vivo nas DUAS consultas (lista e contagem)", async () => {
    const seen: string[] = [];
    const f = await frontierOf("acme", fakeExec(baseResponses("7", ""), seen) as never);

    const list = seen.find((c) => c.startsWith("git log --no-merges --max-count="));
    const count = seen.find((c) => c.includes("rev-list --no-merges --count"));
    expect(list).toContain(`--not ${JSON.stringify(LIVE)}`);
    expect(count).toContain(`--not ${JSON.stringify(LIVE)}`);
    expect(f.stagedTotal).toBe(7);
  });

  it("mantém a base na fronteira do board e o pathspec dos pacotes dele", async () => {
    const seen: string[] = [];
    await frontierOf("acme", fakeExec(baseResponses("7", ""), seen) as never);

    const count = seen.find((c) => c.includes("rev-list --no-merges --count"))!;
    // A ordem importa: `base..stage` PRIMEIRO, a exclusão depois, o pathspec por último — `--` encerra
    // as revisões, então um `--not` do outro lado dele viraria caminho.
    expect(count).toMatch(/"5d27b9c4[a-f0-9]*"\.\."stage" --not "3c9a5d17[a-f0-9]*" -- /);
    // a contagem é dos commits que tocam os arquivos PENDENTES por conteúdo
    expect(count).toContain('"packages/acmeapp/a.ts"');
    // e o conteúdo é medido no escopo do board: o pacote dele e os compartilhados que ele declara
    const scope = seen.find((c) => c.includes("diff --name-only --no-renames") && c.includes(".."))!;
    expect(scope).toContain(`"${FRONTIER}".."stage"`);
    expect(scope).toContain('"packages/acmeapp/"');
    expect(scope).toContain('"packages/commons/"');
    expect(scope).toContain('"packages/acme-shared/"');
    // O pacote de OUTRO board nunca entra no escopo deste.
    expect(seen.join("\n")).not.toContain("storymap-ui");
  });

  it("sem sha vivo legível, mede sem a exclusão em vez de não medir", async () => {
    const seen: string[] = [];
    const responses = baseResponses("8", "").map(([re, out]) =>
      /log -1 --format=/.test(String(re)) ? ([re, ""] as [RegExp, string]) : ([re, out] as [RegExp, string]),
    );
    const f = await frontierOf("acme", fakeExec(responses, seen) as never);

    const count = seen.find((c) => c.includes("rev-list --no-merges --count"))!;
    expect(count).not.toContain("--not");
    expect(f.stagedTotal).toBe(8);
    // Falsy, não `null`: o `git` devolveu string VAZIA (não falhou), e o default do destructuring só
    // cobre `undefined` — então sobra `""`. O que a exclusão precisa é exatamente isto: um guard por
    // veracidade, não por `!= null`, senão `--not ""` iria para a linha de comando.
    expect(f.liveSha).toBeFalsy();
  });

  it("separa PODE publicar (máquina) de PUBLICA SOZINHO (board)", async () => {
    // A regressão que isto tranca: as duas respostas vinham de UMA flag, e desligá-la apagava o botão
    // junto com o automático — o board ficava sem alavanca nenhuma, que foi o que prendeu o acme.
    const seen: string[] = [];
    const f = await frontierOf("acme", fakeExec(baseResponses("7", ""), seen) as never);
    expect(f.releaseMode).toBe("manual"); // o board não declarou ⇒ default seguro
    expect(f.canPublish).toBe(true); // …e mesmo assim a publicação PODE ser pedida
  });
});

// ── a contagem pela DIFERENÇA DE CONTEÚDO, em git de verdade ──────────────────────────────────────────────────────────
// O número «N entregas ainda não no ar» decide publicar. Contado por commits do stage fora do histórico da main, ele
// mentia: a promoção re-commita o delta (o commit do stage nunca vira ancestral da main), então uma stage ATRÁS da main
// num arquivo do escopo seguia «pendente» — e publicá-la reverteria a main. A régua é a do conteúdo (stage-content.ts).
describePosix("frontierOf — conta pelo CONTEÚDO, não por commit fora do histórico da main (git real)", () => {
  let tmp: string;
  let repo: string;
  let gitExec: ExecFn;
  const run = (cmd: string) => gitExec(cmd, { cwd: repo });
  const write = (rel: string, body: string) => fsp.writeFile(path.join(repo, rel), body);
  const commit = async (msg: string) => {
    await run(`git add -A`);
    await run(`git commit -q --no-verify -m ${JSON.stringify(msg)}`);
  };
  /** o `exec` do módulo, apontado para o repositório do teste (o módulo roda no `findRepoRoot()` simulado). */
  const execHere = (() => (cmd: string, opts: Record<string, unknown> = {}) => gitExec(cmd, { ...opts, cwd: repo })) as unknown as () => ExecFn;

  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-frontier-"));
    gitExec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, tmp);
    repo = path.join(tmp, "repo");
    await fsp.mkdir(path.join(repo, "packages", "acmeapp"), { recursive: true });
    await write("packages/acmeapp/preco.ts", "export const preco = 1;\n");
    await write("packages/acmeapp/nota.ts", "export const nota = 'x';\n");
    await run(`git init -q`);
    await run(`git config user.email t@example.test`);
    await run(`git config user.name tester`);
    await commit("base");
    const main = (await run(`git rev-parse --abbrev-ref HEAD`)).stdout.trim();
    await run(`git checkout -q -b stage`);
    await write("packages/acmeapp/preco.ts", "export const preco = 2;\n");
    await commit("usm(card): preco 2");
    await run(`git checkout -q ${main}`);
    // a promoção re-commita o delta na main; depois a main anda de novo no MESMO arquivo — a stage fica atrás
    await write("packages/acmeapp/preco.ts", "export const preco = 2;\n");
    await commit("release: promove preco 2");
    await write("packages/acmeapp/preco.ts", "export const preco = 3;\n");
    await commit("conserto direto na main: preco 3");
  });

  afterAll(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("stage ATRÁS da main num caminho do escopo ⇒ «tudo publicado» (o commit do stage fora da main não conta)", async () => {
    // a régua antiga: há 1 commit do stage que a main não tem, no escopo — e ela o chamava de entrega pendente
    expect((await run(`git rev-list --no-merges --count HEAD..stage -- packages/acmeapp/`)).stdout.trim()).toBe("1");
    const f = await frontierOf("acme", execHere());
    expect(f.stagedTotal).toBe(0);
    expect(f.pendingFiles).toBe(0);
    expect(f.staged).toEqual([]);
  });

  it("uma entrega NOVA na stage ⇒ ela, e só ela, conta", async () => {
    const main = (await run(`git rev-parse --abbrev-ref HEAD`)).stdout.trim();
    await run(`git checkout -q stage`);
    await write("packages/acmeapp/nota.ts", "export const nota = 'y';\n");
    await commit("usm(card): nota y");
    await run(`git checkout -q ${main}`);
    const f = await frontierOf("acme", execHere());
    expect(f.pendingFiles).toBe(1);
    expect(f.stagedTotal).toBe(1);
    expect(f.staged.map((s) => s.subject)).toEqual(["usm(card): nota y"]);
  });
});
