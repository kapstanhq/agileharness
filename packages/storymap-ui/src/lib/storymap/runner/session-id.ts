// Session id for a card's headless run. Each run gets a FRESH random UUID so a
// RE-RUN of the same card never collides with a prior `--session-id` (the Claude
// CLI rejects "Session ID … is already in use"). The runner registry remembers the
// latest id per card (RunnerRegistry.lastSessionId) so the console can still surface
// `claude --resume <id>` after the run ends or the page reloads — within the dev
// server's lifetime (the ids are not persisted to disk).
//
// SERVER-ONLY (node:crypto). Imported by the runner engine.

import { randomUUID } from "node:crypto";

/** A fresh, collision-free session id for one headless run. */
export function newRunSessionId(): string {
  return randomUUID();
}

/**
 * A short, collision-resistant discriminator that makes a run's systemd scope name UNIQUE per
 * INVOCATION. The scope was historically named `harness-run-<sessionId>.scope`, but a RESUMED step
 * (`claude --resume <sessionId>`) reuses the sessionId → the same scope name → the previous step's
 * scope teardown could SIGKILL the next step launched into the same-named scope (story-olr777, the
 * failure that mis-recorded as "oom-killed"). A fresh nonce per launch makes every activation's
 * cgroup uniquely addressable. `[0-9a-f]` only → still passes the `harness-run-*.scope` kill guard.
 */
export function newScopeNonce(): string {
  return randomUUID().slice(0, 8);
}
