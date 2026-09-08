import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mintNonce, NONCE_TTL_MS, revokeAllNonces, verifyNonce } from "./nonce-store";
import { runnerStateDir } from "@/lib/storymap/paths";

// SAFE to exercise for real: vitest.setup.ts redirects STORYMAP_RUNNER_STATE_DIR to a temp dir, so
// none of this touches the live service's operator state.
const NOW = 1_800_000_000_000;

describe("nonce store — the capability that opens the embed lane", () => {
  it("a freshly minted nonce verifies, and a made-up one does not", async () => {
    const { token, expiresAt } = await mintNonce(NOW);
    expect(expiresAt).toBe(NOW + NONCE_TTL_MS);
    expect(await verifyNonce(token, NOW)).toBe(true);
    expect(await verifyNonce(`${token}x`, NOW)).toBe(false);
    expect(await verifyNonce("not-a-real-nonce-value-at-all", NOW)).toBe(false);
  });

  it("expires on its own — a leaked nonce stops working without anyone acting", async () => {
    const { token } = await mintNonce(NOW);
    expect(await verifyNonce(token, NOW + NONCE_TTL_MS - 1)).toBe(true);
    expect(await verifyNonce(token, NOW + NONCE_TTL_MS + 1)).toBe(false);
  });

  it("rejects junk without throwing (a hostile header is just a string)", async () => {
    for (const junk of [null, undefined, 42, "", "short", "x".repeat(500), {}]) {
      expect(await verifyNonce(junk as unknown, NOW)).toBe(false);
    }
  });

  it("stores the nonce HASHED — the plaintext never lands on disk", async () => {
    const { token } = await mintNonce(NOW, "smoke");
    const raw = await readFile(path.join(runnerStateDir(), "feedback-nonces.json"), "utf8");
    expect(raw).not.toContain(token); // the token itself must not be recoverable from the file
    expect(raw).toContain("smoke"); // the label is fine
    expect(await verifyNonce(token, NOW)).toBe(true);
  });

  it("several nonces coexist (the operator can sanction more than one embed)", async () => {
    const a = await mintNonce(NOW);
    const b = await mintNonce(NOW);
    expect(await verifyNonce(a.token, NOW)).toBe(true);
    expect(await verifyNonce(b.token, NOW)).toBe(true);
  });

  it("revokeAll kills every live nonce (the panic button)", async () => {
    const { token } = await mintNonce(NOW);
    expect(await verifyNonce(token, NOW)).toBe(true);
    await revokeAllNonces();
    expect(await verifyNonce(token, NOW)).toBe(false);
  });
});
