import { describe, expect, it } from "vitest";
import {
  classifyIntake,
  embedCorsHeaders,
  forceEmbedLink,
  isAllowedEmbedOrigin,
  NONCE_HEADER,
  parseEmbedOrigins,
} from "./embed";
import { INGEST_HEADER } from "./ingest";

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
const JSON_CT = { "content-type": "application/json" };
const BOARD = "board.local";

describe("parseEmbedOrigins — the operator's allowlist", () => {
  it("parses a comma-separated list into normalised origins", () => {
    expect(parseEmbedOrigins("https://mosaico.app, http://localhost:3001")).toEqual([
      "https://mosaico.app",
      "http://localhost:3001",
    ]);
  });

  it("OFF by default — absent/empty means the embed lane does not exist", () => {
    expect(parseEmbedOrigins(undefined)).toEqual([]);
    expect(parseEmbedOrigins("")).toEqual([]);
    expect(parseEmbedOrigins("  , ,")).toEqual([]);
  });

  it("drops entries that are not a bare http(s) ORIGIN (a path/wildcard is a config mistake)", () => {
    expect(parseEmbedOrigins("https://mosaico.app/eventos")).toEqual([]); // carries a path
    expect(parseEmbedOrigins("*")).toEqual([]);
    expect(parseEmbedOrigins("mosaico.app")).toEqual([]); // no scheme
    expect(parseEmbedOrigins("javascript:alert(1)")).toEqual([]);
    expect(parseEmbedOrigins("file:///etc")).toEqual([]);
  });

  it("dedupes and tolerates a trailing slash", () => {
    expect(parseEmbedOrigins("https://mosaico.app/,https://mosaico.app")).toEqual(["https://mosaico.app"]);
  });
});

describe("isAllowedEmbedOrigin", () => {
  const allowed = ["https://mosaico.app"];
  it("matches the exact origin only", () => {
    expect(isAllowedEmbedOrigin("https://mosaico.app", allowed)).toBe(true);
    expect(isAllowedEmbedOrigin("https://mosaico.app.evil.com", allowed)).toBe(false); // suffix trick
    expect(isAllowedEmbedOrigin("http://mosaico.app", allowed)).toBe(false); // scheme matters
    expect(isAllowedEmbedOrigin("https://sub.mosaico.app", allowed)).toBe(false);
    expect(isAllowedEmbedOrigin(null, allowed)).toBe(false);
  });
  it("an empty allowlist admits nothing", () => {
    expect(isAllowedEmbedOrigin("https://mosaico.app", [])).toBe(false);
  });
});

/** the lanes config, defaulting both lanes OFF (the shipped default). */
const lanes = (embedOrigins: string[] = [], resolveIngestBoard?: (t: string) => string | null) => ({
  embedOrigins,
  ...(resolveIngestBoard ? { resolveIngestBoard } : {}),
});

describe("classifyIntake — which lane serves this request", () => {
  it("same-origin keeps the FULL capability lane", () => {
    const r = classifyIntake(headers({ ...JSON_CT, origin: `https://${BOARD}`, host: BOARD }), lanes());
    expect(r.kind).toBe("same-origin");
  });

  // AUTONOMY, pinned: this is byte-for-byte what the board's own overlay sends (a fetch POST always
  // carries Origin, and a modern browser adds the attestation). The full lane — reopen a card by id,
  // paste into a live Claude — must keep working exactly as before.
  it("the board's own UI (Origin + the browser's same-origin attestation) keeps the FULL lane", () => {
    const r = classifyIntake(
      headers({ ...JSON_CT, origin: `https://${BOARD}`, host: BOARD, "sec-fetch-site": "same-origin" }),
      lanes(),
    );
    expect(r.kind).toBe("same-origin");
  });

  it("cross-site with NO Origin is refused (sandboxed iframe / data: document)", () => {
    const r = classifyIntake(headers({ ...JSON_CT, "sec-fetch-site": "cross-site" }), lanes(["https://mosaico.app"]));
    expect(r).toMatchObject({ kind: "reject", status: 403 });
  });

  it("an ALLOWLISTED cross-origin gets the embed lane", () => {
    const r = classifyIntake(
      headers({ ...JSON_CT, origin: "https://mosaico.app", host: BOARD, "sec-fetch-site": "cross-site" }),
      lanes(["https://mosaico.app"]),
    );
    expect(r).toEqual({ kind: "embed", origin: "https://mosaico.app" });
  });

  it("a NON-allowlisted cross-origin is refused — and is refused identically when the lane is OFF", () => {
    const h = headers({ ...JSON_CT, origin: "https://evil.example", host: BOARD });
    expect(classifyIntake(h, lanes(["https://mosaico.app"]))).toMatchObject({ kind: "reject", status: 403 });
    expect(classifyIntake(h, lanes())).toMatchObject({ kind: "reject", status: 403 });
  });

  it("the allowlist does NOT weaken the content-type requirement", () => {
    const r = classifyIntake(
      headers({ "content-type": "text/plain", origin: "https://mosaico.app", host: BOARD }),
      lanes(["https://mosaico.app"]),
    );
    expect(r).toMatchObject({ kind: "reject", status: 415 });
  });
});

// THE ATTACK this block exists for: `curl -X POST -H 'content-type: application/json' <board>/api/
// feedback/intake` — no Origin, no Sec-Fetch-Site, no token. Omitting a header is the CHEAPEST request
// anyone can make; while absence of signal counted as "the board's own UI", the cheapest path was also
// the MOST privileged one (file a card, reopen ANY card by id, paste text into a live Claude session).
// Nobody could reach it while the route sits behind the login gate — but the day the operator makes it
// public so the relay lane works, this shape is what arrives. So capability must come only from a
// POSITIVE signal: an Origin that matches Host, an Origin on the allowlist, or a relay token.
describe("classifyIntake — absence of signal is the LEAST privileged class, never the most", () => {
  it("a bare POST with no Origin at all is REFUSED (not promoted to the same-origin lane)", () => {
    expect(classifyIntake(headers(JSON_CT), lanes())).toMatchObject({ kind: "reject", status: 403 });
  });

  it("turning the embed allowlist ON does not hand the headerless caller a lane either", () => {
    expect(classifyIntake(headers(JSON_CT), lanes(["https://mosaico.app"]))).toMatchObject({
      kind: "reject",
      status: 403,
    });
  });

  it("a self-declared Sec-Fetch-Site is not a credential — same-origin without an Origin is refused", () => {
    // Sec-Fetch-Site is unforgeable IN A BROWSER, and worthless outside one: curl writes whatever it
    // likes. It may only ever CONTRADICT an Origin (below), never stand in for one.
    const r = classifyIntake(headers({ ...JSON_CT, "sec-fetch-site": "same-origin" }), lanes());
    expect(r).toMatchObject({ kind: "reject", status: 403 });
  });

  it("the browser CONTRADICTING the Origin wins: host matches but the site is only same-SITE", () => {
    // The scheme-downgrade hole: `Host` carries no scheme, so a page at http://board.local annotating
    // the board served over https://board.local matched on host alone and got the full lane. When the
    // browser's own verdict disagrees with our host comparison, the browser decides.
    const r = classifyIntake(
      headers({ ...JSON_CT, origin: `http://${BOARD}`, host: BOARD, "sec-fetch-site": "same-site" }),
      lanes(),
    );
    expect(r).toMatchObject({ kind: "reject", status: 403 });
  });

  it("Origin: null (sandboxed iframe / data: document) earns no lane", () => {
    const r = classifyIntake(headers({ ...JSON_CT, origin: "null", host: BOARD }), lanes(["https://mosaico.app"]));
    expect(r).toMatchObject({ kind: "reject", status: 403 });
  });

  it("a request with no Host header cannot claim to be the board (nothing to match against)", () => {
    const r = classifyIntake(headers({ ...JSON_CT, origin: `https://${BOARD}` }), lanes());
    expect(r).toMatchObject({ kind: "reject", status: 403 });
  });

  // The sanctioned headerless caller is the RELAY, and it proves itself with a token — the inversion
  // costs it nothing (this is the same shape as the attack above, plus the credential).
  it("the relay keeps working headerless — the token, not the missing Origin, is what admits it", () => {
    const r = classifyIntake(
      headers({ ...JSON_CT, [INGEST_HEADER]: "token-de-repasse-do-app-acme-0001" }),
      lanes([], (t) => (t === "token-de-repasse-do-app-acme-0001" ? "acme" : null)),
    );
    expect(r).toEqual({ kind: "ingest", board: "acme" });
  });
});

// THE regression this suite exists for: a relay sends NEITHER Origin NOR Sec-Fetch-Site, so before
// F6 it was classified `same-origin` — i.e. full capability, session paste included. The token both
// identifies the lane and, when it doesn't resolve, REFUSES it (never a silent fall-through).
describe("classifyIntake — the INGEST (relay) lane", () => {
  const resolver = (t: string) => (t === "token-de-repasse-do-app-acme-0001" ? "acme" : null);
  const relayHeaders = (token: string) => headers({ ...JSON_CT, [INGEST_HEADER]: token });

  it("a valid token yields the ingest lane, with the board taken FROM THE TOKEN", () => {
    const r = classifyIntake(relayHeaders("token-de-repasse-do-app-acme-0001"), lanes([], resolver));
    expect(r).toEqual({ kind: "ingest", board: "acme" });
  });

  it("an UNKNOWN token is refused 401 — it never falls through to the same-origin lane", () => {
    const r = classifyIntake(relayHeaders("token-que-nao-existe-mas-e-longo"), lanes([], resolver));
    expect(r).toMatchObject({ kind: "reject", status: 401 });
  });

  it("with the lane OFF (no resolver) the header is refused, NOT ignored", () => {
    // The dangerous shape: ignoring the header would classify this exact request as same-origin.
    const bare = classifyIntake(relayHeaders("token-de-repasse-do-app-acme-0001"), lanes());
    expect(bare).toMatchObject({ kind: "reject", status: 401 });
  });

  it("claiming the lane can only DOWNGRADE — even a same-origin request with a token lands in ingest", () => {
    const r = classifyIntake(
      headers({ ...JSON_CT, origin: `https://${BOARD}`, host: BOARD, [INGEST_HEADER]: "token-de-repasse-do-app-acme-0001" }),
      lanes([], resolver),
    );
    expect(r).toEqual({ kind: "ingest", board: "acme" });
  });

  it("the token does NOT weaken the content-type requirement", () => {
    const r = classifyIntake(
      headers({ "content-type": "text/plain", [INGEST_HEADER]: "token-de-repasse-do-app-acme-0001" }),
      lanes([], resolver),
    );
    expect(r).toMatchObject({ kind: "reject", status: 415 });
  });
});

describe("embedCorsHeaders — echo ONLY a validated origin, and never credentials", () => {
  const h = embedCorsHeaders("https://mosaico.app");

  it("echoes the exact origin and varies on it", () => {
    expect(h["Access-Control-Allow-Origin"]).toBe("https://mosaico.app");
    expect(h["Vary"]).toBe("Origin");
    expect(h["Access-Control-Allow-Origin"]).not.toBe("*"); // never a wildcard
  });

  it("allows the nonce header (which is what forces the preflight)", () => {
    expect(h["Access-Control-Allow-Headers"]).toContain(NONCE_HEADER);
  });

  it("NEVER allows credentials — the nonce is the credential, not the operator's session", () => {
    const keys = Object.keys(h).map((k) => k.toLowerCase());
    expect(keys).not.toContain("access-control-allow-credentials");
  });
});

describe("forceEmbedLink — an embed may file a NEW item and nothing else", () => {
  it("collapses a session link (the paste path) to triage", () => {
    expect(forceEmbedLink({ kind: "session", board: "storymap", sessionId: "claude-jonatas" })).toEqual({
      kind: "none",
      board: "storymap",
    });
  });

  it("collapses a card link (reopening someone's card by id) to triage", () => {
    expect(forceEmbedLink({ kind: "card", board: "storymap", cardId: "story-x" })).toEqual({
      kind: "none",
      board: "storymap",
    });
  });

  it("keeps a triage link as-is, board included", () => {
    expect(forceEmbedLink({ kind: "none", board: "storymap" })).toEqual({ kind: "none", board: "storymap" });
  });
});
