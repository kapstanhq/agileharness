// Shared platform gate for the runner's environment-bound suites (#1).
//
// A handful of runner suites drive REAL git (worktree add / merge / apply), systemd (systemctl scope
// kill / is-active) or POSIX path/binary resolution. They are faithful ONLY on a POSIX host. On win32
// they FALSE-fail (no systemd, CRLF + path-separator differences, git worktree/quoting quirks) — and that
// noise MASKS genuine regressions in the local full-run, so a dev on the notebook (Windows) can't trust a
// red suite. Gating them on win32 gives the notebook a reliable green signal; the VPS Linux gate
// (run_check) is the real CI and still runs every one of them.
//
// Use describePosix/itPosix exactly like describe/it — they SKIP (not fail) on win32, so the suites still
// report as skipped (visible), never silently dropped.

import { describe, it } from "vitest";

export const IS_WINDOWS = process.platform === "win32";

/** A describe block that runs only on a POSIX host (skipped on win32). For real-git / systemd suites. */
export const describePosix = describe.skipIf(IS_WINDOWS);

/** An individual test that runs only on a POSIX host (skipped on win32). For the odd POSIX-only case in an
 *  otherwise cross-platform suite. */
export const itPosix = it.skipIf(IS_WINDOWS);
