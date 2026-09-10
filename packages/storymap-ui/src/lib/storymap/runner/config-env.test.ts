import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  activeEnvOverrides,
  applyEnvOverrides,
  coerceRunnerSettings,
  DEFAULT_RUNNER_SETTINGS,
  maxTurnsResumeMax,
} from "./config";
import { CHAT_EFFORTS, CHAT_MODEL_BASES, composeModel } from "@/lib/storymap/copilot/copilot-status";
import type { RunnerSettings } from "@/lib/storymap/types";

// applyEnvOverrides is the kill-switch + operational override layer: ENV always
// wins over settings.yaml. If AGILEHARNESS_AUTORUN=0 regresses, autorun can't be turned off
// without killing the (forbidden-to-kill) dev server. policy.test.ts only covered
// AGILEHARNESS_AUTORUN=0 and _MAX through loadRunnerConfig; this exercises the full matrix
// and the "env beats a file value" contract directly.

const ENV_KEYS = [
  "AGILEHARNESS_AUTORUN",
  "AGILEHARNESS_AUTORUN_RESUME_ON_BOOT",
  "AGILEHARNESS_AUTORUN_MAX",
  "AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX",
  "AGILEHARNESS_AUTORUN_CARD_BUDGET_USD",
  "AGILEHARNESS_AUTORUN_TIMEOUT_MS",
  "AGILEHARNESS_AUTORUN_TIMEOUT_DO_MS",
  "AGILEHARNESS_AUTORUN_TIMEOUT_UNIVERSAL_MS",
  "AGILEHARNESS_AUTORUN_CLAUDE_BIN",
  "AGILEHARNESS_AUTORUN_EXTRA_ARGS",
  "AGILEHARNESS_AUTORUN_WORKTREE",
  "AGILEHARNESS_AUTORUN_MERGE_GATE",
  "AGILEHARNESS_AUTORUN_STAGING",
  "AGILEHARNESS_AUTORUN_LANE_LIGHT_MAX",
  "AGILEHARNESS_AUTORUN_LANE_HEAVY_MAX",
  "AGILEHARNESS_AUTORUN_LANE_LIGHT_MEMORY_MAX",
  "AGILEHARNESS_AUTORUN_LANE_LIGHT_CPU_QUOTA",
  "AGILEHARNESS_AUTORUN_LANE_HEAVY_MEMORY_MAX",
  "AGILEHARNESS_AUTORUN_LANE_HEAVY_CPU_QUOTA",
  "AGILEHARNESS_AUTORUN_RAM_FREE_MB",
  "AGILEHARNESS_AUTORUN_LOAD_AVG_1",
] as const;

const original: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) original[k] = process.env[k];

// A base that is DIFFERENT from defaults, so "env wins over file" is observable.
const fileSettings = (): RunnerSettings => ({
  version: 1,
  autorun: {
    enabled: true,
    resumeOnBoot: true,
    maxConcurrent: 5,
    // DIFFERENT from the default (3) so "env wins over file" is observable for the loop-guard cap.
    noProgressMax: 7,
    timeouts: { fastMs: 1000, doMs: 2000, universalMs: 9000 },
    claudeBin: "file-bin",
    extraArgs: ["from-file"],
    worktreeIsolation: true, // DIFFERENT from the default (false) so "env wins" is observable
    // DISTINCT from the permissive defaults (99/99/0/999) so "env wins over file" is observable.
    scheduler: {
      lanes: {
        light: { maxConcurrent: 7, memoryMax: "2G", cpuQuota: 100 },
        heavy: { maxConcurrent: 3, memoryMax: "8G", cpuQuota: 300 },
      },
      thresholds: { ramFreeMb: 250, loadAvg1: 5.5 },
    },
    // DIFFERENT from the default (4) so "env wins over file" is observable for the session cap too.
    sessions: { maxWorktrees: 6 },
  },
  columnDefaults: {},
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("applyEnvOverrides", () => {
  it("with no env set, returns the file/base settings unchanged", () => {
    const base = fileSettings();
    expect(applyEnvOverrides(base)).toEqual(base);
  });

  it("does not mutate the input settings object", () => {
    const base = fileSettings();
    process.env.AGILEHARNESS_AUTORUN_MAX = "9";
    applyEnvOverrides(base);
    expect(base.autorun.maxConcurrent).toBe(5); // untouched
  });

  it("AGILEHARNESS_AUTORUN=0 is the kill switch (disables even when the file enables it)", () => {
    process.env.AGILEHARNESS_AUTORUN = "0";
    expect(applyEnvOverrides(fileSettings()).autorun.enabled).toBe(false);
  });

  it("AGILEHARNESS_AUTORUN set to anything other than '0' does NOT disable", () => {
    process.env.AGILEHARNESS_AUTORUN = "1";
    expect(applyEnvOverrides(fileSettings()).autorun.enabled).toBe(true);
  });

  it("AGILEHARNESS_AUTORUN_RESUME_ON_BOOT=0 disables boot recovery (env beats the file)", () => {
    process.env.AGILEHARNESS_AUTORUN_RESUME_ON_BOOT = "0";
    expect(applyEnvOverrides(fileSettings()).autorun.resumeOnBoot).toBe(false);
  });

  it("AGILEHARNESS_AUTORUN_RESUME_ON_BOOT unset keeps the file value (true)", () => {
    expect(applyEnvOverrides(fileSettings()).autorun.resumeOnBoot).toBe(true);
  });

  it("AGILEHARNESS_AUTORUN_MAX overrides maxConcurrent (env beats the file value)", () => {
    process.env.AGILEHARNESS_AUTORUN_MAX = "9";
    expect(applyEnvOverrides(fileSettings()).autorun.maxConcurrent).toBe(9);
  });

  it("an invalid AGILEHARNESS_AUTORUN_MAX (0 / non-numeric) is ignored — file value kept", () => {
    process.env.AGILEHARNESS_AUTORUN_MAX = "0";
    expect(applyEnvOverrides(fileSettings()).autorun.maxConcurrent).toBe(5);
    process.env.AGILEHARNESS_AUTORUN_MAX = "abc";
    expect(applyEnvOverrides(fileSettings()).autorun.maxConcurrent).toBe(5);
  });

  it("AGILEHARNESS_AUTORUN_TIMEOUT_MS / _DO_MS / _UNIVERSAL_MS override the watchdog timeouts", () => {
    process.env.AGILEHARNESS_AUTORUN_TIMEOUT_MS = "12345";
    process.env.AGILEHARNESS_AUTORUN_TIMEOUT_DO_MS = "67890";
    process.env.AGILEHARNESS_AUTORUN_TIMEOUT_UNIVERSAL_MS = "111222";
    const out = applyEnvOverrides(fileSettings()).autorun.timeouts;
    expect(out.fastMs).toBe(12345);
    expect(out.doMs).toBe(67890);
    expect(out.universalMs).toBe(111222);
  });

  it("AGILEHARNESS_AUTORUN_TIMEOUT_UNIVERSAL_MS unset keeps the file value; an invalid one is ignored", () => {
    expect(applyEnvOverrides(fileSettings()).autorun.timeouts.universalMs).toBe(9000); // file value kept
    process.env.AGILEHARNESS_AUTORUN_TIMEOUT_UNIVERSAL_MS = "0";
    expect(applyEnvOverrides(fileSettings()).autorun.timeouts.universalMs).toBe(9000); // 0 ignored
    process.env.AGILEHARNESS_AUTORUN_TIMEOUT_UNIVERSAL_MS = "abc";
    expect(applyEnvOverrides(fileSettings()).autorun.timeouts.universalMs).toBe(9000); // non-numeric ignored
  });

  it("AGILEHARNESS_AUTORUN_CLAUDE_BIN overrides the binary", () => {
    process.env.AGILEHARNESS_AUTORUN_CLAUDE_BIN = "env-bin";
    expect(applyEnvOverrides(fileSettings()).autorun.claudeBin).toBe("env-bin");
  });

  it("AGILEHARNESS_AUTORUN_EXTRA_ARGS overrides extraArgs (whitespace-split)", () => {
    process.env.AGILEHARNESS_AUTORUN_EXTRA_ARGS = "--foo  --bar";
    expect(applyEnvOverrides(fileSettings()).autorun.extraArgs).toEqual(["--foo", "--bar"]);
  });

  it("an empty AGILEHARNESS_AUTORUN_EXTRA_ARGS clears extraArgs (env present wins → [])", () => {
    process.env.AGILEHARNESS_AUTORUN_EXTRA_ARGS = "";
    expect(applyEnvOverrides(fileSettings()).autorun.extraArgs).toEqual([]);
  });

  it("AGILEHARNESS_AUTORUN_WORKTREE=0 disables worktree isolation (env beats the file)", () => {
    process.env.AGILEHARNESS_AUTORUN_WORKTREE = "0";
    expect(applyEnvOverrides(fileSettings()).autorun.worktreeIsolation).toBe(false);
  });

  it("AGILEHARNESS_AUTORUN_WORKTREE=1 enables it; unset keeps the file value", () => {
    process.env.AGILEHARNESS_AUTORUN_WORKTREE = "1";
    expect(applyEnvOverrides(fileSettings()).autorun.worktreeIsolation).toBe(true);
    delete process.env.AGILEHARNESS_AUTORUN_WORKTREE;
    expect(applyEnvOverrides(fileSettings()).autorun.worktreeIsolation).toBe(true); // file value (true)
  });

  // --- integration gate master switch (story-1k7els) --------------------------------
  // A file base that carries a mergeGate section, so "env wins over file" is observable.
  const withGate = (enabled: boolean): RunnerSettings => {
    const s = fileSettings();
    s.autorun.mergeGate = { enabled, checkCommand: "vitest run", timeoutMs: 300_000 };
    return s;
  };

  it("AGILEHARNESS_AUTORUN_MERGE_GATE=1 enables the gate over a file value of false (command/timeout preserved)", () => {
    process.env.AGILEHARNESS_AUTORUN_MERGE_GATE = "1";
    const out = applyEnvOverrides(withGate(false)).autorun.mergeGate;
    expect(out).toEqual({ enabled: true, checkCommand: "vitest run", timeoutMs: 300_000 });
  });

  it("AGILEHARNESS_AUTORUN_MERGE_GATE=0 disables the gate over a file value of true (command/timeout preserved)", () => {
    process.env.AGILEHARNESS_AUTORUN_MERGE_GATE = "0";
    const out = applyEnvOverrides(withGate(true)).autorun.mergeGate;
    expect(out).toEqual({ enabled: false, checkCommand: "vitest run", timeoutMs: 300_000 });
  });

  it("AGILEHARNESS_AUTORUN_MERGE_GATE unset keeps the file value; a non-0/1 value is ignored", () => {
    expect(applyEnvOverrides(withGate(true)).autorun.mergeGate?.enabled).toBe(true); // unset → file
    process.env.AGILEHARNESS_AUTORUN_MERGE_GATE = "yes";
    expect(applyEnvOverrides(withGate(true)).autorun.mergeGate?.enabled).toBe(true); // garbage ignored
  });

  it("AGILEHARNESS_AUTORUN_MERGE_GATE=1 over an ABSENT mergeGate section synthesizes the CANONICAL defaults enabled", () => {
    // Covers the `next.autorun.mergeGate ?? { ... }` branch: an old file/default lacking the section.
    // A síntese agora ESPELHA DEFAULT_RUNNER_SETTINGS (a revisão achou o literal local divergindo dos
    // defaults em retryOnNewFailure e typecheck — um mergeGate nascido por esta via desligava
    // capacidades default-ON em silêncio).
    const base = fileSettings(); // no mergeGate
    expect(base.autorun.mergeGate).toBeUndefined();
    process.env.AGILEHARNESS_AUTORUN_MERGE_GATE = "1";
    expect(applyEnvOverrides(base).autorun.mergeGate).toEqual({
      ...DEFAULT_RUNNER_SETTINGS.autorun.mergeGate!,
      enabled: true,
    });
  });

  it("does not mutate the input mergeGate object", () => {
    const base = withGate(false);
    process.env.AGILEHARNESS_AUTORUN_MERGE_GATE = "1";
    applyEnvOverrides(base);
    expect(base.autorun.mergeGate?.enabled).toBe(false); // untouched
  });

  // --- staged release master switch (Fase 4a) ---------------------------------------
  // A file base that carries a staging section, so "env wins over file" is observable. branch +
  // codePrefixes must be PRESERVED across the enable/disable flip (only `enabled` moves).
  const withStaging = (enabled: boolean): RunnerSettings => {
    const s = fileSettings();
    s.autorun.staging = { enabled, branch: "stage", codePrefixes: ["packages/"] };
    return s;
  };

  it("AGILEHARNESS_AUTORUN_STAGING=1 enables staging over a file value of false (branch/codePrefixes preserved)", () => {
    process.env.AGILEHARNESS_AUTORUN_STAGING = "1";
    const out = applyEnvOverrides(withStaging(false)).autorun.staging;
    expect(out).toEqual({ enabled: true, branch: "stage", codePrefixes: ["packages/"] });
  });

  it("AGILEHARNESS_AUTORUN_STAGING=0 disables staging over a file value of true (branch/codePrefixes preserved)", () => {
    process.env.AGILEHARNESS_AUTORUN_STAGING = "0";
    const out = applyEnvOverrides(withStaging(true)).autorun.staging;
    expect(out).toEqual({ enabled: false, branch: "stage", codePrefixes: ["packages/"] });
  });

  it("AGILEHARNESS_AUTORUN_STAGING unset keeps the file value; a non-0/1 value is ignored", () => {
    expect(applyEnvOverrides(withStaging(true)).autorun.staging?.enabled).toBe(true); // unset → file
    process.env.AGILEHARNESS_AUTORUN_STAGING = "yes";
    expect(applyEnvOverrides(withStaging(true)).autorun.staging?.enabled).toBe(true); // garbage ignored
  });

  it("AGILEHARNESS_AUTORUN_STAGING=1 over an ABSENT staging section synthesizes the default object enabled", () => {
    // Covers the `next.autorun.staging ?? { ... }` branch: an old file/default lacking the section.
    const base = fileSettings(); // no staging
    expect(base.autorun.staging).toBeUndefined();
    process.env.AGILEHARNESS_AUTORUN_STAGING = "1";
    expect(applyEnvOverrides(base).autorun.staging).toEqual({
      enabled: true,
      branch: "stage",
      codePrefixes: ["packages/"],
    });
  });

  it("does not mutate the input staging object (codePrefixes array is cloned, not shared)", () => {
    const base = withStaging(false);
    process.env.AGILEHARNESS_AUTORUN_STAGING = "1";
    const out = applyEnvOverrides(base);
    expect(base.autorun.staging?.enabled).toBe(false); // untouched
    expect(out.autorun.staging?.codePrefixes).not.toBe(base.autorun.staging?.codePrefixes); // deep-cloned
  });

  // ── BLOCO REMOVIDO (2026-08-05): o interruptor AGILEHARNESS_AUTORUN_SANDBOX não existe mais ───────────────
  // Estas provas cobriam o master switch da camada fail-open (`runner/sandbox.ts`), que saiu junto com
  // o pouso do F0. Não é redundância removida: os dois contratos eram OPOSTOS — aquela camada declarava
  // "must never, by itself, fail a run", e a do F0 RECUSA quando não consegue conter. Manter as duas era
  // garantir que um dia alguém confiasse na que deixa passar.
  //
  // Risco da remoção, medido antes: o flag nascia `enabled: false`, nenhum board o ligava, e
  // `AGILEHARNESS_AUTORUN_SANDBOX` estava AUSENTE do ambiente do serviço em produção. A camada estava inerte.

  // --- scheduler (story-scheduler-lanes-recursos) -----------------------------------
  it("the scheduler lane caps + thresholds pass through unchanged when no env is set", () => {
    const out = applyEnvOverrides(fileSettings()).autorun.scheduler;
    expect(out.lanes.light.maxConcurrent).toBe(7);
    expect(out.lanes.heavy.maxConcurrent).toBe(3);
    expect(out.thresholds.ramFreeMb).toBe(250);
    expect(out.thresholds.loadAvg1).toBe(5.5);
  });

  it("does not mutate the input scheduler object", () => {
    const base = fileSettings();
    process.env.AGILEHARNESS_AUTORUN_LANE_HEAVY_MAX = "9";
    applyEnvOverrides(base);
    expect(base.autorun.scheduler.lanes.heavy.maxConcurrent).toBe(3); // untouched
  });

  it("AGILEHARNESS_AUTORUN_LANE_LIGHT_MAX / _LANE_HEAVY_MAX override the lane caps (env beats the file)", () => {
    process.env.AGILEHARNESS_AUTORUN_LANE_LIGHT_MAX = "8";
    process.env.AGILEHARNESS_AUTORUN_LANE_HEAVY_MAX = "2";
    const out = applyEnvOverrides(fileSettings()).autorun.scheduler.lanes;
    expect(out.light.maxConcurrent).toBe(8);
    expect(out.heavy.maxConcurrent).toBe(2);
  });

  it("an invalid lane cap (0 / non-numeric) is ignored — file value kept", () => {
    process.env.AGILEHARNESS_AUTORUN_LANE_LIGHT_MAX = "0";
    expect(applyEnvOverrides(fileSettings()).autorun.scheduler.lanes.light.maxConcurrent).toBe(7);
    process.env.AGILEHARNESS_AUTORUN_LANE_LIGHT_MAX = "abc";
    expect(applyEnvOverrides(fileSettings()).autorun.scheduler.lanes.light.maxConcurrent).toBe(7);
  });

  it("AGILEHARNESS_AUTORUN_RAM_FREE_MB / _LOAD_AVG_1 override the thresholds (0 and fractional allowed)", () => {
    process.env.AGILEHARNESS_AUTORUN_RAM_FREE_MB = "0"; // 0 is a VALID threshold (never block on RAM)
    process.env.AGILEHARNESS_AUTORUN_LOAD_AVG_1 = "4.25"; // fractional load is valid
    const out = applyEnvOverrides(fileSettings()).autorun.scheduler.thresholds;
    expect(out.ramFreeMb).toBe(0);
    expect(out.loadAvg1).toBe(4.25);
  });

  it("an invalid threshold (negative / non-numeric) is ignored — file value kept", () => {
    process.env.AGILEHARNESS_AUTORUN_RAM_FREE_MB = "-1";
    expect(applyEnvOverrides(fileSettings()).autorun.scheduler.thresholds.ramFreeMb).toBe(250);
    process.env.AGILEHARNESS_AUTORUN_LOAD_AVG_1 = "nope";
    expect(applyEnvOverrides(fileSettings()).autorun.scheduler.thresholds.loadAvg1).toBe(5.5);
  });

  // --- SM-4 governor lane quotas (memoryMax / cpuQuota) ----------------------------
  it("the lane quotas pass through unchanged when no env is set", () => {
    const out = applyEnvOverrides(fileSettings()).autorun.scheduler.lanes;
    expect(out.light.memoryMax).toBe("2G");
    expect(out.light.cpuQuota).toBe(100);
    expect(out.heavy.memoryMax).toBe("8G");
    expect(out.heavy.cpuQuota).toBe(300);
  });

  it("AGILEHARNESS_AUTORUN_LANE_{LIGHT,HEAVY}_{MEMORY_MAX,CPU_QUOTA} override the quotas (env beats the file)", () => {
    process.env.AGILEHARNESS_AUTORUN_LANE_LIGHT_MEMORY_MAX = "1G";
    process.env.AGILEHARNESS_AUTORUN_LANE_LIGHT_CPU_QUOTA = "50";
    process.env.AGILEHARNESS_AUTORUN_LANE_HEAVY_MEMORY_MAX = "16G";
    process.env.AGILEHARNESS_AUTORUN_LANE_HEAVY_CPU_QUOTA = "400";
    const out = applyEnvOverrides(fileSettings()).autorun.scheduler.lanes;
    expect(out.light.memoryMax).toBe("1G");
    expect(out.light.cpuQuota).toBe(50);
    expect(out.heavy.memoryMax).toBe("16G");
    expect(out.heavy.cpuQuota).toBe(400);
  });

  it("an invalid quota (empty memoryMax / 0 cpuQuota) is ignored — file value kept (no silent disable)", () => {
    process.env.AGILEHARNESS_AUTORUN_LANE_LIGHT_MEMORY_MAX = "   ";
    process.env.AGILEHARNESS_AUTORUN_LANE_LIGHT_CPU_QUOTA = "0";
    const out = applyEnvOverrides(fileSettings()).autorun.scheduler.lanes.light;
    expect(out.memoryMax).toBe("2G"); // blank ignored
    expect(out.cpuQuota).toBe(100); // 0 ignored
  });

  it("does not mutate the input lane quota object", () => {
    const base = fileSettings();
    process.env.AGILEHARNESS_AUTORUN_LANE_HEAVY_MEMORY_MAX = "32G";
    applyEnvOverrides(base);
    expect(base.autorun.scheduler.lanes.heavy.memoryMax).toBe("8G"); // untouched
  });

  it("an EMPTY/whitespace threshold env reads as unset (file value kept, NOT coerced to 0)", () => {
    // Regression guard: Number("") === 0 would otherwise turn an empty var into a real 0 override,
    // silently disabling RAM gating (ramFreeMb→0) or freezing the heavy lane (loadAvg1→0 blocks all).
    process.env.AGILEHARNESS_AUTORUN_RAM_FREE_MB = "";
    process.env.AGILEHARNESS_AUTORUN_LOAD_AVG_1 = "   ";
    const out = applyEnvOverrides(fileSettings()).autorun.scheduler.thresholds;
    expect(out.ramFreeMb).toBe(250); // file value, not 0
    expect(out.loadAvg1).toBe(5.5); // file value, not 0
  });
});

describe("coerceRunnerSettings — mergeGate.scope.fallback (a chave CHEGA ao motor)", () => {
  // A METADE DA CHEGADA. A do USO está em merge-queue.test.ts ([PRODUTOR]). Precisa das duas: um coerce
  // que carrega uma chave que ninguém lê é decoração; um leitor de chave que o coerce dropa é uma
  // capacidade INERTE que PARECE ligada — a mentira de configuração que este arquivo já pagou caro
  // (`deploy.surfaces`, inerte por dias porque o coerce não a carregava).
  const scopeDe = (raw: unknown) =>
    coerceRunnerSettings({ autorun: { mergeGate: { enabled: true, scope: raw } } }).autorun.mergeGate!.scope;

  it("carrega `cwd` e `command` declarados", () => {
    expect(scopeDe({ fallback: { cwd: "packages/acmeapp", command: "bun test" } })!.fallback).toEqual({
      cwd: "packages/acmeapp",
      command: "bun test",
    });
  });

  it("`command` ausente é omitido — o chamador cai no checkCommand global, não num string vazio", () => {
    expect(scopeDe({ fallback: { cwd: "packages/acmeapp" } })!.fallback).toEqual({ cwd: "packages/acmeapp" });
  });

  it("[NÃO-VACUIDADE] fallback sem `cwd` útil é DESCARTADO — declaração pela metade não vira caminho vazio", () => {
    for (const ruim of [{ command: "bun test" }, { cwd: "" }, { cwd: "   " }, { cwd: 42 }, "packages/acmeapp", null]) {
      expect(scopeDe({ fallback: ruim })!.fallback, `aceitou ${JSON.stringify(ruim)}`).toBeUndefined();
    }
  });

  it("[NÃO-VACUIDADE] ausente ⇒ ausente: quem não declara nada não ganha chave nenhuma", () => {
    expect(scopeDe({ packages: { "packages/acmeapp": "bun test" } })!.fallback).toBeUndefined();
  });
});

describe("coerceRunnerSettings — mergeGate.typecheck (a chave CHEGA ao motor)", () => {
  // A METADE DA CHEGADA; a do USO está em merge-queue.test.ts ([PRODUTOR] typecheck). Mesma disciplina
  // do scope.fallback acima — com um risco de sinal INVERTIDO: o default é LIGADO, então um coerce que
  // dropasse a chave não desligaria uma capacidade, LIGARIA uma à revelia de quem escreveu
  // `enabled: false`.
  const tcDe = (raw: unknown) =>
    coerceRunnerSettings({ autorun: { mergeGate: { enabled: true, typecheck: raw } } }).autorun.mergeGate!.typecheck;

  it("default: nasce LIGADO com `bunx tsc --noEmit` — D8: gate nunca cego", () => {
    expect(coerceRunnerSettings({}).autorun.mergeGate!.typecheck).toEqual({ enabled: true, command: "bunx tsc --noEmit" });
  });

  it("carrega `enabled: false` e `command` declarados", () => {
    expect(tcDe({ enabled: false, command: "tsc -b --noEmit" })).toEqual({ enabled: false, command: "tsc -b --noEmit" });
  });

  it("boolean CRU é a grafia natural do desligamento — `typecheck: false` (o `off` do YAML) DESLIGA", () => {
    // Sinal invertido: com default ON, recusar `false` em silêncio LIGARIA o verificador à revelia
    // do operador — e este knob é o remédio documentado para a caixa sem bunx que parqueia entradas.
    expect(tcDe(false)).toEqual({ enabled: false, command: "bunx tsc --noEmit" });
    expect(tcDe(true)).toEqual({ enabled: true, command: "bunx tsc --noEmit" });
  });

  it("[NÃO-VACUIDADE] valor podre não muda NADA — nem liga nem desliga em silêncio", () => {
    for (const ruim of ["banana", 1, null, { enabled: "yes" }, { command: "   " }]) {
      expect(tcDe(ruim), `aceitou ${JSON.stringify(ruim)}`).toEqual({ enabled: true, command: "bunx tsc --noEmit" });
    }
  });
});

describe("coerceRunnerSettings — orchestrator.chat (F3.3)", () => {
  it("defaults chat to opus/medium when absent (o high queimava contexto/custo em pergunta trivial)", () => {
    const out = coerceRunnerSettings({ orchestrator: { enabled: true } }).orchestrator!.chat;
    expect(out).toEqual({ model: "opus", effort: "medium" });
  });
  it("keeps known model/effort and round-trips", () => {
    const out = coerceRunnerSettings({ orchestrator: { chat: { model: "sonnet", effort: "xhigh" } } }).orchestrator!.chat;
    expect(out).toEqual({ model: "sonnet", effort: "xhigh" });
  });
  it("falls back to default on an unknown model/effort (never persists garbage)", () => {
    const out = coerceRunnerSettings({ orchestrator: { chat: { model: "gpt-9", effort: "insane" } } }).orchestrator!.chat;
    expect(out).toEqual({ model: "opus", effort: "medium" });
  });

  it("TUDO que a UI oferece sobrevive à coerção — nenhuma escolha do operador é descartada em silêncio", () => {
    // A ponte entre as duas pontas do vocabulário: as superfícies de escolha (a engrenagem e o comando
    // `/model`) montam as opções a partir de CHAT_MODEL_BASES × janela × CHAT_EFFORTS, e é ESTA coerção
    // que decide o que persiste. Se alguém acrescentar um modelo na lista e esquecer da coerção, o
    // operador clica, a tela confirma e o valor cai no default — a falha mais cara que existe aqui,
    // porque ela é MUDA (foi exatamente o que aconteceu com `opus[1m]`). Este teste é o cinto.
    for (const base of CHAT_MODEL_BASES) {
      for (const model of [base, composeModel(base, true)]) {
        for (const effort of CHAT_EFFORTS) {
          const out = coerceRunnerSettings({ orchestrator: { chat: { model, effort } } }).orchestrator!.chat;
          expect(out, `${model} · ${effort}`).toEqual({ model, effort });
        }
      }
    }
  });

  it("PRESERVA a variante de contexto longo — `opus[1m]` não é lixo, é a escolha do operador", () => {
    // O defeito: a validação comparava a string INTEIRA contra {sonnet, opus}, então `opus[1m]` —
    // valor que a PRÓPRIA UI escreve — caía no default em silêncio. Efeitos medidos: a barra de
    // contexto media 267k contra 200k (vermelha, cheia) em vez de contra 1M (27%), o rosto ficava
    // "cansado" com a sessão folgada, e o turno era spawnado com `--model opus` — o chat rodava com
    // a janela CURTA que o operador tinha desligado.
    expect(coerceRunnerSettings({ orchestrator: { chat: { model: "opus[1m]", effort: "high" } } }).orchestrator!.chat)
      .toEqual({ model: "opus[1m]", effort: "high" });
    expect(coerceRunnerSettings({ orchestrator: { chat: { model: "sonnet[1m]", effort: "high" } } }).orchestrator!.chat)
      .toEqual({ model: "sonnet[1m]", effort: "high" });
  });

  it("a variante não vira porta de entrada para modelo desconhecido", () => {
    // A BASE continua validada contra o vocabulário; só o sufixo é preservado.
    expect(coerceRunnerSettings({ orchestrator: { chat: { model: "gpt-9[1m]", effort: "high" } } }).orchestrator!.chat)
      .toEqual({ model: "opus", effort: "high" });
  });
});

describe("coerceRunnerSettings — scheduler section (story-scheduler-lanes-recursos)", () => {
  const ds = DEFAULT_RUNNER_SETTINGS.autorun.scheduler;

  it("an absent scheduler section falls back to the permissive defaults (99/99/0/999)", () => {
    const out = coerceRunnerSettings({ autorun: {} }).autorun.scheduler;
    expect(out).toEqual(ds);
    expect(out.lanes.light.maxConcurrent).toBe(99);
    expect(out.lanes.heavy.maxConcurrent).toBe(99);
    expect(out.thresholds.ramFreeMb).toBe(0);
    expect(out.thresholds.loadAvg1).toBe(999);
  });

  it("coerces operational values from YAML, filling any missing field from defaults", () => {
    const out = coerceRunnerSettings({
      autorun: { scheduler: { lanes: { light: { maxConcurrent: 4 } }, thresholds: { ramFreeMb: 400, loadAvg1: 3.5 } } },
    }).autorun.scheduler;
    expect(out.lanes.light.maxConcurrent).toBe(4); // from YAML
    expect(out.lanes.heavy.maxConcurrent).toBe(99); // missing → default
    expect(out.thresholds.ramFreeMb).toBe(400);
    expect(out.thresholds.loadAvg1).toBe(3.5);
  });

  it("ignores garbage lane/threshold values, keeping defaults (ramFreeMb: 0 stays valid)", () => {
    const out = coerceRunnerSettings({
      autorun: { scheduler: { lanes: { heavy: { maxConcurrent: "x" } }, thresholds: { ramFreeMb: 0, loadAvg1: -2 } } },
    }).autorun.scheduler;
    expect(out.lanes.heavy.maxConcurrent).toBe(99); // non-numeric → default
    expect(out.thresholds.ramFreeMb).toBe(0); // 0 is valid, not coerced away
    expect(out.thresholds.loadAvg1).toBe(999); // negative → default
  });

  // --- SM-4 governor lane quotas (memoryMax / cpuQuota) ----------------------------
  it("a lane WITHOUT quota fields has none (no memoryMax/cpuQuota keys — back-compat default)", () => {
    const out = coerceRunnerSettings({ autorun: {} }).autorun.scheduler.lanes;
    expect(out.light.memoryMax).toBeUndefined();
    expect(out.light.cpuQuota).toBeUndefined();
    expect(out.heavy.memoryMax).toBeUndefined();
    expect(out.heavy.cpuQuota).toBeUndefined();
  });

  it("coerces lane quotas from YAML (memoryMax string, cpuQuota positive int)", () => {
    const out = coerceRunnerSettings({
      autorun: {
        scheduler: {
          lanes: {
            light: { maxConcurrent: 4, memoryMax: "2G", cpuQuota: 100 },
            heavy: { maxConcurrent: 1, memoryMax: "8G", cpuQuota: 300 },
          },
        },
      },
    }).autorun.scheduler.lanes;
    expect(out.light).toEqual({ maxConcurrent: 4, memoryMax: "2G", cpuQuota: 100 });
    expect(out.heavy).toEqual({ maxConcurrent: 1, memoryMax: "8G", cpuQuota: 300 });
  });

  it("ignores a blank memoryMax / non-positive cpuQuota (the lane keeps no quota)", () => {
    const out = coerceRunnerSettings({
      autorun: { scheduler: { lanes: { light: { memoryMax: "  ", cpuQuota: 0 }, heavy: { cpuQuota: -5 } } } },
    }).autorun.scheduler.lanes;
    expect(out.light.memoryMax).toBeUndefined();
    expect(out.light.cpuQuota).toBeUndefined();
    expect(out.heavy.cpuQuota).toBeUndefined();
  });
});

describe("coerceRunnerSettings — mergeGate (story-1k7els)", () => {
  const dmg = DEFAULT_RUNNER_SETTINGS.autorun.mergeGate!;

  it("the default is the integration gate OFF (a dormant capability)", () => {
    expect(dmg).toEqual({ enabled: false, checkCommand: "vitest run", timeoutMs: 300_000, retryOnNewFailure: true, typecheck: { enabled: true, command: "bunx tsc --noEmit" } });
  });

  it("an absent mergeGate section falls back to the OFF default", () => {
    expect(coerceRunnerSettings({ autorun: {} }).autorun.mergeGate).toEqual(dmg);
  });

  it("coerces enabled from YAML, filling checkCommand/timeoutMs from defaults", () => {
    const out = coerceRunnerSettings({ autorun: { mergeGate: { enabled: true } } }).autorun.mergeGate;
    expect(out).toEqual({ enabled: true, checkCommand: dmg.checkCommand, timeoutMs: dmg.timeoutMs, retryOnNewFailure: true, typecheck: { enabled: true, command: "bunx tsc --noEmit" } });
  });

  it("coerces a full mergeGate from YAML (trims checkCommand, positive-int timeoutMs)", () => {
    const out = coerceRunnerSettings({
      autorun: { mergeGate: { enabled: true, checkCommand: "  just test-storymap  ", timeoutMs: 120_000 } },
    }).autorun.mergeGate;
    expect(out).toEqual({ enabled: true, checkCommand: "just test-storymap", timeoutMs: 120_000, retryOnNewFailure: true, typecheck: { enabled: true, command: "bunx tsc --noEmit" } });
  });

  it("coerces retryOnNewFailure from YAML (WS1.3 flaky quarantine toggle), defaulting true", () => {
    const off = coerceRunnerSettings({ autorun: { mergeGate: { enabled: true, retryOnNewFailure: false } } }).autorun.mergeGate;
    expect(off?.retryOnNewFailure).toBe(false);
    const on = coerceRunnerSettings({ autorun: { mergeGate: { enabled: true } } }).autorun.mergeGate;
    expect(on?.retryOnNewFailure).toBe(true);
  });

  it("ignores a blank checkCommand / non-positive timeoutMs (keeps defaults), honoring enabled", () => {
    const out = coerceRunnerSettings({
      autorun: { mergeGate: { enabled: true, checkCommand: "   ", timeoutMs: 0 } },
    }).autorun.mergeGate;
    expect(out).toEqual({ enabled: true, checkCommand: dmg.checkCommand, timeoutMs: dmg.timeoutMs, retryOnNewFailure: true, typecheck: { enabled: true, command: "bunx tsc --noEmit" } });
  });

  it("ignores a non-boolean enabled (default OFF kept — no accidental enable from garbage)", () => {
    const out = coerceRunnerSettings({ autorun: { mergeGate: { enabled: "yes" } } }).autorun.mergeGate;
    expect(out?.enabled).toBe(false);
  });
});

describe("maxTurnsResumeMax — the bounded max-turns resume cap knob (story-9s52tu HALF B)", () => {
  const ORIGINAL = process.env.AGILEHARNESS_AUTORUN_MAXTURNS_RESUME_MAX;
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.AGILEHARNESS_AUTORUN_MAXTURNS_RESUME_MAX;
    else process.env.AGILEHARNESS_AUTORUN_MAXTURNS_RESUME_MAX = ORIGINAL;
  });
  beforeEach(() => {
    delete process.env.AGILEHARNESS_AUTORUN_MAXTURNS_RESUME_MAX;
  });

  it("defaults to 2 when unset", () => {
    expect(maxTurnsResumeMax()).toBe(2);
  });
  it("honors a positive override (floored)", () => {
    process.env.AGILEHARNESS_AUTORUN_MAXTURNS_RESUME_MAX = "4.9";
    expect(maxTurnsResumeMax()).toBe(4);
  });
  it("allows 0 (disable auto-resume — the first max-turns settle escalates straight to a failure)", () => {
    process.env.AGILEHARNESS_AUTORUN_MAXTURNS_RESUME_MAX = "0";
    expect(maxTurnsResumeMax()).toBe(0);
  });
  it("falls back to the default on garbage / negative input (never a degenerate cap)", () => {
    process.env.AGILEHARNESS_AUTORUN_MAXTURNS_RESUME_MAX = "nonsense";
    expect(maxTurnsResumeMax()).toBe(2);
    process.env.AGILEHARNESS_AUTORUN_MAXTURNS_RESUME_MAX = "-3";
    expect(maxTurnsResumeMax()).toBe(2);
  });
});

// ── ADR-063 (4b) loop-guard cap + (4a) per-card budget knobs ──────────────────────────────────────
describe("noProgressMax — the same-column-no-progress loop-guard cap (ADR-063 4b)", () => {
  beforeEach(() => {
    delete process.env.AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX;
  });

  it("defaults to 3 (a dormant-but-ON circuit breaker)", () => {
    expect(DEFAULT_RUNNER_SETTINGS.autorun.noProgressMax).toBe(3);
    expect(coerceRunnerSettings({ autorun: {} }).autorun.noProgressMax).toBe(3);
  });

  it("coerces a non-negative int from YAML; 0 is a VALID value (disable), garbage/negative → default", () => {
    expect(coerceRunnerSettings({ autorun: { noProgressMax: 5 } }).autorun.noProgressMax).toBe(5);
    expect(coerceRunnerSettings({ autorun: { noProgressMax: 0 } }).autorun.noProgressMax).toBe(0); // disable kept
    expect(coerceRunnerSettings({ autorun: { noProgressMax: "x" } }).autorun.noProgressMax).toBe(3);
    expect(coerceRunnerSettings({ autorun: { noProgressMax: -2 } }).autorun.noProgressMax).toBe(3);
  });

  it("AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX overrides the file value (env wins)", () => {
    process.env.AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX = "9";
    expect(applyEnvOverrides(fileSettings()).autorun.noProgressMax).toBe(9);
  });

  it("AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX=0 DISABLES the guard (env beats the file)", () => {
    process.env.AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX = "0";
    expect(applyEnvOverrides(fileSettings()).autorun.noProgressMax).toBe(0);
  });

  it("unset keeps the file value (7); an EMPTY var reads as unset (NOT coerced to 0 by Number(''))", () => {
    expect(applyEnvOverrides(fileSettings()).autorun.noProgressMax).toBe(7); // file value
    process.env.AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX = "   ";
    expect(applyEnvOverrides(fileSettings()).autorun.noProgressMax).toBe(7); // blank ignored, not 0
    process.env.AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX = "nope";
    expect(applyEnvOverrides(fileSettings()).autorun.noProgressMax).toBe(7); // garbage ignored
  });
});

describe("cardBudgetUSD — the opt-in per-card lifetime $ backstop (ADR-063 4a)", () => {
  beforeEach(() => {
    delete process.env.AGILEHARNESS_AUTORUN_CARD_BUDGET_USD;
  });

  it("DEFAULT is undefined = DISABLED (no behaviour change unless opted in)", () => {
    expect(DEFAULT_RUNNER_SETTINGS.autorun.cardBudgetUSD).toBeUndefined();
    expect(coerceRunnerSettings({ autorun: {} }).autorun.cardBudgetUSD).toBeUndefined();
  });

  it("coerces a POSITIVE float from YAML; 0 / negative / garbage → undefined (stays OFF, no card freeze)", () => {
    expect(coerceRunnerSettings({ autorun: { cardBudgetUSD: 12.5 } }).autorun.cardBudgetUSD).toBe(12.5);
    expect(coerceRunnerSettings({ autorun: { cardBudgetUSD: 0 } }).autorun.cardBudgetUSD).toBeUndefined();
    expect(coerceRunnerSettings({ autorun: { cardBudgetUSD: -5 } }).autorun.cardBudgetUSD).toBeUndefined();
    expect(coerceRunnerSettings({ autorun: { cardBudgetUSD: "x" } }).autorun.cardBudgetUSD).toBeUndefined();
  });

  it("AGILEHARNESS_AUTORUN_CARD_BUDGET_USD (positive float) enables it over an absent file value", () => {
    process.env.AGILEHARNESS_AUTORUN_CARD_BUDGET_USD = "20.5";
    expect(applyEnvOverrides(fileSettings()).autorun.cardBudgetUSD).toBe(20.5);
  });

  it("unset / blank / ≤0 leaves the file value untouched (never silently freezes a card)", () => {
    expect(applyEnvOverrides(fileSettings()).autorun.cardBudgetUSD).toBeUndefined(); // file has none
    process.env.AGILEHARNESS_AUTORUN_CARD_BUDGET_USD = "0";
    expect(applyEnvOverrides(fileSettings()).autorun.cardBudgetUSD).toBeUndefined(); // 0 ignored
    process.env.AGILEHARNESS_AUTORUN_CARD_BUDGET_USD = "";
    expect(applyEnvOverrides(fileSettings()).autorun.cardBudgetUSD).toBeUndefined(); // blank ignored
  });
});

describe("activeEnvOverrides — the ADR-063 knobs surface when set", () => {
  beforeEach(() => {
    delete process.env.AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX;
    delete process.env.AGILEHARNESS_AUTORUN_CARD_BUDGET_USD;
  });

  it("neither knob appears when unset", () => {
    const out = activeEnvOverrides();
    expect(out).not.toContain("AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX");
    expect(out).not.toContain("AGILEHARNESS_AUTORUN_CARD_BUDGET_USD");
  });

  it("both appear once set (so the UI can flag them)", () => {
    process.env.AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX = "5";
    process.env.AGILEHARNESS_AUTORUN_CARD_BUDGET_USD = "12";
    const out = activeEnvOverrides();
    expect(out).toContain("AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX");
    expect(out).toContain("AGILEHARNESS_AUTORUN_CARD_BUDGET_USD");
  });
});
