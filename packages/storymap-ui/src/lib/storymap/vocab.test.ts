// vocab — as derivações da tela de Personas & Sistemas. São puras de propósito: a ordem dos grupos, o
// que a busca alcança e o que a linha diz de si eram regras enterradas no JSX, onde nada disto podia
// ser afirmado sem montar React.

import { describe, expect, it } from "vitest";
import type { Persona, SystemDef } from "./types";
import {
  firstLine,
  foldText,
  groupVocab,
  matchesVocabQuery,
  toVocabRow,
  UNTYPED_GROUP_LABEL,
  vocabSubtitle,
  vocabSummary,
} from "./vocab";

const persona = (over: Partial<Persona> & { id: string; name: string }): Persona => ({
  color: "#7e9ac2",
  ...over,
});

const system = (over: Partial<SystemDef> & { id: string; name: string }): SystemDef => ({
  color: "#4FA873",
  ...over,
});

describe("firstLine", () => {
  it("descasca cabeçalho, citação, marcador e negrito", () => {
    expect(firstLine("## Contexto\n\ntexto")).toBe("Contexto");
    expect(firstLine("> _arquiteto · 2026-08-01_")).toBe("_arquiteto · 2026-08-01_");
    expect(firstLine("- [ ] fazer algo")).toBe("fazer algo");
    expect(firstLine("Você é o **Curioso Cultural** — adulto urbano.")).toBe(
      "Você é o Curioso Cultural — adulto urbano.",
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
    const p = persona({ id: "a", name: "A", role: "Adulto urbano, 28–45", prompt: "Você é a A." });
    expect(vocabSubtitle(p, "persona")).toBe("Adulto urbano, 28–45");
  });

  it("cai na primeira frase do prompt quando não há campo declarado", () => {
    const s = system({ id: "wa", name: "WhatsApp", prompt: "## O que detém\n\nA conversa é a interface." });
    expect(vocabSubtitle(s, "system")).toBe("O que detém");
  });

  it("devolve vazio para uma linha sem nada escrito", () => {
    expect(vocabSubtitle(persona({ id: "x", name: "X" }), "persona")).toBe("");
  });
});

describe("matchesVocabQuery", () => {
  const row = toVocabRow(
    persona({ id: "curioso-cultural", name: "Curioso Cultural", kind: "Segmento de mercado", role: "Adulto urbano" }),
    "persona",
    3,
  );

  it("busca sem acento e sem caixa", () => {
    expect(matchesVocabQuery(row, "", "CURIOSO")).toBe(true);
    expect(matchesVocabQuery(row, "", "cultural")).toBe(true);
    expect(matchesVocabQuery(row, "", "segmento")).toBe(true);
    expect(foldText("Serviço")).toBe("servico");
  });

  it("alcança o PROMPT, que é onde mora o conteúdo de verdade", () => {
    expect(matchesVocabQuery(row, "medo de errar a noite", "medo de errar")).toBe(true);
    expect(matchesVocabQuery(row, "", "medo de errar")).toBe(false);
  });

  it("exige TODOS os termos (E, não OU) e passa tudo com termo vazio", () => {
    expect(matchesVocabQuery(row, "", "curioso urbano")).toBe(true);
    expect(matchesVocabQuery(row, "", "curioso inexistente")).toBe(false);
    expect(matchesVocabQuery(row, "", "   ")).toBe(true);
  });
});

describe("groupVocab", () => {
  it("ordena pelos tipos SUGERIDOS, depois os inventados em ordem, e 'sem tipo' por ÚLTIMO", () => {
    const rows = [
      toVocabRow(system({ id: "livre", name: "Livre", kind: "Observabilidade" }), "system", 0),
      toVocabRow(system({ id: "sem", name: "Sem" }), "system", 0),
      toVocabRow(system({ id: "svc", name: "Busca", kind: "Serviço" }), "system", 0),
      toVocabRow(system({ id: "wa", name: "WhatsApp", kind: "Canal" }), "system", 0),
    ];
    expect(groupVocab(rows, "system").map((g) => g.label)).toEqual([
      "Canal",
      "Serviço",
      "Observabilidade",
      UNTYPED_GROUP_LABEL,
    ]);
  });

  it("o grupo sem tipo carrega um convite a classificar, não uma nota descritiva", () => {
    const [g] = groupVocab([toVocabRow(persona({ id: "x", name: "X" }), "persona", 0)], "persona");
    expect(g.key).toBe("");
    expect(g.note).toContain("defina o tipo");
  });

  it("a persona agrupa pelo MESMO campo que o sistema", () => {
    const rows = [
      toVocabRow(persona({ id: "op", name: "Operador", kind: "Interna" }), "persona", 1),
      toVocabRow(persona({ id: "cur", name: "Curioso", kind: "Segmento de mercado" }), "persona", 9),
    ];
    const groups = groupVocab(rows, "persona");
    expect(groups.map((g) => g.label)).toEqual(["Segmento de mercado", "Interna"]);
    expect(groups[0].rows[0].name).toBe("Curioso");
    expect(groups[0].note).toBe("quem o produto quer conquistar");
  });
});

describe("vocabSummary", () => {
  it("concorda em número e gênero, e só diz 'encontrada(s)' quando há busca", () => {
    expect(vocabSummary(7, "persona", false)).toBe("7 personas");
    expect(vocabSummary(1, "persona", true)).toBe("1 persona encontrada");
    expect(vocabSummary(0, "system", true)).toBe("0 sistemas encontrados");
    expect(vocabSummary(1, "system", false)).toBe("1 sistema");
  });
});

describe("toVocabRow", () => {
  it("marca o documento em branco — é o que a lista precisa avisar", () => {
    expect(toVocabRow(persona({ id: "a", name: "A" }), "persona", 0).hasPrompt).toBe(false);
    expect(toVocabRow(persona({ id: "a", name: "A", prompt: "  " }), "persona", 0).hasPrompt).toBe(false);
    expect(toVocabRow(persona({ id: "a", name: "A", prompt: "Você é a A." }), "persona", 0).hasPrompt).toBe(true);
  });

  it("o avatar é só da persona (um sistema é sempre o quadrado da cor)", () => {
    const p = toVocabRow(persona({ id: "a", name: "A", avatar: "/avatars/a.png" }), "persona", 0);
    expect(p.avatar).toBe("/avatars/a.png");
    expect(toVocabRow(system({ id: "s", name: "S" }), "system", 0).avatar).toBeUndefined();
  });
});
