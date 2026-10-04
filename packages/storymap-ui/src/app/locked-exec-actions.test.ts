import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";

// A EXECUÇÃO APROVADA pela server action, com o serviço REAL por baixo (trava e processos injetados, estado num temp):
//   · o dono com cookie de sessão aprova o pedido exato ⇒ o comando roda (uma vez);
//   · um agente pelo MCP — mesmo com o token `full` — ⇒ RECUSADO (propõe, nunca aprova nem desfaz);
//   · o próprio serviço, fora de request ⇒ RECUSADO;
//   · sem sessão ⇒ o guard recusa antes de tudo.
// E, por construção: nenhuma superfície MCP chama approve/undo/keep/ack/reject do serviço.

const SESSION_SECRET = "sessao-secreta-de-teste-com-mais-de-32-chars";
const OPERATOR_TOKEN = "token-do-operador-de-teste-com-mais-de-32-chars";
let cookieJar: Record<string, string> | null = null;

vi.mock("next/headers", () => ({
  cookies: () => {
    if (!cookieJar) throwForMissingRequestStore("cookies");
    const jar = cookieJar!;
    return { get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let service: import("@/lib/storymap/runner/locked-exec-service").LockedExecService | null = null;
vi.mock("@/lib/storymap/runner/locked-exec-service", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/locked-exec-service")>();
  return { ...actual, getLockedExecService: () => service! };
});

import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { LockedExecService } from "@/lib/storymap/runner/locked-exec-service";
import type { LockedExecRecord } from "@/lib/storymap/runner/locked-exec";
import { approveLockedCommandAction, rejectLockedCommandAction, undoLockedCommandAction } from "@/app/actions";

let dir: string;
let calls: string[];
let rec: LockedExecRecord;

beforeEach(async () => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
  dir = mkdtempSync(path.join(tmpdir(), "locked-exec-actions-"));
  calls = [];
  service = new LockedExecService({
    stateDir: () => dir,
    classifier: () => ({
      ok: true,
      classify: async (argv) => ({ ok: true, c: argv[1] === "rotate" || argv[1] === "rollback" ? { locked: true, approvable: true } : { locked: false, approvable: false } }),
    }),
    run: async (argv) => (calls.push(argv.join(" ")), { exitCode: 0, stdout: "chave: ativa", stderr: "" }),
    notify: () => {},
    wake: () => {},
    log: () => {},
    repoRoot: () => "/srv/alvo",
    defer: (fn) => fn(),
    resolveProgram: (a) => ({ ok: true, path: a.startsWith("/") ? a : `/opt/cofre/bin/${a}` }),
    checkPrefixes: () => ({ ok: true, prefixes: [["cofre-cli", "status"], ["cofre-cli", "verifica"]] }),
    workDir: async () => ({ path: "/lx-passo", cleanup: async () => {} }),
    exists: () => false,
    cardExists: async () => true,
  });
  const r = await service.propose(
    {
      board: "atelie",
      cardId: "story-ex7001",
      summary: "Troca a chave de API do cofre por uma nova e guarda a anterior por um ciclo.",
      argv: ["cofre-cli", "rotate", "--key=api"],
      undoArgv: ["cofre-cli", "rollback", "--key=api"],
      verify: [{ label: "a chave nova está ativa", argv: ["cofre-cli", "verifica"], expectStdoutIncludes: "ativa" }],
    },
    "mcp:write(TESTE)",
  );
  if (!r.ok) throw new Error(r.why);
  rec = r.value;
});
afterEach(async () => {
  await service?.flush();
  rmSync(dir, { recursive: true, force: true });
});

async function operatorCookie(): Promise<void> {
  cookieJar = { [SESSION_COOKIE]: await signSession({ sessionSecret: SESSION_SECRET, operatorToken: OPERATOR_TOKEN }) };
}

describe("aprovar um comando travado", () => {
  it("o DONO com sessão aprova o pedido exato: o comando roda uma vez e confere", async () => {
    await operatorCookie();
    const r = await approveLockedCommandAction({ boardId: "atelie", id: rec.id, hash: rec.hash });
    expect(r).toMatchObject({ ok: true, data: { status: "approved" } });
    await service!.flush();
    expect((await service!.get(rec.id))!.status).toBe("done");
    expect(calls.filter((c) => c.includes("rotate")).length).toBe(1);
  });

  it("o dono com o hash de OUTRO pedido ⇒ recusado, nada roda", async () => {
    await operatorCookie();
    const r = await approveLockedCommandAction({ boardId: "atelie", id: rec.id, hash: "f".repeat(64) });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/mudou/) });
    expect(calls).toEqual([]);
  });

  it("um agente pelo MCP — mesmo com o token FULL — NÃO aprova, NÃO recusa, NÃO desfaz", async () => {
    cookieJar = {};
    const a = await runWithMcpActor({ level: "full" }, () => approveLockedCommandAction({ boardId: "atelie", id: rec.id, hash: rec.hash }));
    expect(a).toMatchObject({ ok: false, error: expect.stringMatching(/só o dono/) });
    const j = await runWithMcpActor({ level: "full" }, () => rejectLockedCommandAction({ boardId: "atelie", id: rec.id }));
    expect(j.ok).toBe(false);
    const u = await runWithMcpActor({ level: "full" }, () => undoLockedCommandAction({ boardId: "atelie", id: rec.id }));
    expect(u.ok).toBe(false);
    await service!.flush();
    expect(calls).toEqual([]);
    expect((await service!.get(rec.id))!.status).toBe("pending");
  });

  it("o próprio serviço, fora de request, NÃO aprova", async () => {
    cookieJar = null;
    const r = await approveLockedCommandAction({ boardId: "atelie", id: rec.id, hash: rec.hash });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("sem sessão, o guard recusa antes de tudo", async () => {
    cookieJar = {};
    await expect(approveLockedCommandAction({ boardId: "atelie", id: rec.id, hash: rec.hash })).rejects.toMatchObject({ code: "AH_ACTION_UNAUTHENTICATED" });
    expect(calls).toEqual([]);
  });
});

describe("nenhuma superfície MCP decide um comando travado (por construção)", () => {
  it("approve/reject/undo/keep/ack do serviço só são chamados pelas server actions — nunca sob lib/storymap/mcp", () => {
    const mcpDir = path.join(process.cwd(), "src/lib/storymap/mcp");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const f = path.join(d, e);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.tsx?$/.test(e) && !/\.test\./.test(e) && /getLockedExecService\(\)\s*\.\s*(approve|reject|undo|keep|ack|execute)\(/.test(readFileSync(f, "utf8"))) offenders.push(f);
      }
    };
    walk(mcpDir);
    expect(readdirSync(mcpDir).length, "não li o diretório do MCP — o guarda mediria o vazio").toBeGreaterThan(5);
    expect(offenders).toEqual([]);
    // o positivo: a tool que propõe existe (o guarda não está verde por o serviço nem ser citado ali)
    expect(readFileSync(path.join(mcpDir, "tools.ts"), "utf8")).toContain("getLockedExecService().propose(");
    expect(readFileSync(path.join(process.cwd(), "src/app/actions.ts"), "utf8")).toContain("getLockedExecService().approve(");
  });
});
