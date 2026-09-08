import { describe, it, expect } from "vitest";
import { proposedTypeLabelText } from "./proposed-label";
import { STORY_TYPE_BY_ID } from "../frameworks";

describe("proposedTypeLabelText — chip de tipo no preview da captura", () => {
  it("idea → 'Ideia' (NÃO cai no rótulo de story)", () => {
    // regressão: uma ideia (storyType:null) caía no fall-through e virava "USER STORY".
    expect(proposedTypeLabelText({ type: "idea", storyType: null })).toBe("Ideia");
    expect(proposedTypeLabelText({ type: "idea" })).toBe("Ideia");
  });

  it("activity → 'Atividade', step → 'Step'", () => {
    expect(proposedTypeLabelText({ type: "activity" })).toBe("Atividade");
    expect(proposedTypeLabelText({ type: "step" })).toBe("Step");
  });

  it("story → o nome canônico do storyType (user por padrão)", () => {
    expect(proposedTypeLabelText({ type: "story", storyType: "user" })).toBe(STORY_TYPE_BY_ID["user"].name);
    expect(proposedTypeLabelText({ type: "story", storyType: "bug" })).toBe(STORY_TYPE_BY_ID["bug"].name);
    expect(proposedTypeLabelText({ type: "story", storyType: null })).toBe(STORY_TYPE_BY_ID["user"].name);
  });
});
