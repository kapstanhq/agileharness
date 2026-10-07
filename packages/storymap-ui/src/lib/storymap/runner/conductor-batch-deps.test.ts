// Fase 7 — a régua do `worktree_submit` de uma sessão de LOTE, em git de verdade (runner/conductor-batch-deps.ts
// `droppedItemsSubmitRefusal`): o código de um item que SAIU do lote não vai ao train com os outros. Recusada enquanto o
// commit `Card: <item>` segue no branch; aceita depois do revert com `Card-Revert:`, e aceita depois de refazer o branch
// por cherry-pick só dos itens que ficaram (o caminho quando o revert conflita). Fixtures inventadas (story-ex98NN).

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describePosix } from "./test-platform";
import { batchCommits, droppedItemsSubmitRefusal } from "./conductor-batch-deps";
import type { AgentSession } from "./session-worktree";

const run = promisify(execFile);

describePosix("droppedItemsSubmitRefusal — o código do item que saiu fica fora da submissão", () => {
  let tmp: string;
  let base: string;
  const g = async (...args: string[]) => (await run("git", ["-C", tmp, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmp } })).stdout.trim();
  const commit = async (file: string, text: string, ...msgs: string[]) => {
    await fsp.writeFile(path.join(tmp, file), text);
    await g("add", "-A");
    await g("commit", "-q", "--no-verify", ...msgs.flatMap((m) => ["-m", m]));
    return g("rev-parse", "HEAD");
  };
  const session = (dropped: string[]): AgentSession => ({
    sessionId: "sess-ex9800",
    agentId: "a",
    role: "implement",
    board: "b",
    cardId: "story-ex9801",
    task: "t",
    worktreePath: tmp,
    baseCommit: base,
    openedAt: "",
    heartbeatAt: "",
    batch: { id: "lote-ex", featureKey: "f1", cardIds: ["story-ex9802", "story-ex9803"], dropped: dropped.map((cardId) => ({ cardId, reason: "falhou", at: "x" })) },
  });

  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-batch-submit-"));
    await g("init", "-q");
    await g("config", "user.email", "t@example.test");
    await g("config", "user.name", "tester");
    base = await commit("a.txt", "base\n", "base");
  });

  afterAll(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("recusa com o commit do item que saiu; aceita depois do revert; aceita o branch refeito por cherry-pick", async () => {
    const lead = await commit("lead.txt", "lead\n", "líder", "Card: story-ex9801");
    const bad = await commit("item2.txt", "item 2\n", "item 2", "Card: story-ex9802");
    const ok3 = await commit("item3.txt", "item 3\n", "item 3", "Card: story-ex9803");
    expect((await batchCommits(tmp, `${base}..HEAD`)).map((c) => c.sha)).toEqual([lead, bad, ok3]);

    expect(await droppedItemsSubmitRefusal(session([]))).toBeNull();
    const refusal = await droppedItemsSubmitRefusal(session(["story-ex9802"]));
    expect(refusal).toMatch(new RegExp(`story-ex9802 \\(${bad.slice(0, 8)}\\)`));
    expect(refusal).toMatch(/Card-Revert/);

    // o revert com o trailer
    await g("revert", "--no-edit", "--no-commit", bad);
    await g("commit", "-q", "--no-verify", "-m", "desfaz o item 2", "-m", `Card-Revert: ${bad.slice(0, 12)}`);
    expect(await droppedItemsSubmitRefusal(session(["story-ex9802"]))).toBeNull();

    // o branch refeito só com os itens que ficaram (o caminho do revert que conflita)
    await g("reset", "-q", "--hard", base);
    await g("cherry-pick", lead, ok3);
    expect(await droppedItemsSubmitRefusal(session(["story-ex9802"]))).toBeNull();
    expect((await batchCommits(tmp, `${base}..HEAD`)).length).toBe(2);
  });
});
