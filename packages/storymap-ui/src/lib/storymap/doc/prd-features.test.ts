// 🧩 As funcionalidades do board vêm dos `###` da seção «Funcionalidades» do PRD. O que não pode acontecer: um balde de
// escopo da própria ferramenta virar funcionalidade, ou dois títulos iguais darem o MESMO id (um card não saberia de qual
// ele é).

import { describe, expect, it } from "vitest";
import { docSlug, prdFeatureEntries } from "./prd-features";
import { parseSchemaBody } from "./schema-codec";
import { PRD_SCHEMA } from "./schemas/prd";

function prd(lines: string[]) {
  return parseSchemaBody(["# PRD", "", "## Funcionalidades", "", ...lines].join("\n"), PRD_SCHEMA, {}).doc;
}

describe("prdFeatureEntries — um `###` por funcionalidade", () => {
  it("lê id (slug do nome), nome e o texto abaixo do título, na ordem do documento", () => {
    const doc = prd([
      "### Reservar um canteiro",
      "",
      "Quem cultiva escolhe um canteiro livre e reserva por uma estação.",
      "",
      "### Trocar mudas",
      "",
      "- Anuncia a muda que sobrou.",
      "- Combina a retirada com o vizinho.",
      "",
    ]);
    expect(prdFeatureEntries(doc)).toEqual([
      { id: "reservar-um-canteiro", name: "Reservar um canteiro", markdown: "Quem cultiva escolhe um canteiro livre e reserva por uma estação." },
      { id: "trocar-mudas", name: "Trocar mudas", markdown: "- Anuncia a muda que sobrou.\n- Combina a retirada com o vizinho." },
    ]);
  });

  it("pula os baldes de escopo da ferramenta («Nesta versão», «Escopo»)", () => {
    const doc = prd(["### Nesta versão", "", "- tudo do primeiro mês", "", "### Regar junto", "", "Escala de rega.", "", "### Escopo", "", "- legado", ""]);
    expect(prdFeatureEntries(doc).map((f) => f.id)).toEqual(["regar-junto"]);
  });

  it("título repetido ganha `-2`, `-3`… e nunca colide com um título que já se chama assim", () => {
    const doc = prd(["### Mural", "", "um", "", "### Mural", "", "dois", "", "### Mural 2", "", "três", "", "### Mural", "", "quatro", ""]);
    const ids = prdFeatureEntries(doc).map((f) => f.id);
    expect(ids).toEqual(["mural", "mural-3", "mural-2", "mural-4"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("um `### Outros` no PRD não toma o id do grupo «Outros (fora do PRD)»", () => {
    const doc = prd(["### Outros", "", "miudezas", "", "### Regar junto", "", "Escala de rega.", ""]);
    expect(prdFeatureEntries(doc).map((f) => f.id)).toEqual(["outros-2", "regar-junto"]);
  });

  it("PRD sem a seção, sem `###`, ou nenhum PRD ⇒ []", () => {
    expect(prdFeatureEntries(null)).toEqual([]);
    expect(prdFeatureEntries(undefined)).toEqual([]);
    expect(prdFeatureEntries(prd(["Só um parágrafo, sem título de funcionalidade.", ""]))).toEqual([]);
    const semSecao = parseSchemaBody("# PRD\n\n## Personas\n\n### Quem cultiva\n\n- tem um canteiro\n", PRD_SCHEMA, {}).doc;
    expect(prdFeatureEntries(semSecao)).toEqual([]);
  });

  it("funcionalidade sem texto abaixo tem markdown vazio", () => {
    expect(prdFeatureEntries(prd(["### Compostar", ""]))).toEqual([{ id: "compostar", name: "Compostar", markdown: "" }]);
  });

  it("docSlug é a régua das personas (acentos fora, minúsculas, hífens)", () => {
    expect(docSlug("Ação de Rega — Época Seca")).toBe("acao-de-rega-epoca-seca");
  });
});
