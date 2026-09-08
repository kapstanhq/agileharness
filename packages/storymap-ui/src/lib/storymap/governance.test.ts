import { describe, expect, it } from "vitest";
import { applyGovernanceChange, coerceGovernanceDraft, draftTitle, governanceConflicts } from "./governance";
import type { BoardConfig, GovernanceDraft } from "./types";

const baseConfig = (): BoardConfig => ({
  id: "b",
  name: "B",
  statuses: [],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  desiredOutcome: "old desiredOutcome",
  // O canvas agora guarda ITENS. O kernel de governança é agnóstico de forma (before/after: unknown) —
  // então o fixture usa a forma REAL, provando que um valor estruturado atravessa apply/conflicts.
  canvas: { problem: { items: [{ id: "i1", text: "old canvas value" }] } },
});

describe("coerceGovernanceDraft — tolerant, never throws", () => {
  it("returns a valid draft from a well-formed payload", () => {
    const raw = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "enriquecer story-tihd9l",
      changes: [{ artifact: "desiredOutcome", field: null, before: "old", after: "new" }],
      createdAt: "2026-06-15",
    };
    const d = coerceGovernanceDraft("d1", raw);
    expect(d.id).toBe("d1");
    expect(d.board).toBe("storymap");
    expect(d.status).toBe("pending");
    expect(d.reason).toBe("enriquecer story-tihd9l");
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].artifact).toBe("desiredOutcome");
  });

  it("defaults status to 'pending' for unknown status values", () => {
    const d = coerceGovernanceDraft("dx", { status: "unknown-garbage", changes: [] });
    expect(d.status).toBe("pending");
  });

  it("drops changes with invalid artifact", () => {
    const d = coerceGovernanceDraft("dx", {
      changes: [{ artifact: "invalid-field", before: "a", after: "b" }, { artifact: "personas", after: [] }],
    });
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].artifact).toBe("personas");
  });

  it("returns empty changes for non-array changes field", () => {
    const d = coerceGovernanceDraft("dx", { changes: "not-an-array" });
    expect(d.changes).toEqual([]);
  });

  it("handles entirely missing/null raw input", () => {
    const d = coerceGovernanceDraft("dx", null);
    expect(d.id).toBe("dx");
    expect(d.status).toBe("pending");
    expect(d.changes).toEqual([]);
  });

  it("coerces origin when present", () => {
    const d = coerceGovernanceDraft("dx", {
      changes: [],
      origin: { skill: "harness-enrich", cardId: "story-abc" },
    });
    expect(d.origin).toEqual({ skill: "harness-enrich", cardId: "story-abc" });
  });
});

describe("applyGovernanceChange — pure, does NOT mutate config", () => {
  it("sets the artifact directly when field is null", () => {
    const cfg = baseConfig();
    const result = applyGovernanceChange(cfg, {
      artifact: "desiredOutcome",
      field: null,
      before: "old desiredOutcome",
      after: "new desiredOutcome",
    });
    expect(result.desiredOutcome).toBe("new desiredOutcome");
    expect(cfg.desiredOutcome).toBe("old desiredOutcome"); // original untouched
  });

  it("deep-sets one canvas BLOCK (a structured value) within the artifact", () => {
    const cfg = baseConfig();
    const after = { items: [{ id: "i1", text: "new canvas value", tags: ["seg"] }] };
    const result = applyGovernanceChange(cfg, {
      artifact: "canvas",
      field: "problem",
      before: cfg.canvas?.problem,
      after,
    });
    expect(result.canvas?.problem).toEqual(after);
    // original untouched (o apply clona — nunca muta o config que recebeu)
    expect(cfg.canvas?.problem).toEqual({ items: [{ id: "i1", text: "old canvas value" }] });
  });

  it("replaces the personas array when artifact=personas field=null", () => {
    const cfg = baseConfig();
    const newPersonas = [{ id: "p1", name: "Operador" }];
    const result = applyGovernanceChange(cfg, { artifact: "personas", field: null, before: [], after: newPersonas });
    expect(result.personas).toEqual(newPersonas);
    expect(cfg.personas).toEqual([]); // original untouched
  });

  it("handles a field set on an EMPTY artifact (first fill creates the object)", () => {
    const cfg = { ...baseConfig(), canvas: null };
    const after = { items: [{ id: "i1", text: "first value" }] };
    const result = applyGovernanceChange(cfg, { artifact: "canvas", field: "problem", before: null, after });
    expect(result.canvas?.problem).toEqual(after);
  });
});

describe("governanceConflicts — detects before != canonical", () => {
  it("returns empty array when all before values match canonical", () => {
    const draft: GovernanceDraft = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "test",
      changes: [
        { artifact: "desiredOutcome", field: null, before: "old desiredOutcome", after: "new" },
        {
          artifact: "canvas",
          field: "problem",
          before: { items: [{ id: "i1", text: "old canvas value" }] },
          after: { items: [{ id: "i1", text: "new" }] },
        },
      ],
      createdAt: "2026-06-15",
    };
    const conflicts = governanceConflicts(draft, baseConfig());
    expect(conflicts).toEqual([]);
  });

  it("returns conflict label when top-level artifact diverged", () => {
    const draft: GovernanceDraft = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "test",
      changes: [{ artifact: "desiredOutcome", field: null, before: "STALE-snapshot", after: "new" }],
      createdAt: "2026-06-15",
    };
    const conflicts = governanceConflicts(draft, baseConfig());
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("desiredOutcome");
  });

  it("returns conflict label when nested field diverged", () => {
    const draft: GovernanceDraft = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "test",
      changes: [{ artifact: "canvas", field: "problem", before: "STALE", after: "new" }],
      createdAt: "2026-06-15",
    };
    const conflicts = governanceConflicts(draft, baseConfig());
    expect(conflicts).toHaveLength(1);
  });

  it("uses the change label as the conflict identifier when present", () => {
    const draft: GovernanceDraft = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "test",
      changes: [{ artifact: "desiredOutcome", field: null, label: "desiredOutcome", before: "STALE", after: "new" }],
      createdAt: "2026-06-15",
    };
    const [conflict] = governanceConflicts(draft, baseConfig());
    expect(conflict).toBe("desiredOutcome");
  });
});

describe("draftTitle — readable label from artifact list", () => {
  it("returns artifact name for a single-artifact draft", () => {
    const draft: GovernanceDraft = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "test",
      changes: [{ artifact: "desiredOutcome", field: null, before: "a", after: "b" }],
      createdAt: "2026-06-15",
    };
    expect(draftTitle(draft)).toBe("desiredOutcome");
  });

  it("joins multiple artifact labels with ' + '", () => {
    const draft: GovernanceDraft = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "test",
      changes: [
        { artifact: "desiredOutcome", field: null, before: "a", after: "b" },
        { artifact: "canvas", field: "propositionValue", before: "c", after: "d" },
      ],
      createdAt: "2026-06-15",
    };
    expect(draftTitle(draft)).toBe("desiredOutcome + canvas.propositionValue");
  });

  it("deduplicates repeated artifacts", () => {
    const draft: GovernanceDraft = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "test",
      changes: [
        { artifact: "desiredOutcome", field: null, before: "a", after: "b" },
        { artifact: "desiredOutcome", field: null, before: "a", after: "c" },
      ],
      createdAt: "2026-06-15",
    };
    expect(draftTitle(draft)).toBe("desiredOutcome");
  });

  it("returns 'proposta' for an empty changes array", () => {
    const draft: GovernanceDraft = {
      id: "d1",
      board: "storymap",
      status: "pending",
      reason: "test",
      changes: [],
      createdAt: "2026-06-15",
    };
    expect(draftTitle(draft)).toBe("proposta");
  });
});
