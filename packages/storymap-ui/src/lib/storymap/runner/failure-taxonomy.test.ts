import { describe, it, expect } from "vitest";
import { classifyFailure } from "./findings";

// ADR-063 (4d) — the deterministic failure taxonomy. The classifier is a PURE function of observable
// signals; these cases pin the boundary against RunOutcome (process death) and the review `lens`.
describe("ADR-063 (4d) classifyFailure — infra/test/app auto-attribution", () => {
  it("attributes env/stack breakage to infra (the card is NOT at fault)", () => {
    for (const message of [
      "Error: Cannot find module 'firebase-functions'",
      "code: MODULE_NOT_FOUND",
      "? Enter a string value for WHATSAPP_QUARTZ_PHONE_NUMBER_ID:",
      "listen EADDRINUSE: address already in use :::3008",
      "FATAL ERROR: JavaScript heap out of memory",
      "spawn firebase ENOENT",
      "Error: could not start the firebase emulator suite",
    ]) {
      expect(classifyFailure({ message })).toBe("infra");
    }
  });

  it("attributes a bad spec/selector — or a criterion that passes at another layer — to test", () => {
    expect(classifyFailure({ message: "locator.click: Timeout 30000ms exceeded waiting for selector" })).toBe("test");
    expect(classifyFailure({ message: "strict mode violation: getByRole('button') resolved to 3 elements" })).toBe("test");
    expect(classifyFailure({ passedAtOtherLayer: true, message: "expected true to be false" })).toBe("test");
  });

  it("attributes a genuine criterion miss to app", () => {
    expect(classifyFailure({ criterionUnmet: true })).toBe("app");
    // a plain product assertion with none of the infra/test signals → the app didn't meet the criterion
    expect(classifyFailure({ message: "expected 'Salvar' to be visible but it was not" })).toBe("app");
  });

  it("resolves most-specific-first: infra wins when signals collide", () => {
    expect(
      classifyFailure({ message: "MODULE_NOT_FOUND thrown while waiting for selector", passedAtOtherLayer: true }),
    ).toBe("infra");
  });

  it("returns undefined with no signal (stays sparse — never invents a class)", () => {
    expect(classifyFailure({})).toBeUndefined();
    expect(classifyFailure({ message: "" })).toBeUndefined();
    expect(classifyFailure({ message: null })).toBeUndefined();
  });
});
