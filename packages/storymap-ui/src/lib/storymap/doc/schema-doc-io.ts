// 📐 schema-doc-io — o lado de SERVIDOR dos documentos de board (Camada 1: os bytes).
//
// É aqui, e só aqui, que um documento de schema toca o disco. Existe separado do `schema-codec`
// (puro) por duas razões que não são de estilo:
//
//   1. O CHOKEPOINT de segurança. `parseFrontmatter` (frontmatter.ts) é o ÚNICO caminho permitido
//      para parsear bytes de board não-confiáveis — há lint mecânico provando que nenhum módulo de
//      `src/` chama `matter()`/`yaml.load()` fora dele. Concentrar o split aqui mantém essa fronteira
//      intacta e deixa o codec importável pelo cliente.
//   2. O BUNDLE. O cliente importa o codec e o schema para montar as views; arrastar `node:fs` e
//      gray-matter junto reprova o `next build` — e o `tsc --noEmit` NÃO pega isso.
//
// A escrita é a mesma primitiva atômica do resto do board (`atomicWriteFile`: stage + rename(2)),
// então um leitor concorrente — o watcher, uma server action, um agente no meio de um poll — nunca
// enxerga um frontmatter pela metade.

import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../atomic-write";
import { FrontmatterError, describeFrontmatterError, parseFrontmatter } from "../frontmatter";
import { boardDocPath, boardDocsDir } from "../paths";
import { readBoardConfig } from "../repo";
import type { BoardConfig } from "../types";
import { docEntry } from "./doc-registry";
import { blockingViolations, violation, type DocSchema, type SchemaViolation } from "./doc-schema";
import { emptySchemaDoc, parseSchemaBody, serializeSchemaDoc, type SchemaDoc } from "./schema-codec";

export interface ReadSchemaDocResult {
  doc: SchemaDoc;
  violations: SchemaViolation[];
  /** false ⇒ o arquivo ainda não existe e `doc` é o esqueleto vazio (um documento novo, válido). */
  exists: boolean;
  /** os bytes exatos do disco — o que a view de fonte mostra e o que o round-trip compara. */
  raw: string;
}

/**
 * Lê o documento. Arquivo ausente NÃO é erro: devolve o esqueleto vazio do schema, que é o estado
 * legítimo de "esta entidade ainda não foi escrita" — a tela abre no empty-state em vez de num 404.
 */
export async function readSchemaDoc(boardId: string, schema: DocSchema): Promise<ReadSchemaDocResult> {
  const file = boardDocPath(boardId, schema.docType);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { doc: emptySchemaDoc(schema), violations: [], exists: false, raw: "" };
    }
    throw err;
  }

  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(raw, `${boardId}/docs/${schema.docType}.md`);
    frontmatter = parsed.data;
    body = parsed.content;
  } catch (err) {
    // Frontmatter recusado (YAML inválido, teto estourado, token de linguagem) NUNCA vira mapa
    // vazio silencioso: o documento volta legível pelo corpo e a recusa vira violação nomeada, para
    // a tela poder mostrar o que está errado em vez de perder o cabeçalho sem avisar.
    const detail = err instanceof FrontmatterError ? err.message : describeFrontmatterError(err);
    const result = parseSchemaBody(stripFrontmatterBlock(raw), schema, {});
    return {
      doc: result.doc,
      violations: [violation("frontmatter-invalid", `O cabeçalho do documento não pôde ser lido — ${detail}`), ...result.violations],
      exists: true,
      raw,
    };
  }

  const { doc, violations } = parseSchemaBody(body, schema, frontmatter);
  return { doc, violations, exists: true, raw };
}

export interface WriteSchemaDocResult {
  ok: boolean;
  /** presente quando `ok: false` — as violações que RECUSARAM a escrita. */
  violations?: SchemaViolation[];
  error?: string;
}

/**
 * Grava o documento — validando ANTES, e recusando quando o esqueleto está quebrado.
 *
 * A política é recusar, nunca auto-reparar: injetar de volta uma seção que a pessoa acabou de apagar
 * é apagar a decisão dela em silêncio. Quem quiser o esqueleto de volta chama `ensureSkeleton`, que
 * é um gesto explícito com nome.
 *
 * Esta é a TERCEIRA porta de travamento (editor rico e fonte markdown são as outras duas): um agente
 * ou uma tool de MCP escrevendo direto passa por aqui e obedece às mesmas regras. Sem esta, o
 * travamento seria só uma sugestão visual.
 */
export async function writeSchemaDoc(
  boardId: string,
  schema: DocSchema,
  doc: SchemaDoc,
): Promise<WriteSchemaDocResult> {
  const markdown = serializeSchemaDoc(doc, schema);

  // Valida o que SERÁ gravado (não o que o chamador acha que montou): a única leitura que importa é
  // a dos bytes finais, e é ela que o próximo leitor vai fazer.
  const check = parseSchemaBody(stripFrontmatterBlock(markdown), schema, doc.frontmatter);
  const blocking = blockingViolations(check.violations);
  if (blocking.length) {
    return {
      ok: false,
      violations: blocking,
      error: blocking.map((v) => v.message).join(" · "),
    };
  }

  const file = boardDocPath(boardId, schema.docType);
  await fs.mkdir(boardDocsDir(boardId), { recursive: true });
  await atomicWriteFile(file, markdown);
  return { ok: true };
}

export interface LoadDocResult extends ReadSchemaDocResult {
  schema: DocSchema;
}

/**
 * O CAMINHO ÚNICO para obter um documento — disco, com a projeção do legado como piso.
 *
 * Existe para que ninguém precise lembrar da migração preguiçosa. Quem lesse só `readSchemaDoc` num
 * board ainda não migrado receberia o esqueleto VAZIO e o trataria como verdade: a tela abriria em
 * branco, e — pior — um agente que escrevesse ali gravaria um `.md` vazio POR CIMA de um canvas
 * inteiro que ainda vivia no `board.yaml`. A regra fica num lugar só, e é este.
 *
 * `undefined` para docType desconhecido — o chamador recusa (fail-closed).
 */
export async function loadDoc(boardId: string, docType: string, config?: BoardConfig): Promise<LoadDocResult | undefined> {
  const entry = docEntry(docType);
  if (!entry) return undefined;
  const read = await readSchemaDoc(boardId, entry.schema);
  if (read.exists || !entry.legacyProject) return { ...read, schema: entry.schema };
  const resolved = config ?? (await readBoardConfig(boardId));
  return { ...read, schema: entry.schema, doc: entry.legacyProject(resolved), violations: [] };
}

/** O documento existe em disco? (a migração pergunta isto para não sobrescrever.) */
export async function schemaDocExists(boardId: string, schema: DocSchema): Promise<boolean> {
  try {
    await fs.stat(boardDocPath(boardId, schema.docType));
    return true;
  } catch {
    return false;
  }
}

/** Onde o documento mora — para mensagens e para o agente citar o caminho. */
export function schemaDocRelPath(boardId: string, schema: DocSchema): string {
  return path.posix.join("storymap", "boards", boardId, "docs", `${schema.docType}.md`);
}

/**
 * Remove o bloco de frontmatter por TEXTO, sem parseá-lo — usado nos dois caminhos em que o mapa já
 * é conhecido (ou já foi recusado) e só o corpo interessa. Não é um parser: é um corte na primeira
 * ocorrência do delimitador de fechamento, exatamente como o gray-matter delimita.
 */
function stripFrontmatterBlock(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const after = raw.indexOf("\n", end + 1);
  return after === -1 ? "" : raw.slice(after + 1);
}
