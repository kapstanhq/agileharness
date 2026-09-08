// O lado CLIENTE da marca de visto do Inbox: um fetch para /api/inbox/seen.
//
// Um chamador só para as superfícies que marcam (hoje o carrossel da home) — o contrato do request
// mora em um lugar. O porquê de ser rota e não server action está no doc da rota.

export type InboxSeenResult = { ok: true } | { ok: false; error: string };

async function post(boardId: string, itemId: string, op: "seen" | "unseen"): Promise<InboxSeenResult> {
  try {
    const res = await fetch("/api/inbox/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId, itemId, op }),
    });
    const data = (await res.json().catch(() => null)) as InboxSeenResult | null;
    if (data && "ok" in data) return data;
    return { ok: false, error: `falha (${res.status})` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "falha de rede" };
  }
}

/** "Já passei os olhos neste" — a marca que o Pular deixa ao avançar o carrossel. */
export function markInboxItemSeen(boardId: string, itemId: string): Promise<InboxSeenResult> {
  return post(boardId, itemId, "seen");
}

/** Desfaz a marca ("quero reler este com olhos novos"). */
export function markInboxItemUnseen(boardId: string, itemId: string): Promise<InboxSeenResult> {
  return post(boardId, itemId, "unseen");
}
