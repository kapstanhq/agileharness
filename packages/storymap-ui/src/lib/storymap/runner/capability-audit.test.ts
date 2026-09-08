import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Card, Finding } from "@/lib/storymap/types";

// Mock the disk write so the audit's dispatch + finding transform are testable without a real board.
vi.mock("@/lib/storymap/write", () => ({ updateCardOnDisk: vi.fn(async () => {}) }));
import { updateCardOnDisk } from "@/lib/storymap/write";
import { registerCapabilityAudit } from "./capability-audit";
import {
  routeUndersizedFindingId,
  toolingUnusedFindingId,
  withRouteUndersizedFinding,
  withRouteUndersizedResolved,
  withToolingUnusedFinding,
  withToolingUnusedResolved,
} from "./findings";

const mockUpdate = updateCardOnDisk as unknown as ReturnType<typeof vi.fn>;
const card = (findings: Finding[] = []): Card => ({ findings } as Card);
const flush = () => new Promise((r) => setTimeout(r, 0));

type Handler = (ev: { board: string; cardId: string; trigger: string; toolGap?: string[] }) => void;
function fakeEngine() {
  let handler: Handler = () => {};
  return {
    onComplete: (fn: Handler) => {
      handler = fn;
      return () => {};
    },
    fire: (ev: Parameters<Handler>[0]) => handler(ev),
  };
}

describe("registerCapabilityAudit — dispatch by toolGap (WS3 F2)", () => {
  beforeEach(() => mockUpdate.mockClear());

  // harness-review is NOT a route-audited trigger, so these stay a single write (route audit fires only on
  // harness-plan/harness-do — see the dedicated block below).
  it("STAMPS a soft advisory when a success left a non-empty toolGap", async () => {
    const eng = fakeEngine();
    registerCapabilityAudit(eng);
    eng.fire({ board: "nimbus", cardId: "story-1", trigger: "harness-review", toolGap: ["codegraph"] });
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [board, cardId, updater] = mockUpdate.mock.calls[0];
    expect(board).toBe("nimbus");
    expect(cardId).toBe("story-1");
    const out = (updater as (c: Card) => Card)(card());
    const f = out.findings!.find((x) => x.id === toolingUnusedFindingId("harness-review"))!;
    expect(f.severity).toBe("low"); // SOFT — never a blocker
    expect(f.lens).toBe("general");
    expect(f.title).toContain("codegraph");
  });

  it("CLEARS a prior advisory when a success left an EMPTY toolGap (tool used this time)", async () => {
    const eng = fakeEngine();
    registerCapabilityAudit(eng);
    eng.fire({ board: "nimbus", cardId: "story-1", trigger: "harness-review", toolGap: [] });
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const updater = mockUpdate.mock.calls[0][2] as (c: Card) => Card | null;
    // with an open advisory → flips to fixed
    const withOpen = card([{ id: toolingUnusedFindingId("harness-review"), lens: "general", severity: "low", title: "t", status: "open" }]);
    expect(updater(withOpen)!.findings!.find((f) => f.id === toolingUnusedFindingId("harness-review"))!.status).toBe("fixed");
    // with nothing open → returns null so the IO layer SKIPS the write (no loop)
    expect(updater(card())).toBeNull();
  });

  it("IGNORES a non-success emit (undefined toolGap) — no write", async () => {
    const eng = fakeEngine();
    registerCapabilityAudit(eng);
    eng.fire({ board: "nimbus", cardId: "story-1", trigger: "harness-do" });
    await flush();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("clears only the SAME step's advisory — a different trigger is untouched", async () => {
    const other: Finding = { id: toolingUnusedFindingId("harness-review"), lens: "general", severity: "low", title: "t", status: "open" };
    expect(withToolingUnusedResolved([other], "harness-plan")).toBeNull(); // harness-plan clear leaves harness-review alone
  });
});

describe("withToolingUnusedFinding — pure transform", () => {
  it("upserts a per-step advisory idempotently (refresh, not stack)", () => {
    const a = withToolingUnusedFinding([], "harness-plan", ["codegraph"], "Plano técnico");
    const b = withToolingUnusedFinding(a, "harness-plan", ["codegraph"], "Plano técnico");
    expect(b.filter((f) => f.id === toolingUnusedFindingId("harness-plan"))).toHaveLength(1);
    expect(b[0].title).toContain('"Plano técnico"');
    expect(b[0].severity).toBe("low");
  });
});

describe("registerCapabilityAudit — route-undersizing audit (WS4 furo #1)", () => {
  beforeEach(() => mockUpdate.mockClear());
  const routeCard = (over: Partial<Card>): Card => ({ findings: [], ...over } as Card);

  it("runs the route audit AFTER a harness-plan success (2nd write); STAMPS when UI-surface + skipped design", async () => {
    const eng = fakeEngine();
    registerCapabilityAudit(eng);
    eng.fire({ board: "nimbus", cardId: "story-1", trigger: "harness-plan", toolGap: [] });
    await flush();
    // call[0] = tooling clear; call[1] = route audit
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    const routeUpdater = mockUpdate.mock.calls[1][2] as (c: Card) => Card | null;
    const c = routeCard({ hasUiSurface: true, routing: { skips: ["design-ux"], decidedBy: "agent", decidedAt: "2026-07-10" } });
    const out = routeUpdater(c)!;
    const f = out.findings!.find((x) => x.id === routeUndersizedFindingId())!;
    expect(f.severity).toBe("medium"); // non-blocking advisory
    expect(f.lens).toBe("general");
    expect(f.title).toContain("design-ux");
  });

  it("does NOT run the route audit for a non-plan/dev trigger (harness-review → single write)", async () => {
    const eng = fakeEngine();
    registerCapabilityAudit(eng);
    eng.fire({ board: "nimbus", cardId: "story-1", trigger: "harness-review", toolGap: [] });
    await flush();
    expect(mockUpdate).toHaveBeenCalledTimes(1); // tooling only, no route audit
  });

  it("the route updater CLEARS a prior advisory when the card is no longer undersized (else null)", async () => {
    const eng = fakeEngine();
    registerCapabilityAudit(eng);
    eng.fire({ board: "nimbus", cardId: "story-1", trigger: "harness-do", toolGap: [] });
    await flush();
    const routeUpdater = mockUpdate.mock.calls[1][2] as (c: Card) => Card | null;
    // no UI surface → not undersized; a prior open advisory flips to fixed
    const withOpen = routeCard({ hasUiSurface: false, findings: [{ id: routeUndersizedFindingId(), lens: "general", severity: "medium", title: "t", status: "open" }] });
    expect(routeUpdater(withOpen)!.findings!.find((f) => f.id === routeUndersizedFindingId())!.status).toBe("fixed");
    // nothing open → null (skip write)
    expect(routeUpdater(routeCard({ hasUiSurface: false }))).toBeNull();
  });
});

describe("withRouteUndersizedFinding — pure transform", () => {
  it("upserts one medium/general advisory naming the skipped design steps", () => {
    const a = withRouteUndersizedFinding([], ["design-ux", "design-ui"]);
    const b = withRouteUndersizedFinding(a, ["design-ux", "design-ui"]);
    expect(b.filter((f) => f.id === routeUndersizedFindingId())).toHaveLength(1); // idempotent
    expect(b[0].severity).toBe("medium");
    expect(b[0].lens).toBe("general");
    expect(b[0].title).toContain("design-ux");
  });
  it("resolve returns null when nothing is open (skip write)", () => {
    expect(withRouteUndersizedResolved([])).toBeNull();
  });
});
