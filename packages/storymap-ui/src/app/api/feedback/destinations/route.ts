// GET /api/feedback/destinations — the DISCOVERY catalog for the overlay's send-step picker.
//
// Thin, board-PINNED, minimal projection over the EXISTING session enricher + card reader (never a
// second store — that would drift, the story-248pqq stale-names class of bug). It is same-origin
// board only, NO CORS ever: a cross-origin page can trigger the GET but the same-origin policy blocks
// it from READING the session/card list. Session mode is present ONLY when the terminal round-trip is
// enabled (AGILEHARNESS_FEEDBACK_TERMINAL=1) — recon (this list) and action (the paste) ship together or
// not at all. (Fase 3b: a cross-origin product embed gets a triage-only projection via a nonce path.)

import { checkSameOrigin } from "@/lib/feedback/guard";
import { projectDestinations, type SessionLike } from "@/lib/feedback/destinations";
import { buildEnrichedSessions } from "@/lib/terminal/enrich";
import { sessionRunsClaude } from "@/lib/vps/tmux";
import { isMasterSession } from "@/lib/vps/kill-guard";
import { readCards, readBoardConfig } from "@/lib/storymap/repo";
import { selfBoardId } from "@/lib/storymap/self-board";
import { terminalStatusIds } from "@/lib/storymap/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PINNED server-side — never a client `?board` param — so a spoofed board can't enumerate a foreign
// board's backlog. A FONTE é o env desta instalação (`lib/storymap/self-board.ts`), nunca um id do
// repositório de quem desenvolve: sem board próprio declarado, o catálogo responde VAZIO em vez de
// apontar para um board que só existe na máquina de outra pessoa.

export async function GET(request: Request): Promise<Response> {
  const guard = checkSameOrigin(request.headers);
  if (!guard.ok) {
    return Response.json({ ok: false, error: guard.error }, { status: guard.status });
  }

  const sessionEnabled = process.env.AGILEHARNESS_FEEDBACK_TERMINAL === "1";

  // Cards for the picker: strip everything but the fields the projection needs (no ops-intel leaks by
  // construction) and stamp `terminal` from the board config so a closed/shipped card — a poor refine
  // target — drops out. Config read is best-effort: no config → empty terminal set → nothing extra hidden.
  const feedbackBoard = selfBoardId();
  const [rawCards, config] = await Promise.all([
    feedbackBoard ? readCards(feedbackBoard).catch(() => []) : Promise.resolve([]),
    feedbackBoard ? readBoardConfig(feedbackBoard).catch(() => null) : Promise.resolve(null),
  ]);
  const termIds = config ? terminalStatusIds(config) : new Set<string>();
  const cards = rawCards.map((c) => ({
    id: c.id,
    title: c.title,
    updatedMs: c.updatedMs,
    capture: c.capture,
    terminal: termIds.has(c.status ?? ""),
  }));

  let sessions: SessionLike[] = [];
  if (sessionEnabled) {
    const enriched = await buildEnrichedSessions().catch(() => []);
    // Identity filter: only sessions actually running a Claude agent (the EXACT set the terminal sink
    // will accept, via the same sessionRunsClaude allowlist) — so the operator never picks a target
    // the paste would then refuse. Bounded per-session ps walk; the picker fetches on demand, not polled.
    const isClaude = await Promise.all(enriched.map((s) => sessionRunsClaude(s.name).catch(() => false)));
    sessions = enriched
      .filter((_, i) => isClaude[i])
      .map((s) => ({
        name: s.name,
        label: s.label,
        status: s.status,
        createdAt: s.createdAt,
        // paste-safety predicate (narrowest): ONLY the master orchestrator (`claude*`) — NOT the broad
        // kill-`protected` verdict (every live agent = valid targets) and NOT the durable `shell` (the
        // operator's own interactive session). The sink enforces the same. sessionRunsClaude already
        // filtered to real Claude agents above.
        master: isMasterSession(s.name),
        card: s.card,
      }));
  }

  const options = projectDestinations({ board: feedbackBoard ?? "", cards, sessions, sessionEnabled, now: Date.now() });

  return Response.json({ ok: true, sessionEnabled, options }, { headers: { "cache-control": "no-store" } });
}
