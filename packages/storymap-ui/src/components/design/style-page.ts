// 🟥 A página de Design (fase 2) — a ORDEM do guia de estilo na linguagem de quem o lê, e o mesmo arranjo no
// editor. PURO (o cliente importa; sem `node:crypto` — o kernel `style-guide.ts` só entra aqui como tipo).
//
// O arquivo compilado (`design/style-guide.md`) segue na ordem do registro (`STYLE_SECTIONS`, a ordem em que um
// agente preenche). A PÁGINA lê em outra, a de quem usa o guia: primeiro o tom, depois o que se vê (cores,
// tipografia), a estética, os componentes, e por último — recolhido — o que NÃO fazer e as dívidas conhecidas.

import type { DocBlock, DocModel } from "@/lib/storymap/doc/doc-model";
import { GROUP_PREFIX } from "@/lib/storymap/doc/style-doc";

/** Um grupo da página: o nome que a pessoa lê e as seções do guia que ele junta. */
export interface StylePageGroup {
  id: "tom" | "cores" | "tipografia" | "estetica" | "componentes" | "cuidados";
  label: string;
  keys: readonly string[];
  /** recolhido por padrão (os anti-padrões e as dívidas). */
  collapsed?: boolean;
}

export const STYLE_PAGE_GROUPS: readonly StylePageGroup[] = [
  { id: "tom", label: "Tom", keys: ["voice"] },
  { id: "cores", label: "Cores", keys: ["color"] },
  { id: "tipografia", label: "Tipografia", keys: ["typography"] },
  { id: "estetica", label: "Estética", keys: ["identity", "principles", "shape", "spacing", "motion"] },
  { id: "componentes", label: "Componentes", keys: ["components"] },
  { id: "cuidados", label: "Anti-padrões e dívidas", keys: ["antiPatterns", "debt"], collapsed: true },
];

/** O nome que a pessoa lê de cada seção DENTRO de um grupo de várias (a leitura e a edição usam o mesmo). */
export const STYLE_SUB_LABEL: Readonly<Record<string, string>> = {
  identity: "Identidade",
  principles: "Princípios",
  shape: "Forma",
  spacing: "Espaçamento",
  motion: "Movimento",
  antiPatterns: "Anti-padrões",
  debt: "Dívidas conhecidas",
};

/** As seções do guia na ordem da PÁGINA. */
export const STYLE_PAGE_ORDER: readonly string[] = STYLE_PAGE_GROUPS.flatMap((g) => g.keys);

/** O prefixo do vínculo de um título de seção no modelo do guia (`style-doc.ts`: `style:<key>`). */
const HEADING_BINDING = "style:";

/**
 * O modelo do editor (`projectStyleDoc`) rearrumado como a LEITURA: na ordem da página e com os MESMOS nomes —
 * Tom · Cores · Tipografia · Estética (Identidade, Princípios, Forma, Espaçamento, Movimento) · Componentes ·
 * Anti-padrões e dívidas. Cada região (o título vinculado e tudo até o próximo título vinculado) se move INTEIRA e
 * mantém o vínculo — o salvamento (`commitStyleDoc`) lê por vínculo, não por posição nem por texto. Um grupo de uma
 * seção só empresta o nome ao título dela; um grupo de várias ganha um título próprio (`style-group:<id>`, que o
 * salvamento ignora) e as seções descem um nível, com o subnome da leitura. O bloco de propriedades (versão, data
 * crua) sai: a página não o mostra lendo, e o editor não pode mostrar outra coisa. Uma seção que a página não conhece
 * vai para o fim, intacta.
 */
export function orderStyleModel(model: DocModel): DocModel {
  const regions = new Map<string, DocBlock[]>();
  const unknown: DocBlock[][] = [];
  let current: DocBlock[] | null = null;

  for (const block of model.blocks) {
    const key = block.kind === "heading" && block.binding?.startsWith(HEADING_BINDING) ? block.binding.slice(HEADING_BINDING.length) : null;
    if (key !== null) {
      current = [block];
      if (STYLE_PAGE_ORDER.includes(key) && !regions.has(key)) regions.set(key, current);
      else unknown.push(current);
      continue;
    }
    if (current) current.push(block);
    // antes do primeiro título só vem o bloco de propriedades — fora (ver acima)
  }

  const ordered: DocBlock[] = [];
  for (const group of STYLE_PAGE_GROUPS) {
    const present = group.keys.filter((k) => regions.has(k));
    if (!present.length) continue;
    const single = group.keys.length === 1;
    if (!single) {
      ordered.push({ kind: "heading", id: `${GROUP_PREFIX}${group.id}`, level: 2, text: group.label, binding: `${GROUP_PREFIX}${group.id}` });
    }
    for (const k of present) {
      const [heading, ...rest] = regions.get(k)!;
      const relabeled =
        heading.kind === "heading"
          ? { ...heading, level: single ? 2 : 3, text: single ? group.label : (STYLE_SUB_LABEL[k] ?? heading.text) }
          : heading;
      ordered.push(relabeled as DocBlock, ...rest);
    }
  }
  return { ...model, blocks: [...ordered, ...unknown.flat()] };
}
