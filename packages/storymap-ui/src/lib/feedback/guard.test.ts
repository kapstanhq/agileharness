import { describe, expect, it } from "vitest";
import { checkSameOrigin, checkSameOriginJson, type HeaderReader } from "./guard";

// A deterministic header bag — avoids the forbidden-header quirks of a real Headers/Request for
// "host"/"origin", and lets us assert the EXACT status the intake route returns.
function headers(map: Record<string, string>): HeaderReader {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(map)) lower[k.toLowerCase()] = map[k];
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

describe("feedback broker same-origin/CSRF guard", () => {
  it("accepts a same-origin JSON POST (Origin host == Host)", () => {
    const v = checkSameOriginJson(
      headers({
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        origin: "https://board.example",
        host: "board.example",
      }),
    );
    expect(v.ok).toBe(true);
  });

  it("ATTACK: a headerless JSON POST is REFUSED — silence is not the board's own UI", () => {
    // The premise this replaces was simply false: `fetch` omits `Origin` on GET/HEAD, never on a POST.
    // So "no Origin at all" was never the shape the board sends — it is the shape of `curl -H
    // 'content-type: application/json'`, the cheapest request anyone can make, and it used to be the
    // most privileged one (see the FAIL-CLOSED note in guard.ts).
    const v = checkSameOriginJson(headers({ "content-type": "application/json; charset=utf-8" }));
    expect(v.ok, "absence of every origin signal must be the LEAST privileged class").toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(403);
  });

  it("rejects a non-JSON content-type with 415 (forces a preflight for any cross-origin caller)", () => {
    const v = checkSameOriginJson(headers({ "content-type": "text/plain" }));
    expect(v).toEqual({ ok: false, status: 415, error: "content-type deve ser application/json" });
  });

  it("rejects a missing content-type with 415", () => {
    const v = checkSameOriginJson(headers({}));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(415);
  });

  it("rejects Sec-Fetch-Site=cross-site with 403 even when Origin is absent (sandbox/data:)", () => {
    const v = checkSameOriginJson(headers({ "content-type": "application/json", "sec-fetch-site": "cross-site" }));
    expect(v).toEqual({ ok: false, status: 403, error: "cross-site não permitido (Fase 3b: nonce)" });
  });

  it("rejects a cross-origin Origin (host mismatch) with 403", () => {
    const v = checkSameOriginJson(
      headers({ "content-type": "application/json", origin: "https://evil.example", host: "board.example" }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(403);
    expect(v.error).toContain("origem cruzada");
  });

  it("rejects a malformed Origin (unparseable URL) with 403", () => {
    const v = checkSameOriginJson(
      headers({ "content-type": "application/json", origin: "://not a url", host: "board.example" }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(403);
  });

  it("cross-site takes precedence over a same-host Origin (defence in depth)", () => {
    const v = checkSameOriginJson(
      headers({
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        origin: "https://board.example",
        host: "board.example",
      }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(403);
  });
});

describe("read guard (checkSameOrigin) — the GET catalog variant", () => {
  it("accepts a same-origin GET with NO content-type (a GET has no body)", () => {
    const v = checkSameOrigin(headers({ origin: "https://board.example", host: "board.example" }));
    expect(v.ok).toBe(true);
  });

  // AUTONOMY, pinned: this is byte-for-byte what the overlay's catalog read and the stored-shot <img>
  // send. A GET carries NO `Origin` (the spec omits it), so the browser's own attestation is the only
  // positive signal available — refusing it would take the picker and the screenshots away from the
  // operator, which is the forbidden outcome.
  it("accepts the board's own GET: no Origin, but the browser attests same-origin", () => {
    const v = checkSameOrigin(headers({ "sec-fetch-site": "same-origin", accept: "application/json" }));
    expect(v.ok).toBe(true);
  });

  it("accepts a user-initiated request (Sec-Fetch-Site: none) — no initiator document exists", () => {
    // Address bar / bookmark: the operator opening a stored screenshot URL directly. A third-party page
    // cannot cause this shape (its top-level navigation is `cross-site`), so it names no attacker.
    expect(checkSameOrigin(headers({ "sec-fetch-site": "none" })).ok).toBe(true);
  });

  it("does NOT require application/json (unlike the POST guard)", () => {
    const v = checkSameOrigin(headers({ "content-type": "text/plain", "sec-fetch-site": "same-origin" }));
    expect(v.ok).toBe(true);
  });

  it("rejects Sec-Fetch-Site=cross-site with 403", () => {
    const v = checkSameOrigin(headers({ "sec-fetch-site": "cross-site" }));
    expect(v).toEqual({ ok: false, status: 403, error: "cross-site não permitido (Fase 3b: nonce)" });
  });

  it("rejects a cross-origin Origin with 403", () => {
    const v = checkSameOrigin(headers({ origin: "https://evil.example", host: "board.example" }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(403);
  });
});

// THE ATTACK this block exists for: `curl <board>/api/feedback/destinations` — no Origin, no
// Sec-Fetch-Site, nothing. This guard fronts the RECON surface (the catalog lists live tmux session
// NAMES, which are the ?b= attach keys and the paste targets) and a screenshot of the operator's
// screen. While absence of signal counted as "the board's own page", the cheapest request was the
// privileged one; the inversion landed in `classifyIntake` (the batch endpoint) and stopped there, so
// this guard kept the old fallback while guarding the endpoint next door.
describe("read guard — absence of EVERY origin signal is the least privileged class", () => {
  it("ATTACK: a bare request with no Origin and no Sec-Fetch-Site is refused, not trusted", () => {
    const v = checkSameOrigin(headers({}));
    expect(v.ok, "a headerless curl was being classified as the board's own page").toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(403);
    // The refusal has to be actionable: the sanctioned non-browser caller is the operator's own script.
    expect(v.error).toContain("Sec-Fetch-Site");
  });

  it("ATTACK: a legacy/stripped browser's cross-site read gets no lane either", () => {
    // The shape that makes the bare case impossible to trust: a browser that sends neither header (or an
    // intermediary that strips Sec-Fetch-*) produces, for a CROSS-SITE read, exactly the same request as
    // the board's own page. Indistinguishable ⇒ it must fail closed.
    expect(checkSameOrigin(headers({ accept: "image/*" })).ok).toBe(false);
  });

  it("the browser naming ANOTHER site is refused even when no Origin is present", () => {
    // `same-site` is not `same-origin`: http://board.example annotating the https board is a different
    // origin, and with no Origin header the browser's verdict is the only thing that can say so.
    for (const site of ["cross-site", "same-site", "algo-que-nao-conhecemos"]) {
      expect(checkSameOrigin(headers({ "sec-fetch-site": site })).ok, site).toBe(false);
    }
  });

  it("ONE ruler: the JSON variant inherits the same verdict, it does not re-decide it", () => {
    // Two copies of this decision is exactly how one endpoint ended up inverted and the other did not.
    // Same headers ⇒ same verdict on both variants, the JSON one only adding the content-type demand.
    const bags: Record<string, string>[] = [
      {},
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "cross-site" },
      { origin: "https://board.example", host: "board.example" },
      { origin: "https://evil.example", host: "board.example" },
    ];
    for (const bag of bags) {
      const read = checkSameOrigin(headers(bag));
      const json = checkSameOriginJson(headers({ ...bag, "content-type": "application/json" }));
      expect(json.ok, JSON.stringify(bag)).toBe(read.ok);
      if (!read.ok && !json.ok) expect(json.error, JSON.stringify(bag)).toBe(read.error);
    }
  });
});
