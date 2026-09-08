import { describe, expect, it } from "vitest";
import { parseWeeklyTokenWindow } from "./ccusage";

// Fixture shaped like real `ccusage weekly --json` (captured from the VPS): weeks keyed by
// their Monday `period`, with token + cost totals. The current week is the latest period.
const PRIOR = { period: "2026-05-25", totalTokens: 500_000_000, totalCost: 410, modelsUsed: ["claude-opus-4-8"] };
const CURRENT = {
  period: "2026-06-01",
  totalTokens: 381_395_624,
  totalCost: 293.08,
  modelsUsed: ["claude-opus-4-8", "claude-haiku-4-5-20251001"],
};

const NOW = Date.parse("2026-06-04T00:00:00Z"); // mid-week (Thu); resets 2026-06-08

describe("parseWeeklyTokenWindow", () => {
  it("picks the latest week and computes % used against the plan budget", () => {
    const w = parseWeeklyTokenWindow(JSON.stringify({ weekly: [PRIOR, CURRENT] }), NOW, 760_000_000);
    expect(w).not.toBeNull();
    expect(w!.source).toBe("ccusage");
    expect(w!.usedTokens).toBe(381_395_624);
    expect(w!.limitTokens).toBe(760_000_000);
    expect(w!.usedPct).toBe(50.2); // 381.4M / 760M — the "~50%" the user sees in /usage
    expect(w!.remainingPct).toBe(49.8);
    expect(w!.costUSD).toBe(293.08);
    expect(w!.resetsAt).toBe(Date.parse("2026-06-08T00:00:00Z")); // period + 7d
    expect(w!.resetsInMinutes).toBe(4 * 24 * 60); // 2026-06-04 → 2026-06-08
    expect(w!.models).toEqual(["claude-opus-4-8", "claude-haiku-4-5-20251001"]);
    // weekly carries no burn/projection
    expect(w!.burnTokensPerMin).toBeNull();
    expect(w!.willExceedBeforeReset).toBeNull();
  });

  it("leaves % null when no budget is known", () => {
    const w = parseWeeklyTokenWindow(JSON.stringify({ weekly: [CURRENT] }), NOW, null);
    expect(w!.limitTokens).toBeNull();
    expect(w!.usedPct).toBeNull();
    expect(w!.remainingPct).toBeNull();
    expect(w!.usedTokens).toBe(381_395_624); // raw usage still surfaced
  });

  it("clamps to 100% when usage exceeds the budget", () => {
    const over = { ...CURRENT, totalTokens: 900_000_000 };
    const w = parseWeeklyTokenWindow(JSON.stringify({ weekly: [over] }), NOW, 760_000_000);
    expect(w!.usedPct).toBe(100);
    expect(w!.remainingPct).toBe(0);
  });

  it("returns null on empty/malformed input", () => {
    expect(parseWeeklyTokenWindow(JSON.stringify({ weekly: [] }), NOW, 760_000_000)).toBeNull();
    expect(parseWeeklyTokenWindow("not json", NOW, 760_000_000)).toBeNull();
    expect(parseWeeklyTokenWindow(JSON.stringify({}), NOW, 760_000_000)).toBeNull();
  });
});
