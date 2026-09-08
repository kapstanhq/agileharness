import { describe, expect, it, vi } from "vitest";
import { attributeWithRetry, type GateFailure } from "./merge-queue";
import { withFlakyTestFinding, flakyTestFindingId } from "./findings";

const f = (file: string, name: string): GateFailure => ({ file, name, message: "boom" });
const key = (x: GateFailure) => `${x.file}::${x.name}`;

describe("attributeWithRetry (WS1.3) — flaky quarantine on the merge gate", () => {
  it("no NEW failures (all pre-exist on main) → pass, NO retry (a red main never reproves the card)", async () => {
    const rerun = vi.fn();
    const d = await attributeWithRetry({
      mergedFailures: [f("a.test.ts", "x")],
      baseKeys: new Set(["a.test.ts::x"]),
      retryEnabled: true,
      rerun,
    });
    expect(d.verdict).toBe("pass");
    expect(d.flaky).toBeUndefined();
    expect(rerun).not.toHaveBeenCalled(); // a base(main) failure NEVER triggers a retry
  });

  it("new failure that DOESN'T reproduce on the full-suite retry → pass + flaky recorded", async () => {
    const rerun = vi.fn(async () => ({ ok: true, failures: [] as GateFailure[] })); // retry green
    const d = await attributeWithRetry({
      mergedFailures: [f("a.test.ts", "flaky")],
      baseKeys: new Set(),
      retryEnabled: true,
      rerun,
    });
    expect(d.verdict).toBe("pass");
    expect(d.flaky?.map(key)).toEqual(["a.test.ts::flaky"]);
    expect(rerun).toHaveBeenCalledOnce();
  });

  it("new failure that STILL reproduces on retry → park with the reproduced set", async () => {
    const rerun = vi.fn(async () => ({ ok: false, failures: [f("a.test.ts", "real")] }));
    const d = await attributeWithRetry({
      mergedFailures: [f("a.test.ts", "real")],
      baseKeys: new Set(),
      retryEnabled: true,
      rerun,
    });
    expect(d.verdict).toBe("park");
    expect(d.newFailures.map(key)).toEqual(["a.test.ts::real"]);
    expect(d.flaky).toBeUndefined();
  });

  it("retry surfaces a DIFFERENT still-new failure → park; the base(main) reds stay excluded on the retry too", async () => {
    const rerun = vi.fn(async () => ({ ok: false, failures: [f("b.test.ts", "other-new"), f("pre.test.ts", "existing")] }));
    const d = await attributeWithRetry({
      mergedFailures: [f("a.test.ts", "gone")],
      baseKeys: new Set(["pre.test.ts::existing"]),
      retryEnabled: true,
      rerun,
    });
    expect(d.verdict).toBe("park");
    expect(d.newFailures.map(key)).toEqual(["b.test.ts::other-new"]); // pre-existing excluded again
  });

  it("a CRASHED/OOM/timed-out retry (ok:false, NO parseable failures) → PARK, never flaky (fail-CLOSED)", async () => {
    // The bug this guards: an unparseable retry (crash → failures:[]) MUST NOT be read as flaky-green and
    // integrate genuinely-broken code. Also covers a failed `git reset --hard mergedSha` (same sentinel).
    const rerun = vi.fn(async () => ({ ok: false, failures: [] as GateFailure[] }));
    const d = await attributeWithRetry({
      mergedFailures: [f("a.test.ts", "real")],
      baseKeys: new Set(),
      retryEnabled: true,
      rerun,
    });
    expect(d.verdict).toBe("park");
    expect(d.newFailures.map(key)).toEqual(["a.test.ts::real"]); // the ORIGINAL new set, not masked as flaky
    expect(d.flaky).toBeUndefined();
  });

  it("retry DISABLED → park immediately on a new failure (rerun never called)", async () => {
    const rerun = vi.fn();
    const d = await attributeWithRetry({
      mergedFailures: [f("a.test.ts", "x")],
      baseKeys: new Set(),
      retryEnabled: false,
      rerun,
    });
    expect(d.verdict).toBe("park");
    expect(rerun).not.toHaveBeenCalled();
  });
});

describe("withFlakyTestFinding (WS1.3) — advisory, never a gate", () => {
  it("stamps a LOW (never blocker) finding naming the flaky tests, upserted by run id", () => {
    const ids = ["a.test.ts::x", "b.test.ts::y"];
    const once = withFlakyTestFinding([], "run-1", ids);
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ id: flakyTestFindingId("run-1"), severity: "low", lens: "testing", status: "open" });
    expect(once[0].severity).not.toBe("blocker"); // must gate nothing
    expect(once[0].detail).toContain("a.test.ts::x");
    // idempotent by id — a re-fire refreshes, never stacks
    const twice = withFlakyTestFinding(once, "run-1", ids);
    expect(twice.filter((x) => x.id === flakyTestFindingId("run-1"))).toHaveLength(1);
  });
});
