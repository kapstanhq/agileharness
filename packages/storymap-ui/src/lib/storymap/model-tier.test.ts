import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { coerceSessionModel } from "./repo";
import { MODEL_TIERS, RETIRED_MODEL_TIERS, SESSION_MODELS, coerceModelTier } from "./types";

describe("model tiers — only sonnet and opus (owner decision 2026-10-01)", () => {
  it("MODEL_TIERS is sonnet then opus (capability order) and has no haiku", () => {
    expect([...MODEL_TIERS]).toEqual(["sonnet", "opus"]);
  });

  it("a session can ask for a tier or its 1M variant, never haiku", () => {
    expect([...SESSION_MODELS]).toEqual(["sonnet", "opus", "sonnet[1m]", "opus[1m]"]);
  });
});

describe("coerceModelTier — what an old file may still hold", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("keeps a known tier as is", () => {
    expect(coerceModelTier("sonnet")).toBe("sonnet");
    expect(coerceModelTier("opus")).toBe("opus");
  });

  it("reads a retired tier as its successor instead of dropping it (a dropped cap would mean NO cap)", () => {
    expect(RETIRED_MODEL_TIERS.haiku).toBe("sonnet");
    expect(coerceModelTier("haiku")).toBe("sonnet");
  });

  it("drops what was never a tier — including names that merely look like object keys", () => {
    for (const v of ["gpt", "", "opus[1m]", "constructor", "__proto__", "toString", undefined, null, 3]) {
      expect(coerceModelTier(v)).toBeUndefined();
    }
  });
});

describe("coerceSessionModel — the model of a conductor / claude_new session", () => {
  it("keeps a known session model, with or without the long-context suffix", () => {
    for (const m of SESSION_MODELS) expect(coerceSessionModel(m)).toBe(m);
  });

  // Dropping it would fall back to the conductor default (opus): the most expensive tier, the opposite of the intent.
  it("reads a retired tier as its successor and KEEPS the [1m] suffix", () => {
    expect(coerceSessionModel("haiku")).toBe("sonnet");
    expect(coerceSessionModel("haiku[1m]")).toBe("sonnet[1m]");
  });

  it("returns undefined for anything else (the default applies)", () => {
    for (const v of ["gpt", "opus[2m]", "[1m]", "", 3, null, undefined]) expect(coerceSessionModel(v)).toBeUndefined();
  });
});
