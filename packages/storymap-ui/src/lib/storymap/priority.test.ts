import { describe, expect, it } from "vitest";
import { priorityKind, priorityScore, bugSeverityOf, cardPriorityTier, cardPriorityRank } from "./priority";
import { coerceCard } from "./repo";
import type { Card } from "./types";

// Type-aware prioritization (Fase 2) — the WSJF that lets a bug/melhoria rank in the
// SAME backlog as a feature. The discriminator + the comparable score are the heart.
const card = (data: Record<string, unknown>): Card => coerceCard("c", { type: "story", ...data }, "");

const FULL_RICE = { reach: 600, impact: 2, confidence: 0.8, effort: 3 };

describe("priorityKind — the discriminator", () => {
  it("feature when RICE+KANO+funnel are complete — even in fix/refine mode (preserves the bet)", () => {
    expect(priorityKind(card({ rice: FULL_RICE, kano: "performance", funnelStage: "retention" }))).toBe("feature");
    // a bug REOPENED on a shipped feature keeps the feature score (not the bug rubric)
    const reopened = card({ storyType: "bug", mode: "fix", rice: FULL_RICE, kano: "must-be", funnelStage: "retention" });
    expect(priorityKind(reopened)).toBe("feature");
  });

  it("bug for a storyType bug / fix mode WITHOUT a feature prioritization", () => {
    expect(priorityKind(card({ storyType: "bug" }))).toBe("bug");
    expect(priorityKind(card({ storyType: "user", mode: "fix" }))).toBe("bug");
  });

  it("melhoria for refine mode WITHOUT a feature prioritization", () => {
    expect(priorityKind(card({ mode: "refine" }))).toBe("melhoria");
  });

  it("feature by default (a fresh, not-yet-prioritized build)", () => {
    expect(priorityKind(card({ storyType: "user" }))).toBe("feature");
    expect(priorityKind(card({ storyType: "technical" }))).toBe("feature");
  });
});

describe("priorityScore — WSJF, comparable across kinds", () => {
  const blockerBug = card({ storyType: "bug", severity: "blocker", frequency: "always", hasWorkaround: false });
  const lowFeature = card({
    storyType: "user",
    rice: { reach: 30, impact: 0.5, confidence: 0.5, effort: 5 },
    kano: "performance",
    funnelStage: "awareness",
  });
  const bigFeature = card({
    storyType: "user",
    rice: { reach: 6000, impact: 3, confidence: 1, effort: 3 },
    kano: "must-be",
    funnelStage: "activation",
  });
  const melhoria = card({ mode: "refine", rice: { reach: null, impact: 2, confidence: null, effort: 2 } });

  it("a frequent blocker bug out-ranks a low-RICE feature (the Fase 2 goal)", () => {
    expect(priorityScore(blockerBug)!).toBeGreaterThan(priorityScore(lowFeature)!);
    expect(priorityScore(blockerBug)!).toBeGreaterThan(priorityScore(bigFeature)!);
  });

  it("computes the documented points for each kind (calibration lock)", () => {
    expect(priorityScore(blockerBug)).toBe(150);
    expect(priorityScore(bigFeature)).toBe(78);
    expect(priorityScore(melhoria)).toBe(20);
    expect(priorityScore(lowFeature)).toBe(1);
  });

  it("a workaround + lower frequency lower a bug's score", () => {
    const mild = card({ storyType: "bug", severity: "low", frequency: "rare", hasWorkaround: true });
    expect(priorityScore(mild)!).toBeLessThan(priorityScore(blockerBug)!);
  });

  it("returns null when the kind's required inputs are missing (sinks to the bottom)", () => {
    expect(priorityScore(card({ storyType: "bug", severity: "blocker" }))).toBeNull(); // bug w/o frequency
    expect(priorityScore(card({ storyType: "user" }))).toBeNull(); // feature w/o rice
    expect(priorityScore(card({ mode: "refine" }))).toBeNull(); // melhoria w/o impact/effort
  });

  it("bugSeverityOf prefers the first-class `severity`, falling back to bugReport", () => {
    expect(bugSeverityOf(card({ severity: "high" }))).toBe("high");
    expect(bugSeverityOf(card({ bugReport: { brief: "x", severity: "low" } }))).toBe("low");
    expect(bugSeverityOf(card({ storyType: "user" }))).toBeNull();
  });
});

// Prioridade ARGUMENTADA (reasoning-first) — o tier defendido pelo agente/humano é o sinal PRIMÁRIO;
// o WSJF é só o fallback. cardPriorityTier/cardPriorityRank são o ponto de entrada que a UI usa.
const pc = (rank: 0 | 1 | 2 | 3, source: "agent" | "human" = "agent") => ({
  rank,
  rationale: "argumento de teste",
  source,
  assessedAt: "2026-06-20",
});

describe("cardPriorityTier — o argumento vence o WSJF", () => {
  it("usa o tier argumentado (priorityCall) quando presente", () => {
    expect(cardPriorityTier(card({ priorityCall: pc(3) }))?.label).toBe("Crítica");
    expect(cardPriorityTier(card({ priorityCall: pc(0, "human") }))?.label).toBe("Baixa");
  });

  it("o argumento vence MESMO um WSJF que daria outro tier (reasoning-first)", () => {
    const c = card({
      rice: { reach: 30, impact: 0.5, confidence: 0.5, effort: 5 },
      kano: "performance",
      funnelStage: "awareness",
      priorityCall: pc(2, "human"),
    });
    expect(priorityScore(c)).toBe(1); // WSJF → "Baixa"
    expect(cardPriorityTier(c)?.label).toBe("Alta"); // mas o argumento manda
  });

  it("cai no WSJF quando não há priorityCall", () => {
    const blocker = card({ storyType: "bug", severity: "blocker", frequency: "always", hasWorkaround: false });
    expect(cardPriorityTier(blocker)?.label).toBe("Crítica"); // score 150
  });

  it("null quando não há nem argumento nem inputs do WSJF", () => {
    expect(cardPriorityTier(card({ storyType: "user" }))).toBeNull();
  });
});

describe("cardPriorityRank — argued flutua acima de qualquer WSJF cru na ordenação", () => {
  it("um card argumentado (mesmo rank 0) fica acima do maior WSJF", () => {
    const argued = card({ priorityCall: pc(0) });
    const bigWsjf = card({ storyType: "bug", severity: "blocker", frequency: "always", hasWorkaround: false }); // 150
    expect(cardPriorityRank(argued)!).toBeGreaterThan(cardPriorityRank(bigWsjf)!);
  });

  it("entre argumentados, ordena pelo rank", () => {
    expect(cardPriorityRank(card({ priorityCall: pc(3) }))!).toBeGreaterThan(
      cardPriorityRank(card({ priorityCall: pc(1) }))!,
    );
  });
});
