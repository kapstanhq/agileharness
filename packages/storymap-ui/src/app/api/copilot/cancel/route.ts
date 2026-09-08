// Cancel explícito do turno do Jido (F1.2) — belt do abort do fetch (o stream cancel já mata no
// disconnect, mas o botão "cancelar" chama esta rota p/ matar o processo de forma determinística). Mesma
// fronteira de auth da rota de turno (catch-all basic_auth do Caddy — NUNCA fora do auth).

import { boardScope, killCopilotTurn, viewScope } from "@/lib/storymap/copilot/agent-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]+$/i;

export async function POST(request: Request): Promise<Response> {
  let body: { boardId?: unknown; sessionId?: unknown; view?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const boardId = String(body.boardId ?? "");
  if (!SLUG_RE.test(boardId)) return Response.json({ ok: false, error: "invalid boardId" }, { status: 400 });
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
  const view = typeof body.view === "string" && body.view.trim() ? body.view.trim() : undefined;
  if (view && !SLUG_RE.test(view)) return Response.json({ ok: false, error: "invalid view" }, { status: 400 });
  // Cancela DENTRO da raia. O fallback (quando a chave de sessão não casa) varre só a raia pedida — cancelar o
  // Jido não pode matar a conversa de outra tela que está em voo ao lado, e vice-versa.
  const killed = killCopilotTurn(view ? viewScope(boardId, view) : boardScope(boardId), sessionId);
  return Response.json({ ok: true, killed });
}
