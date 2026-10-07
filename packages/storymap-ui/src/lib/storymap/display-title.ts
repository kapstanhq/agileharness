// O TÍTULO COMO O DONO O LÊ — PURO (zero React, zero `node:*`).
//
// Agentes que abrem cards sozinhos (a varredura de arquivos sem uso, o vigia de saúde, um sinal de cobertura) põem uma
// ETIQUETA de máquina na frente do título — «[gc:arquivos-sem-uso:src/a.ts] Apagar o arquivo a.ts», «[saude:S7] …». A
// etiqueta serve para o agente achar o próprio card de novo (e por isso o título GRAVADO nunca muda); na tela ela é
// ruído: o Kanban mostrava «Próximo: [sinal:cobertura:…] …» antes da frase que importa.
//
// `displayTitle` tira UMA etiqueta do começo — só quando ela é de máquina (sem espaço dentro) e quando sobra texto
// depois dela. `nameCardIds` troca, num texto livre (a descrição de uma funcionalidade), o id de um card conhecido pelo
// título dele: o dono não lê «ex9101», lê o nome do item.

/** Uma etiqueta de máquina no começo: `[…]` sem espaço nem colchete dentro, seguida de espaço. */
const LEADING_TAG = /^\s*\[[^\s[\]]{1,200}\]\s+/;

/** O título sem a etiqueta de máquina do começo (uma só). Sem etiqueta, ou sem texto depois dela, o título como está. */
export function displayTitle(title: string): string {
  const m = LEADING_TAG.exec(title);
  if (!m) return title;
  const rest = title.slice(m[0].length).trim();
  return rest ? rest : title;
}

/** O título curto para caber no meio de uma frase («Ver as receitas», ou os primeiros ~48 caracteres e «…»). */
export function shortTitle(title: string, max = 48): string {
  const t = displayTitle(title).trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/, "")}…`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * O texto com cada id de card CONHECIDO trocado pelo título curto do card, entre «». Vale o id inteiro («story-ex9101»)
 * e o sufixo dele («ex9101», a forma curta que agentes escrevem) quando o sufixo tem 5 caracteres ou mais. Só casa a
 * palavra inteira (nunca o pedaço de um caminho ou de outra palavra). Id desconhecido fica como está. PURA.
 */
export function nameCardIds(text: string, cards: readonly { id: string; title: string }[]): string {
  if (!text || !cards.length) return text;
  const byToken = new Map<string, string>();
  for (const c of cards) {
    const name = `«${shortTitle(c.title)}»`;
    byToken.set(c.id.toLowerCase(), name);
    const dash = c.id.indexOf("-");
    const suffix = dash >= 0 ? c.id.slice(dash + 1) : "";
    if (suffix.length >= 5 && !byToken.has(suffix.toLowerCase())) byToken.set(suffix.toLowerCase(), name);
  }
  // o mais longo primeiro: «story-ex9101» vence «ex9101»
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  // sem lookbehind (Safari antigo não o tem): o caractere de antes vai no grupo 1 e volta na troca
  const re = new RegExp(`(^|[^\\w/.\\-])(${tokens.join("|")})(?![\\w\\-/])`, "gi");
  return text.replace(re, (_m, before: string, token: string) => `${before}${byToken.get(token.toLowerCase()) ?? token}`);
}
