// 🗂️ vocab — as derivações PURAS de uma persona/sistema do board: como uma linha se lê (o subtítulo e a
// primeira frase do prompt) e a dobra de texto da busca.
//
// A tela de Personas & Sistemas saiu na fase 2 (as personas são a seção «Personas» do PRD; os sistemas viraram
// contexto que o chat mantém por `write_vocab`). Ficou aqui só o que a escrita do agente (`vocab-actions.ts`) e o
// filtro do Kanban ainda leem — sem React, sem `node:fs`, sem server action.

import type { Persona, SystemDef } from "./types";

export type VocabKind = "persona" | "system";

/** A primeira frase legível de um markdown: sem `#`, sem `>`, sem marcador de lista, sem `**`. */
export function firstLine(md: string | undefined | null): string {
  for (const raw of String(md ?? "").split("\n")) {
    const line = raw
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s+/, "")
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`(.+?)`/g, "$1")
      .trim();
    if (line) return line;
  }
  return "";
}

/**
 * O subtítulo de uma linha. Prefere o que foi DECLARADO (o `role` da persona, a `description` do
 * sistema) e só cai na primeira frase do prompt quando não há declaração — nessa ordem porque o
 * campo declarado é curto por construção e a primeira frase do prompt costuma ser um "Você é…"
 * que repete o nome que já está ao lado.
 */
export function vocabSubtitle(entity: Persona | SystemDef, kind: VocabKind): string {
  const declared =
    kind === "persona" ? (entity as Persona).role?.trim() : (entity as SystemDef).description?.trim();
  if (declared) return declared;
  return firstLine(entity.prompt);
}

/** Texto sem acento e em minúsculas — a busca de um board PT-BR não pode exigir o til certo. */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
