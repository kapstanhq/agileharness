import { describe, expect, it } from "vitest";
import { hopActorWords, hopNoteWords } from "@/lib/storymap/hop-words";

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

// fase 6 — quem moveu é o PAPEL gravado (mcp/actor.ts), nunca o rótulo cru: o condutor, a Sentinela, o revisor do serviço.
describe("hopActorWords", () => {
  it("o papel de cada agente em palavras; o legado `run:*` segue «agente»", () => {
    expect(hopActorWords("conductor:story-ex9101")).toBe("condutor");
    expect(hopActorWords("sentinel")).toBe("Sentinela");
    expect(hopActorWords("critic")).toBe("revisor independente");
    expect(hopActorWords("proxy")).toBe("procurador");
    expect(hopActorWords("external:claude-code")).toBe("agente de fora");
    expect(hopActorWords("run:orch")).toBe("agente");
    expect(hopActorWords("human")).toBe("você");
  });
});
