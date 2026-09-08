import { describe, expect, it } from "vitest";

// Behavioral freeze of the auth boundary's SECOND floor. The FIRST floor is Caddy basic_auth: in prod
// `/api/feedback/*` matches neither the PUBLIC `@mcp` (`/api/usm/*`) nor the `@pwa` asset matcher, so it
// hits the basic_auth catch-all → 401 without credentials (live spike confirmed; the Caddyfile is infra,
// not in-repo, so it can't be frozen here). Unlike a string grep for the guard token, this INVOKES each
// route handler with a cross-site request and asserts it is rejected (403) BEFORE any sink runs — so a
// future refactor that comments out, relocates past an early return, or otherwise neuters the
// same-origin guard fails here. The guard's own accept/reject logic is unit-covered in guard.test.ts.
describe("feedback routes enforce same-origin at the handler boundary (behavioral)", () => {
  it("intake POST → 403 on a cross-site request (before touching a sink)", async () => {
    const { POST } = await import("@/app/api/feedback/intake/route");
    const req = new Request("http://board.local/api/feedback/intake", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ v: 1, producer: "x", producedAt: "2026-01-01T00:00:00.000Z", link: { kind: "none" }, pins: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("destinations GET → 403 on a cross-site request", async () => {
    const { GET } = await import("@/app/api/feedback/destinations/route");
    const req = new Request("http://board.local/api/feedback/destinations", {
      method: "GET",
      headers: { "sec-fetch-site": "cross-site" },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  // The shot store is BOTH a write (into the board's sidecar zone) and a read (a screenshot of the
  // operator's screen) — a cross-site page must be able to do neither.
  it("shot POST → 403 on a cross-site upload (nothing reaches disk)", async () => {
    const { POST } = await import("@/app/api/feedback/shot/route");
    const req = new Request("http://board.local/api/feedback/shot", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("shot GET → 403 on a cross-site read (no hotlinking a screenshot)", async () => {
    const { GET } = await import("@/app/api/feedback/shot/route");
    const req = new Request("http://board.local/api/feedback/shot?board=storymap&batch=ab12&file=shot-1.png", {
      method: "GET",
      headers: { "sec-fetch-site": "cross-site" },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

// F6 — the shot store's RELAY lane. A region capture only keeps its image if the app's server can
// upload it, so this endpoint grew a second caller. Both cases below stop BEFORE anything is written:
// a bad token is refused outright, and a good token is fed an INVALID image, so 400 means "the lane
// opened" and 401 means "it didn't" — the distinction worth pinning. The GET stays same-origin-only
// (frozen above): a relay may write a screenshot, never read one back.
describe("F6 relay lane on the shot store — token or nothing, and never a browser", () => {
  const TOKEN = "token-de-repasse-do-app-0001";

  async function postShot(headers: Record<string, string>, dataUrl: string) {
    const { POST } = await import("@/app/api/feedback/shot/route");
    return POST(
      new Request("http://board.local/api/feedback/shot", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ dataUrl }),
      }),
    );
  }

  it("an invalid token is refused 401 (nothing decoded, nothing written)", async () => {
    process.env.STORYMAP_FEEDBACK_INGEST_TOKENS = `acme:${TOKEN}`;
    const res = await postShot({ "x-ah-ingest": "token-errado-porem-longo-o-bastante" }, "data:image/png;base64,iVBORw0KGgo=");
    expect(res.status).toBe(401);
    delete process.env.STORYMAP_FEEDBACK_INGEST_TOKENS;
  });

  it("with the lane OFF the token is refused too (never falls through to same-origin)", async () => {
    delete process.env.STORYMAP_FEEDBACK_INGEST_TOKENS;
    const res = await postShot({ "x-ah-ingest": TOKEN }, "data:image/png;base64,iVBORw0KGgo=");
    expect(res.status).toBe(401);
  });

  it("a valid token clears the gate (400 on a bogus image = reached validation, not 401)", async () => {
    process.env.STORYMAP_FEEDBACK_INGEST_TOKENS = `acme:${TOKEN}`;
    const res = await postShot({ "x-ah-ingest": TOKEN }, "data:text/html;base64,PHNjcmlwdD4=");
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBeNull(); // server-to-server: never CORS
    delete process.env.STORYMAP_FEEDBACK_INGEST_TOKENS;
  });
});

// F5 — the cross-origin EMBED lane, frozen behaviourally (a grep can't tell a gated lane from blanket
// CORS). Every case below stops BEFORE the sink runs, so nothing here creates a card or touches tmux:
// a request that clears the nonce gate is fed a schema-INVALID batch, so 400 means "the gate opened"
// and 401 means "it didn't" — the distinction we actually want to pin.
describe("F5 embed lane — allowlisted origin + board nonce, or nothing", () => {
  const ALLOWED = "https://mosaico.app";
  const invalidBatch = JSON.stringify({ link: { board: "storymap" }, pins: [] }); // pins:[] fails the schema

  async function postFrom(origin: string, headers: Record<string, string> = {}) {
    const { POST } = await import("@/app/api/feedback/intake/route");
    return POST(
      new Request("http://board.local/api/feedback/intake", {
        method: "POST",
        headers: { "content-type": "application/json", origin, host: "board.local", "sec-fetch-site": "cross-site", ...headers },
        body: invalidBatch,
      }),
    );
  }

  it("with the lane OFF (no allowlist) an allowlisted-looking origin is still refused", async () => {
    delete process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS;
    const res = await postFrom(ALLOWED);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a NON-allowlisted origin is refused and gets NO allow-header", async () => {
    process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS = ALLOWED;
    const res = await postFrom("https://evil.example");
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    delete process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS;
  });

  it("an allowlisted origin WITHOUT a nonce is refused (origin alone is not authorisation)", async () => {
    process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS = ALLOWED;
    const res = await postFrom(ALLOWED);
    expect(res.status).toBe(401);
    // the error IS readable cross-origin, so the operator can see why
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    delete process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS;
  });

  it("an allowlisted origin WITH a valid nonce clears the gate (400 = reached validation, not 401)", async () => {
    process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS = ALLOWED;
    const { mintNonce } = await import("./nonce-store");
    const { token } = await mintNonce(Date.now());
    const res = await postFrom(ALLOWED, { "x-ah-nonce": token });
    expect(res.status).toBe(400); // past the nonce gate, rejected by the schema — no sink ran
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    delete process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS;
  });

  it("preflight: 204 + allow-headers for an allowlisted origin, bare 403 otherwise", async () => {
    process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS = ALLOWED;
    const { OPTIONS } = await import("@/app/api/feedback/intake/route");
    const ok = await OPTIONS(new Request("http://board.local/api/feedback/intake", { method: "OPTIONS", headers: { origin: ALLOWED } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-ah-nonce");

    const nope = await OPTIONS(new Request("http://board.local/api/feedback/intake", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(nope.status).toBe(403);
    expect(nope.headers.get("access-control-allow-origin")).toBeNull();
    delete process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS;
  });

  it("the same-origin lane is untouched by the allowlist (no CORS header leaks onto it)", async () => {
    process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS = ALLOWED;
    const { POST } = await import("@/app/api/feedback/intake/route");
    const res = await POST(
      new Request("http://board.local/api/feedback/intake", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://board.local", host: "board.local" },
        body: invalidBatch,
      }),
    );
    expect(res.status).toBe(400); // same-origin reaches validation as always
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    delete process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS;
  });
});
