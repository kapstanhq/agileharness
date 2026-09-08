// Resource governor for the autorun runner (SM-4 · governor por systemd-run scope).
//
// Where the scheduler (SM-3, scheduler.ts) does ADMISSION — decides IF a run may start given the
// VPS's free RAM / load — this governor does ENFORCEMENT: once admitted, a run is wrapped in a
// transient `systemd-run --scope` so the kernel (cgroup v2) caps its RAM (`MemoryMax`) and CPU
// (`CPUQuota`). A run that blows past MemoryMax is OOM-killed INSIDE its own scope — contained, so
// concurrent runs survive — and the scope auto-cleans (`--collect`) so no `failed` transient unit
// accumulates in `systemctl list-units`.
//
// All three functions are PURE (the systemd probe takes its check by injection, the engine's DI
// pattern), so the wrapping/detection logic is unit-testable on Bun without vi.mock and without a
// real systemd/D-Bus on the test host.

import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// The named slice all run scopes live under — `systemctl status claude-runs.slice` and cgroup v2
// then aggregate every concurrent run for monitoring. systemd auto-creates the slice on first use.
const RUN_SLICE = "claude-runs.slice";

/**
 * The systemd scope a run launches into, DETERMINISTIC from the run's sessionId. Naming the scope
 * (vs the anonymous default) makes a crashed run's still-live cgroup ADDRESSABLE: recovery can stop it
 * by name even from a journal entry written before the unit field was persisted (the unit is rederivable
 * from sessionId alone). The `harness-run-` prefix is the SECURITY BOUNDARY — see {@link isRunScopeUnit}.
 */
export function runScopeUnit(sessionId: string, nonce?: string): string {
  // A per-invocation `nonce` makes the scope name UNIQUE even when the sessionId is reused across
  // resumed steps (`--resume`), so one step's scope teardown can NEVER target another step's scope
  // (the collision that surfaced as a mislabeled "oom-killed" in story-olr777). Recovery reads the
  // EXACT recorded `unit` from the journal, so uniqueness never breaks the stop-the-orphan-before-
  // resume path. Omit the nonce (legacy 1-arg call) to reproduce the old deterministic name — used
  // ONLY by recovery's fallback for pre-nonce journal entries that never recorded a `unit`.
  return `harness-run-${sessionId}${nonce ? `-${nonce}` : ""}.scope`;
}

// The ONLY unit-name shape any scope-targeted kill may touch. This regex is the STRUCTURAL guarantee
// that a scope-kill can NEVER hit `storymap.service` or the bare `claude-runs.slice` (the prime-directive
// guardrail: never kill the AgileHarness service). Every kill/stop site asserts it BEFORE exec and falls back
// to a no-op (never broadens to a slice) on any miss. sessionIds are uuids → [a-z0-9-].
const RUN_SCOPE_UNIT_RE = /^harness-run-[a-z0-9-]+\.scope$/;

/** Type-guard + allowlist: is `unit` a run scope we are permitted to stop/kill? Rejects undefined,
 * empty, the service, and any slice — the single boundary the kill primitives are built on. */
export function isRunScopeUnit(unit: string | undefined | null): unit is string {
  return typeof unit === "string" && RUN_SCOPE_UNIT_RE.test(unit);
}

/** A probe of `systemd-run` availability — injectable so tests need no real systemd. */
export type SystemdCheck = () => boolean;

// The real probe: `which systemd-run` succeeds only when the binary is on PATH. FAIL-OPEN — any
// throw (not found, no shell, permission) means "unavailable" → the engine spawns WITHOUT a scope
// (graceful degradation). Wrapped so the engine can call detectSystemd() with no args in prod.
const defaultCheck: SystemdCheck = () => {
  try {
    execSync("which systemd-run", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// Cached across calls: `which` is a process spawn, and availability never changes within a server
// lifetime. Null = not yet probed. A test passes its own `check` (bypassing + not poisoning the cache).
let cached: boolean | null = null;

/**
 * Is `systemd-run` available on this host? Cached after the first real probe (availability is
 * fixed for the process). `check` is injected ONLY by tests — the engine always calls with no
 * argument, getting the cached real result. Pure w.r.t. the injected check. Exported for tests.
 */
export function detectSystemd(check: SystemdCheck = defaultCheck): boolean {
  // An injected check (tests) bypasses the cache entirely, so cases stay independent.
  if (check !== defaultCheck) return check();
  if (cached === null) cached = defaultCheck();
  return cached;
}

/** Test-only: reset the memoized availability so a probe re-runs. */
export function resetSystemdCache(): void {
  cached = null;
}

/**
 * Build the `systemd-run --scope` prefix that wraps a run command. Flags:
 *   --scope                       run the command in a transient SCOPE (not a forking service), so
 *                                 it stays a child of THIS process and inherits stdio.
 *   --collect                     garbage-collect the unit even if it ends in `failed` (an OOM kill
 *                                 leaves the scope failed) — keeps `systemctl list-units` clean (AC3).
 *   --slice=claude-runs.slice     group every run under one named slice for aggregate monitoring.
 *   -p MemoryMax=<m>              hard RAM ceiling → kernel OOM-kills the scope's cgroup on breach.
 *   -p CPUQuota=<c>%              CFS CPU cap (100% = 1 core) so one run can't monopolize the box.
 *   --unit=<unit>                 NAME the scope (when given) so a crashed run's cgroup is addressable
 *                                 by recovery's stop-the-orphan-before-resume (see runScopeUnit). Omitted
 *                                 → anonymous scope (legacy / no sessionId), still valid.
 * Trailing `--` terminates systemd-run's own option parsing; the run command follows.
 * Pure — exported for tests.
 */
export function buildScopePrefix(memoryMax: string, cpuQuota: number, unit?: string): string {
  const unitFlag = unit ? `--unit=${unit} ` : "";
  return `systemd-run --scope --collect ${unitFlag}--slice=${RUN_SLICE} -p MemoryMax=${memoryMax} -p CPUQuota=${cpuQuota}% --`;
}

/**
 * Wrap a run command in a systemd-run scope when a quota is configured AND systemd is available.
 * Returns `{ cmd, applied }`:
 *   - `applied: true`  → cmd is `<scope prefix> <original cmd>`; the engine then treats a SIGKILL as
 *                        an OOM kill (the kernel's contained kill) rather than a generic exit.
 *   - `applied: false` → cmd is returned UNCHANGED. Two reasons: no quota for this lane (nothing to
 *                        enforce), or systemd unavailable (graceful degradation — the engine logs a
 *                        warning when a quota WAS configured but couldn't be enforced).
 * A quota counts as configured when EITHER memoryMax or cpuQuota is set; both flags are always
 * emitted together, so a lane that sets only one still gets a complete, valid scope. The unset side
 * falls back to a sentinel: MemoryMax=infinity (a true no-op) / CPUQuota=100% — NOTE the CPU sentinel
 * is NOT a no-op, it caps to a SINGLE core, so a memory-only lane is implicitly pinned to 1 core.
 * The shipped settings.yaml always sets both fields, so this single-sided path is unreachable today.
 * Pure — exported for tests.
 */
export function wrapWithScope(
  cmd: string,
  memoryMax: string | undefined,
  cpuQuota: number | undefined,
  available: boolean,
  unit?: string,
): { cmd: string; applied: boolean; unit?: string } {
  const hasQuota = (memoryMax != null && memoryMax !== "") || (cpuQuota != null && cpuQuota > 0);
  if (!hasQuota || !available) return { cmd, applied: false };
  // Emit a complete scope even if a lane configured only one side: systemd needs a value for each
  // flag we pass, so fill the unset field with a sentinel — MemoryMax=infinity (no-op) / CPUQuota=100%
  // (a single-CORE CAP, not a no-op: a memory-only lane is thereby pinned to one core).
  const mem = memoryMax != null && memoryMax !== "" ? memoryMax : "infinity";
  const cpu = cpuQuota != null && cpuQuota > 0 ? cpuQuota : 100;
  // `unit` is echoed back so the engine persists the EXACT scope name on the journal entry (used
  // verbatim by the kill primitives — never recomputed at a foreign call site).
  return { cmd: `${buildScopePrefix(mem, cpu, unit)} ${cmd}`, applied: true, unit };
}

/** Run a `systemctl` subcommand. Injected so the kill/liveness primitives are unit-testable without a
 * real systemd. NEVER throws — a non-zero exit (is-active on a dead unit, stop on a not-loaded unit) is
 * normal control flow, surfaced as {code, stdout}. */
export type SystemctlRun = (args: string[]) => Promise<{ code: number; stdout: string }>;

const defaultSystemctlRun: SystemctlRun = async (args) => {
  try {
    const { stdout } = await execFileP("systemctl", args, { timeout: 15_000 });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown };
    // systemctl exits non-zero for is-active(inactive) / stop(not-loaded) and still prints state to
    // stdout — surface both; never throw on the boot/shutdown path.
    return { code: typeof e.code === "number" ? e.code : 1, stdout: typeof e.stdout === "string" ? e.stdout : "" };
  }
};

/**
 * Is a run scope STILL alive? Probes the SCOPE (`systemctl is-active <unit>`), NOT the journal's recorded
 * pid — which is the (already-dead) `systemd-run` shell CLIENT, not the scope leader that survives a
 * service restart. Returns false for any non-"active" state OR an unaddressable unit (fail-safe: treat
 * unknown as dead so a caller's await-death loop can never hang on a bad name). DI exec for tests.
 */
export async function isRunScopeActive(unit: string | undefined | null, run: SystemctlRun = defaultSystemctlRun): Promise<boolean> {
  if (process.platform === "win32") return false; // no systemd scopes on win32 → no probe (symmetric with stopRunScope)
  if (!isRunScopeUnit(unit)) return false;
  const { stdout } = await run(["is-active", unit]).catch(() => ({ code: 1, stdout: "" }));
  return stdout.trim() === "active";
}

/**
 * The systemd InvocationID of a scope's CURRENT activation — a fresh 128-bit id systemd assigns each
 * time a unit starts. Empty string when the unit isn't loaded (already `--collect`ed / never started)
 * or the probe fails. stopRunScope uses it to prove the scope still alive AFTER its grace is the SAME
 * activation it set out to reap — not a same-named scope a resumed step relaunched into during the
 * grace window (which is exactly what SIGKILL'd the innocent next step in story-olr777). DI exec.
 */
export async function scopeInvocationId(unit: string, run: SystemctlRun = defaultSystemctlRun): Promise<string> {
  const { stdout } = await run(["show", unit, "--property=InvocationID", "--value"]).catch(() => ({ code: 1, stdout: "" }));
  return stdout.trim();
}

export interface StopScopeResult {
  acted: boolean;
  reason: string;
}

/**
 * The SINGLE constructor of a scope-targeted kill — the chokepoint the never-kill-the-service guardrail
 * is enforced at. STRUCTURAL safety (not prose):
 *   - refuses any unit that is not a `harness-run-*.scope` ({@link isRunScopeUnit}) → can NEVER target
 *     storymap.service or a slice; an empty/invalid/undefined unit is a NO-OP (it NEVER broadens to the
 *     `claude-runs.slice`, which `kill --kill-whom=all` would cascade across EVERY live run);
 *   - no-op on win32 (systemd scopes don't exist there — the engine's taskkill path handles those);
 *   - graceful `systemctl stop` first (SIGTERM to the scope cgroup, lets `--collect` clean up), then —
 *     only if still active after the grace — escalates `systemctl kill -s SIGKILL` to the whole cgroup
 *     (the only thing that stops a SIGTERM-ignoring claude). The unit is passed VERBATIM — never
 *     reconstructed from an id at the call site (which could target a sibling run's scope).
 * Verified live (spike 2026-06-11): a named scope stops cleanly; a not-loaded unit stop is a harmless
 * exit-5 no-op, so a speculative stop of every interrupted entry is safe. DI exec + sleep for tests.
 */
export async function stopRunScope(
  unit: string | undefined | null,
  run: SystemctlRun = defaultSystemctlRun,
  opts: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<StopScopeResult> {
  if (process.platform === "win32") return { acted: false, reason: "win32-no-scope" };
  if (!isRunScopeUnit(unit)) return { acted: false, reason: "no-or-invalid-unit" };
  // GUARANTEED a `harness-run-*.scope` from here — the only shape the execs below can ever receive.
  // IDENTITY GUARD (story-olr777): capture the CURRENT activation's InvocationID BEFORE the grace.
  // If, after the grace, the scope is still active but under a DIFFERENT (or unverifiable) id, a
  // resumed step relaunched into a same-named scope DURING our grace — reaping it would SIGKILL an
  // innocent run (the root cause of the mislabeled-"oom-killed"). Only escalate to SIGKILL when the
  // SAME activation is provably still alive (a SIGTERM-ignoring claude, or detached grandchildren
  // keeping the cgroup up — the koieb3 reap). Fail-safe: an empty before-id ⇒ we can't prove
  // ownership ⇒ never SIGKILL (bias toward never killing the wrong run).
  const invocationBefore = await scopeInvocationId(unit, run);
  await run(["stop", unit]).catch(() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(opts.graceMs ?? 3_000);
  if (await isRunScopeActive(unit, run)) {
    const invocationAfter = await scopeInvocationId(unit, run);
    if (invocationBefore === "" || invocationBefore !== invocationAfter) {
      return { acted: true, reason: "skipped-foreign-activation" };
    }
    await run(["kill", "--kill-whom=all", "-s", "SIGKILL", unit]).catch(() => {});
  }
  return { acted: true, reason: "stopped" };
}
