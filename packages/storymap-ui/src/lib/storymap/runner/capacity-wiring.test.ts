import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapacityGovernor, setCapacityGovernorForTests } from "./capacity-service";
import { DAY_MS, DEFAULT_GOVERNOR_SETTINGS } from "./capacity-governor";
import { buildTickDeps } from "./orchestrator-run";
import { tickOutcomeText } from "@/lib/storymap/copilot/activity";
import { RunnerEngine } from "./engine";
import { CardClaims, memoryClaimStore, setCardClaimsSingletonForTests } from "./claims";
import type { RunnerJournalPort } from "./journal";
import type { TelemetryPort } from "./telemetry";
import type { WorktreeOps } from "./worktree";

// A FIAÇÃO de produção — as superfícies automáticas fora do engine consultam o SINGLETON do governador (o
// mesmo que o engine recebe por default). Um portão que só existe em teste com dublê é a capacidade declarada
// sem produtor; aqui o governador REAL (medidor injetado) retém e a superfície obedece.

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
let dir: string;

function heldGovernor(): CapacityGovernor {
  dir = mkdtempSync(path.join(tmpdir(), "capacity-wiring-"));
  return new CapacityGovernor({
    now: () => T0,
    settings: () => ({ ...DEFAULT_GOVERNOR_SETTINGS, timezone: "UTC" }),
    statsUrl: () => "http://medidor/stats",
    // 5h em 87% ⇒ o teto de 5h retém a automação (sem trava: nenhum aviso)
    readUsage: async () => ({
      source: "subscription",
      week: { usedPct: 40, resetsInMinutes: 0, resetsAt: T0 + 3 * DAY_MS },
      session: { usedPct: 87, resetsInMinutes: 0, resetsAt: T0 + 3_600_000 },
      weekSonnet: null,
      extra: null,
      polledAt: T0 - 60_000,
      stale: false,
    }),
    stateDir: () => path.join(dir, "autonomy"),
    haltPath: () => path.join(dir, "HALT"),
    notify: () => {},
    log: () => {},
  });
}

afterEach(() => {
  setCapacityGovernorForTests(null);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("o tick do copiloto consulta o governador de produção", () => {
  it("buildTickDeps().capacityHeld devolve o MOTIVO quando o governador retém, e a frase do chat o carrega", async () => {
    const g = heldGovernor();
    await g.refresh();
    setCapacityGovernorForTests(g);
    const detail = await buildTickDeps().capacityHeld!("acme");
    expect(detail).toContain("5 horas");
    const said = tickOutcomeText("skipped-capacity", { capacityDetail: detail ?? undefined });
    expect(said?.text).toContain("5 horas");
    await g.flush();
  });
});

describe("o engine de produção usa o governador SINGLETON por default", () => {
  it("construído sem portão explícito (como getRunnerEngine), um run automático espera o governador do processo", async () => {
    const g = heldGovernor();
    await g.refresh();
    setCapacityGovernorForTests(g);
    setCardClaimsSingletonForTests(new CardClaims(memoryClaimStore()));
    const spawned: string[] = [];
    const fakeSpawn = ((cmd: string) => {
      spawned.push(cmd);
      const ee = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
      ee.pid = 4321;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      return ee;
    }) as unknown as typeof import("node:child_process").spawn;
    const journal: RunnerJournalPort = { recordStart: () => {}, recordFinish: () => {}, markResumable: () => {} };
    const telemetry: TelemetryPort = {
      recordRun: async () => {},
      listByCard: async () => [],
      boardSummary: async (boardId) => ({ boardId, cards: [], totalCostUSD: 0 }),
    };
    const worktreeOps: WorktreeOps = {
      create: async (root, id) => ({ worktreePath: `${root}/.worktrees/run-${id}`, branch: `run/${id}` }),
      commit: async () => ({ committed: true }),
      commitBoardState: async () => ({ committed: false }),
      commitBoardStateAndPush: async () => ({ committed: false, pushed: false }),
      remove: async () => {},
      detach: async () => {},
      hasUnmergedWork: async () => true,
      disposeBranch: async () => {},
    };
    // posicional até a telemetria — o resto (inclusive o portão de capacidade) fica no DEFAULT de produção
    const engine = new RunnerEngine(
      fakeSpawn,
      journal,
      async () => null,
      worktreeOps,
      null,
      undefined,
      () => ({ freeRamMb: Infinity, loadAvg1: 0 }),
      () => false,
      async () => null,
      async () => null,
      telemetry,
    );
    engine.runSkill("acme", "prod-auto", "harness-enrich", { id: "enriquecer", name: "Especificar" });
    engine.runSkill("acme", "prod-op", "harness-enrich", { id: "enriquecer", name: "Especificar" }, { origin: "manual" });
    await new Promise((r) => setTimeout(r, 0));
    expect(spawned.some((c) => c.includes("acme/prod-auto"))).toBe(false);
    expect(spawned.some((c) => c.includes("acme/prod-op"))).toBe(true);
    expect(g.snapshot().held.count).toBe(1);
    await g.flush();
  });
});
