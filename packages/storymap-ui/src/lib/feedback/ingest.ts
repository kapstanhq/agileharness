// The INGEST lane — a SERVER-TO-SERVER relay operated by the product app's own backend.
//
// WHY it exists. The overlay's reason to be is annotating the PRODUCT's UI, which lives on another
// origin. Two ways to cross that gap:
//   • F5/EMBED — the browser talks to the board directly (allowlisted Origin + a board-issued nonce).
//     Costs: the board must be reachable from the public internet, the page's CSP must list the board
//     in connect-src, and the operator has to carry a nonce around.
//   • INGEST (this one) — the browser talks to ITS OWN backend, which relays to the board with a
//     server-side secret. The board never has to be reachable by the browser, nothing secret ever
//     lands in a page, and the app needs no CSP change for the board. This is the default path.
//
// THE HAZARD THIS MODULE EXISTS TO CLOSE. A relay is a server: it sends no `Origin` and no
// `Sec-Fetch-Site`. Fed to the intake classifier unchanged, that looks EXACTLY like a same-origin
// request from the board's own UI — i.e. FULL capability, including the `session` link that pastes
// into a live Claude. So the relay must ANNOUNCE itself, and the announcement must be unforgeable:
// the `x-ah-ingest` header carries a token, and possession of that token is what the lane is worth.
//
// What a valid token buys, and nothing more:
//   • TRIAGE-ONLY — the link is collapsed server-side to `{kind:"none"}` (forceIngestLink). A relayed
//     batch files a new item; it can never reopen a card by id nor address a tmux session.
//   • ONE BOARD — the board is read FROM THE TOKEN, never from the payload. A leaked relay token can
//     only file into the board it was minted for, whatever the body claims.
// The header also can't be reached from a browser cross-origin: it is a non-simple header, so it needs
// a preflight, and the intake's CORS allow-list never includes it (frozen in no-cors.test.ts).

import { createHash, timingSafeEqual } from "node:crypto";
import type { AnnotationLink } from "./schema";

/** Header carrying the relay's board-scoped token. */
export const INGEST_HEADER = "x-ah-ingest";

/** Below this, a token isn't a secret — it's a typo. Short entries are DROPPED, never honoured. */
export const MIN_INGEST_TOKEN_LENGTH = 24;

/** Board ids are slugs (they name a directory under `boards/`), so anything else is a config error. */
const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface IngestBinding {
  board: string;
  /** sha256 of the token — the parsed config never keeps the plaintext around. */
  hash: string;
}

/**
 * Parse the operator's relay tokens (env `AGILEHARNESS_FEEDBACK_INGEST_TOKENS`), formatted
 * `board:token,board2:token2`. Empty/absent ⇒ the lane does not exist.
 *
 * Malformed entries are DROPPED rather than half-honoured (fail closed): a bad board slug, a token
 * shorter than MIN_INGEST_TOKEN_LENGTH, or a missing separator. Dropping beats guessing — the failure
 * then shows up as an honest 401 at the first relayed request instead of a lane bound to a board the
 * operator didn't mean.
 */
export function parseIngestTokens(raw: string | undefined | null): IngestBinding[] {
  if (!raw) return [];
  const out: IngestBinding[] = [];
  for (const piece of raw.split(",")) {
    const entry = piece.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep <= 0) continue;
    const board = entry.slice(0, sep).trim();
    const token = entry.slice(sep + 1).trim();
    if (!BOARD_ID_RE.test(board)) continue;
    if (token.length < MIN_INGEST_TOKEN_LENGTH) continue;
    out.push({ board, hash: hashToken(token) });
  }
  return out;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Build the resolver the intake classifier calls: a token → the board it is bound to, or null.
 *
 * Compared in constant time against every binding, and WITHOUT an early exit — both so a timing
 * observer learns neither whether a prefix matched nor which board matched. Comparing sha256 digests
 * (fixed 32 bytes) is what makes timingSafeEqual usable on inputs of arbitrary length.
 */
export function makeIngestResolver(bindings: IngestBinding[]): (token: string) => string | null {
  return (token: string) => {
    if (typeof token !== "string" || token.length < MIN_INGEST_TOKEN_LENGTH || token.length > 400) return null;
    const candidate = Buffer.from(hashToken(token), "hex");
    let match: string | null = null;
    for (const b of bindings) {
      let stored: Buffer;
      try {
        stored = Buffer.from(b.hash, "hex");
      } catch {
        continue;
      }
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) match = b.board;
    }
    return match;
  };
}

/**
 * TRIAGE-ONLY collapse for the relay lane, with the board taken from the TOKEN.
 *
 * Deliberately drops everything the payload asked for — cardId, sessionId and the payload's own
 * `board`. A relay is the least-trusted producer in the system (its input is an anonymous browser on
 * the public internet), so it gets the one capability that is safe to expose: file a new item, in one
 * known board, for a human to triage.
 */
export function forceIngestLink(board: string): AnnotationLink {
  return { kind: "none", board };
}
