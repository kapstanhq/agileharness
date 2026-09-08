import { describe, expect, it } from "vitest";
import { readBoardConfig, readCards, coerceCard, listBoards } from "./repo";
import { parseCard, parseBoardConfig } from "./contracts";
import type { CardContract, BoardConfigContract } from "./contracts";
import type { Card, BoardConfig } from "./types";

// B1 — proves the Zod contracts (contracts.ts) faithfully describe the domain, two ways:
//   (1) COMPILE-TIME drift guard — the inferred contract type and the hand-written interface must be
//       mutually assignable. If they drift (a field added to one, an optional/null mismatch), ONE of
//       the assert lines below fails `tsc`. This is what lets Increment 2 swap the interfaces for
//       `z.infer` safely: the swap is a no-op only because these stay green.
//   (2) RUNTIME conformance — coerceCard()/readBoardConfig() output (incl. EVERY real card on the
//       board) parses clean against the schema. So the contract isn't just plausible — it matches
//       what the loaders actually produce today.

// (1) compile-time: `never` unless A and B are mutually assignable → `const _: never = true` fails tsc.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _cardParity: MutuallyAssignable<Card, CardContract> = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _boardParity: MutuallyAssignable<BoardConfig, BoardConfigContract> = true;

describe("contracts — repo-wide spec conformance (EVERY board + EVERY card)", () => {
  it("every board.yaml satisfies BoardConfigSchema", async () => {
    const boards = await listBoards();
    expect(boards.length).toBeGreaterThan(0);
    const failures: Array<{ board: string; issues: unknown }> = [];
    for (const b of boards) {
      const r = parseBoardConfig(await readBoardConfig(b.id));
      if (!r.ok) failures.push({ board: b.id, issues: r.issues });
    }
    expect(failures).toEqual([]);
  });

  it("every card on every board satisfies CardSchema", async () => {
    const boards = await listBoards();
    let total = 0;
    const failures: Array<{ board: string; card: string; issues: unknown }> = [];
    for (const b of boards) {
      const cards = await readCards(b.id);
      total += cards.length;
      for (const c of cards) {
        const r = parseCard(c);
        if (!r.ok) failures.push({ board: b.id, card: c.id, issues: r.issues });
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it("coerceCard edge shapes satisfy CardSchema (sparse refine/fix/retire/findings/staged)", () => {
    const inputs: Array<Record<string, unknown>> = [
      {},
      { type: "story", storyType: "bug", severity: "high", frequency: "often", hasWorkaround: true, labels: ["regression"] },
      { type: "story", mode: "refine", refinement: { brief: "melhorar contraste", kinds: ["ux", "ui"], openedAt: "2026-06-10" } },
      // Per-instance routing override (pipeline-owned) round-trips clean through CardSchema.
      { type: "story", mode: "refine", refinement: { brief: "trocar copy", kinds: ["copy"] }, routing: { skips: ["interview", "design-ux", "design-ui", "com-design", "ready"], decidedBy: "agent", decidedAt: "2026-06-16" } },
      { type: "story", mode: "fix", bugReport: { brief: "quebra no login", severity: "high", steps: ["abrir", "logar"] } },
      { type: "story", mode: "retire", retirement: { brief: "descontinuar", disposition: "descontinuado", level: "remover-codigo", scope: ["codigo", "rota"], dataDeletionApproved: false } },
      { type: "activity", title: "Backbone" },
      { findings: [{ id: "f1", lens: "security", severity: "blocker", title: "SQLi", status: "open", file: "a.ts", line: 3 }] },
      { stagedAt: "2026-06-10", releasedAt: "2026-06-11", commitRange: { base: "aaa", head: "bbb" }, diffSnapshot: { base: "aaa", mergeCommit: "ccc" } },
      { type: "story", rice: { reach: 100, impact: 2, confidence: 0.8, effort: 4 }, kano: "performance", funnelStage: "activation", duplicateOf: "story-x" },
    ];
    const failures = inputs
      .map((i) => ({ i, r: parseCard(coerceCard("c", i, "body")) }))
      .filter((x) => !x.r.ok)
      .map((x) => ({ input: x.i, issues: x.r.ok ? [] : x.r.issues }));
    expect(failures).toEqual([]);
  });
});
