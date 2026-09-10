import { describe, expect, it } from "vitest";
import {
  PROD_PORT,
  EPHEMERAL_PORT_BASE,
  EPHEMERAL_PORT_SPAN,
  ephemeralPortForRun,
  assertNotProdPort,
  resolveDevServerPort,
  resolveNextBinary,
  devServerPidFile,
  writeDevServerPid,
  cmdlineIsQaDevServer,
  reapDevServerPid,
  type PortProbe,
} from "./dev-server";
import { itPosix } from "./test-platform";

const RUN_ID = "3f05137c-3e3a-4f88-a34b-e3463290a39e";

describe("ephemeralPortForRun — deterministic, in-range, never 3008", () => {
  it("is DETERMINISTIC for a fixed sessionId (re-runs/resumes target the same port)", () => {
    const a = ephemeralPortForRun(RUN_ID);
    const b = ephemeralPortForRun(RUN_ID);
    expect(a).toBe(b);
  });

  it("derives a port strictly inside the ephemeral range [base, base+span)", () => {
    for (const id of [RUN_ID, "story-koieb3", "x", "0000", "a-b-c-d", "zzzzzzzzzzzzzzzzzzzz"]) {
      const port = ephemeralPortForRun(id);
      expect(port).toBeGreaterThanOrEqual(EPHEMERAL_PORT_BASE);
      expect(port).toBeLessThan(EPHEMERAL_PORT_BASE + EPHEMERAL_PORT_SPAN);
    }
  });

  it("NEVER returns the prod port 3008 — for any of a large spread of ids", () => {
    for (let i = 0; i < 5000; i++) {
      expect(ephemeralPortForRun(`run-${i}-${i * 7}`)).not.toBe(PROD_PORT);
    }
  });

  it("the range sits ABOVE every dev-all/emulator port + 3008 (base 3100 > 3008)", () => {
    expect(EPHEMERAL_PORT_BASE).toBeGreaterThan(PROD_PORT);
    // The whole derived range avoids the 30xx web ports and below.
    expect(EPHEMERAL_PORT_BASE).toBe(3100);
    expect(EPHEMERAL_PORT_BASE + EPHEMERAL_PORT_SPAN - 1).toBe(3899);
  });

  it("different ids spread across the range (the hash is not a constant)", () => {
    const ports = new Set(Array.from({ length: 50 }, (_, i) => ephemeralPortForRun(`id-${i}`)));
    expect(ports.size).toBeGreaterThan(1);
  });
});

describe("assertNotProdPort — the fail-early 3008 collision guard (AC3)", () => {
  it("THROWS on the prod port 3008", () => {
    expect(() => assertNotProdPort(PROD_PORT)).toThrow(/3008/);
    expect(() => assertNotProdPort(3008)).toThrow(/storymap\.service/);
  });

  it("is a NO-OP for any other port", () => {
    expect(() => assertNotProdPort(3200)).not.toThrow();
    expect(() => assertNotProdPort(EPHEMERAL_PORT_BASE)).not.toThrow();
    expect(() => assertNotProdPort(0)).not.toThrow();
  });
});

describe("resolveDevServerPort — deterministic → free, skips 3008, hermetic via injected probe", () => {
  it("returns ephemeralPortForRun(id) when that port is FREE (no stepping)", async () => {
    const expected = ephemeralPortForRun(RUN_ID);
    const allFree: PortProbe = async () => true;
    expect(await resolveDevServerPort(RUN_ID, allFree)).toBe(expected);
  });

  it("STEPS to the next free port when the deterministic one is occupied", async () => {
    const start = ephemeralPortForRun(RUN_ID);
    // Only the very first candidate is taken; the next is free.
    const probe: PortProbe = async (port) => port !== start;
    expect(await resolveDevServerPort(RUN_ID, probe)).toBe(start + 1);
  });

  it("steps past a run of occupied ports to the first free one", async () => {
    const start = ephemeralPortForRun(RUN_ID);
    const taken = new Set([start, start + 1, start + 2]);
    const probe: PortProbe = async (port) => !taken.has(port);
    expect(await resolveDevServerPort(RUN_ID, probe)).toBe(start + 3);
  });

  it("NEVER returns 3008 even if 3008 were the only 'free' port (the guard refuses it)", async () => {
    // Force the search to start AT 3008 via a tiny custom range, with 3008 the only free port.
    const onlyProdFree: PortProbe = async (port) => port === PROD_PORT;
    await expect(
      resolveDevServerPort(RUN_ID, onlyProdFree, { base: PROD_PORT, span: 3, maxTries: 3 }),
    ).rejects.toThrow(/nenhuma porta livre/);
  });

  it("the returned port is ALWAYS != 3008 across many ids (probe = all free)", async () => {
    const allFree: PortProbe = async () => true;
    for (let i = 0; i < 200; i++) {
      const port = await resolveDevServerPort(`run-${i}`, allFree);
      expect(port).not.toBe(PROD_PORT);
    }
  });

  it("THROWS when every probed candidate is occupied (saturated box — never silently falls to 3008)", async () => {
    const allTaken: PortProbe = async () => false;
    await expect(resolveDevServerPort(RUN_ID, allTaken, { maxTries: 8 })).rejects.toThrow(
      /nenhuma porta livre/,
    );
  });

  it("wraps within the range (a candidate near the top walks back to base, never above span)", async () => {
    // Start near the top of a small range so the +i stepping must wrap to `base`.
    const base = 3100;
    const span = 4; // ports 3100..3103
    // Make the start deterministically the top of the range by choosing an id, then assert the
    // resolved port stays within [base, base+span) even when stepping wraps.
    const allFree: PortProbe = async () => true;
    for (let i = 0; i < 20; i++) {
      const port = await resolveDevServerPort(`wrap-${i}`, allFree, { base, span });
      expect(port).toBeGreaterThanOrEqual(base);
      expect(port).toBeLessThan(base + span);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// story-koieb3 hardening — EDGE 2: explicit, PATH-independent `next` binary resolution.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveNextBinary — PATH-independent next CLI resolution", () => {
  it("runs the resolved next entrypoint under the CURRENT runtime (PATH-independent)", () => {
    const bin = resolveNextBinary("/repo/packages/storymap-ui", {
      resolve: (id) => {
        expect(id).toBe("next/dist/bin/next");
        return "/repo/node_modules/next/dist/bin/next";
      },
      execPath: "/usr/bin/bun",
    });
    expect(bin.runtime).toBe("/usr/bin/bun");
    expect(bin.prefix).toEqual(["/repo/node_modules/next/dist/bin/next"]);
  });

  itPosix("falls back to node_modules/.bin/next when the package export can't be resolved", () => {
    const bin = resolveNextBinary("/repo/pkg", {
      resolve: () => {
        throw new Error("MODULE_NOT_FOUND");
      },
      existsSync: (p) => p === "/repo/pkg/node_modules/.bin/next",
    });
    expect(bin.runtime).toBe("/repo/pkg/node_modules/.bin/next");
    expect(bin.prefix).toEqual([]);
  });

  it("last resort: bare `next` (PATH) when neither the export nor the shim exists — the spawn error handler explains", () => {
    const bin = resolveNextBinary("/repo/pkg", {
      resolve: () => {
        throw new Error("MODULE_NOT_FOUND");
      },
      existsSync: () => false,
    });
    expect(bin.runtime).toBe("next");
    expect(bin.prefix).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// story-koieb3 hardening — EDGE 3: no-systemd fallback teardown via a run-scoped PID file.
// ─────────────────────────────────────────────────────────────────────────────
describe("devServerPidFile — deterministic, run-scoped, escape-proof path", () => {
  it("is DETERMINISTIC for a runId (writer and reaper agree with no IPC)", () => {
    expect(devServerPidFile("run-abc", "/tmp")).toBe(devServerPidFile("run-abc", "/tmp"));
  });

  it("differs per run id", () => {
    expect(devServerPidFile("run-a", "/tmp")).not.toBe(devServerPidFile("run-b", "/tmp"));
  });

  itPosix("constrains the id to the slug charset so it can never escape the temp dir", () => {
    const file = devServerPidFile("../../etc/passwd", "/tmp");
    expect(file).not.toContain("..");
    expect(file).not.toContain("/etc/");
    expect(file.startsWith("/tmp/")).toBe(true);
  });

  it("never produces an empty filename for an empty id (falls back to 'unknown')", () => {
    expect(devServerPidFile("", "/tmp")).toBe(devServerPidFile("unknown", "/tmp"));
  });
});

describe("writeDevServerPid — best-effort record of the dev-server child pid", () => {
  it("writes the pid to the run-scoped file", () => {
    let written: { path: string; data: string } | null = null;
    const file = writeDevServerPid("run-w", 4242, {
      tmpDir: "/tmp",
      writeFileSync: (p, data) => {
        written = { path: p, data };
      },
    });
    expect(file).toBe(devServerPidFile("run-w", "/tmp"));
    expect(written).toEqual({ path: devServerPidFile("run-w", "/tmp"), data: "4242" });
  });

  it("swallows a write failure (returns null) — never crashes the dev server", () => {
    const file = writeDevServerPid("run-x", 1, {
      tmpDir: "/tmp",
      writeFileSync: () => {
        throw new Error("EROFS read-only fs");
      },
    });
    expect(file).toBeNull();
  });
});

/** O cmdline de um `next dev` de verdade, NUL-separado como o /proc entrega. */
const CMDLINE_NEXT_DEV = "node\u0000/repo/node_modules/.bin/next\u0000dev\u0000-H\u0000127.0.0.1\u0000-p\u00003142\u0000";

describe("reapDevServerPid — the no-systemd fallback teardown", () => {
  it("kills the recorded pid's PROCESS GROUP (negative pid → grandchildren die) and deletes the file", async () => {
    const kills: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const unlinked: string[] = [];
    const res = await reapDevServerPid("run-g", {
      tmpDir: "/tmp",
      platform: "linux",
      readFileSync: () => "5555\n",
      // O cmdline REAL de um `next dev` — a guarda de atribuição exige que ele confira antes de sinalizar.
      readCmdline: () => CMDLINE_NEXT_DEV,
      kill: (pid, signal) => kills.push({ pid, signal }),
      unlinkSync: (p) => unlinked.push(p),
    });
    expect(res).toEqual({ acted: true, reason: "reaped", pid: 5555 });
    expect(kills).toEqual([{ pid: -5555, signal: "SIGTERM" }]); // GROUP, not bare pid
    expect(unlinked).toEqual([devServerPidFile("run-g", "/tmp")]);
  });

  it("falls back to the BARE recorded pid if the group send throws (dev server wasn't a leader)", async () => {
    const kills: Array<number> = [];
    const res = await reapDevServerPid("run-h", {
      tmpDir: "/tmp",
      platform: "linux",
      readFileSync: () => "7777",
      readCmdline: () => CMDLINE_NEXT_DEV,
      kill: (pid) => {
        kills.push(pid);
        if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      },
      unlinkSync: () => {},
    });
    expect(res.acted).toBe(true);
    expect(kills).toEqual([-7777, 7777]); // tried the group, then fell back to the bare pid
  });

  it("on win32 signals only the bare pid (no process groups)", async () => {
    const kills: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    await reapDevServerPid("run-win", {
      tmpDir: "C:/tmp",
      platform: "win32",
      readFileSync: () => "8888",
      kill: (pid, signal) => kills.push({ pid, signal }),
      unlinkSync: () => {},
    });
    expect(kills).toEqual([{ pid: 8888, signal: "SIGTERM" }]); // positive pid only
  });

  it("is a harmless NO-OP when no PID file exists (the common case — most runs)", async () => {
    let killed = false;
    const res = await reapDevServerPid("run-none", {
      tmpDir: "/tmp",
      readFileSync: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      kill: () => {
        killed = true;
      },
      unlinkSync: () => {},
    });
    expect(res).toEqual({ acted: false, reason: "no-pid-file" });
    expect(killed).toBe(false);
  });

  it("REFUSES a non-positive / garbage pid (never signals a whole group we didn't choose)", async () => {
    for (const bad of ["0", "1", "-5", "not-a-number", "  "]) {
      let killed = false;
      const unlinked: string[] = [];
      const res = await reapDevServerPid("run-bad", {
        tmpDir: "/tmp",
        readFileSync: () => bad,
        kill: () => {
          killed = true;
        },
        unlinkSync: (p) => unlinked.push(p),
      });
      expect(res.acted).toBe(false);
      expect(res.reason).toBe("bad-pid");
      expect(killed).toBe(false);
      // The stale file is still cleaned up.
      expect(unlinked).toEqual([devServerPidFile("run-bad", "/tmp")]);
    }
  });

  // ── A GUARDA DE ATRIBUIÇÃO ─────────────────────────────────────────────────────────────────────
  //
  // O número gravado não significa a mesma coisa nos dois lados. Sob contenção quem grava é o
  // `qa-dev-server`, DENTRO da jaula e num PID namespace próprio — medido, os PIDs de lá são 22, 34, 41,
  // 56. Quem lê é o engine, NO HOST. Um `kill(-22)` no host não atinge dev server nenhum: atinge o grupo
  // de processos 22 do host. Hoje isso não dispara por ACIDENTE (medido: `/tmp` é read-only na jaula e o
  // TMPDIR de lá é `/tmp/claude-0`, então os caminhos nunca coincidem), e um acidente não é uma guarda.
  it("RECUSA um pid cujo cmdline não é um dev server — a guarda contra matar processo do host", async () => {
    let killed = false;
    const unlinked: string[] = [];
    const res = await reapDevServerPid("run-ns", {
      tmpDir: "/tmp",
      platform: "linux",
      readFileSync: () => "22", // o PID como visto DENTRO da jaula
      readCmdline: () => "/usr/sbin/sshd\u0000-D\u0000", // no HOST, 22 é outra coisa inteiramente
      kill: () => { killed = true; },
      unlinkSync: (p) => unlinked.push(p),
    });
    expect(killed).toBe(false);
    expect(res).toEqual({ acted: false, reason: "pid-nao-confere", pid: 22 });
    expect(unlinked).toEqual([devServerPidFile("run-ns", "/tmp")]); // o arquivo obsoleto some mesmo assim
  });

  it("RECUSA quando não há cmdline nenhum (thread de kernel, ou processo já morto)", async () => {
    let killed = false;
    const res = await reapDevServerPid("run-kthread", {
      tmpDir: "/tmp",
      platform: "linux",
      readFileSync: () => "34",
      readCmdline: () => null, // /proc/34/cmdline vazio ou ilegível
      kill: () => { killed = true; },
      unlinkSync: () => {},
    });
    expect(killed).toBe(false);
    expect(res.reason).toBe("pid-ausente");
  });

  it("PAR DISCRIMINANTE — o MESMO pid mata ou não conforme o cmdline, e só por isso", async () => {
    // Sem este par, o teste acima passaria mesmo se a guarda recusasse SEMPRE — o que transformaria o
    // reaper em código morto e vazaria dev server em silêncio. É o cmdline que precisa estar decidindo.
    const roda = async (cmdline: string | null) => {
      const kills: number[] = [];
      await reapDevServerPid("run-par", {
        tmpDir: "/tmp", platform: "linux", readFileSync: () => "4242",
        readCmdline: () => cmdline, kill: (pid) => kills.push(pid), unlinkSync: () => {},
      });
      return kills;
    };
    expect(await roda(CMDLINE_NEXT_DEV)).toEqual([-4242]); // confere → mata o GRUPO
    expect(await roda("/usr/bin/python3\u0000-m\u0000http.server\u0000")).toEqual([]); // não confere → nada
  });

  it("o classificador é PURO e exige as DUAS marcas (um `next` solto não basta)", () => {
    expect(cmdlineIsQaDevServer(CMDLINE_NEXT_DEV)).toBe(true);
    expect(cmdlineIsQaDevServer("node\u0000next\u0000dev\u0000-H\u0000127.0.0.1\u0000")).toBe(true);
    expect(cmdlineIsQaDevServer(null)).toBe(false);
    expect(cmdlineIsQaDevServer("")).toBe(false);
    expect(cmdlineIsQaDevServer("/usr/bin/next-unrelated\u0000")).toBe(false); // tem `next`, falta o host
    expect(cmdlineIsQaDevServer("curl\u0000http://127.0.0.1:3000\u0000")).toBe(false); // tem o host, falta `next`
  });

  it("noutra plataforma a guarda NÃO se aplica — limitação nomeada, não esquecida", async () => {
    // Não há /proc barato fora do linux, e a contenção do SO — que é quem cria o descasamento de PID
    // namespace — só existe em linux hoje. O comportamento antigo fica intacto onde ela não roda.
    const kills: number[] = [];
    await reapDevServerPid("run-darwin", {
      tmpDir: "/tmp", platform: "darwin", readFileSync: () => "5150",
      readCmdline: () => null, // seria RECUSA em linux
      kill: (pid) => kills.push(pid), unlinkSync: () => {},
    });
    expect(kills).toEqual([-5150]);
  });

  it("NEVER throws even if kill AND unlink both fail (settle's finally must stay safe)", async () => {
    const res = await reapDevServerPid("run-explode", {
      tmpDir: "/tmp",
      platform: "linux",
      readFileSync: () => "9999",
      readCmdline: () => CMDLINE_NEXT_DEV,
      kill: () => {
        throw new Error("kill boom");
      },
      unlinkSync: () => {
        throw new Error("unlink boom");
      },
    });
    // It still reports acted (it attempted the kill) and did not throw.
    expect(res.acted).toBe(true);
    expect(res.pid).toBe(9999);
  });
});
