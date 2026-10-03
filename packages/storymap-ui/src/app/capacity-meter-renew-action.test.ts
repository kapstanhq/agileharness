import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";

// O «Renovar agora» do item do MEDIDOR DE COTA PARADO no Inbox (v0.9.2). A server action é chamada DIRETO (o mundo
// em que o middleware não decidiu), com o governador REAL por baixo (medidor e keepalive injetados, estado num temp):
//   · operador com cookie de sessão ⇒ o keepalive roda e o desfecho volta para o toast (renovado / não configurado /
//     falhou);
//   · agente pelo MCP — mesmo com o token `full` — ⇒ RECUSADO, e o keepalive NÃO roda (ele gasta cota e fura a
//     cadência: é um clique deliberado do operador, não uma alavanca de agente);
//   · o próprio serviço, fora de request ⇒ RECUSADO;
//   · sem sessão ⇒ o guard recusa antes de tudo.

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

// O singleton do governador trocado por um REAL com dependências de teste (a closure sobrevive à hoistagem).
let governor: import("@/lib/storymap/runner/capacity-service").CapacityGovernor | null = null;
vi.mock("@/lib/storymap/runner/capacity-service", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/capacity-service")>();
  return { ...actual, getCapacityGovernor: () => governor! };
});

import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { CapacityGovernor } from "@/lib/storymap/runner/capacity-service";
import { DEFAULT_GOVERNOR_SETTINGS } from "@/lib/storymap/runner/capacity-governor";
import type { UsageWindow } from "@/lib/vps/types";
import { renewCapacityMeterAction } from "@/app/actions";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIN = 60_000;
const ARGV = ["claude", "-p", "ok"];

function usage(polledAt: number): UsageWindow {
  return {
    source: "subscription",
    week: { usedPct: 40, resetsInMinutes: 3 * 24 * 60, resetsAt: T0 + 3 * 24 * 60 * MIN },
    session: { usedPct: 20, resetsInMinutes: 120, resetsAt: T0 + 120 * MIN },
    weekSonnet: null,
    extra: { enabled: false, usedUsd: 0, limitUsd: 0 },
    polledAt,
    stale: false,
  };
}

let dir: string;
let now: number;
let current: UsageWindow;
let argv: string[] | null;
let keepalive: (argv: string[]) => Promise<{ ok: boolean; detail: string }>;
let calls: string[][];

beforeEach(async () => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
  dir = mkdtempSync(path.join(tmpdir(), "capacity-renew-"));
  now = T0;
  current = usage(T0 - MIN);
  argv = ARGV;
  calls = [];
  // o tráfego do keepalive renova o token: o proxy volta a medir
  keepalive = async (a) => {
    calls.push(a);
    current = usage(now);
    return { ok: true, detail: "ok" };
  };
  governor = new CapacityGovernor({
    now: () => now,
    settings: () => ({ ...DEFAULT_GOVERNOR_SETTINGS, timezone: "UTC" }),
    statsUrl: () => "http://medidor/stats",
    readUsage: async () => current,
    stateDir: () => path.join(dir, "autonomy"),
    haltPath: () => path.join(dir, "HALT"),
    notify: () => {},
    log: () => {},
    keepaliveArgv: () => argv,
    runKeepalive: (a) => keepalive(a),
  });
  // o medidor visto fresco em T0 e PARADO 40 min depois — o estado em que o item aparece no Inbox
  await governor.refresh();
  now = T0 + 40 * MIN;
  await governor.refresh();
  expect(governor.snapshot().meterStall).not.toBeNull();
});
afterEach(async () => {
  await governor?.flush();
  rmSync(dir, { recursive: true, force: true });
});

async function operatorCookie(): Promise<void> {
  cookieJar = { [SESSION_COOKIE]: await signSession({ sessionSecret: SESSION_SECRET, operatorToken: OPERATOR_TOKEN }) };
}

describe("renovar o medidor de cota pelo Inbox", () => {
  it("o OPERADOR com sessão: o keepalive roda, o medidor é relido e o impasse acaba", async () => {
    await operatorCookie();
    const r = await renewCapacityMeterAction();
    expect(r).toEqual({ ok: true, data: { outcome: "renewed", detail: "ok" } });
    expect(calls).toEqual([ARGV]);
    expect(governor!.snapshot().meterStall).toBeNull();
    expect(governor!.admission("automation").admit).toBe(true);
  });

  it("keepalive NÃO configurado no host ⇒ o desfecho diz isso (o toast manda pedir ao operador do host), nada roda", async () => {
    await operatorCookie();
    argv = null;
    const r = await renewCapacityMeterAction();
    expect(r.ok).toBe(true);
    expect(r.ok && r.data?.outcome).toBe("not-configured");
    expect(calls).toEqual([]);
    expect(governor!.snapshot().meterStall).not.toBeNull();
  });

  it("o keepalive FALHA ⇒ o erro dele volta para a tela; o medidor segue parado", async () => {
    await operatorCookie();
    keepalive = async (a) => (calls.push(a), { ok: false, detail: "Command failed: claude — not logged in" });
    const r = await renewCapacityMeterAction();
    expect(r).toEqual({ ok: true, data: { outcome: "failed", detail: "Command failed: claude — not logged in" } });
    expect(governor!.snapshot().meterStall).not.toBeNull();
  });

  it("um agente pelo MCP — mesmo com o token FULL — é RECUSADO, e o keepalive não roda", async () => {
    cookieJar = {}; // request MCP: sem cookie
    const r = await runWithMcpActor({ level: "full" }, () => renewCapacityMeterAction());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("operador") });
    expect(calls).toEqual([]);
    expect(governor!.snapshot().meterStall).not.toBeNull();
  });

  it("um token ESCOPADO do MCP também é recusado", async () => {
    cookieJar = {};
    const r = await runWithMcpActor({ level: "orch" }, () => renewCapacityMeterAction());
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("o próprio serviço, fora de request, NÃO renova", async () => {
    cookieJar = null;
    const r = await renewCapacityMeterAction();
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("sem sessão, o guard recusa antes de tudo", async () => {
    cookieJar = {};
    await expect(renewCapacityMeterAction()).rejects.toMatchObject({ code: "AH_ACTION_UNAUTHENTICATED" });
    expect(calls).toEqual([]);
  });
});
