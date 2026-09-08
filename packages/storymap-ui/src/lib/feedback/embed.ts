// F5 — the CROSS-ORIGIN embed lane. PURE (no fs, no Request): the whole access decision for a
// cross-origin POST lives here so it can be unit-tested exhaustively, which matters because this is
// the one place the same-origin invariant is deliberately relaxed.
//
// WHY relax it at all: the overlay's REASON to exist is annotating the PRODUCT's own UI (Nest at
// mosaico.app/eventos, or acmeapp on :3001 in dev) — always a different origin from the board. Until
// now every feedback endpoint answered a cross-origin caller with 403, so the overlay only worked on
// the board itself (dogfood).
//
// WHY it is NOT just "turn CORS on" — the two things a cross-origin caller must never get:
//   1. RECON — /destinations lists live tmux session NAMES (also the ?b= attach keys and the paste
//      targets). It stays same-origin-only FOREVER; this module is never wired into it.
//   2. WRITE POWER — a session-linked batch pastes into a live Claude. The embed lane is therefore
//      forced to TRIAGE-ONLY server-side (see forceEmbedLink): an embed can file a new item and
//      nothing else. Not a client convention — the server rewrites the link.
//
// The lane opens only when BOTH hold: the Origin is on the operator's allowlist AND the request
// carries a valid board-issued nonce. Absent allowlist (the default) ⇒ the lane does not exist and
// behaviour is byte-for-byte what it was before F5.

// F6 note: this module is now THE lane classifier for the intake — same-origin, embed (cross-origin
// browser) and ingest (server-to-server relay). It stays dependency-free on purpose: the ingest
// SECRET never enters here, only a resolver callback the route injects (see classifyIntake).

import type { AnnotationLink } from "./schema";
import type { HeaderReader } from "./guard";
import { INGEST_HEADER } from "./ingest";

/** Header carrying the board-issued nonce. Custom on purpose: a custom header can't ride a "simple"
 *  request, so the browser MUST preflight — giving us a chokepoint that a form-POST can't bypass. */
export const NONCE_HEADER = "x-ah-nonce";

/**
 * Parse the operator's embed allowlist (env `STORYMAP_FEEDBACK_EMBED_ORIGINS`, comma-separated).
 * Each entry must be a bare ORIGIN (scheme://host[:port]) — a value with a path/query is a config
 * mistake and is dropped rather than half-honoured. Empty ⇒ the embed lane is OFF.
 */
export function parseEmbedOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const s = piece.trim();
    if (!s) continue;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      continue; // not a URL at all
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    // `new URL("https://a.com/x").origin` drops the path — compare against the ORIGIN so a sloppy
    // entry with a trailing path still normalises, but reject anything carrying query/hash intent.
    if (s !== u.origin && s !== `${u.origin}/`) continue;
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}

export function isAllowedEmbedOrigin(origin: string | null | undefined, allowed: string[]): boolean {
  if (!origin || allowed.length === 0) return false;
  let normalised: string;
  try {
    normalised = new URL(origin).origin;
  } catch {
    return false;
  }
  return allowed.includes(normalised);
}

export type IntakeAccess =
  | { kind: "same-origin" }
  | { kind: "embed"; origin: string }
  /** a relay run by the product app's backend; `board` comes from the TOKEN, never the payload. */
  | { kind: "ingest"; board: string }
  | { kind: "reject"; status: number; error: string };

export interface IntakeLanes {
  /** F5: origins allowed to talk to the board straight from a browser. Empty ⇒ that lane is OFF. */
  embedOrigins: string[];
  /** F6: token → board for the relay lane. ABSENT ⇒ that lane is OFF, and a request that presents
   *  the header is REFUSED rather than falling through to another lane (see below). */
  resolveIngestBoard?: (token: string) => string | null;
}

/**
 * Classify a POST /intake request into the lane that will serve it. Order matters:
 *   json → ingest header → same-origin → allowlisted embed → reject.
 *
 * A same-origin request keeps the FULL capability set (card/session/triage). An embed gets in only
 * with an allowlisted Origin; the caller then still has to present a valid nonce (verified with the
 * store, which this pure module deliberately doesn't reach). An ingest presents a board-scoped token
 * and is collapsed to triage-only.
 *
 * WHY the ingest check comes FIRST, before the origin checks: a relay carries no `Origin` and no
 * `Sec-Fetch-Site`, so it is INDISTINGUISHABLE from the board's own UI by those headers alone — it
 * would otherwise land in `same-origin` with full capability, which is precisely the privilege the
 * relay must not have. Claiming the lane can only ever DOWNGRADE a request (triage-only, one board),
 * so evaluating it first is safe even for a caller that could have qualified for another lane. And
 * because an unrecognised token is REFUSED here rather than falling through, a misconfigured relay
 * fails loudly (401) instead of silently being promoted to same-origin.
 *
 * FAIL-CLOSED ON ABSENCE (story-14xvpa). Capability is granted ONLY by a signal that is present and
 * checkable: an `Origin` whose host matches `Host` (and that the browser does not itself contradict),
 * an `Origin` on the operator's allowlist, or a resolvable relay token. Until this inversion, a
 * request with NO `Origin` and NO `Sec-Fetch-Site` fell through to `same-origin` — so the cheapest
 * request anyone can make (`curl` with a single content-type header) was also the most privileged one,
 * carrying the right to reopen any card by id and to paste text into a live Claude session. Nothing
 * exploited it, because the route sits behind the login gate; the point is that the gate then became
 * the ONLY thing holding, and step 2 of that card is to make this route reachable without a cookie so
 * the relay lane can exist. Ordering the inversion first is what keeps that step from opening a hole.
 * Zero cost to the sanctioned callers: the board's own overlay is a browser `fetch` POST, which always
 * carries `Origin`, and the relay is admitted by its token.
 */
export function classifyIntake(headers: HeaderReader, lanes: IntakeLanes): IntakeAccess {
  const ctype = (headers.get("content-type") ?? "").toLowerCase();
  if (!ctype.includes("application/json")) {
    return { kind: "reject", status: 415, error: "content-type deve ser application/json" };
  }

  const ingestToken = headers.get(INGEST_HEADER);
  if (ingestToken) {
    const board = lanes.resolveIngestBoard ? lanes.resolveIngestBoard(ingestToken) : null;
    if (!board) {
      return { kind: "reject", status: 401, error: "token de repasse inválido ou lane desligada" };
    }
    return { kind: "ingest", board };
  }

  const allowedOrigins = lanes.embedOrigins;
  const origin = headers.get("origin");
  if (!origin) {
    // Nothing to verify ⇒ no lane. A browser POST always sends `Origin`, so this shape is never the
    // board's UI: it is a non-browser caller, and the ONE sanctioned non-browser caller (the relay)
    // identifies itself with a token above. Naming that path in the error keeps the refusal actionable
    // for whoever is wiring a relay, without conceding anything to a caller that has no credential.
    return {
      kind: "reject",
      status: 403,
      error: "requisição sem Origin não é aceita (a via servidor-a-servidor é o token de repasse)",
    };
  }

  // `Sec-Fetch-Site` is a forbidden header — script cannot write it, so INSIDE a browser it is the
  // browser's own verdict about the caller. It can therefore only ever VETO the host comparison below,
  // never substitute for it (outside a browser it is just another string the caller chose).
  const fetchSite = (headers.get("sec-fetch-site") ?? "").toLowerCase();
  let sameOrigin = false;
  try {
    // `Host` carries no scheme, so host equality alone would also accept a document served over the
    // OTHER scheme on the same host (http page ⇢ https board) — a same-SITE, cross-ORIGIN caller. When
    // the browser says the site is anything but `same-origin`, the browser wins and the full lane is
    // withheld; an absent value (older browser / non-browser) leaves the host comparison in charge.
    sameOrigin = new URL(origin).host === (headers.get("host") ?? "");
  } catch {
    sameOrigin = false; // includes `Origin: null` (sandboxed iframe / data: document)
  }
  if (sameOrigin && (fetchSite === "" || fetchSite === "same-origin")) return { kind: "same-origin" };
  // A caller the full lane refused may still qualify for the DOWNGRADED embed lane (triage-only, and
  // a nonce still to prove) — being refused above never promotes anything.
  if (isAllowedEmbedOrigin(origin, allowedOrigins)) return { kind: "embed", origin: new URL(origin).origin };
  return { kind: "reject", status: 403, error: "origem cruzada não permitida" };
}

/**
 * CORS headers for an ALREADY-CLASSIFIED embed origin. Never call this with an unvalidated value —
 * echoing an arbitrary Origin is the classic "CORS allowlist that allows everything".
 * Note what is ABSENT and must stay absent: `Access-Control-Allow-Credentials`. The nonce IS the
 * credential; allowing cookies/basic-auth to ride along would let a malicious page borrow the
 * operator's board session instead of proving possession of a nonce.
 */
export function embedCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": `content-type, ${NONCE_HEADER}`,
    "Access-Control-Max-Age": "600",
    // The response varies by Origin — without this a shared cache could serve one origin's
    // allow-header to another.
    Vary: "Origin",
  };
}

/**
 * TRIAGE-ONLY collapse for the embed lane. An embed may file a NEW item and nothing else: it can't
 * reopen an arbitrary card by id, and above all it can't address a tmux session (which would paste
 * into a live agent). Applied SERVER-SIDE after schema validation, so a hostile producer that sends
 * `{kind:"session", sessionId:"claude"}` simply has it rewritten — there is no path where an embed
 * batch reaches the terminal or refine sink.
 */
export function forceEmbedLink(link: AnnotationLink): AnnotationLink {
  return { kind: "none", ...(link.board ? { board: link.board } : {}) };
}
