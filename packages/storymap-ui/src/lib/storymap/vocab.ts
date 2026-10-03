// 🗂️ vocab — as derivações PURAS da tela de Personas & Sistemas: como uma linha se lê, em que
// GRUPO ela cai, e o que a busca alcança.
//
// Está fora do componente de propósito. A tela desenhava tudo isso dentro do `map` do JSX — e por
// isso nada ali podia ser testado sem montar React, nem reusado pelo documento (que precisa do
// MESMO subtítulo e do MESMO rótulo de tipo que a listagem mostra). Aqui é kernel: sem React, sem
// `node:fs`, sem server action — o cliente e o servidor importam o mesmo arquivo.
//
// A régua do AGRUPAMENTO é o campo `kind`, e ele é o MESMO conceito nos dois lados: um sistema já
// declarava o seu ("Canal", "Serviço", "UI"…), uma persona não tinha onde dizer se é um SEGMENTO DE
// MERCADO (quem o produto quer conquistar) ou uma persona INTERNA (operação, automação) — que é a
// distinção que muda como o agente deve adotá-la. Uma linha sem `kind` não some nem inventa grupo:
// cai em "Sem tipo", que é um convite a classificá-la, não um erro.

import type { Persona, SystemDef } from "./types";

export type VocabKind = "persona" | "system";

/** Os tipos SUGERIDOS de persona. Sugestão, não enum: o campo é texto livre e um board pode ter o seu. */
export const PERSONA_KINDS = ["Segmento de mercado", "Interna"] as const;

/** Os tipos SUGERIDOS de sistema — o mesmo conjunto que a bancada já oferecia no `datalist`. */
export const SYSTEM_KINDS = ["Canal", "Serviço", "Integração", "Dados", "UI", "Infra"] as const;

/**
 * A NOTA de cada grupo — uma linha dizendo o que aquele grupo é, ao lado do rótulo.
 *
 * Ela existe porque "Interna" e "Dados" não se explicam sozinhos, e a explicação estava na cabeça de
 * quem criou a linha. Um tipo que o board inventou simplesmente não tem nota (string vazia) — o
 * cabeçalho continua correto, só mais calado.
 */
const GROUP_NOTES: Record<string, string> = {
  "Segmento de mercado": "quem o produto quer conquistar",
  Interna: "operação e automação — não é segmento de mercado",
  Canal: "por onde a pessoa fala com o produto",
  Serviço: "o que o produto usa por dentro",
  UI: "superfície visual",
  Dados: "o que guardamos",
  Integração: "terceiros",
  Infra: "o que sustenta a operação",
};

/** O rótulo do grupo de quem ainda não declarou tipo. */
export const UNTYPED_GROUP_LABEL = "Sem tipo";

/** Uma linha da listagem, já derivada — o que a tela desenha e o que a busca varre. */
export interface VocabRow {
  id: string;
  name: string;
  kind: VocabKind;
  /** o tipo declarado (`Persona.kind` / `SystemDef.kind`), ou `null` quando a linha não tem. */
  type: string | null;
  color?: string;
  avatar?: string;
  /** a segunda linha: o papel/descrição declarados, senão a primeira frase do prompt. */
  subtitle: string;
  /** quantos cards do board adotam este prompt. */
  usage: number;
  /** o prompt tem conteúdo? Uma linha sem prompt é um documento em branco — a tela avisa. */
  hasPrompt: boolean;
}

export interface VocabGroup {
  /** a chave estável (o tipo declarado, ou "" para o grupo sem tipo) — serve de `key` no React. */
  key: string;
  label: string;
  note: string;
  rows: VocabRow[];
}

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

/** A linha derivada de uma persona/sistema. `usage` vem de fora (é do board, não da entidade). */
export function toVocabRow(entity: Persona | SystemDef, kind: VocabKind, usage: number): VocabRow {
  const type = entity.kind?.trim() || null;
  return {
    id: entity.id,
    name: entity.name,
    kind,
    type,
    color: entity.color,
    avatar: kind === "persona" ? (entity as Persona).avatar : undefined,
    subtitle: vocabSubtitle(entity, kind),
    usage,
    hasPrompt: Boolean(entity.prompt?.trim()),
  };
}

/** A linha casa com a busca? Varre nome, tipo, subtítulo, id e o PROMPT INTEIRO (o texto que importa). */
export function matchesVocabQuery(row: VocabRow, prompt: string | undefined, query: string): boolean {
  const q = foldText(query.trim());
  if (!q) return true;
  const haystack = foldText([row.name, row.type ?? "", row.subtitle, row.id, prompt ?? ""].join(" "));
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

/**
 * Agrupa as linhas por tipo. A ORDEM é a dos tipos sugeridos (para a tela abrir sempre igual),
 * depois os tipos que o board inventou em ordem alfabética, e o grupo "Sem tipo" por ÚLTIMO —
 * ele é uma pendência, não uma categoria, e no topo empurraria o conteúdo real para baixo.
 */
export function groupVocab(rows: readonly VocabRow[], kind: VocabKind): VocabGroup[] {
  const suggested: readonly string[] = kind === "persona" ? PERSONA_KINDS : SYSTEM_KINDS;
  const byType = new Map<string, VocabRow[]>();
  for (const row of rows) {
    const key = row.type ?? "";
    const bucket = byType.get(key);
    if (bucket) bucket.push(row);
    else byType.set(key, [row]);
  }

  const keys = [...byType.keys()];
  const rank = (k: string): number => {
    if (k === "") return 2; // "Sem tipo" sempre por último
    const i = suggested.indexOf(k);
    return i >= 0 ? 0 : 1;
  };
  keys.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return suggested.indexOf(a) - suggested.indexOf(b);
    return a.localeCompare(b, "pt-BR");
  });

  return keys.map((key) => ({
    key,
    label: key || UNTYPED_GROUP_LABEL,
    note: key ? (GROUP_NOTES[key] ?? "") : "defina o tipo para organizar a lista",
    rows: byType.get(key)!,
  }));
}

/** "7 personas" / "1 sistema encontrado" — o resumo à direita da barra de busca. */
export function vocabSummary(count: number, kind: VocabKind, searching: boolean): string {
  const noun =
    kind === "persona" ? (count === 1 ? "persona" : "personas") : count === 1 ? "sistema" : "sistemas";
  if (!searching) return `${count} ${noun}`;
  const found =
    kind === "persona" ? (count === 1 ? "encontrada" : "encontradas") : count === 1 ? "encontrado" : "encontrados";
  return `${count} ${noun} ${found}`;
}
