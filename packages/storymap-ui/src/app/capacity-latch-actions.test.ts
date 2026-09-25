import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";

// A TRAVA DO GOVERNADOR DE CAPACIDADE só sai por AÇÃO DO OPERADOR. As server actions são chamadas DIRETO (o
// mundo em que o middleware não decidiu), com o governador REAL por baixo (medidor injetado, estado num temp):
//   · operador com cookie de sessão + motivo ⇒ solta;
//   · agente pelo MCP — mesmo com o token `full` — ⇒ RECUSADO (pode engatar, nunca soltar);
//   · o próprio serviço, fora de request ⇒ RECUSADO (uma trava que se solta sozinha não é trava);
//   · sem sessão ⇒ o guard recusa antes de tudo.
// E, por construção: nenhuma superfície MCP chama `clearLatch` — a única porta é a server action.

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
import { clearCapacityLatchAction, engageCapacityLatchAction } from "@/app/actions";

let dir: string;
const latchPath = () => path.join(dir, "autonomy", "latch.json");

beforeEach(async () => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
  dir = mkdtempSync(path.join(tmpdir(), "capacity-actions-"));
  governor = new CapacityGovernor({
    settings: () => ({ ...DEFAULT_GOVERNOR_SETTINGS }),
    statsUrl: () => null, // sem medidor: a trava vale mesmo assim (ela é do operador, não da leitura)
    stateDir: () => path.join(dir, "autonomy"),
    haltPath: () => path.join(dir, "HALT"),
    notify: () => {},
    log: () => {},
  });
  await governor.engageLatch({ level: "soft", reason: "semana apertada", by: "operator" });
});
afterEach(async () => {
  await governor?.flush();
  rmSync(dir, { recursive: true, force: true });
});

async function operatorCookie(): Promise<void> {
  cookieJar = { [SESSION_COOKIE]: await signSession({ sessionSecret: SESSION_SECRET, operatorToken: OPERATOR_TOKEN }) };
}

describe("soltar a trava de capacidade", () => {
  it("o OPERADOR com sessão e motivo solta; a automação volta a entrar", async () => {
    await operatorCookie();
    expect(governor!.admission("automation").admit).toBe(false);
    const r = await clearCapacityLatchAction({ reason: "a semana virou" });
    expect(r.ok).toBe(true);
    expect(existsSync(latchPath())).toBe(false);
    expect(governor!.admission("automation").admit).toBe(true);
  });

  it("operador SEM motivo ⇒ recusado, a trava fica", async () => {
    await operatorCookie();
    const r = await clearCapacityLatchAction({ reason: " " });
    expect(r.ok).toBe(false);
    expect(existsSync(latchPath())).toBe(true);
  });

  it("um agente pelo MCP — mesmo com o token FULL — NÃO solta", async () => {
    cookieJar = {}; // request MCP: sem cookie
    const r = await runWithMcpActor({ level: "full" }, () => clearCapacityLatchAction({ reason: "quero rodar" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("operador") });
    expect(existsSync(latchPath())).toBe(true);
    expect(governor!.admission("automation").admit).toBe(false);
  });

  it("o próprio serviço, fora de request, NÃO solta", async () => {
    cookieJar = null;
    const r = await clearCapacityLatchAction({ reason: "auto-liberar" });
    expect(r.ok).toBe(false);
    expect(existsSync(latchPath())).toBe(true);
  });

  it("sem sessão, o guard recusa antes de tudo", async () => {
    cookieJar = {};
    await expect(clearCapacityLatchAction({ reason: "anônimo" })).rejects.toMatchObject({ code: "AH_ACTION_UNAUTHENTICATED" });
    expect(existsSync(latchPath())).toBe(true);
  });

  it("ENGATAR, em compensação, qualquer chamador legítimo pode (o sentido seguro) — e nunca rebaixa", async () => {
    cookieJar = {};
    const r = await runWithMcpActor({ level: "orch" }, () => engageCapacityLatchAction({ level: "hard", reason: "agente puxou o freio" }));
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(latchPath(), "utf8"))).toMatchObject({ level: "hard", trippedBy: "mcp:escopado" });
  });
});

describe("nenhuma superfície MCP solta a trava (por construção)", () => {
  it("`clearLatch(` só é chamado pela server action — nunca sob lib/storymap/mcp", () => {
    const mcpDir = path.join(process.cwd(), "src/lib/storymap/mcp");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const f = path.join(d, e);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.tsx?$/.test(e) && !/\.test\./.test(e) && readFileSync(f, "utf8").includes("clearLatch(")) offenders.push(f);
      }
    };
    walk(mcpDir);
    expect(readdirSync(mcpDir).length, "não li o diretório do MCP — o guarda mediria o vazio").toBeGreaterThan(5);
    expect(offenders).toEqual([]);
    expect(readFileSync(path.join(process.cwd(), "src/app/actions.ts"), "utf8")).toContain(".clearLatch(");
  });
});
