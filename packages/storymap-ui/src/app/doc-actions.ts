"use server";

// Server actions dos DOCUMENTOS de board (markdown como fonte da verdade).
//
// Uma action de leitura e uma de escrita servem a TODOS os docTypes — é o ganho de ter um contrato:
// antes cada entidade trazia o próprio par (canvas via governança, estilo via chokepoint de versão,
// vocabulário via patch direto), e cada par tinha o seu jeito de falhar.
//
// Duas travas, ambas fail-closed:
//   · o `docType` vem de FORA e é resolvido contra o registro fechado (`docSchema`) — desconhecido é
//     recusa, nunca um schema de consolação nem um caminho montado a partir da entrada;
//   · a escrita valida contra o schema ANTES de tocar o disco (`writeSchemaDoc`), então o rótulo
//     travado de uma seção vale também para quem não passa pela UI.

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/action-guard";
import { docSchema } from "@/lib/storymap/doc/doc-registry";
import {
  parseSchemaBody,
  replaceSectionBlocks,
  sectionItems,
  serializeSchemaDoc,
  setSectionItems,
  type SchemaDoc,
} from "@/lib/storymap/doc/schema-codec";
import { loadDoc, writeSchemaDoc } from "@/lib/storymap/doc/schema-doc-io";
import type { SchemaViolation } from "@/lib/storymap/doc/doc-schema";

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string; violations?: SchemaViolation[] };

export interface SaveDocInput {
  boardId: string;
  docType: string;
  doc: SchemaDoc;
}

/**
 * Grava o documento inteiro. O cliente manda o `SchemaDoc` (o que as três superfícies — documento,
 * fonte e quadro — produzem), e a serialização canônica acontece no SERVIDOR: assim os bytes em
 * disco têm uma origem só, e um cliente antigo não consegue gravar um dialeto diferente.
 */
export async function saveDocAction(input: SaveDocInput): Promise<Result> {
  await requireSession("saveDocAction");
  const schema = docSchema(input.docType);
  if (!schema) return { ok: false, error: `Documento desconhecido: "${input.docType}".` };
  if (!input.doc || typeof input.doc !== "object") return { ok: false, error: "Documento ausente." };

  try {
    const res = await writeSchemaDoc(input.boardId, schema, { ...input.doc, docType: schema.docType });
    if (!res.ok) return { ok: false, error: res.error ?? "Documento recusado.", violations: res.violations };
    revalidatePath(`/board/${input.boardId}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Grava a partir do MARKDOWN CRU (a view de fonte). O texto é parseado contra o schema aqui, então a
 * fonte obedece exatamente às mesmas regras do editor rico — e uma seção travada que o autor
 * renomeou volta como recusa nomeada, em vez de virar conteúdo solto.
 */
export async function saveDocMarkdownAction(input: {
  boardId: string;
  docType: string;
  markdown: string;
  /** o frontmatter atual — a fonte edita o CORPO; o cabeçalho tem superfícies próprias. */
  frontmatter?: Record<string, unknown>;
}): Promise<Result> {
  await requireSession("saveDocMarkdownAction");
  const schema = docSchema(input.docType);
  if (!schema) return { ok: false, error: `Documento desconhecido: "${input.docType}".` };
  if (typeof input.markdown !== "string") return { ok: false, error: "Markdown ausente." };

  const { doc, violations } = parseSchemaBody(input.markdown, schema, input.frontmatter ?? {});
  const blocking = violations.filter((v) => v.severity === "error");
  if (blocking.length) {
    return { ok: false, error: blocking.map((v) => v.message).join(" · "), violations: blocking };
  }
  return saveDocAction({ boardId: input.boardId, docType: input.docType, doc });
}

/**
 * A escrita do AGENTE: uma SEÇÃO de cada vez, e nada além dela.
 *
 * É a tool do chat da tela (classe de risco `doc-write`), e a estreiteza é o controle — não uma
 * gentileza. O que ela estruturalmente NÃO alcança:
 *   · o frontmatter (o que a máquina lê e roteia) — fora do schema de entrada;
 *   · o RÓTULO de qualquer seção — travado, e revalidado na gravação;
 *   · uma seção que o schema não declara — resolvida contra o schema, não contra a entrada;
 *   · o documento inteiro — `mode: "append"` é o default, e é o que a persona pede.
 *
 * `replace` existe porque reescrever uma seção é pedido legítimo do operador ("reescreva o
 * problema"), mas ele é EXPLÍCITO: o agente precisa nomear a intenção, e o humano vê no transcript.
 */
export async function writeDocSectionAction(input: {
  boardId: string;
  docType: string;
  /** a `key` da seção — resolvida contra o schema (fail-closed), nunca um caminho. */
  section: string;
  /** os itens (para seções que carregam itens). */
  items?: { text: string; group?: string | null; checked?: boolean }[];
  /** o texto (para seções de prosa) — markdown, um parágrafo por linha em branco. */
  prose?: string;
  mode?: "append" | "replace";
}): Promise<Result<{ section: string; count: number }>> {
  await requireSession("writeDocSectionAction");
  const loaded = await loadDoc(input.boardId, input.docType);
  if (!loaded) return { ok: false, error: `Documento desconhecido: "${input.docType}".` };
  const { schema, doc } = loaded;

  const rule = schema.sections.find((s) => s.key === input.section);
  if (!rule) {
    const known = schema.sections.map((s) => s.key).join(", ");
    return { ok: false, error: `Seção desconhecida: "${input.section}". As deste documento: ${known}.` };
  }

  const mode = input.mode ?? "append";
  let next = doc;

  if (rule.content === "prose") {
    if (typeof input.prose !== "string" || !input.prose.trim()) {
      return { ok: false, error: `"${rule.label}" é uma seção de prosa — mande \`prose\`.` };
    }
    const parsed = parseSchemaBody(`## ${rule.label}\n\n${input.prose}\n`, schema, doc.frontmatter);
    const written = parsed.doc.sections.find((s) => s.key === rule.key);
    const blocks = written?.blocks ?? [];
    const prev = mode === "append" ? (doc.sections.find((s) => s.key === rule.key)?.blocks ?? []) : [];
    next = replaceSectionBlocks(doc, rule.key, [...prev, ...blocks], schema);
  } else {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      return { ok: false, error: `"${rule.label}" é uma seção de itens — mande \`items\`.` };
    }
    const incoming = input.items
      .filter((i) => i && typeof i.text === "string" && i.text.trim())
      .map((i) => ({ text: i.text.trim(), group: i.group?.trim() || null, checked: i.checked }));
    if (!incoming.length) return { ok: false, error: "Nenhum item com texto." };
    const prev = mode === "append" ? sectionItems(doc, rule.key) : [];
    next = setSectionItems(doc, rule.key, [...prev, ...incoming], schema);
  }

  const res = await writeSchemaDoc(input.boardId, schema, next);
  if (!res.ok) return { ok: false, error: res.error ?? "Documento recusado.", violations: res.violations };
  revalidatePath(`/board/${input.boardId}`, "layout");
  return { ok: true, data: { section: rule.key, count: sectionItems(next, rule.key).length } };
}

/**
 * O CONTEXTO que a conversa da tela recebe a cada turno: o documento inteiro, em markdown, mais o
 * mapa de seções (chave → rótulo → que conteúdo aceita).
 *
 * O mapa vai junto de propósito: sem ele o agente adivinharia a chave a partir do rótulo, e `write_doc`
 * recusaria a chave inventada — o que gasta um turno para descobrir o que já podia estar dito. Como o
 * contexto é re-resolvido FRESCO a cada turno, ele também é o que faz o agente enxergar o que o humano
 * acabou de editar na tela.
 */
export async function docChatContextAction(boardId: string, docType: string): Promise<string | undefined> {
  await requireSession("docChatContextAction");
  const loaded = await loadDoc(boardId, docType);
  if (!loaded) return undefined;
  const { schema, doc, exists } = loaded;

  const map = schema.sections
    .map((s) => `- \`${s.key}\` — "${s.label}" (${s.content}${s.parent ? `, dentro de ${s.parent}` : ""})`)
    .join("\n");

  return [
    `## Documento em foco: ${schema.docType}`,
    exists ? "" : "(ainda não gravado em disco — o conteúdo abaixo vem do formato antigo e será materializado no primeiro save)",
    "",
    "### Seções deste documento (use a CHAVE em write_doc, não o rótulo)",
    map,
    "",
    "### O documento agora",
    "",
    serializeSchemaDoc(doc, schema),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Relê o documento (disco, com a projeção do legado como piso) — a recarga depois de escreverem nele. */
export async function readDocAction(input: { boardId: string; docType: string }): Promise<
  Result<{ doc: SchemaDoc; violations: SchemaViolation[]; exists: boolean; raw: string }>
> {
  await requireSession("readDocAction");
  try {
    // `loadDoc`, e NÃO `readSchemaDoc`: num board ainda não migrado o arquivo não existe, e ler só o
    // disco devolve o esqueleto VAZIO. O agente então segue o conselho da própria tool ("leia antes
    // de escrever"), vê seções vazias, e escreve numa seção que `write_doc` — que já passa por
    // `loadDoc` — vai mesclar num documento CHEIO. As duas portas têm de ler a MESMA coisa; enquanto
    // não liam, o agente agia sobre um documento que nunca existiu. (Hoje NENHUM board está migrado,
    // então este era o caminho comum, não a borda.)
    const loaded = await loadDoc(input.boardId, input.docType);
    if (!loaded) return { ok: false, error: `Documento desconhecido: "${input.docType}".` };
    const { doc, violations, exists, raw } = loaded;
    return { ok: true, data: { doc, violations, exists, raw } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
