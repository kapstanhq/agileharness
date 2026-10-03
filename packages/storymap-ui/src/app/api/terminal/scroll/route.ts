// "Take me back to the previous prompt" for the web terminal.
//
// It has to be a SERVER endpoint: the scrollback belongs to tmux's copy-mode on the other side of
// the socket, not to the browser. The page holds no history to search and `wheelBy` is relative-only.
//
// The security shape is the whole point, and it is enforced in lib/terminal/scroll.ts rather than
// here: the client names an ACTION out of a closed set and the server owns the search pattern. A
// client-supplied regex forwarded to `tmux send-keys -X search-backward` would be a command-injection
// surface. This route therefore validates against that module's own `isScrollAction` — a second
// literal list here would be a second truth, and the copy that drifts open is the hole.
//
// Reachable only through Caddy's catch-all (basic_auth + TLS), like every sibling terminal route.

import { scrollBack, isScrollAction } from "@/lib/terminal/scroll";
import { isSafeSessionName } from "@/lib/vps/tmux";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Require a real JSON content-type. Caddy's basic_auth credentials are cached by the browser and
  // attached to CROSS-ORIGIN requests too, so without this a random page could POST here with a plain
  // <form enctype="text/plain"> — the one request shape that needs no CORS preflight — and drive the
  // operator's pane. Demanding application/json forces a preflight the browser will refuse to send.
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return Response.json({ ok: false, error: "content-type deve ser application/json" }, { status: 415 });
  }

  let body: { name?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "expected JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!isSafeSessionName(name)) {
    return Response.json({ ok: false, error: "nome de terminal inválido" }, { status: 400 });
  }
  if (!isScrollAction(body.action)) {
    return Response.json({ ok: false, error: "ação desconhecida" }, { status: 400 });
  }

  // scrollBack re-validates both arguments; the checks above exist to answer with a 400 (a client
  // bug) instead of a 500 (a box problem). The double check is deliberate, not redundant: the module
  // must stay safe for any caller, and the route must return the right status for this one.
  const res = await scrollBack(name, body.action);
  if (!res.ok) {
    return Response.json({ ok: false, error: res.error ?? "não consegui mexer no histórico deste terminal" }, { status: 500 });
  }
  // `found: false` is a SUCCESSFUL call that matched nothing — the page says so out loud rather than
  // looking like a dead button.
  return Response.json({ ok: true, found: res.found }, { headers: { "cache-control": "no-store" } });
}
