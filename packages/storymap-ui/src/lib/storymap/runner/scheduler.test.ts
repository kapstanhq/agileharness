import { describe, expect, it } from "vitest";
import {
  classifyTrigger,
  isVpsOverloaded,
  loadCeilingFor,
  parseMemAvailableMb,
  probeVpsResources,
  type SchedulerThresholds,
} from "./scheduler";

// A realistic /proc/meminfo slice (Linux). MemAvailable is 2_000_000 kB ≈ 1953.125 MB.
const MEMINFO = [
  "MemTotal:       8169312 kB",
  "MemFree:         500000 kB",
  "MemAvailable:   2000000 kB",
  "Buffers:          12345 kB",
].join("\n");

describe("classifyTrigger — lane membership (AC1)", () => {
  it("routes the high-context code/diagnose/browser skills to the HEAVY lane", () => {
    for (const t of ["harness-do", "harness-review", "harness-qa", "harness-refine", "harness-fix", "harness-retire", "harness-sync-card"] as const) {
      expect(classifyTrigger(t)).toBe("heavy");
    }
  });

  it("routes the .md-only fast skills to the LIGHT lane", () => {
    for (const t of ["harness-enrich", "harness-prioritize", "harness-tasks", "harness-plan", "harness-ux"] as const) {
      expect(classifyTrigger(t)).toBe("light");
    }
  });
});

describe("parseMemAvailableMb — /proc/meminfo parsing (AC1)", () => {
  it("prefers MemAvailable and converts kB → MB", () => {
    expect(parseMemAvailableMb(MEMINFO)).toBeCloseTo(2000000 / 1024, 5);
  });

  it("falls back to MemFree when MemAvailable is absent", () => {
    const noAvail = "MemTotal:  8169312 kB\nMemFree:  500000 kB\n";
    expect(parseMemAvailableMb(noAvail)).toBeCloseTo(500000 / 1024, 5);
  });

  it("throws on a file with neither line (caller treats it as unavailable)", () => {
    expect(() => parseMemAvailableMb("Garbage:  1 kB\n")).toThrow();
  });
});

describe("probeVpsResources — sampling with injected OS readers (AC1)", () => {
  it("parses free RAM from the meminfo reader and load from the loadavg reader", () => {
    const r = probeVpsResources(() => MEMINFO, () => 1.25);
    expect(r.freeRamMb).toBeCloseTo(2000000 / 1024, 5);
    expect(r.loadAvg1).toBe(1.25);
  });

  it("FAIL-OPEN: a meminfo read error yields Infinity free RAM (never blocks)", () => {
    const r = probeVpsResources(
      () => {
        throw new Error("ENOENT /proc/meminfo");
      },
      () => 0.5,
    );
    expect(r.freeRamMb).toBe(Infinity);
    expect(r.loadAvg1).toBe(0.5);
  });

  it("FAIL-OPEN: a loadavg read error yields 0 load (never blocks)", () => {
    const r = probeVpsResources(
      () => MEMINFO,
      () => {
        throw new Error("no loadavg");
      },
    );
    expect(r.loadAvg1).toBe(0);
  });
});

describe("isVpsOverloaded — admission threshold (AC2)", () => {
  const thresholds: SchedulerThresholds = { ramFreeMb: 400, loadAvg1: 3.5 };

  it("is true when free RAM dipped below the floor", () => {
    expect(isVpsOverloaded({ freeRamMb: 399, loadAvg1: 0 }, thresholds)).toBe(true);
  });

  it("is true when the 1-min load climbed above the ceiling", () => {
    expect(isVpsOverloaded({ freeRamMb: 4000, loadAvg1: 3.6 }, thresholds)).toBe(true);
  });

  it("is false when both RAM and load are within bounds", () => {
    expect(isVpsOverloaded({ freeRamMb: 401, loadAvg1: 3.4 }, thresholds)).toBe(false);
  });

  it("is false exactly at the boundary (floor not crossed, ceiling not exceeded)", () => {
    expect(isVpsOverloaded({ freeRamMb: 400, loadAvg1: 3.5 }, thresholds)).toBe(false);
  });

  it("the permissive defaults (0 / 999) never block, even on a starved box", () => {
    const permissive: SchedulerThresholds = { ramFreeMb: 0, loadAvg1: 999 };
    expect(isVpsOverloaded({ freeRamMb: 1, loadAvg1: 50 }, permissive)).toBe(false);
  });
});

describe("loadCeilingFor — a load threshold only means something in CORES", () => {
  it("uses the absolute ceiling when no per-core value is set (back-compat)", () => {
    expect(loadCeilingFor({ ramFreeMb: 0, loadAvg1: 3.5 }, 6)).toBe(3.5);
  });

  it("PER-CORE wins when set, scaling with the host", () => {
    expect(loadCeilingFor({ ramFreeMb: 0, loadAvg1: 3.5, loadAvg1PerCore: 1 }, 6)).toBe(6);
    expect(loadCeilingFor({ ramFreeMb: 0, loadAvg1: 3.5, loadAvg1PerCore: 1 }, 16)).toBe(16);
  });

  it("the SAME config admits differently per host — which is the whole point", () => {
    const t: SchedulerThresholds = { ramFreeMb: 0, loadAvg1: 999, loadAvg1PerCore: 1 };
    const box = { freeRamMb: 8000, loadAvg1: 5 };
    expect(isVpsOverloaded(box, t, 2)).toBe(true); // load 5 on 2 cores = saturated
    expect(isVpsOverloaded(box, t, 16)).toBe(false); // same load on 16 cores = idle
  });

  it("this incident: an absolute BELOW the host's own baseline stalls every heavy run", () => {
    // 6-core VPS, baseline load 5–9, configured ceiling 3.5 → the heavy lane and worktree_open refused
    // every request while looking exactly like an idle pipeline. Per-core expresses the intent portably.
    const baseline = { freeRamMb: 8000, loadAvg1: 5.5 };
    expect(isVpsOverloaded(baseline, { ramFreeMb: 1500, loadAvg1: 3.5 }, 6)).toBe(true);
    expect(isVpsOverloaded(baseline, { ramFreeMb: 1500, loadAvg1: 3.5, loadAvg1PerCore: 1 }, 6)).toBe(false);
  });

  it("a non-positive per-core value reads as NOT CONFIGURED (a 0 ceiling would admit nothing, ever)", () => {
    expect(loadCeilingFor({ ramFreeMb: 0, loadAvg1: 7, loadAvg1PerCore: 0 }, 6)).toBe(7);
  });

  it("never resolves below 1, so a single-core box is not locked out", () => {
    expect(loadCeilingFor({ ramFreeMb: 0, loadAvg1: 999, loadAvg1PerCore: 0.5 }, 1)).toBe(1);
  });
});
