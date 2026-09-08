// 🪟 A convenção de PREFIXO de etiqueta num item — Camada 3, compartilhada por todas as views.
//
// Um item pode abrir com `**Nome da etiqueta** — texto`, onde o nome resolve contra as `tags`
// declaradas no frontmatter do documento. É convenção de LEITURA, não sintaxe nova: no markdown cru
// ela se lê como negrito comum, e um documento sem etiqueta nenhuma continua perfeitamente válido.
//
// Fica aqui, e não no schema, porque é interpretação de APRESENTAÇÃO: quadro pinta o ponto, tabela
// vira coluna, kanban vira raia. O conteúdo é o mesmo texto nos três.
//
// Regra de ouro herdada do modelo antigo: um prefixo que NÃO resolve para uma etiqueta conhecida
// permanece texto verbatim. Nunca se engole um negrito que o autor escreveu por outro motivo.

export interface DocTag {
  id: string;
  name: string;
  color?: string;
}

export interface SplitItemText {
  /** as etiquetas resolvidas do prefixo (vazio quando não há prefixo ou ele não resolve). */
  tags: DocTag[];
  /** o texto SEM o prefixo quando ele resolveu; o texto inteiro quando não. */
  text: string;
}

const PREFIX = /^\*\*([^*]+)\*\*\s+—\s+([\s\S]*)$/;

/** Lê as `tags` do frontmatter de um documento, tolerando um cabeçalho ainda malformado. */
export function docTags(frontmatter: Record<string, unknown>): DocTag[] {
  const raw = frontmatter.tags;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, name, color } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") return [];
    return [{ id, name, ...(typeof color === "string" ? { color } : {}) }];
  });
}

export function splitItemText(raw: string, tags: readonly DocTag[]): SplitItemText {
  const match = PREFIX.exec(raw);
  if (!match) return { tags: [], text: raw };
  const group = match[1].trim();
  const byName = (name: string) => tags.find((t) => t.name.toLowerCase() === name.toLowerCase());

  // O nome de uma etiqueta pode conter " & " — tenta o grupo INTEIRO como um nome antes de dividir.
  const whole = byName(group);
  if (whole) return { tags: [whole], text: match[2] };

  const parts = group.split(" & ").map((p) => byName(p.trim()));
  if (parts.length > 0 && parts.every((t): t is DocTag => !!t)) return { tags: parts, text: match[2] };

  return { tags: [], text: raw }; // prefixo desconhecido → verbatim
}

/** Recompõe o texto com o prefixo — o caminho de volta quando a view edita as etiquetas. */
export function joinItemText(text: string, tags: readonly DocTag[]): string {
  if (!tags.length) return text;
  return `**${tags.map((t) => t.name).join(" & ")}** — ${text}`;
}
