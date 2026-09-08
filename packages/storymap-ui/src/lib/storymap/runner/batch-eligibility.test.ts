import { describe, expect, it } from "vitest";
import { checkBatchEligibility, DEFAULT_MAX_GROUP_SIZE, type BatchCandidate } from "./batch-eligibility";

const c = (over: Partial<BatchCandidate>): BatchCandidate => ({
  key: over.key ?? `storymap/${over.cardId ?? "x"}`,
  board: "storymap",
  cardId: "x",
  status: "desenvolver",
  trigger: "harness-do",
  isCode: true,
  batchable: true,
  toolkitMounts: ["storymap/graphify/storymap.json"],
  ...over,
});

describe("checkBatchEligibility (WS7) — all-or-nothing group admission with named violations", () => {
  it("a clean 2-card group of the same batchable code step is eligible", () => {
    const r = checkBatchEligibility([c({ cardId: "a", key: "storymap/a" }), c({ cardId: "b", key: "storymap/b" })]);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("a group of 1 is NOT a group", () => {
    expect(checkBatchEligibility([c({ cardId: "a" })]).ok).toBe(false);
  });

  it("rejects cross-board", () => {
    const r = checkBatchEligibility([c({ cardId: "a", key: "storymap/a" }), c({ cardId: "b", key: "nimbus/b", board: "nimbus" })]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/boards diferentes/);
  });

  it("rejects a mixed status / trigger", () => {
    const r = checkBatchEligibility([c({ cardId: "a", key: "storymap/a" }), c({ cardId: "b", key: "storymap/b", status: "revisar-codigo", trigger: "harness-review" })]);
    expect(r.violations.join(" ")).toMatch(/status diferentes|triggers diferentes/);
  });

  it("rejects a non-batchable or non-code trigger (named per card)", () => {
    const r = checkBatchEligibility([
      c({ cardId: "a", key: "storymap/a" }),
      c({ cardId: "b", key: "storymap/b", batchable: false, trigger: "harness-review" }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/b: o trigger/);
  });

  it("rejects a differing resolved toolkit", () => {
    const r = checkBatchEligibility([
      c({ cardId: "a", key: "storymap/a", toolkitMounts: ["m1.json"] }),
      c({ cardId: "b", key: "storymap/b", toolkitMounts: ["m2.json"] }),
    ]);
    expect(r.violations.join(" ")).toMatch(/toolkit resolvido difere/);
  });

  it("toolkit order does not matter (order-insensitive signature)", () => {
    const r = checkBatchEligibility([
      c({ cardId: "a", key: "storymap/a", toolkitMounts: ["m1.json", "m2.json"] }),
      c({ cardId: "b", key: "storymap/b", toolkitMounts: ["m2.json", "m1.json"] }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("rejects an intra-group depends-on (sequence, not group)", () => {
    const r = checkBatchEligibility(
      [c({ cardId: "a", key: "storymap/a" }), c({ cardId: "b", key: "storymap/b" })],
      [{ from: "storymap/a", to: "storymap/b" }],
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/dependência interna/);
  });

  it("enforces the group-size cap", () => {
    const many = Array.from({ length: DEFAULT_MAX_GROUP_SIZE + 1 }, (_, i) => c({ cardId: `c${i}`, key: `storymap/c${i}` }));
    expect(checkBatchEligibility(many).violations.join(" ")).toMatch(/teto de/);
  });
});
