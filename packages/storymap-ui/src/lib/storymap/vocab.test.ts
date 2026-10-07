// vocab — o que uma persona/sistema diz de si (subtítulo, primeira frase do prompt) e a dobra de texto da
// busca. A listagem de Personas & Sistemas saiu na fase 2; estas derivações seguem vivas na escrita do agente
// (`vocab-actions.ts`) e no filtro do Kanban.

import { describe, expect, it } from "vitest";
import type { Persona, SystemDef } from "./types";
import { firstLine, foldText, vocabSubtitle } from "./vocab";

const persona = (over: Partial<Persona> & { id: string; name: string }): Persona => ({
  color: "#b5651d",
  ...over,
});

const system = (over: Partial<SystemDef> & { id: string; name: string }): SystemDef => ({
  color: "#2f7f86",
  ...over,
});

describe("firstLine", () => {
  it("descasca cabeçalho, citação, marcador e negrito", () => {
    expect(firstLine("## Contexto\n\ntexto")).toBe("Contexto");
    expect(firstLine("> _arquiteto · 2026-08-01_")).toBe("_arquiteto · 2026-08-01_");
    expect(firstLine("- [ ] fazer algo")).toBe("fazer algo");
    expect(firstLine("Quem lê é o **Leitor Assíduo** — três livros por mês.")).toBe(
      "Quem lê é o Leitor Assíduo — três livros por mês.",
    );
  });

  it("pula linhas em branco e devolve string vazia quando não há nada", () => {
    expect(firstLine("\n\n\n  \n\nprimeira")).toBe("primeira");
    expect(firstLine("")).toBe("");
    expect(firstLine(undefined)).toBe("");
  });
});

describe("vocabSubtitle", () => {
  it("prefere o campo DECLARADO ao primeiro parágrafo do prompt", () => {
    const p = persona({ id: "a", name: "A", role: "Leitor de ficção, 30–50", prompt: "Você é a A." });
    expect(vocabSubtitle(p, "persona")).toBe("Leitor de ficção, 30–50");
  });

  it("cai na primeira frase do prompt quando não há campo declarado", () => {
    const s = system({ id: "vitrine", name: "Vitrine", prompt: "## O que detém\n\nO catálogo é a interface." });
    expect(vocabSubtitle(s, "system")).toBe("O que detém");
  });

  it("devolve vazio para uma linha sem nada escrito", () => {
    expect(vocabSubtitle(persona({ id: "x", name: "X" }), "persona")).toBe("");
  });
});

describe("foldText", () => {
  it("tira acento e caixa — a busca de um board PT-BR não pode exigir o til certo", () => {
    expect(foldText("Serviço")).toBe("servico");
    expect(foldText("ASSÍDUO")).toBe("assiduo");
  });
});
