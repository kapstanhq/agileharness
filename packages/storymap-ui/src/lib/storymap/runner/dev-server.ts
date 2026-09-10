// Dev-server port helper for the dogfood QA path (story-koieb3 · process isolation).
//
// The PROBLEM this solves: when harness-qa dogfoods the `storymap` board it must serve storymap-ui
// FROM the run's worktree to drive a visual sweep. The package's `dev`/`start` scripts HARD-CODE
// `next … -p 3008` (the LIVE storymap.service + autorun dispatcher), and Next's `-p` flag OVERRIDES
// the PORT env var (https://nextjs.org/docs/pages/api-reference/cli/next) — so the old skill recipe
// `PORT=3018 bun run dev` actually bound 3008, colliding with prod. The agent then "fixed" the
// collision by killing processes by loose PID, which both risked the prod service AND SIGTERM'd its
// OWN process tree (the self-kill in run 6996dac9).
//
// The FIX is a deterministic, FREE, NEVER-3008 port chosen here (not in a shell), plus a structural
// guard that REFUSES to ever touch 3008. Mirrors governor.ts: every function is PURE / dependency-
// injected (the port probe is injectable), so the whole module unit-tests on Bun with NO real
// sockets and NO real systemd.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

/**
 * The ONE port the prod AgileHarness service (`storymap.service`, `next start -p 3008`) + the autorun
 * dispatcher bind. Named once so the guard below is the single source of "the port we must never
 * touch". An ephemeral QA dev server binding this would collide with the live board (the koieb3 bug).
 */
export const PROD_PORT = 3008;

/**
 * The ephemeral range the QA dev server picks from: [3100, 3899]. Chosen to sit ABOVE every dev-all
 * / emulator port the box uses (3001/3002/3003/3004/3005/3006/3007/3008 web · 4000 UI · 5001/5003/
 * 5005/5010/5015 functions · 8080-8084 firestore · 9099 auth — see .claude/rules/dev-environment.md)
 * AND above the prod 3008, so a derived port is structurally clear of both. If a future port
 * assignment lands in 3100-3899, MOVE it or widen this range — the probe still guards collisions, but
 * a clear base keeps the deterministic first pick free.
 */
export const EPHEMERAL_PORT_BASE = 3100;
export const EPHEMERAL_PORT_SPAN = 800; // → highest derived base = 3899

/**
 * A DETERMINISTIC port derived from a run's sessionId, so the SAME run always targets the SAME port:
 * re-runs / resumes are idempotent and the port is addressable in logs (vs a non-deterministic
 * OS-assigned port-0). FNV-1a over the id's chars (pure, no crypto import) → `base + (hash % span)`.
 * Structurally in [3100, 3899] (base=3100 > 3008), so it can never EQUAL the prod port — but we add 1
 * as a belt-and-suspenders if it somehow does. Pure — exported for tests.
 */
export function ephemeralPortForRun(sessionId: string, base = EPHEMERAL_PORT_BASE, span = EPHEMERAL_PORT_SPAN): number {
  // FNV-1a 32-bit. `>>> 0` keeps the running hash an unsigned 32-bit int (Math.imul is the 32-bit
  // multiply); no Node crypto so this stays a zero-dependency pure function.
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const port = base + (hash % span);
  // Cannot trigger while base > PROD_PORT, but assert the invariant rather than assume it.
  return port === PROD_PORT ? port + 1 : port;
}

/**
 * The fail-early collision guard (AC3): THROW if a port equals the prod 3008. The single chokepoint
 * the dev-server entrypoint asserts BEFORE it ever binds — so an ephemeral QA server can never bind
 * (and the agent can never be told to kill) the live storymap.service port. Pure — exported for tests.
 */
export function assertNotProdPort(port: number): void {
  if (port === PROD_PORT) {
    throw new Error(
      `guard: recusando porta ${PROD_PORT} (serviço prod storymap.service + dispatcher de autorun)`,
    );
  }
}

/**
 * A probe of whether a port is FREE to bind. Injectable (DI) so the port resolver unit-tests without
 * real sockets — `resolveDevServerPort` takes a probe, prod gets {@link defaultPortProbe}.
 * Resolves `true` when the port is free, `false` when it's taken (EADDRINUSE / EACCES).
 */
export type PortProbe = (port: number) => Promise<boolean>;

/**
 * The real probe: try to bind a throwaway server on `127.0.0.1:<port>`; if it binds, the port is free
 * (close it and resolve true); EADDRINUSE/EACCES → taken (resolve false). Binds the LOOPBACK only —
 * symmetric with the dev server, which serves on 127.0.0.1 (never internet-exposed). Pattern per
 * https://devops-daily.com/posts/how-to-find-available-port . Not exercised by unit tests (they inject
 * a fake probe) — covered by the manual/dogfood smoke.
 */
export const defaultPortProbe: PortProbe = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false)); // EADDRINUSE / EACCES → taken
    server.once("listening", () => {
      server.close(() => resolve(true)); // bound cleanly → free
    });
    server.listen(port, "127.0.0.1");
  });

export interface ResolveDevServerPortOptions {
  /** How many candidate ports to probe before giving up (default 64 — covers a busy box). */
  maxTries?: number;
  base?: number;
  span?: number;
}

/**
 * Resolve a GUARANTEED-free, NEVER-3008 port for this run's dev server. Starts at the deterministic
 * {@link ephemeralPortForRun}, asserts it's not the prod port, then probes; if taken, steps +1
 * (SKIPPING 3008, though the range never reaches it) up to `maxTries` candidates, returning the first
 * free one. Throws if every candidate is occupied (a genuinely saturated box — surfaced, never a
 * silent fall-through to 3008). The probe is injected so tests are hermetic (no real sockets). The
 * first probed port equals `ephemeralPortForRun(sessionId)` so the same run is addressable across
 * restarts when that port is free.
 */
export async function resolveDevServerPort(
  sessionId: string,
  probe: PortProbe = defaultPortProbe,
  opts: ResolveDevServerPortOptions = {},
): Promise<number> {
  const base = opts.base ?? EPHEMERAL_PORT_BASE;
  const span = opts.span ?? EPHEMERAL_PORT_SPAN;
  const maxTries = opts.maxTries ?? 64;
  const start = ephemeralPortForRun(sessionId, base, span);
  for (let i = 0; i < maxTries; i++) {
    // Wrap with the span so a candidate near the top of the range walks back to `base` instead of
    // marching into emulator/system ports above 3899.
    let candidate = base + ((start - base + i) % span);
    if (candidate === PROD_PORT) candidate += 1; // structurally unreachable in-range, but never bind 3008
    assertNotProdPort(candidate); // hard guard: a free 3008 is STILL refused (it's the prod service)
    if (await probe(candidate)) return candidate;
  }
  throw new Error(
    `resolveDevServerPort: nenhuma porta livre em ${maxTries} tentativas a partir de ${start} (faixa ${base}-${base + span - 1})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// story-koieb3 hardening — EDGE 2: explicit `next` binary resolution.
//
// qa-dev-server spawns `next` WITHOUT shell:true, so it relied on the process PATH carrying
// `node_modules/.bin`. That holds when launched via `bun run`/`just`, but a bare spawn from a
// foreign cwd (or a stripped PATH) can't find `next` → ENOENT and the QA dev server never boots.
// Resolve the REAL JS entrypoint (`next/dist/bin/next`) and run it under THIS runtime
// (process.execPath = bun/node), which is PATH-independent. Falls back to the conventional
// `node_modules/.bin/next` shim only if the package export can't be resolved.
// ─────────────────────────────────────────────────────────────────────────────

export interface NextBinary {
  /** The runtime to exec (process.execPath = the bun/node binary already running this script). */
  runtime: string;
  /** Argv prefix: the resolved next entrypoint, then the subcommand args the caller appends. */
  prefix: string[];
}

/**
 * Resolve the `next` CLI to a PATH-INDEPENDENT invocation. Prefers `require.resolve('next/dist/bin/next')`
 * (the real JS entrypoint, run under the current runtime), so it works from any cwd with any PATH.
 * Falls back to `<cwd>/node_modules/.bin/next` (the shim) when the package export can't be resolved.
 * `fromDir` defaults to the cwd; tests inject a fake resolver + existsSync. Pure (no spawn) — exported.
 */
export function resolveNextBinary(
  fromDir: string = process.cwd(),
  deps: {
    resolve?: (id: string) => string;
    existsSync?: (p: string) => boolean;
    execPath?: string;
  } = {},
): NextBinary {
  const execPath = deps.execPath ?? process.execPath;
  const existsSyncFn = deps.existsSync ?? fs.existsSync;
  const resolveFn =
    deps.resolve ?? createRequire(path.join(fromDir, "noop.js")).resolve;
  try {
    // The package's real bin entrypoint — run it under the current runtime (PATH-independent).
    const entry = resolveFn("next/dist/bin/next");
    return { runtime: execPath, prefix: [entry] };
  } catch {
    // Fall back to the conventional shim. If even that is missing we still return it — the caller's
    // spawn 'error' handler prints the PATH hint, which is the correct failure surface.
    const shim = path.join(fromDir, "node_modules", ".bin", "next");
    if (existsSyncFn(shim)) return { runtime: shim, prefix: [] };
    // Last resort: bare `next`, leaning on PATH — the 'error' handler explains if it's absent.
    return { runtime: "next", prefix: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// story-koieb3 hardening — EDGE 3: no-systemd fallback teardown via a run-scoped PID file.
//
// When systemd is ABSENT (scopeApplied=false) the engine can't reap the run's cgroup scope, so a
// dev server the agent detached out of killTree's process group would LEAK (the orphan 3009 symptom).
// Fix: qa-dev-server writes its `next dev` child PID to a DETERMINISTIC, run-scoped file; the engine
// reaps that PID's whole process GROUP at settle (best-effort, bounded, never throwing). The path is
// derived from the runId alone, so the engine reaps it WITHOUT any IPC. This complements — never
// replaces — the scope reap: when scoped, the file may be absent (a no-op); when unscoped, it's the
// only teardown. It can NEVER touch 3008: it only ever signals the EXACT pid qa-dev-server recorded.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The deterministic run-scoped PID file for a run's QA dev server. Under the OS temp dir, keyed by the
 * SANITIZED runId, so the writer (qa-dev-server) and the reaper (engine settle) agree with NO IPC.
 * The runId is constrained to the slug charset so it can never escape the temp dir. Pure — exported.
 */
export function devServerPidFile(runId: string, tmpDir: string = os.tmpdir()): string {
  const safe = String(runId ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 120) || "unknown";
  return path.join(tmpDir, `storymap-qa-devserver-${safe}.pid`);
}

/**
 * Record the QA dev server's child PID so the engine can reap it at settle even with no systemd.
 * Best-effort: a write failure (read-only tmp, race) is swallowed — the scope reap (when present)
 * still covers teardown, and a leaked dev server is a degraded-but-safe outcome, never a crash.
 * DI fs for tests. Returns the file path written (for logging), or null on failure.
 */
export function writeDevServerPid(
  runId: string,
  pid: number,
  deps: { writeFileSync?: (p: string, data: string) => void; tmpDir?: string } = {},
): string | null {
  const file = devServerPidFile(runId, deps.tmpDir);
  const write = deps.writeFileSync ?? ((p: string, data: string) => fs.writeFileSync(p, data, "utf8"));
  try {
    write(file, String(pid));
    return file;
  } catch {
    return null;
  }
}

export interface ReapPidResult {
  acted: boolean;
  reason: string;
  pid?: number;
}

/**
 * O `/proc/<pid>/cmdline` (campos separados por NUL), ou null quando não há como ler — processo morto,
 * thread de kernel, ou plataforma sem /proc. Injetável para teste.
 */
export type ReadCmdline = (pid: number) => string | null;

const readCmdlineFromProc: ReadCmdline = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null; // morto, inexistente, ou sem /proc — em todos os casos "não sei", que é o que importa
  }
};

/**
 * Este PID é PLAUSIVELMENTE o dev server do QA? PURA.
 *
 * POR QUE ISTO PRECISA EXISTIR — o número gravado não significa a mesma coisa nos dois lados. Quem grava
 * é o `qa-dev-server`, que sob contenção roda DENTRO da jaula e num PID namespace próprio: medido, os
 * PIDs de lá são 22, 34, 41, 56. Quem lê é o engine, que roda NO HOST. Um `kill(-22)` no host não atinge
 * o dev server de ninguém — atinge o grupo de processos 22 DO HOST, que é outra coisa inteiramente.
 *
 * Hoje isso não dispara, e por acidente: medido, `/tmp` é READ-ONLY dentro da jaula e o `TMPDIR` de lá
 * aponta para `/tmp/claude-0`, então o arquivo do escritor e o caminho do leitor nunca coincidem e o
 * reaper devolve `no-pid-file` para sempre. Um acidente não é uma guarda: bastaria alguém "consertar" o
 * descasamento de caminho — ou acrescentar `/tmp` ao allowWrite — para que o engine passasse a mandar
 * SIGTERM em grupos de processos arbitrários do host. Esta função é a guarda que faltava.
 *
 * O critério é o cmdline do processo que se pretende matar: o dev server é spawnado como
 * `<runtime> [...prefix] dev -H 127.0.0.1 -p <porta>`, então `next` e `127.0.0.1` estão ambos lá. Uma
 * thread de kernel tem cmdline VAZIO e nunca casa; um processo reaproveitando o PID quase nunca casa —
 * o que também fecha, de graça, o risco clássico de reuso de PID, que já existia antes da contenção.
 *
 * A DIREÇÃO DO ERRO é deliberada e é o oposto da do resto deste módulo: aqui, na dúvida, NÃO mata. Um
 * dev server vazado é degradado-mas-seguro (e o cgroup do systemd ainda o pega quando há scope); um
 * SIGTERM no processo errado do host não tem volta. O custo é que, se o cmdline do `next` mudar um dia,
 * o reaper para de agir — por isso ele devolve `pid-nao-confere` em vez de `reaped`, e o chamador loga:
 * o modo de falha desta guarda tem de ser VISÍVEL, não silencioso.
 */
export function cmdlineIsQaDevServer(cmdline: string | null): boolean {
  if (!cmdline) return false;
  const s = cmdline.replace(/\0/g, " ").toLowerCase();
  return s.includes("next") && s.includes("127.0.0.1");
}

/**
 * The no-systemd fallback teardown: read the run's recorded QA dev-server PID and kill its whole
 * PROCESS GROUP (negative pid → reaches grandchildren `next dev` forks), then delete the file.
 * SAFETY:
 *   - signals ONLY the exact pid qa-dev-server recorded for THIS run (never a scanned/loose pid),
 *     so it can never reach the prod 3008 service or a sibling run;
 *   - a missing/empty/garbage file, a dead pid (ESRCH), or any kill error is a harmless no-op — it
 *     NEVER throws into the engine's settle finally;
 *   - win32 has no process groups → falls back to a bare-pid kill, still only the recorded pid.
 * `kill`/fs are injected so the engine's settle reap is unit-testable with no real processes. Async
 * only to mirror stopRunScope's shape (no real await needed). Exported for tests.
 */
export async function reapDevServerPid(
  runId: string,
  deps: {
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
    readFileSync?: (p: string) => string;
    unlinkSync?: (p: string) => void;
    readCmdline?: ReadCmdline;
    tmpDir?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ReapPidResult> {
  const file = devServerPidFile(runId, deps.tmpDir);
  const readFileSyncFn = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const unlinkSyncFn = deps.unlinkSync ?? fs.unlinkSync;
  const killFn = deps.kill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
  const readCmdlineFn = deps.readCmdline ?? readCmdlineFromProc;
  const platform = deps.platform ?? process.platform;

  let raw: string;
  try {
    raw = readFileSyncFn(file);
  } catch {
    return { acted: false, reason: "no-pid-file" }; // nothing recorded → nothing to reap
  }
  const pid = Number.parseInt(String(raw).trim(), 10);
  // Reject non-positive / non-finite pids: a negative pid would signal a whole GROUP we never chose,
  // and 0/NaN are meaningless — fail safe, just clean the file.
  if (!Number.isInteger(pid) || pid <= 1) {
    try { unlinkSyncFn(file); } catch { /* best-effort */ }
    return { acted: false, reason: "bad-pid" };
  }
  // A GUARDA DE ATRIBUIÇÃO — ver {@link cmdlineIsQaDevServer}. Só onde há `/proc` para consultar: em
  // linux o cmdline é a fonte da verdade, e um vazio (thread de kernel, processo já morto) RECUSA, que é
  // a direção segura para uma operação que manda sinal. Noutras plataformas não há como verificar barato,
  // então o comportamento fica como era — limitação nomeada, não esquecida. A contenção do SO só existe
  // em linux hoje, e é ela que cria o descasamento de PID namespace que esta guarda fecha.
  if (platform === "linux") {
    const cmdline = readCmdlineFn(pid);
    if (!cmdlineIsQaDevServer(cmdline)) {
      try { unlinkSyncFn(file); } catch { /* best-effort */ }
      return { acted: false, reason: cmdline ? "pid-nao-confere" : "pid-ausente", pid };
    }
  }
  try {
    if (platform === "win32") {
      // No process groups on win32 → signal the bare recorded pid only.
      try { killFn(pid, "SIGTERM"); } catch { /* already gone */ }
    } else {
      // Signal the GROUP (negative pid) so a detached `next dev` grandchild dies too; fall back to the
      // bare pid if the group send throws (the dev server wasn't a group leader).
      try { killFn(-pid, "SIGTERM"); } catch {
        try { killFn(pid, "SIGTERM"); } catch { /* already gone (ESRCH) */ }
      }
    }
  } finally {
    try { unlinkSyncFn(file); } catch { /* best-effort cleanup */ }
  }
  return { acted: true, reason: "reaped", pid };
}
