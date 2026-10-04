import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import type { Card } from "@/lib/storymap/types";

// O ADIAMENTO DO DONO só o dono levanta. Adiado por uma pessoa na tela, ou pelo «Parar» do teto de rodadas de revisão:
// um agente (token MCP, de qualquer nível) que trouxesse o card de volta desfazia a decisão do dono. O adiamento de um
// agente («jido»), um agente pode levantar. A action é chamada DIRETO, como nos testes da trava de capacidade.

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

let cards: Card[] = [];
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readCards: async () => cards };
});
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    updateCardOnDisk: async (_b: string, id: string, mutate: (c: Card) => Card | null) => {
      const c = cards.find((x) => x.id === id);
      if (!c) return null;
      const next = mutate(c);
      if (next) cards = cards.map((x) => (x.id === id ? next : x));
      return next;
    },
  };
});
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: async () => {} }));

import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { coerceCard } from "@/lib/storymap/repo";
import { CAP_STOP_DEFER_REASON, isOwnerHeldDeferral } from "@/lib/storymap/deferral";
import { undeferCardAction } from "@/app/actions";

const deferred = (by: string, reason = "não agora") =>
  coerceCard("story-ex7301", { type: "story", storyType: "technical", title: "Trocar o selim", status: "enriquecer", deferred: { reason, since: "2026-03-02", by } }, "");

beforeEach(() => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
});
afterEach(() => vi.clearAllMocks());

describe("isOwnerHeldDeferral", () => {
  it("da pessoa e do «Parar» do teto: sim; do agente: não", () => {
    expect(isOwnerHeldDeferral({ by: "human", reason: "x" })).toBe(true);
    expect(isOwnerHeldDeferral({ by: "jido", reason: CAP_STOP_DEFER_REASON })).toBe(true);
    expect(isOwnerHeldDeferral({ by: "jido", reason: "x" })).toBe(false);
    expect(isOwnerHeldDeferral(undefined)).toBe(false);
  });
});

describe("undeferCardAction — o adiamento do dono", () => {
  it("um agente pelo MCP — mesmo com o token FULL — não levanta o adiamento do dono", async () => {
    cards = [deferred("human")];
    cookieJar = {};
    const r = await runWithMcpActor({ level: "full" }, () => undeferCardAction({ boardId: "oficina", cardId: "story-ex7301" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/adiamento é do dono/) });
    expect(cards[0].deferred).toBeTruthy();
  });

  it("nem o do «Parar» do teto de rodadas", async () => {
    cards = [deferred("system", CAP_STOP_DEFER_REASON)];
    cookieJar = {};
    const r = await runWithMcpActor({ level: "orch" }, () => undeferCardAction({ boardId: "oficina", cardId: "story-ex7301" }));
    expect(r.ok).toBe(false);
  });

  it("o OPERADOR com sessão levanta", async () => {
    cards = [deferred("human")];
    cookieJar = { [SESSION_COOKIE]: await signSession({ sessionSecret: SESSION_SECRET, operatorToken: OPERATOR_TOKEN }) };
    const r = await undeferCardAction({ boardId: "oficina", cardId: "story-ex7301" });
    expect(r).toMatchObject({ ok: true, data: { lifted: ["story-ex7301"] } });
    expect(cards[0].deferred).toBeUndefined();
  });

  it("o adiamento de um agente, um agente levanta", async () => {
    cards = [deferred("jido")];
    cookieJar = {};
    const r = await runWithMcpActor({ level: "orch" }, () => undeferCardAction({ boardId: "oficina", cardId: "story-ex7301" }));
    expect(r.ok).toBe(true);
  });
});
