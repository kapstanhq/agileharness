// 🔁 As migrações de formato — a garantia é uma só: NADA SOME. Cada teste conta o que entrou e o que
// saiu (blocos de conteúdo, não títulos) e confere que cada texto de origem chegou a um destino
// declarado. Fixtures INVENTADAS, no vocabulário da livraria de demonstração.

import { describe, expect, it } from "vitest";
import type { BoardConfig } from "../types";
import type { DocBlock } from "./doc-model";
import { blockingViolations } from "./doc-schema";
import {
  appendMigratedContexto,
  isPrdV1,
  migrateLeanCanvasToBmc,
  migratePrdV1,
  parsePrdV1,
} from "./migrations";
import { parseSchemaBody, sectionGroups, sectionItems, serializeSchemaDoc, type SchemaDoc } from "./schema-codec";
import { BMC_SCHEMA } from "./schemas/business-model-canvas";
import { CONTEXTO_SCHEMA } from "./schemas/contexto";
import { LEAN_CANVAS_SCHEMA } from "./schemas/lean-canvas";
import { projectLegacyLeanCanvas } from "./schemas/lean-canvas-legacy";
import { PRD_SCHEMA } from "./schemas/prd";

/** Os blocos de CONTEÚDO de um documento (títulos de seção e de grupo não contam). */
function contentBlocks(doc: SchemaDoc): DocBlock[] {
  return [...doc.sections.flatMap((s) => s.blocks), ...doc.tail].filter((b) => b.kind !== "heading");
}

function texts(doc: SchemaDoc): string[] {
  return contentBlocks(doc).map((b) => ("text" in b ? String(b.text) : b.kind));
}

/** O documento migrado relido pelo schema de destino: tem de salvar (nenhuma violação que recuse). */
function savable(doc: SchemaDoc, schema: typeof PRD_SCHEMA): void {
  const md = serializeSchemaDoc(doc, schema);
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  expect(blockingViolations(parseSchemaBody(body, schema, doc.frontmatter).violations), schema.docType).toEqual([]);
}

// ---------------------------------------------------------------------------
// PRD formato 1 → 2
// ---------------------------------------------------------------------------

/** Um PRD formato 1 INVENTADO (livraria de demonstração) com TODAS as seções — e uma que o schema não conhece. */
const PRD_V1 = `# PRD

## Resumo executivo

A livraria Aurora leva a curadoria do balcão para uma vitrine online.

## Problema

### Descoberta

- Quem lê muito só acha o mais vendido.

### Risco da compra

- Devolver um livro errado custa caro.

## Público

### Leitor frequente

- Quer o próximo livro sem a lista de mais vendidos.

### Quem presenteia

- Quer acertar o presente sem conhecer o gosto da pessoa.

### Alternativas hoje

- Grupo de mensagens com amigos.
- Marketplace com «quem comprou também comprou».

## Posicionamento

Para quem compra por indicação, a Aurora é a livraria que conhece o seu gosto.

## Objetivos e métricas

A aposta: a recomendação da casa traz o leitor de volta.

### Métrica de negócio

- Valor de vida do cliente em 24 meses

### Resultado-alvo

- Dobrar os pedidos que nascem de uma recomendação

### Sinais-líderes

- Fichas de gosto preenchidas por semana

## Escopo

### Nesta versão

- Ficha de gosto online
- Vitrine com o porquê de cada indicação

### Fora, por ora

- Clube de assinatura

### Nunca

- Recomendar por histórico de compra

## Solução

### Recomendar

- Vitrine pela ficha de gosto

## Jornadas

- Declarar o gosto → ver a vitrine
- Descobrir → comprar

## Requisitos

### Funcionais

- A ficha pode ser editada pelo leitor

### Não-funcionais

- A vitrine abre em menos de 2 s no celular

## Decisões já tomadas

- Recomendação por gosto declarado

## Restrições e premissas

- Equipe de duas pessoas

## Riscos e perguntas em aberto

- [ ] Fichas digitalizadas ilegíveis
- [x] Contagem dos 11% conferida

## Modelo de negócio

### Receita

- Venda avulsa de livros

## Lançamento

- Newsletter da loja

## Pronto quando

- Um leitor reconhece um título que não acharia sozinho

## Glossário

- **Ficha de gosto** — o que o leitor declarou gostar

## Parceiros de entrega

Transportadora do bairro, combinada por telefone.

### Horários

- Coleta às 17h
`;

describe("isPrdV1 — o que precisa migrar", () => {
  it("formato 1 sem carimbo ⇒ migra; `format: 2` ⇒ nunca", () => {
    expect(isPrdV1({ doc: "prd" }, PRD_V1)).toBe(true);
    expect(isPrdV1({ doc: "prd", format: 2 }, PRD_V1)).toBe(false);
  });

  it("um documento vazio migra (vira o esqueleto novo); um formato 2 escrito à mão sem carimbo não", () => {
    expect(isPrdV1({}, "# PRD\n")).toBe(true);
    expect(isPrdV1({}, "# PRD\n\n## Problema\n\n- x\n\n## Personas\n\n### Leitor\n\n- y\n")).toBe(false);
  });

  it("um `## Resumo executivo` dentro de bloco de código não conta como seção", () => {
    expect(isPrdV1({}, "# PRD\n\n## Personas\n\n```\n## Resumo executivo\n```\n")).toBe(false);
  });
});

describe("migratePrdV1 — formato 1 → PRD formato 2 + contexto, sem perder bloco", () => {
  const v1 = parsePrdV1(PRD_V1, { doc: "prd" });
  const { prd, contexto } = migratePrdV1(v1);

  it("NADA SOME: os blocos de conteúdo de antes são exatamente os de depois (PRD + contexto)", () => {
    const antes = contentBlocks(v1).length;
    expect(antes, "não-vacuidade: a fixture tem conteúdo").toBeGreaterThan(25);
    expect(contentBlocks(prd).length + contentBlocks(contexto).length).toBe(antes);
    // e cada texto de origem está lá, em algum lugar (o prefixo de métrica pode vir antes dele)
    const depois = [...texts(prd), ...texts(contexto)].join("\n");
    for (const t of texts(v1)) expect(depois, t).toContain(t);
  });

  it("aceita o markdown cru do corpo e chega ao MESMO resultado", () => {
    expect(serializeSchemaDoc(migratePrdV1(PRD_V1).prd, PRD_SCHEMA)).toBe(serializeSchemaDoc(migratePrdV1(parsePrdV1(PRD_V1)).prd, PRD_SCHEMA));
  });

  it("o PRD novo tem as sete seções, é carimbado `format: 2` e SALVA", () => {
    expect(prd.sections.map((s) => s.key)).toEqual(PRD_SCHEMA.sections.map((s) => s.key));
    expect(prd.frontmatter).toEqual({ doc: "prd", format: 2 });
    savable(prd, PRD_SCHEMA);
    savable(contexto, CONTEXTO_SCHEMA);
  });

  it("problema e personas (com «Como resolvem hoje») mantêm os grupos autorais", () => {
    expect(sectionGroups(prd, "problema")).toEqual(["Descoberta", "Risco da compra"]);
    expect(sectionGroups(prd, "personas")).toEqual(["Leitor frequente", "Quem presenteia", "Como resolvem hoje"]);
    expect(sectionItems(prd, "personas").filter((i) => i.group === "Como resolvem hoje")).toHaveLength(2);
  });

  it("proposta de valor = posicionamento primeiro, depois o resumo", () => {
    const md = serializeSchemaDoc(prd, PRD_SCHEMA);
    const pos = md.indexOf("Para quem compra por indicação");
    const resumo = md.indexOf("A livraria Aurora leva a curadoria");
    expect(pos).toBeGreaterThan(-1);
    expect(resumo).toBeGreaterThan(pos);
  });

  it("funcionalidades = solução + o escopo DE DENTRO; o de fora vai para «Fora do escopo» (o «Nunca» com prefixo)", () => {
    expect(sectionGroups(prd, "funcionalidades")).toEqual(["Recomendar", "Nesta versão"]);
    expect(sectionItems(prd, "foraEscopo").map((i) => i.text)).toEqual([
      "Clube de assinatura",
      "Nunca: Recomendar por histórico de compra",
    ]);
  });

  it("jornadas → fluxo de uso; objetivos e as três subseções → métricas de sucesso, com o degrau como prefixo", () => {
    expect(sectionItems(prd, "fluxoUso").map((i) => i.text)).toEqual(["Declarar o gosto → ver a vitrine", "Descobrir → comprar"]);
    expect(sectionItems(prd, "metricasSucesso").map((i) => i.text)).toEqual([
      "A aposta: a recomendação da casa traz o leitor de volta.",
      "Métrica de negócio: Valor de vida do cliente em 24 meses",
      "Resultado-alvo: Dobrar os pedidos que nascem de uma recomendação",
      "Sinal-líder: Fichas de gosto preenchidas por semana",
    ]);
  });

  it("as seções dos agentes vão para o contexto com a mesma chave; a desconhecida vai para «Outras notas»", () => {
    expect(contexto.sections.map((s) => s.key)).toEqual([
      "decisoes",
      "prontoQuando",
      "requisitos",
      "restricoes",
      "riscos",
      "modeloNegocio",
      "lancamento",
      "glossario",
      "outros",
    ]);
    expect(sectionItems(contexto, "riscos").map((i) => i.checked)).toEqual([false, true]);
    expect(sectionGroups(contexto, "outros")).toEqual(["Parceiros de entrega", "Parceiros de entrega — Horários"]);
  });

  it("um PRD formato 1 VAZIO vira o esqueleto novo e um contexto sem seções", () => {
    const r = migratePrdV1("# PRD\n");
    expect(r.prd.sections.every((s) => s.blocks.length === 0)).toBe(true);
    expect(r.contexto.sections).toEqual([]);
  });
});

describe("appendMigratedContexto — o contexto que já existia não é sobrescrito", () => {
  const { contexto } = migratePrdV1(PRD_V1);
  const existente = parseSchemaBody(
    "# Contexto para os agentes\n\n## Decisões já tomadas\n\n- Recomendação por gosto declarado\n- Pagamento só por cartão\n",
    CONTEXTO_SCHEMA,
    { doc: "contexto" },
  ).doc;

  it("acrescenta em «Outras notas» só o que ele ainda não tem, e mantém o que estava escrito", () => {
    const junto = appendMigratedContexto(existente, contexto);
    expect(sectionItems(junto, "decisoes").map((i) => i.text)).toEqual(["Recomendação por gosto declarado", "Pagamento só por cartão"]);
    const outros = sectionItems(junto, "outros").map((i) => i.text);
    expect(outros).not.toContain("Recomendação por gosto declarado"); // já estava — não duplica
    expect(outros).toContain("Equipe de duas pessoas");
    expect(sectionGroups(junto, "outros")).toContain("Do PRD antigo — Requisitos — Funcionais");
    savable(junto, CONTEXTO_SCHEMA);
  });

  it("é idempotente: acrescentar de novo não muda nada", () => {
    const uma = appendMigratedContexto(existente, contexto);
    expect(appendMigratedContexto(uma, contexto)).toBe(uma);
  });
});

// ---------------------------------------------------------------------------
// Lean Canvas → Business Model Canvas
// ---------------------------------------------------------------------------

const LEAN_MD = `# Lean Canvas

## Segmentos de clientes

- Leitor frequente

### Early adopters

- Clientes com ficha de gosto no balcão

## Problema

### Descoberta

- Só acha o mais vendido

### Alternativas existentes

- Marketplace

## Proposta de valor única

- A livraria que conhece o seu gosto

### Conceito de alto nível

- O livreiro do bairro, online

## Solução

- Vitrine pela ficha de gosto

## Canais

- Newsletter da loja

## Fontes de receita

- Venda avulsa

## Estrutura de custos

- Frete da devolução

## Métricas-chave

- Pedidos vindos de recomendação

## Vantagem injusta

- Sete anos de fichas escritas à mão
`;

describe("migrateLeanCanvasToBmc — nove blocos novos, nenhum item perdido", () => {
  const lean = parseSchemaBody(LEAN_MD, LEAN_CANVAS_SCHEMA, { doc: "lean-canvas", tags: [{ id: "leitor", name: "Leitor", color: "#336699" }] }).doc;
  const bmc = migrateLeanCanvasToBmc(lean);

  it("NADA SOME: mesmos blocos de conteúdo, mesmos textos", () => {
    expect(contentBlocks(lean).length, "não-vacuidade").toBe(12);
    expect(texts(bmc).sort()).toEqual(texts(lean).sort());
  });

  it("os nove blocos, na ordem do BMC; o canvas migrado SALVA; as etiquetas passam inteiras", () => {
    expect(bmc.sections.map((s) => s.key)).toEqual(BMC_SCHEMA.sections.map((s) => s.key));
    expect(bmc.frontmatter).toEqual({ doc: "business-model-canvas", tags: [{ id: "leitor", name: "Leitor", color: "#336699" }] });
    savable(bmc, BMC_SCHEMA);
  });

  it("cada bloco do Lean Canvas cai no destino declarado, com o grupo que diz de onde veio", () => {
    expect(sectionGroups(bmc, "customerSegments")).toEqual(["Primeiros clientes"]);
    expect(sectionItems(bmc, "valuePropositions")[0].text, "o hero continua o primeiro item").toBe("A livraria que conhece o seu gosto");
    // o grupo autoral do Problema («Descoberta») não aninha sob o grupo novo: vira prefixo
    expect(sectionGroups(bmc, "valuePropositions")).toEqual(["Conceito", "Problemas que resolve — Descoberta", "Como resolvem hoje"]);
    expect(sectionGroups(bmc, "keyActivities")).toEqual(["Solução", "Métricas-chave"]);
    expect(sectionGroups(bmc, "keyResources")).toEqual(["Vantagem difícil de copiar"]);
    expect(sectionItems(bmc, "channels").map((i) => i.text)).toEqual(["Newsletter da loja"]);
    expect(sectionItems(bmc, "customerRelationships")).toEqual([]);
    expect(sectionItems(bmc, "keyPartners")).toEqual([]);
  });

  it("a partir do `canvas:` do board.yaml (o caminho de todo board existente), pela projeção legada", () => {
    const config = {
      id: "demo",
      name: "Demo",
      canvasTags: [{ id: "leitor", name: "Leitor", color: "#336699" }],
      canvas: {
        customerSegments: { items: [{ id: "i1", text: "Leitor frequente", tags: ["leitor"], group: "Quem lê" }] },
        problem: { items: [{ id: "i2", text: "Só acha o mais vendido" }] },
        unfairAdvantage: { items: [{ id: "i3", text: "Fichas escritas à mão" }] },
      },
    } as unknown as BoardConfig;
    const doc = migrateLeanCanvasToBmc(projectLegacyLeanCanvas(config));
    expect(sectionItems(doc, "customerSegments")).toEqual([{ text: "**Leitor** — Leitor frequente", group: "Quem lê" }]);
    expect(sectionItems(doc, "valuePropositions")).toEqual([{ text: "Só acha o mais vendido", group: "Problemas que resolve" }]);
    expect(sectionItems(doc, "keyResources")).toEqual([{ text: "Fichas escritas à mão", group: "Vantagem difícil de copiar" }]);
    savable(doc, BMC_SCHEMA);
  });
});
