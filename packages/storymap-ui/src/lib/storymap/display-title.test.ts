import { describe, expect, it } from "vitest";
import { displayTitle, nameCardIds, shortTitle } from "./display-title";

describe("displayTitle — a etiqueta de máquina sai da tela, o título gravado fica", () => {
  it("tira UMA etiqueta do começo quando sobra texto", () => {
    expect(displayTitle("[gc:arquivos-sem-uso:src/util/velho.ts] Apagar o arquivo velho.ts")).toBe("Apagar o arquivo velho.ts");
    expect(displayTitle("[saude:S7] Fila do condutor parada")).toBe("Fila do condutor parada");
    expect(displayTitle("[sinal:agenda:livraria-aurora:vazia] Livraria Aurora com a agenda vazia")).toBe("Livraria Aurora com a agenda vazia");
    // só a primeira
    expect(displayTitle("[a:1] [b:2] Texto")).toBe("[b:2] Texto");
  });
  it("não mexe no que não é etiqueta de máquina", () => {
    expect(displayTitle("Ver as receitas da semana")).toBe("Ver as receitas da semana");
    // colchete com espaço dentro é texto de gente
    expect(displayTitle("[Importante para hoje] Revisar a capa")).toBe("[Importante para hoje] Revisar a capa");
    // colchete no meio
    expect(displayTitle("Revisar [a capa]")).toBe("Revisar [a capa]");
    // sem espaço depois da etiqueta não é etiqueta
    expect(displayTitle("[x:1]colado")).toBe("[x:1]colado");
  });
  it("etiqueta sem texto depois: o título como está (nunca um título vazio)", () => {
    expect(displayTitle("[saude:S7]")).toBe("[saude:S7]");
    expect(displayTitle("[saude:S7]   ")).toBe("[saude:S7]   ");
    expect(displayTitle("")).toBe("");
  });
});

describe("shortTitle", () => {
  it("curto fica inteiro; longo corta numa palavra, com «…»", () => {
    expect(shortTitle("[x:1] Ver receitas")).toBe("Ver receitas");
    const t = shortTitle("Uma frase bem comprida que passa do limite de caracteres da conta", 30);
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(31);
    expect(t).toBe("Uma frase bem comprida que…");
  });
});

describe("nameCardIds — o dono lê o nome do item, não o id", () => {
  const cards = [
    { id: "story-ex9101", title: "Ver as receitas da semana" },
    { id: "story-ex9102", title: "[saude:S1] Guardar o rascunho" },
  ];
  it("troca o id inteiro e o sufixo pelo título curto entre «»", () => {
    expect(nameCardIds("Ancora de story-ex9101 e ex9102 — não arquive.", cards)).toBe(
      "Ancora de «Ver as receitas da semana» e «Guardar o rascunho» — não arquive.",
    );
    expect(nameCardIds("EX9101, ex9102", cards)).toBe("«Ver as receitas da semana», «Guardar o rascunho»");
  });
  it("não toca pedaço de palavra, caminho, nem id desconhecido", () => {
    expect(nameCardIds("src/ex9101/a.ts e xex9101 e story-ex9999", cards)).toBe("src/ex9101/a.ts e xex9101 e story-ex9999");
    expect(nameCardIds("sem id nenhum", cards)).toBe("sem id nenhum");
    expect(nameCardIds("ex9101", [])).toBe("ex9101");
  });
  it("sufixo curto demais (menos de 5) não casa", () => {
    expect(nameCardIds("abc apareceu", [{ id: "story-abc", title: "X" }])).toBe("abc apareceu");
    expect(nameCardIds("story-abc apareceu", [{ id: "story-abc", title: "X" }])).toBe("«X» apareceu");
  });
});
