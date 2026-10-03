import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";
import type { AgentSession } from "@/lib/storymap/runner/session-worktree";
import type { CardClaim } from "@/lib/storymap/runner/claims";

// conductor-core — the server actions behind the conductor's MCP tools (add_finding, set_tasks,
// set_card_driver, structured ask_question) and the route edit that must not drop the driver. Each goes
// through updateCardOnDisk (the service's single writer); these pin what reaches the card on MAIN.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let cardOnDisk: Card;
let writes = 0;
let sessions: AgentSession[] = [];
let claims: CardClaim[] = [];

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readCard: async () => cardOnDisk,
    readCards: async () => [cardOnDisk],
    readBoardConfig: async () => ({ id: "b", name: "B", statuses: [{ id: "desenvolver", name: "Dev" }], releases: [], personas: [], systems: [], linkTypes: [] }),
  };
});

vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    updateCardOnDisk: async (_b: string, _id: string, mutate: (c: Card) => Card | null) => {
      const next = mutate(cardOnDisk);
      if (next) {
        cardOnDisk = next;
        writes += 1;
      }
      return next;
    },
    writeCard: async () => {},
  };
});

vi.mock("@/lib/storymap/runner/session-worktree", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/session-worktree")>();
  return { ...actual, allSessions: async () => sessions };
});

vi.mock("@/lib/storymap/runner/claims", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/claims")>();
  return { ...actual, getCardClaims: () => ({ list: async () => claims }) };
});

import { addFindingAction, askQuestionsAction, setCardDriverAction, setCardRouteAction, setTasksAction } from "./actions";
import { coerceCard } from "@/lib/storymap/repo";

const conductorSession: AgentSession = {
  sessionId: "sess-1",
  agentId: "agent-1",
  role: "implement",
  board: "b",
  cardId: "story-x",
  task: "conduzir",
  openedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
};
const liveClaim = (actor: string): CardClaim => ({
  board: "b",
  cardId: "story-x",
  actor,
  kind: "implement",
  scope: "both",
  acquiredAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  heartbeatAt: new Date().toISOString(),
});

beforeEach(() => {
  cardOnDisk = coerceCard("story-x", { type: "story", status: "desenvolver" }, "");
  writes = 0;
  sessions = [conductorSession];
  claims = [];
});
afterEach(() => vi.clearAllMocks());

describe("setTasksAction — só a sessão DONA do card grava a evidência do build", () => {
  const tasks = [
    { id: "t1", title: "teste vermelho", done: true },
    { id: "t2", title: "implementação", done: false },
  ];

  it("com o claim vivo da sessão: substitui as tasks na main", async () => {
    claims = [liveClaim("session:agent-1")];
    const res = await setTasksAction({ boardId: "b", cardId: "story-x", sessionId: "sess-1", tasks });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.tasks).toEqual(tasks);
  });

  it("SEM o claim (ou com o claim de outro ator): recusa nomeando o dono e NÃO escreve", async () => {
    claims = [liveClaim("run:xyz")];
    const res = await setTasksAction({ boardId: "b", cardId: "story-x", sessionId: "sess-1", tasks });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error).toContain("run:xyz");
    expect(writes).toBe(0);
    expect(cardOnDisk.tasks).toEqual([]);
  });

  it("sessão desconhecida e lista malformada são recusadas sem escrita", async () => {
    claims = [liveClaim("session:agent-1")];
    expect((await setTasksAction({ boardId: "b", cardId: "story-x", sessionId: "forjada", tasks })).ok).toBe(false);
    expect((await setTasksAction({ boardId: "b", cardId: "story-x", sessionId: "sess-1", tasks: [tasks[0], tasks[0]] })).ok).toBe(false);
    expect(writes).toBe(0);
  });
});

describe("addFindingAction — um finding NA MAIN no meio do build", () => {
  it("cria `open`; re-adicionar o mesmo id com o mesmo conteúdo não escreve de novo", async () => {
    const first = await addFindingAction({ boardId: "b", cardId: "story-x", finding: { id: "conductor-budget", severity: "high", title: "teto" } });
    expect(first).toMatchObject({ ok: true, data: { id: "conductor-budget", created: true } });
    expect(cardOnDisk.findings).toEqual([{ id: "conductor-budget", lens: "general", severity: "high", title: "teto", status: "open" }]);
    const again = await addFindingAction({ boardId: "b", cardId: "story-x", finding: { id: "conductor-budget", severity: "high", title: "teto" } });
    expect(again).toMatchObject({ ok: true, data: { changed: false } });
    expect(writes).toBe(1);
  });
});

describe("setCardDriverAction", () => {
  it("marca e desmarca — e desmarcar preserva uma rota com substância", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", status: "desenvolver", routing: { skips: ["interview"], decidedBy: "agent", decidedAt: "d" } }, "");
    await setCardDriverAction({ boardId: "b", cardId: "story-x", driver: "conductor" });
    expect(cardOnDisk.routing).toMatchObject({ skips: ["interview"], driver: "conductor" });
    const res = await setCardDriverAction({ boardId: "b", cardId: "story-x", driver: null });
    expect(res.ok && res.data?.changed).toBe(true);
    expect(cardOnDisk.routing).toEqual({ skips: ["interview"], decidedBy: "agent", decidedAt: "d" });
  });

  it("idempotente: marcar de novo não escreve", async () => {
    await setCardDriverAction({ boardId: "b", cardId: "story-x", driver: "conductor" });
    const before = writes;
    const res = await setCardDriverAction({ boardId: "b", cardId: "story-x", driver: "conductor" });
    expect(res.ok && res.data?.changed).toBe(false);
    expect(writes).toBe(before);
  });
});

describe("setCardRouteAction — editar/limpar a rota NÃO devolve o card conduzido à cascata", () => {
  it("limpar a rota de um card conduzido mantém o driver", async () => {
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", status: "desenvolver", routing: { skips: [], decidedBy: "rules", decidedAt: "d", driver: "conductor" } },
      "",
    );
    const res = await setCardRouteAction({ boardId: "b", cardId: "story-x", skips: [] });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.routing?.driver).toBe("conductor");
  });
});

describe("askQuestionsAction — perguntas ESTRUTURADAS (e o texto de sempre)", () => {
  it("grava opções/recomendação/contexto no card", async () => {
    const res = await askQuestionsAction({
      boardId: "b",
      cardId: "story-x",
      askedBy: "harness-conductor",
      questions: [
        {
          text: "Filtro no topo?",
          context: "muda a hierarquia",
          options: [{ label: "Sim", recommended: true }, { label: "Não" }],
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.questions?.[0]).toMatchObject({
      id: "q1",
      askedBy: "harness-conductor",
      context: "muda a hierarquia",
      mode: "single",
      options: [{ id: "o1", label: "Sim", recommended: true }, { id: "o2", label: "Não" }],
    });
  });

  it("uma pergunta estruturada inválida recusa o lote inteiro sem escrever", async () => {
    const res = await askQuestionsAction({
      boardId: "b",
      cardId: "story-x",
      texts: ["ok?"],
      questions: [{ text: "x", options: [{ label: "a", recommended: true }, { label: "b", recommended: true }] }],
    });
    expect(res.ok).toBe(false);
    expect(writes).toBe(0);
  });

  it("compat: só `texts` segue funcionando igual", async () => {
    const res = await askQuestionsAction({ boardId: "b", cardId: "story-x", texts: ["Qual o público?"] });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.questions?.[0]).toMatchObject({ id: "q1", text: "Qual o público?", askedBy: "operator", status: "open" });
  });

  it("nada para perguntar: recusa", async () => {
    expect((await askQuestionsAction({ boardId: "b", cardId: "story-x" })).ok).toBe(false);
  });
});
