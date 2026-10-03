import { describe, expect, it } from "vitest";
import { parseWeeklyTokenWindow } from "./ccusage";

// Fixture shaped like the `ccusage weekly --json` output (invented values): weeks keyed by
// their Monday `period`, with token + cost totals. The current week is the latest period.
const PRIOR = { period: "2026-03-02", totalTokens: 310_000_000, totalCost: 187.2, modelsUsed: ["claude-opus-4-8"] };
const CURRENT = {
  period: "2026-03-09",
  totalTokens: 212_480_000,
  totalCost: 118.4,
  modelsUsed: ["claude-opus-4-8", "claude-sonnet-4-6"],
};

const NOW = Date.parse("2026-03-12T00:00:00Z"); // mid-week (Thu); resets 2026-03-16

describe("parseWeeklyTokenWindow", () => {
  it("picks the latest week and computes % used against the plan budget", () => {
    const w = parseWeeklyTokenWindow(JSON.stringify({ weekly: [PRIOR, CURRENT] }), NOW, 500_000_000);
    expect(w).not.toBeNull();
    expect(w!.source).toBe("ccusage");
    expect(w!.usedTokens).toBe(212_480_000);
    expect(w!.limitTokens).toBe(500_000_000);
    expect(w!.usedPct).toBe(42.5); // 212.5M / 500M
    expect(w!.remainingPct).toBe(57.5);
    expect(w!.costUSD).toBe(118.4);
    expect(w!.resetsAt).toBe(Date.parse("2026-03-16T00:00:00Z")); // period + 7d
    expect(w!.resetsInMinutes).toBe(4 * 24 * 60); // 2026-03-12 → 2026-03-16
    expect(w!.models).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
    // weekly carries no burn/projection
    expect(w!.burnTokensPerMin).toBeNull();
    expect(w!.willExceedBeforeReset).toBeNull();
  });

  it("leaves % null when no budget is known", () => {
    const w = parseWeeklyTokenWindow(JSON.stringify({ weekly: [CURRENT] }), NOW, null);
    expect(w!.limitTokens).toBeNull();
    expect(w!.usedPct).toBeNull();
    expect(w!.remainingPct).toBeNull();
    expect(w!.usedTokens).toBe(212_480_000); // raw usage still surfaced
  });

  it("clamps to 100% when usage exceeds the budget", () => {
    const over = { ...CURRENT, totalTokens: 700_000_000 };
    const w = parseWeeklyTokenWindow(JSON.stringify({ weekly: [over] }), NOW, 500_000_000);
    expect(w!.usedPct).toBe(100);
    expect(w!.remainingPct).toBe(0);
  });

  it("returns null on empty/malformed input", () => {
    expect(parseWeeklyTokenWindow(JSON.stringify({ weekly: [] }), NOW, 500_000_000)).toBeNull();
    expect(parseWeeklyTokenWindow("not json", NOW, 500_000_000)).toBeNull();
    expect(parseWeeklyTokenWindow(JSON.stringify({}), NOW, 500_000_000)).toBeNull();
  });
});
