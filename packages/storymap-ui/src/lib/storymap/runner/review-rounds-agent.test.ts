// O portão do teto para o que um agente cria (review-rounds-agent.ts), com a sessão, o disco e a contagem falsos:
//   · B2 — só a sessão PROVADA decide a herança (o rótulo sozinho não);
//   · M1 — com a sessão provada num card que carrega cadeia, qualquer story herda, e `continuesFrom` fora da árvore é
//     recusado;
//   · a resposta do portão de contagem vira marca, «teto» ou nada.
// E as duas regras de CONTAGEM (M2): a lixeira conta, e um board ilegível pergunta ao dono em vez de contar a menos.
// Fixtures inventadas (uma oficina de bicicletas).

import { describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";
import { coerceCard } from "@/lib/storymap/repo";
import { agentRoundsDecision, type AgentRoundsDeps } from "./review-rounds-agent";
import { cardCarriesReviewChain, type BoardCard } from "./review-rounds";
import type { SessionBinding } from "./session-binding";
import type { ReviewRoundsDecision } from "./review-rounds-deps";

const card = (id: string, over: Partial<Card> = {}): Card => ({ ...coerceCard(id, { type: "story", title: `Freios ${id}` }, ""), labels: [], links: [], ...over }) as Card;
const finding = (over: Record<string, unknown> = {}) => ({ id: "f1", lens: "security", severity: "high", status: "open", title: "a pinça raspa", ...over });
const raiz = card("story-ex7201", { findings: [finding()] } as Partial<Card>);
const solto = card("story-ex7202");
const membro = card("story-ex7203", { reviewChain: { root: "oficina/story-ex7201", round: 2 } } as Partial<Card>);
const all: BoardCard[] = [raiz, solto, membro].map((c) => ({ board: "oficina", card: c }));

function deps(binding: SessionBinding, gateOut: ReviewRoundsDecision = { gate: "open", mark: { root: "oficina/story-ex7201", round: 3 } }) {
  const gate = vi.fn(async () => gateOut);
  const d: Partial<AgentRoundsDeps> = {
    binding: async () => binding,
    readCard: async (_b, id) => [raiz, solto, membro].find((c) => c.id === id) ?? null,
    readAll: async () => all,
    gate,
  };
  return { d, gate };
}
const bound: SessionBinding = { state: "bound", session: { sessionId: "s-1", agentId: "s-1", role: "worker", board: "oficina", cardId: "story-ex7201", task: "t", openedAt: "", heartbeatAt: "" } as never };

describe("agentRoundsDecision", () => {
  it("B2: sessão não provada não herda — sem continuesFrom, nada em jogo", async () => {
    const { d, gate } = deps({ state: "unproven", sessionId: "s-1", why: "sem prova" });
    expect(await agentRoundsDecision({ boardId: "oficina", summary: "x", actor: undefined }, d)).toEqual({ kind: "none" });
    expect(gate).not.toHaveBeenCalled();
  });

  it("M1: sessão provada num card com cadeia ⇒ a criação herda (marca da rodada, vínculo no mesmo board)", async () => {
    const { d, gate } = deps(bound);
    const r = await agentRoundsDecision({ boardId: "oficina", summary: "x", actor: undefined }, d);
    expect(gate).toHaveBeenCalledWith("oficina", "story-ex7201", "x");
    expect(r).toMatchObject({ kind: "stamp", stamp: { labels: ["rodada-de-revisao"], links: [{ rel: "relates-to", to: "story-ex7201" }], reviewChain: { round: 3 } } });
  });

  it("M1: continuesFrom DENTRO da árvore vale; FORA da árvore é recusado", async () => {
    const dentro = await agentRoundsDecision({ boardId: "oficina", summary: "x", continuesFrom: "story-ex7203", actor: undefined }, deps(bound).d);
    expect(dentro.kind).toBe("stamp");
    const fora = await agentRoundsDecision({ boardId: "oficina", summary: "x", continuesFrom: "story-ex7202", actor: undefined }, deps(bound).d);
    expect(fora).toMatchObject({ kind: "refuse", error: expect.stringMatching(/FORA da cadeia/) });
  });

  it("sem sessão, continuesFrom explícito é a origem (o fluxo normal)", async () => {
    const { d, gate } = deps({ state: "none" });
    expect((await agentRoundsDecision({ boardId: "oficina", summary: "x", continuesFrom: "story-ex7202", actor: undefined }, d)).kind).toBe("stamp");
    expect(gate).toHaveBeenCalledWith("oficina", "story-ex7202", "x");
  });

  it("continuesFrom que não existe é recusado", async () => {
    const r = await agentRoundsDecision({ boardId: "oficina", summary: "x", continuesFrom: "story-ex7299", actor: undefined }, deps({ state: "none" }).d);
    expect(r).toMatchObject({ kind: "refuse" });
  });

  it("no teto (perguntei / aceitou / parou) nada nasce — e a nota diz por quê", async () => {
    for (const g of ["asked", "accepted", "stopped"] as const) {
      const r = await agentRoundsDecision({ boardId: "oficina", summary: "x", actor: undefined }, deps(bound, { gate: g, mark: null }).d);
      expect(r).toMatchObject({ kind: "held", nota: expect.stringMatching(/não abra outro card/) });
    }
  });

  it("árvore ilegível ao conferir um continuesFrom da sessão ⇒ recusa (nada criado), nunca aceita às cegas", async () => {
    const { d } = deps(bound);
    d.readAll = async () => {
      throw new Error("board ilegível");
    };
    expect((await agentRoundsDecision({ boardId: "oficina", summary: "x", continuesFrom: "story-ex7203", actor: undefined }, d)).kind).toBe("refuse");
  });
});

describe("cardCarriesReviewChain", () => {
  it("rodada, achado aberto, ou achado fechado por AGENTE carregam a cadeia; fechado pelo dono ou achado geral não", () => {
    expect(cardCarriesReviewChain(membro)).toBe(true);
    expect(cardCarriesReviewChain(raiz)).toBe(true);
    expect(cardCarriesReviewChain(card("a", { findings: [finding({ status: "fixed", statusBy: "copilot" })] } as Partial<Card>))).toBe(true);
    expect(cardCarriesReviewChain(card("b", { findings: [finding({ status: "fixed", statusBy: "human" })] } as Partial<Card>))).toBe(false);
    expect(cardCarriesReviewChain(card("c", { findings: [finding({ lens: "general" })] } as Partial<Card>))).toBe(false);
    expect(cardCarriesReviewChain(solto)).toBe(false);
  });
});
