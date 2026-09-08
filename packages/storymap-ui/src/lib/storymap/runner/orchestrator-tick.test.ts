import { describe, expect, it, vi } from "vitest";
import { runOrchestratorTick, startOrchestratorTick, type OrchestratorTickDeps } from "./orchestrator-tick";

const baseDeps = (over: Partial<OrchestratorTickDeps> = {}): OrchestratorTickDeps => ({
  enabled: true,
  activeBoards: async () => [{ board: "storymap", mode: "autonomous" }],
  leaseHeldByHuman: async () => false,
  budgetOk: async () => true,
  hasWork: async () => true,
  spawn: vi.fn(async () => {}),
  recordTick: vi.fn(async () => {}),
  recordOutcome: vi.fn(async () => {}),
  ...over,
});

// O breaker de spawn precede o budget DE PROPÓSITO. Em 2026-07-13 o board respondeu "parei por budget" durante
// horas — verdade no contador, mentira na causa (19 spawns natimortos o haviam esgotado). Um DEFEITO tem
// precedência sobre um limite de economia na hora de explicar ao operador por que o Jido não agiu.
describe("runOrchestratorTick — circuit breaker de spawn", () => {
  it("breaker aberto → não spawna, e o motivo é o DEFEITO (não 'budget')", async () => {
    const spawn = vi.fn(async () => {});
    const recordOutcome = vi.fn(async () => {});
    const r = await runOrchestratorTick(baseDeps({ spawn, recordOutcome, spawnBroken: async () => true }));
    expect(r).toEqual(["skipped-spawn-broken"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith("storymap", "skipped-spawn-broken");
  });

  it("breaker VENCE o budget esgotado — o operador vê a causa raiz, não o sintoma", async () => {
    const recordOutcome = vi.fn(async () => {});
    const r = await runOrchestratorTick(
      baseDeps({ recordOutcome, spawnBroken: async () => true, budgetOk: async () => false }),
    );
    expect(r).toEqual(["skipped-spawn-broken"]); // e NÃO "skipped-budget"
  });

  it("breaker fechado → o tick segue normal (nenhuma regressão no caminho feliz)", async () => {
    const spawn = vi.fn(async () => {});
    const r = await runOrchestratorTick(baseDeps({ spawn, spawnBroken: async () => false }));
    expect(r).toEqual(["ran"]);
    expect(spawn).toHaveBeenCalled();
  });

  it("dep ausente ⇒ sem breaker (compatível com o comportamento legado)", async () => {
    const r = await runOrchestratorTick(baseDeps({ spawnBroken: undefined }));
    expect(r).toEqual(["ran"]);
  });
});

describe("runOrchestratorTick (WS8) — the autonomous decision", () => {
  it("disabled → no spawn, empty result", async () => {
    const spawn = vi.fn(async () => {});
    expect(await runOrchestratorTick(baseDeps({ enabled: false, spawn }))).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("autonomous + work + budget + no lease → spawns + records", async () => {
    const spawn = vi.fn(async () => {});
    const recordTick = vi.fn(async () => {});
    const r = await runOrchestratorTick(baseDeps({ spawn, recordTick }));
    expect(r).toEqual(["ran"]);
    expect(spawn).toHaveBeenCalledWith("storymap", "autonomous", undefined); // sem wake ⇒ sem motivo
    expect(recordTick).toHaveBeenCalledWith("storymap");
  });

  it("wake: o MOTIVO do evento chega ao spawn (vai no prompt do run)", async () => {
    const spawn = vi.fn(async () => {});
    await runOrchestratorTick(baseDeps({ spawn, reason: 'Blocker aberto em "Login"' }));
    expect(spawn).toHaveBeenCalledWith("storymap", "autonomous", 'Blocker aberto em "Login"');
  });

  it("o spawn NÃO nasceu (sem token) → não debita o budget do dia", async () => {
    // o estado real do acme mostrava 6 ticks "gastos" e $0: o spawn era pulado por falta de token e o budget
    // era debitado assim mesmo — 20 ticks/dia queimados sem NENHUM run ter existido.
    const spawn = vi.fn(async () => false);
    const recordTick = vi.fn(async () => {});
    const r = await runOrchestratorTick(baseDeps({ spawn, recordTick }));
    expect(r).toEqual(["skipped-spawn-failed"]);
    expect(recordTick).not.toHaveBeenCalled();
  });

  it("um run DESTE board já em voo → não empilha um segundo Jido", async () => {
    // a corrida que o wake por evento cria: o timer e um evento caindo na mesma janela.
    const spawn = vi.fn(async () => {});
    const r = await runOrchestratorTick(baseDeps({ spawn, runInFlight: async () => true }));
    expect(r).toEqual(["skipped-running"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ZERO-TOKEN: no work → no spawn (an idle board costs nothing)", async () => {
    const spawn = vi.fn(async () => {});
    expect(await runOrchestratorTick(baseDeps({ hasWork: async () => false, spawn }))).toEqual(["skipped-no-work"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  // O DEADLOCK que este dep resolve: quando TODOS os itens caem no backoff anti-noop, `hasWork` fica false
  // para sempre. O steward completo roda DEPOIS do hasWork (de propósito — 8.1/8.2/8.3 AGEM e não podem furar
  // os gates), então o único mecanismo capaz de destravar um item preso nunca era alcançado: a recuperação
  // ficava atrás exatamente da condição que ela existe para recuperar. Medido em 2026-07-18: o acme passou
  // horas em `skipped-no-work` com o fato de mundo já resolvido e ninguém para observá-lo.
  it("sem trabalho → NÃO spawna, mas RODA o passe de recuperação ($0, sob prova) — senão o backoff é eterno", async () => {
    const spawn = vi.fn(async () => {});
    const recoveryPass = vi.fn(async () => {});
    const stewardPass = vi.fn(async () => {});
    const r = await runOrchestratorTick(baseDeps({ hasWork: async () => false, spawn, recoveryPass, stewardPass }));
    expect(r).toEqual(["skipped-no-work"]);
    expect(recoveryPass).toHaveBeenCalledWith("storymap"); // a saída do deadlock
    expect(spawn).not.toHaveBeenCalled(); // segue custando ZERO token
    expect(stewardPass).not.toHaveBeenCalled(); // 8.1/8.2/8.3 continuam gated por hasWork — nada de furar
  });

  it("COM trabalho → o passe completo roda e o de recuperação NÃO (ele é só a saída do caminho sem-trabalho)", async () => {
    const recoveryPass = vi.fn(async () => {});
    const stewardPass = vi.fn(async () => {});
    await runOrchestratorTick(baseDeps({ hasWork: async () => true, recoveryPass, stewardPass }));
    expect(stewardPass).toHaveBeenCalledWith("storymap");
    expect(recoveryPass).not.toHaveBeenCalled();
  });

  it("3.5a — a stand-down records the outcome via recordOutcome, and never consumes budget (recordTick)", async () => {
    const recordOutcome = vi.fn(async () => {});
    const recordTick = vi.fn(async () => {});
    await runOrchestratorTick(baseDeps({ hasWork: async () => false, recordOutcome, recordTick }));
    expect(recordOutcome).toHaveBeenCalledWith("storymap", "skipped-no-work");
    expect(recordTick).not.toHaveBeenCalled(); // a skip never touches the budget
  });

  it("a paired board is the human's — the autonomous tick never acts there", async () => {
    const spawn = vi.fn(async () => {});
    const r = await runOrchestratorTick(baseDeps({ activeBoards: async () => [{ board: "b", mode: "paired" }], spawn }));
    expect(r).toEqual(["skipped-not-autonomous"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("human lease held → stand down", async () => {
    const spawn = vi.fn(async () => {});
    expect(await runOrchestratorTick(baseDeps({ leaseHeldByHuman: async () => true, spawn }))).toEqual(["skipped-leased"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("budget exhausted → no-op", async () => {
    const spawn = vi.fn(async () => {});
    expect(await runOrchestratorTick(baseDeps({ budgetOk: async () => false, spawn }))).toEqual(["skipped-budget"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("6.4 — backs off when the last spawns saw no board progress (shouldBackoff true) → no spawn", async () => {
    const spawn = vi.fn(async () => {});
    const recordOutcome = vi.fn(async () => {});
    const r = await runOrchestratorTick(baseDeps({ shouldBackoff: async () => true, spawn, recordOutcome }));
    expect(r).toEqual(["skipped-backoff"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith("storymap", "skipped-backoff");
  });

  it("6.4 — shouldBackoff is checked AFTER hasWork (no work short-circuits first)", async () => {
    const shouldBackoff = vi.fn(async () => true);
    const r = await runOrchestratorTick(baseDeps({ hasWork: async () => false, shouldBackoff }));
    expect(r).toEqual(["skipped-no-work"]);
    expect(shouldBackoff).not.toHaveBeenCalled(); // hasWork false short-circuits → backoff never consulted
  });

  it("6.4 — backoff is opt-in: with work + no shouldBackoff dep, the tick still spawns", async () => {
    const spawn = vi.fn(async () => {});
    expect(await runOrchestratorTick(baseDeps({ spawn }))).toEqual(["ran"]); // baseDeps has no shouldBackoff
    expect(spawn).toHaveBeenCalled();
  });

  it("independent per board; a per-board error is swallowed to 'error' (timer keeps going)", async () => {
    const spawn = vi.fn(async (b: string) => {
      if (b === "bad") throw new Error("boom");
    });
    const r = await runOrchestratorTick(
      baseDeps({
        activeBoards: async () => [
          { board: "ok", mode: "autonomous" },
          { board: "bad", mode: "autonomous" },
        ],
        spawn,
      }),
    );
    expect(r).toEqual(["ran", "error"]);
  });
});

describe("startOrchestratorTick — re-arming timer", () => {
  it("intervalMs <= 0 is a no-op", () => {
    const tick = vi.fn(async () => {});
    const stop = startOrchestratorTick({ intervalMs: 0, tick });
    stop();
    expect(tick).not.toHaveBeenCalled();
  });

  it("arms once and re-arms after each tick; stop() cancels", async () => {
    const tick = vi.fn(async () => {});
    let fire: (() => void) | null = null;
    const setTimer = (fn: () => void) => {
      fire = fn;
      return { unref: () => {} };
    };
    const clearTimer = vi.fn();
    const stop = startOrchestratorTick({ intervalMs: 1000, tick, setTimer, clearTimer });
    expect(fire).not.toBeNull(); // armed
    fire!(); // fire one tick
    await new Promise((r) => setTimeout(r, 0));
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
    expect(clearTimer).toHaveBeenCalled();
  });
});
