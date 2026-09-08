// Session surface for the web terminal (/terminal). Four methods, one route:
//   GET    — the ENRICHED list (identity + live phrase + card + board + git + cost + kill verdict)
//            the bar, picker, tab bar and Cmd+K palette all render (buildEnrichedSessions), PLUS
//            the board list the inline board picker needs (the page is a static asset — it cannot
//            read the boards dir itself, and a second round-trip for a list that never changes
//            would be worse than riding along here).
//   POST   — create a new detached bash session (idempotent). The operator can launch anything from
//            the shell once attached, so we mint only a plain shell — not an arbitrary command.
//   DELETE — kill a session, FAIL-CLOSED: the never-kill guard is re-derived server-side here; the
//            client's `protected` flag is display-only and never trusted.
//   PATCH  — set the per-session operator prefs (display alias / pinned / BOARD link), persisted in
//            the runner dir. The board link is validated twice: the id must exist, and a session
//            whose board is STRUCTURAL (a card terminal, a fleet session) is refused 409 — the
//            client's lock is display only, the authority is here.
//
// Reachable only through Caddy's catch-all (basic_auth + TLS) — the same trust boundary as the board.
// The static page can't touch the filesystem or tmux; every mutation goes through these handlers.

import { buildEnrichedSessions } from "@/lib/terminal/enrich";
import { ensureDetachedSession, killSession, isSafeSessionName } from "@/lib/vps/tmux";
import { assessKillLive, isReservedSessionName } from "@/lib/vps/kill-guard";
import { setPref } from "@/lib/terminal/prefs-store";
import { findRepoRoot } from "@/lib/storymap/paths";
import { listBoards } from "@/lib/storymap/repo";
import { listRunningServices } from "@/lib/vps/processes";
import type { BoardSummary } from "@/lib/storymap/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // `boards` viaja JUNTO das sessões porque a página do terminal é um asset estático: sem isto ela
  // precisaria de uma segunda rota só para montar o seletor de board. O custo é um readdir + N
  // board.yaml, num endpoint que já faz fan-out de tmux/ps — e degrada para lista vazia (o seletor
  // some, o resto da página continua).
  const [sessions, boards] = await Promise.all([
    buildEnrichedSessions(),
    listBoards().catch(() => [] as BoardSummary[]),
  ]);
  return Response.json(
    { ok: true, at: new Date().toISOString(), sessions, boards },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "expected JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  // Same ≤80 slug as attach-session.sh, so a name minted here is always attachable via `?b=`.
  if (!isSafeSessionName(name)) {
    return Response.json({ ok: false, error: "nome de terminal inválido — use letras, números, _ e -, até 80 caracteres" }, { status: 400 });
  }
  // Refuse a name that would be PROTECTED-BY-NAME forever (master `claude*` / infra `shell`): creating
  // one mints a session the kill guard can never let go — a self-inflicted trap.
  if (isReservedSessionName(name)) {
    return Response.json({ ok: false, error: "esse nome é reservado pelo sistema — escolha outro" }, { status: 400 });
  }
  // `exec bash` = an interactive login shell that keeps the session alive; the operator launches
  // claude / any command from there. No client-supplied command → no arbitrary-exec capability here.
  const res = await ensureDetachedSession(name, "exec bash", findRepoRoot());
  if (!res.ok) {
    return Response.json({ ok: false, error: res.error ?? "não consegui criar o terminal" }, { status: 500 });
  }
  return Response.json({ ok: true, name, created: res.created });
}

export async function DELETE(request: Request): Promise<Response> {
  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "expected JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!isSafeSessionName(name)) {
    return Response.json({ ok: false, error: "nome de terminal inválido" }, { status: 400 });
  }
  // Fail-closed: fresh verdict, server-side. A protected session is refused with the reason.
  const verdict = await assessKillLive(name);
  if (verdict.protected) {
    return Response.json({ ok: false, protected: true, reason: verdict.reason }, { status: 403 });
  }
  const res = await killSession(name);
  if (!res.ok) {
    return Response.json({ ok: false, error: res.error ?? "não consegui encerrar o terminal" }, { status: 500 });
  }
  // Drop this name's prefs so a future session that REUSES the name doesn't inherit a stale alias/pin
  // (prefs are keyed by name), and so the file doesn't accrue dead entries as sessions come and go.
  await setPref(name, { alias: null, pinned: false }).catch(() => {});
  return Response.json({ ok: true, killed: true });
}

export async function PATCH(request: Request): Promise<Response> {
  let body: { name?: unknown; alias?: unknown; pinned?: unknown; board?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "expected JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!isSafeSessionName(name)) {
    return Response.json({ ok: false, error: "nome de terminal inválido" }, { status: 400 });
  }
  const patch: { alias?: string | null; pinned?: boolean; board?: string | null } = {};
  if ("alias" in body) patch.alias = body.alias == null ? null : String(body.alias);
  if ("pinned" in body) patch.pinned = !!body.pinned;

  if ("board" in body) {
    const raw = body.board == null ? "" : String(body.board).trim();
    if (raw) {
      // 1) O board precisa EXISTIR. Um id pendurado gravaria um vínculo que filtra para nada em
      //    silêncio — o terminal continuaria invisível e o operador acharia que vinculou.
      const boards = await listBoards().catch(() => [] as BoardSummary[]);
      if (!boards.some((b) => b.id === raw)) {
        return Response.json({ ok: false, error: `board desconhecido: ${raw}` }, { status: 400 });
      }
    }
    // 2) Fail-closed sobre o vínculo ESTRUTURAL: o cadeado da UI é display, a autoridade é aqui. Um
    //    terminal de card/frota não pode ser reapontado — a home de um board passaria a listar o
    //    terminal do card de outro. Re-derivamos em vez de confiar no que o cliente mandou.
    const structural = (await listRunningServices().catch(() => []))
      .filter((s) => s.tmuxSession === name)
      .find((s) => s.boardSource === "card" || s.boardSource === "fleet");
    if (structural) {
      return Response.json(
        {
          ok: false,
          error:
            structural.boardSource === "card"
              ? `este terminal é do card ${structural.cardId ?? ""} (board ${structural.board}) — o vínculo vem do card`
              : `este terminal é de uma sessão da frota no board ${structural.board} — o vínculo vem do claim`,
          board: structural.board ?? null,
          boardSource: structural.boardSource,
        },
        { status: 409 },
      );
    }
    patch.board = raw || null;
  }

  const pref = await setPref(name, patch);
  return Response.json({
    ok: true,
    prefs: { alias: pref.alias ?? null, pinned: !!pref.pinned, board: pref.board ?? null },
  });
}
