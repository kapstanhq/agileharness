import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect the approval sidecar dir to a throwaway tmp dir so the IO tests never touch the live storymap/boards.
const TMP = path.join(os.tmpdir(), "storymap-approvals-test");
vi.mock("@/lib/storymap/paths", () => ({
  approvalsDir: (board: string) => path.join(TMP, board),
  approvalPath: (board: string, id: string) => path.join(TMP, board, `${id}.json`),
}));

import {
  argsHash,
  canonicalArgs,
  consumeGrant,
  createApprovalRequest,
  decideApprovalRequest,
  findMatchingGrant,
  grantMatches,
  isExpired,
  readApprovalRequest,
  type ApprovalRequest,
} from "./approvals";

const T0 = 1_800_000_000_000; // fixed epoch for deterministic expiry
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});
afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("approvals — pure helpers (F5.4)", () => {
  it("canonicalArgs sorts keys recursively → equal args serialize identically regardless of key order", () => {
    expect(canonicalArgs({ b: 1, a: { y: 2, x: 3 } })).toBe(canonicalArgs({ a: { x: 3, y: 2 }, b: 1 }));
    expect(canonicalArgs({ a: 1 })).not.toBe(canonicalArgs({ a: 2 }));
  });

  it("argsHash is stable across key order and distinct for distinct args", () => {
    expect(argsHash({ board: "acme", status: "x" })).toBe(argsHash({ status: "x", board: "acme" }));
    expect(argsHash({ board: "acme" })).not.toBe(argsHash({ board: "tribi" }));
  });

  it("isExpired is true only past expiresAt", () => {
    const a = { expiresAt: new Date(T0 + DAY).toISOString() };
    expect(isExpired(a, T0)).toBe(false);
    expect(isExpired(a, T0 + DAY + 1)).toBe(true);
  });

  it("grantMatches: only a live GRANT with byte-identical args + same tool matches", () => {
    const base: ApprovalRequest = {
      v: 1, id: "apr-x", board: "acme", tool: "move_card",
      args: canonicalArgs({ board: "acme", cardId: "c1", status: "deploy" }),
      argsHash: argsHash({ board: "acme", cardId: "c1", status: "deploy" }),
      riskClass: "deploy", requestedBy: "run:orch",
      requestedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + DAY).toISOString(), status: "granted",
    };
    const call = { board: "acme", cardId: "c1", status: "deploy" };
    expect(grantMatches(base, "move_card", call, T0)).toBe(true);
    // key order of the call doesn't matter (canonicalized)
    expect(grantMatches(base, "move_card", { status: "deploy", cardId: "c1", board: "acme" }, T0)).toBe(true);
    // different tool / different args / pending / expired all fail
    expect(grantMatches(base, "delete_card", call, T0)).toBe(false);
    expect(grantMatches(base, "move_card", { ...call, status: "revisao" }, T0)).toBe(false);
    expect(grantMatches({ ...base, status: "pending" }, "move_card", call, T0)).toBe(false);
    expect(grantMatches(base, "move_card", call, T0 + DAY + 1)).toBe(false);
  });
});

describe("approvals — IO round-trip + atomic consume (F5.4)", () => {
  it("create → read (pending) → decide granted → find → consume once (CAS blocks the 2nd)", async () => {
    const args = { board: "acme", cardId: "c1", status: "publicar" };
    const req = await createApprovalRequest({ board: "acme", cardId: "c1", tool: "move_card", args, riskClass: "deploy", now: T0 });
    expect(req.status).toBe("pending");

    const read = await readApprovalRequest("acme", req.id);
    expect(read?.status).toBe("pending");
    expect(read?.argsHash).toBe(argsHash(args));

    // not grantable while pending
    expect(await findMatchingGrant("acme", "move_card", args, T0)).toBeNull();

    const granted = await decideApprovalRequest("acme", req.id, "granted", "human", undefined, T0);
    expect(granted?.status).toBe("granted");

    const grant = await findMatchingGrant("acme", "move_card", args, T0);
    expect(grant?.id).toBe(req.id);

    // FIRST consume wins; SECOND fails (already consumed) — a grant is one-shot
    expect(await consumeGrant("acme", req.id, "move_card", args, T0)).toBe(true);
    expect(await consumeGrant("acme", req.id, "move_card", args, T0)).toBe(false);
    expect((await readApprovalRequest("acme", req.id))?.status).toBe("consumed");
  });

  it("consume refuses args that don't match byte-for-byte (a forged re-call can't spend the grant)", async () => {
    const args = { board: "acme", status: "publicar" };
    const req = await createApprovalRequest({ board: "acme", tool: "move_card", args, riskClass: "deploy", now: T0 });
    await decideApprovalRequest("acme", req.id, "granted", "human", undefined, T0);
    // different args → consume fails and leaves the grant intact for the real call
    expect(await consumeGrant("acme", req.id, "move_card", { board: "acme", status: "OUTRA" }, T0)).toBe(false);
    expect((await readApprovalRequest("acme", req.id))?.status).toBe("granted");
    expect(await consumeGrant("acme", req.id, "move_card", args, T0)).toBe(true);
  });

  it("a rejected request never grants; an expired pending reads as expired", async () => {
    const a = await createApprovalRequest({ board: "acme", tool: "delete_card", args: { board: "acme", cardId: "c9" }, riskClass: "destructive", now: T0 });
    await decideApprovalRequest("acme", a.id, "rejected", "human", "não", T0);
    expect(await findMatchingGrant("acme", "delete_card", { board: "acme", cardId: "c9" }, T0)).toBeNull();

    const b = await createApprovalRequest({ board: "acme", tool: "move_card", args: { board: "acme", status: "x" }, riskClass: "run", now: T0 });
    const list = await import("./approvals").then((m) => m.listApprovalRequests("acme", T0 + 2 * DAY));
    expect(list.find((r) => r.id === b.id)?.status).toBe("expired");
  });
});
