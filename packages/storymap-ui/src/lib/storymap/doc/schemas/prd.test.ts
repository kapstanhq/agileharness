// 📋 O PRD — o schema e a ponte da escada estratégica antiga.
//
// Dois momentos perigosos, e cada `describe` guarda um:
//
//   · o SCHEMA — ele é lido por três portas de escrita e por todo agente que cita uma seção. Uma
//     chave duplicada ou um rótulo ambíguo não explode: torna o casamento por rótulo indeterminado,
//     e a fonte markdown (a superfície que perde props) passa a reancorar na seção errada.
//   · a PROJEÇÃO — a primeira leitura de um board que ainda não migrou. Se ela errar, o operador vê
//     um PRD errado, e o primeiro save GRAVA esse erro por cima do que existia no `board.yaml`.

import { describe, expect, it } from "vitest";
import type { BoardConfig } from "../../types";
import { blockingViolations, validateSchema } from "../doc-schema";
import { parseSchemaBody, sectionItems, serializeSchemaDoc } from "../schema-codec";
import { PRD_DOC_TYPE, PRD_SCHEMA } from "./prd";
import { hasLegacyStrategy, projectLegacyPrd } from "./prd-legacy";

const config = (over: Partial<BoardConfig> = {}): BoardConfig =>
  ({ id: "b", name: "Board", ...over }) as unknown as BoardConfig;

/** O board real do `demo`, palavra por palavra — a forma que a projeção vai encontrar em produção. */
const DEMO = config({
  positioning:
    "Para leitores que compram por indicação e não por catálogo, a Aurora é a livraria que conhece o seu " +
    "gosto — ao contrário dos marketplaces, que conhecem o seu histórico de compra.",
  businessMetric: "Valor de vida do cliente (CLV) em 24 meses",
  desiredOutcome:
    "Dobrar a fração de pedidos que nascem de uma recomendação da casa (hoje 11%) até o fim do r2.",
});

describe("PRD_SCHEMA — a integridade do próprio contrato", () => {
  it("não tem chave duplicada, rótulo ambíguo nem filha órfã", () => {
    expect(validateSchema(PRD_SCHEMA)).toEqual([]);
  });

  it("as três seções que a escada estratégica alimenta existem, e são filhas do lugar certo", () => {
    const byKey = (k: string) => PRD_SCHEMA.sections.find((s) => s.key === k);

    expect(byKey("posicionamento")?.content, "posicionamento é uma FRASE, não uma lista").toBe("prose");
    expect(byKey("metricaNegocio")?.parent).toBe("objetivos");
    expect(byKey("resultadoAlvo")?.parent).toBe("objetivos");
  });

  it("as três seções escritas para o AGENTE existem — são elas que separam este PRD de um PRD humano", () => {
    // Decisões já tomadas, jornadas e critérios de verificação. Um agente sem a primeira re-decide
    // plausivelmente; sem a segunda a captura propõe uma lista plana em vez de um backbone; sem a
    // terceira "funciona" vira o critério, e "funciona" não é verificável por ninguém de fora.
    for (const key of ["decisoes", "jornadas", "prontoQuando"]) {
      expect(PRD_SCHEMA.sections.some((s) => s.key === key), `seção \`${key}\``).toBe(true);
    }
  });

  it("todo rótulo é travado e toda seção diz o que se escreve nela", () => {
    // O `hint` é o empty-state em QUALQUER view: uma seção sem ele abre em branco, sem instrução.
    // E um PRD de dezesseis seções em branco é exatamente o documento que ninguém preenche.
    const mudas = PRD_SCHEMA.sections.filter((s) => !s.hint.trim() || !s.locked);
    expect(mudas.map((s) => s.key)).toEqual([]);
    expect(PRD_SCHEMA.sections.length, "não-vacuidade: o schema tem seções").toBeGreaterThan(10);
  });

  it("o esqueleto obrigatório é PEQUENO — um documento nasce curto e cresce", () => {
    const obrigatorias = PRD_SCHEMA.sections.filter((s) => s.required).map((s) => s.key);
    expect(obrigatorias).toEqual([
      "resumo",
      "problema",
      "publico",
      "posicionamento",
      "objetivos",
      "escopo",
    ]);
  });
});

describe("PRD — o round-trip pelo markdown", () => {
  it("serializar e reler é PONTO FIXO, e o documento projetado não tem violação que impeça salvar", () => {
    const doc = projectLegacyPrd(DEMO);
    const md = serializeSchemaDoc(doc, PRD_SCHEMA);
    const relido = parseSchemaBody(stripFrontmatter(md), PRD_SCHEMA, doc.frontmatter);

    expect(blockingViolations(relido.violations), "um doc projetado abriria acusando erro que ninguém causou").toEqual([]);
    expect(serializeSchemaDoc(relido.doc, PRD_SCHEMA)).toBe(md);
  });

  it("renomear um rótulo travado é RECUSADO — o esqueleto é o que toda view lê", () => {
    const md = serializeSchemaDoc(projectLegacyPrd(DEMO), PRD_SCHEMA);
    const adulterado = md.replace("## Posicionamento", "## Posicionamento estratégico");
    const { violations } = parseSchemaBody(stripFrontmatter(adulterado), PRD_SCHEMA, {});

    expect(blockingViolations(violations).length, "o rótulo travado passou").toBeGreaterThan(0);
  });
});

describe("projectLegacyPrd — a leitura de um board que ainda não migrou", () => {
  it("o posicionamento continua uma FRASE (prosa), com o dobramento do YAML desfeito", () => {
    const doc = projectLegacyPrd(DEMO);
    const md = serializeSchemaDoc(doc, PRD_SCHEMA);

    // A frase chega do YAML dobrada em várias linhas; cortá-la em itens inventaria uma estrutura
    // que ninguém escreveu.
    expect(md).toContain("Para leitores que compram por indicação e não por catálogo, a Aurora é a livraria");
    expect(sectionItems(doc, "posicionamento"), "posicionamento não é lista").toEqual([]);
  });

  it("métrica e resultado-alvo viram ITENS, pelo mesmo corte conservador do canvas", () => {
    expect(sectionItems(projectLegacyPrd(DEMO), "metricaNegocio").map((i) => i.text)).toEqual([
      "Valor de vida do cliente (CLV) em 24 meses",
    ]);
    expect(sectionItems(projectLegacyPrd(DEMO), "resultadoAlvo").map((i) => i.text)).toEqual([
      "Dobrar a fração de pedidos que nascem de uma recomendação da casa (hoje 11%) até o fim do r2.",
    ]);
  });

  it("prosa achatada em vários resultados-alvo vira vários itens, não um parágrafo só", () => {
    const doc = projectLegacyPrd(config({ desiredOutcome: "1. Dobrar X.\n\n2. Reduzir Y.\n\n3. Manter Z." }));
    expect(sectionItems(doc, "resultadoAlvo").map((i) => i.text)).toEqual([
      "Dobrar X.",
      "Reduzir Y.",
      "Manter Z.",
    ]);
  });

  it("um board SEM escada nenhuma projeta o esqueleto obrigatório — válido e vazio, nunca quebrado", () => {
    const doc = projectLegacyPrd(config());
    expect(doc.sections.map((s) => s.key)).toEqual([
      "resumo",
      "problema",
      "publico",
      "posicionamento",
      "objetivos",
      "escopo",
    ]);
    const { violations } = parseSchemaBody(
      stripFrontmatter(serializeSchemaDoc(doc, PRD_SCHEMA)),
      PRD_SCHEMA,
      doc.frontmatter,
    );
    expect(blockingViolations(violations)).toEqual([]);
  });

  it("as seções que a escada NÃO alimenta nascem ausentes, não vazias-e-obrigatórias", () => {
    // Dito de outro jeito: a projeção não inventa conteúdo. As treze seções que a escada nunca teve
    // são exatamente o que faltava — e elas aparecem como esqueleto na tela, não como texto falso.
    const doc = projectLegacyPrd(DEMO);
    expect(doc.sections.some((s) => s.key === "decisoes")).toBe(false);
    expect(doc.sections.some((s) => s.key === "jornadas")).toBe(false);
  });

  it("o frontmatter declara o tipo do documento", () => {
    expect(projectLegacyPrd(DEMO).frontmatter).toEqual({ doc: PRD_DOC_TYPE });
  });

  it("hasLegacyStrategy distingue «nunca declarou norte» de «declarou»", () => {
    expect(hasLegacyStrategy(config())).toBe(false);
    expect(hasLegacyStrategy(config({ positioning: "   " })), "só espaço não é norte").toBe(false);
    expect(hasLegacyStrategy(config({ businessMetric: "CLV" }))).toBe(true);
    expect(hasLegacyStrategy(DEMO)).toBe(true);
  });
});

/** O corpo depois do frontmatter — o parse do corpo é sempre sobre o texto sem o cabeçalho. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const after = raw.indexOf("\n", end + 1);
  return after === -1 ? "" : raw.slice(after + 1);
}
