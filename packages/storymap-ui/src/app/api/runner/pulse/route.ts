// GET /api/runner/pulse[?board=<id>] — a poll-friendly JSON snapshot of everything an
// AUTONOMOUS operator (the orchestrator / an external monitor) must ACT on, in ONE request:
//   • running    — live headless runs (board/card/trigger/age)
//   • failures   — recent in-memory run failures (error/exit/no-op/timeout/oom)
//   • mergeQueue — LIVE merge-train entries (parked conflict/gate-failed need resolve_merge)
//   • demands    — the per-board human "precisa de você" inbox (questions, blockers, approvals,
//                  stuck runs, merge conflicts, design/proposal gates) via the SAME cockpit
//                  derivation the Inbox screen uses (collectBoardCockpitItems).
//
// WHY a snapshot endpoint (vs the /events SSE tail): a monitor that can't call MCP can poll this over
// plain HTTP (node fetch — NOT curl, which trips the Cloudflare WAF), diff it, and emit ONLY the
// actionable deltas (a run FAILED, a card reached a STOP/demand, a merge PARKED) — no git-commit proxy,
// no interpretive re-polling.
//
// AUTH (story-h8tmzh / story-m9jflb): `Authorization: Bearer <token>` PREFERIDO, `?secret=` aceito e
// DEPRECADO (a query string do poll vaza em todo log de acesso e de proxy — foi ESTA rota que
// reproduziu ao vivo os 6 × 401 sem trava e sem uma única linha no journal). O monitor autônomo do dono
// polla por query hoje, então ela continua funcionando: quebrá-la seria remoção de capacidade. A trava
// por origem e o rastro durável estão em `../perimeter`; fail-closed em STORYMAP_MCP_TOKEN
// ausente/fraco segue igual.
//
// `?board=<id>` scopes the (heavier) demands IO to one board — the autonomous monitor passes its board
// so each poll reads one board's cockpit instead of every board's.

import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { getMergeQueue } from "@/lib/storymap/runner/merge-queue";
import { isLiveMergeStatus } from "@/lib/storymap/runner/merge-status";
import { listBoards } from "@/lib/storymap/repo";
import { collectBoardCockpitItems } from "@/lib/storymap/cockpit-collect";
import { RUNNER_SURFACE_AUTH, authorizeRunnerRequest } from "../perimeter";

// `fs`/registry access → Node runtime, never the edge; never cache a live snapshot.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A régua de "entrada VIVA no train" vem de `merge-status.ts` — aqui havia uma cópia hardcoded dela.

export async function GET(request: Request): Promise<Response> {
  // Header preferido, query deprecada — e agora toda recusa CONTA (trava por origem) e DEIXA RASTRO.
  const auth = await authorizeRunnerRequest(request, RUNNER_SURFACE_AUTH.pulse);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const boardFilter = url.searchParams.get("board");

  const now = Date.now();
  const snap = getRunnerRegistry().snapshot();
  // liveRunIds() loads the store before snapshotting (same ordering runner_status relies on).
  await getMergeQueue().liveRunIds();
  const mqSnap = getMergeQueue().getSnapshot();

  const running = snap.running
    .filter((r) => !boardFilter || r.board === boardFilter)
    .map((r) => ({
      board: r.board,
      cardId: r.cardId,
      trigger: r.trigger,
      ageSec: Math.round((now - r.startedAt) / 1000),
      sessionId: r.sessionId,
    }));

  const failures = snap.failures
    .filter((f) => !boardFilter || f.board === boardFilter)
    .map((f) => ({ board: f.board, cardId: f.cardId, trigger: f.trigger, reason: f.reason, detail: f.detail, at: f.at }));

  const mergeQueue = mqSnap.entries
    .filter((e) => isLiveMergeStatus(e.status) && (!boardFilter || e.board === boardFilter))
    .map((e) => ({
      runId: e.runId,
      board: e.board,
      cardId: e.cardId,
      status: e.status,
      branch: e.branch,
      parked: e.status === "gate-failed" || e.status === "conflict",
    }));

  // Demands: scope to the requested board, else every board. collectBoardCockpitItems is the canonical
  // "precisa de você" aggregator (card demands ⊕ stuck telemetry ⊕ merge conflicts ⊕ design/proposal).
  // Fail-open per board (a bad board never 500s the whole pulse). Projected to a LEAN, stable shape so
  // a diffing monitor keys cleanly on (kind, cardId, lane) without the full per-kind payloads.
  const boardIds = boardFilter ? [boardFilter] : (await listBoards().catch(() => [])).map((b) => b.id);
  const demandLists = await Promise.all(boardIds.map((id) => collectBoardCockpitItems(id).catch(() => [])));
  const demands = demandLists.flat().map((d) => ({
    kind: d.kind,
    boardId: d.boardId,
    cardId: d.cardId,
    cardTitle: d.cardTitle,
    status: d.status,
    lane: d.lane,
    severity: d.severity,
  }));

  return Response.json({ at: now, running, failures, mergeQueue, demands });
}
