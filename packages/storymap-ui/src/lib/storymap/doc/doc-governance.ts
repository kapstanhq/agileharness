// 🏛️ Os artefatos governados que vivem num DOCUMENTO — o par ler/aplicar que a casca usa.
//
// Dois artefatos de `GOVERNANCE_ARTIFACTS` não são campos do `board.yaml`: o **PRD** (sempre) e o
// **Lean Canvas** (depois de o `.md` dele existir). `applyGovernanceChange` (puro, sobre
// `BoardConfig`) não sabe — e não deve saber — escrever em disco; então a parte que precisa de I/O
// mora aqui.
//
// A REGRA que decide qual caminho vale, e ela é uma só: **escreva onde `loadDoc` LÊ.** Para o PRD
// isso é sempre o `.md` (a escada do YAML é só a projeção legada). Para o canvas depende: enquanto
// o `docs/lean-canvas.md` não existir, `loadDoc` projeta do `board.yaml` e o YAML É o canônico —
// materializar o `.md` a partir de uma aprovação deixaria o campo `canvas:` sendo lido por quem
// projeta e escrito por mais ninguém.
//
// A regra que este arquivo existe para garantir: **o caminho governado grava exatamente onde o
// caminho da tela grava** — os mesmos bytes, o mesmo `writeSchemaDoc`, a mesma validação de schema.
// O Lean Canvas tem hoje o defeito oposto (a governança escreve o campo `canvas:` do YAML enquanto
// `loadDoc`, depois da migração, lê só o `.md`, e nada reconcilia os dois). Uma proposta aprovada que
// não muda o que o leitor lê é pior que uma proposta recusada: ela reporta sucesso.
//
// SERVIDOR (`loadDoc`/`writeSchemaDoc` tocam disco).

import { loadDoc, schemaDocExists, writeSchemaDoc } from "./schema-doc-io";
import { PRD_SCHEMA, PRD_DOC_TYPE } from "./schemas/prd";
import { LEAN_CANVAS_SCHEMA } from "./schemas/lean-canvas";
import { sectionBlocks } from "./schemas/lean-canvas-legacy";
import { parseSchemaBody, replaceSectionBlocks, serializeSchemaDoc, sectionContent, type SchemaDoc } from "./schema-codec";
import { serializeDocMd } from "./md-codec";
import { blockIdFactory } from "./doc-model";
import { coerceCanvasBlock } from "../canvas";
import type { DocSchema } from "./doc-schema";
import type { BoardConfig, CanvasTag } from "../types";

/**
 * O mapa artefato → documento. `undefined` ⇒ o artefato é campo do `board.yaml` e segue o caminho de
 * config. Uma entrada aqui é a ÚNICA coisa que um artefato governado novo precisa declarar.
 */
export function governedDoc(artifact: string): { schema: DocSchema; as: "section" | "tags" } | undefined {
  if (artifact === "prd") return { schema: PRD_SCHEMA, as: "section" };
  if (artifact === "canvas") return { schema: LEAN_CANVAS_SCHEMA, as: "section" };
  if (artifact === "canvasTags") return { schema: LEAN_CANVAS_SCHEMA, as: "tags" };
  return undefined;
}

/**
 * O DOCUMENTO é o canônico deste artefato agora? É a pergunta que decide o caminho da escrita, e ela
 * tem de dar exatamente a mesma resposta que `loadDoc` dá ao LER — senão a aprovação grava num lugar
 * e o leitor lê de outro, que é o defeito que este módulo existe para não repetir.
 */
export async function docIsCanonical(boardId: string, artifact: string): Promise<boolean> {
  const alvo = governedDoc(artifact);
  if (!alvo) return false;
  // O PRD nasceu markdown: mesmo sem o arquivo, `loadDoc` devolve a projeção e o primeiro save
  // materializa — a escada do YAML nunca foi lida por ninguém depois desta migração.
  if (alvo.schema.docType === PRD_DOC_TYPE) return true;
  return schemaDocExists(boardId, alvo.schema);
}

/** A seção existe no schema do PRD? Fail-closed: quem propõe uma chave inventada é RECUSADO. */
export function isPrdSection(field: string | null | undefined): boolean {
  return typeof field === "string" && PRD_SCHEMA.sections.some((s) => s.key === field);
}

/** As chaves válidas — a recusa enumera, em vez de só dizer "não". */
export function prdSectionKeys(): string[] {
  return PRD_SCHEMA.sections.map((s) => s.key);
}

/**
 * O conteúdo ATUAL de uma seção, em markdown — o `before` de uma proposta e o lado canônico do
 * guard de conflito. String vazia quando a seção não existe no documento (é um estado legítimo:
 * seção opcional nunca escrita), nunca `undefined`, para o `JSON.stringify` da comparação não
 * distinguir "vazia" de "ausente" — que para o autor são a mesma coisa.
 */
export async function readPrdSection(boardId: string, field: string, config?: BoardConfig): Promise<string> {
  return readGovernedValue(boardId, "prd", field, config) as Promise<string>;
}

/**
 * O valor ATUAL de um artefato governado que vive em documento — o `before` de uma proposta e o lado
 * canônico do guard de conflito. Seção ⇒ o markdown do corpo; tags ⇒ a lista do frontmatter.
 *
 * String vazia (e não `undefined`) quando a seção não existe: para o autor, "vazia" e "ausente" são
 * a mesma coisa, e o `JSON.stringify` da comparação não pode distingui-las.
 */
export async function readGovernedValue(
  boardId: string,
  artifact: string,
  field: string | null | undefined,
  config?: BoardConfig,
): Promise<unknown> {
  const alvo = governedDoc(artifact);
  if (!alvo) return undefined;
  const loaded = await loadDoc(boardId, alvo.schema.docType, config).catch(() => undefined);
  if (!loaded) return alvo.as === "tags" ? [] : "";

  if (alvo.as === "tags") return loaded.doc.frontmatter.tags ?? [];

  const secao = field ? sectionContent(loaded.doc, field) : undefined;
  if (!secao) return "";
  return serializeDocMd({ docType: alvo.schema.docType, title: "", blocks: secao.blocks }, { includeTitle: false }).trim();
}

/**
 * Grava o conteúdo de UMA seção do PRD. `after` é o markdown do corpo da seção (sem o heading — o
 * rótulo é travado e vem do schema, então nem o proponente nem o aprovador podem trocá-lo).
 *
 * Passa pelo MESMO `writeSchemaDoc` da tela, que re-parseia os bytes que vão aterrissar e recusa por
 * violação de esqueleto. Uma proposta aprovada não tem passe livre para quebrar o documento.
 */
export async function applyPrdSection(
  boardId: string,
  field: string,
  after: unknown,
  config?: BoardConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return applyGovernedChange(boardId, "prd", field, after, config);
}

/**
 * Grava um artefato governado que vive em documento, pelo MESMO `writeSchemaDoc` que a tela usa —
 * que reparseia os bytes que vão aterrissar e recusa por violação de esqueleto. Uma proposta
 * aprovada não tem passe livre para quebrar o documento.
 */
export async function applyGovernedChange(
  boardId: string,
  artifact: string,
  field: string | null | undefined,
  after: unknown,
  config?: BoardConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const alvo = governedDoc(artifact);
  if (!alvo) return { ok: false, error: `"${artifact}" não é um artefato de documento.` };

  const loaded = await loadDoc(boardId, alvo.schema.docType, config);
  if (!loaded) return { ok: false, error: `O documento "${alvo.schema.docType}" deste board não pôde ser lido.` };

  // ── TAGS (o frontmatter do canvas) ─────────────────────────────────────────
  // `write_doc` não alcança o frontmatter de propósito (é o que a máquina roteia). A governança
  // alcança porque a lista de etiquetas É dado autoral e não existe outra porta para ela.
  if (alvo.as === "tags") {
    const tags = Array.isArray(after) ? after : [];
    const proximo = { ...loaded.doc, frontmatter: { ...loaded.doc.frontmatter, tags } };
    return gravar(boardId, alvo.schema, proximo);
  }

  const rule = alvo.schema.sections.find((s) => s.key === field);
  if (!rule) {
    const validas = alvo.schema.sections.map((s) => s.key).join(", ");
    return { ok: false, error: `Seção desconhecida em "${alvo.schema.docType}": "${field}". As válidas: ${validas}.` };
  }

  // ── CANVAS: `after` é `{items:[…]}`, não markdown ───────────────────────────
  // A conversão passa pelo MESMO `sectionBlocks` da projeção legada. Uma segunda conversão aqui
  // divergiria da primeira, e a que diverge é justamente a que ninguém olha.
  if (alvo.schema !== PRD_SCHEMA) {
    const tags = (loaded.doc.frontmatter.tags ?? config?.canvasTags ?? []) as CanvasTag[];
    const itens = coerceCanvasBlock(after)?.items ?? [];
    const blocos = sectionBlocks(itens, tags, blockIdFactory());
    return gravar(boardId, alvo.schema, replaceSectionBlocks(loaded.doc, rule.key, blocos, alvo.schema));
  }

  // ── PRD: `after` é o markdown do CORPO da seção ─────────────────────────────
  const corpo = typeof after === "string" ? after.trim() : "";
  // Re-parseia pelo esqueleto: o corpo entra sob o heading TRAVADO da seção, e é o parser do schema
  // — não uma concatenação de strings — que decide o que aquele texto vira (itens, grupos, prosa).
  //
  // Uma seção de NÍVEL 3 precisa do pai por cima no texto de rascunho. Sem ele o parser vê uma
  // subseção ÓRFÃ (`orphan-subsection`) e devolve a seção vazia — o `resultadoAlvo` aterrissava como
  // nada, calado, e o teste dos itens foi quem pegou. O pai é só andaime: `replaceSectionBlocks`
  // abaixo troca exclusivamente os blocos da seção pedida.
  const pai = rule.parent ? PRD_SCHEMA.sections.find((s) => s.key === rule.parent) : undefined;
  const andaime = pai ? `${"#".repeat(pai.level)} ${pai.label}\n\n` : "";
  const { doc: parsed } = parseSchemaBody(
    `${andaime}${"#".repeat(rule.level)} ${rule.label}\n\n${corpo}\n`,
    PRD_SCHEMA,
    loaded.doc.frontmatter,
  );
  const blocos = sectionContent(parsed, rule.key)?.blocks ?? [];
  const proximo = replaceSectionBlocks(loaded.doc, rule.key, blocos, PRD_SCHEMA);

  return gravar(boardId, PRD_SCHEMA, proximo);
}

/** A gravação, com a recusa do schema traduzida — o único ponto que toca `writeSchemaDoc` daqui. */
async function gravar(boardId: string, schema: DocSchema, doc: SchemaDoc): Promise<{ ok: true } | { ok: false; error: string }> {
  const escrito = await writeSchemaDoc(boardId, schema, doc);
  if (!escrito.ok) {
    const motivos = (escrito.violations ?? []).map((v) => v.message).join(" · ");
    return { ok: false, error: `A gravação de "${schema.docType}" foi recusada pelo schema${motivos ? `: ${motivos}` : "."}` };
  }
  return { ok: true };
}

/** O documento inteiro em markdown — para o diff que o operador lê no Inbox antes de aprovar. */
export async function readPrdMarkdown(boardId: string, config?: BoardConfig): Promise<string> {
  const loaded = await loadDoc(boardId, PRD_DOC_TYPE, config).catch(() => undefined);
  return loaded ? serializeSchemaDoc(loaded.doc, PRD_SCHEMA) : "";
}
