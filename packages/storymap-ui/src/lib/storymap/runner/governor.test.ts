import { describe, expect, it } from "vitest";
import {
  buildScopePrefix,
  detectSystemd,
  isRunScopeActive,
  isRunScopeUnit,
  resetSystemdCache,
  runScopeUnit,
  scopeInvocationId,
  stopRunScope,
  wrapWithScope,
  type SystemctlRun,
} from "./governor";
import { itPosix } from "./test-platform";

// SM-4 governor: pure functions that wrap a run command in a `systemd-run --scope` for cgroup
// enforcement. DI on the systemd probe keeps the suite hermetic on Bun (no vi.mock, no real
// systemd/D-Bus on the test host).

describe("buildScopePrefix — the systemd-run --scope flag string", () => {
  it("emits scope + collect + named slice + MemoryMax + CPUQuota%, terminated by --", () => {
    expect(buildScopePrefix("2G", 100)).toBe(
      "systemd-run --scope --collect --slice=claude-runs.slice -p MemoryMax=2G -p CPUQuota=100% --",
    );
  });

  it("interpolates the heavy lane's larger quota", () => {
    expect(buildScopePrefix("8G", 300)).toBe(
      "systemd-run --scope --collect --slice=claude-runs.slice -p MemoryMax=8G -p CPUQuota=300% --",
    );
  });

  it("includes --collect so an OOM-failed scope is GC'd (no `failed` transient unit accumulates)", () => {
    expect(buildScopePrefix("2G", 100)).toContain("--collect");
  });
});

describe("wrapWithScope — apply the scope only when a quota is configured AND systemd is present", () => {
  const CMD = 'claude -p "/harness-do acme/story-1" --foo';

  it("wraps the command with the scope prefix when quota + systemd available", () => {
    const { cmd, applied } = wrapWithScope(CMD, "2G", 100, true);
    expect(applied).toBe(true);
    expect(cmd).toBe(`${buildScopePrefix("2G", 100)} ${CMD}`);
    expect(cmd.endsWith(CMD)).toBe(true); // original command preserved verbatim at the tail
  });

  it("passes the command through UNCHANGED when no quota is configured (nothing to enforce)", () => {
    const { cmd, applied } = wrapWithScope(CMD, undefined, undefined, true);
    expect(applied).toBe(false);
    expect(cmd).toBe(CMD);
  });

  it("passes the command through UNCHANGED when systemd is unavailable (graceful degradation)", () => {
    const { cmd, applied } = wrapWithScope(CMD, "2G", 100, false);
    expect(applied).toBe(false);
    expect(cmd).toBe(CMD);
  });

  it("an empty-string memoryMax with no cpuQuota counts as no quota (pass-through)", () => {
    const { applied } = wrapWithScope(CMD, "", undefined, true);
    expect(applied).toBe(false);
  });

  it("a cpuQuota of 0 counts as no quota (systemd rejects 0; treat as unset)", () => {
    const { applied } = wrapWithScope(CMD, undefined, 0, true);
    expect(applied).toBe(false);
  });

  it("memoryMax alone fills CPUQuota with a single-core cap so the scope is still complete", () => {
    const { cmd, applied } = wrapWithScope(CMD, "4G", undefined, true);
    expect(applied).toBe(true);
    expect(cmd).toContain("MemoryMax=4G");
    expect(cmd).toContain("CPUQuota=100%");
  });

  it("cpuQuota alone fills MemoryMax with infinity so the scope is still complete", () => {
    const { cmd, applied } = wrapWithScope(CMD, undefined, 200, true);
    expect(applied).toBe(true);
    expect(cmd).toContain("MemoryMax=infinity");
    expect(cmd).toContain("CPUQuota=200%");
  });
});

describe("detectSystemd — fail-open availability probe", () => {
  it("returns true when the injected check reports the binary present", () => {
    expect(detectSystemd(() => true)).toBe(true);
  });

  it("returns false when the injected check reports it absent", () => {
    expect(detectSystemd(() => false)).toBe(false);
  });

  it("FAILS OPEN on the REAL default probe: never throws, always a boolean (the `which` is try/caught)", () => {
    // No injected check → exercises the actual defaultCheck (execSync `which systemd-run`) AND its
    // try/catch — the path production hits. Host-agnostic on purpose: we do NOT assert true/false
    // (depends on whether systemd-run is on PATH), only that an ABSENT binary is swallowed into a
    // boolean instead of throwing up into the engine. This is the genuine graceful-degradation contract.
    resetSystemdCache();
    expect(() => detectSystemd()).not.toThrow();
    expect(typeof detectSystemd()).toBe("boolean");
    resetSystemdCache();
  });

  it("memoizes the real probe: a second no-arg call returns the cached result (no re-probe)", () => {
    resetSystemdCache();
    const first = detectSystemd();
    expect(detectSystemd()).toBe(first);
    resetSystemdCache();
  });
});

// ── Named-scope addressability + the guarded kill primitive (the deploy-during-run un-strand fix) ──

/** A recording fake SystemctlRun: logs every argv, returns scripted states for `is-active` and
 * scripted values for `show --property=InvocationID` (consumed in order, independently). */
function fakeSystemctl(states: string[] = [], invocations: string[] = []): { run: SystemctlRun; calls: string[][] } {
  const calls: string[][] = [];
  let si = 0;
  let ii = 0;
  const run: SystemctlRun = async (args) => {
    calls.push(args);
    if (args[0] === "is-active") return { code: 0, stdout: (states[si++] ?? "inactive") + "\n" };
    if (args[0] === "show") return { code: 0, stdout: (invocations[ii++] ?? "") + "\n" };
    return { code: 0, stdout: "" };
  };
  return { run, calls };
}

describe("runScopeUnit — addressable scope name, unique per invocation", () => {
  it("derives harness-run-<sessionId>.scope with no nonce (legacy 1-arg — recovery's fallback)", () => {
    expect(runScopeUnit("3f05137c-3e3a-4f88-a34b-e3463290a39e")).toBe(
      "harness-run-3f05137c-3e3a-4f88-a34b-e3463290a39e.scope",
    );
  });
  it("appends a per-invocation nonce so a RESUMED step never reuses the previous step's scope name", () => {
    const a = runScopeUnit("sess", "aaaa1111");
    const b = runScopeUnit("sess", "bbbb2222");
    expect(a).toBe("harness-run-sess-aaaa1111.scope");
    expect(b).toBe("harness-run-sess-bbbb2222.scope");
    expect(a).not.toBe(b); // same session, different scope → teardown of one can't cross-kill the other
    expect(isRunScopeUnit(a)).toBe(true); // still passes the never-kill-the-service guard
    expect(isRunScopeUnit(b)).toBe(true);
  });
});

describe("isRunScopeUnit — the never-kill-the-service security boundary", () => {
  it("accepts a real run scope", () => {
    expect(isRunScopeUnit("harness-run-3f05137c-3e3a-4f88-a34b-e3463290a39e.scope")).toBe(true);
  });
  it("REJECTS the AgileHarness service, the bare slice, empty, undefined, and arbitrary units", () => {
    for (const bad of [
      "storymap.service",
      "claude-runs.slice",
      "claude.slice",
      "",
      undefined,
      null,
      "harness-run-.scope", // empty id
      "something-harness-run-x.scope", // prefix not anchored
      "harness-run-x.service", // wrong suffix
      "-.scope",
    ]) {
      expect(isRunScopeUnit(bad as string)).toBe(false);
    }
  });
});

describe("buildScopePrefix / wrapWithScope — optional --unit naming (back-compatible)", () => {
  it("omits --unit when none is given (legacy 2-arg call unchanged)", () => {
    expect(buildScopePrefix("2G", 100)).not.toContain("--unit");
  });
  it("emits --unit=<name> when given", () => {
    expect(buildScopePrefix("2G", 100, "harness-run-abc.scope")).toContain("--unit=harness-run-abc.scope ");
  });
  it("wrapWithScope echoes the unit back (for the engine to persist verbatim) only when applied", () => {
    const on = wrapWithScope("claude -p x", "2G", 100, true, "harness-run-abc.scope");
    expect(on.applied).toBe(true);
    expect(on.unit).toBe("harness-run-abc.scope");
    expect(on.cmd).toContain("--unit=harness-run-abc.scope");
    const off = wrapWithScope("claude -p x", undefined, undefined, false, "harness-run-abc.scope");
    expect(off.applied).toBe(false);
    expect(off.unit).toBeUndefined();
  });
});

describe("stopRunScope — the SINGLE guarded scope-kill chokepoint", () => {
  it("SAFETY: an invalid/empty/service/slice unit runs ZERO systemctl commands (never broadens to a slice)", async () => {
    for (const bad of ["storymap.service", "claude-runs.slice", "", undefined]) {
      const { run, calls } = fakeSystemctl();
      const res = await stopRunScope(bad as string, run, { graceMs: 0 });
      expect(res.acted).toBe(false);
      expect(calls.length).toBe(0); // proves no `systemctl stop/kill` ever targets the service or a slice
    }
  });

  itPosix("graceful stop only when the scope is dead after the grace window (no SIGKILL)", async () => {
    const { run, calls } = fakeSystemctl(["inactive"]); // is-active → inactive after stop
    const res = await stopRunScope("harness-run-abc.scope", run, { graceMs: 0, sleep: async () => {} });
    expect(res.acted).toBe(true);
    expect(calls.some((c) => c[0] === "stop" && c[1] === "harness-run-abc.scope")).toBe(true);
    expect(calls.some((c) => c[0] === "kill")).toBe(false); // dead after stop → no escalation
  });

  itPosix("escalates to SIGKILL when the SAME activation is still alive after the grace (koieb3 reap)", async () => {
    // InvocationID identical before + after the grace ⇒ our scope, still up (SIGTERM-ignoring claude
    // or detached grandchildren keeping the cgroup alive) ⇒ reap the whole cgroup.
    const { run, calls } = fakeSystemctl(["active"], ["inv-1", "inv-1"]);
    const res = await stopRunScope("harness-run-abc.scope", run, { graceMs: 0, sleep: async () => {} });
    expect(res.reason).toBe("stopped");
    const kill = calls.find((c) => c[0] === "kill");
    expect(kill).toEqual(["kill", "--kill-whom=all", "-s", "SIGKILL", "harness-run-abc.scope"]);
  });

  itPosix("NEVER SIGKILLs when a DIFFERENT activation reused the name during the grace (story-olr777 guard)", async () => {
    // before-grace InvocationID inv-1 (our scope), after-grace inv-2 (a resumed step relaunched into
    // the same-named scope) ⇒ NOT ours ⇒ no SIGKILL. This is the exact root-cause collision guard.
    const { run, calls } = fakeSystemctl(["active"], ["inv-1", "inv-2"]);
    const res = await stopRunScope("harness-run-abc.scope", run, { graceMs: 0, sleep: async () => {} });
    expect(res.reason).toBe("skipped-foreign-activation");
    expect(calls.some((c) => c[0] === "kill")).toBe(false);
  });

  itPosix("NEVER SIGKILLs when our scope was already gone at capture time (empty before-InvocationID)", async () => {
    // Scope self-deactivated before capture (clean exit) ⇒ invocationBefore empty ⇒ even if a new run
    // is active after the grace we cannot prove it's ours ⇒ skip. Fail-safe toward never-kill.
    const { run, calls } = fakeSystemctl(["active"], ["", "inv-new"]);
    const res = await stopRunScope("harness-run-abc.scope", run, { graceMs: 0, sleep: async () => {} });
    expect(res.reason).toBe("skipped-foreign-activation");
    expect(calls.some((c) => c[0] === "kill")).toBe(false);
  });
});

describe("scopeInvocationId — the activation-identity probe (collision guard input)", () => {
  it("returns the trimmed InvocationID value from `systemctl show`", async () => {
    const { run, calls } = fakeSystemctl([], ["0735478284a8443c82227d0b1500f61c"]);
    expect(await scopeInvocationId("harness-run-abc.scope", run)).toBe("0735478284a8443c82227d0b1500f61c");
    expect(calls[0]).toEqual(["show", "harness-run-abc.scope", "--property=InvocationID", "--value"]);
  });
  it("returns empty string when the unit isn't loaded (probe throws / already collected)", async () => {
    const run: SystemctlRun = async () => {
      throw Object.assign(new Error("Unit not loaded"), { code: 1 });
    };
    expect(await scopeInvocationId("harness-run-gone.scope", run)).toBe("");
  });
});

describe("isRunScopeActive — probe the SCOPE, never the dead shell pid", () => {
  itPosix("true only when systemctl is-active prints exactly active", async () => {
    const { run } = fakeSystemctl(["active"]);
    expect(await isRunScopeActive("harness-run-abc.scope", run)).toBe(true);
  });
  it("false for any other state and for an unaddressable unit (fail-safe = dead)", async () => {
    const { run } = fakeSystemctl(["failed"]);
    expect(await isRunScopeActive("harness-run-abc.scope", run)).toBe(false);
    expect(await isRunScopeActive("storymap.service", run)).toBe(false); // never probes the service
  });
});
