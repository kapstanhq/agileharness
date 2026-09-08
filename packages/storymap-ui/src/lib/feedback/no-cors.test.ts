import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embedCorsHeaders } from "./embed";
import { INGEST_HEADER } from "./ingest";

// These feedback endpoints are SAME-ORIGIN ONLY, and their confidentiality rests ENTIRELY on never
// emitting a CORS allow header (the same-origin policy then blocks a cross-origin page from READING
// the response). Highest stakes on the catalog: it lists live Claude session NAMES, which are also the
// `?b=` attach keys and the tmux paste targets — i.e. reconnaissance for the paste path. The shot
// store serves screenshots of the operator's screen; the nonce route MINTS the embed capability, so
// cross-origin access there would let a page issue itself a key.
//
// ⚠️ F5 deliberately EXCLUDED /intake from this list: it now has a narrow, gated cross-origin lane
// (allowlisted Origin + board-issued nonce, collapsed to triage-only). That relaxation is frozen
// BEHAVIOURALLY in guard-wiring.test.ts (CORS only for an allowlisted origin, 403 otherwise, 401
// without a nonce) — a grep could not distinguish "gated lane" from "blanket CORS". Everything below
// must stay CORS-free forever.
const ROUTES_NEVER_CORS = [
  "src/app/api/feedback/destinations/route.ts",
  "src/app/api/feedback/shot/route.ts",
  "src/app/api/feedback/nonce/route.ts",
];

describe("feedback endpoints never emit CORS (same-origin-only invariant)", () => {
  for (const rel of ROUTES_NEVER_CORS) {
    it(`${rel} sets no Access-Control-Allow-* header`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8").toLowerCase();
      expect(src).not.toContain("access-control-allow");
    });
  }

  // F6 — the relay lane's header must stay UNREACHABLE from a browser. It is a non-simple header, so
  // a cross-origin fetch needs a preflight; as long as it is never in Access-Control-Allow-Headers,
  // the browser refuses to send it and the lane is server-to-server by construction. (A page could
  // then only reach the relay via the app's OWN backend — which is exactly the intended path.)
  it("the ingest header is NEVER allowed cross-origin", () => {
    const allow = embedCorsHeaders("https://exemplo.test")["Access-Control-Allow-Headers"].toLowerCase();
    expect(allow).not.toContain(INGEST_HEADER);
  });

  it("the intake's CORS is the ONLY one, and it can never be a wildcard", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/feedback/intake/route.ts"), "utf8");
    // It must not hand-roll headers at all — it delegates to embedCorsHeaders, whose unit tests pin
    // the exact echo-the-validated-origin / no-credentials shape.
    expect(src).toContain("embedCorsHeaders");
    expect(src.toLowerCase()).not.toContain('"access-control-allow-origin"');
    expect(src).not.toContain('"*"');
  });
});
// The auth boundary's SECOND floor (every route must call a same-origin guard) is frozen BEHAVIOURALLY
// in guard-wiring.test.ts — it invokes each handler with a cross-site request and asserts 403, which a
// string-match here could not (a grep passes even on a commented-out or relocated guard call).
