import { beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";

// «Parar condutor» e «Devolver ao fluxo» (fase 3) — as duas alavancas do item «o condutor encerrou e ninguém assumiu».
// Elas matam sessões tmux, tiram o card da fila do condutor, soltam claims e reescrevem o roteamento, então:
//   · só a sessão do operador no navegador as usa — um agente pelo MCP (mesmo `full`) e o próprio serviço não;
//   · só as sessões de CONDUTOR deste card morrem (nunca a de outro card, nunca a de outro tipo no mesmo card);
//   · «Parar» guarda o card como adiado (senão a varredura de órfãos abriria outro condutor);
//   · card inexistente ⇒ erro ANTES de qualquer efeito (nada morto, nada solto, a fila intacta).
// Os efeitos (tmux, sessões, claims, fila, disco) são injetados; a régua de quem chama é a REAL (action-guard).

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

const killed: string[] = [];
const released: string[] = [];
const dropped: string[] = [];
let sessions: { board: string; cardId: string; agentId: string; tmuxSession?: string }[] = [];
let cards: Map<string, Record<string, unknown>>;

vi.mock("@/lib/vps/tmux", async (orig) => ({
  ...(await orig<typeof import("@/lib/vps/tmux")>()),
  killSession: vi.fn(async (name: string) => (killed.push(name), { ok: true })),
}));
vi.mock("@/lib/storymap/runner/session-worktree", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/runner/session-worktree")>()),
  allSessions: vi.fn(async () => sessions),
}));
vi.mock("@/lib/storymap/runner/claims", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/runner/claims")>()),
  getCardClaims: () => ({ release: async (board: string, cardId: string, actor: string) => void released.push(`${board}/${cardId}:${actor}`) }),
}));
vi.mock("@/lib/storymap/runner/conductor", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/runner/conductor")>()),
  withConductorDispatchLock: <T,>(fn: () => Promise<T>) => fn(),
  diskConductorQueueStore: () => ({}),
  dropQueuedConductorCard: vi.fn(async (_s: unknown, board: string, cardId: string) => (dropped.push(`${board}/${cardId}`), true)),
}));
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/repo")>()),
  readCard: vi.fn(async (_b: string, id: string) => cards.get(id) ?? null),
}));
vi.mock("@/lib/storymap/write", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/write")>()),
  updateCardOnDisk: vi.fn(async (_b: string, id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
    const cur = cards.get(id);
    if (!cur) return null;
    const next = mutate(cur);
    cards.set(id, next);
    return next;
  }),
}));
vi.mock("./audit-actions", async (orig) => ({ ...(await orig<typeof import("./audit-actions")>()), logHumanActionAction: vi.fn(async () => ({ ok: true })) }));

import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { returnCardToFlowAction, stopConductorAction } from "@/app/actions";

const CARD = "story-ex9301";
const conducted = () => ({ id: CARD, type: "story", title: "Estante de favoritos", status: "desenvolver", routing: { driver: "conductor", skips: [] }, findings: [], tasks: [] });

beforeEach(() => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
  cookieJar = null;
  killed.length = 0;
  released.length = 0;
  dropped.length = 0;
  cards = new Map([[CARD, conducted()]]);
  sessions = [
    { board: "livraria", cardId: CARD, agentId: "a1", tmuxSession: "agent-conductor-livraria-ab12" },
    { board: "livraria", cardId: CARD, agentId: "a2", tmuxSession: "agent-chat-livraria-cd34" },
    { board: "livraria", cardId: "story-ex9302", agentId: "a3", tmuxSession: "agent-conductor-livraria-ef56" },
  ];
});

async function operatorCookie(): Promise<void> {
  cookieJar = { [SESSION_COOKIE]: await signSession({ sessionSecret: SESSION_SECRET, operatorToken: OPERATOR_TOKEN }) };
}

describe("só o operador para ou devolve o condutor", () => {
  it("um agente pelo MCP — mesmo com o token FULL — é recusado, e nada acontece", async () => {
    cookieJar = {};
    for (const action of [stopConductorAction, returnCardToFlowAction]) {
      const r = await runWithMcpActor({ level: "full" }, () => action({ boardId: "livraria", cardId: CARD }));
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/do operador/) });
    }
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
    expect(released).toEqual([]);
    expect(cards.get(CARD)).toEqual(conducted());
  });
});

describe("«Parar condutor»", () => {
  it("a sessão do operador tira o card da fila, mata SÓ o condutor deste card, solta os claims, tira o driver e adia", async () => {
    await operatorCookie();
    const r = await stopConductorAction({ boardId: "livraria", cardId: CARD });
    expect(r).toMatchObject({ ok: true, data: { ended: ["agent-conductor-livraria-ab12"] } });
    expect(dropped).toEqual([`livraria/${CARD}`]);
    expect(killed).toEqual(["agent-conductor-livraria-ab12"]);
    expect(released.every((x) => x.startsWith(`livraria/${CARD}:`))).toBe(true);
    const card = cards.get(CARD)!;
    expect((card.routing as { driver?: string } | undefined)?.driver).toBeUndefined();
    expect(card.deferred).toBeTruthy();
  });

  it("card inexistente ⇒ erro, sem matar sessão, soltar claim nem mexer na fila", async () => {
    await operatorCookie();
    const r = await stopConductorAction({ boardId: "livraria", cardId: "story-ex9399" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/card não encontrado/) });
    expect(killed).toEqual([]);
    expect(released).toEqual([]);
    expect(dropped).toEqual([]);
  });
});

describe("«Devolver ao fluxo»", () => {
  it("card inexistente ⇒ erro, sem efeito nenhum", async () => {
    await operatorCookie();
    const r = await returnCardToFlowAction({ boardId: "livraria", cardId: "story-ex9399" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/card não encontrado/) });
    expect(killed).toEqual([]);
    expect(dropped).toEqual([]);
  });
});
