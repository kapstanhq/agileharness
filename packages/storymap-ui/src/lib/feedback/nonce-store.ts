// F5 — the board-issued NONCE that authorises the cross-origin embed lane.
//
// The problem it solves: a page on mosaico.app has no board credentials (the board sits behind Caddy
// basic_auth on another origin, and a browser would not send those cross-origin anyway). So the
// embed proves it was SANCTIONED instead: the operator — who can reach the board — mints a nonce and
// hands it to the embed (?ah-nonce=… / config). Possession of a nonce is the capability.
//
// Design notes:
//  • STATEFUL, not a signed token: no new secret to manage, and revocation is `rm` on one file.
//  • Stored HASHED (sha256). The file lives in the runner state dir (operator state, gitignored, the
//    same home as terminal-prefs) — but a leaked file still must not yield usable tokens.
//  • Expiry is enforced on read AND the store is GC'd on every write, so it cannot grow unbounded.
//  • Absent file / unreadable JSON ⇒ "no valid nonces" (fail CLOSED — never fail open into the lane).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";

/** A work-session's worth of validity. Long enough not to be a nuisance, short enough that a leaked
 *  nonce stops working on its own. */
export const NONCE_TTL_MS = 8 * 60 * 60 * 1000;

interface StoredNonce {
  /** sha256 of the token — the plaintext is shown ONCE, at mint time, and never persisted. */
  hash: string;
  expiresAt: number;
  label?: string;
}

interface NonceFile {
  v: 1;
  nonces: StoredNonce[];
}

function noncesPath(): string {
  return path.join(runnerStateDir(), "feedback-nonces.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function load(): Promise<StoredNonce[]> {
  try {
    const raw = await readFile(noncesPath(), "utf8");
    const parsed = JSON.parse(raw) as NonceFile;
    if (!parsed || !Array.isArray(parsed.nonces)) return [];
    return parsed.nonces.filter(
      (n) => n && typeof n.hash === "string" && typeof n.expiresAt === "number",
    );
  } catch {
    return []; // missing/corrupt ⇒ no valid nonces (fail closed)
  }
}

async function save(nonces: StoredNonce[]): Promise<void> {
  const dir = runnerStateDir();
  await mkdir(dir, { recursive: true });
  const body: NonceFile = { v: 1, nonces };
  await writeFile(noncesPath(), JSON.stringify(body, null, 2), "utf8");
}

/** Mint a nonce. Returns the PLAINTEXT token — the only time it exists outside the caller. */
export async function mintNonce(now: number, label?: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = now + NONCE_TTL_MS;
  const live = (await load()).filter((n) => n.expiresAt > now); // GC on write
  live.push({ hash: hashToken(token), expiresAt, ...(label ? { label } : {}) });
  await save(live);
  return { token, expiresAt };
}

/**
 * Is this token a live nonce? Compared in constant time against each stored hash — the hashes are
 * fixed-length hex, so a length-mismatch short-circuit leaks nothing.
 */
export async function verifyNonce(token: unknown, now: number): Promise<boolean> {
  if (typeof token !== "string" || token.length < 16 || token.length > 200) return false;
  const candidate = Buffer.from(hashToken(token), "hex");
  for (const n of await load()) {
    if (n.expiresAt <= now) continue;
    let stored: Buffer;
    try {
      stored = Buffer.from(n.hash, "hex");
    } catch {
      continue;
    }
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) return true;
  }
  return false;
}

/** Drop every nonce — the panic button ("I pasted it somewhere I shouldn't have"). */
export async function revokeAllNonces(): Promise<void> {
  await save([]);
}
