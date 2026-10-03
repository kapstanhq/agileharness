import { describe, expect, it } from "vitest";
import { dejargonText, lensLabel } from "./dejargon";

describe("lensLabel", () => {
  it("traduz as lenses conhecidas para linguagem de produto", () => {
    expect(lensLabel("perf")).toBe("Performance");
    expect(lensLabel("firestore")).toBe("Regras de acesso (Firestore)");
    expect(lensLabel("security")).toBe("Segurança");
    expect(lensLabel("testing")).toBe("Testes");
    expect(lensLabel("nextjs")).toBe("Frontend (Next.js)");
    expect(lensLabel("general")).toBe("Revisão geral");
  });

  it("lens ausente ⇒ null (o chamador esconde o rótulo)", () => {
    expect(lensLabel(undefined)).toBeNull();
    expect(lensLabel(null)).toBeNull();
    expect(lensLabel("  ")).toBeNull();
  });

  it("lens desconhecida cai num Capitalize seguro (nunca some, nunca crua)", () => {
    expect(lensLabel("acessibilidade")).toBe("Acessibilidade");
  });
});

describe("dejargonText — limpador conservador de jargão", () => {
  it("troca rotas de skill conhecidas por frases de produto", () => {
    expect(dejargonText("rode /harness-review de novo")).toBe("rode a revisão de código de novo");
    expect(dejargonText("gerado por /harness-style")).toBe("gerado por o guia de estilo");
  });

  it("deixa INTACTA uma rota desconhecida (nunca adivinha)", () => {
    expect(dejargonText("veja /harness-inexistente aqui")).toBe("veja /harness-inexistente aqui");
  });

  it("texto sem jargão passa igual; vazio/ausente ⇒ ''", () => {
    expect(dejargonText("Contraste reprovado — ajuste as cores.")).toBe("Contraste reprovado — ajuste as cores.");
    expect(dejargonText("")).toBe("");
    expect(dejargonText(null)).toBe("");
    expect(dejargonText(undefined)).toBe("");
  });

  it("troca MÚLTIPLAS rotas na mesma frase", () => {
    expect(dejargonText("passou /harness-do e /harness-qa")).toBe("passou a implementação e o QA automatizado");
  });
});
