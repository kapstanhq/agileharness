// 📄 style-doc — bidirectional projection Guia de Estilo ⇄ DocModel (the "style" docType).
//
// `StyleGuideDoc` stays canonical (sidecar compiled by the D3 chokepoint); the doc edits ONLY the
// per-section `prose` — the structured half (tokens, scale, lexicon, …) projects as READ-ONLY
// `section` blocks bound `style-ro:<key>` which commit SKIPS entirely, so prose may freely contain
// bullets/tables without ever colliding with the structured projections. Region rule mirrors
// card-doc's acceptance run: everything between a bound `style:<key>` heading and the next bound
// heading (minus read-only sections) is that section's prose. Commit reassembles
// `sections[*].prose` and rides `applyStyleGuideAssistAction` ({boardId, doc, baseVersion}) — the
// optimistic-concurrency chokepoint that compiles the .md and bumps the version (never these bytes).

import type { StyleGuideDoc } from "../style-guide";
import { STYLE_SECTIONS } from "../style-guide-blocks";
import { blockIdFactory, type DocBlock, type DocModel } from "./doc-model";
import { parseDocMd, serializeDocMd } from "./md-codec";

export const STYLE_DOC_TYPE = "style";
const HEADING_PREFIX = "style:";
const READONLY_PREFIX = "style-ro:";
/**
 * As três listas do LÉXICO do tom (`voice.lexicon`), EDITÁVEIS pelo dono na página: o tom é dele, e o
 * `write_styleguide` recusa a seção — sem isto ninguém mais conseguia mudar a lista de palavras. Cada lista é
 * um subtítulo vinculado `style-lex:<lista>` dentro da região do tom; os itens dela são as linhas abaixo.
 */
const LEXICON_PREFIX = "style-lex:";
/** O título de um GRUPO da página (`components/design/style-page.ts`) — apresentação, o commit o ignora. */
export const GROUP_PREFIX = "style-group:";
type LexiconList = "preferred" | "forbidden" | "exceptions";
const LEXICON_LISTS: readonly { key: LexiconList; label: string }[] = [
  { key: "preferred", label: "Prefira (use → em vez de)" },
  { key: "forbidden", label: "Nunca use" },
  { key: "exceptions", label: "Exceções" },
];
/** `use → evite` — o separador de um item de «Prefira» (aceita também `->`). */
const PREFERRED_SEP = /\s*(?:→|->)\s*/;

export const STYLE_ALLOWED_BLOCKS: DocBlock["kind"][] = [
  "paragraph",
  "bullet",
  "numbered",
  "quote",
  "code",
];

/** Sections of StyleGuideDoc that carry a `prose` field, keyed like STYLE_SECTIONS. */
type ProseKey =
  | "identity"
  | "principles"
  | "color"
  | "typography"
  | "spacing"
  | "shape"
  | "motion"
  | "voice"
  | "components";

const PROSE_KEYS: readonly ProseKey[] = [
  "identity",
  "principles",
  "color",
  "typography",
  "spacing",
  "shape",
  "motion",
  "voice",
  "components",
];

function proseOf(doc: StyleGuideDoc, key: string): string | null {
  return PROSE_KEYS.includes(key as ProseKey) ? (doc[key as ProseKey]?.prose ?? "") : null;
}

export function projectStyleDoc(doc: StyleGuideDoc): DocModel {
  const nextId = blockIdFactory();
  const blocks: DocBlock[] = [];

  blocks.push({
    kind: "properties",
    id: nextId(),
    entries: [
      { key: "version", label: "Versão", icon: "git-commit-vertical", value: { kind: "badge", text: `v${doc.meta.version}` } },
      { key: "school", label: "Escola", icon: "palette", value: { kind: "text", text: doc.identity.school || "—" } },
      { key: "updated", label: "Atualizado", icon: "clock", value: { kind: "text", text: doc.meta.updatedAt || "—" } },
    ],
  });

  for (const def of STYLE_SECTIONS) {
    const prose = proseOf(doc, def.key);
    if (prose === null && def.key !== "antiPatterns" && def.key !== "debt") continue;
    blocks.push({
      kind: "heading",
      id: nextId(),
      level: 2,
      text: def.label,
      icon: "brush",
      binding: `${HEADING_PREFIX}${def.key}`,
    });
    if (prose !== null) {
      if (prose.trim()) blocks.push(...reId(parseDocMd(prose).blocks, nextId));
      else blocks.push({ kind: "paragraph", id: nextId(), text: "" });
    }
    if (def.key === "voice") blocks.push(...lexiconProjection(doc, nextId));
    const ro = readOnlyProjection(doc, def.key, nextId);
    if (ro) blocks.push(ro);
  }

  return { docType: STYLE_DOC_TYPE, title: "Guia de Estilo", blocks };
}

/** O léxico do tom como três listas editáveis (subtítulo vinculado + um item por linha; lista vazia = um item vazio). */
function lexiconProjection(doc: StyleGuideDoc, nextId: () => string): DocBlock[] {
  const out: DocBlock[] = [];
  const lex = doc.voice.lexicon;
  for (const list of LEXICON_LISTS) {
    out.push({ kind: "heading", id: nextId(), level: 3, text: list.label, binding: `${LEXICON_PREFIX}${list.key}` });
    const items = list.key === "preferred" ? lex.preferred.map((p) => `${p.use} → ${p.avoid}`) : lex[list.key];
    if (!items.length) out.push({ kind: "bullet", id: nextId(), text: "" });
    for (const text of items) out.push({ kind: "bullet", id: nextId(), text });
  }
  return out;
}

/** O texto de um bloco de lista/parágrafo, para virar item do léxico (`null` para o que não é linha de texto). */
function lineText(block: DocBlock): string | null {
  return block.kind === "bullet" || block.kind === "numbered" || block.kind === "paragraph" || block.kind === "todo"
    ? block.text.trim()
    : null;
}

/** As linhas de uma lista do léxico → o valor dela (linhas vazias somem; «Prefira» sem `→` vira `use` sem `avoid`). */
function lexiconFromLines(key: LexiconList, lines: string[]): StyleGuideDoc["voice"]["lexicon"][LexiconList] {
  const texts = lines.filter(Boolean);
  if (key !== "preferred") return texts;
  return texts.map((t) => {
    const [use, ...rest] = t.split(PREFERRED_SEP);
    return { use: use.trim(), avoid: rest.join(" ").trim() };
  });
}

/** The structured half of a section, as ONE read-only section block (commit skips it). */
function readOnlyProjection(
  doc: StyleGuideDoc,
  key: string,
  nextId: () => string,
): DocBlock | null {
  const body: DocBlock[] = [];
  switch (key) {
    case "identity":
      if (doc.identity.personality.length)
        body.push({ kind: "paragraph", id: nextId(), text: doc.identity.personality.map((p) => `\`${p}\``).join(" · ") });
      break;
    case "principles":
      doc.principles.items.forEach((item) => body.push({ kind: "numbered", id: nextId(), text: item }));
      break;
    case "color":
      if (doc.color.tokens.length)
        body.push({
          kind: "table",
          id: nextId(),
          header: ["Papel", "Valor", "Uso", "Budget"],
          rows: doc.color.tokens.map((t) => [t.role, `\`${t.value}\``, t.usage ?? "", t.budget ?? ""]),
        });
      break;
    case "typography":
      if (doc.typography.scale.length)
        body.push({
          kind: "table",
          id: nextId(),
          header: ["Nível", "Tamanho", "Peso", "Regra"],
          rows: doc.typography.scale.map((l) => [l.id, l.size, String(l.weight), l.rule ?? ""]),
        });
      break;
    case "spacing":
      body.push({ kind: "paragraph", id: nextId(), text: `Base \`${doc.spacing.base}px\` · passos ${doc.spacing.steps.map((s) => `\`${s}\``).join(" ")}` });
      break;
    case "shape":
      body.push({ kind: "paragraph", id: nextId(), text: Object.entries(doc.shape.radii).map(([k, v]) => `${k}: \`${v}\``).join(" · ") || "—" });
      break;
    case "motion":
      body.push({ kind: "paragraph", id: nextId(), text: Object.entries(doc.motion.durations).map(([k, v]) => `${k}: \`${v}\``).join(" · ") || "—" });
      break;
    // voice: o léxico é EDITÁVEL (lexiconProjection) — o tom é do dono, não do assistente
    case "components":
      // opcional: um guia de antes da seção (sem coerce) não a tem
      if (doc.components?.items.length)
        body.push({
          kind: "table",
          id: nextId(),
          header: ["Componente", "Regra"],
          rows: doc.components.items.map((c) => [c.name, c.rule]),
        });
      break;
    case "antiPatterns":
      if (doc.antiPatterns.length)
        body.push({
          kind: "table",
          id: nextId(),
          header: ["Sintoma", "Correção"],
          rows: doc.antiPatterns.map((a) => [a.symptom, a.fix]),
        });
      break;
    case "debt":
      doc.debt.knownIssues.forEach((issue) => body.push({ kind: "bullet", id: nextId(), text: issue }));
      break;
  }
  if (!body.length) return null;
  return {
    kind: "section",
    id: nextId(),
    // uma LEGENDA discreta (tom `note`), não um título por seção: o dado é mantido pelo assistente do guia
    // (`write_styleguide`), e quem quer mudá-lo pede no compositor da página
    label: "Mantido pelo assistente do guia — peça a mudança no compositor abaixo",
    tone: "note",
    binding: `${READONLY_PREFIX}${key}`,
    body,
  };
}

export interface StyleCommitResult {
  /** Rebuilt doc (prose only) — feed applyStyleGuideAssistAction with the pointer's baseVersion. */
  doc: StyleGuideDoc;
  changedSections: string[];
  unbound: { id: string; kind: string; text: string }[];
}

export function commitStyleDoc(model: DocModel, prev: StyleGuideDoc): StyleCommitResult {
  const unbound: StyleCommitResult["unbound"] = [];
  const regions = new Map<string, DocBlock[]>();
  const lexicon = new Map<LexiconList, string[]>();
  let currentKey: string | null = null;
  let currentLex: LexiconList | null = null;

  for (const block of model.blocks) {
    if (block.kind === "properties") continue;
    if (block.kind === "section" && block.binding?.startsWith(READONLY_PREFIX)) continue;
    // um título de GRUPO da página (Estética, Anti-padrões e dívidas): só apresentação
    if (block.kind === "heading" && block.binding?.startsWith(GROUP_PREFIX)) {
      currentKey = null;
      currentLex = null;
      continue;
    }
    // uma lista do léxico, dentro da região do tom
    if (block.kind === "heading" && block.binding?.startsWith(LEXICON_PREFIX) && currentKey === "voice") {
      const key = block.binding.slice(LEXICON_PREFIX.length) as LexiconList;
      if (LEXICON_LISTS.some((l) => l.key === key)) {
        currentLex = key;
        if (!lexicon.has(key)) lexicon.set(key, []);
        continue;
      }
    }
    if (currentLex && currentKey === "voice" && block.kind !== "heading") {
      const text = lineText(block);
      if (text !== null) {
        lexicon.get(currentLex)!.push(text);
        continue;
      }
    }
    if (block.kind === "heading") {
      currentLex = null;
      const bound = block.binding?.startsWith(HEADING_PREFIX)
        ? block.binding.slice(HEADING_PREFIX.length)
        : STYLE_SECTIONS.find((s) => s.label.toLowerCase() === block.text.trim().toLowerCase())?.key;
      if (bound && STYLE_SECTIONS.some((s) => s.key === bound)) {
        currentKey = bound;
        if (!regions.has(bound)) regions.set(bound, []);
        continue;
      }
      // an H3+ inside a region is prose content; an unrecognized H2 is refused
      if (block.level === 2) {
        unbound.push({ id: block.id, kind: block.kind, text: block.text });
        currentKey = null;
        continue;
      }
    }
    if (!currentKey) {
      unbound.push({
        id: block.id,
        kind: block.kind,
        text: "text" in block && typeof block.text === "string" ? block.text : block.kind,
      });
      continue;
    }
    regions.get(currentKey)!.push(block);
  }

  if (unbound.length) return { doc: prev, changedSections: [], unbound };

  const next: StyleGuideDoc = structuredClone(prev);
  const changedSections: string[] = [];
  for (const [key, blocks] of regions) {
    const prevProse = proseOf(prev, key);
    if (prevProse === null) continue; // antiPatterns/debt have no prose — read-only regions
    let prose = serializeDocMd({ docType: model.docType, title: "", blocks }).trim();
    if (prose !== prevProse.trim()) {
      const prevCanonical = serializeDocMd({
        docType: model.docType,
        title: "",
        blocks: parseDocMd(prevProse).blocks,
      }).trim();
      if (prevCanonical === prose) prose = prevProse;
    } else {
      prose = prevProse;
    }
    if (prose !== prevProse) {
      (next[key as ProseKey] as { prose: string }).prose = prose;
      changedSections.push(key);
    }
  }
  // O léxico só muda quando a lista FOI editada (está no modelo): um modelo sem os subtítulos não apaga nada.
  let lexChanged = false;
  for (const [key, lines] of lexicon) {
    const value = lexiconFromLines(key, lines);
    if (JSON.stringify(value) !== JSON.stringify(prev.voice.lexicon[key])) {
      (next.voice.lexicon as Record<LexiconList, unknown>)[key] = value;
      lexChanged = true;
    }
  }
  if (lexChanged && !changedSections.includes("voice")) changedSections.push("voice");

  return { doc: next, changedSections, unbound };
}

function reId(blocks: DocBlock[], nextId: () => string): DocBlock[] {
  return blocks.map((block) => {
    const withId = { ...block, id: nextId() } as DocBlock;
    if (withId.kind === "toggle") withId.children = reId(withId.children, nextId);
    if (withId.kind === "section") withId.body = reId(withId.body, nextId);
    return withId;
  });
}
