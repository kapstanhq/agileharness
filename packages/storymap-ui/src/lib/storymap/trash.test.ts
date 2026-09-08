import { describe, expect, it } from "vitest";
import { coerceTrashManifest, trashAgeDays } from "./trash";

// autonomo-liberdade-humana M2 — the pure core of the soft-delete quarantine: manifest coercion (a broken
// sidecar is never restorable, never a crash) and the ageing decision (what the 7-day GC prunes).

describe("coerceTrashManifest (M2)", () => {
  it("aceita um manifesto de card válido e preserva restorePath", () => {
    const m = coerceTrashManifest({ kind: "card", id: "story-1", by: "agent", at: "2026-07-10T00:00:00Z", restorePath: "/x/cards/story-1.md" });
    expect(m).toMatchObject({ kind: "card", id: "story-1", by: "agent", restorePath: "/x/cards/story-1.md" });
  });

  it("preserva o object + strippedRefs de persona/system", () => {
    const m = coerceTrashManifest({ kind: "persona", id: "p1", by: "human", at: "2026-07-10T00:00:00Z", object: { id: "p1", name: "Ana" }, strippedRefs: ["story-a", "story-b"] });
    expect(m?.object).toEqual({ id: "p1", name: "Ana" });
    expect(m?.strippedRefs).toEqual(["story-a", "story-b"]);
  });

  it("kind inválido ⇒ null (não restaurável, não crash)", () => {
    expect(coerceTrashManifest({ kind: "database", id: "x", at: "2026-07-10T00:00:00Z" })).toBeNull();
  });

  it("id ausente ⇒ null", () => {
    expect(coerceTrashManifest({ kind: "card", at: "2026-07-10T00:00:00Z" })).toBeNull();
  });

  it("não-objeto ⇒ null", () => {
    expect(coerceTrashManifest(null)).toBeNull();
    expect(coerceTrashManifest("nope")).toBeNull();
  });
});

describe("trashAgeDays (M2 — o que o GC de 7 dias decide)", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-07-18T00:00:00Z");

  it("0 dias para agora mesmo", () => {
    expect(trashAgeDays({ at: "2026-07-18T00:00:00Z" }, now)).toBe(0);
  });

  it("conta os dias inteiros decorridos", () => {
    expect(trashAgeDays({ at: new Date(now - 7 * day).toISOString() }, now)).toBe(7);
    expect(trashAgeDays({ at: new Date(now - 6.9 * day).toISOString() }, now)).toBe(6); // ainda dentro da janela
  });

  it("`at` malformado ou futuro ⇒ 0 (fail-safe: nunca coleta cedo)", () => {
    expect(trashAgeDays({ at: "não-é-data" }, now)).toBe(0);
    expect(trashAgeDays({ at: new Date(now + 5 * day).toISOString() }, now)).toBe(0);
  });
});
