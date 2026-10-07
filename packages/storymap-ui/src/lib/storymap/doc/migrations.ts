// 🔁 As migrações de FORMATO dos documentos de board — funções PURAS, sem disco.
//
//   · `migrateLeanCanvasToBmc` — Lean Canvas → Business Model Canvas (o grupo Negócio trocou de método);
//   · `migratePrdV1`           — PRD formato 1 (20 seções) → PRD formato 2 (7 seções, de negócio)
//                                + `contexto` (o que só os agentes usam).
//
// A regra das duas, e o teste que a prende (migrations.test.ts): NADA SOME. Todo item, todo parágrafo
// e todo grupo autoral do documento de origem tem destino declarado aqui; o que não tem lugar natural
// vira um grupo (`###`) com o nome da origem no bloco mais próximo — ou, no PRD, em
// `contexto.outros`. Um grupo autoral de uma seção que foi ANINHADA sob outro grupo ganha o prefixo do
// grupo novo («Problemas que resolve — Descoberta»), porque `###` não aninha.
//
// Quem grava é `migrate-board-docs.ts` (servidor, idempotente, com cópia de arquivo do original);
// `schema-doc-io.loadDoc` usa as mesmas funções em memória para que nenhum leitor veja o formato
// antigo entre o deploy e a migração do boot.

import { blockIdFactory, type DocBlock } from "./doc-model";
import { labelKey, topLevelSections } from "./doc-schema";
import { ensureSkeleton, parseSchemaBody, type SchemaDoc, type SectionContent } from "./schema-codec";
import { BMC_DOC_TYPE, BMC_SCHEMA } from "./schemas/business-model-canvas";
import { CONTEXTO_DOC_TYPE, CONTEXTO_SCHEMA } from "./schemas/contexto";
import { PRD_ALTERNATIVES_GROUP, PRD_DOC_TYPE, PRD_FORMAT, PRD_SCHEMA } from "./schemas/prd";
import { PRD_V1_SCHEMA } from "./schemas/prd-v1";

// ---------------------------------------------------------------------------
// utilitários de blocos
// ---------------------------------------------------------------------------

interface SplitSection {
  /** os blocos antes do primeiro `###` (itens sem grupo, prosa). */
  loose: DocBlock[];
  /** cada grupo autoral, com o heading e os blocos dele. */
  groups: { heading: DocBlock; label: string; blocks: DocBlock[] }[];
}

/** Separa uma seção em «solto» + grupos autorais (`###`). */
function splitGroups(blocks: readonly DocBlock[]): SplitSection {
  const out: SplitSection = { loose: [], groups: [] };
  let current: SplitSection["groups"][number] | null = null;
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 3) {
      current = { heading: block, label: block.text.trim(), blocks: [] };
      out.groups.push(current);
      continue;
    }
    (current ? current.blocks : out.loose).push(block);
  }
  return out;
}

function blocksOf(doc: SchemaDoc, key: string): DocBlock[] {
  return doc.sections.find((s) => s.key === key)?.blocks ?? [];
}

function heading(text: string, nextId: () => string): DocBlock {
  return { kind: "heading", id: nextId(), level: 3, text };
}

/**
 * Os blocos de uma seção de origem ANINHADOS sob um grupo novo: o solto vai para `### label`; cada
 * grupo autoral vira `### label — grupo` (o `###` não aninha, e perder o grupo seria perder dado).
 */
function nestUnder(label: string, blocks: readonly DocBlock[], nextId: () => string): DocBlock[] {
  const { loose, groups } = splitGroups(blocks);
  const out: DocBlock[] = [];
  if (loose.length) out.push(heading(label, nextId), ...loose);
  for (const g of groups) out.push(heading(`${label} — ${g.label}`, nextId), ...g.blocks);
  return out;
}

/**
 * Junta blocos numa seção de grupos SEM que um item solto caia dentro do grupo anterior: o solto de
 * todas as partes abre a seção, os grupos vêm depois, na ordem das partes.
 */
function mergeGrouped(parts: readonly (readonly DocBlock[])[]): DocBlock[] {
  const loose: DocBlock[] = [];
  const grouped: DocBlock[] = [];
  for (const part of parts) {
    const split = splitGroups(part);
    loose.push(...split.loose);
    for (const g of split.groups) grouped.push(g.heading, ...g.blocks);
  }
  return [...loose, ...grouped];
}

/** Um bloco de prosa vira item (uma linha); um item fica item; o resto passa como está. */
function asItem(block: DocBlock, prefix: string, nextId: () => string): DocBlock {
  if (block.kind === "paragraph") return { kind: "bullet", id: nextId(), text: `${prefix}${block.text}` };
  if (block.kind === "bullet" || block.kind === "numbered" || block.kind === "todo") {
    return { kind: "bullet", id: nextId(), text: `${prefix}${block.text}` };
  }
  return block;
}

/** Achata uma seção em itens (os grupos viram prefixo do item), para uma seção de destino `items`. */
function flattenToItems(blocks: readonly DocBlock[], prefix: string, nextId: () => string): DocBlock[] {
  const { loose, groups } = splitGroups(blocks);
  const out = loose.map((b) => asItem(b, prefix, nextId));
  for (const g of groups) out.push(...g.blocks.map((b) => asItem(b, `${prefix}${g.label}: `, nextId)));
  return out;
}

function section(schema: typeof PRD_SCHEMA, key: string, blocks: DocBlock[]): SectionContent {
  const rule = schema.sections.find((s) => s.key === key)!;
  return { key, label: rule.label, blocks };
}

// ---------------------------------------------------------------------------
// Lean Canvas → Business Model Canvas
// ---------------------------------------------------------------------------

/**
 * Leva TODO o conteúdo de um Lean Canvas para os nove blocos do BMC. O mapa:
 *
 *   customerSegments (+ earlyAdopters → «Primeiros clientes»)                 → customerSegments
 *   uniqueValueProposition (+ highLevelConcept → «Conceito»),
 *     problem → «Problemas que resolve» (+ existingAlternatives → «Como resolvem hoje») → valuePropositions
 *   solution → «Solução», keyMetrics → «Métricas-chave»                      → keyActivities
 *   unfairAdvantage → «Vantagem difícil de copiar»                          → keyResources
 *   channels, revenueStreams, costStructure                                  → os blocos de mesmo nome
 *
 * O frontmatter (as etiquetas coloridas) passa inteiro; só o `doc:` muda. Relacionamento e
 * Parcerias nascem vazios — são exatamente o que o Lean Canvas não perguntava.
 */
export function migrateLeanCanvasToBmc(lean: SchemaDoc): SchemaDoc {
  const nextId = blockIdFactory();
  const src = (key: string) => blocksOf(lean, key);

  const byKey: Record<string, DocBlock[]> = {
    customerSegments: mergeGrouped([src("customerSegments"), nestUnder("Primeiros clientes", src("earlyAdopters"), nextId)]),
    valuePropositions: mergeGrouped([
      src("uniqueValueProposition"),
      nestUnder("Conceito", src("highLevelConcept"), nextId),
      nestUnder("Problemas que resolve", src("problem"), nextId),
      nestUnder("Como resolvem hoje", src("existingAlternatives"), nextId),
    ]),
    channels: [...src("channels")],
    customerRelationships: [],
    revenueStreams: [...src("revenueStreams")],
    keyResources: nestUnder("Vantagem difícil de copiar", src("unfairAdvantage"), nextId),
    keyActivities: mergeGrouped([
      nestUnder("Solução", src("solution"), nextId),
      nestUnder("Métricas-chave", src("keyMetrics"), nextId),
    ]),
    keyPartners: [],
    costStructure: [...src("costStructure")],
  };

  const frontmatter: Record<string, unknown> = { ...lean.frontmatter, doc: BMC_DOC_TYPE };
  const doc: SchemaDoc = {
    docType: BMC_DOC_TYPE,
    title: BMC_SCHEMA.title.kind === "fixed" ? BMC_SCHEMA.title.text : "Business Model Canvas",
    frontmatter,
    sections: BMC_SCHEMA.sections.map((rule) => ({ key: rule.key, label: rule.label, blocks: byKey[rule.key] ?? [] })),
    // Um Lean Canvas não tem cauda livre; se um dia tiver, ela não some: vai para o fim da proposta.
    tail: [],
  };
  if (lean.tail.length) {
    const vp = doc.sections.find((s) => s.key === "valuePropositions")!;
    vp.blocks = mergeGrouped([vp.blocks, nestUnder("Outras notas do Lean Canvas", lean.tail, nextId)]);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// PRD v1 → PRD v2 + contexto
// ---------------------------------------------------------------------------

/** O schema do formato 1 com cauda livre: o que ele não reconhece vai para `tail` em vez de sumir. */
const PRD_V1_PERMISSIVE = { ...PRD_V1_SCHEMA, allowFreeTail: true };

const V2_TOP_LABELS = new Set(topLevelSections(PRD_SCHEMA).map((s) => labelKey(s.label)));
const V1_ONLY_TOP_LABELS = new Set(
  topLevelSections(PRD_V1_SCHEMA)
    .map((s) => labelKey(s.label))
    .filter((l) => !V2_TOP_LABELS.has(l)),
);

/** Os rótulos `##` do corpo (fora de bloco de código). */
function topHeadings(body: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push(labelKey(m[1]));
  }
  return out;
}

/**
 * Este `prd.md` ainda está no formato 1? `format: 2` no cabeçalho é a resposta definitiva (toda
 * gravação o carimba). Sem ele, decide o corpo: um rótulo que só o formato 1 tem ⇒ 1; nenhum rótulo
 * do formato 2 ⇒ 1 também (um documento vazio migra para o esqueleto novo); só rótulos do formato 2
 * (alguém escreveu à mão sem o carimbo) ⇒ 2.
 */
export function isPrdV1(frontmatter: Record<string, unknown>, body: string): boolean {
  if (frontmatter.format === PRD_FORMAT) return false;
  const labels = topHeadings(body);
  if (labels.some((l) => V1_ONLY_TOP_LABELS.has(l))) return true;
  const v2Only = labels.filter((l) => V2_TOP_LABELS.has(l) && l !== labelKey("Problema"));
  return v2Only.length === 0;
}

/** Parse do corpo de um PRD v1 — permissivo: nada do que o autor escreveu fica para trás. */
export function parsePrdV1(body: string, frontmatter: Record<string, unknown> = {}): SchemaDoc {
  return parseSchemaBody(body, PRD_V1_PERMISSIVE, frontmatter).doc;
}

/** As seções do formato 1 que vão para o contexto com a MESMA chave. */
const TO_CONTEXTO = ["decisoes", "prontoQuando", "requisitos", "restricoes", "riscos", "modeloNegocio", "lancamento", "glossario"] as const;

/** O que o formato 1 tinha e é coberto por uma regra explícita (o resto do v1 vai para «outros»). */
const MAPPED_V1 = new Set<string>([
  "resumo",
  "problema",
  "publico",
  "alternativas",
  "posicionamento",
  "objetivos",
  "metricaNegocio",
  "resultadoAlvo",
  "sinaisLideres",
  "escopo",
  "solucao",
  "jornadas",
  ...TO_CONTEXTO,
]);

/** «Fora, por ora» / «Nunca» — os grupos do Escopo antigo que viram «Fora do escopo». */
function escopoKind(label: string): "fora" | "nunca" | "dentro" {
  const l = labelKey(label);
  if (l.startsWith("nunca")) return "nunca";
  if (l.startsWith("fora")) return "fora";
  return "dentro";
}

/** A cauda livre (seções desconhecidas) como grupos de «Outras notas»: `##` vira `###`, `###` ganha prefixo. */
function tailAsGroups(tail: readonly DocBlock[], nextId: () => string): DocBlock[] {
  const out: DocBlock[] = [];
  let parent = "Notas do PRD antigo";
  let opened = false;
  for (const block of tail) {
    if (block.kind === "heading" && block.level === 2) {
      parent = block.text.trim();
      out.push(heading(parent, nextId));
      opened = true;
      continue;
    }
    if (block.kind === "heading" && block.level === 3) {
      out.push(heading(`${parent} — ${block.text.trim()}`, nextId));
      opened = true;
      continue;
    }
    if (!opened) {
      out.push(heading(parent, nextId));
      opened = true;
    }
    out.push(block);
  }
  return out;
}

export interface MigratedPrd {
  prd: SchemaDoc;
  /** o contexto para os agentes — só as seções que receberam conteúdo. */
  contexto: SchemaDoc;
}

/**
 * PRD formato 1 → formato 2 + contexto, sem perder bloco. Aceita o `SchemaDoc` do formato 1 (de
 * {@link parsePrdV1}) ou o CORPO markdown cru (sem frontmatter). O mapa:
 *
 *   problema                                              → problema
 *   publico (os `###` são as personas) + alternativas → «Como resolvem hoje» → personas
 *   posicionamento, depois resumo                         → propostaValor
 *   solucao + os grupos do escopo que não são «Fora…»/«Nunca» → funcionalidades
 *   jornadas                                              → fluxoUso
 *   objetivos + metricaNegocio + resultadoAlvo + sinaisLideres → metricasSucesso (itens com prefixo)
 *   escopo «Fora, por ora» + «Nunca» (prefixo «Nunca: ») → foraEscopo
 *   decisoes, prontoQuando, requisitos, restricoes, riscos, modeloNegocio, lancamento, glossario → contexto
 *   qualquer outra coisa                                  → contexto.outros
 */
export function migratePrdV1(v1: SchemaDoc | string): MigratedPrd {
  const doc = typeof v1 === "string" ? parsePrdV1(v1) : v1;
  const nextId = blockIdFactory();
  const src = (key: string) => blocksOf(doc, key);

  // ── escopo: dentro × fora × nunca ──────────────────────────────────────────
  const escopo = splitGroups(src("escopo"));
  const dentro: DocBlock[] = [];
  const fora: DocBlock[] = [];
  if (escopo.loose.length) dentro.push(heading("Escopo", nextId), ...escopo.loose);
  for (const g of escopo.groups) {
    const kind = escopoKind(g.label);
    if (kind === "dentro") dentro.push(heading(g.label, nextId), ...g.blocks);
    else fora.push(...flattenToItems(g.blocks, kind === "nunca" ? "Nunca: " : "", nextId));
  }

  const prdSections: Record<string, DocBlock[]> = {
    problema: [...src("problema")],
    personas: mergeGrouped([src("publico"), nestUnder(PRD_ALTERNATIVES_GROUP, src("alternativas"), nextId)]),
    propostaValor: [...src("posicionamento"), ...src("resumo")],
    funcionalidades: mergeGrouped([src("solucao"), dentro]),
    fluxoUso: [...src("jornadas")],
    metricasSucesso: [
      ...flattenToItems(src("objetivos"), "", nextId),
      ...flattenToItems(src("metricaNegocio"), "Métrica de negócio: ", nextId),
      ...flattenToItems(src("resultadoAlvo"), "Resultado-alvo: ", nextId),
      ...flattenToItems(src("sinaisLideres"), "Sinal-líder: ", nextId),
    ],
    foraEscopo: fora,
  };

  const prd: SchemaDoc = ensureSkeleton(
    {
      docType: PRD_DOC_TYPE,
      title: "PRD",
      frontmatter: { ...doc.frontmatter, doc: PRD_DOC_TYPE, format: PRD_FORMAT },
      sections: PRD_SCHEMA.sections.map((rule) => section(PRD_SCHEMA, rule.key, prdSections[rule.key] ?? [])),
      tail: [],
    },
    PRD_SCHEMA,
  );

  // ── contexto ───────────────────────────────────────────────────────────────
  const outros: DocBlock[] = [];
  // Uma seção do formato 1 que este mapa não cobre (não deveria existir — o teste garante — mas um
  // schema que cresça sem atualizar daqui não pode perder conteúdo calado).
  for (const s of doc.sections) {
    if (MAPPED_V1.has(s.key) || !s.blocks.length) continue;
    outros.push(...nestUnder(s.label, s.blocks, nextId));
  }
  outros.push(...tailAsGroups(doc.tail, nextId));

  const contextoSections: SectionContent[] = [];
  for (const rule of CONTEXTO_SCHEMA.sections) {
    const blocks = rule.key === "outros" ? outros : (TO_CONTEXTO as readonly string[]).includes(rule.key) ? src(rule.key) : [];
    if (blocks.length) contextoSections.push({ key: rule.key, label: rule.label, blocks: [...blocks] });
  }
  const contexto: SchemaDoc = {
    docType: CONTEXTO_DOC_TYPE,
    title: CONTEXTO_SCHEMA.title.kind === "fixed" ? CONTEXTO_SCHEMA.title.text : "Contexto",
    frontmatter: { doc: CONTEXTO_DOC_TYPE },
    sections: contextoSections,
    tail: [],
  };

  return { prd, contexto };
}

// ---------------------------------------------------------------------------
// contexto existente + contexto migrado
// ---------------------------------------------------------------------------

/** O texto de um bloco, para reconhecer o que já está no documento. */
function blockKey(block: DocBlock): string | null {
  if ("text" in block && typeof block.text === "string" && block.kind !== "heading") return block.text.trim();
  return null;
}

/**
 * Acrescenta o contexto MIGRADO a um contexto que já existia, sem sobrescrever nada: cada seção
 * migrada entra em «Outras notas» como `### Do PRD antigo — <rótulo>`, só com os blocos que o
 * documento ainda não tem (é o que torna a migração segura de repetir). Sem nada novo ⇒ o mesmo doc.
 */
export function appendMigratedContexto(existing: SchemaDoc, migrated: SchemaDoc): SchemaDoc {
  const known = new Set<string>();
  for (const s of existing.sections) for (const b of s.blocks) {
    const k = blockKey(b);
    if (k) known.add(k);
  }
  const nextId = blockIdFactory();
  const extra: DocBlock[] = [];
  for (const s of migrated.sections) {
    // o que o documento ainda NÃO tem; os grupos autorais ficam só se ainda tiverem conteúdo novo
    const { loose, groups } = splitGroups(s.blocks);
    const novo = (blocks: readonly DocBlock[]) => blocks.filter((b) => {
      const k = blockKey(b);
      return k === null || !known.has(k);
    });
    const fresh: DocBlock[] = [...novo(loose)];
    for (const g of groups) {
      const rest = novo(g.blocks);
      if (rest.some((b) => blockKey(b) !== null)) fresh.push(g.heading, ...rest);
    }
    if (!fresh.some((b) => blockKey(b) !== null)) continue;
    extra.push(...nestUnder(`Do PRD antigo — ${s.label}`, fresh, nextId));
  }
  if (!extra.length) return existing;
  const current = existing.sections.find((s) => s.key === "outros")?.blocks ?? [];
  const outros: SectionContent = {
    key: "outros",
    label: CONTEXTO_SCHEMA.sections.find((s) => s.key === "outros")!.label,
    blocks: mergeGrouped([current, extra]),
  };
  const sections = [...existing.sections.filter((s) => s.key !== "outros"), outros];
  const order = CONTEXTO_SCHEMA.sections.map((s) => s.key);
  sections.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { ...existing, sections };
}
