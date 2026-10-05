import { describe, expect, it } from "vitest";
import { STORY_TYPE_BY_ID, narrativeSentence, narrativeWhy, opensWithConnector } from "./frameworks";

// A frase da narrativa: o conector do tipo só entra quando a parte guarda o MIOLO. Uma parte que já traz o
// próprio conector (ou o de outro tipo) fala por si — nunca «Para viabilizar Como…, precisamos quero…».

const USER = STORY_TYPE_BY_ID.user.connectors;
const TECH = STORY_TYPE_BY_ID.technical.connectors;

describe("narrativeSentence", () => {
  it("miolo puro ⇒ conector do tipo + vírgulas + ponto final", () => {
    expect(narrativeSentence(USER, { role: "leitor da livraria", want: "reservar um livro", soThat: "buscar no balcão" })).toBe(
      "Como leitor da livraria, quero reservar um livro, para buscar no balcão.",
    );
    expect(narrativeSentence(TECH, { role: "a fila de pedidos", want: "um índice novo", soThat: "a busca responda em 1 s" })).toBe(
      "Para viabilizar a fila de pedidos, precisamos um índice novo, de modo que a busca responda em 1 s.",
    );
  });

  it("partes que já trazem conector (de qualquer tipo) não ganham o conector do tipo de novo", () => {
    expect(
      narrativeSentence(TECH, { role: "Como dono da oficina", want: "quero recusar pedidos sem peça", soThat: "para que o estoque não minta" }),
    ).toBe("Como dono da oficina, quero recusar pedidos sem peça, para que o estoque não minta.");
    expect(narrativeSentence(USER, { role: "leitor", want: "quero ver o prazo", soThat: "de modo que eu planeje" })).toBe(
      "Como leitor, quero ver o prazo, de modo que eu planeje.",
    );
  });

  it("parte ausente some sem deixar vírgula sobrando; nenhuma parte ⇒ null; pontuação final não dobra", () => {
    expect(narrativeSentence(USER, { role: null, want: "reservar", soThat: null })).toBe("Quero reservar.");
    expect(narrativeSentence(USER, {})).toBeNull();
    expect(narrativeSentence(USER, { role: "leitor.", want: "reservar,", soThat: "buscar." })).toBe("Como leitor, quero reservar, para buscar.");
  });

  it("conector só vale como palavra inteira («paralelo» não é «para»; «comando» não é «como»)", () => {
    expect(opensWithConnector("paralelo de filas")).toBe(false);
    expect(opensWithConnector("comando novo")).toBe(false);
    expect(opensWithConnector("Para que o leitor saiba")).toBe(true);
    expect(narrativeSentence(USER, { role: "comprador", want: "comando de voz", soThat: "paralelo ao carrinho" })).toBe(
      "Como comprador, quero comando de voz, para paralelo ao carrinho.",
    );
  });
});

describe("narrativeWhy", () => {
  it("o porquê com o conector certo, sem repetir", () => {
    expect(narrativeWhy(USER, "buscar no balcão")).toBe("para buscar no balcão");
    expect(narrativeWhy(TECH, "para que a busca seja rápida")).toBe("para que a busca seja rápida");
    expect(narrativeWhy(USER, "  ")).toBeNull();
  });
});
