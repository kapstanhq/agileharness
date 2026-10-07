// 📄 As regras PURAS da página de documento (doc/DocPage) — fora do .tsx para o teste importá-las de verdade (o rig
// deste pacote não carrega .tsx).

import { BMC_DOC_TYPE } from "@/lib/storymap/doc/schemas/business-model-canvas";
import { blockIdFactory, type DocBlock, type DocModel } from "@/lib/storymap/doc/doc-model";
import type { DocSchema } from "@/lib/storymap/doc/doc-schema";
import { schemaDocToModel, type SchemaDoc } from "@/lib/storymap/doc/schema-codec";

/** A vista FIXA de cada documento. O canvas é um quadro (nove blocos); o resto se lê como documento. */
export function docPageLayout(docType: string): "quadro" | "documento" {
  return docType === BMC_DOC_TYPE ? "quadro" : "documento";
}

/** A linha de estado, em palavras. */
export function docStatusLine(input: { editing: boolean; dirty: boolean; saving: boolean; errors: number }): string {
  if (input.saving) return "Salvando…";
  if (input.errors > 0) return input.errors === 1 ? "1 problema impede de salvar" : `${input.errors} problemas impedem de salvar`;
  if (input.dirty) return "Alterações não salvas";
  return input.editing ? "Editando — nada mudou ainda" : "Salvo";
}

/** Um bloco que DIZ algo — um parágrafo vazio (o que o esqueleto deixa numa seção nova) não conta. */
function hasContent(block: DocBlock): boolean {
  if (block.kind === "paragraph" || block.kind === "bullet" || block.kind === "numbered" || block.kind === "todo" || block.kind === "quote") {
    return block.text.trim().length > 0;
  }
  if (block.kind === "heading") return false; // um `###` sozinho é a casca de um grupo, não conteúdo
  if (block.kind === "section") return block.body.some(hasContent);
  if (block.kind === "toggle") return block.title.trim().length > 0 || block.children.some(hasContent);
  return true;
}

/** O documento ainda não tem uma linha escrita (todas as seções vazias, nada no fim)? */
export function isSchemaDocEmpty(doc: SchemaDoc): boolean {
  return !doc.sections.some((s) => s.blocks.some(hasContent)) && !doc.tail.some(hasContent);
}

/**
 * A LEITURA de um documento de schema com a DICA de cada seção vazia logo abaixo do título dela, como legenda discreta
 * (um `section` de tom `note`, sem corpo) — o que diz à pessoa o que escrever ali, em vez de sete títulos soltos. A
 * seção com conteúdo sai como sempre saiu.
 */
export function readModelWithHints(doc: SchemaDoc, schema: DocSchema): DocModel {
  const model = schemaDocToModel(doc, schema);
  const empty = new Set(doc.sections.filter((s) => !s.blocks.some(hasContent)).map((s) => s.key));
  const hintByLabel = new Map(schema.sections.filter((r) => empty.has(r.key) && r.hint).map((r) => [r.label, r.hint] as const));
  if (!hintByLabel.size) return model;
  const nextId = blockIdFactory();
  const blocks: DocBlock[] = [];
  for (const block of model.blocks) {
    blocks.push(block);
    const hint = block.kind === "heading" && block.level === 2 ? hintByLabel.get(block.text) : undefined;
    if (hint) blocks.push({ kind: "section", id: `hint-${nextId()}`, label: hint, tone: "note", body: [] });
  }
  return { ...model, blocks };
}
