import { describe, expect, it } from "vitest";
import { cardQuickActionVisibility, cardReadViewSpec, cardSummaryLine, idleDiffVisible, openQuestionHref, splitPreview } from "./card-preview";
import type { Card } from "./types";

/** Minimal Card fixture — only the fields cardSummaryLine reads (narrative + body). */
function card(over: { soThat?: string | null; body?: string }): Card {
  return {
    narrative: { role: null, want: null, soThat: over.soThat ?? null },
    body: over.body ?? "",
  } as unknown as Card;
}

describe("splitPreview", () => {
  it("shows all when under the limit, nothing hidden", () => {
    const r = splitPreview([1, 2, 3], 3);
    expect(r.shown).toEqual([1, 2, 3]);
    expect(r.hiddenCount).toBe(0);
  });

  it("caps at the limit and counts the rest (boundary at 3)", () => {
    const r = splitPreview([1, 2, 3, 4, 5], 3);
    expect(r.shown).toEqual([1, 2, 3]);
    expect(r.hiddenCount).toBe(2);
  });

  it("exactly at the limit hides nothing", () => {
    expect(splitPreview([1, 2, 3], 3).hiddenCount).toBe(0);
  });

  it("empty list → empty shown, no hidden", () => {
    expect(splitPreview([], 3)).toEqual({ shown: [], hiddenCount: 0 });
  });

  it("clamps a negative max to 0", () => {
    expect(splitPreview([1, 2], -1)).toEqual({ shown: [], hiddenCount: 2 });
  });
});

describe("cardSummaryLine", () => {
  it("prefers narrative.soThat (the value/benefit) over the body", () => {
    expect(cardSummaryLine(card({ soThat: "ajo num relance", body: "## Escopo\nlinha do corpo" }))).toBe(
      "ajo num relance",
    );
  });

  it("trims surrounding whitespace from soThat", () => {
    expect(cardSummaryLine(card({ soThat: "  com folga  " }))).toBe("com folga");
  });

  it("falls back to the first non-empty body line when soThat is empty", () => {
    expect(cardSummaryLine(card({ soThat: "", body: "\n\nprimeira linha real\nsegunda" }))).toBe(
      "primeira linha real",
    );
  });

  it("strips a leading markdown heading marker from the body fallback", () => {
    expect(cardSummaryLine(card({ soThat: null, body: "## Escopo do card\nresto" }))).toBe("Escopo do card");
  });

  it("strips a leading blockquote marker from the body fallback", () => {
    expect(cardSummaryLine(card({ body: "> uma nota citada" }))).toBe("uma nota citada");
  });

  it("returns null when both soThat and body are empty (AC7 — omit silently, no placeholder)", () => {
    expect(cardSummaryLine(card({ soThat: "", body: "" }))).toBeNull();
    expect(cardSummaryLine(card({ soThat: null, body: "   \n  \n" }))).toBeNull();
  });

  it("returns null when soThat is only whitespace and there's no body", () => {
    expect(cardSummaryLine(card({ soThat: "   " }))).toBeNull();
  });
});

describe("cardQuickActionVisibility", () => {
  it("terminal shows while running even without a session", () => {
    const v = cardQuickActionVisibility({ kind: "running", hasSession: false, hasRecommendedMove: true });
    expect(v.terminal).toBe(true);
    expect(v.advance).toBe(false); // never advance mid-run
    expect(v.diff).toBe(false); // running but the branch has NO commits yet → no diff to show
  });

  it("diff appears DURING a run once its branch has commits (hasDiff) — the small-commits flow", () => {
    // before the first commit: no diff
    expect(cardQuickActionVisibility({ kind: "running", hasSession: false, hasRecommendedMove: false, hasDiff: false }).diff).toBe(false);
    // after the skill's first incremental commit lands: the +/− lights up live, mid-run
    expect(cardQuickActionVisibility({ kind: "running", hasSession: false, hasRecommendedMove: false, hasDiff: true }).diff).toBe(true);
  });

  it("hasDiff does NOT force the diff on for non-run states (it only unlocks the running case)", () => {
    // an idle card with a stale stat must not paint the command-strip diff (idleDiffVisible owns idle)
    expect(cardQuickActionVisibility({ kind: null, hasSession: false, hasRecommendedMove: false, hasDiff: true }).diff).toBe(false);
  });

  it("terminal shows when there's a resumable session even when idle", () => {
    const v = cardQuickActionVisibility({ kind: null, hasSession: true, hasRecommendedMove: false });
    expect(v.terminal).toBe(true);
    expect(v.diff).toBe(false);
    expect(v.advance).toBe(false);
  });

  it("diff appears for branch-bearing states (done/conflict/failed/merging/waiting)", () => {
    for (const kind of ["merging", "conflict", "waiting", "failed", "done"] as const) {
      expect(cardQuickActionVisibility({ kind, hasSession: true, hasRecommendedMove: false }).diff).toBe(true);
    }
  });

  it("advance appears only when idle AND a move is recommended", () => {
    expect(cardQuickActionVisibility({ kind: "done", hasSession: true, hasRecommendedMove: true }).advance).toBe(true);
    expect(cardQuickActionVisibility({ kind: "running", hasSession: true, hasRecommendedMove: true }).advance).toBe(false);
    expect(cardQuickActionVisibility({ kind: null, hasSession: false, hasRecommendedMove: false }).advance).toBe(false);
  });
});

describe("cardReadViewSpec", () => {
  function makeCard(over: Partial<Card>): Parameters<typeof cardReadViewSpec>[0] {
    return {
      narrative: { role: null, want: null, soThat: null },
      acceptance: [],
      personas: [],
      systems: [],
      body: "",
      ...over,
    };
  }

  it("all false + empty:true when card is completely blank (AC1 — vazios não aparecem)", () => {
    const r = cardReadViewSpec(makeCard({}));
    expect(r).toEqual({ narrative: false, acceptance: false, personas: false, systems: false, body: false, empty: true });
  });

  it("narrative:true when any narrative field is non-empty", () => {
    expect(cardReadViewSpec(makeCard({ narrative: { role: "operador", want: null, soThat: null } })).narrative).toBe(true);
    expect(cardReadViewSpec(makeCard({ narrative: { role: null, want: "ver runs", soThat: null } })).narrative).toBe(true);
    expect(cardReadViewSpec(makeCard({ narrative: { role: null, want: null, soThat: "sem scroll" } })).narrative).toBe(true);
  });

  it("narrative:false when fields are only whitespace", () => {
    expect(cardReadViewSpec(makeCard({ narrative: { role: "   ", want: "\t", soThat: "" } })).narrative).toBe(false);
  });

  it("acceptance:true when list is non-empty", () => {
    expect(cardReadViewSpec(makeCard({ acceptance: ["Dado que…"] })).acceptance).toBe(true);
  });

  it("personas:true when list is non-empty", () => {
    expect(cardReadViewSpec(makeCard({ personas: ["operador"] })).personas).toBe(true);
  });

  it("systems:true when list is non-empty", () => {
    expect(cardReadViewSpec(makeCard({ systems: ["ui"] })).systems).toBe(true);
  });

  it("body:true when non-empty non-whitespace text", () => {
    expect(cardReadViewSpec(makeCard({ body: "## Contexto\ndetalhes" })).body).toBe(true);
    expect(cardReadViewSpec(makeCard({ body: "   \n  " })).body).toBe(false);
  });

  it("empty:false when at least one section is present", () => {
    expect(cardReadViewSpec(makeCard({ systems: ["ui"] })).empty).toBe(false);
  });

  // A priorização saiu na fase 5: RICE/KANO/funil de um card ANTIGO (ainda no frontmatter) não contam como conteúdo.
  it("um card antigo só com RICE/KANO/funil continua vazio — e o spec não tem mais essas chaves", () => {
    const antigo = { kano: "performance", funnelStage: "retention", rice: { reach: 1, impact: 1, confidence: 1, effort: 1 } };
    const r = cardReadViewSpec({ ...makeCard({}), ...antigo } as Parameters<typeof cardReadViewSpec>[0]);
    expect(r.empty).toBe(true);
    expect(r).not.toHaveProperty("kano");
    expect(r).not.toHaveProperty("rice");
    expect(r).not.toHaveProperty("funnelStage");
  });
});

describe("openQuestionHref", () => {
  it("abre o ITEM da pergunta no Inbox (a fila /perguntas saiu) — o id viaja codificado (AC4)", () => {
    expect(openQuestionHref("storymap", "story-abc123", "q1")).toBe("/board/storymap/inbox/story-abc123%3Aq%3Aq1");
  });
});

describe("idleDiffVisible", () => {
  it("hidden when the card never produced a run branch here (stat == null)", () => {
    // "sem run → não exibe": a clean footer, never an empty badge.
    expect(idleDiffVisible({ hasLiveSubstate: false, stat: null })).toBe(false);
  });

  it("hidden while a live sub-state owns the +/− (the command strip shows it)", () => {
    expect(idleDiffVisible({ hasLiveSubstate: true, stat: { additions: 42, deletions: 15 } })).toBe(false);
  });

  it("shown for an idle card whose run branch has real changes", () => {
    expect(idleDiffVisible({ hasLiveSubstate: false, stat: { additions: 42, deletions: 15 } })).toBe(true);
  });

  it("shown for a pure-addition branch (only +)", () => {
    expect(idleDiffVisible({ hasLiveSubstate: false, stat: { additions: 7, deletions: 0 } })).toBe(true);
  });

  it("shown for a pure-deletion branch (only −)", () => {
    expect(idleDiffVisible({ hasLiveSubstate: false, stat: { additions: 0, deletions: 4 } })).toBe(true);
  });

  it("hidden for a no-op branch — never a '+0 −0' badge", () => {
    expect(idleDiffVisible({ hasLiveSubstate: false, stat: { additions: 0, deletions: 0 } })).toBe(false);
  });
});
