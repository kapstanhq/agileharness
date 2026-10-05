import { describe, expect, it } from "vitest";
import { modelWords } from "./model-words";

describe("modelWords", () => {
  it("nome técnico do modelo em palavras; o desconhecido fica como está", () => {
    expect(modelWords("opus[1m]")).toBe("Opus (contexto longo)");
    expect(modelWords("sonnet")).toBe("Sonnet");
    expect(modelWords("modelo-x")).toBe("modelo-x");
  });
});
