import { describe, expect, it } from "vitest";
import { buildRequeueEntry, isRequeueableStatus, requeueCandidates } from "./requeue";
import type { MergeQueueEntry } from "./types";

describe("isRequeueableStatus", () => {
  it("aceita os terminais failed/conflict/done — done incluso (o falso-done é recuperável; o honesto é no-op)", () => {
    expect(isRequeueableStatus("failed")).toBe(true);
    expect(isRequeueableStatus("conflict")).toBe(true);
    expect(isRequeueableStatus("done")).toBe(true);
  });
  it("recusa os VIVOS — eles têm caminho próprio e um requeue duplicaria a integração em voo", () => {
    for (const s of ["waiting", "merging", "gate-running", "gate-failed", "re-driving", "returned-to-session"]) {
      expect(isRequeueableStatus(s)).toBe(false);
    }
  });
});

describe("requeueCandidates", () => {
  it("orders registered → failed/run/<id> → conflicted/run/<id> → run/<id>, deduped", () => {
    expect(requeueCandidates({ runId: "r1", branch: "run/r1" })).toEqual([
      "run/r1",
      "failed/run/r1",
      "conflicted/run/r1",
    ]);
    expect(requeueCandidates({ runId: "r1", branch: "failed/run/r1" })).toEqual([
      "failed/run/r1",
      "conflicted/run/r1",
      "run/r1",
    ]);
    expect(requeueCandidates({ runId: "r1", branch: "custom/x" })).toEqual([
      "custom/x",
      "failed/run/r1",
      "conflicted/run/r1",
      "run/r1",
    ]);
  });

  // autonomy-endgame WS-3.5 — `conflicted/run/<id>` is NOT a widened net; it is the branch the incident
  // actually parks on. A DATA-half failure finalizes the entry as `conflict` and the preservation rename
  // stacks `conflicted/` — so the operator's ONE manual recovery path was looking for the wrong branch name
  // in the exact case it existed for. (The action's status gate was the other half of the same blindness:
  // it only accepted `failed`, and the incident parks as `conflict`.)
  it("inclui a branch preservada de um CONFLITO — o estado em que a falha de dados parqueia", () => {
    expect(requeueCandidates({ runId: "a779b5be", branch: "conflicted/run/a779b5be" })).toContain(
      "conflicted/run/a779b5be",
    );
    // ...e sem duplicar quando ela já é a branch registrada.
    expect(
      requeueCandidates({ runId: "a779b5be", branch: "conflicted/run/a779b5be" }).filter(
        (b) => b === "conflicted/run/a779b5be",
      ),
    ).toHaveLength(1);
  });
});

describe("buildRequeueEntry", () => {
  it("preserves lineage + the resolved branch, and DISCARDS all terminal residue + status/enqueuedAt", () => {
    const entry: MergeQueueEntry = {
      runId: "r1",
      board: "storymap",
      cardId: "c1",
      branch: "run/r1",
      status: "failed",
      enqueuedAt: 1,
      baseCommit: "abc",
      trigger: "harness-do",
      driveCount: 2,
      mergeStartedAt: 5,
      mergeEndedAt: 9,
      failureReason: "boom",
      conflictDetail: "x",
      gateLog: "y",
      pushError: "p",
      gateBlockerError: "g",
      secretScanBlockerError: "s",
      split: { dataLanded: true },
    };
    const out = buildRequeueEntry(entry, "failed/run/r1");
    expect(out).toEqual({
      runId: "r1",
      board: "storymap",
      cardId: "c1",
      branch: "failed/run/r1",
      baseCommit: "abc",
      trigger: "harness-do",
      driveCount: 2,
    });
    for (const dropped of ["status", "enqueuedAt", "failureReason", "conflictDetail", "gateLog", "mergeEndedAt", "pushError", "split"]) {
      expect(dropped in out).toBe(false);
    }
  });

  it("omits absent lineage fields (a minimal entry stays minimal)", () => {
    const entry: MergeQueueEntry = { runId: "r2", board: "b", cardId: "c2", branch: "run/r2", status: "failed", enqueuedAt: 1 };
    expect(buildRequeueEntry(entry, "run/r2")).toEqual({ runId: "r2", board: "b", cardId: "c2", branch: "run/r2" });
  });
});
