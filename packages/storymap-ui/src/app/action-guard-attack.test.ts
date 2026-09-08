import { beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import type { Card } from "@/lib/storymap/types";

// O ATAQUE: um POST anônimo alcança uma Server Action privilegiada.
//
// As Server Actions do Next são endpoints POST. Se o portão da BORDA (`src/middleware.ts`) deixar de
// cobrir o dispatch — uma linha mudada no `matcher`, uma rota nova entrando em `PUBLIC_ROUTES` por
// descuido, um caminho de dispatch que o matcher não veja —, um anônimo chega em ~120 mutadores de
// uma vez: apagar card, spawnar agente, publicar em produção. Estes testes NÃO passam pelo
// middleware de propósito: eles chamam a action DIRETO, que é exatamente o mundo em que o middleware
// falhou, e exigem que ela se recuse SOZINHA.
//
// E o outro lado, que vale tanto quanto: o agente headless (MCP) e o próprio serviço NÃO têm cookie e
// PRECISAM continuar passando. Perímetro fechado, autonomia intacta — se um destes testes ficar
// vermelho, o hardening virou perda de capacidade.

// Segredos do serviço: só precisam vencer o piso de 32 chars de `lib/auth/session`.
const SESSION_SECRET = "sessao-secreta-de-teste-com-mais-de-32-chars";
const OPERATOR_TOKEN = "token-do-operador-de-teste-com-mais-de-32-chars";

// O contexto de request simulado. `null` = NÃO existe request (chamada in-process): é o que o
// `next/headers` de verdade faz fora do request store — estoura.
let cookieJar: Record<string, string> | null = null;

vi.mock("next/headers", () => ({
  cookies: () => {
    // O erro do caminho "fora de request" vem da FUNÇÃO REAL do Next instalado, nunca de uma
    // mensagem escrita à mão: desde que o guard virou fail-closed (só um sinal POSITIVO de
    // "sem request" classifica como interno — ver `lib/auth/action-guard.ts`), um erro
    // inventado é um erro DESCONHECIDO e recusa, com razão. Um stub que finge um Next que não
    // existe testaria um mundo que não existe.
    if (!cookieJar) throwForMissingRequestStore("cookies");
    const jar = cookieJar!;
    return { get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) };
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── deleteCardAction (destrutiva) sobre um store em memória ────────────────────────────────────
let store: Card[] = [];
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readCards: async () => store.map((c) => ({ ...c })) };
});
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    trashCardFile: async (_b: string, id: string) => {
      store = store.filter((c) => c.id !== id);
    },
    updateCardOnDisk: async (_b: string, id: string, mutate: (c: Card) => Card | null) => {
      const idx = store.findIndex((c) => c.id === id);
      if (idx < 0) return null;
      const next = mutate({ ...store[idx] });
      if (next) store[idx] = next;
      return next;
    },
  };
});
vi.mock("@/lib/storymap/smart-capture/proposal", () => ({ deleteProposal: async () => {} }));
vi.mock("@/lib/storymap/runner/engine", () => ({ getRunnerEngine: vi.fn() }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: vi.fn() }));

// ── publishStagedAction (deploy — o poder máximo da superfície) ────────────────────────────────
// Contador em vez de `vi.fn()` no factory: o factory é hoistado para o topo do arquivo, então uma
// referência a um `const` deste escopo estouraria em TDZ (só closures sobrevivem à hoistagem).
let enqueueCalls: unknown[] = [];
vi.mock("@/lib/storymap/runner/publish-queue", () => ({
  enqueuePublish: async (input: unknown) => {
    enqueueCalls.push(input);
    return { request: { id: "req-1", status: "waiting" }, deduped: false };
  },
  cancelPublish: async () => false,
}));
vi.mock("@/lib/storymap/runner/publish-git", () => ({ stagingShaOf: async () => "deadbeefdeadbeefdeadbeef" }));
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/config")>();
  return {
    ...actual,
    loadRunnerConfig: () => ({ autorun: { publishQueue: { enabled: true }, staging: { enabled: true } } }),
  };
});
vi.mock("@/lib/storymap/runner/delivery-deps", () => ({ collectDelivery: async () => ({}) }));
vi.mock("@/app/audit-actions", () => ({ logHumanActionAction: vi.fn(async () => ({ ok: true })) }));

import { SESSION_COOKIE, signSession, SESSION_TTL_MS } from "@/lib/auth/session";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { deleteCardAction } from "@/app/actions";
import { publishStagedAction } from "@/app/delivery-actions";

const mk = (over: Partial<Card>): Card =>
  ({ id: "x", type: "story", title: "t", parent: null, links: [], ...over }) as Card;

/** O cookie que o operador legítimo carrega. */
async function validCookie(ttlMs = SESSION_TTL_MS): Promise<string> {
  return signSession({ sessionSecret: SESSION_SECRET, operatorToken: OPERATOR_TOKEN, ttlMs });
}

beforeEach(() => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
  store = [mk({ id: "story-alvo", type: "story", parent: "step-1" })];
  cookieJar = {};
  enqueueCalls = [];
});

describe("Server Action alcançada sem sessão — a ação recusa POR CONTA PRÓPRIA", () => {
  it("apagar um card sem cookie de sessão é RECUSADO, e o card continua lá", async () => {
    cookieJar = {}; // request chegou; nenhuma sessão
    await expect(deleteCardAction({ boardId: "b", cardId: "story-alvo" })).rejects.toMatchObject({
      code: "AH_ACTION_UNAUTHENTICATED",
    });
    expect(store.map((c) => c.id)).toEqual(["story-alvo"]);
  });

  it("PUBLICAR EM PRODUÇÃO sem sessão é recusado ANTES de a fila ser tocada", async () => {
    cookieJar = {};
    await expect(publishStagedAction({ board: "storymap" })).rejects.toMatchObject({
      code: "AH_ACTION_UNAUTHENTICATED",
    });
    expect(enqueueCalls).toEqual([]);
  });

  it("cookie assinado com OUTRO segredo (token do operador rotacionado) não vale", async () => {
    cookieJar = {
      [SESSION_COOKIE]: await signSession({
        sessionSecret: SESSION_SECRET,
        operatorToken: "token-ANTIGO-que-foi-rotacionado-32-chars",
      }),
    };
    await expect(deleteCardAction({ boardId: "b", cardId: "story-alvo" })).rejects.toMatchObject({
      code: "AH_ACTION_UNAUTHENTICATED",
    });
    expect(store.map((c) => c.id)).toEqual(["story-alvo"]);
  });

  it("sessão EXPIRADA não vale — a mesma régua do middleware, dentro da action", async () => {
    cookieJar = { [SESSION_COOKIE]: await validCookie(-1000) };
    await expect(deleteCardAction({ boardId: "b", cardId: "story-alvo" })).rejects.toMatchObject({
      code: "AH_ACTION_UNAUTHENTICATED",
    });
  });

  it("segredo do serviço AUSENTE tranca a ação (fail-closed), não a abre", async () => {
    const cookie = await validCookie();
    delete process.env[SESSION_SECRET_ENV];
    cookieJar = { [SESSION_COOKIE]: cookie };
    await expect(deleteCardAction({ boardId: "b", cardId: "story-alvo" })).rejects.toMatchObject({
      code: "AH_ACTION_UNAUTHENTICATED",
    });
  });
});

describe("o operador legítimo e os agentes NÃO perdem nada", () => {
  it("com sessão válida, apagar o card funciona igual a antes", async () => {
    cookieJar = { [SESSION_COOKIE]: await validCookie() };
    const r = await deleteCardAction({ boardId: "b", cardId: "story-alvo" });
    expect(r.ok).toBe(true);
    expect(store.map((c) => c.id)).toEqual([]);
  });

  it("AUTONOMIA: o agente headless via MCP passa SEM cookie (o token dele já foi verificado na rota)", async () => {
    cookieJar = {}; // request MCP: nunca tem cookie
    const r = await runWithMcpActor({ level: "full" }, () => deleteCardAction({ boardId: "b", cardId: "story-alvo" }));
    expect(r.ok).toBe(true);
    expect(store.map((c) => c.id)).toEqual([]);
  });

  it("AUTONOMIA: um agente ESCOPADO (token write) também passa — o guard não é o gate de risco", async () => {
    cookieJar = {};
    const r = await runWithMcpActor({ level: "write", tokenEnv: "AGILEHARNESS_MCP_TOKEN_WRITE" }, () =>
      publishStagedAction({ board: "storymap" }),
    );
    expect(r.ok).toBe(true);
    expect(enqueueCalls).toHaveLength(1);
  });

  it("AUTONOMIA: o próprio serviço, fora de qualquer request, segue chamando a action", async () => {
    cookieJar = null; // sem request store — engine, fs.watch, tick do copiloto, teste
    const r = await deleteCardAction({ boardId: "b", cardId: "story-alvo" });
    expect(r.ok).toBe(true);
  });
});
