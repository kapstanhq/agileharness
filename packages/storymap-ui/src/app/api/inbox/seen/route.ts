// POST /api/inbox/seen — marca (ou desmarca) um item do Inbox como JÁ VISTO pelo operador.
//
// É o efeito colateral do "Pular" do carrossel da home: avançar de cartão deixa a marca para que a
// volta da pilha não faça o operador reler o que acabou de ler. Não esconde nada, em lugar nenhum
// (ver inbox-seen.ts).
//
// POR QUE UMA ROTA E NÃO UMA SERVER ACTION: histórico — a tela vive sob `router.refresh()` do SSE, e
// um refresh ABORTA o POST de server action em voo, prendendo a fila de ações do React (o clique
// sumia sem erro e sem request). A fome de conexão que causava isso foi corrigida (lib/sse-bus.ts),
// mas o `fetch` continua sendo o caminho certo para um gesto de NAVEGAÇÃO: ele não compete com o
// refresh da página, não re-renderiza o RSC inteiro a cada folha virada, e falha de um jeito que a
// UI consegue mostrar.

import { collectBoardCockpitItems } from "@/lib/storymap/cockpit-collect";
import { clearSeen, markSeen, readInboxSeen, writeInboxSeen } from "@/lib/storymap/inbox-seen";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Mesma régua de slug do resto do app (copilot/escalation SLUG_RE): o boardId vira caminho de arquivo. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export async function POST(req: Request): Promise<Response> {
  let body: { boardId?: unknown; itemId?: unknown; op?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "corpo inválido" }, { status: 400 });
  }

  const boardId = typeof body.boardId === "string" ? body.boardId : "";
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  const op = body.op === "unseen" ? "unseen" : "seen";
  if (!SLUG_RE.test(boardId) || !itemId) {
    return Response.json({ ok: false, error: "board ou item inválido" }, { status: 400 });
  }

  try {
    const state = await readInboxSeen(boardId);

    if (op === "unseen") {
      await writeInboxSeen(boardId, clearSeen(state, itemId));
      return Response.json({ ok: true });
    }

    // A marca é carimbada contra o item VIVO: a assinatura gravada é a do pedido que o operador
    // realmente leu. Item que não existe mais ⇒ nada a marcar (e nunca uma marca fantasma).
    const item = (await collectBoardCockpitItems(boardId)).find((i) => i.id === itemId);
    if (!item) return Response.json({ ok: false, error: "Este item não está mais aberto." }, { status: 404 });
    await writeInboxSeen(boardId, markSeen(state, item, new Date().toISOString()));
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "falha ao marcar o item" },
      { status: 500 },
    );
  }
}
