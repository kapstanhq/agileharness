// O GATE HONESTO no runner — o que a auditoria v0.5.x mediu, fechado um por um, cada um com o teste que
// falha sem a proteção:
//   1. o `affected.command` global SUBSTITUÍA o comando de toda unidade (pytest rodava vitest; `--config` sumia);
//   2. só o JSON do vitest era lido (`--reporter=json` anexado a qualquer comando);
//   3. nenhuma contagem de testes executados — "verde" sem prova de que algo rodou;
//   4. o código do delta rodava como o serviço, com rede (o selo é testado aqui na FORMA da argv; a
//      contenção de verdade é medida em gate-sandbox.test.ts, contra o systemd deste host).
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { makeDefaultGateRunner, makeMergeQueue, type GateReportIo, type MergeQueueStore } from "./merge-queue";
import type { ExecFn, WorktreeFs } from "./worktree";
import type { GateScopeSpec } from "./gate-scope";
import type { MergeQueueEntry } from "./types";

type Beh = { exit: 0 | 1; stdout?: string; junit?: string | null; killed?: boolean };
type UnitBeh = { merged: Beh; base?: Beh; retry?: Beh };

function vitestJson(pass: number, failures: Array<{ file: string; name: string }> = []) {
  return JSON.stringify({
    numPassedTests: pass,
    numFailedTests: failures.length,
    testResults: [
      ...failures.map((f) => ({ name: f.file, status: "failed", assertionResults: [{ fullName: f.name, status: "failed", failureMessages: ["AssertionError: boom"] }] })),
    ],
  });
}
function junit(cases: Array<{ name: string; fail?: boolean }>) {
  return `<testsuites><testsuite>${cases
    .map((c) => (c.fail ? `<testcase classname="t" name="${c.name}"><failure message="nope"/></testcase>` : `<testcase classname="t" name="${c.name}"/>`))
    .join("")}</testsuite></testsuites>`;
}

/**
 * Um exec que fala git como o gate espera (merge → mesclada; reset → base/mesclada; diff → delta) e, para
 * todo o resto, despacha pelo DIRETÓRIO da unidade (`o.cwd` termina na chave). O relatório junit é "escrito"
 * num fake de disco — o `io` — como a unidade real escreveria no seu `junitPath`.
 */
function harness(opts: { changed: string[]; units: Record<string, UnitBeh>; junitFile?: string }) {
  const calls: Array<{ cmd: string; cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }> = [];
  const disk = new Map<string, string>();
  const events: string[] = [];
  let merged = false;
  let onBase = false;
  let mergedRuns = new Map<string, number>();
  const exec: ExecFn = async (cmd, o) => {
    calls.push({ cmd, cwd: o?.cwd, env: o?.env, timeout: o?.timeout });
    if (cmd.includes("git merge --no-ff")) {
      merged = true;
      return { stdout: "", stderr: "" };
    }
    if (cmd.includes("git rev-parse HEAD")) return { stdout: merged ? "mergedsha1111\n" : "basesha0000\n", stderr: "" };
    if (cmd.includes("git reset --hard")) {
      onBase = cmd.includes("basesha0000");
      return { stdout: "", stderr: "" };
    }
    if (cmd.includes("git diff --name-only")) return { stdout: opts.changed.join("\n"), stderr: "" };
    if (cmd.startsWith("git ") || cmd.startsWith("systemctl ")) return { stdout: "", stderr: "" };
    const key = Object.keys(opts.units).find((k) => (o?.cwd ?? "").endsWith(k));
    if (!key) return { stdout: "", stderr: "" };
    events.push(`exec:${key}:${onBase ? "base" : "merged"}`);
    const u = opts.units[key];
    const n = (mergedRuns.get(key) ?? 0) + (onBase ? 0 : 1);
    if (!onBase) mergedRuns.set(key, n);
    const b = onBase ? (u.base ?? u.merged) : n > 1 && u.retry ? u.retry : u.merged;
    if (b.junit != null && opts.junitFile) disk.set(path.join(o!.cwd!, opts.junitFile), b.junit);
    if (b.killed) throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM", stdout: "" });
    if (b.exit === 0) return { stdout: b.stdout ?? "", stderr: "" };
    throw Object.assign(new Error("exit 1"), { code: 1, stdout: b.stdout ?? "", stderr: "red" });
  };
  const io: GateReportIo = {
    read: async (p) => {
      events.push(`read:${p}`);
      return disk.get(p) ?? null;
    },
    remove: async (p) => {
      events.push(`remove:${p}`);
      disk.delete(p);
    },
  };
  const fs: WorktreeFs = {
    listDirs: async () => [],
    isDir: async (p: string) => Object.keys(opts.units).some((k) => p.endsWith(k)) || p.includes("packages/storymap-ui"),
    isFile: async () => false,
    linkDir: async () => {},
    unlinkDir: async () => false,
  };
  return { exec, calls, io, fs, events, disk };
}

const unitCalls = <C extends { cmd: string; cwd?: string }>(calls: C[], key: string): C[] => calls.filter((c) => (c.cwd ?? "").endsWith(key));
const run = (h: ReturnType<typeof harness>, extra: Record<string, unknown>) =>
  makeDefaultGateRunner(h.fs, h.io)({ exec: h.exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, ...extra });

const AFFECTED = { enabled: true, fullSuitePaths: [] as string[] };
const MONOREPO: GateScopeSpec = {
  packages: {
    "packages/web": { command: "bunx vitest run --config vitest.unit.config.ts" },
    "services/api": { command: "pytest -q --junitxml=.gate/junit.xml", reporter: "junit-xml", junitPath: ".gate/junit.xml" },
    "tools/lint": { command: "./lint.sh", reporter: "exit-code" },
  },
};

describe("unidades declarativas — a seleção por afetados é da UNIDADE, e só vitest", () => {
  it("[REGRESSÃO] a vitest com --config ganha o sufixo NO PRÓPRIO comando; a pytest roda completa e sem --reporter=json", async () => {
    const h = harness({
      changed: ["packages/web/src/a.ts", "services/api/app.py"],
      junitFile: ".gate/junit.xml",
      units: {
        "packages/web": { merged: { exit: 0, stdout: vitestJson(7) } },
        "services/api": { merged: { exit: 0, junit: junit([{ name: "a" }, { name: "b" }]) } },
      },
    });
    const res = await run(h, { scope: MONOREPO, affected: AFFECTED });

    expect(res.passed).toBe(true);
    expect(unitCalls(h.calls, "packages/web").map((c) => c.cmd)).toEqual([
      "bunx vitest run --config vitest.unit.config.ts --changed basesha0000 --passWithNoTests --reporter=json",
    ]);
    expect(unitCalls(h.calls, "services/api").map((c) => c.cmd)).toEqual(["pytest -q --junitxml=.gate/junit.xml"]);
    // a contagem: 7 (vitest) + 2 (junit) — a prova de que N>0 testes rodaram, por unidade
    expect(res.report?.testsExecuted).toBe(9);
    expect(res.report?.units.map((u) => [u.label, u.reporter, u.mode, u.tests])).toEqual([
      ["packages/web", "vitest-json", "affected", 7],
      ["services/api", "junit-xml", "full", 2],
    ]);
  });

  it("uma unidade vitest com `affected: false` roda completa mesmo com a seleção ligada", async () => {
    const h = harness({ changed: ["packages/web/src/a.ts"], units: { "packages/web": { merged: { exit: 0, stdout: vitestJson(3) } } } });
    await run(h, { scope: { packages: { "packages/web": { command: "bunx vitest run", affected: false } } }, affected: AFFECTED });
    expect(unitCalls(h.calls, "packages/web")[0].cmd).toBe("bunx vitest run --reporter=json");
  });
});

describe("o relatório da entrada — argv EXATA e testes executados, também no log", () => {
  it("o log verde diz QUANTOS testes rodaram e traz a argv de cada unidade", async () => {
    const h = harness({ changed: ["packages/web/src/a.ts"], units: { "packages/web": { merged: { exit: 0, stdout: vitestJson(12) } } } });
    const res = await run(h, { scope: MONOREPO });
    expect(res.log).toContain("✓ suíte verde");
    expect(res.log).toContain("12 teste(s) executado(s)");
    const argv = ["/bin/sh", "-c", "bunx vitest run --config vitest.unit.config.ts --reporter=json"];
    expect(res.log).toContain(`argv: ${JSON.stringify(argv)}`);
    expect(res.report?.units[0].argv).toEqual(argv);
    expect(res.report?.isolation).toBe("none");
  });

  it("uma unidade exit-code não CONTA: a contagem é desconhecida (null), nunca 0", async () => {
    const h = harness({ changed: ["tools/lint/x.sh"], units: { "tools/lint": { merged: { exit: 0 } } } });
    const res = await run(h, { scope: MONOREPO });
    expect(res.passed).toBe(true);
    expect(res.report?.testsExecuted).toBeNull();
    expect(res.report?.uncountedUnits).toBe(1);
    expect(res.log).toContain("contagem desconhecida");
  });
});

describe("junit-xml — lido do arquivo que a unidade grava, e só do DESTA rodada", () => {
  it("falha NOVA (verde na base) reprova, nomeando o testcase", async () => {
    const h = harness({
      changed: ["services/api/app.py"],
      junitFile: ".gate/junit.xml",
      units: {
        "services/api": {
          merged: { exit: 1, junit: junit([{ name: "ok" }, { name: "quebrou", fail: true }]) },
          base: { exit: 0, junit: junit([{ name: "ok" }, { name: "quebrou" }]) },
        },
      },
    });
    const res = await run(h, { scope: MONOREPO, retryOnNewFailure: false });
    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBeUndefined();
    expect(res.log).toContain("quebrou");
  });

  it("falha que JÁ existia na base é perdoada (atribuição por testcase)", async () => {
    const red = junit([{ name: "ok" }, { name: "velho", fail: true }]);
    const h = harness({ changed: ["services/api/app.py"], junitFile: ".gate/junit.xml", units: { "services/api": { merged: { exit: 1, junit: red }, base: { exit: 1, junit: red } } } });
    const res = await run(h, { scope: MONOREPO });
    expect(res.passed).toBe(true);
    expect(res.log).toContain("pré-existente");
  });

  // O relatório da rodada MESCLADA fica na árvore depois do `git reset --hard` (arquivo não rastreado).
  // Se a rodada da BASE não escrever o dela e o gate ler o velho, as falhas "existem na base" e o delta é
  // perdoado. Este teste FALHA se o `remove` antes de cada execução sair.
  it("[ATAQUE] um relatório VELHO não é lido como o desta rodada — a base que não escreveu não perdoa nada", async () => {
    const h = harness({
      changed: ["services/api/app.py"],
      junitFile: ".gate/junit.xml",
      units: { "services/api": { merged: { exit: 1, junit: junit([{ name: "quebrou", fail: true }]) }, base: { exit: 1, junit: null } } },
    });
    const res = await run(h, { scope: MONOREPO, retryOnNewFailure: false });
    expect(res.passed).toBe(false);
    const junitPath = path.join("/repo/.worktrees/gate-x/services/api", ".gate/junit.xml");
    // a ordem prova a guarda: remove → exec, nas duas rodadas
    const seq = h.events.filter((e) => e === `remove:${junitPath}` || e.startsWith("exec:services/api"));
    expect(seq).toEqual([`remove:${junitPath}`, "exec:services/api:merged", `remove:${junitPath}`, "exec:services/api:base"]);
  });

  it("exit 0 SEM relatório é INCONCLUSIVO — um junit que não escreveu não mediu nada", async () => {
    const h = harness({ changed: ["services/api/app.py"], junitFile: ".gate/junit.xml", units: { "services/api": { merged: { exit: 0, junit: null } } } });
    const res = await run(h, { scope: MONOREPO });
    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.log).toContain("sem relatório legível");
  });

  it("…também quando OUTRA unidade da entrada tem relatório verde — a regra é por unidade, não pela soma", async () => {
    const h = harness({
      changed: ["services/api/app.py", "packages/web/src/a.ts"],
      junitFile: ".gate/junit.xml",
      units: { "services/api": { merged: { exit: 0, junit: null } }, "packages/web": { merged: { exit: 0, stdout: vitestJson(9) } } },
    });
    const res = await run(h, { scope: MONOREPO });
    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.log).toContain("[services/api] junit-xml exit 0 sem relatório legível");
  });

  it("junit-xml sem junitPath é RECUSA anunciada — a suíte nem roda", async () => {
    const h = harness({ changed: ["services/api/app.py"], units: { "services/api": { merged: { exit: 0 } } } });
    const res = await run(h, { scope: { packages: { "services/api": { command: "pytest", reporter: "junit-xml" } } } });
    expect(res.passed).toBe(false);
    expect(res.log).toMatch(/RECUSADO \(não reprovado\).*junit-xml sem junitPath/);
    expect(unitCalls(h.calls, "services/api")).toHaveLength(0);
  });

  it("junitPath que ESCAPA da unidade (`..` / absoluto) também é recusado", async () => {
    for (const junitPath of ["../../etc/passwd", "/etc/passwd"]) {
      const h = harness({ changed: ["services/api/app.py"], units: { "services/api": { merged: { exit: 0 } } } });
      const res = await run(h, { scope: { packages: { "services/api": { command: "pytest", reporter: "junit-xml", junitPath } } } });
      expect(res.passed, junitPath).toBe(false);
      expect(res.log).toContain("RECUSADO");
    }
  });
});

describe("exit-code — só o status; com a BASE vermelha, INCONCLUSIVO, nunca aprovação", () => {
  it("vermelha na mesclada e VERDE na base ⇒ o delta a quebrou: reprova (não inconclusivo)", async () => {
    const h = harness({ changed: ["tools/lint/x.sh"], units: { "tools/lint": { merged: { exit: 1 }, base: { exit: 0 } } } });
    const res = await run(h, { scope: MONOREPO, retryOnNewFailure: false });
    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBeUndefined();
    expect(res.log).toContain("tools/lint");
  });

  it("vermelha na mesclada E na base ⇒ INCONCLUSIVO — a atribuição por chave NÃO pode perdoá-la", async () => {
    const h = harness({ changed: ["tools/lint/x.sh"], units: { "tools/lint": { merged: { exit: 1 }, base: { exit: 1 } } } });
    const res = await run(h, { scope: MONOREPO });
    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.log).toMatch(/INCONCLUSIVO: unidade\(s\) exit-code vermelha\(s\) TAMBÉM na base — tools\/lint/);
    // a main vermelha é registrada (P-8), mesmo sem identidade de teste
    expect(res.preexisting?.map((f) => f.file)).toEqual(["tools/lint"]);
  });

  it("uma falha NOVA de outra unidade domina: reprova (não inconclusivo) mesmo com o exit-code vermelho na base", async () => {
    const h = harness({
      changed: ["tools/lint/x.sh", "packages/web/src/a.ts"],
      units: {
        "tools/lint": { merged: { exit: 1 }, base: { exit: 1 } },
        "packages/web": { merged: { exit: 1, stdout: vitestJson(1, [{ file: "w.test.ts", name: "novo" }]) }, base: { exit: 0, stdout: vitestJson(2) } },
      },
    });
    const res = await run(h, { scope: MONOREPO, retryOnNewFailure: false });
    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBeUndefined();
    expect(res.log).toContain("novo");
  });

  it("exit-code vermelha que some no retry é FLAKY (integra, registrado)", async () => {
    const h = harness({ changed: ["tools/lint/x.sh"], units: { "tools/lint": { merged: { exit: 1 }, base: { exit: 0 }, retry: { exit: 0 } } } });
    const res = await run(h, { scope: MONOREPO });
    expect(res.passed).toBe(true);
    expect(res.flaky?.map((f) => f.file)).toEqual(["tools/lint"]);
  });
});

describe("crash por UNIDADE — o furo da soma fechado", () => {
  // Antes: as falhas de TODAS as unidades eram somadas. Uma unidade que crashava (sem relatório) ao lado de
  // outra com falha PRÉ-EXISTENTE sumia na soma — a atribuição perdoava a pré-existente e o gate APROVAVA
  // uma entrada cuja segunda suíte nem produziu veredito.
  it("uma unidade crashada ao lado de outra com falha pré-existente é INCONCLUSIVO, nunca aprovação", async () => {
    const velho = [{ file: "w.test.ts", name: "velho" }];
    const h = harness({
      changed: ["packages/web/src/a.ts", "packages/other/b.ts"],
      units: {
        "packages/web": { merged: { exit: 1, stdout: vitestJson(1, velho) }, base: { exit: 1, stdout: vitestJson(1, velho) } },
        "packages/other": { merged: { exit: 1, stdout: "Segmentation fault" } },
      },
    });
    const res = await run(h, { scope: { packages: { "packages/web": "bunx vitest run", "packages/other": "bunx vitest run" } } });
    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.log).toContain("packages/other");
  });

  it("relatório LEGÍVEL com zero falhas e exit≠0 (o 'Unhandled Error' do vitest) ao lado de falha pré-existente: INCONCLUSIVO", async () => {
    const velho = [{ file: "w.test.ts", name: "velho" }];
    const h = harness({
      changed: ["packages/web/src/a.ts", "packages/other/b.ts"],
      units: {
        "packages/web": { merged: { exit: 1, stdout: vitestJson(1, velho) }, base: { exit: 1, stdout: vitestJson(1, velho) } },
        "packages/other": { merged: { exit: 1, stdout: vitestJson(5) } },
      },
    });
    const res = await run(h, { scope: { packages: { "packages/web": "bunx vitest run", "packages/other": "bunx vitest run" } } });
    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.log).toContain("[packages/other]");
  });
});

describe("o SELO na argv — forma verificada aqui; contenção medida em gate-sandbox.test.ts", () => {
  const SEALED = { mode: "systemd" as const, reason: "sonda ok", inaccessiblePaths: ["/etc/agileharness"] };

  it("todo comando de código-do-delta vira `systemd-run` selado, com os valores do env FORA da linha de comando", async () => {
    const h = harness({
      changed: ["packages/web/src/a.ts", "services/api/app.py"],
      junitFile: ".gate/junit.xml",
      units: {
        "packages/web": { merged: { exit: 0, stdout: vitestJson(4) } },
        "services/api": { merged: { exit: 0, junit: junit([{ name: "a" }]) } },
      },
    });
    const prev = process.env.GATE_SEAL_VALUE_PROBE;
    process.env.GATE_SEAL_VALUE_PROBE = "valor-que-nao-pode-ir-para-a-argv";
    try {
      const res = await run(h, {
        scope: {
          packages: {
            "packages/web": { command: "bunx vitest run" },
            "services/api": { command: "pytest -q --junitxml=.gate/junit.xml", reporter: "junit-xml", junitPath: ".gate/junit.xml", network: "allow" },
          },
        },
        isolation: SEALED,
      });
      expect(res.passed).toBe(true);
      const web = unitCalls(h.calls, "packages/web")[0];
      const api = unitCalls(h.calls, "services/api")[0];
      for (const c of [web, api]) {
        expect(c.cmd.startsWith("'systemd-run' '--wait' '--pipe' '--collect'")).toBe(true);
        expect(c.cmd).toContain("'--expand-environment=no'");
        expect(c.cmd).toContain("'--property=CapabilityBoundingSet='");
        expect(c.cmd).toContain("'--property=TemporaryFileSystem=/run:ro'");
        expect(c.cmd).toContain("'--property=BindPaths=/repo/.worktrees/gate-x'");
        expect(c.cmd).toContain(`'--property=InaccessiblePaths=-${path.join(os.homedir(), ".ssh")}'`);
        expect(c.cmd).toContain("'--property=InaccessiblePaths=-/etc/agileharness'");
        expect(c.cmd).toContain("'--setenv=GATE_SEAL_VALUE_PROBE'");
        expect(c.cmd).not.toContain("valor-que-nao-pode-ir-para-a-argv");
        expect(c.env?.TMPDIR).toBe("/tmp");
      }
      // rede por UNIDADE: deny (default) tira a rede; allow a devolve (e expõe o resolv.conf do /run)
      expect(web.cmd).toContain("'--property=PrivateNetwork=yes'");
      expect(api.cmd).not.toContain("PrivateNetwork");
      expect(api.cmd).toContain("'--property=BindReadOnlyPaths=-/run/systemd/resolve'");
      // e a argv registrada é a do systemd-run, terminando no comando da unidade
      const u = res.report!.units[0];
      expect(u.isolation).toBe("systemd");
      expect(u.argv[0]).toBe("systemd-run");
      expect(u.argv.slice(-3)).toEqual(["/bin/sh", "-c", "bunx vitest run --reporter=json"]);
      expect(res.report!.isolation).toBe("systemd");
    } finally {
      if (prev === undefined) delete process.env.GATE_SEAL_VALUE_PROBE;
      else process.env.GATE_SEAL_VALUE_PROBE = prev;
    }
  });

  it("o typecheck também roda selado", async () => {
    const h = harness({ changed: ["packages/web/src/a.ts"], units: { "packages/web": { merged: { exit: 0, stdout: vitestJson(1) } } } });
    const fsTs: WorktreeFs = { ...h.fs, isFile: async (p: string) => p.endsWith("tsconfig.json") };
    await makeDefaultGateRunner(fsTs, h.io)({
      exec: h.exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000,
      scope: { packages: { "packages/web": "bunx vitest run" } },
      typecheck: { enabled: true, command: "bunx tsc --noEmit" },
      isolation: SEALED,
    });
    const tsc = h.calls.find((c) => c.cmd.includes("tsc --noEmit"));
    expect(tsc?.cmd.startsWith("'systemd-run'")).toBe(true);
  });

  it("num TIMEOUT o cliente morre mas a unidade não — o runner a PARA pelo nome (e só uma unidade do gate)", async () => {
    const h = harness({ changed: ["packages/web/src/a.ts"], units: { "packages/web": { merged: { exit: 1, killed: true } } } });
    await run(h, { scope: { packages: { "packages/web": "bunx vitest run" } }, isolation: SEALED });
    const stops = h.calls.filter((c) => c.cmd.startsWith("systemctl stop"));
    expect(stops).toHaveLength(1);
    expect(stops[0].cmd).toMatch(/^systemctl stop 'ah-gate-x-[a-z0-9]+\.service'$/);
  });

  it("[NÃO-VACUIDADE] sem isolamento pedido, NADA de systemd-run — o comportamento de antes, byte a byte", async () => {
    const h = harness({ changed: ["packages/web/src/a.ts"], units: { "packages/web": { merged: { exit: 0, stdout: vitestJson(1) } } } });
    await run(h, { scope: { packages: { "packages/web": "bunx vitest run" } } });
    expect(h.calls.some((c) => c.cmd.includes("systemd-run"))).toBe(false);
    expect(unitCalls(h.calls, "packages/web")[0].cmd).toBe("bunx vitest run --reporter=json");
  });
});

describe("a fila — o relatório CHEGA à entrada e o isolamento é resolvido pedido × sonda", () => {
  function store() {
    let saved: MergeQueueEntry[] = [];
    const s: MergeQueueStore = { load: async () => saved.map((e) => ({ ...e })), persist: async (e) => void (saved = e.map((x) => ({ ...x }))) };
    return { s, read: () => saved };
  }
  const gitOk: ExecFn = async (cmd) => {
    if (cmd.includes("diff --name-only")) return { stdout: "packages/storymap-ui/src/foo.ts\n", stderr: "" };
    // o branch NÃO é ancestral de HEAD (senão a fila o dá por já-integrado e o gate nem roda)
    if (cmd.includes("is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
    return { stdout: "", stderr: "" };
  };
  const REPORT = {
    isolation: "systemd" as const,
    isolationReason: "sonda ok",
    testsExecuted: 42,
    uncountedUnits: 0,
    units: [{ label: "packages/x", cwd: "packages/x", reporter: "vitest-json" as const, mode: "full" as const, network: "deny" as const, isolation: "systemd" as const, argv: ["systemd-run", "--", "/bin/sh", "-c", "vitest"], exitCode: 0, tests: 42, failures: 0 }],
  };

  it("o gateReport do gate é PERSISTIDO na entrada — e uma rodada SEM relatório limpa o da anterior", async () => {
    const { s, read } = store();
    let n = 0;
    const mq = makeMergeQueue({
      repoRoot: "/repo", exec: gitOk, store: s, sleep: async () => {}, gateEnabled: true, addGateBlocker: async () => {},
      integrationGate: async () => (++n === 1 ? { passed: false, log: "red", report: REPORT } : { passed: false, log: "conflito, nada rodou" }),
    });
    await mq.enqueueMerge({ runId: "r1", board: "acme", cardId: "c1", branch: "run/r1" });
    await mq.whenIdle();
    const e = mq.getSnapshot().entries[0];
    expect(e.status).toBe("gate-failed");
    expect(e.gateReport?.testsExecuted).toBe(42);
    expect(read()[0].gateReport?.units[0].argv).toEqual(REPORT.units[0].argv);
    // retry: a segunda rodada não rodou suíte nenhuma ⇒ a contagem da primeira NÃO pode sobreviver
    await mq.resolveGateFailed("r1", "retry");
    await mq.whenIdle();
    expect(n).toBe(2);
    expect(mq.getSnapshot().entries.find((x) => x.runId === "r1")?.gateReport).toBeUndefined();
  });

  it("isolamento: sonda OK ⇒ o gate recebe `systemd`; sonda falha ⇒ `none` COM o motivo (fallback anunciado)", async () => {
    for (const [probe, mode] of [
      [{ ok: true, detail: "selo provado" }, "systemd"],
      [{ ok: false, detail: "sem systemd aqui" }, "none"],
    ] as const) {
      const seen: unknown[] = [];
      const { s } = store();
      const mq = makeMergeQueue({
        repoRoot: "/repo", exec: gitOk, store: s, sleep: async () => {}, gateEnabled: true, addGateBlocker: async () => {},
        gateSandboxProbe: () => probe,
        integrationGate: async (o) => {
          seen.push(o.isolation);
          return { passed: false, log: "x" };
        },
      });
      await mq.enqueueMerge({ runId: `r-${mode}`, board: "acme", cardId: "c1", branch: `run/r-${mode}` });
      await mq.whenIdle();
      expect((seen[0] as { mode: string }).mode).toBe(mode);
      if (mode === "none") expect((seen[0] as { reason: string }).reason).toMatch(/SEM SELO.*sem systemd aqui/);
    }
  });

  it("sem sonda injetada (qualquer fila que não a de produção) NUNCA dispara systemd-run — cai em `none`", async () => {
    const seen: Array<{ mode: string }> = [];
    const { s } = store();
    const mq = makeMergeQueue({ repoRoot: "/repo", exec: gitOk, store: s, sleep: async () => {}, gateEnabled: true, addGateBlocker: async () => {}, integrationGate: async (o) => (seen.push(o.isolation as { mode: string }), { passed: false, log: "x" }) });
    await mq.enqueueMerge({ runId: "r2", board: "acme", cardId: "c1", branch: "run/r2" });
    await mq.whenIdle();
    expect(seen[0].mode).toBe("none");
  });
});
