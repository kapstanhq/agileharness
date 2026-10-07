// 👥 As personas vêm da seção «Personas» do PRD, com o board.yaml como piso legado. O que não pode
// acontecer: um card perder a persona que referencia (o id) porque ela passou a morar no PRD.

import { describe, expect, it } from "vitest";
import type { Persona } from "../types";
import { prdPersonaEntries, projectPersonas, personaSlug } from "./prd-personas";
import { parseSchemaBody } from "./schema-codec";
import { PRD_SCHEMA } from "./schemas/prd";

const PRD = parseSchemaBody(
  [
    "# PRD",
    "",
    "## Personas",
    "",
    "### Leitor frequente",
    "",
    "- Lê doze livros por ano e foge da lista de mais vendidos.",
    "",
    "### Quem presenteia",
    "",
    "- Quer acertar o presente sem conhecer o gosto da pessoa.",
    "",
    "### Como resolvem hoje",
    "",
    "- Marketplace",
    "",
  ].join("\n"),
  PRD_SCHEMA,
  {},
).doc;

const LEGADO: Persona[] = [
  { id: "leitor", name: "Leitor frequente", color: "#336699", avatar: "/avatars/demo/leitor.png" },
  { id: "colecionador", name: "Colecionador", color: "#996633" },
];

describe("prdPersonaEntries — um `###` por persona", () => {
  it("lê nome + texto; o grupo «Como resolvem hoje» NÃO é persona", () => {
    expect(prdPersonaEntries(PRD)).toEqual([
      { name: "Leitor frequente", prompt: "- Lê doze livros por ano e foge da lista de mais vendidos." },
      { name: "Quem presenteia", prompt: "- Quer acertar o presente sem conhecer o gosto da pessoa." },
    ]);
  });
});

describe("projectPersonas — PRD primeiro, board.yaml como piso", () => {
  it("casa pelo nome: herda id, cor e avatar do legado; o texto vem do PRD", () => {
    const [leitor] = projectPersonas(PRD, LEGADO);
    expect(leitor).toEqual({
      id: "leitor",
      name: "Leitor frequente",
      color: "#336699",
      avatar: "/avatars/demo/leitor.png",
      prompt: "- Lê doze livros por ano e foge da lista de mais vendidos.",
    });
  });

  it("persona nova ganha id do nome; a do legado que o PRD não cita CONTINUA (um card pode referenciá-la)", () => {
    expect(projectPersonas(PRD, LEGADO).map((p) => p.id)).toEqual(["leitor", "quem-presenteia", "colecionador"]);
  });

  it("PRD sem personas ⇒ exatamente o board.yaml", () => {
    expect(projectPersonas(parseSchemaBody("# PRD\n", PRD_SCHEMA, {}).doc, LEGADO)).toEqual(LEGADO);
    expect(projectPersonas(null, LEGADO)).toEqual(LEGADO);
  });

  it("casa também pelo id legado = primeira palavra do nome, sem roubar o casamento exato de outra", () => {
    const prd = parseSchemaBody(
      "# PRD\n\n## Personas\n\n### Leitor ocasional\n\n- a\n\n### Leitor\n\n- b\n",
      PRD_SCHEMA,
      {},
    ).doc;
    const legado: Persona[] = [{ id: "leitor", name: "Leitora que compra por indicação" }];
    // «Leitor» casa EXATO com o id `leitor`; «Leitor ocasional» não pode tomá-lo pela primeira palavra
    expect(projectPersonas(prd, legado).map((p) => [p.id, p.name])).toEqual([
      ["leitor-ocasional", "Leitor ocasional"],
      ["leitor", "Leitor"],
    ]);
    const so = parseSchemaBody("# PRD\n\n## Personas\n\n### Leitor frequente (early adopter)\n\n- a\n", PRD_SCHEMA, {}).doc;
    expect(projectPersonas(so, legado).map((p) => p.id)).toEqual(["leitor"]);
  });

  it("o slug tira acento e pontuação", () => {
    expect(personaSlug("Leitor frequente (early adopter)")).toBe("leitor-frequente-early-adopter");
    expect(personaSlug("Ângela, a livreira")).toBe("angela-a-livreira");
  });
});
