// Round-trip tests for the BlockNote ⇄ DocModel adapter (see adapter.ts header). Two layers:
//   1. the canonical fixtures (the same ones md-codec.test.ts golden-tests) — the HARD requirement:
//      blockNoteToDoc(docToBlockNote(model.blocks)) must be content-identical to model.blocks.
//   2. one hand-built case per DocBlock kind that the canonical fixtures don't exercise (todo
//      checked, code lang+label, image alt/src, section label/tone/binding, properties JSON,
//      inline bold/italic/code/link combined) — `properties` in particular never appears in
//      canonical markdown (md-codec.ts never serializes it into the body), so it's untested by (1).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocMd } from "@/lib/storymap/doc/md-codec";
import { sameBlockContent, sameDocContent, type DocBlock } from "@/lib/storymap/doc/doc-model";
import { blockNoteToDoc, docToBlockNote } from "./adapter";
import type { DocBlockNoteBlock } from "./schema";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "../../../lib/storymap/doc/__fixtures__", name), "utf8");

const CANONICAL = ["canonical-card.md", "canonical-canvas.md"];

// docToBlockNote's declared return type is PartialBlock (id/children are optional — a live editor
// fills them in on insert). DocEditorImpl always round-trips through a real BlockNoteEditor, which
// performs exactly that Partial→Block normalization; this suite is node-env (no DOM for ProseMirror,
// so no real editor) and chains the two pure functions directly instead — every case in adapter.ts
// already constructs FULLY-EXPANDED content (never the bare-string shorthand), so this cast reflects
// what a real editor would hand back, not a behavior change.
function asFullBlocks(blocks: ReturnType<typeof docToBlockNote>): DocBlockNoteBlock[] {
  return blocks as unknown as DocBlockNoteBlock[];
}

describe("adapter round-trip (canonical fixtures)", () => {
  for (const name of CANONICAL) {
    it(`round-trips ${name} content-identical through BlockNote`, () => {
      const model = parseDocMd(fixture(name));
      const roundTripped = blockNoteToDoc(asFullBlocks(docToBlockNote(model.blocks)));
      expect(sameDocContent({ ...model, blocks: roundTripped }, model)).toBe(true);
    });
  }
});

describe("adapter unit cases (per kind)", () => {
  function roundTrip(block: DocBlock): DocBlock {
    const [result] = blockNoteToDoc(asFullBlocks(docToBlockNote([block])));
    return result;
  }

  it("round-trips a checked todo", () => {
    const block: DocBlock = { kind: "todo", id: "x", text: "feito", checked: true };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips an unchecked todo", () => {
    const block: DocBlock = { kind: "todo", id: "x", text: "a fazer", checked: false };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips code with lang + label", () => {
    const block: DocBlock = {
      kind: "code",
      id: "x",
      lang: "text",
      label: "system-prompt · recs",
      text: "linha 1\nlinha 2",
    };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips code with lang only (no label)", () => {
    const block: DocBlock = { kind: "code", id: "x", lang: "ts", text: "const x = 1;" };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips image alt/src", () => {
    const block: DocBlock = { kind: "image", id: "x", alt: "mockup — card de evento", src: "docs/mockup-card.png" };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips a section's label/tone/binding + nested body", () => {
    const block: DocBlock = {
      kind: "section",
      id: "x",
      tone: "hero",
      label: "Decisão",
      body: [
        { kind: "paragraph", id: "y", text: "corpo da decisão" },
        { kind: "bullet", id: "z", text: "primeiro ponto" },
      ],
      binding: "campo.decisao",
    };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips a section with no binding (undefined stays undefined)", () => {
    const block: DocBlock = {
      kind: "section",
      id: "x",
      tone: "neutral",
      label: "Nota",
      body: [{ kind: "paragraph", id: "y", text: "sem binding" }],
    };
    const result = roundTrip(block);
    expect(result.kind === "section" && result.binding).toBeUndefined();
    expect(sameBlockContent(result, block)).toBe(true);
  });

  it("round-trips properties entries (JSON)", () => {
    const block: DocBlock = {
      kind: "properties",
      id: "x",
      entries: [
        { key: "status", label: "Status", icon: "Circle", value: { kind: "status", text: "Ativo", color: "#4FA873" } },
        { key: "owner", label: "Responsável", value: { kind: "text", text: "Jonatas" } },
        { key: "tags", label: "Tags", value: { kind: "chips", chips: [{ text: "a" }, { text: "b", color: "#000" }] } },
      ],
    };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips inline bold/italic/code/link within one paragraph", () => {
    const block: DocBlock = {
      kind: "paragraph",
      id: "x",
      text: "um **negrito**, um *itálico*, um `código` e um [link](https://x.test)",
    };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips inline strikethrough", () => {
    const block: DocBlock = { kind: "paragraph", id: "x", text: "isto ~~não vale mais~~ isto sim" };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips a toggle's title + nested children", () => {
    const block: DocBlock = {
      kind: "toggle",
      id: "x",
      title: "Ver detalhes",
      children: [{ kind: "paragraph", id: "y", text: "conteúdo escondido" }],
    };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });

  it("round-trips a table's header + rows", () => {
    const block: DocBlock = {
      kind: "table",
      id: "x",
      header: ["Métrica", "Alvo"],
      rows: [
        ["Salvam ≥1 evento", "≥ 40%"],
        ["Recomendações abertas", "≥ 3"],
      ],
    };
    expect(sameBlockContent(roundTrip(block), block)).toBe(true);
  });
});
