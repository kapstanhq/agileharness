// Resource-aware admission scheduler for the autorun runner (story-scheduler-lanes-recursos).
//
// Two orthogonal concerns the RunnerEngine consults before admitting a queued run:
//   1. LANE classification — a run is LIGHT (low-context skills that only edit .md:
//      harness-enrich/prioritize/tasks/plan/ux) or HEAVY (high-context skills that write
//      code + run tools: harness-do/review/qa/refine/fix/retire/sync-card). The two lanes
//      have independent concurrency caps so a backlog of heavy runs never starves the
//      cheap light ones (and vice-versa).
//   2. VPS RESOURCE probe — free RAM + 1-min load average, sampled before admitting a
//      HEAVY run. A heavy run is held in its queue while the box is over the configured
//      threshold, so parallelism scales with the worktree isolation (SM-1) WITHOUT
//      saturating the server.
//
// All three functions are PURE (probeVpsResources takes its OS readers by injection, the
// engine's DI pattern) so the lane/threshold logic is unit-testable on Bun without vi.mock
// and without touching /proc on the test host.

import { loadavg, cpus } from "node:os";
import { readFileSync } from "node:fs";
import type { RunnerSettings, TriggerId } from "@/lib/storymap/types";
import { CODE_SKILLS } from "./skill-registry";

/** Which admission lane a run competes in. */
export type RunLane = "light" | "heavy";

/** A point-in-time sample of the VPS's spare capacity. */
export interface VpsResources {
  /** estimated free RAM in MB (Infinity when /proc/meminfo is unavailable → never blocks) */
  freeRamMb: number;
  /** the 1-minute load average (0 on platforms without one, e.g. Windows → never blocks) */
  loadAvg1: number;
}

/** The per-lane admission thresholds (mirrors RunnerSettings so the two never diverge). */
export type SchedulerThresholds = RunnerSettings["autorun"]["scheduler"]["thresholds"];

// High-context skills (write product code + run the TDD suite, or read the live codebase to diagnose /
// drive a browser) consomem RAM/CPU real e vão na lane HEAVY throttled; o resto (skills .md-only rápidas)
// vai na LIGHT. A pertinência é EXATAMENTE o CODE_SKILLS de skill-registry.ts — antes este Set era uma
// CÓPIA mantida em lockstep manual por comentário (sumiu). (FULL_AUTONOMY difere: inclui harness-enrich, que é
// LIGHT aqui — por isso continua próprio no engine.)

/** Classify a run into its admission lane by trigger. Pure — exported for tests. */
export function classifyTrigger(trigger: TriggerId): RunLane {
  return CODE_SKILLS.has(trigger) ? "heavy" : "light";
}

// Injectable OS readers so probeVpsResources stays a pure function under test (Bun has no
// vi.mock): production gets the real /proc/meminfo read + os.loadavg, a test passes fakes.
export type MemInfoReader = () => string;
export type LoadAvgReader = () => number;

const defaultReadMemInfo: MemInfoReader = () => readFileSync("/proc/meminfo", "utf8");
const defaultLoadAvg1: LoadAvgReader = () => loadavg()[0];

/**
 * Parse the kernel's allocatable-RAM estimate (MB) from /proc/meminfo. Prefers
 * `MemAvailable` (the kernel's own estimate of RAM obtainable without swapping) and
 * falls back to `MemFree`. Throws when neither line is present so the caller can treat a
 * malformed file like a missing one (→ Infinity, never blocks). Pure — exported for tests.
 */
export function parseMemAvailableMb(meminfo: string): number {
  const match =
    /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo) ?? /^MemFree:\s+(\d+)\s*kB/m.exec(meminfo);
  if (!match) throw new Error("/proc/meminfo sem MemAvailable/MemFree");
  return Number(match[1]) / 1024;
}

/**
 * Sample the VPS's spare capacity (free RAM + 1-min load). FAIL-OPEN by design: on any
 * platform without /proc/meminfo (dev macOS/Windows) or any read error, freeRamMb is
 * Infinity and a read error on loadavg yields 0 — so a probe failure NEVER blocks a run.
 * The OS readers are injected (DI) so the parse/fallback logic is testable without /proc.
 */
export function probeVpsResources(
  readMemInfo: MemInfoReader = defaultReadMemInfo,
  loadAvg1: LoadAvgReader = defaultLoadAvg1,
): VpsResources {
  let freeRamMb: number;
  try {
    freeRamMb = parseMemAvailableMb(readMemInfo());
  } catch {
    freeRamMb = Infinity; // no /proc/meminfo or malformed → don't block on RAM
  }
  let load: number;
  try {
    load = loadAvg1();
  } catch {
    load = 0; // no load average available → don't block on CPU
  }
  return { freeRamMb, loadAvg1: load };
}

/**
 * The load ceiling to admit a HEAVY run, resolved in units the number actually means something in: CORES.
 *
 * A bare `loadAvg1: 3.5` is not portable — 3.5 is idle on a 16-core box and saturated on a 2-core one, so
 * the same config admits everything on one host and NOTHING on another. That is not hypothetical: on this
 * 6-core VPS the configured 3.5 sat BELOW the host's own baseline (5–9 with the service polling), so the
 * heavy lane AND `worktree_open` refused every request — the board stalled on admission control, silently,
 * because a fail-closed threshold with no signal looks exactly like an idle pipeline. Same family of defect
 * as the capability contract this release adds: a rule whose premise was never checked against the host.
 *
 * Precedence: `loadAvg1PerCore` (portable — multiplied by the host's core count) WINS when set; otherwise
 * the absolute `loadAvg1`. Per-core wins rather than the reverse so adopting it is a one-line addition,
 * with no window where a host is left running on the permissive default while the absolute is removed.
 * Pure — exported for tests.
 */
export function loadCeilingFor(t: SchedulerThresholds, cores: number): number {
  const perCore = t.loadAvg1PerCore;
  if (perCore != null && Number.isFinite(perCore) && perCore > 0) return Math.max(1, perCore * Math.max(1, cores));
  return t.loadAvg1;
}

/**
 * Is the box too loaded to admit another HEAVY run? True when free RAM dipped BELOW the
 * configured floor OR the 1-min load climbed ABOVE the ceiling ({@link loadCeilingFor} — the
 * configured absolute, else derived from the core count). With the permissive defaults
 * (ramFreeMb: 0, loadAvg1: 999) this is always false — identical to the pre-scheduler engine.
 * Pure — exported for tests.
 */
export function isVpsOverloaded(r: VpsResources, t: SchedulerThresholds, cores = cpus().length): boolean {
  return r.freeRamMb < t.ramFreeMb || r.loadAvg1 > loadCeilingFor(t, cores);
}
