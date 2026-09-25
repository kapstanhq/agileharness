// O GATE DE DADOS (mergeGate.dataUnits) — git REAL, split ligado, suítes REAIS (`node --test`, vitest).
//
// O defeito medido no alvo de referência: com `staging` ligado, o split manda para `main` tudo o que está fora
// de `staging.codePrefixes` como "board-data", SEM gate — `scripts/deploy/**` (o sistema de deploy, com suíte
// vitest), `scripts/ops/**`, `scripts/gc/**` (suítes `node --test`) e o `justfile` chegavam a main sem rodar um
// teste. Cada caso abaixo reprova sem a proteção que ele nomeia:
//   · metade de dados vermelha ⇒ NADA aterrissa (nem o código em stage — o gate roda ANTES do split);
//   · sessão ⇒ o recado volta para ela; run ⇒ gate-failed com bloqueador;
//   · verde ⇒ as duas metades aterrissam e o relatório diz quantos testes de main rodaram;
//   · falha que main JÁ tinha não é atribuída ao delta (a atribuição re-mede main sem o patch);
//   · a metade de dados que não aplica em main é CONFLITO, e nada aterrissa;
//   · o card que main também moveu chega à árvore FUNDIDO POR CAMPO, como a aterrissagem o funde;
//   · a unidade vitest-json roda com seleção por afetados contra main;
//   · e a entrada que não toca prefixo declarado segue EXATAMENTE como hoje (o gate nem é chamado).
import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { describePosix } from "./test-platform";
import { makeDefaultDataGateRunner, makeMergeQueue, type DataGateRunner, type MergeQueueConfig, type MergeQueueStore } from "./merge-queue";
import { findRepoRoot } from "@/lib/storymap/paths";
import { ensureRunnerStateDir, isolatedGitExec } from "./git-test-env";
import type { GateUnitSpec } from "./gate-scope";
import type { ExecFn } from "./worktree";
import type { MergeQueueEntry } from "./types";

const baseExec = promisify(nodeExec) as unknown as ExecFn;

function memStore(): MergeQueueStore & { read: () => MergeQueueEntry[] } {
  let saved: MergeQueueEntry[] = [];
  return {
    load: async () => saved.map((e) => ({ ...e })),
    persist: async (entries) => {
      saved = entries.map((e) => ({ ...e }));
    },
    read: () => saved,
  };
}

const NODE = process.execPath;
/** A suíte `node --test` de scripts/ops, medida por JUnit (a forma do exemplo publicado no settings.yaml). */
const OPS_UNIT: Record<string, GateUnitSpec> = {
  "scripts/ops": {
    command: `${NODE} --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=junit.xml`,
    reporter: "junit-xml",
    junitPath: "junit.xml",
  },
};
const CARD = "storymap/boards/b/cards/story-c.md";
const card = (fields: string[]) => ["---", "id: story-c", "type: story", ...fields, "---", "", "corpo", ""].join("\n");
const TEST_OK = `import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "./lib.mjs";\ntest("soma", () => assert.equal(add(1, 2), 3));\n`;

describePosix("gate de dados (real git) — a metade do split que vai para main é medida contra main", () => {
  let tmpRoot: string;
  let repo: string;
  let main: string;
  let exec: ExecFn;
  const blockers: string[] = [];

  const git = (args: string, cwd = repo) => exec(`git ${args}`, { cwd, timeout: 60_000 });
  const show = async (ref: string): Promise<string | null> => git(`show ${ref}`).then((r) => r.stdout).catch(() => null);
  const write = async (rel: string, body: string) => {
    await fsp.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fsp.writeFile(path.join(repo, rel), body);
  };
  /** Um branch cortado de main com estes arquivos; volta para main. */
  const branch = async (name: string, files: Record<string, string>) => {
    await git(`checkout -q -b ${name}`);
    for (const [rel, body] of Object.entries(files)) await write(rel, body);
    await git(`add -A`);
    await git(`commit -q --no-verify -m ${JSON.stringify(`work ${name}`)}`);
    await git(`checkout -q ${main}`);
  };
  const commitOnMain = async (files: Record<string, string>, msg: string) => {
    for (const [rel, body] of Object.entries(files)) await write(rel, body);
    await git(`add -A`);
    await git(`commit -q --no-verify -m ${JSON.stringify(msg)}`);
  };
  const queue = (over: Partial<MergeQueueConfig> = {}) => {
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store,
      now: () => 1000,
      sleep: async () => {},
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      gateEnabled: true,
      gateDataUnits: OPS_UNIT,
      gateIsolation: { mode: "none", reason: "teste sem selo" },
      gateTimeoutMs: 120_000,
      dataGate: makeDefaultDataGateRunner(),
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
      clearRunBlockers: async () => {},
      addGateBlocker: async (_b, _c, runId, log) => void blockers.push(`${runId}: ${log}`),
      ...over,
    });
    return { mq, store };
  };

  beforeEach(async () => {
    blockers.length = 0;
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ah-data-gate-"));
    exec = isolatedGitExec(baseExec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "repo");
    await fsp.mkdir(repo, { recursive: true });
    await write(".gitignore", "node_modules\n.worktrees/\njunit.xml\n");
    await write("scripts/git-hooks/scan-secrets.mjs", await fsp.readFile(path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"), "utf8"));
    await write("packages/app/x.ts", "export const x = 1;\n");
    await write("scripts/ops/lib.mjs", "export const add = (a, b) => a + b;\n");
    await write("scripts/ops/lib.test.mjs", TEST_OK);
    await write(CARD, card(["title: Título base", "status: priorizar"]));
    await git(`init -q -b main`);
    await git(`config user.email t@t.dev`);
    await git(`config user.name tester`);
    await git(`add -A`);
    await git(`commit -q --no-verify -m base`);
    main = "main";
  });
  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("[REGRESSÃO] a metade de dados que quebra a suíte de scripts/ops NÃO aterrissa — nem o código vai para stage", async () => {
    await branch("run/red", {
      "packages/app/x.ts": "export const x = 2;\n",
      "scripts/ops/lib.mjs": "export const add = (a, b) => a - b;\n",
      [CARD]: card(["title: Título base", "status: desenvolver"]),
    });
    const { mq, store } = queue();
    await mq.enqueueMerge({ runId: "red", board: "b", cardId: "story-c", branch: "run/red" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status, e.gateLog).toBe("gate-failed");
    expect(e.gateLog).toMatch(/^gate de dados \(main@[0-9a-f]{8}\): /);
    expect(e.gateLog).toContain("soma");
    expect(e.split, "entrou no split — algo aterrissou antes do veredito").toBeUndefined();
    // main intocada: nem o ferramental quebrado nem o card
    expect(await show(`main:scripts/ops/lib.mjs`)).toContain("a + b");
    expect(await show(`main:${CARD}`)).toContain("status: priorizar");
    // e o código NÃO foi para stage (o gate de dados roda ANTES das duas metades)
    expect(await show(`stage:packages/app/x.ts`)).toBeNull();
    // o relatório diz o que rodou contra main
    expect(e.gateReport?.units).toHaveLength(1);
    expect(e.gateReport?.units[0]).toMatchObject({ label: "scripts/ops", half: "data", reporter: "junit-xml", tests: 1, failures: 1 });
    expect(blockers).toHaveLength(1);
    // a árvore descartável não sobrou
    expect(await fsp.stat(path.join(repo, ".worktrees", "gate-red")).catch(() => null)).toBeNull();
  }, 120_000);

  it("verde ⇒ as duas metades aterrissam, e o relatório diz quantos testes de main rodaram", async () => {
    await branch("run/green", {
      "packages/app/x.ts": "export const x = 2;\n",
      "scripts/ops/lib.mjs": "// soma\nexport const add = (a, b) => a + b;\n",
      "scripts/ops/more.test.mjs": `import test from "node:test";\nimport assert from "node:assert";\ntest("um", () => assert.ok(true));\ntest("dois", () => assert.ok(true));\n`,
      [CARD]: card(["title: Título base", "status: desenvolver"]),
    });
    const { mq, store } = queue();
    await mq.enqueueMerge({ runId: "green", board: "b", cardId: "story-c", branch: "run/green" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status, e.failureReason ?? e.gateLog ?? e.conflictDetail).toBe("done");
    expect(e.split).toEqual({ dataLanded: true, codeStaged: true });
    expect(await show(`main:scripts/ops/lib.mjs`)).toContain("// soma");
    expect(await show(`main:${CARD}`)).toContain("status: desenvolver");
    expect(await show(`stage:packages/app/x.ts`)).toContain("x = 2");
    expect(e.gateReport?.testsExecuted).toBe(3);
    expect(e.gateReport?.units[0]).toMatchObject({ half: "data", tests: 3, failures: 0, mode: "full" });
  }, 120_000);

  it("uma SESSÃO com a metade de dados vermelha recebe o recado de volta — nunca espera um humano", async () => {
    await branch("agent/s1", { "scripts/ops/lib.mjs": "export const add = (a, b) => a * b;\n" });
    const { mq, store } = queue();
    await mq.enqueueMerge({ runId: "s1", board: "b", branch: "agent/s1", kind: "session" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status).toBe("returned-to-session");
    expect(e.conflictDetail).toContain("gate de dados (o que aterrissa em main) reprovou");
    expect(e.conflictDetail).toContain("soma");
    expect(await show(`main:scripts/ops/lib.mjs`)).toContain("a + b");
  }, 120_000);

  it("falha que main JÁ tinha não é atribuída ao delta — a atribuição re-mede main sem o patch", async () => {
    await commitOnMain(
      { "scripts/ops/old.test.mjs": `import test from "node:test";\nimport assert from "node:assert";\ntest("antiga vermelha", () => assert.equal(1, 2));\n` },
      "main vermelha",
    );
    await branch("run/pre", { "scripts/ops/lib.mjs": "// nota\nexport const add = (a, b) => a + b;\n" });
    const { mq, store } = queue();
    await mq.enqueueMerge({ runId: "pre", board: "b", cardId: "story-c", branch: "run/pre" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status, e.gateLog).toBe("done");
    expect(await show(`main:scripts/ops/lib.mjs`)).toContain("// nota");
  }, 120_000);

  it("a metade de dados que NÃO aplica em main é conflito — e nada aterrissa", async () => {
    await branch("run/conf", {
      "packages/app/x.ts": "export const x = 3;\n",
      "scripts/ops/lib.mjs": "export const add = (a, b) => b + a; // run\n",
    });
    await commitOnMain({ "scripts/ops/lib.mjs": "export const add = (a, b) => a + b + 0; // main\n" }, "main mexe na mesma linha");
    const { mq, store } = queue();
    await mq.enqueueMerge({ runId: "conf", board: "b", cardId: "story-c", branch: "run/conf" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status).toBe("conflict");
    expect(e.conflictDetail).toContain("gate de dados");
    expect(e.conflict?.files).toContain("scripts/ops/lib.mjs");
    expect(await show(`main:scripts/ops/lib.mjs`)).toContain("// main");
    expect(await show(`stage:packages/app/x.ts`)).toBeNull();
  }, 120_000);

  it("o card que main TAMBÉM moveu chega à árvore FUNDIDO POR CAMPO — a mesma régua da aterrissagem", async () => {
    // a unidade LÊ o card na árvore: ela só passa se a árvore tiver o que a aterrissagem vai produzir
    const check =
      `${NODE} -e "const c=require('fs').readFileSync('../../${CARD}','utf8');` +
      `process.exit(c.includes('Título humano')&&c.includes('status: desenvolver')&&!c.includes('<<<<<<<')?0:1)"`;
    await branch("run/carve", {
      "scripts/ops/lib.mjs": "// carve\nexport const add = (a, b) => a + b;\n",
      [CARD]: card(["title: Título base", "status: desenvolver"]),
    });
    await commitOnMain({ [CARD]: card(["title: Título humano", "status: pronta"]) }, "humano edita o card em main");
    const { mq, store } = queue({ gateDataUnits: { "scripts/ops": { command: check, reporter: "exit-code" } } });
    await mq.enqueueMerge({ runId: "carve", board: "b", cardId: "story-c", branch: "run/carve" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status, e.gateLog ?? e.conflictDetail).toBe("done");
    const final = await show(`main:${CARD}`);
    expect(final).toContain("Título humano");
    expect(final).toContain("status: desenvolver");
  }, 120_000);

  it("a unidade vitest-json roda com seleção por AFETADOS contra main (`--changed <sha de main>`)", async () => {
    // node_modules do alvo (gitignorado) = o deste pacote: a árvore do gate o recebe por link, como em produção
    await fsp.symlink(path.resolve(process.cwd(), "node_modules"), path.join(repo, "node_modules"));
    await commitOnMain(
      {
        "scripts/deploy/lib.mjs": "export const dobro = (n) => n * 2;\n",
        "scripts/deploy/__tests__/lib.test.mjs": `import { expect, it } from "vitest";\nimport { dobro } from "../lib.mjs";\nit("dobro", () => expect(dobro(2)).toBe(4));\n`,
        "scripts/deploy/__tests__/outro.test.mjs": `import { expect, it } from "vitest";\nit("intocado", () => expect(1).toBe(1));\n`,
      },
      "suíte de deploy",
    );
    const mainSha = (await git(`rev-parse HEAD`)).stdout.trim();
    await branch("run/vit", { "scripts/deploy/lib.mjs": "// v2\nexport const dobro = (n) => n * 2;\n" });
    const vitest = path.resolve(process.cwd(), "node_modules", ".bin", "vitest");
    const { mq, store } = queue({
      gateDataUnits: { "scripts/deploy": { command: `${vitest} run --no-cache` } },
      gateAffected: { enabled: true, fullSuitePaths: [] },
    });
    await mq.enqueueMerge({ runId: "vit", board: "b", cardId: "story-c", branch: "run/vit" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status, e.gateLog ?? e.conflictDetail).toBe("done");
    const u = e.gateReport!.units[0];
    expect(u).toMatchObject({ label: "scripts/deploy", half: "data", reporter: "vitest-json", mode: "affected" });
    expect(u.argv.at(-1)).toContain(`--changed ${mainSha}`);
    // só o teste que importa o arquivo mudado foi selecionado — N>0, e não a suíte inteira
    expect(u.tests).toBe(1);
  }, 180_000);

  it("o código não-liberado de `stage` NÃO entra na árvore de main — só a metade de dados é aplicada lá", async () => {
    // stage já carrega código que main não tem (x = 10); o run, cortado de stage, o edita (10 → 11) e mexe em
    // scripts/ops. O patch de CÓDIGO não aplica em main (lá x = 1) — se ele vazasse para a árvore do gate de
    // dados, o gate diria "conflito" sobre um delta que aterrissa limpo nas duas metades.
    await git(`checkout -q -b stage`);
    await write("packages/app/x.ts", "export const x = 10;\n");
    await git(`add -A`);
    await git(`commit -q --no-verify -m "código não-liberado"`);
    const stageSha = (await git(`rev-parse HEAD`)).stdout.trim();
    await git(`checkout -q ${main}`);
    await git(`checkout -q -b run/staged stage`);
    await write("packages/app/x.ts", "export const x = 11;\n");
    await write("scripts/ops/lib.mjs", "// staged\nexport const add = (a, b) => a + b;\n");
    await git(`add -A`);
    await git(`commit -q --no-verify -m "run sobre stage"`);
    await git(`checkout -q ${main}`);

    const { mq, store } = queue();
    await mq.enqueueMerge({ runId: "staged", board: "b", cardId: "story-c", branch: "run/staged", baseCommit: stageSha });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status, e.gateLog ?? e.conflictDetail).toBe("done");
    expect(e.gateReport?.units[0]).toMatchObject({ half: "data", tests: 1, failures: 0 });
    expect(await show(`main:scripts/ops/lib.mjs`)).toContain("// staged");
    expect(await show(`main:packages/app/x.ts`)).toContain("x = 1;");
    expect(await show(`stage:packages/app/x.ts`)).toContain("x = 11");
  }, 120_000);

  it("INCONCLUSIVO (infra) re-enfileira com o MESMO teto do gate de código, e integra no retry", async () => {
    await branch("run/flake", { "scripts/ops/lib.mjs": "// f\nexport const add = (a, b) => a + b;\n" });
    let calls = 0;
    const flaky: DataGateRunner = async (o) => (++calls === 1 ? { passed: false, inconclusive: true, log: "morto no meio" } : makeDefaultDataGateRunner()(o));
    const { mq, store } = queue({ dataGate: flaky });
    await mq.enqueueMerge({ runId: "flake", board: "b", cardId: "story-c", branch: "run/flake" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(calls).toBe(2);
    expect(e.status).toBe("done");
    expect(e.gateInconclusiveRetries).toBe(1);
  }, 120_000);

  it("INCONCLUSIVO persistente (o runner LANÇA) nunca aprova: esgota o retry e parqueia rotulado", async () => {
    await branch("run/boom", { "scripts/ops/lib.mjs": "// b\nexport const add = (a, b) => a + b;\n" });
    const { mq, store } = queue({
      dataGate: async () => {
        throw new Error("sem disco");
      },
    });
    await mq.enqueueMerge({ runId: "boom", board: "b", cardId: "story-c", branch: "run/boom" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status).toBe("gate-failed");
    expect(e.gateLog).toContain("gate de dados erro inesperado: sem disco");
    expect(await show(`main:scripts/ops/lib.mjs`)).not.toContain("// b");
  }, 120_000);

  it("gate desligado (`mergeGate.enabled: false`) ⇒ o de dados também não roda", async () => {
    await branch("run/off", { "scripts/ops/lib.mjs": "export const add = (a, b) => a - b;\n" });
    let calls = 0;
    const { mq, store } = queue({ gateEnabled: false, dataGate: async () => (calls++, { passed: false, log: "x" }) });
    await mq.enqueueMerge({ runId: "off", board: "b", cardId: "story-c", branch: "run/off" });
    await mq.whenIdle();
    expect(calls).toBe(0);
    expect(store.read()[0].status).toBe("done"); // o comportamento de hoje com o gate desligado
  }, 120_000);

  it("o relatório da entrada SOMA as unidades de código e as de dados da mesma passada", async () => {
    await branch("run/both", {
      "packages/app/x.ts": "export const x = 7;\n",
      "scripts/ops/lib.mjs": "// both\nexport const add = (a, b) => a + b;\n",
    });
    const codeReport = {
      isolation: "none" as const,
      isolationReason: "teste",
      testsExecuted: 40,
      uncountedUnits: 0,
      units: [{ label: "packages/app", cwd: "packages/app", reporter: "vitest-json" as const, mode: "full" as const, network: "deny" as const, isolation: "none" as const, argv: ["/bin/sh", "-c", "vitest"], exitCode: 0, tests: 40, failures: 0 }],
    };
    const { mq, store } = queue({ integrationGate: async () => ({ passed: true, log: "✓", report: codeReport }) });
    await mq.enqueueMerge({ runId: "both", board: "b", cardId: "story-c", branch: "run/both" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(e.status, e.gateLog).toBe("done");
    expect(e.gateReport?.units.map((u) => [u.label, u.half ?? "code"])).toEqual([
      ["packages/app", "code"],
      ["scripts/ops", "data"],
    ]);
    expect(e.gateReport?.testsExecuted).toBe(41);
  }, 120_000);

  it("a entrada que NÃO toca prefixo declarado segue exatamente como hoje — o gate de dados nem é chamado", async () => {
    await branch("run/plain", {
      "packages/app/x.ts": "export const x = 5;\n",
      [CARD]: card(["title: Título base", "status: desenvolver"]),
      "docs/nota.md": "nota\n",
    });
    let calls = 0;
    const spy: DataGateRunner = async (o) => {
      calls++;
      return makeDefaultDataGateRunner()(o);
    };
    const { mq, store } = queue({ dataGate: spy });
    await mq.enqueueMerge({ runId: "plain", board: "b", cardId: "story-c", branch: "run/plain" });
    await mq.whenIdle();

    const e = store.read()[0];
    expect(calls).toBe(0);
    expect(e.status).toBe("done");
    expect(e.split).toEqual({ dataLanded: true, codeStaged: true });
    expect(e.gateReport).toBeUndefined();
    expect(await show(`main:docs/nota.md`)).toBe("nota\n");
  }, 120_000);
});
