// POST /api/feedback/intake — the BROKER for the AgileHarness feedback overlay.
//
// The overlay (running in the product app: localhost or the public faceUrl) POSTs an
// AnnotationBatch here. This route runs INSIDE the storymap-ui service — the sole writer of
// board data (D4/WS-3) — so it is the trusted place that turns captured pins into AgileHarness
// work. It validates the batch, picks the first accepting sink, and always returns the
// copy-paste handoff markdown (so the operator has a fallback even if a sink fails).
//
// THREE LANES:
//  • SAME-ORIGIN (the board itself) — full capability: triage / refine a card / paste into a session.
//    Authorised HERE, by the operator's session cookie (`hasBoardSession`, the SAME `verifySession`
//    the middleware and the terminal gateway use). This route IS in `PUBLIC_ROUTES` (self-auth) since
//    story-14xvpa step 2: it left the middleware's default-deny so the two lanes below can exist —
//    a relay has no cookie, and a cross-origin browser never sends the board's. (Until 2026-07-27 the
//    claim here was "it sits behind the Caddy basic_auth catch-all"; that basic_auth is GONE, and from
//    2026-07-27 to 2026-09-09 the route sat behind the middleware instead, which made INGEST and EMBED
//    unreachable — the relay in the reference deployment logged zero executions. See story-8oy5q8 and
//    the repo's issue #2.) Two floors, both in this file: `classifyIntake` grants this lane only on a
//    POSITIVE same-origin signal (no `Origin` ⇒ refused, never assumed to be the board's own UI), and
//    then the session check — because `Origin` is a header a non-browser client writes at will, the
//    signal alone would hand full capability to a two-header `curl`.
//  • INGEST (F6, the DEFAULT path for a product app) — a relay running in the app's OWN backend posts
//    here with a board-scoped token (`x-ah-ingest`). The browser never holds a board credential and
//    the board never has to be reachable from the public internet. Collapsed to TRIAGE-ONLY, with the
//    board taken from the token. Ships OFF (no `STORYMAP_FEEDBACK_INGEST_TOKENS` ⇒ 401).
//  • EMBED, cross-origin (F5, the fallback for an app with NO backend) — the browser talks to the
//    board directly. Opens ONLY when the Origin is on the operator's allowlist AND the request carries
//    a valid board-issued nonce, and is likewise collapsed to TRIAGE-ONLY. Ships OFF: no
//    `STORYMAP_FEEDBACK_EMBED_ORIGINS` ⇒ the lane does not exist.
// Both untrusted lanes are RATE-LIMITED: every accepted batch spawns a triage agent, so an unbounded
// caller is an unbounded bill.
// The catalog (/destinations) and the shot store are NOT part of this — they stay same-origin-only
// forever, because the catalog lists live tmux session names (recon for the paste path).

import { refineCardAction, reportIssueAction } from "@/app/actions";
import type { ImprovementKind } from "@/lib/storymap/frameworks";
import { sendToClaudeSession } from "@/lib/vps/tmux";
import { isMasterSession } from "@/lib/vps/kill-guard";
import { coerceAnnotationBatch, renderBatchMarkdown } from "@/lib/feedback/schema";
import {
  classifyIntake,
  embedCorsHeaders,
  forceEmbedLink,
  NONCE_HEADER,
  parseEmbedOrigins,
} from "@/lib/feedback/embed";
import { forceIngestLink, makeIngestResolver, parseIngestTokens } from "@/lib/feedback/ingest";
import { hasBoardSession, SESSION_REQUIRED_ERROR } from "@/lib/feedback/session-gate";
import { createRateLimiter } from "@/lib/feedback/rate-limit";
import { verifyNonce } from "@/lib/feedback/nonce-store";
import { deriveLink } from "@/lib/feedback/link";
import { pickSink, type SinkDeps } from "@/lib/feedback/sinks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ceiling for the untrusted lanes. Sized for a HUMAN annotating a screen (a busy session files a
// handful of batches), not for a machine: well above real use, far below "loop submit() forever".
// Module-level so it survives across requests within the single board process (see rate-limit.ts on
// why in-process is a truthful ceiling here and what would change with replicas).
const UNTRUSTED_LANE_LIMIT = 30;
const UNTRUSTED_LANE_WINDOW_MS = 60_000;
const untrustedLimiter = createRateLimiter({ limit: UNTRUSTED_LANE_LIMIT, windowMs: UNTRUSTED_LANE_WINDOW_MS });

// Wire the real server actions into the sink contract. Explicit mapping (not a bare pass-
// through) keeps the sinks decoupled from the actions' richer Result shape.
const deps: SinkDeps = {
  reportIssue: async (input) => {
    const r = await reportIssueAction(input);
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.data) return { ok: false, error: "triagem não retornou card" };
    return { ok: true, data: { card: { id: r.data.card.id } } };
  },
  refineCard: async (input) => {
    const r = await refineCardAction({
      boardId: input.boardId,
      cardId: input.cardId,
      brief: input.brief,
      kinds: input.kinds as ImprovementKind[],
    });
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.data) return { ok: false, error: "refino não retornou card" };
    return { ok: true, data: { card: { id: r.data.card.id } } };
  },
  sendToTerminal: async (input) => {
    // Ships OFF — the terminal round-trip drives a real tmux session, so it stays behind an explicit
    // opt-in (like the codebase's other risky capabilities). Enable with STORYMAP_FEEDBACK_TERMINAL=1.
    if (process.env.STORYMAP_FEEDBACK_TERMINAL !== "1") {
      return { ok: false, error: "round-trip de terminal desligado (defina STORYMAP_FEEDBACK_TERMINAL=1 para ligar)" };
    }
    // SERVER-SIDE re-enforcement of the picker's exclusion (SAME predicate → they agree by
    // construction): NEVER paste into the MASTER orchestrator (`claude*`, which drives autorun
    // box-wide). The sessionId is client-controlled, so a direct POST (or a future cross-origin nonce
    // path) must not target the orchestrator by bypassing the picker. NARROWEST paste-safety check (by
    // name) — deliberately NOT the broad kill-`protected` verdict (every live agent = valid targets),
    // and NOT the durable `shell` (the operator's own interactive session IS a valid target). On top of
    // sendToClaudeSession's Claude identity allowlist (which already refuses non-Claude sessions like
    // the ttyd root shell).
    if (isMasterSession(input.sessionId)) {
      return { ok: false, error: `sessão "${input.sessionId}" é o orquestrador (master) — envio recusado` };
    }
    const r = await sendToClaudeSession(input.sessionId, input.text);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

/** CORS PREFLIGHT — reached only because the embed sends a custom nonce header (which makes the POST
 *  non-"simple"). Answered ONLY for an allowlisted origin; anything else gets a bare 403 with no
 *  allow-headers, so the browser blocks the real request before it is ever sent. */
export async function OPTIONS(request: Request): Promise<Response> {
  const allowed = parseEmbedOrigins(process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS);
  const origin = request.headers.get("origin");
  if (origin && allowed.includes(safeOrigin(origin))) {
    return new Response(null, { status: 204, headers: embedCorsHeaders(safeOrigin(origin)) });
  }
  return new Response(null, { status: 403 });
}

function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

export async function POST(request: Request): Promise<Response> {
  const access = classifyIntake(request.headers, {
    embedOrigins: parseEmbedOrigins(process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS),
    resolveIngestBoard: makeIngestResolver(parseIngestTokens(process.env.STORYMAP_FEEDBACK_INGEST_TOKENS)),
  });
  if (access.kind === "reject") {
    return Response.json({ ok: false, error: access.error }, { status: access.status });
  }
  // The same-origin lane's proof is the operator's SESSION — checked here since the route left the
  // middleware's gate (story-14xvpa step 2). Before the body is read, before any sink: a forged
  // `Origin` without a cookie gets the middleware's own 401, not a look at the handler.
  if (access.kind === "same-origin" && !(await hasBoardSession(request.headers))) {
    return Response.json({ ok: false, error: SESSION_REQUIRED_ERROR }, { status: 401 });
  }

  // Every response on the embed lane must carry the allow-header, errors included — otherwise the
  // browser hides the reason and the operator debugs blind. The ingest lane is server-to-server and
  // NEVER gets CORS headers (a browser must not be able to reach it directly).
  const cors = access.kind === "embed" ? embedCorsHeaders(access.origin) : undefined;
  const reply = (body: unknown, status: number) => Response.json(body, { status, ...(cors ? { headers: cors } : {}) });

  // Cap the untrusted lanes BEFORE reading the body — the cheapest possible refusal. Keyed per
  // origin / per board so one noisy consumer can't starve another, and never applied to the
  // same-origin board UI (that caller is already behind the platform's auth).
  if (access.kind !== "same-origin") {
    const key = access.kind === "embed" ? `embed:${access.origin}` : `ingest:${access.board}`;
    const verdict = untrustedLimiter.take(key, Date.now());
    if (!verdict.ok) {
      return Response.json(
        { ok: false, error: "muitos envios seguidos — tente de novo em instantes" },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(verdict.retryAfterMs / 1000)), ...(cors ?? {}) },
        },
      );
    }
  }

  // The embed lane's second gate: an allowlisted ORIGIN is not enough (an attacker who gets a user to
  // visit the product site still can't post) — the request must PROVE it was sanctioned by the
  // operator. (The ingest lane's equivalent proof is the token, already verified by classifyIntake.)
  if (access.kind === "embed") {
    const ok = await verifyNonce(request.headers.get(NONCE_HEADER), Date.now());
    if (!ok) {
      return reply({ ok: false, error: "nonce ausente ou expirado — peça um novo no board" }, 401);
    }
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return reply({ ok: false, error: "corpo JSON inválido" }, 400);
  }

  const parsed = coerceAnnotationBatch(raw);
  if (!parsed.ok) {
    return reply({ ok: false, error: parsed.error }, 400);
  }
  // Defensive normalisation: a routed kind must carry its target and an explicit "none" wins, so a
  // sloppy producer (a kind that doesn't match its selection) can't route wrong. Real overlay traffic
  // is already consistent → unchanged; this only fixes malformed inputs. Routing stays link.kind-only.
  // Then, for the UNTRUSTED lanes, the link is COLLAPSED to triage-only: whatever the remote page
  // asked for, it may file a new item and nothing else — never reopen a card by id, never address a
  // tmux session. The two differ in ONE way: an embed keeps the board its payload named (its origin is
  // allowlisted per operator), while an INGEST takes the board from its token and ignores the payload
  // entirely (a relay's input is an anonymous browser, so nothing it says may choose a destination).
  const link =
    access.kind === "ingest"
      ? forceIngestLink(access.board)
      : access.kind === "embed"
        ? forceEmbedLink(deriveLink(parsed.batch.link))
        : deriveLink(parsed.batch.link);
  const batch = { ...parsed.batch, link };
  const handoff = renderBatchMarkdown(batch);

  const sink = pickSink(batch);
  if (!sink) {
    return reply(
      { ok: false, error: "nenhum destino aceitou o lote (o overlay precisa de um board configurado)", handoff },
      422,
    );
  }

  try {
    const result = await sink.run(batch, deps);
    return reply({ ok: result.ok, result, handoff }, result.ok ? 200 : 502);
  } catch (e) {
    return reply({ ok: false, error: e instanceof Error ? e.message : String(e), handoff }, 500);
  }
}
