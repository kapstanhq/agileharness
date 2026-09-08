// A ponte do formato antigo (board.yaml `canvas:`) para o documento markdown.
//
// O que estes testes protegem é o momento MAIS perigoso da mudança: a primeira leitura de um board
// que ainda não migrou. Se a projeção errar, o operador vê um canvas errado — e o primeiro save
// GRAVA esse erro por cima do que existia.

import { describe, expect, it } from "vitest";
import type { BoardConfig } from "../../types";
import { sectionGroups, sectionItems, serializeSchemaDoc } from "../schema-codec";
import { parseSchemaBody } from "../schema-codec";
import { blockingViolations } from "../doc-schema";
import { LEAN_CANVAS_SCHEMA } from "./lean-canvas";
import { hasLegacyLeanCanvas, projectLegacyLeanCanvas, splitLegacyProse } from "./lean-canvas-legacy";

const config = (canvas: Record<string, unknown>, canvasTags?: unknown): BoardConfig =>
  ({ id: "b", canvas, canvasTags }) as unknown as BoardConfig;

describe("splitLegacyProse — o corte da prosa achatada em itens", () => {
  it("corta por PARÁGRAFO e remove o enumerador (a posição passou a carregá-lo)", () => {
    // A forma real do board hoje.
    expect(splitLegacyProse("1. Primeira dor.\n\n2. Segunda dor.\n\n3. Terceira dor.")).toEqual([
      "Primeira dor.",
      "Segunda dor.",
      "Terceira dor.",
    ]);
  });

  it("corta uma LISTA de linha única por linha", () => {
    expect(splitLegacyProse("- alfa\n- beta\n- gama")).toEqual(["alfa", "beta", "gama"]);
    expect(splitLegacyProse("1) um\n2) dois")).toEqual(["um", "dois"]);
  });

  it("NÃO corta um item bem formado — uma frase é uma frase", () => {
    expect(splitLegacyProse("Uma única ideia, com vírgula e tudo.")).toEqual([
      "Uma única ideia, com vírgula e tudo.",
    ]);
  });

  it("uma frase QUEBRADA em várias linhas (o dobramento do YAML) vira UM item", () => {
    // `>-` no YAML dobra a linha: o texto chega com \n mas é UMA frase. Cortar aqui seria picar
    // uma ideia ao meio — o erro oposto e mais grave.
    expect(splitLegacyProse("Pessoas que precisam transformar\numa ideia em software\nno ar.")).toEqual([
      "Pessoas que precisam transformar uma ideia em software no ar.",
    ]);
  });

  it("texto vazio ou só espaço não vira item nenhum", () => {
    expect(splitLegacyProse("")).toEqual([]);
    expect(splitLegacyProse("   \n\n  ")).toEqual([]);
  });
});

describe("projectLegacyLeanCanvas — a leitura de um board não migrado", () => {
  it("um bloco em prosa achatada vira VÁRIOS itens, não um post-it gigante", () => {
    const doc = projectLegacyLeanCanvas(config({ problem: "1. Uma.\n\n2. Duas.\n\n3. Três." }));
    expect(sectionItems(doc, "problem").map((i) => i.text)).toEqual(["Uma.", "Duas.", "Três."]);
  });

  it("as etiquetas viram o prefixo visível, e só no PRIMEIRO pedaço", () => {
    const doc = projectLegacyLeanCanvas(
      config(
        { problem: { items: [{ id: "i1", text: "Uma.\n\nDuas.", tags: ["pm"] }] } },
        [{ id: "pm", name: "PM", color: "#7c3aed" }],
      ),
    );
    const items = sectionItems(doc, "problem").map((i) => i.text);
    expect(items[0]).toBe("**PM** — Uma.");
    expect(items[1]).toBe("Duas."); // repetir a etiqueta afirmaria uma autoria que não houve
  });

  it("o grupo do item vira o `###` autoral", () => {
    const doc = projectLegacyLeanCanvas(
      config({
        problem: {
          items: [
            { id: "i1", text: "da demanda", group: "Demanda" },
            { id: "i2", text: "da oferta", group: "Oferta" },
          ],
        },
      }),
    );
    expect(sectionGroups(doc, "problem")).toEqual(["Demanda", "Oferta"]);
  });

  it("o item DESTACADO da proposta de valor vai para a primeira posição (o hero vira derivação)", () => {
    const doc = projectLegacyLeanCanvas(
      config({
        uniqueValueProposition: {
          items: [
            { id: "i1", text: "secundária" },
            { id: "i2", text: "A GRANDE", highlight: true },
          ],
        },
      }),
    );
    expect(sectionItems(doc, "uniqueValueProposition")[0].text).toBe("A GRANDE");
  });

  it("as etiquetas do board viram o frontmatter do documento", () => {
    const doc = projectLegacyLeanCanvas(config({}, [{ id: "pm", name: "PM", color: "#7c3aed" }]));
    expect(doc.frontmatter.tags).toEqual([{ id: "pm", name: "PM", color: "#7c3aed" }]);
  });

  it("a projeção é SEMPRE um documento válido — a tela nunca abre com violação que ninguém causou", () => {
    for (const canvas of [{}, { problem: "1. a\n\n2. b" }, { channels: { items: [{ id: "i1", text: "x" }] } }]) {
      const doc = projectLegacyLeanCanvas(config(canvas));
      const md = serializeSchemaDoc(doc, LEAN_CANVAS_SCHEMA);
      const body = md.startsWith("---") ? md.slice(md.indexOf("\n---", 3) + 5) : md;
      expect(
        blockingViolations(parseSchemaBody(body, LEAN_CANVAS_SCHEMA, doc.frontmatter).violations),
        `canvas ${JSON.stringify(canvas)}`,
      ).toEqual([]);
    }
  });

  it("hasLegacyLeanCanvas distingue 'nunca preenchido' de 'tem conteúdo'", () => {
    expect(hasLegacyLeanCanvas(config({}))).toBe(false);
    expect(hasLegacyLeanCanvas(config({ problem: { items: [] } }))).toBe(false);
    expect(hasLegacyLeanCanvas(config({ problem: { items: [{ id: "i1", text: "x" }] } }))).toBe(true);
  });
});
