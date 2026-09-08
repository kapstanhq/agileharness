// F6 — behavioural freeze of the INGEST (relay) lane, driven through the REAL route handler with the
// board-writing collaborators mocked. The unit tests next door pin each piece; this pins the WIRING,
// which is where the danger lives: a relay carries no Origin, so any refactor that stops honouring the
// token silently promotes it to the same-origin lane — full capability, including the paste into a
// live Claude session. Nothing here may be provable by grep; every assertion runs the handler.
//
// Why mocks: the triage sink calls the real reportIssue action, which spawns an LLM triage agent and
// writes board data. The mocks replace exactly that boundary — the lane classification, the collapse
// and the sink selection under test are the genuine code paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions", () => ({
  reportIssueAction: vi.fn(async () => ({ ok: true, data: { card: { id: "story-relay" } } })),
  refineCardAction: vi.fn(async () => ({ ok: true, data: { card: { id: "story-refine" } } })),
}));
vi.mock("@/lib/vps/tmux", () => ({ sendToClaudeSession: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/vps/kill-guard", () => ({ isMasterSession: vi.fn(() => false) }));

const APP_TOKEN = "token-de-repasse-do-app-0001";
const OTHER_TOKEN = "token-de-repasse-de-outro-app-2";

/** A batch that ASKS for the paste-into-a-session route and names a board of its choosing — i.e. the
 *  most privileged thing a hostile payload could request. Schema-VALID, so it reaches the collapse. */
function greedyBatch() {
  return JSON.stringify({
    v: 1,
    producer: "test",
    link: { kind: "session", board: "storymap", cardId: "story-alheio", sessionId: "claude-jonatas" },
    pins: [{ note: "o botão some no mobile", kind: "change", anchor: { selector: "main > button" } }],
  });
}

async function post(headers: Record<string, string>, body: string = greedyBatch()) {
  const { POST } = await import("@/app/api/feedback/intake/route");
  return POST(
    new Request("http://board.local/api/feedback/intake", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STORYMAP_FEEDBACK_INGEST_TOKENS = `acme:${APP_TOKEN},storymap:${OTHER_TOKEN}`;
});
afterEach(() => {
  delete process.env.STORYMAP_FEEDBACK_INGEST_TOKENS;
});

describe("ingest lane — a relayed batch is TRIAGE-ONLY, in the token's board", () => {
  it("files to triage even though the payload asked for a tmux session", async () => {
    const res = await post({ "x-ah-ingest": APP_TOKEN });
    expect(res.status).toBe(200);

    const { sendToClaudeSession } = await import("@/lib/vps/tmux");
    const { reportIssueAction, refineCardAction } = await import("@/app/actions");
    expect(sendToClaudeSession).not.toHaveBeenCalled(); // the paste path is unreachable from a relay
    expect(refineCardAction).not.toHaveBeenCalled(); // nor reopening someone else's card by id
    expect(reportIssueAction).toHaveBeenCalledTimes(1);
  });

  it("uses the board bound to the TOKEN, not the one in the payload", async () => {
    await post({ "x-ah-ingest": APP_TOKEN });
    const { reportIssueAction } = await import("@/app/actions");
    expect(vi.mocked(reportIssueAction).mock.calls[0][0].boardId).toBe("acme");
  });

  it("a second token reaches only ITS board", async () => {
    await post({ "x-ah-ingest": OTHER_TOKEN });
    const { reportIssueAction } = await import("@/app/actions");
    expect(vi.mocked(reportIssueAction).mock.calls[0][0].boardId).toBe("storymap");
  });

  it("an INVALID token is refused 401 and nothing is written", async () => {
    const res = await post({ "x-ah-ingest": "token-invalido-porem-longo-o-bastante" });
    expect(res.status).toBe(401);
    const { reportIssueAction } = await import("@/app/actions");
    expect(reportIssueAction).not.toHaveBeenCalled();
  });

  it("with the lane OFF the very same request is refused (not silently promoted to same-origin)", async () => {
    delete process.env.STORYMAP_FEEDBACK_INGEST_TOKENS;
    const res = await post({ "x-ah-ingest": APP_TOKEN });
    expect(res.status).toBe(401);
    const { reportIssueAction } = await import("@/app/actions");
    expect(reportIssueAction).not.toHaveBeenCalled();
  });

  it("never emits a CORS header — a relay is server-to-server, a browser must not reach it", async () => {
    const res = await post({ "x-ah-ingest": APP_TOKEN });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  // THE ATTACK, end to end: the very same greedy batch, posted by `curl` with no Origin, no
  // Sec-Fetch-Site and no token — the cheapest request in existence. It used to BE the same-origin
  // lane, so it came back 200 with the paste already delivered into a live Claude session. Whoever
  // opens this route to make the relay lane work would have handed that to an anonymous POST, which is
  // why the classifier must refuse absence of signal instead of trusting it. The terminal knob is ON
  // here on purpose: the refusal has to hold even with the riskiest sink armed.
  it("a headerless POST reaches NO sink — no paste into a live Claude, no card, no reopen", async () => {
    process.env.STORYMAP_FEEDBACK_TERMINAL = "1";
    try {
      const res = await post({});
      expect(res.status).toBe(403);
      const { sendToClaudeSession } = await import("@/lib/vps/tmux");
      const { reportIssueAction, refineCardAction } = await import("@/app/actions");
      expect(sendToClaudeSession).not.toHaveBeenCalled();
      expect(reportIssueAction).not.toHaveBeenCalled();
      expect(refineCardAction).not.toHaveBeenCalled();
    } finally {
      delete process.env.STORYMAP_FEEDBACK_TERMINAL;
    }
  });

  // The contrast the token exists to create, now measured against the REAL board UI (a fetch POST
  // always carries Origin): full capability is untouched — the operator's own overlay still pastes
  // into a live session. The relay's downgrade is what the token buys; nothing was taken from the board.
  it("contrast: the same batch from the board's own UI keeps full capability, paste included", async () => {
    process.env.STORYMAP_FEEDBACK_TERMINAL = "1"; // the paste path's own opt-in, off by default
    try {
      const res = await post({ origin: "http://board.local", host: "board.local", "sec-fetch-site": "same-origin" });
      expect(res.status).toBe(200);
      const { sendToClaudeSession } = await import("@/lib/vps/tmux");
      expect(sendToClaudeSession).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.STORYMAP_FEEDBACK_TERMINAL;
    }
  });
});

describe("ingest lane — bounded", () => {
  it("refuses with 429 once the per-board ceiling is hit, and says when to retry", async () => {
    // A board of its own so the shared in-process limiter can't leak this into another test.
    process.env.STORYMAP_FEEDBACK_INGEST_TOKENS = `limite:${APP_TOKEN}`;
    let last: Response | null = null;
    for (let i = 0; i < 40; i++) {
      last = await post({ "x-ah-ingest": APP_TOKEN });
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
