import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { coerceCard } from "./repo";
import { cardToFrontmatter } from "./write";
import {
  groupDeliveryByNode,
  isBackboneStory,
  isContainerCard,
  isDeliveryStory,
  isLegacyOrphan,
  isPlacementDebt,
  isUnplacedStory,
  needsPlacement,
  servesTarget,
  shouldBeUnplaced,
} from "./unplaced";
import type { Card } from "./types";

// SM-02 — gate de hierarquia: impedir story órfã (parent null) no commit.
// Pinned here: the pure classifiers (the soft-gate decision + the two render
// buckets) and that the sparse `unplaced` flag survives the REAL serialization
// path (matter.stringify -> matter -> coerceCard) without touching the watched
// storymap/boards dir. Mirrors round-trip.test.ts.

const card = (data: Record<string, unknown>): Card => coerceCard("c", { type: "story", ...data }, "");

function roundTrip(c: Card): Card {
  const fm = cardToFrontmatter(c);
  const file = matter.stringify(`\n${(c.body ?? "").trim()}\n`, fm);
  const { data, content } = matter(file);
  return coerceCard(c.id, data as Record<string, unknown>, content);
}

describe("shouldBeUnplaced — the creation-time soft gate", () => {
  it("flags a parentless story", () => {
    expect(shouldBeUnplaced("story", null)).toBe(true);
  });
  it("does NOT flag a story that has a parent", () => {
    expect(shouldBeUnplaced("story", "step-1")).toBe(false);
  });
  it("does NOT flag parentless backbone roots (activity/step are valid roots)", () => {
    expect(shouldBeUnplaced("activity", null)).toBe(false);
    expect(shouldBeUnplaced("step", null)).toBe(false);
  });
});

describe("isUnplacedStory — the Backlog não-mapeado lane bucket (AC1/AC2)", () => {
  it("is true for an unplaced, parentless story", () => {
    expect(isUnplacedStory(card({ unplaced: true, parent: null }))).toBe(true);
  });
  it("is false once the story gains a parent (stale flag never double-renders)", () => {
    expect(isUnplacedStory(card({ unplaced: true, parent: "step-1" }))).toBe(false);
  });
  it("is false for a normal mapped story", () => {
    expect(isUnplacedStory(card({ parent: "step-1" }))).toBe(false);
  });
});

describe("isLegacyOrphan — parentless story WITHOUT the flag (AC3)", () => {
  it("is true for a legacy orphan (parent null, no unplaced flag)", () => {
    expect(isLegacyOrphan(card({ parent: null }))).toBe(true);
  });
  it("is false for an intentionally unplaced story (it has the flag)", () => {
    expect(isLegacyOrphan(card({ parent: null, unplaced: true }))).toBe(false);
  });
  it("is false for a parented story", () => {
    expect(isLegacyOrphan(card({ parent: "step-1" }))).toBe(false);
  });
  it("is false for a parentless DELIVERY story rescued by a serves override (attributed on a shelf)", () => {
    expect(isLegacyOrphan(card({ storyType: "bug", parent: null, serves: "story-x" }))).toBe(false);
  });
  it("is true for a parentless delivery story with NO serves (truly unattributed)", () => {
    expect(isLegacyOrphan(card({ storyType: "technical", parent: null }))).toBe(true);
  });
});

describe("isBackboneStory — only user-facing stories belong on the map", () => {
  it("is true for a user story", () => {
    expect(isBackboneStory(card({ storyType: "user", parent: "step-1" }))).toBe(true);
  });
  it("defaults legacy/untyped stories to user (coerceCard) → on the map", () => {
    expect(isBackboneStory(card({ parent: "step-1" }))).toBe(true);
  });
  it("is false for delivery work (technical/bug/chore/spike) — those live in the Kanban", () => {
    for (const t of ["technical", "bug", "chore", "spike"] as const) {
      expect(isBackboneStory(card({ storyType: t, parent: "step-1" }))).toBe(false);
    }
  });
  it("is false for activities/steps (backbone roots, not stories)", () => {
    expect(isBackboneStory(coerceCard("a", { type: "activity" }, ""))).toBe(false);
    expect(isBackboneStory(coerceCard("s", { type: "step" }, ""))).toBe(false);
  });
});

describe("isDeliveryStory — delivery work (the inverse of backbone over stories)", () => {
  it("is true for technical/bug/chore/spike stories", () => {
    for (const t of ["technical", "bug", "chore", "spike"] as const) {
      expect(isDeliveryStory(card({ storyType: t, parent: "step-1" }))).toBe(true);
    }
  });
  it("is false for a user story (it's backbone, not delivery)", () => {
    expect(isDeliveryStory(card({ storyType: "user", parent: "step-1" }))).toBe(false);
  });
  it("is false for activities/steps", () => {
    expect(isDeliveryStory(coerceCard("a", { type: "activity" }, ""))).toBe(false);
    expect(isDeliveryStory(coerceCard("s", { type: "step" }, ""))).toBe(false);
  });
  it("is the exact inverse of isBackboneStory over stories", () => {
    for (const t of ["user", "technical", "bug", "chore", "spike"] as const) {
      const c = card({ storyType: t, parent: "step-1" });
      expect(isBackboneStory(c)).toBe(!isDeliveryStory(c));
    }
  });
});

describe("servesTarget — effective attribution (serves overrides parent)", () => {
  it("uses explicit serves when set", () => {
    expect(servesTarget(card({ storyType: "technical", parent: "step-1", serves: "step-9" }))).toBe("step-9");
  });
  it("falls back to parent when serves is absent (the 100%-covered case)", () => {
    expect(servesTarget(card({ storyType: "bug", parent: "step-1" }))).toBe("step-1");
  });
  it("is null for a user story (backbone, never on a shelf)", () => {
    expect(servesTarget(card({ storyType: "user", parent: "step-1", serves: "step-9" }))).toBeNull();
  });
  it("is null for activities/steps", () => {
    expect(servesTarget(coerceCard("a", { type: "activity" }, ""))).toBeNull();
    expect(servesTarget(coerceCard("s", { type: "step" }, ""))).toBeNull();
  });
  it("is null for an unattributed delivery story (no serves, no parent)", () => {
    expect(servesTarget(card({ storyType: "technical", parent: null }))).toBeNull();
  });
});

describe("needsPlacement (4.3) — mirrors the hasPlacement gate exactly", () => {
  it("is true for a story with no parent, no serves, no ack", () => {
    expect(needsPlacement(card({ parent: null }))).toBe(true);
  });
  it("is false once a parent is set", () => {
    expect(needsPlacement(card({ parent: "step-1" }))).toBe(false);
  });
  it("is false for a delivery story attributed via serves", () => {
    expect(needsPlacement(card({ storyType: "technical", parent: null, serves: "story-x" }))).toBe(false);
  });
  it("is false once unplacedAck is present (any `by`)", () => {
    expect(needsPlacement(card({ parent: null, unplacedAck: { by: "human", at: "2026-07-10" } }))).toBe(false);
    expect(needsPlacement(card({ parent: null, unplacedAck: { by: "system:parent-dropped", at: "2026-07-10" } }))).toBe(false);
  });
  it("treats a whitespace parent as absent (nonEmpty semantics, same as the gate)", () => {
    // coerceCard normalizes, but the predicate must also hold for a raw ''/whitespace parent
    expect(needsPlacement({ ...card({ parent: null }), parent: "  " as unknown as string })).toBe(true);
  });
  it("is false for non-stories (activity/step are valid parentless roots)", () => {
    expect(needsPlacement(coerceCard("a", { type: "activity" }, ""))).toBe(false);
    expect(needsPlacement(coerceCard("s", { type: "step" }, ""))).toBe(false);
  });
  it("diverges from isLegacyOrphan on an ACKNOWLEDGED unplaced story (gate satisfied, still map-invisible)", () => {
    const acked = card({ parent: null, unplaced: true, unplacedAck: { by: "human", at: "2026-07-10" } });
    expect(needsPlacement(acked)).toBe(false); // gate passes
    // isLegacyOrphan ignores the ack (requires unplaced!==true) → false here (unplaced:true), so no double signal
    expect(isLegacyOrphan(acked)).toBe(false);
  });
});

describe("unplaced serialization round-trip (real gray-matter + js-yaml)", () => {
  it("preserves unplaced:true through the real YAML path", () => {
    const back = roundTrip(card({ status: "triage", parent: null, unplaced: true }));
    expect(back.unplaced).toBe(true);
    expect(isUnplacedStory(back)).toBe(true);
  });

  it("stays LEAN: omits `unplaced` from frontmatter when the story is mapped", () => {
    const fm = cardToFrontmatter(card({ parent: "step-1" }));
    expect(fm).not.toHaveProperty("unplaced");
  });

  it("a legacy orphan (parent null, no flag) reads back without unplaced (AC3, no migration)", () => {
    const raw = "---\nid: c\ntype: story\nstatus: enriquecer\nparent: null\n---\ncorpo";
    const { data, content } = matter(raw);
    const c = coerceCard("c", data as Record<string, unknown>, content);
    expect(c.unplaced).toBeUndefined();
    expect(isLegacyOrphan(c)).toBe(true);
  });
});

describe("groupDeliveryByNode — delivery tickets attach to their served STEP or user story", () => {
  const withId = (id: string, data: Record<string, unknown>): Card =>
    coerceCard(id, { type: "story", ...data }, "");

  // A small dual-track backbone: an activity, a step under it, and a user story on the step.
  const nodes: Card[] = [
    coerceCard("act-1", { type: "activity" }, ""),
    coerceCard("step-feed", { type: "step", parent: "act-1" }, ""),
    withId("story-us", { storyType: "user", parent: "step-feed" }),
  ];

  it("attaches a bug that serves a STEP (parent: step-*, no serves) to that step — the reported case", () => {
    const bug = withId("bug-1", { storyType: "bug", parent: "step-feed", mode: "fix" });
    const m = groupDeliveryByNode([...nodes, bug]);
    expect(m.get("step-feed")?.map((c) => c.id)).toEqual(["bug-1"]);
  });

  it("attaches a delivery ticket that serves a USER story (explicit serves) to that story", () => {
    const tech = withId("tech-1", { storyType: "technical", serves: "story-us", parent: "step-feed" });
    const m = groupDeliveryByNode([...nodes, tech]);
    // serves overrides parent — it hangs off the user story, not the step
    expect(m.get("story-us")?.map((c) => c.id)).toEqual(["tech-1"]);
    expect(m.has("step-feed")).toBe(false);
  });

  it("does NOT attach a user (backbone) story — only delivery types are shelved", () => {
    const m = groupDeliveryByNode(nodes);
    expect(m.size).toBe(0);
  });

  it("skips a delivery ticket with no served node (orphan) — the Kanban is its home", () => {
    const orphan = withId("orphan", { storyType: "bug", parent: null });
    const m = groupDeliveryByNode([...nodes, orphan]);
    expect(m.size).toBe(0);
  });

  it("skips a ticket whose served target does not exist", () => {
    const dangling = withId("dangling", { storyType: "bug", parent: "step-ghost" });
    const m = groupDeliveryByNode([...nodes, dangling]);
    expect(m.size).toBe(0);
  });

  it("honours the keep filter (board view filter)", () => {
    const a = withId("bug-a", { storyType: "bug", parent: "step-feed", release: "r1" });
    const b = withId("bug-b", { storyType: "bug", parent: "step-feed", release: "r2" });
    const m = groupDeliveryByNode([...nodes, a, b], (c) => c.release === "r1");
    expect(m.get("step-feed")?.map((c) => c.id)).toEqual(["bug-a"]);
  });
});

describe("isContainerCard — ephemeral capture/style containers", () => {
  it("flags a capture container", () => {
    expect(isContainerCard(card({ capture: true }))).toBe(true);
  });
  it("flags a style-guide container", () => {
    expect(isContainerCard(card({ container: "style" }))).toBe(true);
  });
  it("does NOT flag a normal story", () => {
    expect(isContainerCard(card({ parent: "step-1" }))).toBe(false);
  });
});

describe("isPlacementDebt — WS6 lint scope (exempts containers + terminals + staging)", () => {
  const terminals = new Set(["concluida", "arquivados", "capturado"]);
  const staging = new Set(["triage"]);
  const noStaging = new Set<string>();
  const orphan = (extra: Record<string, unknown>) =>
    card({ parent: null, serves: null, ...extra });

  it("a LIVE orphan story (no parent/serves/ack, non-terminal, non-staging) IS debt", () => {
    expect(isPlacementDebt(orphan({ status: "desenvolver" }), terminals, staging)).toBe(true);
  });

  it("an ephemeral CAPTURE container orphan is NOT debt (the reported false positive)", () => {
    expect(isPlacementDebt(orphan({ status: "capturado", capture: true }), terminals, staging)).toBe(false);
  });

  it("an ephemeral STYLE container orphan is NOT debt", () => {
    expect(isPlacementDebt(orphan({ status: "arquivados", container: "style" }), terminals, staging)).toBe(false);
  });

  it("a TERMINAL orphan (shipped/archived) is NOT debt — placement is moot", () => {
    expect(isPlacementDebt(orphan({ status: "concluida" }), terminals, staging)).toBe(false);
  });

  it("a STAGING orphan (the un-triaged Triagem inbox) is NOT debt — pre-map by design", () => {
    // The reported gate-blocker: an intake card resting in `triage` (staging) has no place YET — that is
    // exactly what triage decides — so it must NOT count as placement debt and fail-close the merge gate.
    expect(isPlacementDebt(orphan({ status: "triage" }), terminals, staging)).toBe(false);
    // ...but on a board that does NOT declare that status as staging, it stays debt (forward-safe).
    expect(isPlacementDebt(orphan({ status: "triage" }), terminals, noStaging)).toBe(true);
  });

  it("a placed story (has parent) is NOT debt", () => {
    expect(isPlacementDebt(card({ parent: "step-1", status: "desenvolver" }), terminals, staging)).toBe(false);
  });

  it("an acknowledged orphan (unplacedAck) is NOT debt", () => {
    expect(
      isPlacementDebt(
        orphan({ status: "desenvolver", unplacedAck: { by: "mcp", at: "2026-01-01" } }),
        terminals,
        staging,
      ),
    ).toBe(false);
  });

  it("a live orphan with an UNKNOWN (non-terminal, non-staging) status is still debt (forward-safe)", () => {
    expect(isPlacementDebt(orphan({ status: "some-future-status" }), terminals, staging)).toBe(true);
  });
});
