import { describe, expect, it } from "vitest";
import { pinCardId, randomCardId } from "./id";
import { coerceCard } from "./repo";
import type { Card } from "./types";

const story = (id: string, extra: Record<string, unknown> = {}): Card =>
  coerceCard(id, { type: "story", title: "x", ...extra }, "");

// The bug (card-id-immutability): a captured hash id (story-wagi3p) was rewritten by
// harness-enrich into a title slug (story-mcp-enfileiramento-lote-dependencias), breaking
// parent/links references and run-branch tracking. The actor that mutated was the SKILL
// (an LLM), not a pure function — so the deterministic repro is the IMMUTABILITY CONTRACT
// in code: no transformation may change a card's id. `pinCardId` enforces it at the single
// mutation choke point (updateCardOnDisk). Before the fix this test fails because
// `pinCardId` does not exist and nothing in code freezes the id.
describe("card id immutability contract (the card-id-immutability fix)", () => {
  it("pins a transformed card back to its capture id (enrich must NOT rename to a slug)", () => {
    const captured = story("story-wagi3p");
    // Exactly what harness-enrich USED to do: rewrite the id to a slug of the refined title.
    const renamed: Card = { ...captured, id: "story-mcp-enfileiramento-lote-dependencias", title: "MCP…" };
    expect(pinCardId(renamed, captured.id).id).toBe("story-wagi3p");
  });

  it("is a no-op (same reference) when the id already matches — a stable id stays stable", () => {
    const c = story("story-abc123");
    expect(pinCardId(c, "story-abc123")).toBe(c);
  });

  it("freezes an EXISTING slug id too — no retroactive rebatism to a hash (compat/migração)", () => {
    const slug = story("story-fila-de-merge-serial");
    const tampered: Card = { ...slug, id: "story-xyz999" };
    expect(pinCardId(tampered, slug.id).id).toBe("story-fila-de-merge-serial");
  });

  it("forces ONLY the id — every other field of the transformation survives", () => {
    const captured = story("story-wagi3p", { status: "enriquecer" });
    const enriched: Card = { ...captured, id: "story-slug", title: "Novo título", status: "priorizar" };
    const pinned = pinCardId(enriched, captured.id);
    expect(pinned.id).toBe("story-wagi3p");
    expect(pinned.title).toBe("Novo título");
    expect(pinned.status).toBe("priorizar");
  });

  it("the capture id is the PERMANENT id: a fresh story id is story-<6 base36> and that shape is what gets frozen", () => {
    const id = randomCardId("story", new Set());
    expect(id).toMatch(/^story-[a-z0-9]{6}$/);
    // pinning a (would-be) enrich rename keeps that very capture id forever.
    const captured = story(id);
    const renamed: Card = { ...captured, id: "story-um-slug-longo-do-titulo" };
    expect(pinCardId(renamed, id).id).toBe(id);
  });
});
