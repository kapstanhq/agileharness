// Keystone FREEZE — the AnnotationBatch/link contract routes ONLY by link.kind. This test fails if a
// future "destination picker" feature smuggles a SECOND routing signal into the batch (a
// returnMode/destination/sink field) — the "declared capability with no consumer" anti-pattern the
// schema comment (schema.ts) explicitly rejects. The overlay's batch() output is mirrored here (it is
// a static IIFE that can't be imported) and must validate; any extra field a producer sends is
// STRIPPED by the schema (z.object strips unknown keys by default), so it can never influence routing.

import { describe, expect, it } from "vitest";
import { annotationBatchSchema, coerceAnnotationBatch, linkSchema } from "./schema";

describe("keystone freeze — routing is link.kind-only", () => {
  it("the batch shape is frozen (no second routing field)", () => {
    expect(Object.keys(annotationBatchSchema.shape).sort()).toEqual(
      ["link", "pins", "producedAt", "producer", "v"].sort(),
    );
  });

  it("the link shape is frozen (kind is the ONLY router; board/cardId/sessionId are targets)", () => {
    expect(Object.keys(linkSchema.shape).sort()).toEqual(["board", "cardId", "kind", "sessionId"].sort());
  });

  it("a batch mirroring the overlay's batch() output validates", () => {
    // field-for-field the overlay's batch(): { v, producer, producedAt, link, pins }
    const overlayBatch = {
      v: 1,
      producer: "agileharness-board",
      producedAt: "2026-07-24T00:00:00.000Z",
      link: { kind: "none", board: "storymap" },
      pins: [{ note: "muda isto", kind: "change", anchor: { selector: "main > button" } }],
    };
    expect(coerceAnnotationBatch(overlayBatch).ok).toBe(true);
  });

  it("an extra top-level routing field is STRIPPED — it cannot hijack routing", () => {
    const r = coerceAnnotationBatch({
      link: { board: "storymap" },
      pins: [{ note: "x", anchor: { selector: "#e" } }],
      // would-be second routing signals:
      returnMode: "terminal",
      destination: "session",
    } as unknown);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch as Record<string, unknown>).not.toHaveProperty("returnMode");
    expect(r.batch as Record<string, unknown>).not.toHaveProperty("destination");
  });

  it("an extra field inside link is STRIPPED too", () => {
    const r = coerceAnnotationBatch({
      link: { kind: "none", board: "storymap", sink: "terminal" },
      pins: [{ note: "x", anchor: { selector: "#e" } }],
    } as unknown);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch.link as Record<string, unknown>).not.toHaveProperty("sink");
  });
});
