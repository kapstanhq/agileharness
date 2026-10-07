// As entradas do digest — o bloco de contexto do card desenha UMA por seção. O caso que estes testes guardam: uma
// proposta de valor escrita com quebras suaves e um `código` no meio virava vários parágrafos curtos (a frase partida
// em volta do código, e o par do `**negrito**` separado).

import { describe, expect, it } from "vitest";
import { parseSchemaBody } from "./schema-codec";
import { PRD_SCHEMA } from "./schemas/prd";
import { prdDigest } from "./prd-digest";
import { digestEntries } from "./digest-entries";

const PRD = `## Problema

- Ninguém acha o próximo livro.

## Proposta de valor

Para leitores que compram por indicação, a vitrine em
\`aurora.example/vitrine\` é o lugar onde **cada
indicação diz o porquê** — sem
garimpar catálogo.

## Métricas de sucesso

- Dobrar os pedidos vindos de recomendação
`;

describe("digestEntries", () => {
  it("a prosa com quebras suaves é UMA entrada: o código e o negrito ficam dentro da frase", () => {
    const strategy = prdDigest(parseSchemaBody(PRD, PRD_SCHEMA, {}).doc);
    expect(strategy.split("\n").length).toBeGreaterThan(3); // o digest cru carrega as quebras da prosa
    const entries = digestEntries(strategy);
    expect(entries.map((e) => e.slice(0, e.indexOf(":")))).toEqual(["Proposta de valor", "Problema", "Métricas de sucesso"]);
    const proposta = entries[0];
    expect(proposta).toContain("a vitrine em `aurora.example/vitrine` é o lugar");
    expect(proposta).toContain("**cada indicação diz o porquê**");
    expect(proposta).not.toContain("\n");
  });

  it("rótulo com grupo abre entrada; linhas vazias somem; texto sem rótulo no início não se perde", () => {
    expect(
      digestEntries("solto no topo\n\nPersonas — Leitor: compra por indicação\ncontinua aqui\nFuncionalidades — Descobrir: vitrine"),
    ).toEqual(["solto no topo", "Personas — Leitor: compra por indicação continua aqui", "Funcionalidades — Descobrir: vitrine"]);
    expect(digestEntries("")).toEqual([]);
  });
});
