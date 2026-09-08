import { describe, expect, it } from "vitest";
import { deriveEstiloState } from "./derive-estilo-state";
import { coerceStyleGuideDoc } from "./style-guide";

const NON_EMPTY_GUIDE = coerceStyleGuideDoc({
  identity: { school: "editorial urbano", personality: ["direto"], prose: "" },
  color: { tokens: [{ role: "primary", value: "#FF4F00", on: "#FFFFFF", usage: "cta" }] },
});

describe("deriveEstiloState — the 2-state truth table (plain source-of-truth guide)", () => {
  it("vazio — no guide", () => {
    expect(deriveEstiloState({ styleGuide: null, hasPublishedGuide: false })).toEqual({ kind: "vazio" });
  });

  it("vazio — guide present but the caller marked it EMPTY (hasPublishedGuide:false)", () => {
    const empty = coerceStyleGuideDoc(null);
    expect(deriveEstiloState({ styleGuide: empty, hasPublishedGuide: false })).toEqual({ kind: "vazio" });
  });

  it("vazio — even a non-empty doc renders 'vazio' if the caller says hasPublishedGuide:false (trusts the caller)", () => {
    expect(deriveEstiloState({ styleGuide: NON_EMPTY_GUIDE, hasPublishedGuide: false })).toEqual({ kind: "vazio" });
  });

  it("publicado — guide non-empty + hasPublishedGuide:true", () => {
    const state = deriveEstiloState({ styleGuide: NON_EMPTY_GUIDE, hasPublishedGuide: true });
    expect(state).toEqual({ kind: "publicado", styleGuide: NON_EMPTY_GUIDE });
  });
});
