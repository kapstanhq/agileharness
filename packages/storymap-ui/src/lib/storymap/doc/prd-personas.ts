// 👥 As PERSONAS do board vêm do PRD — a seção «Personas», um `###` por persona. PURO.
//
// Antes elas viviam só no `board.yaml` (`personas[]`, com `prompt`), editadas numa tela própria. O
// dono decidiu (06/10): a persona é parte do documento de produto, só ele a muda (agentes propõem por
// `propose_change artifact:"prd" field:"personas"`), e a tela própria sai. Quem lia `config.personas`
// (o vocabulário do MCP, o motor, o procurador) passa a ler ESTA projeção, com o `board.yaml` como
// piso legado: um board que ainda não escreveu a seção continua com as personas que tinha.
//
// O CASAMENTO com o legado é o que mantém os cards válidos: um card guarda o ID da persona
// (`card.personas: ["leitor"]`), e o PRD guarda o NOME. Uma persona do PRD cujo nome (ou id) bate com
// uma do `board.yaml` herda o id, a cor, o avatar e o tipo dela; as outras ganham um id derivado do
// nome. As do `board.yaml` que o PRD não cita seguem no fim — sumir com elas tiraria de um card a
// persona que ele referencia.

import type { Persona } from "../types";
import { serializeDocMd } from "./md-codec";
import { sectionContent, type SchemaDoc } from "./schema-codec";
import { PRD_ALTERNATIVES_GROUP, PRD_DOC_TYPE } from "./schemas/prd";

/** `Leitor frequente (early adopter)` → `leitor-frequente-early-adopter`. */
export function personaSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function norm(text: string): string {
  return personaSlug(text);
}

/** As personas escritas no PRD — nome + o texto do grupo (markdown) como `prompt`. */
export function prdPersonaEntries(doc: SchemaDoc | null | undefined): { name: string; prompt: string }[] {
  const blocks = doc ? (sectionContent(doc, "personas")?.blocks ?? []) : [];
  const out: { name: string; prompt: string; blocks: typeof blocks }[] = [];
  let current: (typeof out)[number] | null = null;
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 3) {
      const name = block.text.trim();
      current = norm(name) === norm(PRD_ALTERNATIVES_GROUP) || !name ? null : { name, prompt: "", blocks: [] };
      if (current) out.push(current);
      continue;
    }
    current?.blocks.push(block);
  }
  return out.map(({ name, blocks: b }) => ({
    name,
    prompt: serializeDocMd({ docType: PRD_DOC_TYPE, title: "", blocks: b }, { includeTitle: false }).trim(),
  }));
}

/**
 * As personas do board: as do PRD (casadas com as do `board.yaml` por nome ou id) e, depois, as do
 * `board.yaml` que o PRD não cita. PRD sem personas ⇒ exatamente o `board.yaml` (o piso legado).
 */
export function projectPersonas(doc: SchemaDoc | null | undefined, legacy: readonly Persona[]): Persona[] {
  const fromPrd = prdPersonaEntries(doc);
  if (!fromPrd.length) return [...legacy];

  // Casamento em DUAS passadas: primeiro o exato (nome ou id = slug do nome, para todas as entradas),
  // depois o id legado igual à PRIMEIRA palavra do nome («Leitor frequente» ↔ `leitor`). A ordem
  // importa: o exato de uma entrada nunca é roubado pelo aproximado de outra.
  const matched = new Map<number, Persona>();
  const taken = new Set<string>();
  fromPrd.forEach((entry, i) => {
    const key = norm(entry.name);
    const hit = legacy.find((p) => !taken.has(p.id) && (norm(p.name) === key || norm(p.id) === key));
    if (hit) {
      matched.set(i, hit);
      taken.add(hit.id);
    }
  });
  fromPrd.forEach((entry, i) => {
    if (matched.has(i)) return;
    const first = norm(entry.name).split("-")[0];
    const hit = first ? legacy.find((p) => !taken.has(p.id) && norm(p.id) === first) : undefined;
    if (hit) {
      matched.set(i, hit);
      taken.add(hit.id);
    }
  });

  const used = new Set<string>();
  const out: Persona[] = [];
  fromPrd.forEach((entry, i) => {
    const match = matched.get(i);
    const id = match?.id ?? (norm(entry.name) || `persona-${i + 1}`);
    if (used.has(id)) return;
    used.add(id);
    out.push({ ...(match ?? {}), id, name: entry.name, ...(entry.prompt ? { prompt: entry.prompt } : {}) });
  });
  for (const p of legacy) if (!used.has(p.id)) out.push(p);
  return out;
}
