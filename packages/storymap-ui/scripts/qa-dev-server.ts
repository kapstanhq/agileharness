#!/usr/bin/env bun
// qa-dev-server — the ISOLATED dev-server entrypoint the harness-qa dogfood path calls instead of the
// hard-coded `next dev -p 3008` scripts (story-koieb3 · process isolation).
//
// WHY this exists: `package.json` `dev`/`start` bind `next … -p 3008`, the LIVE storymap.service +
// autorun dispatcher port — and Next's `-p` flag OVERRIDES the PORT env var, so `PORT=3018 bun run
// dev` actually binds 3008 and collides with prod. This entrypoint instead derives a DETERMINISTIC,
// FREE, NEVER-3008 port from THIS run's id (resolveDevServerPort) and execs `next dev` bound to that
// port on 127.0.0.1 — bypassing the package.json `-p 3008` entirely.
//
// The skill greps the `QA_DEV_PORT=<port>` line this prints (no guessing). The dev server runs INSIDE
// the run's systemd scope (`harness-run-<id>.scope`); the engine tears the whole cgroup down at settle, so
// the agent never kills it by PID/port (the self-kill + prod-3008 vector this card fixes).
//
// HARDENING (story-koieb3 LOW edges):
//   (1) TOCTOU port: `-p <port>` DISABLES Next's own EADDRINUSE auto-retry, so a rare race between the
//       probe and the bind (another run grabbing the same free port) would FAIL the run. We catch an
//       EADDRINUSE startup exit, re-resolve a fresh free port, and respawn — bounded to MAX_PORT_ATTEMPTS.
//   (2) Binary resolution: resolve `next` to a PATH-INDEPENDENT invocation (resolveNextBinary), and on
//       a spawn 'error' (ENOENT) print a PATH hint instead of a bare stack.
//   (3) No-systemd teardown: write the `next dev` child PID to a run-scoped file (writeDevServerPid) so
//       the engine can reap it at settle even when systemd is absent (no scope to stop). Cleaned on exit.
//
// Usage:  bun packages/storymap-ui/scripts/qa-dev-server.ts   (run from the worktree's storymap-ui)
//   env:  STORYMAP_AUTORUN_RUN_ID  — the run's sessionId (the engine injects it on every spawn);
//                                    falls back to a per-process id so a manual invocation still works.

import { spawn, type ChildProcess } from "node:child_process";
import {
  resolveDevServerPort,
  resolveNextBinary,
  writeDevServerPid,
  devServerPidFile,
  STORYMAP_PROD_PORT,
} from "../src/lib/storymap/runner/dev-server";
import { unlinkSync } from "node:fs";

// Bounded so a genuinely saturated box surfaces a failure instead of respawning forever.
const MAX_PORT_ATTEMPTS = 3;

// EADDRINUSE can surface either as the spawn 'error' code or in Next's startup stderr — match both.
const EADDRINUSE_RE = /EADDRINUSE|address already in use|port \d+ is in use/i;

async function main() {
  // The engine injects STORYMAP_AUTORUN_RUN_ID on every autorun spawn (engine.ts) — that IS the
  // sessionId, so the derived port is stable across a re-run/resume of the same card. A manual
  // invocation (no env) falls back to a per-process id so the script still serves a free port.
  const runId = process.env.STORYMAP_AUTORUN_RUN_ID || `manual-${process.pid}`;

  // EDGE 2: resolve `next` ONCE (PATH-independent) — reused across port retries.
  const nextBin = resolveNextBinary(process.cwd());
  const pidFile = devServerPidFile(runId);

  // EDGE 1: bounded port-retry loop. attemptDevServer resolves with the EXIT CODE we should propagate,
  // or the sentinel RETRY when an EADDRINUSE startup demands a fresh port + respawn.
  const RETRY = Symbol("retry-port");
  type AttemptOutcome = number | typeof RETRY;

  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    let port: number;
    try {
      port = await resolveDevServerPort(runId);
    } catch (err) {
      console.error(
        `[qa-dev-server] não encontrou porta livre: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
      return;
    }

    // Belt-and-suspenders (the guard already lives in resolveDevServerPort): never proceed on 3008.
    if (port === STORYMAP_PROD_PORT) {
      console.error(
        `[qa-dev-server] guard: porta resolvida é ${STORYMAP_PROD_PORT} (prod) — abortando`,
      );
      process.exit(1);
      return;
    }

    const outcome = await attemptDevServer(nextBin, port, runId, pidFile, attempt, RETRY, EADDRINUSE_RE);
    if (outcome !== RETRY) {
      process.exit(outcome as number);
      return;
    }
    // RETRY: the deterministic port lost a TOCTOU race — log + loop to re-resolve a fresh free port.
    console.error(
      `[qa-dev-server] porta ${port} ocupada na hora do bind (corrida TOCTOU) — re-resolvendo (tentativa ${attempt + 1}/${MAX_PORT_ATTEMPTS})`,
    );
  }

  console.error(
    `[qa-dev-server] esgotou ${MAX_PORT_ATTEMPTS} tentativas de porta (todas colidiram no bind) — abortando`,
  );
  process.exit(1);
}

/**
 * Spawn one `next dev` bound to 127.0.0.1:<port>. Resolves with the child's exit code to propagate, OR
 * the `retry` sentinel when the child died at startup with an EADDRINUSE (so the caller re-resolves the
 * port). Writes the child PID to the run-scoped file (EDGE 3) and cleans it on exit.
 */
function attemptDevServer(
  nextBin: ReturnType<typeof resolveNextBinary>,
  port: number,
  runId: string,
  pidFile: string,
  attempt: number,
  retry: symbol,
  eaddrinuseRe: RegExp,
): Promise<number | symbol> {
  return new Promise((resolve) => {
    // Bind the LOOPBACK (not 0.0.0.0) so the ephemeral instance is never internet-exposed. Spawn the
    // resolved runtime + next entrypoint (NO shell, PATH-independent). cwd = the worktree's storymap-ui.
    const child: ChildProcess = spawn(
      nextBin.runtime,
      [...nextBin.prefix, "dev", "-H", "127.0.0.1", "-p", String(port)],
      { cwd: process.cwd(), stdio: ["inherit", "inherit", "pipe"], env: process.env },
    );

    // EDGE 3: record the child PID so the engine reaps it at settle even with no systemd scope.
    if (typeof child.pid === "number") writeDevServerPid(runId, child.pid);

    // The skill greps THIS line — keep it exact + on its own line. Print AFTER spawn so a port that
    // dies instantly at bind doesn't advertise itself as serving.
    console.log(`QA_DEV_PORT=${port}`);

    let sawEaddrinuse = false;
    let settled = false;
    const cleanup = () => {
      try {
        unlinkSync(pidFile);
      } catch {
        /* best-effort: engine reap / scope teardown also covers it */
      }
    };

    // Tee stderr so readiness/errors still stream to the agent AND we can sniff for EADDRINUSE.
    child.stderr?.on("data", (d) => {
      const text = String(d);
      if (eaddrinuseRe.test(text)) sawEaddrinuse = true;
      process.stderr.write(text);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      // EDGE 1: a startup EADDRINUSE (Next can't bind the explicit -p port) → ask the caller to retry.
      // Only on a non-zero/abnormal exit (a clean exit isn't a port collision).
      if (sawEaddrinuse && (code ?? 0) !== 0 && attempt < MAX_PORT_ATTEMPTS) {
        resolve(retry);
        return;
      }
      // Mirror the child's signal so the scope/process tree settles cleanly; else propagate the code.
      if (signal) {
        process.kill(process.pid, signal);
        resolve(0); // process.kill above ends us; this resolve is unreachable in practice
      } else {
        resolve(code ?? 0);
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      const msg = err instanceof Error ? err.message : String(err);
      // EDGE 2: ENOENT means the resolved `next` runtime/entrypoint wasn't found → print a PATH hint
      // so the operator fixes the env instead of chasing a bare stack.
      if (/ENOENT/.test(msg) || (err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(
          `[qa-dev-server] falha ao iniciar next dev: binário não encontrado (${msg}).\n` +
            `  Rode a partir de packages/storymap-ui com as deps instaladas (bun install), ou garanta\n` +
            `  que node_modules/.bin está no PATH. Tentou runtime='${nextBin.runtime}' args=[${nextBin.prefix.join(", ")}].`,
        );
      } else {
        console.error(`[qa-dev-server] falha ao iniciar next dev: ${msg}`);
      }
      resolve(1);
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
