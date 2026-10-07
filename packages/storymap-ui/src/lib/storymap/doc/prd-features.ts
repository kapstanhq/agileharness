// 🧩 As FUNCIONALIDADES do board vêm do PRD — a seção «Funcionalidades», um `###` por funcionalidade. PURO.
//
// Fase 7: o Kanban agrupa os itens pela funcionalidade do PRD (não mais pelo passo do mapa). Um card guarda o ID
// (`card.feature`), o PRD guarda o NOME: o id é o slug do nome — a mesma régua das personas (prd-personas.ts). Dois
// `###` com o mesmo slug ganham `-2`, `-3` na ordem (a remarcação de renomes — feature-remap.ts — trata o deslocamento).
// Os grupos de ESCOPO que a própria ferramenta escreveu ({@link PRD_SCOPE_GROUPS}) não são funcionalidades.
//
// Esqueleto do commit de interfaces: a Trilha A dona deste arquivo fecha a implementação e os testes.

import { OUTROS_FEATURE } from "../feature-key";
import { serializeDocMd } from "./md-codec";
import { personaSlug } from "./prd-personas";
import { sectionContent, type SchemaDoc } from "./schema-codec";
import { PRD_DOC_TYPE, PRD_SCOPE_GROUPS } from "./schemas/prd";

/** O slug de um título de documento (`###`) — a mesma régua das personas. */
export { personaSlug as docSlug };

/** Uma funcionalidade do PRD: o id (slug do nome, desduplicado), o nome do `###` e o texto abaixo dele (markdown). */
export interface PrdFeature {
  id: string;
  name: string;
  markdown: string;
}

const SCOPE = new Set(PRD_SCOPE_GROUPS.map(personaSlug));

/** As funcionalidades escritas no PRD, na ordem do documento. PRD sem a seção (ou sem `###`) ⇒ `[]`. PURA. */
export function prdFeatureEntries(doc: SchemaDoc | null | undefined): PrdFeature[] {
  const blocks = doc ? (sectionContent(doc, "funcionalidades")?.blocks ?? []) : [];
  const groups: { name: string; blocks: typeof blocks }[] = [];
  let current: (typeof groups)[number] | null = null;
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 3) {
      const name = block.text.trim();
      current = !name || SCOPE.has(personaSlug(name)) ? null : { name, blocks: [] };
      if (current) groups.push(current);
      continue;
    }
    current?.blocks.push(block);
  }
  // Um id é ÚNICO no board: o slug repetido ganha `-2`, `-3`… — e pula um sufixo que outro título já tem de verdade
  // («Busca», «Busca», «Busca 2» ⇒ busca, busca-3, busca-2 — nunca dois `busca-2`).
  const natural = new Set(groups.map(({ name }, i) => personaSlug(name) || `funcionalidade-${i + 1}`));
  // o id do grupo «Outros (fora do PRD)» é da ferramenta: um `### Outros` no PRD vira `outros-2`, nunca o grupo
  const used = new Set<string>([OUTROS_FEATURE.id]);
  return groups.map(({ name, blocks: b }, i) => {
    const base = personaSlug(name) || `funcionalidade-${i + 1}`;
    let id = base;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${base}-${n}`) || natural.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
    }
    used.add(id);
    return {
      id,
      name,
      markdown: serializeDocMd({ docType: PRD_DOC_TYPE, title: "", blocks: b }, { includeTitle: false }).trim(),
    };
  });
}
