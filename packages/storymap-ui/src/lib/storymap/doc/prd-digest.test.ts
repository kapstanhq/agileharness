// 🧭 O digest do PRD — o norte que entra em todo prompt de decisão.
//
// A propriedade que estes testes existem para guardar é a NEGATIVA: um board sem norte tem de
// produzir digest VAZIO, e não uma linha bem formada com nada dentro. É a diferença entre o agente
// dizer "este board não declarou norte" e o agente priorizar quarenta cards contra um rótulo oco —
// que sai com aparência de julgamento e sem julgamento nenhum dentro.

import { describe, expect, it } from "vitest";
import { parseSchemaBody, type SchemaDoc } from "./schema-codec";
import { PRD_SCHEMA } from "./schemas/prd";
import { hasPrdDigest, prdDigest, PRD_DIGEST_SECTIONS } from "./prd-digest";

/** Um PRD escrito como um humano escreveria — o caminho que os prompts vão encontrar. */
const PRD_CHEIO = `# PRD

## Resumo executivo

A Aurora é uma livraria de bairro que quer vender por indicação.

## Problema

- Ninguém acha o próximo livro.

## Público

### Leitor frequente

- Compra por indicação, não por catálogo.

## Posicionamento

Para leitores que compram por indicação, a Aurora é a livraria que conhece o seu gosto.

## Objetivos e métricas

### Métrica de negócio

- Valor de vida do cliente em 24 meses

### Resultado-alvo

- Dobrar os pedidos vindos de recomendação da casa

## Escopo

### Nesta versão

- Recomendação por leitor

### Fora, por ora

- Programa de fidelidade
`;

function doc(markdown: string): SchemaDoc {
  return parseSchemaBody(markdown.replace(/^# PRD\n/, ""), PRD_SCHEMA, {}).doc;
}

describe("prdDigest — o norte em algumas linhas", () => {
  const digest = prdDigest(doc(PRD_CHEIO));

  it("carrega as cinco seções que moldam decisão, rotuladas", () => {
    expect(digest).toContain("Resumo: A Aurora é uma livraria de bairro");
    expect(digest).toContain("Posicionamento: Para leitores que compram por indicação");
    expect(digest).toContain("Resultado-alvo: Dobrar os pedidos vindos de recomendação da casa");
    expect(digest).toContain("Métrica de negócio: Valor de vida do cliente em 24 meses");
  });

  it("no ESCOPO o grupo autoral sobrevive — «dentro» e «fora» são leituras opostas do mesmo item", () => {
    // Achatar as duas listas numa só diria a coisa errada, e diria com confiança: uma demanda que
    // cai em «Fora, por ora» não precisa ser pontuada, precisa ser recusada.
    expect(digest).toContain("Escopo — Nesta versão: Recomendação por leitor");
    expect(digest).toContain("Escopo — Fora, por ora: Programa de fidelidade");
  });

  it("NÃO carrega as seções caras — elas servem para escrever o card, não para ordená-lo", () => {
    expect(digest).not.toContain("Ninguém acha o próximo livro");
    expect(digest).not.toContain("Compra por indicação, não por catálogo");
  });

  it("não-vacuidade: o digest tem substância e uma linha por seção preenchida", () => {
    expect(digest.length).toBeGreaterThan(80);
    // 4 seções de uma linha + o escopo, que rende uma linha por grupo.
    expect(digest.split("\n").length).toBe(6);
  });
});

describe("prdDigest — a ausência de norte é DITA, não simulada", () => {
  it("um PRD só com esqueleto produz digest VAZIO", () => {
    const vazio = doc(`## Resumo executivo

## Problema

## Público

## Posicionamento

## Objetivos e métricas

## Escopo
`);
    expect(prdDigest(vazio)).toBe("");
    expect(hasPrdDigest(vazio)).toBe(false);
  });

  it("documento ausente (board sem PRD nenhum) não explode — devolve vazio", () => {
    expect(prdDigest(null)).toBe("");
    expect(prdDigest(undefined)).toBe("");
    expect(hasPrdDigest(null)).toBe(false);
  });

  it("uma seção preenchida basta para haver norte — e só ela aparece", () => {
    const so = doc(`## Resumo executivo

## Problema

## Público

## Posicionamento

Somos a livraria que conhece o seu gosto.

## Objetivos e métricas

## Escopo
`);
    expect(hasPrdDigest(so)).toBe(true);
    expect(prdDigest(so)).toBe("Posicionamento: Somos a livraria que conhece o seu gosto.");
  });
});

describe("prdDigest — o teto por seção", () => {
  it("uma seção enorme é cortada em fronteira de palavra, e o corte é VISÍVEL", () => {
    const longo = "palavra ".repeat(300).trim();
    const d = prdDigest(
      doc(`## Resumo executivo

${longo}

## Problema

## Público

## Posicionamento

## Objetivos e métricas

## Escopo
`),
    );
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
