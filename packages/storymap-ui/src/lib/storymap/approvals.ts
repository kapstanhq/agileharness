// F5.4 — APPROVAL REQUESTS: the human-in-the-loop grant store that lets a SCOPED agent (the autonomous tick,
// token `write`) act on an `ask`-disposition tool call. When the guard (register.ts, 5.2) resolves a call to
// `ask`, it mints an ApprovalRequest sidecar (boards/<board>/approvals/<id>.json) and returns a pending result;
// the human grants/rejects it on Inbox (or via approve_action/reject_action — full-only tools); on the next
// try the guard finds the GRANT, validates the args byte-for-byte, CONSUMES it atomically (one grant = one
// action), and lets the call through. Modeled on the GovernanceDraft sidecar loop.
//
// The pure helpers (canonicalArgs / argsHash / isExpired / grantMatches) are exported for unit tests; the IO
// (create/list/read/decide/consume) uses the sidecars.ts atomic-file discipline. Consume is a rename-CAS so
// two concurrent turns can never spend the same grant.

import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { approvalPath, approvalsDir } from "@/lib/storymap/paths";
import type { RiskClass } from "@/lib/storymap/types";

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // a grant is valid for 24h, then lazily expires

export type ApprovalStatus = "pending" | "granted" | "rejected" | "consumed" | "expired";

export interface ApprovalRequest {
  v: 1;
  id: string;
  board: string;
  cardId?: string;
  /** the tool the scoped agent wants to run (or the pseudo-tool "move_card" / "accept_triage" for a move gate). */
  tool: string;
  /** the canonicalized args JSON (≤2KB) — the PROOF re-validated byte-for-byte on consume, not just the hash. */
  args: string;
  /** sha256 over `args` — the index the guard looks a grant up by. */
  argsHash: string;
  riskClass: RiskClass;
  requestedBy: string; // "run:orch" (the scoped actor) — cosmetic attribution
  requestedAt: string; // ISO
  expiresAt: string; // ISO (requestedAt + TTL)
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

// ── PURE helpers (exported for tests) ──────────────────────────────────────────────────────────────

/** Deterministic JSON of an args object — keys sorted recursively, so equal args hash + compare identically. */
export function canonicalArgs(args: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = norm(o[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(args) ?? null);
}

/** sha256 (hex) over the canonical args — the grant index. */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalArgs(args)).digest("hex");
}

/** Is an approval past its TTL, at `now`? */
export function isExpired(a: Pick<ApprovalRequest, "expiresAt">, now: number): boolean {
  const t = Date.parse(a.expiresAt);
  return Number.isFinite(t) && now > t;
}

/**
 * Does a stored approval GRANT the given tool+args call, at `now`? True only when it is a live GRANT for the
 * SAME tool whose args match BYTE-FOR-BYTE (the hash is the index; the canonical args are the proof) and it
 * hasn't expired. A pending/rejected/consumed/expired request never grants. PURE.
 */
export function grantMatches(a: ApprovalRequest, tool: string, args: unknown, now: number): boolean {
  return (
    a.status === "granted" &&
    a.tool === tool &&
    !isExpired(a, now) &&
    a.argsHash === argsHash(args) &&
    a.args === canonicalArgs(args)
  );
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────────────────

function coerce(id: string, raw: unknown): ApprovalRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.tool !== "string" || typeof o.board !== "string") return null;
  return { ...(o as unknown as ApprovalRequest), id };
}

/** Mint a PENDING approval request for a scoped agent's `ask` call and write its sidecar. Returns the record. */
export async function createApprovalRequest(input: {
  board: string;
  cardId?: string;
  tool: string;
  args: unknown;
  riskClass: RiskClass;
  requestedBy?: string;
  now?: number;
}): Promise<ApprovalRequest> {
  const now = input.now ?? Date.now();
  const id = `apr-${randomUUID().slice(0, 12)}`;
  const rec: ApprovalRequest = {
    v: 1,
    id,
    board: input.board,
    ...(input.cardId ? { cardId: input.cardId } : {}),
    tool: input.tool,
    args: canonicalArgs(input.args).slice(0, 2048),
    argsHash: argsHash(input.args),
    riskClass: input.riskClass,
    requestedBy: input.requestedBy ?? "run:orch",
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    status: "pending",
  };
  await fs.mkdir(approvalsDir(input.board), { recursive: true });
  await fs.writeFile(approvalPath(input.board, id), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  return rec;
}

export async function readApprovalRequest(board: string, id: string): Promise<ApprovalRequest | null> {
  try {
    return coerce(id, JSON.parse(await fs.readFile(approvalPath(board, id), "utf8")));
  } catch {
    return null;
  }
}

/** All approval sidecars for a board, with lazily-expired ones reported as status "expired" (not rewritten). */
export async function listApprovalRequests(board: string, now = Date.now()): Promise<ApprovalRequest[]> {
  let files: string[];
  try {
    files = await fs.readdir(approvalsDir(board));
  } catch {
    return [];
  }
  const out: ApprovalRequest[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const rec = await readApprovalRequest(board, f.slice(0, -5));
    if (!rec) continue;
    out.push((rec.status === "pending" || rec.status === "granted") && isExpired(rec, now) ? { ...rec, status: "expired" } : rec);
  }
  return out;
}

/** Human decision: a PENDING request → granted | rejected. No-op (returns null) when absent/not pending/expired. */
export async function decideApprovalRequest(
  board: string,
  id: string,
  decision: "granted" | "rejected",
  decidedBy: string,
  note?: string,
  now = Date.now(),
): Promise<ApprovalRequest | null> {
  const rec = await readApprovalRequest(board, id);
  if (!rec || rec.status !== "pending" || isExpired(rec, now)) return null;
  const next: ApprovalRequest = {
    ...rec,
    status: decision,
    decidedBy,
    decidedAt: new Date(now).toISOString(),
    ...(note ? { note } : {}),
  };
  await fs.writeFile(approvalPath(board, id), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Block until a pending ApprovalRequest is DECIDED (granted/rejected) or expires, or the timeout elapses —
 * modeled on wait_for_run (an event-ish wait via short polls, not a busy spin). Returns the final record
 * (its status tells the agent what to do next), or null when the request vanished. Caps the timeout at 10min.
 */
export async function waitForApprovalDecision(
  board: string,
  id: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<ApprovalRequest | null> {
  const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 120_000, 1000), 600_000);
  const pollMs = Math.min(Math.max(opts?.pollMs ?? 2000, 250), 10_000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = await readApprovalRequest(board, id);
    if (!rec) return null;
    if (rec.status !== "pending") return rec;
    if (isExpired(rec, Date.now())) return { ...rec, status: "expired" };
    if (Date.now() >= deadline) return rec; // still pending → timed out; the agent should NOT spin-wait
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Find a live GRANT for a scoped call (tool+args), or null. Lazily ignores expired. */
export async function findMatchingGrant(board: string, tool: string, args: unknown, now = Date.now()): Promise<ApprovalRequest | null> {
  for (const a of await listApprovalRequests(board, now)) {
    if (grantMatches(a, tool, args, now)) return a;
  }
  return null;
}

/**
 * ATOMIC consume of a grant (one grant = one action). Renames the sidecar to a `.consuming` lock FIRST — the
 * rename is the compare-and-swap: a second concurrent consumer hits ENOENT and returns false. Re-validates the
 * grant (status granted + args byte-for-byte + not expired) AFTER acquiring the lock; on mismatch it restores
 * the file and returns false. On success it rewrites the sidecar as `consumed`. Returns whether it consumed.
 */
export async function consumeGrant(board: string, id: string, tool: string, args: unknown, now = Date.now()): Promise<boolean> {
  const src = approvalPath(board, id);
  const lock = `${src}.consuming`;
  try {
    await fs.rename(src, lock); // CAS: only one caller wins the rename; the loser gets ENOENT
  } catch {
    return false;
  }
  try {
    const rec = coerce(id, JSON.parse(await fs.readFile(lock, "utf8")));
    if (!rec || !grantMatches(rec, tool, args, now)) {
      await fs.rename(lock, src).catch(() => {}); // restore — not ours to consume
      return false;
    }
    const consumed: ApprovalRequest = { ...rec, status: "consumed" };
    await fs.writeFile(src, `${JSON.stringify(consumed, null, 2)}\n`, "utf8");
    await fs.rm(lock, { force: true }).catch(() => {});
    return true;
  } catch {
    await fs.rename(lock, src).catch(() => {});
    return false;
  }
}
