// A FIAÇÃO do papel na rota MCP: cabeçalho → parseToolset → handler em cache POR PAPEL → setServerToolset.
//
// toolsets.test.ts prova o filtro chamando `setServerToolset` direto. O que só a rota prova: (1) o nome do cabeçalho que
// ela lê é o que o serviço escreve no `.mcp.json` da sessão; (2) a MESMA credencial com e sem o cabeçalho monta DOIS
// handlers — um cache que ignorasse o papel serviria a superfície estreita a um cliente sem papel (ou o contrário);
// (3) um papel desconhecido cai na superfície do nível, sem handler próprio.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Cada construção do handler: o basePath e o papel que o callback de registro carimbou no servidor. */
const builds: { basePath: string; toolset: string | undefined }[] = [];
let lastToolset: string | undefined;

vi.mock("mcp-handler", () => ({
  createMcpHandler: (register: (server: unknown) => void, _info: unknown, opts: { basePath: string }) => {
    lastToolset = undefined;
    register({});
    const toolset = lastToolset;
    builds.push({ basePath: opts.basePath, toolset });
    return async (): Promise<Response> => Response.json({ toolset: toolset ?? null });
  },
}));
vi.mock("@/lib/storymap/mcp/tools", () => ({ registerStorymapTools: () => {} }));
vi.mock("@/lib/storymap/mcp/dev-tools", () => ({ registerDevTools: () => {} }));
vi.mock("@/lib/storymap/mcp/resources", () => ({ registerResources: () => {} }));
vi.mock("@/lib/storymap/mcp/onboarding", () => ({ registerOnboarding: () => {}, MCP_INSTRUCTIONS: "instruções" }));
vi.mock("@/lib/storymap/mcp/register", () => ({
  setServerLevel: () => {},
  setServerToolset: (_server: unknown, toolset: string | undefined) => {
    lastToolset = toolset;
  },
}));

import { POST } from "@/app/api/mcp/[secret]/[transport]/route";
import { MCP_TOOLSET_HEADER } from "@/lib/storymap/mcp/toolsets";
import { resetPerimeterState, flushAuthFailures } from "@/lib/auth/auth-audit";

const TOKEN_ENV = "AGILEHARNESS_MCP_TOKEN";
/** Um token legado forte inventado (32 bytes em base64url). */
const TOKEN = "Zq3vN8kT1xR6wP0mY4sB7cH2jL9fD5gE-aU_iO3eK1M";

let stateDir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.dir = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  saved.tok = process.env[TOKEN_ENV];
  stateDir = mkdtempSync(path.join(tmpdir(), "mcp-toolset-"));
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = stateDir;
  process.env[TOKEN_ENV] = TOKEN;
  resetPerimeterState();
  builds.length = 0;
});

afterEach(async () => {
  await flushAuthFailures();
  if (saved.dir === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = saved.dir;
  if (saved.tok === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = saved.tok;
  rmSync(stateDir, { recursive: true, force: true });
});

function call(headers: Record<string, string>): Promise<Response> {
  const seg = encodeURIComponent(TOKEN);
  const req = new Request(`https://ah.example/api/mcp/${seg}/mcp`, { method: "POST", headers: { "x-forwarded-for": "198.51.100.40", ...headers } });
  return POST(req, { params: Promise.resolve({ secret: seg, transport: "mcp" }) });
}

describe("rota MCP: o papel declarado no cabeçalho", () => {
  it("mesma credencial, com e sem o cabeçalho ⇒ superfícies diferentes, handlers que NÃO se compartilham", async () => {
    const plain = await call({});
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ toolset: null });

    const conductor = await call({ [MCP_TOOLSET_HEADER]: "conductor" });
    expect(await conductor.json()).toEqual({ toolset: "conductor" });

    // de novo, nas duas ordens: cada um volta ao SEU handler (cache por papel), sem nova construção
    expect(await (await call({})).json()).toEqual({ toolset: null });
    expect(await (await call({ [MCP_TOOLSET_HEADER]: "conductor" })).json()).toEqual({ toolset: "conductor" });
    const mine = builds.filter((b) => b.basePath.endsWith(encodeURIComponent(TOKEN)) || b.basePath.endsWith(TOKEN));
    expect(mine.map((b) => b.toolset ?? null).sort()).toEqual(["conductor", null].sort());
  });

  it("papel desconhecido ⇒ a superfície inteira do nível (o mesmo handler de quem não declara papel)", async () => {
    expect(await (await call({ [MCP_TOOLSET_HEADER]: "critic" })).json()).toEqual({ toolset: null });
    expect(await (await call({ [MCP_TOOLSET_HEADER]: "admin" })).json()).toEqual({ toolset: null });
  });
});
