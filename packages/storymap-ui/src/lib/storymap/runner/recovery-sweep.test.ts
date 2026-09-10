import { describe, expect, it, vi } from "vitest";
import {
  RECOVERY_SWEEP_DEFAULT_MS,
  recoverySweepIntervalMs,
  runRecoverySweepTick,
  startRecoverySweep,
  type SweepTimer,
} from "./recovery-sweep";

// A real-macrotask flush so the re-arming `.finally(arm)` microtask chain has fully settled.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("recoverySweepIntervalMs — env knob", () => {
  it("defaults when unset / empty", () => {
    expect(recoverySweepIntervalMs({})).toBe(RECOVERY_SWEEP_DEFAULT_MS);
    expect(recoverySweepIntervalMs({ AGILEHARNESS_AUTORUN_RECOVERY_SWEEP_MS: "" })).toBe(RECOVERY_SWEEP_DEFAULT_MS);
  });

  it("parses a positive integer (ms)", () => {
    expect(recoverySweepIntervalMs({ AGILEHARNESS_AUTORUN_RECOVERY_SWEEP_MS: "60000" })).toBe(60000);
  });

  it("disables (0) on explicit 0 / negative / garbage", () => {
    expect(recoverySweepIntervalMs({ AGILEHARNESS_AUTORUN_RECOVERY_SWEEP_MS: "0" })).toBe(0);
    expect(recoverySweepIntervalMs({ AGILEHARNESS_AUTORUN_RECOVERY_SWEEP_MS: "-5" })).toBe(0);
    expect(recoverySweepIntervalMs({ AGILEHARNESS_AUTORUN_RECOVERY_SWEEP_MS: "abc" })).toBe(0);
  });
});

describe("runRecoverySweepTick — idle/enabled gating", () => {
  it("skips (disabled) WITHOUT calling recovery when autorun/resume is off", async () => {
    const runRecovery = vi.fn(async () => {});
    expect(await runRecoverySweepTick({ enabled: false, isIdle: () => true, runRecovery })).toBe("skipped-disabled");
    expect(runRecovery).not.toHaveBeenCalled();
  });

  it("skips (busy) WITHOUT calling recovery when work is in flight", async () => {
    const runRecovery = vi.fn(async () => {});
    expect(await runRecoverySweepTick({ enabled: true, isIdle: async () => false, runRecovery })).toBe("skipped-busy");
    expect(runRecovery).not.toHaveBeenCalled(); // the whole point: never fight the train / run git while busy
  });

  it("runs recovery exactly once when enabled AND idle", async () => {
    const runRecovery = vi.fn(async () => {});
    expect(await runRecoverySweepTick({ enabled: true, isIdle: async () => true, runRecovery })).toBe("ran");
    expect(runRecovery).toHaveBeenCalledTimes(1);
  });

  /**
   * P-3 e P-3b rodam ANTES do portão pelo mesmo motivo: a fila do train travada é justamente o que faz
   * `isIdle` responder false. Rodá-las depois seria a mesma inanição que o escape abaixo existe para
   * quebrar — quem espera uma condição que OUTRO precisa limpar precisa de saída quando esse outro é o
   * travado. Nenhuma das duas faz IO de git, então é seguro com o sistema ocupado.
   */
  it("varre a cabeça E re-cutuca o train mesmo OCUPADO — as duas rodam antes do portão", async () => {
    const ordem: string[] = [];
    const runRecovery = vi.fn(async () => {});
    const status = await runRecoverySweepTick({
      enabled: true,
      isIdle: async () => false,
      runRecovery,
      sweepStuckEntries: async () => void ordem.push("sweep"),
      pumpMergeQueue: async () => void ordem.push("pump"),
    });
    expect(status).toBe("skipped-busy"); // o portão seguiu fechado para o resto do tick
    expect(ordem).toEqual(["sweep", "pump"]); // destravar a cabeça ANTES de bombear o laço
    expect(runRecovery).not.toHaveBeenCalled();
  });

  it("um pump que lança não derruba o tick — best-effort como as irmãs", async () => {
    const runRecovery = vi.fn(async () => {});
    const status = await runRecoverySweepTick({
      enabled: true,
      isIdle: async () => true,
      runRecovery,
      pumpMergeQueue: async () => {
        throw new Error("fila ilegível");
      },
    });
    expect(status).toBe("ran");
    expect(runRecovery).toHaveBeenCalledTimes(1);
  });
});

// O LIVELOCK (2026-07-17): um run preso NA FILA mantém `isIdle` false para sempre, e a sweep que ele
// bloqueia é a ÚNICA coisa que resgata run preso — o órfão bloqueava o próprio resgatador. Ficou 5h+ assim,
// com o log CONTANDO os pulos ("PULADO 6x seguidas") e nada agindo. O portão de ociosidade é uma OTIMIZAÇÃO
// (o header sempre disse isso; a recovery se protege sozinha por maxConcurrent + rate-limit + in-flight):
// tratá-lo como pré-condição foi o que o virou livelock.
describe("runRecoverySweepTick — escape de inanição (o órfão não pode bloquear o próprio resgate)", () => {
  const limit = 3;

  it("abaixo do limite continua PULANDO ocupado (a otimização segue valendo no caso normal)", async () => {
    const runRecovery = vi.fn(async () => {});
    for (const busySkips of [0, 1, 2]) {
      expect(await runRecoverySweepTick({ enabled: true, isIdle: async () => false, runRecovery, busySkips, starvationLimit: limit })).toBe("skipped-busy");
    }
    expect(runRecovery).not.toHaveBeenCalled();
  });

  it("NO limite roda a recovery MESMO ocupado — é o que quebra o livelock", async () => {
    const runRecovery = vi.fn(async () => {});
    const status = await runRecoverySweepTick({ enabled: true, isIdle: async () => false, runRecovery, busySkips: limit, starvationLimit: limit });
    expect(status).toBe("ran-starved");
    expect(runRecovery).toHaveBeenCalledTimes(1);
  });

  it("o escape roda SÓ a recovery — branch GC e deploy-reconcile (git pesado) ficam para a janela ociosa", async () => {
    const runBranchGc = vi.fn(async () => {});
    const runDeployReconcile = vi.fn(async () => {});
    await runRecoverySweepTick({
      enabled: true,
      isIdle: async () => false,
      runRecovery: async () => {},
      runBranchGc,
      runDeployReconcile,
      busySkips: limit,
      starvationLimit: limit,
    });
    expect(runBranchGc).not.toHaveBeenCalled(); // não compramos contenção de git com o train ocupado…
    expect(runDeployReconcile).not.toHaveBeenCalled();
  });

  it("num tick OCIOSO os piggybacks voltam a rodar (o escape não os aposenta)", async () => {
    const runBranchGc = vi.fn(async () => {});
    const runDeployReconcile = vi.fn(async () => {});
    const status = await runRecoverySweepTick({
      enabled: true,
      isIdle: async () => true,
      runRecovery: async () => {},
      runBranchGc,
      runDeployReconcile,
      busySkips: 99, // streak alta, mas o box está OCIOSO → caminho normal, não o escape
      starvationLimit: limit,
    });
    expect(status).toBe("ran");
    expect(runBranchGc).toHaveBeenCalledTimes(1);
    expect(runDeployReconcile).toHaveBeenCalledTimes(1);
  });

  it("DESLIGADO vence o escape: inanição nunca ressuscita a sweep que o operador desligou", async () => {
    const runRecovery = vi.fn(async () => {});
    expect(await runRecoverySweepTick({ enabled: false, isIdle: async () => false, runRecovery, busySkips: 999, starvationLimit: limit })).toBe("skipped-disabled");
    expect(runRecovery).not.toHaveBeenCalled();
  });

  it("sem busySkips (chamador que não conta) o comportamento é o de antes: pula", async () => {
    const runRecovery = vi.fn(async () => {});
    expect(await runRecoverySweepTick({ enabled: true, isIdle: async () => false, runRecovery })).toBe("skipped-busy");
    expect(runRecovery).not.toHaveBeenCalled();
  });

  it("swallows a recovery error into 'error' (so the re-arming timer keeps going)", async () => {
    const status = await runRecoverySweepTick({
      enabled: true,
      isIdle: () => true,
      runRecovery: async () => {
        throw new Error("boom");
      },
    });
    expect(status).toBe("error");
  });
});

describe("startRecoverySweep — re-arming timer", () => {
  it("is a no-op when the interval is disabled (<=0)", () => {
    const setTimer = vi.fn();
    const stop = startRecoverySweep({ intervalMs: 0, tick: async () => {}, setTimer });
    expect(setTimer).not.toHaveBeenCalled();
    stop();
  });

  it("arms once, unrefs the handle, then RE-ARMS after each tick completes (never overlaps)", async () => {
    let captured: (() => void) | null = null;
    const unref = vi.fn();
    const setTimer = vi.fn((fn: () => void): SweepTimer => {
      captured = fn;
      return { unref };
    });
    const tick = vi.fn(async () => {});
    startRecoverySweep({ intervalMs: 1000, tick, setTimer });
    expect(setTimer).toHaveBeenCalledTimes(1); // armed
    expect(unref).toHaveBeenCalledTimes(1); // never keeps the process alive
    captured!(); // the timer fires → runs the tick, which re-arms in its finally
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledTimes(2); // re-armed for the next cycle
  });

  it("stop() prevents any further re-arming", async () => {
    let captured: (() => void) | null = null;
    const setTimer = vi.fn((fn: () => void): SweepTimer => {
      captured = fn;
      return { unref: () => {} };
    });
    const tick = vi.fn(async () => {});
    const stop = startRecoverySweep({ intervalMs: 1000, tick, setTimer, clearTimer: () => {} });
    stop();
    captured!(); // an already-scheduled timer fires after stop
    await flush();
    expect(setTimer).toHaveBeenCalledTimes(1); // NOT re-armed (the loop is dead)
  });
});
