// 📐 schema-codec — markdown ⇄ SchemaDoc, sob as regras de um {@link DocSchema}.
//
// É a ponte entre a Camada 1 (bytes) e a Camada 3 (views): o `md-codec` já sabe virar markdown em
// blocos; aqui os blocos são RECONHECIDOS contra o esqueleto do schema e viram seções nomeadas —
// que é a forma que toda view consome (documento, tabela, quadro, kanban). Nenhuma view fala com o
// `md-codec` direto; todas falam com o `SchemaDoc`.
//
// Três leis, todas testadas em schema-codec.test.ts:
//
//   1. PONTO FIXO      — `serialize(parse(x))` reserializa os mesmos bytes, para todo `x` canônico.
//   2. NO-OP ≡ NO-WRITE — parsear e reserializar um documento que ninguém tocou não muda um byte
//                         (herdada do `md-codec`: o texto de bloco é SUBSTRING da fonte, não reimpressão).
//   3. RECUSA EXPLÍCITA — nada que o esqueleto não comporte é dobrado em silêncio: vira violação
//                         nomeada. Recusar é a política; auto-reparar apagaria o que a pessoa
//                         acabou de digitar.
//
// PURO por contrato (o cliente importa): sem `node:fs` e sem gray-matter. Quem separa o frontmatter
// dos bytes é o módulo de I/O do servidor — aqui o frontmatter CHEGA já parseado. Isso também
// mantém o chokepoint de segurança intacto: `parseFrontmatter` (frontmatter.ts) segue sendo o único
// caminho que toca bytes de board não-confiáveis, e há lint provando isso.

import { dump as yamlDump } from "js-yaml";
import type { DocBlock, DocModel } from "./doc-model";
import { blockIdFactory } from "./doc-model";
import { parseDocMd, serializeDocMd } from "./md-codec";
import {
  bearsItems,
  childSections,
  labelKey,
  orderedSections,
  sectionByLabel,
  topLevelSections,
  violation,
  type DocSchema,
  type SchemaViolation,
  type SectionRule,
} from "./doc-schema";

// ---------------------------------------------------------------------------
// O modelo
// ---------------------------------------------------------------------------

/** O conteúdo de UMA seção: os blocos abaixo do heading dela, sem o heading. */
export interface SectionContent {
  key: string;
  /** o rótulo COMO ESTÁ no documento (igual ao do schema quando travado — é o que o parse garante). */
  label: string;
  blocks: DocBlock[];
}

export interface SchemaDoc {
  docType: string;
  /** o `# H1`. Em schema de título fixo é sempre o texto do schema. */
  title: string;
  frontmatter: Record<string, unknown>;
  /** as seções ENCONTRADAS, na ordem do schema. Uma seção ausente simplesmente não está aqui. */
  sections: SectionContent[];
  /** conteúdo livre depois do esqueleto (só quando `allowFreeTail`). */
  tail: DocBlock[];
}

export interface SchemaParseResult {
  doc: SchemaDoc;
  violations: SchemaViolation[];
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

/**
 * Reconhece uma lista de blocos contra o esqueleto. É o núcleo do parse E o caminho de volta do
 * EDITOR RICO (que devolve blocos, não texto) — os dois passam exatamente pelas mesmas regras, que
 * é o que impede a fonte markdown e o editor de divergirem no que aceitam.
 */
export function collectSchemaDoc(
  blocks: readonly DocBlock[],
  schema: DocSchema,
  opts: { title?: string; frontmatter?: Record<string, unknown> } = {},
): SchemaParseResult {
  const violations: SchemaViolation[] = [];
  const sections: SectionContent[] = [];
  const tail: DocBlock[] = [];
  const byKey = new Map<string, SectionContent>();
  const encounteredTopOrder: string[] = [];

  let currentTop: SectionRule | null = null;
  /** onde os blocos que vierem caem: uma seção, ou `null` = cauda/livre. */
  let sink: SectionContent | null = null;
  /** um heading desconhecido abriu região livre — ela dura até o próximo heading CONHECIDO. */
  let inFreeRegion = false;

  const openSection = (rule: SectionRule, label: string): SectionContent | null => {
    if (byKey.has(rule.key)) {
      violations.push(
        violation("heading-duplicated", `A seção "${rule.label}" aparece mais de uma vez — junte o conteúdo numa só.`, {
          sectionKey: rule.key,
          found: label,
        }),
      );
      return null;
    }
    const content: SectionContent = { key: rule.key, label: rule.label, blocks: [] };
    byKey.set(rule.key, content);
    sections.push(content);
    if (rule.level === 2) encounteredTopOrder.push(rule.key);
    return content;
  };

  const pushFree = (block: DocBlock, what: string) => {
    if (schema.allowFreeTail) {
      tail.push(block);
      return;
    }
    violations.push(
      violation("heading-unknown", `${what} não tem lugar neste documento — mova para dentro de uma seção conhecida ou remova.`, {
        found: blockText(block),
      }),
    );
  };

  for (const block of blocks) {
    if (block.kind === "heading" && (block.level === 2 || block.level === 3)) {
      const level = block.level;

      if (level === 2) {
        const rule = sectionByLabel(schema, block.text, { level: 2 });
        if (rule) {
          inFreeRegion = false;
          currentTop = rule;
          sink = openSection(rule, block.text);
          continue;
        }
        // Nível 2 desconhecido: uma seção travada que foi RENOMEADA é o caso comum e merece a
        // mensagem certa — mas só dá para acusar renomeação quando a seção travada some do resto do
        // documento. Isso só se sabe no fim, então marcamos como livre e reconciliamos depois.
        currentTop = null;
        sink = null;
        inFreeRegion = true;
        if (schema.allowFreeTail) tail.push(block);
        else
          violations.push(
            violation("heading-unknown", `"${block.text.trim()}" não é uma seção deste documento.`, {
              found: block.text.trim(),
            }),
          );
        continue;
      }

      // level === 3
      const child = currentTop ? sectionByLabel(schema, block.text, { level: 3, parent: currentTop.key }) : undefined;
      if (child) {
        inFreeRegion = false;
        sink = openSection(child, block.text);
        continue;
      }
      const elsewhere = sectionByLabel(schema, block.text, { level: 3 });
      if (elsewhere) {
        const parentLabel = schema.sections.find((s) => s.key === elsewhere.parent)?.label ?? elsewhere.parent;
        violations.push(
          violation("orphan-subsection", `"${elsewhere.label}" só existe dentro de "${parentLabel}" — mova para lá.`, {
            sectionKey: elsewhere.key,
            found: block.text.trim(),
          }),
        );
        continue;
      }
      // Um `###` livre dentro de uma seção `groups` É o grupo autoral — o dado, não um erro.
      if (currentTop?.content === "groups" && sink && !inFreeRegion) {
        sink.blocks.push(block);
        continue;
      }
      if (sink && !inFreeRegion) {
        sink.blocks.push(block);
        continue;
      }
      pushFree(block, `O título "${block.text.trim()}"`);
      continue;
    }

    if (sink && !inFreeRegion) sink.blocks.push(block);
    else pushFree(block, "Este conteúdo");
  }

  // ── Título ──────────────────────────────────────────────────────────────────────────────────
  const title = opts.title ?? "";
  if (schema.title.kind === "fixed" && labelKey(title) !== labelKey(schema.title.text) && title.trim() !== "") {
    violations.push(
      violation("heading-renamed", `O título deste documento é "${schema.title.text}" e não pode ser reescrito.`, {
        found: title.trim(),
      }),
    );
  }

  // ── Seções obrigatórias ausentes ────────────────────────────────────────────────────────────
  for (const rule of orderedSections(schema)) {
    if (!rule.required || byKey.has(rule.key)) continue;
    // Filha cujo PAI também sumiu não vira duas queixas — a do pai já conta a história.
    if (rule.parent && !byKey.has(rule.parent)) continue;
    const code = rule.locked ? "heading-missing" : "heading-missing";
    violations.push(
      violation(code, `Falta a seção "${rule.label}" (${"#".repeat(rule.level)} ${rule.label}). ${rule.hint}`, {
        sectionKey: rule.key,
      }),
    );
  }

  // ── Ordem ───────────────────────────────────────────────────────────────────────────────────
  const schemaOrder = topLevelSections(schema).map((s) => s.key);
  let last = -1;
  for (const key of encounteredTopOrder) {
    const idx = schemaOrder.indexOf(key);
    if (idx < last) {
      const rule = schema.sections.find((s) => s.key === key)!;
      violations.push(
        violation("out-of-order", `A seção "${rule.label}" está fora de ordem — as seções seguem a ordem do documento.`, {
          sectionKey: key,
        }),
      );
      break; // uma queixa basta: a correção é a mesma para todas
    }
    last = Math.max(last, idx);
  }

  // ── Forma do conteúdo ───────────────────────────────────────────────────────────────────────
  for (const content of sections) {
    const rule = schema.sections.find((s) => s.key === content.key)!;
    violations.push(...validateContent(content, rule, schema));
  }

  const doc: SchemaDoc = {
    docType: schema.docType,
    title: schema.title.kind === "fixed" ? schema.title.text : title,
    frontmatter: opts.frontmatter ?? {},
    sections: sortSections(sections, schema),
    tail,
  };
  return { doc, violations };
}

/**
 * Parse a partir do CORPO markdown (sem frontmatter — quem o separa é o I/O do servidor, para
 * manter o chokepoint de `parseFrontmatter` intacto e este módulo puro).
 */
export function parseSchemaBody(
  body: string,
  schema: DocSchema,
  frontmatter: Record<string, unknown> = {},
): SchemaParseResult {
  const model = parseDocMd(body, { docType: schema.docType, stripTitle: true });
  const result = collectSchemaDoc(model.blocks, schema, { title: model.title, frontmatter });
  if (schema.frontmatter) {
    const parsed = schema.frontmatter.safeParse(frontmatter);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
        .join(" · ");
      result.violations.push(violation("frontmatter-invalid", `O cabeçalho do documento não confere — ${detail}`));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

/**
 * O documento como IR plana — o que `DocRead`/`DocEditor` consomem. Emite exatamente as seções que
 * o doc tem, SEMPRE na ordem do schema (é aqui que a ordem canônica é restaurada).
 */
export function schemaDocToModel(doc: SchemaDoc, schema: DocSchema): DocModel {
  const nextId = blockIdFactory();
  const byKey = new Map(doc.sections.map((s) => [s.key, s] as const));
  const blocks: DocBlock[] = [];
  for (const rule of orderedSections(schema)) {
    const content = byKey.get(rule.key);
    if (!content) continue;
    blocks.push({ kind: "heading", id: nextId(), level: rule.level, text: rule.label });
    blocks.push(...content.blocks);
  }
  blocks.push(...doc.tail);
  return { docType: schema.docType, title: doc.title, blocks };
}

/** O documento de volta a BYTES: frontmatter (quando houver) + `# Título` + o corpo canônico. */
export function serializeSchemaDoc(doc: SchemaDoc, schema: DocSchema): string {
  const chunks: string[] = [];
  if (Object.keys(doc.frontmatter).length) {
    chunks.push(`---\n${yamlDump(doc.frontmatter, { lineWidth: 100 }).trimEnd()}\n---`);
  }
  const body = serializeDocMd(schemaDocToModel(doc, schema), { includeTitle: true });
  if (body.trim()) chunks.push(body.trimEnd());
  const out = chunks.join("\n\n");
  return out ? `${out}\n` : "";
}

// ---------------------------------------------------------------------------
// esqueleto
// ---------------------------------------------------------------------------

/**
 * Acrescenta as seções obrigatórias que faltam, VAZIAS — o gesto EXPLÍCITO de reparo.
 *
 * Não é chamado no salvamento por decisão: lá a política é recusar, porque injetar seções por baixo
 * de quem está escrevendo é auto-reparo silencioso. Isto serve à CRIAÇÃO (um documento novo nasce
 * com o esqueleto inteiro) e ao botão explícito de "restaurar seções".
 */
export function ensureSkeleton(doc: SchemaDoc, schema: DocSchema): SchemaDoc {
  const byKey = new Map(doc.sections.map((s) => [s.key, s] as const));
  const sections: SectionContent[] = [];
  for (const rule of orderedSections(schema)) {
    const existing = byKey.get(rule.key);
    if (existing) sections.push(existing);
    else if (rule.required) sections.push({ key: rule.key, label: rule.label, blocks: [] });
  }
  return { ...doc, sections };
}

/** Um documento novo, já válido: esqueleto completo e frontmatter inicial. */
export function emptySchemaDoc(
  schema: DocSchema,
  opts: { title?: string; frontmatter?: Record<string, unknown> } = {},
): SchemaDoc {
  return ensureSkeleton(
    {
      docType: schema.docType,
      title: schema.title.kind === "fixed" ? schema.title.text : (opts.title ?? ""),
      frontmatter: opts.frontmatter ?? {},
      sections: [],
      tail: [],
    },
    schema,
  );
}

// ---------------------------------------------------------------------------
// acesso
// ---------------------------------------------------------------------------

export function sectionContent(doc: SchemaDoc, key: string): SectionContent | undefined {
  return doc.sections.find((s) => s.key === key);
}

/**
 * Os ITENS de uma seção que carrega itens — a pergunta que as views de tabela/quadro/kanban fazem.
 * Um `###` livre (grupo) NÃO é item: ele volta em `group`, para a view decidir se agrupa ou ignora.
 */
export interface SchemaItem {
  /** o markdown inline do item, verbatim. */
  text: string;
  /** o grupo autoral em que ele está, quando a seção é `groups`. */
  group: string | null;
  /** estado, quando a seção é `checklist`. */
  checked?: boolean;
}

export function sectionItems(doc: SchemaDoc, key: string): SchemaItem[] {
  const content = sectionContent(doc, key);
  if (!content) return [];
  const out: SchemaItem[] = [];
  let group: string | null = null;
  for (const block of content.blocks) {
    if (block.kind === "heading") {
      group = block.text.trim() || null;
      continue;
    }
    if (block.kind === "bullet" || block.kind === "numbered") {
      out.push({ text: block.text, group });
    } else if (block.kind === "todo") {
      out.push({ text: block.text, group, checked: block.checked });
    }
  }
  return out;
}

/** Os grupos autorais de uma seção, na ordem de aparição. */
export function sectionGroups(doc: SchemaDoc, key: string): string[] {
  const content = sectionContent(doc, key);
  if (!content) return [];
  const out: string[] = [];
  for (const block of content.blocks) {
    if (block.kind !== "heading") continue;
    const label = block.text.trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// mutação
// ---------------------------------------------------------------------------
//
// As views EDITAM por aqui, e é por isso que elas podem editar sem cada uma inventar o próprio
// caminho de escrita: a mutação acontece no documento (puro, testável), e o único jeito de chegar ao
// disco continua sendo `serializeSchemaDoc`. Uma view que escrevesse markdown na mão seria uma
// segunda gramática — e a segunda é sempre a que diverge.

/** Substitui os blocos de uma seção. Seção inexistente é CRIADA na posição do schema. */
export function replaceSectionBlocks(doc: SchemaDoc, key: string, blocks: DocBlock[], schema: DocSchema): SchemaDoc {
  const rule = schema.sections.find((s) => s.key === key);
  if (!rule) return doc;
  const existing = doc.sections.find((s) => s.key === key);
  const sections = existing
    ? doc.sections.map((s) => (s.key === key ? { ...s, blocks } : s))
    : [...doc.sections, { key, label: rule.label, blocks }];
  return { ...doc, sections: sortSections(sections, schema) };
}

/**
 * Reescreve os ITENS de uma seção, preservando os grupos autorais: os itens são reagrupados na ordem
 * de primeira aparição de cada grupo, e os sem grupo abrem a seção (é onde o autor os vê hoje).
 */
export function setSectionItems(
  doc: SchemaDoc,
  key: string,
  items: readonly SchemaItem[],
  schema: DocSchema,
): SchemaDoc {
  const rule = schema.sections.find((s) => s.key === key);
  if (!rule) return doc;
  const nextId = blockIdFactory();
  const blocks: DocBlock[] = [];

  /**
   * O marcador de estado NUNCA vive no texto.
   *
   * Numa seção de checklist o estado tem campo próprio (`checked`), e o `- [ ] ` é a SINTAXE que a
   * serialização acrescenta. Um texto que já o carrega produz `- [ ] [ ] …` — duas caixas, uma
   * clicável e outra literal — e o defeito é silencioso: nada valida, o round-trip é estável (o
   * texto sujo volta igual), e só se vê olhando a tela. Aconteceu de verdade, no PRD deste board.
   *
   * A limpeza mora AQUI porque este é o único ponto por onde as três portas de escrita passam para
   * virar bloco. Limpar em `write_doc` deixaria o editor e a fonte markdown de fora.
   */
  const semMarcador = (text: string): string => text.replace(/^\s*\[([ xX])\]\s+/, "");

  const toBlock = (item: SchemaItem): DocBlock =>
    rule.content === "checklist"
      ? {
          kind: "todo",
          id: nextId(),
          text: semMarcador(item.text),
          // Um `[x]` no texto é uma afirmação de estado do autor: respeita-se, em vez de descartar.
          checked: item.checked ?? /^\s*\[[xX]\]/.test(item.text),
        }
      : { kind: "bullet", id: nextId(), text: item.text };

  for (const item of items) if (!item.group) blocks.push(toBlock(item));

  const groups: string[] = [];
  for (const item of items) if (item.group && !groups.includes(item.group)) groups.push(item.group);
  for (const group of groups) {
    blocks.push({ kind: "heading", id: nextId(), level: 3, text: group });
    for (const item of items) if (item.group === group) blocks.push(toBlock(item));
  }

  return replaceSectionBlocks(doc, key, blocks, schema);
}

/** Acrescenta um item ao fim de uma seção (opcionalmente dentro de um grupo). */
export function appendSectionItem(
  doc: SchemaDoc,
  key: string,
  item: SchemaItem,
  schema: DocSchema,
): SchemaDoc {
  return setSectionItems(doc, key, [...sectionItems(doc, key), item], schema);
}

/** Reescreve UM item pelo índice dentro da seção. Índice fora da faixa devolve o doc intacto. */
export function updateSectionItem(
  doc: SchemaDoc,
  key: string,
  index: number,
  patch: Partial<SchemaItem>,
  schema: DocSchema,
): SchemaDoc {
  const items = sectionItems(doc, key);
  if (index < 0 || index >= items.length) return doc;
  const next = items.map((item, i) => (i === index ? { ...item, ...patch } : item));
  return setSectionItems(doc, key, next, schema);
}

/** Remove UM item pelo índice. */
export function removeSectionItem(doc: SchemaDoc, key: string, index: number, schema: DocSchema): SchemaDoc {
  const items = sectionItems(doc, key);
  if (index < 0 || index >= items.length) return doc;
  return setSectionItems(
    doc,
    key,
    items.filter((_, i) => i !== index),
    schema,
  );
}

// ---------------------------------------------------------------------------
// internos
// ---------------------------------------------------------------------------

function sortSections(sections: SectionContent[], schema: DocSchema): SectionContent[] {
  const order = orderedSections(schema).map((s) => s.key);
  return [...sections].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** Blocos que não contam como conteúdo em nenhuma forma (separadores puramente visuais). */
const INERT: ReadonlySet<DocBlock["kind"]> = new Set(["divider", "properties"]);

function validateContent(content: SectionContent, rule: SectionRule, schema: DocSchema): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  const meaningful = content.blocks.filter((b) => !INERT.has(b.kind));

  const wrong = (block: DocBlock, expected: string) =>
    violation("wrong-content-kind", `Em "${rule.label}" espera-se ${expected}. ${rule.hint}`, {
      sectionKey: rule.key,
      found: blockText(block),
    });

  if (rule.content === "items" || rule.content === "groups") {
    const childLabels = new Set(childSections(schema, rule.key).map((s) => labelKey(s.label)));
    for (const block of meaningful) {
      if (block.kind === "bullet" || block.kind === "numbered") continue;
      // `groups` aceita o `###` autoral; `items` não tem subdivisão.
      if (block.kind === "heading" && rule.content === "groups" && !childLabels.has(labelKey(block.text))) continue;
      out.push(wrong(block, "uma lista — um item por linha"));
      break;
    }
  } else if (rule.content === "checklist") {
    for (const block of meaningful) {
      if (block.kind === "todo") continue;
      out.push(wrong(block, "uma lista de tarefas (`- [ ] texto`)"));
      break;
    }
  } else if (rule.content === "table") {
    for (const block of meaningful) {
      if (block.kind === "table") continue;
      out.push(wrong(block, "uma tabela"));
      break;
    }
  }
  // `prose` aceita qualquer bloco: é texto corrido, e uma lista dentro de prosa é prosa.

  if (bearsItems(rule.content)) {
    const count = meaningful.filter(
      (b) => b.kind === "bullet" || b.kind === "numbered" || b.kind === "todo",
    ).length;
    if (rule.min !== undefined && count < rule.min) {
      out.push(
        violation("too-few-items", `"${rule.label}" pede ao menos ${rule.min} ${plural(rule.min, "item", "itens")} — hoje tem ${count}.`, {
          sectionKey: rule.key,
        }),
      );
    }
    if (rule.max !== undefined && count > rule.max) {
      out.push(
        violation("too-many-items", `"${rule.label}" comporta no máximo ${rule.max} ${plural(rule.max, "item", "itens")} — hoje tem ${count}.`, {
          sectionKey: rule.key,
        }),
      );
    }
  }
  return out;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function blockText(block: DocBlock): string {
  if ("text" in block && typeof block.text === "string") return block.text.trim().slice(0, 80);
  if (block.kind === "section") return block.label;
  if (block.kind === "toggle") return block.title;
  return block.kind;
}
