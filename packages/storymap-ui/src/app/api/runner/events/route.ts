// GET /api/runner/events — a Server-Sent Events `tail -f` over storymap/.runner/events.jsonl.
// External clients (curl -N, EventSource, the ops UI) get every settled-run event live, with
// no polling. Reconnection uses the SSE Last-Event-ID header to resume without duplicates. The
// streaming/tail/resume core lives in lib/runner/event-stream.
//
// AUTH (story-h8tmzh / story-m9jflb): `Authorization: Bearer <token>` é o caminho PREFERIDO;
// `?secret=` segue aceito e DEPRECADO — query string vaza em log de acesso, em `Referer` e em
// histórico de proxy (174 gravações do token medidas no journal do Caddy, story-u4yf1i). A query
// permanece porque o `EventSource` nativo do browser não sabe mandar header, e porque há automação
// viva usando-a: quebrá-la seria remoção de capacidade. A trava por origem + o rastro durável de
// toda recusa vivem em `../perimeter` → `lib/auth/auth-audit`.

import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { createEventsStream, startLineFromLastEventId } from "@/lib/storymap/runner/event-stream";
import { RUNNER_SURFACE_AUTH, authorizeRunnerRequest } from "../perimeter";

// `fs` access → Node runtime, never the edge; never cache a live stream.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  // Header OU query, o MESMO conjunto de segredos de antes (STORYMAP_MCP_TOKEN) + handle revogável.
  // Fail-closed continua valendo: segredo configurado ausente/fraco nunca autentica.
  const auth = await authorizeRunnerRequest(request, RUNNER_SURFACE_AUTH.events);
  if (!auth.ok) return auth.response;

  const startLine = startLineFromLastEventId(request.headers.get("Last-Event-ID"));
  const filePath = path.join(runnerStateDir(), "events.jsonl");
  const stream = createEventsStream(filePath, { startLine });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable reverse-proxy buffering so frames flush immediately
    },
  });
}
