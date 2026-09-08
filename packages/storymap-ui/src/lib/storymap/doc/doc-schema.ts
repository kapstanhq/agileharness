// 📐 DocSchema — o CONTRATO de conteúdo de um documento. A camada do meio de três:
//
//   Camada 1  markdown + frontmatter  → a FONTE DA VERDADE (bytes em disco, GFM puro)
//   Camada 2  DocSchema (este arquivo) → o CONTRATO: que seções existem, travadas?, que conteúdo
//   Camada 3  views                    → as PROJEÇÕES (documento, markdown, tabela, quadro, kanban…)
//
// A REGRA que mantém as camadas separadas, e que este arquivo existe para não deixar apodrecer:
//
//   **Nenhum termo daqui pode existir só porque uma view existe.**
//
// Nada de célula de grid, cor, ícone, largura, ordem visual, "post-it", "chip", "coluna". Isso é
// Camada 3 e mora no LAYOUT que a view importa (views/board-layouts/*), nunca aqui. Um schema que
// carrega `cell: "lg:col-start-1"` deixou de descrever conteúdo e passou a descrever UMA tela — e a
// próxima view herda a decisão da anterior. Dois testes mecânicos guardam a regra
// (doc-schema-agnostic.test.ts):
//
//   · APAGAMENTO      — apague uma view: sobrou algum termo órfão no schema? era layout disfarçado.
//   · TERCEIRA ENTIDADE — o mesmo vocabulário descreve canvas, card e persona sem UMA palavra que
//                         só faça sentido em um dos três?
//
// PURO por contrato: sem `node:fs`, sem React, sem gray-matter. O cliente importa este módulo para
// decidir quais views uma entidade oferece — arrastar um módulo de servidor para cá reprova o
// `next build` (e o `tsc --noEmit` NÃO pega isso).

import { z } from "zod";
import { blockIdFactory, type DocBlock } from "./doc-model";

// ---------------------------------------------------------------------------
// O vocabulário
// ---------------------------------------------------------------------------

/**
 * O que vive DENTRO de uma seção. Seis primitivas, todas genéricas — nenhuma delas nomeia uma
 * entidade ou uma tela.
 *
 * · `prose`     — parágrafos livres. Aceita qualquer bloco: é texto corrido de verdade.
 * · `items`     — unidades atômicas, uma por linha (a lista é o dado, não a decoração).
 * · `checklist` — itens com estado (feito/não feito).
 * · `table`     — grade.
 * · `groups`    — subdivisões AUTORAIS (`###` livres) contendo itens; itens soltos antes do
 *                 primeiro grupo são legítimos (grupo é opcional por construção).
 */
export type ContentKind = "prose" | "items" | "checklist" | "table" | "groups";

/** As primitivas que aceitam itens de lista — a pergunta que as views fazem o tempo todo. */
export const ITEM_BEARING_KINDS: readonly ContentKind[] = ["items", "checklist", "groups"];

export function bearsItems(kind: ContentKind): boolean {
  return ITEM_BEARING_KINDS.includes(kind);
}

/**
 * Uma seção do esqueleto.
 *
 * `locked` é a regra que o operador pediu em voz alta: o RÓTULO não é editável, o CONTEÚDO é. Ela
 * vale nas três portas de escrita (editor rico, fonte markdown, agente/MCP) — quem a aplica são o
 * validador aqui e o chokepoint de escrita; a UI apenas TORNA VISÍVEL o que já é verdade.
 */
export interface SectionRule {
  /** identidade estável da seção — o que views, layouts e o agente citam. Nunca o rótulo. */
  key: string;
  /** o texto LITERAL do heading no markdown. Travado ⇒ é exatamente isto, byte a byte. */
  label: string;
  /** 2 = seção de topo; 3 = seção aninhada (precisa de `parent`). */
  level: 2 | 3;
  /** a `key` da seção de topo que a contém (só para `level: 3`). */
  parent?: string;
  /** o rótulo pode ser reescrito pelo autor? */
  locked: boolean;
  /** a seção precisa existir para o documento estar completo? */
  required: boolean;
  content: ContentKind;
  /** cardinalidade esperada de itens — informa o vazio e o excesso, nunca recusa o salvamento. */
  min?: number;
  max?: number;
  /** o que se escreve aqui, em uma frase. Vira o empty-state em QUALQUER view. */
  hint: string;
}

/**
 * O título do documento (o `# H1`).
 *
 * `fixed`    — o documento É aquela coisa (um Lean Canvas é "Lean Canvas"). Renomear é violação.
 * `authored` — o título é conteúdo do autor (o título de um card, o nome de uma persona) e
 *              round-trippa livre.
 */
export type DocTitleRule =
  | { kind: "fixed"; text: string }
  | { kind: "authored"; hint: string };

export interface DocSchema {
  /** chave de registro — "lean-canvas", "card", "persona", … */
  docType: string;
  title: DocTitleRule;
  /**
   * O que a MÁQUINA lê (ids, cores, status, roteamento). A linha que evita o drift de volta para
   * "prosa dentro de YAML" é esta: frontmatter = o que a máquina roteia; corpo = o que o humano lê.
   */
  frontmatter?: z.ZodType<Record<string, unknown>>;
  sections: SectionRule[];
  /** conteúdo livre DEPOIS do esqueleto é aceito? (o corpo de um card é; um canvas não tem). */
  allowFreeTail: boolean;
}

// ---------------------------------------------------------------------------
// Violações
// ---------------------------------------------------------------------------

export type ViolationCode =
  /** um heading travado foi reescrito (ou o `# Título` de um doc de título fixo). */
  | "heading-renamed"
  /** uma seção `required` não está no documento. */
  | "heading-missing"
  /** a mesma seção aparece duas vezes — a segunda não tem para onde ir. */
  | "heading-duplicated"
  /** um heading de nível de seção que o schema não conhece (e a cauda livre não aceita). */
  | "heading-unknown"
  /** as seções estão fora da ordem do schema. */
  | "out-of-order"
  /** uma seção aninhada apareceu fora do pai dela. */
  | "orphan-subsection"
  /** o conteúdo não tem a forma que a seção declara (parágrafo onde se esperava item). */
  | "wrong-content-kind"
  /** menos itens do que o `min`. */
  | "too-few-items"
  /** mais itens do que o `max`. */
  | "too-many-items"
  /** o frontmatter não satisfaz o Zod do schema. */
  | "frontmatter-invalid";

/**
 * ERROR recusa o salvamento; WARNING informa e deixa passar.
 *
 * O corte é deliberado: quebrar o ESQUELETO (renomear/sumir/duplicar/desordenar) invalida a leitura
 * que toda view faz, então recusa. Já um documento em construção — seção vazia, um parágrafo onde
 * ainda vai virar lista — é trabalho normal em andamento; recusar aí seria transformar o validador
 * num obstáculo à escrita, que é o oposto do ponto.
 */
export type ViolationSeverity = "error" | "warning";

export interface SchemaViolation {
  code: ViolationCode;
  severity: ViolationSeverity;
  /** a seção afetada, quando a violação tem uma. */
  sectionKey?: string;
  /** o que o autor de fato escreveu — o que a mensagem precisa citar de volta. */
  found?: string;
  /** PT-BR, prescritiva: diz o que fazer, não só o que está errado. */
  message: string;
}

const SEVERITY_BY_CODE: Record<ViolationCode, ViolationSeverity> = {
  "heading-renamed": "error",
  "heading-missing": "error",
  "heading-duplicated": "error",
  "heading-unknown": "error",
  "out-of-order": "error",
  "orphan-subsection": "error",
  "wrong-content-kind": "warning",
  "too-few-items": "warning",
  "too-many-items": "warning",
  "frontmatter-invalid": "error",
};

export function severityOf(code: ViolationCode): ViolationSeverity {
  return SEVERITY_BY_CODE[code];
}

export function violation(
  code: ViolationCode,
  message: string,
  extra: { sectionKey?: string; found?: string } = {},
): SchemaViolation {
  return { code, severity: severityOf(code), message, ...extra };
}

/** As que recusam o salvamento. Vazio ⇒ pode gravar. */
export function blockingViolations(violations: readonly SchemaViolation[]): SchemaViolation[] {
  return violations.filter((v) => v.severity === "error");
}

// ---------------------------------------------------------------------------
// Acesso ao schema
// ---------------------------------------------------------------------------

/** Normalização de rótulo para casamento — a MESMA de `reattachSections` (doc-model.ts). */
export function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

export function sectionByKey(schema: DocSchema, key: string): SectionRule | undefined {
  return schema.sections.find((s) => s.key === key);
}

/** Casa um heading escrito pelo autor com uma regra do schema. `undefined` = heading desconhecido. */
export function sectionByLabel(
  schema: DocSchema,
  label: string,
  opts: { level?: 2 | 3; parent?: string } = {},
): SectionRule | undefined {
  const wanted = labelKey(label);
  return schema.sections.find(
    (s) =>
      labelKey(s.label) === wanted &&
      (opts.level === undefined || s.level === opts.level) &&
      (opts.parent === undefined || s.parent === opts.parent),
  );
}

export function topLevelSections(schema: DocSchema): SectionRule[] {
  return schema.sections.filter((s) => s.level === 2);
}

export function childSections(schema: DocSchema, parentKey: string): SectionRule[] {
  return schema.sections.filter((s) => s.parent === parentKey);
}

/** A ordem canônica de serialização: cada seção de topo seguida das filhas dela. */
export function orderedSections(schema: DocSchema): SectionRule[] {
  const out: SectionRule[] = [];
  for (const top of topLevelSections(schema)) {
    out.push(top);
    out.push(...childSections(schema, top.key));
  }
  return out;
}

/**
 * Integridade do PRÓPRIO schema (não do documento) — erros de autoria que devem explodir cedo, no
 * teste do schema, e não virar comportamento estranho no parse: filha sem pai, pai inexistente,
 * chave duplicada, rótulo duplicado no mesmo nível, nível 3 sem pai.
 */
export function validateSchema(schema: DocSchema): string[] {
  const problems: string[] = [];
  const seenKeys = new Set<string>();
  for (const s of schema.sections) {
    if (seenKeys.has(s.key)) problems.push(`chave de seção duplicada: "${s.key}"`);
    seenKeys.add(s.key);
    if (s.level === 3 && !s.parent) problems.push(`seção "${s.key}" é nível 3 sem \`parent\``);
    if (s.level === 2 && s.parent) problems.push(`seção "${s.key}" é nível 2 mas declara \`parent\``);
    if (s.parent && !schema.sections.some((p) => p.key === s.parent && p.level === 2)) {
      problems.push(`seção "${s.key}" aponta para o pai inexistente "${s.parent}"`);
    }
  }
  // Rótulo duplicado no mesmo escopo torna o casamento por rótulo ambíguo — e o casamento por
  // rótulo é a rede que segura a superfície que perde props (a fonte markdown).
  const scope = (s: SectionRule) => `${s.level}:${s.parent ?? ""}:${labelKey(s.label)}`;
  const seenScopes = new Set<string>();
  for (const s of schema.sections) {
    if (seenScopes.has(scope(s))) problems.push(`rótulo ambíguo no mesmo escopo: "${s.label}"`);
    seenScopes.add(scope(s));
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Esqueleto
// ---------------------------------------------------------------------------

/** As seções que um documento novo já nasce tendo. */
export function skeletonSectionKeys(schema: DocSchema): string[] {
  return orderedSections(schema)
    .filter((s) => s.required)
    .map((s) => s.key);
}

/**
 * O documento VAZIO do schema, em markdown: título + todas as seções obrigatórias, sem conteúdo.
 * É o que a criação grava e o que a UI mostra como ponto de partida — um documento novo nasce
 * VÁLIDO, nunca com o esqueleto quebrado por omissão.
 */
export function emptyDocMarkdown(schema: DocSchema, titleText?: string): string {
  const title = schema.title.kind === "fixed" ? schema.title.text : (titleText ?? "");
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, "");
  for (const rule of orderedSections(schema)) {
    if (!rule.required) continue;
    lines.push(`${"#".repeat(rule.level)} ${rule.label}`, "");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/** Os blocos do esqueleto vazio como IR — para superfícies que montam o modelo sem passar por texto. */
export function emptyDocBlocks(schema: DocSchema): DocBlock[] {
  const nextId = blockIdFactory();
  return orderedSections(schema)
    .filter((s) => s.required)
    .map((rule): DocBlock => ({ kind: "heading", id: nextId(), level: rule.level, text: rule.label }));
}
