import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";

// «Refazer os pedidos de publicação» (a Esteira do board): só o OPERADOR, com a sessão no navegador, refaz — um agente
// pelo MCP (mesmo com o token `full`) e o próprio serviço fora de request são recusados; sem sessão o guard recusa antes.
// O que ele roda é a MESMA re-medição do pedido recusado por velho (owner-approval.ts), aqui com a medição fingida.

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
const measured: string[] = [];
vi.mock("@/lib/storymap/runner/owner-approval", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storymap/runner/owner-approval")>();
  return {
    ...real,
    defaultRerequestDeps: () => ({
      publisherOf: async (pkg: string) => (pkg === "vitrine" ? { board: "vitrine" } : null),
      mark: async () => {},
      unmark: async () => {},
      measure: async (board: string) => {
        measured.push(board);
        return { ok: true as const, via: "deploy" as const };
      },
      now: () => Date.parse("2026-10-05T12:00:00Z"),
    }),
  };
});

import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { rerequestPublishRequestsAction } from "@/app/delivery-actions";

let state: string;
let prevState: string | undefined;
const row = (board: string, phase = "needs-human") => ({
  board, causeKey: `vitrine:owner:money`, pkg: "vitrine", phase, decider: "owner", ownerClass: "money", units: ["api"], rules: [], command: "./ship",
  firstAt: "2026-10-05T10:00:00Z", lastAt: "2026-10-05T10:00:00Z", cardIds: ["story-v1"], planHead: null, attributedCard: null,
});

beforeEach(() => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
  state = mkdtempSync(path.join(os.tmpdir(), "ah-rerequest-action-"));
  mkdirSync(state, { recursive: true });
  prevState = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = state;
  writeFileSync(path.join(state, "deploy-blocks.json"), JSON.stringify({ version: 1, rows: [row("vitrine")] }));
  measured.length = 0;
  cookieJar = null;
});
afterEach(() => {
  if (prevState === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevState;
  rmSync(state, { recursive: true, force: true });
});

async function operatorCookie(): Promise<void> {
  cookieJar = { [SESSION_COOKIE]: await signSession({ sessionSecret: SESSION_SECRET, operatorToken: OPERATOR_TOKEN }) };
}

describe("rerequestPublishRequestsAction — só o operador refaz os pedidos de publicação", () => {
  it("o OPERADOR, com pedido `needs-human` no board: a medição do pacote roda AGORA no board que o publica", async () => {
    await operatorCookie();
    const r = await rerequestPublishRequestsAction({ board: "vitrine" });
    expect(r).toMatchObject({ ok: true, data: { message: expect.stringContaining("refazendo o pedido…") } });
    expect(measured).toEqual(["vitrine"]);
  });

  it("sem pedido `needs-human` no board: diz que não há o que refazer, e nada roda", async () => {
    await operatorCookie();
    writeFileSync(path.join(state, "deploy-blocks.json"), JSON.stringify({ version: 1, rows: [row("vitrine", "needs-proof")] }));
    const r = await rerequestPublishRequestsAction({ board: "vitrine" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("nada a refazer") });
    expect(measured).toEqual([]);
  });

  it("um agente pelo MCP — mesmo com o token FULL — é recusado, e nada roda", async () => {
    cookieJar = {};
    const r = await runWithMcpActor({ level: "full" }, () => rerequestPublishRequestsAction({ board: "vitrine" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("operador") });
    expect(measured).toEqual([]);
  });

  it("o próprio serviço, fora de request, é recusado", async () => {
    cookieJar = null;
    const r = await rerequestPublishRequestsAction({ board: "vitrine" }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    expect(r.ok).toBe(false);
    expect(measured).toEqual([]);
  });

  it("sem sessão (request de navegador sem cookie) o guard recusa antes de tudo", async () => {
    cookieJar = {};
    await expect(rerequestPublishRequestsAction({ board: "vitrine" })).rejects.toThrow();
    expect(measured).toEqual([]);
  });
});

describe("por construção: a porta é o botão da Esteira", () => {
  it("nenhum arquivo das tools MCP chama a action", () => {
    const mcpDir = path.join(__dirname, "..", "lib", "storymap", "mcp");
    const files = readdirSync(mcpDir, { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => readFileSync(path.join(mcpDir, f), "utf8").includes("rerequestPublishRequestsAction"))).toEqual([]);
  });

  it("a Esteira mostra o botão quando há pedido do board e o troca por «refazendo o pedido…» enquanto refaz", () => {
    const src = readFileSync(path.join(__dirname, "..", "components", "EntregaScreen.tsx"), "utf8");
    expect(src).toContain("data.publishRequests && data.publishRequests.pending > 0");
    expect(src).toContain("rerequestPublishRequestsAction({ board: b })");
    expect(src).toContain("Refazer os pedidos de publicação");
    expect(src).toMatch(/requests\.rerequesting \?[\s\S]*refazendo o pedido…/);
  });
});
