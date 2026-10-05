// O CLIQUE QUE FALHA DEPOIS DE UMA ATUALIZAÇÃO — e o recarregar que o conserta sem perder o que foi digitado.
//
// Cada versão da ferramenta compila as ações do servidor com ids novos. Uma aba aberta antes da atualização ainda chama
// os ids velhos; o servidor responde que não conhece a ação (o cabeçalho `x-nextjs-action-not-found`) e o clique falha
// — muitas vezes em silêncio, porque o componente engole o erro. A saída é recarregar a página: a aba passa a ter os ids
// novos. Este módulo diz QUANDO (uma resposta de ação desconhecida) e guarda o que estava digitado para devolver depois
// do recarregar. PURO (o DOM entra por interfaces mínimas) — o componente StaleActionGuard só o liga à janela.

/** O cabeçalho que o servidor do Next põe numa resposta a uma ação que ele não conhece (versão diferente). */
export const ACTION_NOT_FOUND_HEADER = "x-nextjs-action-not-found";
/** O cabeçalho que marca um POST como chamada de ação do servidor. */
export const NEXT_ACTION_HEADER = "next-action";
/** Onde o rascunho espera o recarregar (sessionStorage: some com a aba, nunca vai a outro dispositivo). */
export const STALE_DRAFTS_KEY = "ah:stale-action-drafts";
/** O aviso que aparece depois do recarregar. */
export const STALE_RELOAD_NOTICE = "A ferramenta foi atualizada — recarreguei a página para você. O que você tinha digitado foi mantido.";

/** A chamada foi uma ação do servidor e o servidor não a conhece? PURA. */
export function isStaleActionResponse(requestHeaders: Headers | Record<string, string> | undefined, responseHeaders: Pick<Headers, "get">): boolean {
  const hasAction = (() => {
    if (!requestHeaders) return false;
    if (typeof (requestHeaders as Headers).get === "function") return !!(requestHeaders as Headers).get(NEXT_ACTION_HEADER);
    return Object.keys(requestHeaders).some((k) => k.toLowerCase() === NEXT_ACTION_HEADER);
  })();
  return hasAction && responseHeaders.get(ACTION_NOT_FOUND_HEADER) === "1";
}

/** Um campo de texto da página, no mínimo que o rascunho precisa. */
export interface DraftField {
  id?: string;
  name?: string;
  value: string;
  type?: string;
}

/** A chave estável de um campo (id, senão name); campo sem chave, senha ou vazio não entra. PURA. */
export function draftKey(f: Pick<DraftField, "id" | "name" | "type">): string | null {
  if (f.type === "password" || f.type === "hidden") return null;
  if (f.id) return `#${f.id}`;
  if (f.name) return `@${f.name}`;
  return null;
}

/** O rascunho da página: o texto de cada campo com chave e algo digitado. PURA. */
export function collectDrafts(fields: Iterable<DraftField>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const k = draftKey(f);
    if (k && f.value.trim()) out[k] = f.value;
  }
  return out;
}

/** Devolve o rascunho aos campos que ainda existem e estão vazios (nunca sobrescreve o que já tem texto). PURA. */
export function restoreDrafts(fields: Iterable<DraftField & { setValue(v: string): void }>, drafts: Record<string, string>): number {
  let restored = 0;
  for (const f of fields) {
    const k = draftKey(f);
    if (!k || !(k in drafts) || f.value.trim()) continue;
    f.setValue(drafts[k]);
    restored++;
  }
  return restored;
}
