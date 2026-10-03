// A tool MCP `deploy` publica do MESMO checkout de runtime que o pipeline — então passa pelo MESMO preflight
// de frescor, e uma recusa volta a quem chamou com o motivo, sem lançar nada. Arquivo próprio porque os mocks
// (registry, boards, preflight) são globais ao arquivo e não podem vazar para a suíte grande de dev-tools.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const estado = vi.hoisted(() => ({
  lancados: [] as string[],
  recusar: false,
}));

vi.mock("@/lib/storymap/runner/product-deploy", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/product-deploy")>();
  const reg = new actual.ProductDeployRegistry((pkg) => {
    estado.lancados.push(pkg);
    return { pid: 1, whenDone: () => {} };
  });
  return { ...actual, productDeployTargets: () => ["app"], getProductDeploy: () => reg };
});

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    listBoards: async () => [{ id: "loja" }, { id: "outro" }],
    readBoardConfig: async (id: string) =>
      id === "loja"
        ? { id, package: "packages/app", sharedPackages: ["packages/shared"], deploy: { liveShaCommand: "just live-sha" } }
        : { id, package: "packages/outro" },
  };
});

vi.mock("@/lib/storymap/runner/deploy-freshness", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/deploy-freshness")>();
  return {
    ...actual,
    // Recusa, ou cunha uma autorização REAL pelo escape humano (o registry exige uma de verdade).
    checkDeployFreshness: vi.fn(async (req: Parameters<typeof actual.checkDeployFreshness>[0]) =>
      estado.recusar
        ? { ok: false as const, code: "behind" as const, reason: "o checkout está 7 commit(s) ATRÁS de origin/main" }
        : actual.checkDeployFreshness(req, {
            exec: async () => {
              throw new Error("o escape não mede git");
            },
            env: { AGILEHARNESS_DEPLOY_FRESHNESS: "off" },
            log: () => {},
          }),
    ),
  };
});

import { setServerLevel } from "./register";
import { registerDevTools } from "./dev-tools";
import { checkDeployFreshness } from "@/lib/storymap/runner/deploy-freshness";

function deployHandler() {
  let handler: ((a: Record<string, unknown>) => Promise<CallToolResult>) | null = null;
  const server = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "registerTool"
          ? (name: string, _cfg: unknown, fn: (a: Record<string, unknown>) => Promise<CallToolResult>) => {
              if (name === "deploy") handler = fn;
            }
          : () => {},
    },
  ) as unknown as McpServer;
  setServerLevel(server, "full");
  registerDevTools(server);
  if (!handler) throw new Error("deploy não foi registrada");
  return handler as (a: Record<string, unknown>) => Promise<CallToolResult>;
}
const texto = (r: CallToolResult) => String((r.content as { text: string }[])[0].text);

beforeEach(() => {
  estado.lancados.length = 0;
  vi.mocked(checkDeployFreshness).mockClear();
});

describe("tool MCP `deploy` — o preflight de frescor antes do deploy cru", () => {
  it("preflight RECUSA ⇒ a tool recusa com o motivo e NADA é lançado", async () => {
    estado.recusar = true;
    const r = await deployHandler()({ pkg: "app", confirm: "app" });
    expect(r.isError).toBe(true);
    expect(texto(r)).toContain("RECUSADO pelo preflight de frescor");
    expect(texto(r)).toContain("7 commit(s) ATRÁS de origin/main");
    expect(estado.lancados).toEqual([]);
    // o escopo é o de PROMOÇÃO do board que publica o alvo, e o liveShaCommand é o que ele declarou
    const [req, deps] = vi.mocked(checkDeployFreshness).mock.calls[0];
    expect(req).toMatchObject({
      target: "app",
      scope: ["packages/app/", "packages/shared/"],
      liveShaCommands: ["just live-sha"],
      label: "mcp deploy app",
    });
    expect(deps, "o escape vem do env do SERVIÇO — a tool não o injeta").not.toHaveProperty("env");
  });

  it("preflight LIBERA ⇒ lança, e a resposta diz o que foi medido (aqui: o escape, que não mede nada)", async () => {
    estado.recusar = false;
    const r = await deployHandler()({ pkg: "app", confirm: "app" });
    expect(r.isError).toBeFalsy();
    expect(estado.lancados).toEqual(["app"]);
    expect(texto(r)).toContain("PREFLIGHT DE FRESCOR DESLIGADO");
  });

  it("a confirmação continua vindo ANTES — sem ela nem o preflight roda", async () => {
    const r = await deployHandler()({ pkg: "app", confirm: "outro" });
    expect(r.isError).toBe(true);
    expect(checkDeployFreshness).not.toHaveBeenCalled();
    expect(estado.lancados).toEqual([]);
  });
});
