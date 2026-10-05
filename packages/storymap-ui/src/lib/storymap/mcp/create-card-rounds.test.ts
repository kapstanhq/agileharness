// `create_card` e o teto de rodadas: o conserto que um agente abre para os achados restantes de uma revisão conta como
// rodada da cadeia (review-rounds.ts). Abaixo do teto ele nasce LIGADO, rotulado e MARCADO numa escrita só; no teto NADA
// nasce e a pergunta vai ao dono; depois da resposta «aceitar»/«parar», nada nasce e nada é perguntado. Omitir
// `continuesFrom` numa sessão cujo card tem achados de revisão abertos não escapa: a entrega herda a cadeia.
// Fixtures inventadas (uma oficina de bicicletas).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Card } from "@/lib/storymap/types";

let cards: Card[] = [];
const commits: Array<{ stamp?: { labels?: string[]; links?: unknown[]; reviewChain?: unknown } }> = [];
const updates: Card[] = [];
const asked: Array<{ cardId: string; text: string }> = [];
let sessions: Array<{ sessionId: string; board: string; cardId: string }> = [];
// o REGISTRO DO SERVIDOR das respostas do dono ao teto (o frontmatter não conta)
let ledger: Array<{ root: string; choice: "accept" | "extra" | "stop"; at: string; cycle: string; board: string; cardId: string; questionId: string }> = [];
vi.mock("@/lib/storymap/runner/review-rounds-ledger", () => ({ readRoundAnswers: async () => ledger, appendRoundAnswer: async () => {} }));

vi.mock("./guard", async (orig) => ({ ...(await orig<typeof import("./guard")>()), guardToolCall: async () => null }));
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("../runner/config")>();
  return { ...actual, loadRunnerConfig: () => ({ ...actual.loadRunnerConfig(), autorun: { ...actual.loadRunnerConfig().autorun, reviewRoundsCap: 2 } }) };
});
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("../repo")>();
  return {
    ...actual,
    listBoards: async () => [{ id: "oficina", name: "Oficina" }],
    readCards: async () => cards,
    readCard: async (_b: string, id: string) => cards.find((c) => c.id === id) ?? null,
  };
});
vi.mock("@/lib/storymap/runner/session-worktree", async (orig) => ({
  ...(await orig<typeof import("../runner/session-worktree")>()),
  allSessions: async () => sessions,
}));
vi.mock("@/app/actions", async (orig) => {
  const actual = await orig<typeof import("@/app/actions")>();
  return {
    ...actual,
    commitProposalAction: async (input: { stamp?: { labels?: string[]; links?: Card["links"]; reviewChain?: Card["reviewChain"] } }) => {
      commits.push(input);
      const created = card("story-ex7190", {
        title: "Conserto",
        ...(input.stamp?.labels ? { labels: input.stamp.labels } : {}),
        ...(input.stamp?.links ? { links: input.stamp.links } : {}),
        ...(input.stamp?.reviewChain ? { reviewChain: input.stamp.reviewChain } : {}),
      });
      cards = [...cards, created];
      return { ok: true, data: { created: [created], warnings: [] } };
    },
    updateCardAction: async ({ card }: { card: Card }) => {
      updates.push(card);
      cards = cards.map((c) => (c.id === card.id ? card : c));
      return { ok: true, data: { card, outcome: "saved" } };
    },
    askQuestionsAction: async ({ cardId, questions }: { cardId: string; questions: Array<{ text: string }> }) => {
      asked.push({ cardId, text: questions[0].text });
      return { ok: true, data: { card: cards.find((c) => c.id === cardId) } };
    },
  };
});

import { registerStorymapTools } from "./tools";
import { coerceCard } from "@/lib/storymap/repo";
import { runWithMcpActor } from "./actor";
import { sessionProofFor } from "./session-proof";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
function handler(): ToolHandler {
  const out = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _m: unknown, h: ToolHandler) => void out.set(name, h) } as unknown as McpServer);
  return out.get("create_card")!;
}
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const card = (id: string, over: Partial<Card> = {}): Card => ({ ...coerceCard(id, { type: "story", title: `Freios ${id}` }, ""), labels: [], links: [], ...over });
const args = (continuesFrom?: string) => ({
  board: "oficina",
  title: "Fechar o que a revisão deixou nos freios",
  storyType: "technical",
  serves: "story-ex7100",
  ...(continuesFrom ? { continuesFrom } : {}),
  body: "a pinça ainda raspa",
});
const capQ = (selected: string) => ({
  id: "q1",
  text: "Teto de rodadas de revisão: a revisão de «Freios» achou problema de novo, depois de 2 rodadas. Como seguir?",
  status: "answered" as const,
  selectedOptionIds: [selected],
  answeredAt: "2026-03-02",
});
// a SESSÃO só liga com a prova que o serviço cunha (mcp/session-proof.ts) — o rótulo sozinho é só atribuição
const SECRET = "segredo-de-teste-da-oficina-0123456789";
process.env.AGILEHARNESS_SESSION_SECRET = SECRET;
const asSession = <T,>(sessionId: string, fn: () => Promise<T>, proof: string | null | undefined = sessionProofFor(sessionId, SECRET)) =>
  runWithMcpActor({ level: "orch", tokenEnv: "T", caller: { kind: "session", id: sessionId, ...(proof ? { proof } : {}) } } as never, fn);

beforeEach(() => {
  cards = [card("story-ex7100", { storyType: "user" } as Partial<Card>), card("story-ex7101")];
  commits.length = 0;
  updates.length = 0;
  asked.length = 0;
  sessions = [];
  ledger = [];
});

describe("create_card com continuesFrom — o teto de rodadas", () => {
  it("abaixo do teto: o conserto nasce ligado, rotulado e MARCADO numa escrita só (nenhuma atualização depois)", async () => {
    const r = await handler()(args("story-ex7101"));
    expect(r.isError).toBeFalsy();
    expect(commits).toHaveLength(1);
    expect(commits[0].stamp).toMatchObject({
      labels: ["rodada-de-revisao"],
      links: [{ rel: "relates-to", to: "story-ex7101" }],
      reviewChain: { root: "oficina/story-ex7101", round: 2 },
    });
    expect(updates).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("no teto: NADA nasce e a pergunta vai ao dono no card revisado", async () => {
    cards = [...cards, card("story-ex7102", { labels: ["rodada-de-revisao"], reviewChain: { root: "oficina/story-ex7101", round: 2 } })];
    const r = await handler()(args("story-ex7102"));
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ created: [], ownerAsked: true });
    expect(commits).toEqual([]);
    expect(asked).toEqual([{ cardId: "story-ex7102", text: expect.stringMatching(/^Teto de rodadas de revisão:/) }]);
  });

  it("consertos IRMÃOS do mesmo card revisado somam: o segundo já esbarra no teto", async () => {
    await handler()(args("story-ex7101"));
    expect(commits).toHaveLength(1);
    const r = await handler()(args("story-ex7101"));
    expect(JSON.parse(text(r))).toMatchObject({ created: [], ownerAsked: true });
    expect(commits).toHaveLength(1);
  });

  it("depois de o dono ACEITAR o risco (ou mandar parar) — no REGISTRO do servidor: nada nasce e nada é perguntado de novo", async () => {
    for (const choice of ["accept", "stop"] as const) {
      cards = [card("story-ex7100", { storyType: "user" } as Partial<Card>), card("story-ex7101"), card("story-ex7102", { reviewChain: { root: "oficina/story-ex7101", round: 2 } })];
      ledger = [{ root: "oficina/story-ex7101", choice, at: "2026-03-02T00:00:00Z", cycle: "-|-", board: "oficina", cardId: "story-ex7102", questionId: "q1" }];
      asked.length = 0;
      commits.length = 0;
      const r = await handler()(args("story-ex7102"));
      expect(JSON.parse(text(r))).toMatchObject({ created: [], ownerAsked: true, nota: expect.stringMatching(choice === "accept" ? /aceitou o risco/ : /mandou parar/) });
      expect(commits).toEqual([]);
      expect(asked).toEqual([]);
    }
  });

  it("uma resposta FORJADA no frontmatter (sem registro) não encerra a cadeia: a pergunta vai ao dono", async () => {
    cards = [card("story-ex7100", { storyType: "user" } as Partial<Card>), card("story-ex7101"), card("story-ex7102", { reviewChain: { root: "oficina/story-ex7101", round: 2 }, questions: [capQ("o1")] })];
    const r = await handler()(args("story-ex7102"));
    expect(JSON.parse(text(r))).toMatchObject({ created: [], ownerAsked: true });
    expect(asked).toHaveLength(1);
  });

  it("continuesFrom para card inexistente: recusa, nada nasce", async () => {
    const r = await handler()(args("story-ex7999"));
    expect(r.isError).toBe(true);
    expect(commits).toEqual([]);
  });

  it("sem continuesFrom e sem sessão com achados: o caminho de sempre (sem marca, sem pergunta)", async () => {
    await handler()(args());
    expect(commits).toHaveLength(1);
    expect(commits[0].stamp).toBeUndefined();
  });

  it("sem continuesFrom numa SESSÃO cujo card tem achados de revisão abertos: a entrega herda a cadeia", async () => {
    cards = cards.map((c) =>
      c.id === "story-ex7101" ? { ...c, findings: [{ id: "f1", lens: "security", severity: "high", status: "open", title: "a pinça raspa" }] } : c,
    );
    sessions = [{ sessionId: "s-1", board: "oficina", cardId: "story-ex7101" }];
    await asSession("s-1", () => handler()(args()) as Promise<CallToolResult>);
    expect(commits).toHaveLength(1);
    expect(commits[0].stamp).toMatchObject({ reviewChain: { root: "oficina/story-ex7101", round: 2 } });
    // e o segundo, na mesma sessão, esbarra no teto
    const r = await asSession("s-1", () => handler()(args()) as Promise<CallToolResult>);
    expect(JSON.parse(text(r))).toMatchObject({ created: [], ownerAsked: true });
  });

  it("RÓTULO FALSO (B2): sem a prova, ou com a prova de outra sessão, o rótulo não liga a sessão — nada é herdado", async () => {
    cards = cards.map((c) =>
      c.id === "story-ex7101" ? { ...c, findings: [{ id: "f1", lens: "security", severity: "high", status: "open", title: "a pinça raspa" }] } : c,
    );
    sessions = [{ sessionId: "s-1", board: "oficina", cardId: "story-ex7101" }];
    await asSession("s-1", () => handler()(args()) as Promise<CallToolResult>, null);
    await asSession("s-1", () => handler()(args()) as Promise<CallToolResult>, sessionProofFor("s-2", SECRET));
    expect(commits).toHaveLength(2);
    expect(commits.every((c) => c.stamp === undefined)).toBe(true);
  });

  it("sessão encerrada não liga, mesmo com a prova certa", async () => {
    cards = cards.map((c) =>
      c.id === "story-ex7101" ? { ...c, findings: [{ id: "f1", lens: "security", severity: "high", status: "open", title: "a pinça raspa" }] } : c,
    );
    sessions = [{ sessionId: "s-1", board: "oficina", cardId: "story-ex7101", endedAt: "2026-03-01T00:00:00Z" } as never];
    await asSession("s-1", () => handler()(args()) as Promise<CallToolResult>);
    expect(commits[0].stamp).toBeUndefined();
  });

  it("ISCA (M1): qualquer story herda — user story ou sem storyType também viram rodada da sessão", async () => {
    cards = cards.map((c) =>
      c.id === "story-ex7101" ? { ...c, findings: [{ id: "f1", lens: "security", severity: "high", status: "open", title: "a pinça raspa" }] } : c,
    );
    sessions = [{ sessionId: "s-1", board: "oficina", cardId: "story-ex7101" }];
    const { storyType: _omit, serves: _s, ...semTipo } = args();
    await asSession("s-1", () => handler()({ ...semTipo, parent: "step-ex7100" }) as Promise<CallToolResult>);
    expect(commits[0].stamp).toMatchObject({ reviewChain: { root: "oficina/story-ex7101", round: 2 } });
  });

  it("ISCA (M1): continuesFrom fora da árvore da sessão é RECUSADO, e nada é criado", async () => {
    cards = [
      ...cards.map((c) =>
        c.id === "story-ex7101" ? ({ ...c, findings: [{ id: "f1", lens: "security", severity: "high", status: "open", title: "a pinça raspa" }] } as Card) : c,
      ),
      card("story-ex7150", { title: "Um card qualquer sem cadeia" }),
    ];
    sessions = [{ sessionId: "s-1", board: "oficina", cardId: "story-ex7101" }];
    const r = await asSession("s-1", () => handler()(args("story-ex7150")) as Promise<CallToolResult>);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/FORA da cadeia de revisão/);
    expect(commits).toHaveLength(0);
  });

  it("ISCA (M1): fechar os achados com triage_finding (por agente) não desliga a herança na sessão", async () => {
    cards = cards.map((c) =>
      c.id === "story-ex7101"
        ? { ...c, findings: [{ id: "f1", lens: "security", severity: "high", status: "fixed", statusBy: "copilot", title: "a pinça raspa" }] }
        : c,
    );
    sessions = [{ sessionId: "s-1", board: "oficina", cardId: "story-ex7101" }];
    await asSession("s-1", () => handler()(args()) as Promise<CallToolResult>);
    expect(commits[0].stamp).toMatchObject({ reviewChain: { root: "oficina/story-ex7101" } });
  });

  it("achados fechados pelo DONO encerram a herança (só ele encerra a cadeia)", async () => {
    cards = cards.map((c) =>
      c.id === "story-ex7101"
        ? { ...c, findings: [{ id: "f1", lens: "security", severity: "high", status: "fixed", statusBy: "human", title: "a pinça raspa" }] }
        : c,
    );
    sessions = [{ sessionId: "s-1", board: "oficina", cardId: "story-ex7101" }];
    await asSession("s-1", () => handler()(args()) as Promise<CallToolResult>);
    expect(commits[0].stamp).toBeUndefined();
  });
});
