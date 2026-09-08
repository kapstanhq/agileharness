// Golden + invariant tests for the canonical markdown ⇄ DocModel codec.
//
// The two laws (see md-codec.ts header):
//   1. IDEMPOTENCY — serialize(parse(x)) is a fixed point for ANY input (adversarial included).
//   2. IDENTITY — canonical fixtures reproduce byte-for-byte (verbatim inline + canonical structure).
// Breaking either law silently rewrites board-data bodies on save and pollutes git diffs — treat a
// red here as a codec bug, never as a fixture to "update until green".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocMd, serializeBlockMd, serializeDocMd } from "./md-codec";
import { DocModelSchema, sameDocContent, type DocBlock } from "./doc-model";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", name), "utf8");

const CANONICAL = ["canonical-card.md", "canonical-canvas.md"];
const ALL = [...CANONICAL, "adversarial.md"];

describe("md-codec invariants", () => {
  for (const name of ALL) {
    it(`idempotency: ${name}`, () => {
      const md = fixture(name);
      const once = serializeDocMd(parseDocMd(md));
      const twice = serializeDocMd(parseDocMd(once));
      expect(twice).toBe(once);
    });

    it(`model validates + parse(serialize) preserves content: ${name}`, () => {
      const model = parseDocMd(fixture(name));
      expect(DocModelSchema.safeParse(model).success).toBe(true);
      const reparsed = parseDocMd(serializeDocMd(model));
      expect(sameDocContent(reparsed, parseDocMd(serializeDocMd(reparsed)))).toBe(true);
    });
  }

  for (const name of CANONICAL) {
    it(`identity (byte-for-byte): ${name}`, () => {
      const md = fixture(name);
      expect(serializeDocMd(parseDocMd(md))).toBe(md);
    });
  }
});

describe("block shapes", () => {
  const card = parseDocMd(fixture("canonical-card.md"));
  const kinds = card.blocks.map((b) => b.kind);

  it("parses the card fixture into the expected block sequence", () => {
    expect(kinds).toEqual([
      "heading",
      "paragraph",
      "heading",
      "paragraph",
      "paragraph",
      "bullet",
      "bullet",
      "bullet",
      "paragraph",
      "bullet",
      "divider",
      "heading",
      "todo",
      "todo",
      "todo",
      "toggle",
      "heading",
      "table",
      "quote",
      "heading",
      "code",
      "image",
    ]);
  });

  it("todo checked state + verbatim inline (escapes untouched)", () => {
    const todos = card.blocks.filter((b): b is Extract<DocBlock, { kind: "todo" }> => b.kind === "todo");
    expect(todos.map((t) => t.checked)).toEqual([true, false, false]);
    expect(todos[1].text).toContain('("porque você curtiu…")');
  });

  it("toggle children include paragraphs", () => {
    const toggle = card.blocks.find((b): b is Extract<DocBlock, { kind: "toggle" }> => b.kind === "toggle");
    expect(toggle?.title).toBe("Decisões e trade-offs (q1, q2)");
    expect(toggle?.children.map((c) => c.kind)).toEqual(["paragraph", "paragraph"]);
  });

  it("code keeps lang + label from the info string", () => {
    const code = card.blocks.find((b): b is Extract<DocBlock, { kind: "code" }> => b.kind === "code");
    expect(code?.lang).toBe("text");
    expect(code?.label).toBe("system-prompt · recs");
    expect(code?.text).toContain("Máx. 3 por resposta");
  });

  it("table header + rows as verbatim cells", () => {
    const table = card.blocks.find((b): b is Extract<DocBlock, { kind: "table" }> => b.kind === "table");
    expect(table?.header).toEqual(["Métrica", "Alvo", "Atual"]);
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[0][1]).toBe("≥ 40%");
  });

  it("standalone image paragraph upgrades to image block", () => {
    const image = card.blocks.find((b): b is Extract<DocBlock, { kind: "image" }> => b.kind === "image");
    expect(image?.src).toBe("docs/mockup-card.png");
    expect(image?.alt).toContain("mockup");
  });
});

describe("section upgrade rule", () => {
  const canvas = parseDocMd(fixture("canonical-canvas.md"));

  it("blockquote with bold-only first line becomes a section; plain blockquote stays quote", () => {
    const sections = canvas.blocks.filter(
      (b): b is Extract<DocBlock, { kind: "section" }> => b.kind === "section",
    );
    expect(sections.map((s) => s.label)).toEqual([
      "Early adopters",
      "Alternativas hoje",
      "Conceito de alto nível",
    ]);
    expect(sections[0].body.map((b) => b.kind)).toEqual(["paragraph"]);
    expect(canvas.blocks.some((b) => b.kind === "quote")).toBe(false);
  });

  it("numbered list round-trips with sequential renumbering", () => {
    const numbered = canvas.blocks.filter((b) => b.kind === "numbered");
    expect(numbered).toHaveLength(3);
    const out = serializeDocMd(canvas);
    expect(out).toContain("1. % de novos");
    expect(out).toContain("2. Organizadores ativos");
  });
});

describe("adversarial corpus", () => {
  const model = parseDocMd(fixture("adversarial.md"));

  it("section nested inside toggle survives", () => {
    const toggle = model.blocks.find(
      (b): b is Extract<DocBlock, { kind: "toggle" }> => b.kind === "toggle",
    );
    expect(toggle?.children.some((c) => c.kind === "section")).toBe(true);
  });

  it("escaped pipe stays verbatim in table cells", () => {
    const table = model.blocks.find((b): b is Extract<DocBlock, { kind: "table" }> => b.kind === "table");
    expect(table?.header[0]).toBe("Coluna com \\| pipe");
    expect(table?.rows[0][0]).toBe("a \\| b");
  });

  it("paragraph + `---` without blank line = setext heading (canonicalized, then stable)", () => {
    const heading = model.blocks.find(
      (b): b is Extract<DocBlock, { kind: "heading" }> =>
        b.kind === "heading" && b.text.startsWith("Parágrafo imediatamente"),
    );
    expect(heading?.level).toBe(2);
  });

  it("empty toggle and unclosed details both survive round-trip", () => {
    const toggles = model.blocks.filter(
      (b): b is Extract<DocBlock, { kind: "toggle" }> => b.kind === "toggle",
    );
    expect(toggles.some((t) => t.children.length === 0)).toBe(true);
    // unclosed <details> falls back to an opaque paragraph — never swallows following content
    expect(
      model.blocks.some((b) => b.kind === "paragraph" && b.text.includes("Detalhes nunca fechados")),
    ).toBe(true);
    expect(
      model.blocks.some(
        (b) => b.kind === "paragraph" && b.text.includes("Texto depois de um details malformado"),
      ),
    ).toBe(true);
  });

  it("nested list stays inside its parent bullet (indent preserved)", () => {
    const bullet = model.blocks.find(
      (b): b is Extract<DocBlock, { kind: "bullet" }> =>
        b.kind === "bullet" && b.text.startsWith("item com lista aninhada"),
    );
    expect(bullet?.text).toContain("- filho um");
    const out = serializeDocMd(model);
    expect(out).toContain("- item com lista aninhada\n  - filho um");
  });

  it("multi-paragraph quote keeps both paragraphs", () => {
    const quote = model.blocks.find((b): b is Extract<DocBlock, { kind: "quote" }> => b.kind === "quote");
    expect(quote?.text).toContain("Citação simples");
    expect(quote?.text).toContain("Segundo parágrafo");
  });
});

describe("stripTitle (a visão Markdown: `# Título` é o título, não um bloco)", () => {
  it("lê o `#` de abertura como título do modelo e o tira dos blocos", () => {
    const out = parseDocMd("# O selo perde o significado\n\nCorpo do documento.\n", { stripTitle: true });
    expect(out.title).toBe("O selo perde o significado");
    expect(out.blocks.map((b) => b.kind)).toEqual(["paragraph"]);
  });

  it("é o INVERSO exato de serializeDocMd({includeTitle}) — ida e volta sem perda", () => {
    const model = {
      docType: "generic",
      title: "Um título",
      blocks: [{ kind: "paragraph", id: "b1", text: "Um parágrafo." }] as DocBlock[],
    };
    const round = parseDocMd(serializeDocMd(model, { includeTitle: true }), { stripTitle: true });
    expect(round.title).toBe(model.title);
    expect(sameDocContent({ ...round, docType: "generic" }, model)).toBe(true);
  });

  it("DESLIGADO por padrão: um corpo que abre com `#` mantém o heading (não é um documento)", () => {
    const out = parseDocMd("# Ainda é conteúdo\n\ntexto\n");
    expect(out.title).toBe("");
    expect(out.blocks[0].kind).toBe("heading");
  });

  it("só o nível 1 vira título — um `##` de abertura continua sendo seção", () => {
    const out = parseDocMd("## Estado atual\n\ntexto\n", { stripTitle: true });
    expect(out.title).toBe("");
    expect(out.blocks[0].kind).toBe("heading");
  });
});

describe("serializeBlockMd (grip menu: Copiar como Markdown)", () => {
  it("serializes a single block through the canonical printer", () => {
    expect(serializeBlockMd({ kind: "todo", id: "b1", text: "fazer x", checked: true })).toBe(
      "- [x] fazer x",
    );
    expect(
      serializeBlockMd({
        kind: "section",
        id: "b2",
        label: "Nota",
        tone: "neutral",
        body: [{ kind: "paragraph", id: "b3", text: "corpo" }],
      }),
    ).toBe("> **Nota**\n> corpo");
  });
});

describe("todo do GFM — o marcador nunca é conteúdo", () => {
  // Defeito MEDIDO (e vivido: o PRD do board saiu com `- [ ] [ ] …`). Quando o item de tarefa começa
  // com um nó inline, o span do parágrafo começa no `[` e o marcador entra no texto; a serialização
  // então o acrescenta de novo, e cada ciclo ler→gravar ganha mais um. O caso de TEXTO PURO sempre
  // funcionou — é por isso que a sonda óbvia não acha nada.
  const texto = (md: string) => {
    const b = parseDocMd(md).blocks[0];
    return b && "text" in b ? `${b.kind}|${b.text}` : "(nada)";
  };

  it("texto puro (o caso que sempre funcionou)", () => {
    expect(texto("- [ ] texto simples")).toBe("todo|texto simples");
  });

  it("começando com negrito, itálico ou code — os três vazavam o marcador", () => {
    expect(texto("- [ ] **negrito** e resto")).toBe("todo|**negrito** e resto");
    expect(texto("- [ ] *itálico* e resto")).toBe("todo|*itálico* e resto");
    expect(texto("- [ ] `code` e resto")).toBe("todo|`code` e resto");
    expect(texto("- [x] **feito**")).toBe("todo|**feito**");
  });

  it("ler e re-serializar NÃO multiplica o marcador", () => {
    const um = "- [ ] **A premissa** que cancela tudo.\n";
    const duas = serializeDocMd(parseDocMd(serializeDocMd(parseDocMd(um))));
    expect(duas.trim()).toBe(um.trim());
  });

  it("um colchete que NÃO é marcador continua sendo conteúdo", () => {
    expect(texto("- [ ] [nota] segue texto")).toBe("todo|[nota] segue texto");
  });
});
