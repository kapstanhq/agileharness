// 📋 O PRD (formato 2) — o schema, o contexto dos agentes e a ponte da escada estratégica antiga.
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
import { emptySchemaDoc, parseSchemaBody, sectionItems, serializeSchemaDoc } from "../schema-codec";
import { BMC_SCHEMA } from "./business-model-canvas";
import { CONTEXTO_SCHEMA } from "./contexto";
import { PRD_DOC_TYPE, PRD_FORMAT, PRD_SCHEMA } from "./prd";
import { hasLegacyStrategy, projectLegacyPrd } from "./prd-legacy";
import { PRD_V1_SCHEMA } from "./prd-v1";

const config = (over: Partial<BoardConfig> = {}): BoardConfig =>
  ({ id: "b", name: "Board", ...over }) as unknown as BoardConfig;

/** A escada da livraria de demonstração — a forma que a projeção vai encontrar num board antigo. */
const DEMO = config({
  positioning:
    "Para leitores que compram por indicação e não por catálogo, a Aurora é a livraria que conhece o seu " +
    "gosto — ao contrário dos marketplaces, que conhecem o seu histórico de compra.",
  businessMetric: "Valor de vida do cliente (CLV) em 24 meses",
  desiredOutcome:
    "Dobrar a fração de pedidos que nascem de uma recomendação da casa (hoje 11%) até o fim do r2.",
});

const SETE = ["problema", "personas", "propostaValor", "funcionalidades", "fluxoUso", "metricasSucesso", "foraEscopo"];

describe("PRD_SCHEMA (formato 2) — a integridade do próprio contrato", () => {
  it("os três schemas novos (e o antigo, fonte da migração) não têm chave duplicada, rótulo ambíguo nem filha órfã", () => {
    for (const schema of [PRD_SCHEMA, CONTEXTO_SCHEMA, BMC_SCHEMA, PRD_V1_SCHEMA]) {
      expect(validateSchema(schema), schema.docType).toEqual([]);
    }
  });

  it("são SETE seções de topo, nesta ordem, todas travadas e com instrução", () => {
    expect(PRD_SCHEMA.sections.map((s) => s.key)).toEqual(SETE);
    expect(PRD_SCHEMA.sections.every((s) => s.level === 2 && s.locked && s.hint.trim())).toBe(true);
    expect(PRD_SCHEMA.allowFreeTail).toBe(false);
  });

  it("é um documento de NEGÓCIO: as seções técnicas foram para o contexto dos agentes", () => {
    for (const key of ["decisoes", "prontoQuando", "requisitos", "restricoes", "riscos", "glossario"]) {
      expect(PRD_SCHEMA.sections.some((s) => s.key === key), `\`${key}\` não pode estar no PRD`).toBe(false);
      expect(CONTEXTO_SCHEMA.sections.some((s) => s.key === key), `\`${key}\` precisa estar no contexto`).toBe(true);
    }
    // O hint diz ao autor (e ao agente) que tecnologia não entra.
    expect(PRD_SCHEMA.sections.find((s) => s.key === "funcionalidades")?.hint).toMatch(/nada de tecnologia/);
  });

  it("o contexto é todo OPCIONAL (um board novo tem contexto vazio) e tem a seção de sobra «outros»", () => {
    expect(CONTEXTO_SCHEMA.sections.filter((s) => s.required)).toEqual([]);
    expect(CONTEXTO_SCHEMA.sections.at(-1)?.key).toBe("outros");
  });

  it("um PRD novo nasce com as sete seções e salva VAZIO — esqueleto válido, nada obrigatório de conteúdo", () => {
    const doc = emptySchemaDoc(PRD_SCHEMA);
    expect(doc.sections.map((s) => s.key)).toEqual(SETE);
    const md = serializeSchemaDoc(doc, PRD_SCHEMA);
    expect(blockingViolations(parseSchemaBody(md, PRD_SCHEMA, {}).violations)).toEqual([]);
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
    const adulterado = md.replace("## Proposta de valor", "## Nossa proposta");
    const { violations } = parseSchemaBody(stripFrontmatter(adulterado), PRD_SCHEMA, {});

    expect(blockingViolations(violations).length, "o rótulo travado passou").toBeGreaterThan(0);
  });

  it("o fluxo de uso aceita uma jornada (itens soltos) ou várias (um `###` por jornada) sem aviso de forma", () => {
    const body = [
      "# PRD",
      "",
      "## Fluxo de uso",
      "",
      "### Comprar",
      "",
      "- abre a vitrine",
      "- compra",
      "",
      "### Devolver",
      "",
      "- devolve em um clique",
      "",
    ].join("\n");
    const { violations } = parseSchemaBody(body, PRD_SCHEMA, {});
    expect(violations.filter((v) => v.sectionKey === "fluxoUso")).toEqual([]);
  });
});

describe("projectLegacyPrd — a leitura de um board que ainda não migrou", () => {
  it("o posicionamento vira a PROPOSTA DE VALOR, e continua uma frase (prosa)", () => {
    const doc = projectLegacyPrd(DEMO);
    const md = serializeSchemaDoc(doc, PRD_SCHEMA);
    expect(md).toContain("## Proposta de valor\n\nPara leitores que compram por indicação e não por catálogo, a Aurora é a livraria");
    expect(sectionItems(doc, "propostaValor"), "proposta de valor não é lista").toEqual([]);
  });

  it("resultado-alvo e métrica viram ITENS de «Métricas de sucesso», com o degrau de origem como prefixo", () => {
    expect(sectionItems(projectLegacyPrd(DEMO), "metricasSucesso").map((i) => i.text)).toEqual([
      "Resultado-alvo: Dobrar a fração de pedidos que nascem de uma recomendação da casa (hoje 11%) até o fim do r2.",
      "Métrica de negócio: Valor de vida do cliente (CLV) em 24 meses",
    ]);
  });

  it("prosa achatada em vários resultados-alvo vira vários itens, não um parágrafo só", () => {
    const doc = projectLegacyPrd(config({ desiredOutcome: "1. Dobrar X.\n\n2. Reduzir Y.\n\n3. Manter Z." }));
    expect(sectionItems(doc, "metricasSucesso").map((i) => i.text)).toEqual([
      "Resultado-alvo: Dobrar X.",
      "Resultado-alvo: Reduzir Y.",
      "Resultado-alvo: Manter Z.",
    ]);
  });

  it("um board SEM escada nenhuma projeta o esqueleto — válido e vazio, nunca quebrado", () => {
    const doc = projectLegacyPrd(config());
    expect(doc.sections.map((s) => s.key)).toEqual(SETE);
    expect(doc.sections.every((s) => s.blocks.length === 0)).toBe(true);
    const { violations } = parseSchemaBody(stripFrontmatter(serializeSchemaDoc(doc, PRD_SCHEMA)), PRD_SCHEMA, doc.frontmatter);
    expect(blockingViolations(violations)).toEqual([]);
  });

  it("o frontmatter declara o tipo E o formato (é o carimbo que impede a migração de reprocessar)", () => {
    expect(projectLegacyPrd(DEMO).frontmatter).toEqual({ doc: PRD_DOC_TYPE, format: PRD_FORMAT });
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
