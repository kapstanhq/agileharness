import { describe, expect, it } from "vitest";
import { mergeEntryEscalation, preservedBranchEscalation, resolveProcessAnchor, serviceEscalation } from "./process-escalation";
import type { MergeQueueStatus } from "../runner/types";

const ALL_MERGE_STATUSES: MergeQueueStatus[] = [
  "waiting",
  "gate-running",
  "gate-failed",
  "merging",
  "conflict",
  "re-driving",
  "done",
  "failed",
];

describe("mergeEntryEscalation", () => {
  it.each(ALL_MERGE_STATUSES)("status=%s", (status) => {
    const target = mergeEntryEscalation({ runId: "r1", board: "acme", cardId: "c1", status });
    if (status === "conflict" || status === "gate-failed" || status === "failed") {
      const expectedTemplate =
        status === "conflict" ? "merge-conflict" : status === "gate-failed" ? "merge-gate-failed" : "merge-failed-terminal";
      expect(target).toEqual({
        boardId: "acme",
        ref: { templateId: expectedTemplate, kind: "merge", boardId: "acme", cardId: "c1", runId: "r1", entryStatus: status },
      });
    } else {
      expect(target).toBeNull();
    }
  });
});

describe("serviceEscalation", () => {
  it("interrupted + card -> run-death", () => {
    const t = serviceEscalation({ kind: "runner-run", status: "interrupted", board: "acme", cardId: "c1" });
    expect(t).toEqual({ boardId: "acme", ref: { templateId: "run-death", kind: "run", boardId: "acme", cardId: "c1" } });
  });

  it("failed + card (any kind) -> run-death", () => {
    const t = serviceEscalation({ kind: "tmux-card", status: "failed", board: "acme", cardId: "c1" });
    expect(t?.ref).toMatchObject({ templateId: "run-death" });
  });

  it("running runner-run + card -> run-inflight-stuck", () => {
    const t = serviceEscalation({ kind: "runner-run", status: "running", board: "acme", cardId: "c1" });
    expect(t).toEqual({ boardId: "acme", ref: { templateId: "run-inflight-stuck", kind: "run", boardId: "acme", cardId: "c1" } });
  });

  it("running non-runner-run (tmux) + card -> null (only a runner-run is diagnosable in-flight)", () => {
    expect(serviceEscalation({ kind: "tmux-card", status: "running", board: "acme", cardId: "c1" })).toBeNull();
  });

  it("idle / done -> null", () => {
    expect(serviceEscalation({ kind: "runner-run", status: "idle", board: "acme", cardId: "c1" })).toBeNull();
    expect(serviceEscalation({ kind: "runner-run", status: "done", board: "acme", cardId: "c1" })).toBeNull();
  });

  it("no board -> null even when otherwise escalable", () => {
    expect(serviceEscalation({ kind: "runner-run", status: "failed", cardId: "c1" })).toBeNull();
  });

  it("no cardId -> null even when otherwise escalable", () => {
    expect(serviceEscalation({ kind: "runner-run", status: "failed", board: "acme" })).toBeNull();
  });

  it("claude-external with neither board nor card -> null (orphan-process-kill stays out of v1)", () => {
    expect(serviceEscalation({ kind: "claude-external", status: "failed" })).toBeNull();
  });
});

describe("preservedBranchEscalation", () => {
  it("needsAttention branch with a board -> escalable", () => {
    const t = preservedBranchEscalation({ branch: "run/abc", board: "acme", superseded: false });
    expect(t).toEqual({
      boardId: "acme",
      ref: { templateId: "preserved-branch-recovery", kind: "branch", boardId: "acme", branch: "run/abc" },
    });
  });

  it("superseded -> null (safe trash; escalating adds nothing)", () => {
    expect(preservedBranchEscalation({ branch: "run/abc", board: "acme", superseded: true })).toBeNull();
  });

  it("board null -> null (no drawer destination, D14)", () => {
    expect(preservedBranchEscalation({ branch: "run/abc", board: null, superseded: false })).toBeNull();
  });

  it("superseded AND board null -> still null", () => {
    expect(preservedBranchEscalation({ branch: "run/abc", board: null, superseded: true })).toBeNull();
  });
});

describe("resolveProcessAnchor", () => {
  const mergeStatusByRunId = new Map<string, MergeQueueStatus>([
    ["r-conflict", "conflict"],
    ["r-gate-failed", "gate-failed"],
    ["r-waiting", "waiting"],
    ["r-done", "done"],
    ["r-failed", "failed"],
  ]);
  const serviceIds = new Set(["run:acme/c1", "tmux:master"]);

  it("run takes precedence over svc", () => {
    const a = resolveProcessAnchor({ run: "r-conflict", svc: "run:acme/c1" }, mergeStatusByRunId, serviceIds);
    expect(a).toEqual({ kind: "merge", runId: "r-conflict", archived: false });
  });

  it("done/failed -> archived true (lives in the Arquivo disclosure)", () => {
    expect(resolveProcessAnchor({ run: "r-done", svc: null }, mergeStatusByRunId, serviceIds)).toEqual({
      kind: "merge",
      runId: "r-done",
      archived: true,
    });
    expect(resolveProcessAnchor({ run: "r-failed", svc: null }, mergeStatusByRunId, serviceIds)).toEqual({
      kind: "merge",
      runId: "r-failed",
      archived: true,
    });
  });

  it("conflict/gate-failed/waiting -> archived false (always visible, no auto-open needed)", () => {
    expect(resolveProcessAnchor({ run: "r-conflict", svc: null }, mergeStatusByRunId, serviceIds)).toEqual({
      kind: "merge",
      runId: "r-conflict",
      archived: false,
    });
    expect(resolveProcessAnchor({ run: "r-gate-failed", svc: null }, mergeStatusByRunId, serviceIds)).toEqual({
      kind: "merge",
      runId: "r-gate-failed",
      archived: false,
    });
    expect(resolveProcessAnchor({ run: "r-waiting", svc: null }, mergeStatusByRunId, serviceIds)).toEqual({
      kind: "merge",
      runId: "r-waiting",
      archived: false,
    });
  });

  it("unknown run -> null, silent", () => {
    expect(resolveProcessAnchor({ run: "r-ghost", svc: null }, mergeStatusByRunId, serviceIds)).toBeNull();
  });

  it("known svc, no run -> service anchor", () => {
    expect(resolveProcessAnchor({ run: null, svc: "run:acme/c1" }, mergeStatusByRunId, serviceIds)).toEqual({
      kind: "service",
      serviceId: "run:acme/c1",
    });
  });

  it("unknown svc -> null, silent", () => {
    expect(resolveProcessAnchor({ run: null, svc: "svc-ghost" }, mergeStatusByRunId, serviceIds)).toBeNull();
  });

  it("neither param -> null", () => {
    expect(resolveProcessAnchor({ run: null, svc: null }, mergeStatusByRunId, serviceIds)).toBeNull();
  });
});
