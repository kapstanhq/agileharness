// 🪟 Contratos de VIEW — a Camada 3, declarada.
//
// Uma view não é escrita PARA uma entidade: ela declara o que EXIGE do schema, e todo documento que
// satisfaz a exigência ganha a view de graça. É o que faz a promessa "as views se adaptam ao
// markdown" ser mecânica em vez de intenção — o Lean Canvas não pede a view de quadro, ele apenas
// tem seções que carregam itens, e por isso o quadro aparece.
//
// A direção da dependência é lei: Camada 3 importa Camada 2, NUNCA o contrário. `doc-schema.ts` não
// sabe que este arquivo existe (e o lint anti-overfit prova).
//
// A PROVA de que o desacoplamento é real está em `boardLayoutFor` devolver `null` sem consequência:
// uma view de quadro sem layout declarado cai no arranjo automático e continua servindo. O grid de
// 5 colunas do Lean Canvas é um REFINAMENTO opcional, não um requisito — apague o layout e o
// documento continua abrindo em quadro, tabela, markdown e documento.

import { bearsItems, type ContentKind, type DocSchema } from "./doc-schema";
import type { DocBlock } from "./doc-model";

export interface ViewRequirement {
  /** id estável — vira a chave da preferência por docType (`doc-view:<docType>`). */
  id: string;
  label: string;
  /** A view faz sentido para este schema? */
  satisfiedBy: (schema: DocSchema) => boolean;
  /** O que ela exige, em uma frase — para o dev entender por que ela não apareceu. */
  requires: string;
}

/** Seções que carregam itens — a pergunta que tabela, quadro e kanban fazem. */
export function itemBearingSections(schema: DocSchema) {
  return schema.sections.filter((s) => bearsItems(s.content));
}

/** Seções que aceitam grupos autorais — a dimensão que um kanban usa como coluna. */
export function groupBearingSections(schema: DocSchema) {
  return schema.sections.filter((s) => s.content === "groups");
}

/**
 * O catálogo. A ordem é a de apresentação: documento primeiro (a leitura padrão), a fonte logo em
 * seguida (é o par imediato dele), e as views derivadas depois.
 */
export const DOC_VIEWS: readonly ViewRequirement[] = [
  {
    id: "documento",
    label: "Documento",
    satisfiedBy: () => true,
    requires: "nada — todo documento se lê como documento",
  },
  {
    id: "markdown",
    label: "Markdown",
    satisfiedBy: () => true,
    requires: "nada — a fonte é sempre a fonte",
  },
  {
    id: "tabela",
    label: "Tabela",
    satisfiedBy: (schema) => itemBearingSections(schema).length > 0,
    requires: "ao menos uma seção que carregue itens",
  },
  {
    id: "quadro",
    label: "Quadro",
    satisfiedBy: (schema) => itemBearingSections(schema).length > 1,
    requires: "duas ou mais seções que carreguem itens (com uma só, o quadro é a própria seção)",
  },
] as const;

/** As views que ESTE schema oferece, na ordem do catálogo. */
export function availableViews(schema: DocSchema): ViewRequirement[] {
  return DOC_VIEWS.filter((v) => v.satisfiedBy(schema));
}

export function viewById(id: string): ViewRequirement | undefined {
  return DOC_VIEWS.find((v) => v.id === id);
}

/**
 * Os blocos que o EDITOR RICO oferece (menu de barra / `/`), DERIVADOS do schema em vez de listados
 * à mão por tela. Uma lista escrita à mão vira a segunda verdade na primeira seção nova: o schema
 * diz que a seção quer itens, e o editor continua oferecendo tabela porque ninguém lembrou de tirar.
 *
 * Não é contenção de segurança — quem recusa de fato é a validação, nas três portas de escrita.
 * É ergonomia: não oferecer o gesto que a próxima tela vai reprovar.
 */
const BLOCKS_BY_KIND: Record<ContentKind, DocBlock["kind"][]> = {
  prose: ["paragraph", "bullet", "numbered", "quote", "code", "table", "image", "toggle", "divider"],
  items: ["bullet"],
  checklist: ["todo"],
  table: ["table"],
  // `groups` é lista COM subdivisão autoral — o `###` é o gesto que cria o grupo.
  groups: ["bullet", "heading"],
};

export function allowedBlocksFor(schema: DocSchema): DocBlock["kind"][] {
  const out = new Set<DocBlock["kind"]>(["divider"]);
  for (const section of schema.sections) for (const kind of BLOCKS_BY_KIND[section.content]) out.add(kind);
  // Um documento com cauda livre aceita prosa em qualquer forma depois do esqueleto.
  if (schema.allowFreeTail) for (const kind of BLOCKS_BY_KIND.prose) out.add(kind);
  return [...out];
}
