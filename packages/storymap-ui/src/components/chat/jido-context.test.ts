// O contexto da conversa aberta a partir de uma FUNCIONALIDADE do PRD (fase 7 — «Pedir item novo» na página dela):
// o chip diz o nome, e o texto que vai ao Jido nomeia a funcionalidade com o id que o `create_card` grava no item novo.
// Fixtures INVENTADAS no vocabulário da livraria de demonstração.

import { describe, expect, it } from "vitest";
import { cardChipLabel, featureChipContext, withCardContext, withFeatureContext } from "./jido-context";

describe("a funcionalidade em contexto", () => {
  const carrinho = { id: "carrinho", title: "Carrinho de compras" };

  it("o texto nomeia a funcionalidade e leva o id", () => {
    expect(withFeatureContext(carrinho, "Quero um item novo em «Carrinho de compras»: cupom de frete")).toBe(
      "Sobre a funcionalidade «Carrinho de compras» (feature: carrinho): Quero um item novo em «Carrinho de compras»: cupom de frete",
    );
    expect(withFeatureContext({ id: "carrinho", title: " " }, "oi")).toBe("Sobre a funcionalidade (feature: carrinho): oi");
    expect(withFeatureContext(null, "oi")).toBe("oi");
    expect(withFeatureContext(carrinho, "   ")).toBe("");
  });

  it("no compositor, a funcionalidade vai pelo mesmo estado do card: o chip diz o nome, o envio diz «funcionalidade»", () => {
    const ctx = featureChipContext(carrinho);
    expect(cardChipLabel(ctx)).toBe("Carrinho de compras");
    expect(withCardContext(ctx, "Como está?")).toBe("Sobre a funcionalidade «Carrinho de compras» (feature: carrinho): Como está?");
    // um card continua sendo um card
    expect(withCardContext({ id: "story-ex9951", title: "Frete por CEP" }, "Como está?")).toBe("Sobre o card «Frete por CEP» (story-ex9951): Como está?");
  });
});
