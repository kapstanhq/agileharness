import { describe, expect, it } from "vitest";
import { linkCardIds } from "./card-links";

// Os ids de card na resposta do Jido viram o TÍTULO do card (link para a página dele) — só os conhecidos, nunca dentro
// de código, de link ou de URL. Fixtures inventadas, no vocabulário da livraria de demonstração.
const titles = new Map([
  ["story-ex9001", "Buscar por título ou autor"],
  ["story-ex9002", "Ver a ficha do livro"],
  ["story-ex9003", "Lista [rascunho] de desejos"],
]);
const href = (id: string) => `/board/demo/card/${id}`;
const link = (s: string) => linkCardIds(s, titles, href);

describe("linkCardIds", () => {
  it("troca o id solto na prosa pelo título, como link", () => {
    expect(link("story-ex9001 está em Desenvolver.")).toBe("[Buscar por título ou autor](/board/demo/card/story-ex9001) está em Desenvolver.");
    expect(link("- **story-ex9002** em Pronto p/ dev")).toBe("- **[Ver a ficha do livro](/board/demo/card/story-ex9002)** em Pronto p/ dev");
    expect(link("trava (story-ex9001), veja")).toBe("trava ([Buscar por título ou autor](/board/demo/card/story-ex9001)), veja");
  });

  it("o «chip» de código que é SÓ o id também vira o link", () => {
    expect(link("o card `story-ex9002` parou")).toBe("o card [Ver a ficha do livro](/board/demo/card/story-ex9002) parou");
  });

  it("id desconhecido fica intacto (nunca adivinha)", () => {
    expect(link("story-ex9999 e story-ex9001-b seguem")).toBe("story-ex9999 e story-ex9001-b seguem");
  });

  it("não mexe em código, em links nem em URLs", () => {
    const fenced = "```\nmove story-ex9001\n```";
    expect(link(fenced)).toBe(fenced);
    expect(link("rode `move story-ex9001 pronta`")).toBe("rode `move story-ex9001 pronta`");
    expect(link("[story-ex9001](/x)")).toBe("[story-ex9001](/x)");
    expect(link("[ver](story-ex9001)")).toBe("[ver](story-ex9001)");
    expect(link("abra /board/demo/card/story-ex9001 agora")).toBe("abra /board/demo/card/story-ex9001 agora");
  });

  it("escapa colchetes do título (o link não quebra)", () => {
    expect(link("story-ex9003")).toBe("[Lista \\[rascunho\\] de desejos](/board/demo/card/story-ex9003)");
  });

  it("sem títulos ou sem id, devolve o mesmo texto", () => {
    expect(linkCardIds("story-ex9001", new Map(), href)).toBe("story-ex9001");
    expect(link("nada aqui")).toBe("nada aqui");
  });
});
