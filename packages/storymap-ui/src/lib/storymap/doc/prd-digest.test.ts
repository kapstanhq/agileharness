// 🧭 O digest do PRD — o norte que entra em todo prompt de decisão.
//
// A propriedade que estes testes existem para guardar é a NEGATIVA: um board sem norte tem de
// produzir digest VAZIO, e não uma linha bem formada com nada dentro. É a diferença entre o agente
// dizer "este board não declarou norte" e o agente ordenar quarenta cards contra um rótulo oco —
// que sai com aparência de julgamento e sem julgamento nenhum dentro.

import { describe, expect, it } from "vitest";
import { parseSchemaBody, type SchemaDoc } from "./schema-codec";
import { PRD_SCHEMA } from "./schemas/prd";
import { hasPrdDigest, prdDigest, PRD_DIGEST_SECTIONS } from "./prd-digest";

/** Um PRD (formato 2) escrito como um humano escreveria — o caminho que os prompts vão encontrar. */
const PRD_CHEIO = `# PRD

## Problema

- Ninguém acha o próximo livro.

## Personas

### Leitor frequente

- Compra por indicação, não por catálogo.

## Proposta de valor

Para leitores que compram por indicação, a Aurora é a livraria que conhece o seu gosto.

## Funcionalidades

### Descobrir

- Recomendação por leitor

## Fluxo de uso

- Abre a vitrine e lê o porquê de cada indicação

## Métricas de sucesso

- Dobrar os pedidos vindos de recomendação da casa

## Fora do escopo

- Programa de fidelidade
`;

/** O esqueleto das sete seções, com `extra` dentro da seção pedida. */
function esqueleto(extra: Partial<Record<"propostaValor", string>> = {}): string {
  return [
    "## Problema",
    "## Personas",
    `## Proposta de valor${extra.propostaValor ? `\n\n${extra.propostaValor}` : ""}`,
    "## Funcionalidades",
    "## Fluxo de uso",
    "## Métricas de sucesso",
    "## Fora do escopo",
  ].join("\n\n") + "\n";
}

function doc(markdown: string): SchemaDoc {
  return parseSchemaBody(markdown.replace(/^# PRD\n/, ""), PRD_SCHEMA, {}).doc;
}

describe("prdDigest — o norte em algumas linhas", () => {
  const digest = prdDigest(doc(PRD_CHEIO));

  it("carrega as seis seções que moldam decisão, rotuladas", () => {
    expect(digest).toContain("Proposta de valor: Para leitores que compram por indicação");
    expect(digest).toContain("Problema: Ninguém acha o próximo livro.");
    expect(digest).toContain("Métricas de sucesso: Dobrar os pedidos vindos de recomendação da casa");
    expect(digest).toContain("Fora do escopo: Programa de fidelidade");
  });

  it("o grupo autoral sobrevive — em «Personas» o grupo É a persona", () => {
    expect(digest).toContain("Personas — Leitor frequente: Compra por indicação, não por catálogo.");
    expect(digest).toContain("Funcionalidades — Descobrir: Recomendação por leitor");
  });

  it("NÃO carrega o fluxo de uso — ele serve para escrever o card, não para ordená-lo", () => {
    expect(digest).not.toContain("Abre a vitrine");
  });

  it("não-vacuidade: o digest tem substância e uma linha por seção preenchida", () => {
    expect(digest.length).toBeGreaterThan(80);
    expect(digest.split("\n").length).toBe(6);
  });
});

describe("prdDigest — a ausência de norte é DITA, não simulada", () => {
  it("um PRD só com esqueleto produz digest VAZIO", () => {
    const vazio = doc(esqueleto());
    expect(prdDigest(vazio)).toBe("");
    expect(hasPrdDigest(vazio)).toBe(false);
  });

  it("documento ausente (board sem PRD nenhum) não explode — devolve vazio", () => {
    expect(prdDigest(null)).toBe("");
    expect(prdDigest(undefined)).toBe("");
    expect(hasPrdDigest(null)).toBe(false);
  });

  it("uma seção preenchida basta para haver norte — e só ela aparece", () => {
    const so = doc(esqueleto({ propostaValor: "Somos a livraria que conhece o seu gosto." }));
    expect(hasPrdDigest(so)).toBe(true);
    expect(prdDigest(so)).toBe("Proposta de valor: Somos a livraria que conhece o seu gosto.");
  });
});

describe("prdDigest — o teto por seção", () => {
  it("uma seção enorme é cortada em fronteira de palavra, e o corte é VISÍVEL", () => {
    const longo = "palavra ".repeat(300).trim();
    const d = prdDigest(doc(esqueleto({ propostaValor: longo })));
    expect(d.endsWith("…"), "o leitor precisa saber que há mais").toBe(true);
    expect(d.length, "um PRD que cresceu não empurra o resto do prompt para fora da janela").toBeLessThan(900);
    expect(d).not.toMatch(/pala…$/);
  });
});

describe("PRD_DIGEST_SECTIONS — o corte é declarado, não espalhado", () => {
  it("toda seção do digest existe de verdade no schema do PRD", () => {
    // Uma chave que o schema não tem produziria silêncio: `sectionItems` devolve vazio, a linha some,
    // e o norte fica pela metade sem ninguém reclamar.
    const doSchema = new Set(PRD_SCHEMA.sections.map((s) => s.key));
    const orfas = PRD_DIGEST_SECTIONS.filter((s) => !doSchema.has(s.key)).map((s) => s.key);
    expect(orfas).toEqual([]);
    expect(PRD_DIGEST_SECTIONS.length, "não-vacuidade").toBeGreaterThan(0);
  });
});
