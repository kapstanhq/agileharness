// Same-origin / CSRF guard for the feedback broker — EXTRACTED from the intake route so it is
// unit-tested (it was inline + untested) and REUSED verbatim by every feedback endpoint. Two variants
// share ONE origin check so they can't drift:
//   - checkSameOrigin      — reject a request whose initiator is a third party, AND a request that
//                            names no initiator at all. For the read catalog (GET /destinations): a GET
//                            has no body, so no content-type to require; the SAME-ORIGIN POLICY (we
//                            never emit CORS allow headers) is what stops a cross-origin page from
//                            READING the session/card list.
//   - checkSameOriginJson  — the above PLUS require `application/json`. For the mutating POST /intake:
//                            a cross-origin caller can't send that as a "simple" request → it forces a
//                            CORS preflight we never allow. A session-linked batch can paste into a
//                            tmux session, so it must NOT be triggerable cross-origin.
// (Fase 3b adds a board-issued nonce for the legit cross-origin product-app case — until then, both
// endpoints are same-origin board only.)
//
// FAIL-CLOSED ON ABSENCE — the second half of story-14xvpa. What this closes: a request carrying NO
// `Origin` AND NO `Sec-Fetch-Site` used to be classified as our own UI, i.e. the CHEAPEST request
// anyone can make (`curl` with zero headers) was also the most privileged one. `classifyIntake` was
// inverted for the batch endpoint; this guard kept the old fallback while guarding the RECON surface
// (GET /destinations lists live tmux session NAMES — the ?b= attach keys and the paste targets) and
// the screenshot of the operator's screen (GET /shot). Absence of every signal is now the LEAST
// privileged class, never the most: it is also EXACTLY the shape a legacy/header-stripped browser's
// cross-site read has, so it can never be told apart from the board's own page and must fail closed.
// Nothing was exploitable while the login gate stood in front — the point is that the gate was then
// the ONLY thing holding, and the same card plans to make a feedback route reachable without a cookie.
//
// ZERO cost to the sanctioned browser callers, measured against what they actually send: the overlay's
// catalog read is `fetch(..., {credentials:"same-origin"})`, a GET — no `Origin` (the spec omits it for
// GET/HEAD) but ALWAYS `Sec-Fetch-Site: same-origin`; the `<img>` that renders a stored shot sends the
// same; every POST/DELETE `fetch` carries `Origin`. A non-browser caller (the operator's own `curl`)
// keeps the endpoint by SAYING it is one — one header — instead of being handed capability by silence.

/** Anything with header access — `Request.headers` (a `Headers`) satisfies it; tests pass a fake so
 *  they don't hit the forbidden-header quirks of a real `Headers` for "host"/"origin". */
export interface HeaderReader {
  get(name: string): string | null;
}

export type GuardVerdict = { ok: true } | { ok: false; status: number; error: string };

/**
 * What the headers PROVE about who initiated this request — the ONE origin decision of the broker.
 *
 * It exists as a classification, not a boolean, because each endpoint grants a DIFFERENT set of these
 * classes and that policy must be stated once per endpoint, in the open: a mutating batch may demand a
 * real `Origin` (a browser POST always has one), while a GET read cannot demand it without refusing the
 * board's own page. What must NEVER be duplicated is the reading of the signals — the parsing, the host
 * comparison, the browser's veto and the fail-closed on absence. Two copies of that is how one endpoint
 * ended up inverted and the other did not (`classifyIntake` in `embed.ts` still carries its own copy —
 * it should consume this).
 */
export type OriginSignal =
  /** `Origin` present, host equal to `Host`, and the browser does not contradict it — the FULL signal. */
  | "our-origin"
  /** no `Origin`, but the BROWSER itself attests `same-origin` (a header script cannot write). */
  | "browser-attests"
  /** no `Origin`, `Sec-Fetch-Site: none` — user-initiated, so by definition no third-party initiator. */
  | "user-initiated"
  /** the browser says the initiator is ANOTHER site (`cross-site`/`same-site`, or a contradiction). */
  | "other-site"
  /** an `Origin` was presented and it is not ours (different host, unparseable, `null`). */
  | "cross-origin"
  /** NEITHER signal arrived — indistinguishable from a legacy browser's cross-site read. */
  | "no-signal";

/** The two `Sec-Fetch-Site` values compatible with "our own document sent this". */
const SITE_SAME_ORIGIN = "same-origin";
/** User-initiated (address bar, bookmark): there is no initiator document, so no `Origin` either. */
const SITE_NONE = "none";

export function readOriginSignal(headers: HeaderReader): OriginSignal {
  const fetchSite = (headers.get("sec-fetch-site") ?? "").trim().toLowerCase();
  const origin = headers.get("origin");

  if (origin) {
    // The browser is the authority on WHO initiated the request: `Sec-Fetch-Site` is a forbidden header
    // name, so script cannot write it. INSIDE a browser it can therefore only ever VETO the host
    // comparison below, never substitute for it. Any value other than the two compatible with "our own
    // document" is a veto — including `none`, which asserts there was no initiator document at all and
    // so cannot legitimately arrive WITH an `Origin`. Unknown/mangled values veto too (fail-closed: a
    // value we can't read is not a value we can credit).
    if (fetchSite !== "" && fetchSite !== SITE_SAME_ORIGIN) return "other-site";
    try {
      // `Host` carries no scheme, so host equality ALONE would also accept a document served over the
      // OTHER scheme on the same host (http page ⇢ https board) — a same-SITE, cross-ORIGIN caller. That
      // is precisely the case the browser's veto above catches.
      if (new URL(origin).host === (headers.get("host") ?? "")) return "our-origin";
    } catch {
      /* unparseable — includes `Origin: null` (sandboxed iframe / data: document) */
    }
    return "cross-origin";
  }

  if (fetchSite === SITE_SAME_ORIGIN) return "browser-attests";
  if (fetchSite === SITE_NONE) return "user-initiated";
  if (fetchSite !== "") return "other-site";
  return "no-signal";
}

/**
 * Reject a third-party initiator AND a request that names no initiator. No content-type requirement —
 * safe for GET reads, whose legitimate form carries `Sec-Fetch-Site` and no `Origin`.
 */
export function checkSameOrigin(headers: HeaderReader): GuardVerdict {
  const signal = readOriginSignal(headers);
  // `other-site` covers the case an `Origin` check cannot see: the browser reporting a cross-site (or
  // merely same-SITE) initiator when `Origin` is absent or null — sandboxed iframe, data: document.
  if (signal === "other-site") {
    return { ok: false, status: 403, error: "cross-site não permitido (Fase 3b: nonce)" };
  }
  if (signal === "cross-origin") {
    return { ok: false, status: 403, error: "origem cruzada não permitida (Fase 3b: nonce)" };
  }
  if (signal === "no-signal") {
    return {
      ok: false,
      status: 403,
      error: "sem sinal de origem: apresente Origin, ou declare Sec-Fetch-Site se não for um navegador",
    };
  }
  return { ok: true };
}

/** The read guard PLUS an `application/json` requirement — for the mutating POST intake. */
export function checkSameOriginJson(headers: HeaderReader): GuardVerdict {
  const ctype = (headers.get("content-type") ?? "").toLowerCase();
  if (!ctype.includes("application/json")) {
    return { ok: false, status: 415, error: "content-type deve ser application/json" };
  }
  return checkSameOrigin(headers);
}
