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
import { appendMigratedContexto, isPrdV1, migratePrdV1, parsePrdV1 } from "./migrations";
import { emptySchemaDoc, parseSchemaBody, serializeSchemaDoc, type SchemaDoc } from "./schema-codec";
import { CONTEXTO_DOC_TYPE, CONTEXTO_SCHEMA } from "./schemas/contexto";
import { PRD_DOC_TYPE, PRD_FORMAT } from "./schemas/prd";
import { prdFeatureEntries, type PrdFeature } from "./prd-features";
import type { FeatureRemapDeps } from "../feature-remap";

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
  /**
   * Os arquivos que a gravação do PRD gravou ANTES dele, relativos a `docs/` — o `contexto.md` e a cópia
   * do formato 1 em `.archive/` quando havia um PRD antigo no disco. Ausente ⇒ nada além do documento.
   */
  carried?: string[];
}

export interface WriteSchemaDocOptions {
  /** a data do sufixo da cópia arquivada (testes fixam). */
  now?: Date;
  /** uma linha por arquivo carregado junto (a migração do boot passa o seu log). */
  log?: (line: string) => void;
  /** TESTE — o disco da remarcação de funcionalidades (feature-remap.ts); ausente ⇒ os cards de verdade. */
  featureRemapDeps?: FeatureRemapDeps;
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
  input: SchemaDoc,
  opts: WriteSchemaDocOptions = {},
): Promise<WriteSchemaDocResult> {
  // O PRD sai SEMPRE carimbado com o formato: é o carimbo que diz à migração "este já é o novo" —
  // sem ele, um PRD gravado pela tela seria reprocessado como formato 1 no próximo boot.
  const doc =
    schema.docType === PRD_DOC_TYPE
      ? { ...input, frontmatter: { ...input.frontmatter, doc: PRD_DOC_TYPE, format: PRD_FORMAT } }
      : input;
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
  // Gravar o PRD novo POR CIMA de um formato 1 (a tela, um `write_doc` ou uma aprovação do Inbox antes
  // da migração do boot) faz ANTES o que a migração faria: o contexto do formato 1 vai para o
  // `contexto.md` e o original para `.archive/`. Sem isto, as seções que saíram do PRD (decisões, pronto
  // quando, riscos…) sumiriam de todo leitor vivo — o `readPrdV1` deixa de achar o formato 1 depois.
  let carried: string[] = [];
  // As funcionalidades de ANTES (fase 7): renomear uma no PRD remarca os cards dela — depois da gravação, nunca antes.
  let featuresBefore: PrdFeature[] | null = null;
  if (schema.docType === PRD_DOC_TYPE) {
    featuresBefore = await prdFeaturesOnDisk(boardId, schema);
    const aside = await setPrdV1Aside(boardId, opts);
    if (!aside.ok) return aside;
    carried = aside.carried ?? [];
  }
  await atomicWriteFile(file, markdown);
  if (featuresBefore?.length) await remapAfterPrdWrite(boardId, featuresBefore, prdFeatureEntries(doc), opts);
  return carried.length ? { ok: true, carried } : { ok: true };
}

/** As funcionalidades do PRD que está no disco (formato 2). Ausente, ilegível ou formato 1 ⇒ null (nada a remarcar). */
async function prdFeaturesOnDisk(boardId: string, schema: DocSchema): Promise<PrdFeature[] | null> {
  try {
    const prev = await readSchemaDoc(boardId, schema);
    if (!prev.exists || isPrdV1(prev.doc.frontmatter, stripFrontmatterBlock(prev.raw))) return null;
    return prdFeatureEntries(prev.doc);
  } catch {
    return null;
  }
}

/**
 * A remarcação dos cards depois de um PRD gravado (feature-remap.ts). Cobre as duas portas — a proposta aprovada e a
 * edição do dono — porque as duas passam por aqui. NUNCA derruba a gravação: o PRD já está no disco; um card não
 * remarcado cai em «Outros» e a âncora o religa.
 */
async function remapAfterPrdWrite(boardId: string, before: PrdFeature[], after: PrdFeature[], opts: WriteSchemaDocOptions): Promise<void> {
  try {
    const { remapFeatureIds } = await import("../feature-remap");
    await remapFeatureIds(boardId, before, after, opts.featureRemapDeps);
  } catch (err) {
    console.warn(`[feature-remap] ${boardId}: remarcação falhou (o PRD foi gravado) —`, err instanceof Error ? err.message : err);
  }
}

/**
 * O passo 1 da migração (formato 1 → contexto + cópia), feito por QUEM grava o PRD — a migração do boot
 * e toda gravação antecipada passam por aqui, então não há caminho que grave o PRD novo e perca o
 * contexto. Ordem: o contexto primeiro (validado; recusado ⇒ nada arquivado, o PRD fica como estava),
 * depois a cópia do original, e só então o chamador grava o PRD. Sem formato 1 no disco ⇒ nada.
 */
async function setPrdV1Aside(boardId: string, opts: WriteSchemaDocOptions): Promise<WriteSchemaDocResult> {
  const v1 = await readPrdV1(boardId);
  if (!v1) return { ok: true };
  const log = opts.log ?? ((line: string) => console.info(line));
  const carried: string[] = [];
  const { contexto } = migratePrdV1(v1.doc);
  if (contexto.sections.length) {
    const existing = await readSchemaDoc(boardId, CONTEXTO_SCHEMA);
    const next = existing.exists ? appendMigratedContexto(existing.doc, contexto) : contexto;
    if (!existing.exists || next !== existing.doc) {
      const w = await writeSchemaDoc(boardId, CONTEXTO_SCHEMA, next);
      if (!w.ok) return { ok: false, violations: w.violations, error: `contexto.md recusado: ${w.error}` };
      carried.push("contexto.md");
      log(`[docs] ${boardId}: contexto.md ${existing.exists ? "acrescido do PRD antigo" : "criado a partir do PRD antigo"}`);
    }
  }
  const archived = await archiveDocFileOnce(boardId, boardDocPath(boardId, PRD_DOC_TYPE), "prd-v1.md", opts.now);
  if (archived.created) carried.push(`.archive/${path.basename(archived.target)}`);
  return { ok: true, carried };
}

/** `storymap/boards/<b>/docs/.archive/` — onde os originais de uma migração ficam guardados. */
export function boardDocsArchiveDir(boardId: string): string {
  return path.join(boardDocsDir(boardId), ".archive");
}

/**
 * Copia `source` para `docs/.archive/<name>` SEM nunca sobrescrever uma cópia existente: se o nome já
 * estiver ocupado, sufixa a data (e um contador, se preciso). Devolve o caminho gravado.
 */
export async function archiveDocFile(boardId: string, source: string, name: string, now: Date = new Date()): Promise<string> {
  return (await archiveDocFileOnce(boardId, source, name, now)).target;
}

/**
 * `archiveDocFile` que NÃO duplica: se uma das cópias já guardadas tem exatamente os mesmos bytes,
 * devolve ela (`created: false`) em vez de abrir outro nome — repetir a migração converge.
 */
async function archiveDocFileOnce(
  boardId: string,
  source: string,
  name: string,
  now: Date = new Date(),
): Promise<{ target: string; created: boolean }> {
  const dir = boardDocsArchiveDir(boardId);
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  const day = now.toISOString().slice(0, 10);
  const candidates = [name, `${base}-${day}${ext}`];
  for (let i = 2; i < 100; i++) candidates.push(`${base}-${day}-${i}${ext}`);
  const content = await fs.readFile(source, "utf8");
  for (const candidate of candidates) {
    const target = path.join(dir, candidate);
    try {
      // `wx`: falha se existir — a garantia de nunca sobrescrever é do sistema de arquivos, não de um stat antes.
      await fs.writeFile(target, content, { flag: "wx" });
      return { target, created: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if ((await fs.readFile(target, "utf8")) === content) return { target, created: false };
    }
  }
  throw new Error(`não há nome livre para arquivar ${name} em ${dir}`);
}

/** Os bytes crus de um documento, separados — `null` quando o arquivo não existe. */
async function readRawDoc(boardId: string, docType: string): Promise<{ raw: string; frontmatter: Record<string, unknown>; body: string } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(boardDocPath(boardId, docType), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = parseFrontmatter(raw, `${boardId}/docs/${docType}.md`);
    return { raw, frontmatter: parsed.data, body: parsed.content };
  } catch {
    return { raw, frontmatter: {}, body: stripFrontmatterBlock(raw) };
  }
}

/**
 * O `docs/prd.md` deste board AINDA no formato 1, já lido — `null` quando não existe ou já é o
 * novo. É a pergunta que a migração do boot, a leitura preguiçosa e a gravação fazem.
 */
export async function readPrdV1(boardId: string): Promise<{ raw: string; doc: SchemaDoc } | null> {
  const read = await readRawDoc(boardId, PRD_DOC_TYPE);
  if (!read || !isPrdV1(read.frontmatter, read.body)) return null;
  return { raw: read.raw, doc: parsePrdV1(read.body, read.frontmatter) };
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

  // ── migração de FORMATO, em memória ───────────────────────────────────────────
  // Um `prd.md` ainda no formato 1 (o boot ainda não migrou) é LIDO como o formato 2 — sem gravar.
  // Nenhum leitor (tela, agente, prompt) vê o formato antigo nem por um instante.
  if (docType === PRD_DOC_TYPE) {
    const v1 = await readPrdV1(boardId);
    if (v1) return { doc: migratePrdV1(v1.doc).prd, violations: [], exists: true, raw: v1.raw, schema: entry.schema };
  }
  // O contexto que AINDA está dentro de um PRD formato 1 — só enquanto o `contexto.md` não existe
  // (se existe, a migração do boot acrescenta nele; projetar por cima esconderia o que está escrito).
  if (docType === CONTEXTO_DOC_TYPE) {
    const read = await readSchemaDoc(boardId, entry.schema);
    if (read.exists) return { ...read, schema: entry.schema };
    const v1 = await readPrdV1(boardId);
    return v1 ? { ...read, schema: entry.schema, doc: migratePrdV1(v1.doc).contexto } : { ...read, schema: entry.schema };
  }

  const read = await readSchemaDoc(boardId, entry.schema);
  if (read.exists) return { ...read, schema: entry.schema };
  // O arquivo do formato ANTIGO deste documento (o `lean-canvas.md` do BMC) vence o `board.yaml`.
  if (entry.legacyFile) {
    const old = await readSchemaDoc(boardId, entry.legacyFile.schema);
    if (old.exists) return { ...read, schema: entry.schema, doc: entry.legacyFile.migrate(old.doc), violations: [] };
  }
  if (!entry.legacyProject) return { ...read, schema: entry.schema };
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
