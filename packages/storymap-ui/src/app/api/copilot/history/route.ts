// Histórico do chat do Jido (persistência cross-dispositivo). GET ?boardId=&before=&limit= →
// resolve o ponteiro durável board→sessionId (.runner/copilot-sessions) e HIDRATA do transcript do CLI (a
// fonte única — não duplicamos o thread), paginado do mais recente p/ o mais antigo. Read-only.
//
// AUTH: cai no catch-all `basic_auth` do Caddy, igual às outras /api/copilot/* — NUNCA adicionar matcher
// dedicado fora do auth. Mesmo o sendo read-only, o histórico é conteúdo do operador.

import { boardScope, viewScope } from "@/lib/storymap/copilot/agent-session";
import { readCopilotSessionPointer } from "@/lib/storymap/copilot/session-store";
import { readCopilotHistory } from "@/lib/storymap/copilot/transcript-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]+$/i;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const boardId = String(url.searchParams.get("boardId") ?? "");
  if (!SLUG_RE.test(boardId)) return Response.json({ ok: false, error: "invalid boardId" }, { status: 400 });

  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 40;
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw != null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : undefined;

  // `view` opcional: o histórico é da RAIA. Sem ele, o chat do board (o caminho de sempre).
  const view = String(url.searchParams.get("view") ?? "").trim();
  if (view && !SLUG_RE.test(view)) return Response.json({ ok: false, error: "invalid view" }, { status: 400 });

  const pointer = await readCopilotSessionPointer(view ? viewScope(boardId, view) : boardScope(boardId));
  if (!pointer) return Response.json({ ok: true, sessionId: null, turns: [], nextCursor: null });

  const { turns, nextCursor } = await readCopilotHistory(pointer.sessionId, { limit, before });
  return Response.json({ ok: true, sessionId: pointer.sessionId, turns, nextCursor });
}
