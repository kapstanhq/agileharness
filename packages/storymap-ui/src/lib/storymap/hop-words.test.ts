import { describe, expect, it } from "vitest";
import { hopNoteWords } from "@/lib/storymap/hop-words";

// O Trajeto do card fala com o dono: o código do motivo («merge:approved») vira palavras; o que a régua não conhece fica.
describe("hopNoteWords", () => {
  it("traduz os motivos conhecidos", () => {
    expect(hopNoteWords("merge:approved")).toBe("integração aprovada");
    expect(hopNoteWords("triage-judge:accept")).toBe("triagem aceito");
    expect(hopNoteWords("deploy:already-live")).toBe("publicação já estava no ar");
    expect(hopNoteWords("undo:inbox")).toBe("desfeito pelo Inbox");
  });

  it("detalhe desconhecido vai como está; tipo desconhecido não é tocado", () => {
    expect(hopNoteWords("merge:outra-coisa")).toBe("integração outra-coisa");
    expect(hopNoteWords("texto livre do motor")).toBe("texto livre do motor");
  });
});
