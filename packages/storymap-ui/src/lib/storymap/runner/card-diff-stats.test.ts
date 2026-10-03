import { beforeEach, describe, expect, it } from "vitest";
import type { Card } from "@/lib/storymap/types";
import { cardsDiffStats, LIVE_BRANCH_TTL_MS, resetCardDiffCache, type CardDiffDeps } from "./card-diff-stats";

const card = (id: string, over: Partial<Card> = {}) => ({ id, ...over }) as Card;

function fakeGit(stats: Record<string, string>) {
  const calls: string[][] = [];
  let now = 1_000_000;
  const deps: CardDiffDeps & { calls: string[][]; tick(ms: number): void } = {
    calls,
    tick(ms) {
      now += ms;
    },
    now: () => now,
    async git(args) {
      calls.push(args);
      const range = args[args.length - 1];
      if (!(range in stats)) throw new Error(`unknown range ${range}`);
      return stats[range];
    },
    async runBranchFor(_board, cardId) {
      return cardId === "running" ? { branch: "run/abc", base: "b0" } : null;
    },
  };
  return deps;
}

beforeEach(() => resetCardDiffCache());

describe("cardsDiffStats — o tamanho do trabalho de um board numa ida só", () => {
  it("card sem nenhuma fonte não custa git; o integrado vem do diffSnapshot", async () => {
    const deps = fakeGit({ "a1..m1": " 14 files changed, 442 insertions(+), 8 deletions(-)" });
    const out = await cardsDiffStats(deps, "armazem", [card("idle"), card("done", { diffSnapshot: { base: "a1", mergeCommit: "m1" } })], new Set());
    expect(out).toEqual({ done: { files: 14, additions: 442, deletions: 8 } });
    expect(deps.calls).toEqual([["diff", "--shortstat", "a1..m1"]]);
  });

  it("o commitRange da revisão vence o diffSnapshot (que a última integração reescreve)", async () => {
    const deps = fakeGit({ "r1..r2": " 3 files changed, 54 insertions(+), 9 deletions(-)", "a1..m1": " 1 file changed, 6 insertions(+), 1 deletion(-)" });
    const out = await cardsDiffStats(deps, "armazem", [card("c", { commitRange: { base: "r1", head: "r2" }, diffSnapshot: { base: "a1", mergeCommit: "m1" } })], new Set());
    expect(out.c).toEqual({ files: 3, additions: 54, deletions: 9 });
  });

  it("um intervalo de shas é medido uma vez só (imutável)", async () => {
    const deps = fakeGit({ "a1..m1": " 1 file changed, 1 insertion(+)" });
    const c = card("c", { diffSnapshot: { base: "a1", mergeCommit: "m1" } });
    await cardsDiffStats(deps, "armazem", [c], new Set());
    await cardsDiffStats(deps, "armazem", [c], new Set());
    expect(deps.calls).toHaveLength(1);
  });

  it("o branch vivo da execução é a fonte mais fresca, remedido só depois do intervalo", async () => {
    const deps = fakeGit({ "b0..run/abc": " 2 files changed, 10 insertions(+)" });
    const out = await cardsDiffStats(deps, "armazem", [card("running")], new Set(["running"]));
    expect(out.running).toEqual({ files: 2, additions: 10, deletions: 0 });
    await cardsDiffStats(deps, "armazem", [card("running")], new Set(["running"]));
    expect(deps.calls).toHaveLength(1);
    deps.tick(LIVE_BRANCH_TTL_MS);
    await cardsDiffStats(deps, "armazem", [card("running")], new Set(["running"]));
    expect(deps.calls).toHaveLength(2);
  });

  it("um git que falha e um diff vazio não viram número", async () => {
    const deps = fakeGit({ "e1..e2": "" });
    const out = await cardsDiffStats(
      deps,
      "armazem",
      [card("broken", { diffSnapshot: { base: "x", mergeCommit: "y" } }), card("empty", { diffSnapshot: { base: "e1", mergeCommit: "e2" } })],
      new Set(),
    );
    expect(out).toEqual({});
  });
});
