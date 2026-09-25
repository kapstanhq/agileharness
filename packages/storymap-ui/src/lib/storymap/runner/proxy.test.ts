// The ULTRA proxy DISPATCHER — every guard that lets it run unattended, proven against fakes (no spawn, no disk).
//   • money / uncategorized / human ⇒ never spawned; a card waiting on its owner never holds up another card;
//   • the same switches as autorun (master, board kill-switch) and the box's admission pause it — nothing dropped;
//   • bounded: attempts counted BEFORE the spawn, capped per question; one proxy per card; a concurrency cap;
//   • the writer's verdict is final (an owner who answered first wins); a decline returns the question to the owner.

import { describe, expect, it, vi } from "vitest";
import { applyProxyAnswers, markProxyDeclined } from "@/lib/storymap/autonomy";
import { memoryProxyLedger, PROXY_MAX_ATTEMPTS, proxyCard, proxyWork, sweepProxy, type ProxyDispatchDeps } from "./proxy";
import { ownerDecisions } from "./proxy-deps";
import type { ProxyRequest, ProxyResult } from "./proxy-spawn";
import type { BoardConfig, Card, CardQuestion } from "@/lib/storymap/types";

const config = (over: Partial<BoardConfig> = {}): BoardConfig => ({
  id: "b",
  name: "B",
  statuses: [{ id: "grill", name: "Dúvidas" }],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  autonomy: { mode: "ultra" },
  ...over,
});

const card = (id: string, questions: CardQuestion[], over: Partial<Card> = {}): Card =>
  ({ id, type: "story", title: id, storyType: "user", status: "grill", questions, ...over }) as unknown as Card;

const q = (id: string, extra: Partial<CardQuestion> = {}): CardQuestion => ({ id, text: `pergunta ${id}`, status: "open", ...extra });

/** A board in memory + a fake proxy that answers every question it is given. */
function world(cards: Card[], cfg: BoardConfig = config(), over: Partial<ProxyDispatchDeps> = {}) {
  const state = { cards: cards.map((c) => ({ ...c })) };
  const spawned: ProxyRequest[] = [];
  const ledger = memoryProxyLedger();
  const deps: ProxyDispatchDeps = {
    ledger,
    listBoards: async () => ["b"],
    readBoardConfig: async () => cfg,
    readCards: async () => state.cards,
    masterEnabled: () => true,
    admission: () => null,
    buildRequest: async (board, c, _cfg, questions) =>
      ({ board, cardId: c.id, cardTitle: c.title, personas: [], history: [], questions: questions.map((x) => ({ id: x.id, text: x.text, category: x.category as "interview" })), model: "sonnet" }) as ProxyRequest,
    spawn: async (req): Promise<ProxyResult> => {
      spawned.push(req);
      return { runId: `run-${spawned.length}`, answers: req.questions.map((x) => ({ questionId: x.id, answer: "resposta do proxy", assumptions: "PRD §1", confidence: 0.9 })) };
    },
    // the REAL pure writer over the in-memory card (the production writer wraps exactly this in the card lock)
    apply: async (board, cardId, answers, runId) => {
      const i = state.cards.findIndex((c) => c.id === cardId);
      const r = applyProxyAnswers(state.cards[i], cfg, board, cardId, answers, { today: "2026-09-25", runId });
      state.cards[i] = { ...state.cards[i], questions: r.questions };
      return r.applied;
    },
    decline: async (_board, cardId, items, runId) => {
      const i = state.cards.findIndex((c) => c.id === cardId);
      state.cards[i] = { ...state.cards[i], questions: markProxyDeclined(state.cards[i].questions ?? [], items, { runId }) };
    },
    inFlight: new Set(),
    log: () => {},
    ...over,
  };
  return { deps, state, spawned, ledger };
}

describe("proxyWork — a seleção", () => {
  it("ultra: só interview/ui-choice abertas; human/money/sem categoria ficam fora", () => {
    const c = card("c", [q("q1", { category: "interview" }), q("q2", { category: "money" }), q("q3"), q("q4", { category: "ui-choice" })]);
    expect(proxyWork(c, config(), "b", []).map((x) => x.id)).toEqual(["q1", "q4"]);
    expect(proxyWork(c, config({ autonomy: { mode: "human" } }), "b", [])).toEqual([]);
    expect(proxyWork({ ...c, autonomyMode: "human" }, config(), "b", [])).toEqual([]);
  });

  it("o ledger tira o que já foi respondido/recusado e o que esgotou as tentativas", () => {
    const c = card("c", [q("q1", { category: "interview" }), q("q2", { category: "interview" }), q("q3", { category: "interview" })]);
    const ledger = [
      { key: "b/c/q1", attempts: 1, lastAt: "", outcome: "declined" as const },
      { key: "b/c/q2", attempts: PROXY_MAX_ATTEMPTS, lastAt: "", outcome: "failed" as const },
      { key: "b/c/q3", attempts: 1, lastAt: "", outcome: "failed" as const },
    ];
    expect(proxyWork(c, config(), "b", ledger).map((x) => x.id)).toEqual(["q3"]);
  });
});

describe("proxyCard — um card", () => {
  it("responde as proxiáveis com premissas, carimba answeredBy proxy, registra no ledger e avisa o condutor", async () => {
    const resumeConductor = vi.fn(async () => {});
    const bookCost = vi.fn(async () => {});
    const { deps, state, spawned, ledger } = world([card("c", [q("q1", { category: "interview" }), q("q2", { category: "money" })])], config(), {
      resumeConductor,
      bookCost,
    });
    const out = await proxyCard(deps, "b", "c");
    expect(out).toMatchObject({ action: "spawned", applied: ["q1"], declined: [] });
    expect(spawned[0].questions.map((x) => x.id)).toEqual(["q1"]); // o dinheiro nunca chegou ao proxy
    const [q1, q2] = state.cards[0].questions!;
    expect(q1).toMatchObject({ status: "answered", answeredBy: "proxy", proxy: { assumptions: "PRD §1", confidence: 0.9 } });
    expect(q2.status).toBe("open");
    expect(ledger.entries).toEqual([expect.objectContaining({ key: "b/c/q1", attempts: 1, outcome: "answered" })]);
    expect(resumeConductor).toHaveBeenCalledWith("b", "c", ["q1"]);
    expect(bookCost).toHaveBeenCalledOnce();
  });

  it("story human ⇒ nada (nem ledger, nem spawn)", async () => {
    const { deps, spawned, ledger } = world([card("c", [q("q1", { category: "interview" })], { autonomyMode: "human" })]);
    expect((await proxyCard(deps, "b", "c")).action).toBe("skipped");
    expect(spawned).toEqual([]);
    expect(ledger.entries).toEqual([]);
  });

  it("master switch desligado, board desarmado ou máquina saturada ⇒ ESPERA (nada gasto, nada contado)", async () => {
    const c = [card("c", [q("q1", { category: "interview" })])];
    for (const over of [{ masterEnabled: () => false }, { admission: () => "RAM baixa" }]) {
      const { deps, spawned, ledger } = world(c, config(), over);
      expect((await proxyCard(deps, "b", "c")).action).toBe("waiting");
      expect(spawned).toEqual([]);
      expect(ledger.entries).toEqual([]);
    }
    const off = world(c, config({ autorunDisabled: true }));
    expect((await proxyCard(off.deps, "b", "c")).action).toBe("waiting");
    expect(off.spawned).toEqual([]);
  });

  it("um proxy por card e o teto de simultâneos: com vaga ocupada, ESPERA", async () => {
    const c = [card("c", [q("q1", { category: "interview" })])];
    const same = world(c, config(), { inFlight: new Set(["b/c"]) });
    expect(await proxyCard(same.deps, "b", "c")).toMatchObject({ action: "waiting", reason: expect.stringMatching(/já há um proxy/) });
    const full = world(c, config(), { inFlight: new Set(["b/outro"]), maxConcurrent: 1 });
    expect(await proxyCard(full.deps, "b", "c")).toMatchObject({ action: "waiting", reason: expect.stringMatching(/teto/) });
    expect(full.spawned).toEqual([]);
  });

  it("a tentativa é CONTADA ANTES do spawn — um proxy que falha para no teto (sem laço)", async () => {
    let calls = 0;
    const { deps, ledger } = world([card("c", [q("q1", { category: "interview" })])], config(), {
      spawn: async () => {
        calls++;
        expect(ledger.entries[0]).toMatchObject({ key: "b/c/q1", outcome: "running", attempts: calls });
        return { runId: `r${calls}`, error: "o proxy estourou o relógio" };
      },
    });
    for (let i = 0; i < PROXY_MAX_ATTEMPTS + 2; i++) await proxyCard(deps, "b", "c");
    expect(calls).toBe(PROXY_MAX_ATTEMPTS);
    expect(ledger.entries[0]).toMatchObject({ outcome: "failed", attempts: PROXY_MAX_ATTEMPTS, detail: expect.stringMatching(/relógio/) });
  });

  it("no teto de falhas a pergunta é DEVOLVIDA ao dono no próprio card (o Inbox para de dizer 'o proxy está nela')", async () => {
    const { deps, state } = world([card("c", [q("q1", { category: "interview" })])], config(), {
      spawn: async () => ({ runId: "r", error: "o proxy estourou o relógio" }),
    });
    await proxyCard(deps, "b", "c");
    expect(state.cards[0].questions![0].proxy).toBeUndefined(); // 1ª falha: ainda tem tentativa
    await proxyCard(deps, "b", "c");
    expect(state.cards[0].questions![0]).toMatchObject({ status: "open", proxy: { declined: true, confidence: 0 } });
    expect(state.cards[0].questions![0].proxy!.assumptions).toMatch(/falhou 2x/);
  });

  it("recusa (`decline`) ⇒ a pergunta fica com o dono e o proxy não volta a ela", async () => {
    let calls = 0;
    const { deps, state, ledger } = world([card("c", [q("q1", { category: "interview" })])], config(), {
      spawn: async () => {
        calls++;
        return { runId: "r", answers: [{ questionId: "q1", decline: "depende do orçamento" }] };
      },
    });
    expect(await proxyCard(deps, "b", "c")).toMatchObject({ action: "spawned", applied: [], declined: ["q1"] });
    await proxyCard(deps, "b", "c");
    expect(calls).toBe(1);
    expect(state.cards[0].questions![0]).toMatchObject({ status: "open", proxy: { declined: true } });
    expect(state.cards[0].questions![0].proxy!.assumptions).toMatch(/depende do orçamento/);
    expect(ledger.entries[0].outcome).toBe("declined");
  });

  it("o dono respondeu ENQUANTO o proxy pensava ⇒ o escritor recusa e a resposta humana fica", async () => {
    const holder: { state?: { cards: Card[] } } = {};
    const w = world([card("c", [q("q1", { category: "interview" })])], config(), {
      spawn: async (req) => {
        holder.state!.cards[0] = { ...holder.state!.cards[0], questions: [q("q1", { category: "interview", status: "answered", answer: "a do dono" })] };
        return { runId: "r", answers: req.questions.map((x) => ({ questionId: x.id, answer: "do proxy", assumptions: "x", confidence: 0.9 })) };
      },
    });
    holder.state = w.state;
    const out = await proxyCard(w.deps, "b", "c");
    expect(out).toMatchObject({ action: "spawned", applied: [] });
    expect(w.state.cards[0].questions![0].answer).toBe("a do dono");
    expect(w.ledger.entries[0].outcome).toBe("answered"); // final: o card já seguiu
  });
});

describe("sweepProxy — o DINHEIRO espera o dono SEM travar o resto do board", () => {
  it("card A só com pergunta de dinheiro, B com entrevista, C sem categoria ⇒ só B vai ao proxy; A e C seguem com o dono", async () => {
    const cards = [
      card("a-dinheiro", [q("q1", { category: "money", text: "Assinamos o plano pago do provedor?" })]),
      card("b-entrevista", [q("q1", { category: "interview" })]),
      card("c-sem-categoria", [q("q1")]),
      card("d-piso", [q("q1", { category: "interview", text: "Qual o preço do plano anual?" })]),
    ];
    const { deps, state, spawned } = world(cards);
    const report = await sweepProxy(deps);
    expect(spawned.map((r) => r.cardId)).toEqual(["b-entrevista"]);
    expect(report.spawned).toEqual([{ board: "b", cardId: "b-entrevista", applied: ["q1"] }]);
    expect(report.waiting).toEqual([]); // nada ficou "esperando vaga" por causa do card de dinheiro
    const byId = new Map(state.cards.map((c) => [c.id, c]));
    expect(byId.get("a-dinheiro")!.questions![0].status).toBe("open");
    expect(byId.get("c-sem-categoria")!.questions![0].status).toBe("open");
    expect(byId.get("d-piso")!.questions![0].status).toBe("open");
    expect(byId.get("b-entrevista")!.questions![0].answeredBy).toBe("proxy");
  });

  it("board human inteiro com uma story ULTRA de exceção ⇒ só a exceção é proxiada", async () => {
    const cards = [card("x", [q("q1", { category: "interview" })]), card("y", [q("q1", { category: "interview" })], { autonomyMode: "ultra" })];
    const { deps, spawned } = world(cards, config({ autonomy: { mode: "human" } }));
    await sweepProxy(deps);
    expect(spawned.map((r) => r.cardId)).toEqual(["y"]);
  });
});

describe("ownerDecisions — o proxy imita o DONO, nunca a si mesmo", () => {
  it("só respostas humanas; resposta do proxy/copiloto e a auto-resolução de terminal ficam fora; mais recentes primeiro", () => {
    const cards = [
      card("c1", [
        q("q1", { status: "answered", answer: "velha", answeredAt: "2026-01-01" }),
        q("q2", { status: "answered", answer: "do proxy", answeredBy: "proxy", answeredAt: "2026-09-01" }),
        q("q3", { status: "answered", answer: "do jido", answeredBy: "copilot", answeredAt: "2026-09-01" }),
      ]),
      card("c2", [
        q("q1", { status: "answered", answer: "(sem resposta — card concluído/arquivado)", answeredAt: "2026-09-02" }),
        q("q2", { status: "answered", selectedOptionIds: ["o2"], options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }], answer: "porque sim", answeredAt: "2026-09-03" }),
      ]),
    ];
    expect(ownerDecisions(cards)).toEqual([
      { cardTitle: "c2", question: "pergunta q2", answer: "B — porque sim" },
      { cardTitle: "c1", question: "pergunta q1", answer: "velha" },
    ]);
  });
});
