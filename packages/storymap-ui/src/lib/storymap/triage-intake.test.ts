import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { checkGate } from "./gates";
import { coerceCard, coerceStatuses } from "./repo";
import { cardToFrontmatter } from "./write";
import { entryStatus, entryStatusId } from "./views";
import type { BoardConfig, Card } from "./types";

// ADR-056 — the Fase 0 data model for free-text bug/improvement intake + triage:
// first-class triage fields on the card, the `staging`/terminal status flags, the
// entry-status helper (replacing the fragile positional statuses[0]), and the new
// hasDuplicateOf gate guarding the `duplicado` terminal.

const card = (data: Record<string, unknown>): Card => coerceCard("c", { type: "story", ...data }, "");

// The REAL serialization path (matter.stringify -> matter -> coerceCard) without
// touching the watched storymap/boards dir. Mirrors round-trip.test.ts.
function roundTrip(c: Card): Card {
  const fm = cardToFrontmatter(c);
  const file = matter.stringify(`\n${(c.body ?? "").trim()}\n`, fm);
  const { data, content } = matter(file);
  return coerceCard(c.id, data as Record<string, unknown>, content);
}

describe("triage card fields — round-trip (ADR-056)", () => {
  it("preserves severity, labels, duplicateOf, needsHumanReview through real YAML", () => {
    const back = roundTrip(
      card({
        status: "triage",
        severity: "high",
        labels: ["regressao", "catalogo"],
        needsHumanReview: true,
      }),
    );
    expect(back.severity).toBe("high");
    expect(back.labels).toEqual(["regressao", "catalogo"]);
    expect(back.needsHumanReview).toBe(true);
  });

  it("keeps duplicateOf when a card is marked duplicado", () => {
    const back = roundTrip(card({ status: "duplicado", duplicateOf: "story-canonica" }));
    expect(back.duplicateOf).toBe("story-canonica");
  });

  it("stays LEAN: omits every triage field when unset (build cards keep slim frontmatter)", () => {
    const fm = cardToFrontmatter(card({ status: "rascunho" }));
    expect(fm).not.toHaveProperty("severity");
    expect(fm).not.toHaveProperty("labels");
    expect(fm).not.toHaveProperty("duplicateOf");
    expect(fm).not.toHaveProperty("needsHumanReview");
  });

  it("drops an invalid severity and an empty labels array (tolerant coercion)", () => {
    const c = card({ severity: "catastrophic", labels: [] });
    expect(c.severity).toBeUndefined();
    expect(c.labels).toBeUndefined();
  });
});

describe("status staging flag (ADR-056)", () => {
  it("coerces the boolean staging flag, leaving non-staging statuses undefined", () => {
    const [triage, rascunho] = coerceStatuses([
      { id: "triage", name: "Triagem", staging: true },
      { id: "rascunho", name: "Rascunho" },
    ]);
    expect(triage.staging).toBe(true);
    expect(rascunho.staging).toBeUndefined();
  });
});

describe("entryStatus — the new-card entry column (ADR-056)", () => {
  const build = (statuses: BoardConfig["statuses"]): BoardConfig => ({
    id: "b",
    name: "B",
    statuses,
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  });

  it("prefers the staging lane (triage) — fresh cards rest there before any autorun fires", () => {
    const cfg = build([
      { id: "triage", name: "Triagem", staging: true },
      { id: "enriquecer", name: "Enriquecer" },
      { id: "concluida", name: "Concluída", terminal: true },
    ]);
    expect(entryStatusId(cfg)).toBe("triage");
    expect(entryStatus(cfg)?.name).toBe("Triagem");
  });

  it("without a staging lane, falls back to the first non-terminal build column (skips terminal)", () => {
    const cfg = build([
      { id: "arquivados", name: "Arquivados", terminal: true },
      { id: "enriquecer", name: "Enriquecer" },
      { id: "concluida", name: "Concluída", terminal: true },
    ]);
    expect(entryStatusId(cfg)).toBe("enriquecer");
  });

  it("falls back to the first status when every column is terminal (no staging, no build column)", () => {
    const cfg = build([
      { id: "concluida", name: "Concluída", terminal: true },
      { id: "cancelado", name: "Cancelado", terminal: true },
    ]);
    expect(entryStatusId(cfg)).toBe("concluida");
  });

  it("returns null for an empty board", () => {
    expect(entryStatusId(build([]))).toBeNull();
    expect(entryStatus(build([]))).toBeNull();
  });
});

describe("hasDuplicateOf gate — guards the duplicado terminal (ADR-056)", () => {
  const board: BoardConfig = {
    id: "b",
    name: "B",
    statuses: [{ id: "duplicado", name: "Duplicado", gate: "hasDuplicateOf", terminal: true }],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  };

  it("blocks entry without a canonical pointer", () => {
    expect(checkGate(card({}), "duplicado", board)).toMatch(/duplicateOf|canônico/i);
  });

  it("allows entry once duplicateOf points at the canonical card", () => {
    expect(checkGate(card({ duplicateOf: "story-canonica" }), "duplicado", board)).toBeNull();
  });
});
