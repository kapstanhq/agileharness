// 📄 vocab-doc — bidirectional projection Persona/Sistema ⇄ DocModel (the "persona"/"system"
// docTypes). The vocabulary rows in board.yaml stay canonical; the doc edits the PRIMARY `prompt`
// field (title edits map to `name`). Rows authored before the prompt model project a composed body
// from the LEGACY structured fields — the first doc save persists that composition into `prompt`
// (lazy migration, same convention the VocabularyManager's editor uses; legacy fields stay
// untouched in the YAML so older readers keep working). Write path: patchPersonaAction/
// patchSystemAction (direct, fresh-read anti-clobber — vocabulary is not governance-gated).

import type { Persona, SystemDef } from "../types";
import { vocabSubtitle } from "../vocab";
import { blockIdFactory, type DocBlock, type DocModel } from "./doc-model";
import { parseDocMd, serializeDocMd } from "./md-codec";

export const PERSONA_DOC_TYPE = "persona";
export const SYSTEM_DOC_TYPE = "system";

export const VOCAB_ALLOWED_BLOCKS: DocBlock["kind"][] = [
  "heading",
  "paragraph",
  "bullet",
  "numbered",
  "todo",
  "quote",
  "code",
  "divider",
  "section",
  "table",
];

/** Same composition shape the VocabularyManager migrates from — one draft body from legacy fields. */
export function composeVocabBody(entity: Persona | SystemDef, kind: "persona" | "system"): string {
  const parts: string[] = [];
  if (kind === "persona") {
    const p = entity as Persona;
    if (p.role?.trim()) parts.push(p.role.trim());
    if (p.description?.trim()) parts.push(p.description.trim());
    if (p.jobs?.length) parts.push("## Jobs\n\n" + p.jobs.map((j) => `- ${j}`).join("\n"));
    if (p.pains?.length) parts.push("## Dores\n\n" + p.pains.map((j) => `- ${j}`).join("\n"));
    if (p.gains?.length) parts.push("## Ganhos\n\n" + p.gains.map((g) => `- ${g}`).join("\n"));
  } else {
    const s = entity as SystemDef;
    if (s.description?.trim()) parts.push(s.description.trim());
    if (s.capabilities?.length)
      parts.push("## Capacidades\n\n" + s.capabilities.map((c) => `- ${c}`).join("\n"));
    if (s.constraints?.length)
      parts.push("## Limites & gotchas\n\n" + s.constraints.map((c) => `- ${c}`).join("\n"));
  }
  return parts.join("\n\n");
}

export function projectVocabDoc(
  entity: Persona | SystemDef,
  kind: "persona" | "system",
  deps: { referencedByCount?: number } = {},
): DocModel {
  const nextId = blockIdFactory();
  const blocks: DocBlock[] = [];

  // O `kind` da entidade agora é o MESMO conceito nos dois lados (a persona também o tem), então o
  // selo diz "Persona · Segmento de mercado" / "Sistema · Canal" pela mesma regra — e não por um ramo
  // que só o sistema atravessava. O IDENTIFICADOR entrou porque é o que o agente e os cards citam:
  // sem ele, quem quer referenciar esta linha num prompt ou numa tool tinha de adivinhá-lo pela URL.
  const typeSuffix = entity.kind?.trim() ? ` · ${entity.kind.trim()}` : "";
  const summary = vocabSubtitle(entity, kind);
  blocks.push({
    kind: "properties",
    id: nextId(),
    entries: [
      {
        key: "kind",
        label: "Tipo",
        icon: kind === "persona" ? "user-round" : "server",
        value: { kind: "badge", text: `${kind === "persona" ? "Persona" : "Sistema"}${typeSuffix}` },
      },
      {
        key: "id",
        label: "Identificador",
        icon: "hash",
        value: { kind: "text", text: entity.id },
      },
      {
        key: "color",
        label: "Cor",
        icon: "circle",
        value: { kind: "status", text: entity.color ?? "—", color: entity.color },
      },
      ...(summary
        ? [
            {
              key: "summary",
              label: kind === "persona" ? "Papel" : "Resumo",
              icon: "target",
              value: { kind: "text" as const, text: summary },
            },
          ]
        : []),
      ...(deps.referencedByCount != null
        ? [
            {
              key: "refs",
              label: "Adotada por",
              icon: "layers",
              value: {
                kind: "text" as const,
                text: `${deps.referencedByCount} ${deps.referencedByCount === 1 ? "card" : "cards"}`,
              },
            },
          ]
        : []),
    ],
  });

  const body = entity.prompt?.trim() ? entity.prompt : composeVocabBody(entity, kind);
  if (body.trim()) {
    blocks.push(...reId(parseDocMd(body).blocks, nextId));
  } else {
    blocks.push({ kind: "paragraph", id: nextId(), text: "" });
  }

  return {
    docType: kind === "persona" ? PERSONA_DOC_TYPE : SYSTEM_DOC_TYPE,
    title: entity.name,
    blocks,
  };
}

export interface VocabCommitResult {
  patch: { name?: string; prompt?: string };
  changed: boolean;
}

/**
 * Free-region commit: every non-properties block serializes back into `prompt`; the title maps to
 * `name`. Byte-preserve: canonicalization alone never counts as an edit — but a row still on legacy
 * fields (prompt unset) DOES persist the composed body on first save (the lazy migration).
 */
export function commitVocabDoc(
  model: DocModel,
  prev: Persona | SystemDef,
  kind: "persona" | "system",
): VocabCommitResult {
  const free = model.blocks.filter((b) => b.kind !== "properties");
  let prompt = serializeDocMd({ docType: model.docType, title: "", blocks: free }).trimEnd();

  const prevPrompt = prev.prompt?.trim() ? prev.prompt : null;
  if (prevPrompt !== null) {
    const prevCanonical = serializeDocMd({
      docType: model.docType,
      title: "",
      blocks: parseDocMd(prevPrompt).blocks,
    }).trimEnd();
    if (prevCanonical === prompt) prompt = prevPrompt;
  } else {
    // Legacy row: an untouched doc serializes exactly the canonical form of the composed body —
    // persisting it IS the intended lazy migration, so no byte-preserve here.
  }

  const name = model.title.trim() || prev.name;
  const patch: VocabCommitResult["patch"] = {};
  if (name !== prev.name) patch.name = name;
  if (prompt !== (prev.prompt ?? "")) patch.prompt = prompt;
  return { patch, changed: Object.keys(patch).length > 0 };
}

function reId(blocks: DocBlock[], nextId: () => string): DocBlock[] {
  return blocks.map((block) => {
    const withId = { ...block, id: nextId() } as DocBlock;
    if (withId.kind === "toggle") withId.children = reId(withId.children, nextId);
    if (withId.kind === "section") withId.body = reId(withId.body, nextId);
    return withId;
  });
}
