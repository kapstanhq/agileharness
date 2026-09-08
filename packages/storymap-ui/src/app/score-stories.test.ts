import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card, StatusDef } from "@/lib/storymap/types";

// scoreStoriesAction é o caminho canônico de prioridade de STORY. Estes testes pinam os contratos que
// ela promete — dois deles corrigem bugs que estavam VIVOS na versão anterior:
//   • o cohort incluía cards TERMINAIS: no storymap, 143 das 173 stories (83%) e no acme 73 de 76
//     (96%) eram trabalho entregue, mandado ao modelo sem nenhuma marca de que estava entregue.
//   • o laço gravava `source:"agent"` em todo item devolvido, PISANDO no override humano.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let cardsOnDisk: Card[] = [];
let boardConfig: BoardConfig;
let lastPrompt = "";
let claudeReply = "";

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readBoardConfig: async () => boardConfig,
    readCards: async () => cardsOnDisk,
    readCard: async (_b: string, id: string) => cardsOnDisk.find((c) => c.id === id) ?? null,
  };
});

vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    updateCardOnDisk: async (_b: string, id: string, mutate: (c: Card) => Card | null) => {
      const i = cardsOnDisk.findIndex((c) => c.id === id);
      if (i === -1) return null;
      const next = mutate(cardsOnDisk[i]);
      if (next) cardsOnDisk[i] = next;
      return next;
    },
  };
});

vi.mock("@/lib/storymap/smart-capture/claude", () => ({
  runClaudeJson: async (prompt: string) => {
    lastPrompt = prompt;
    return claudeReply;
  },
}));

import { scoreStoriesAction } from "./priority-actions";

const STATUSES: StatusDef[] = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "priorizar", name: "Estimar" },
  { id: "concluida", name: "No ar", terminal: true, delivered: true },
];

const card = (over: Partial<Card>): Card =>
  ({
    id: "story-x",
    type: "story",
    title: "t",
    storyType: "user",
    status: "triage",
    parent: null,
    personas: [],
    systems: [],
    links: [],
    acceptance: [],
    tasks: [],
    body: "",
    rice: { reach: null, impact: null, confidence: null, effort: null },
    kano: null,
    funnelStage: null,
    ...over,
  }) as Card;

const reply = (items: unknown[]) => JSON.stringify({ items });
const item = (id: string, o: Record<string, number> = {}) => ({
  id,
  value: 8,
  urgency: 3,
  unlock: 5,
  size: 2,
  rationale: `porque ${id}`,
  ...o,
});

beforeEach(() => {
  boardConfig = {
    id: "b",
    name: "B",
    statuses: STATUSES,
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
    desiredOutcome: "dobrar o WAU",
  };
  cardsOnDisk = [];
  lastPrompt = "";
  claudeReply = "";
});

describe("scoreStoriesAction", () => {
  it("grava os ordinais e DERIVA o rank deles (o rank é cache, não opinião)", async () => {
    cardsOnDisk = [card({ id: "a", title: "A" })];
    claudeReply = reply([item("a")]); // (8+3+5)/2 = 8,0 → tier 3

    const res = await scoreStoriesAction({ boardId: "b" });

    expect(res.ok).toBe(true);
    const pc = cardsOnDisk[0].priorityCall!;
    expect(pc.wsjf).toMatchObject({ value: 8, urgency: 3, unlock: 5, size: 2 });
    expect(pc.rank).toBe(3);
    expect(pc.rationale).toBe("porque a");
    expect(pc.source).toBe("agent");
    expect(typeof pc.wsjf!.cohortAt).toBe("string");
  });

  it("NÃO manda cards terminais ao modelo — nem como alvo, nem como fila", async () => {
    cardsOnDisk = [
      card({ id: "aberto", title: "Card em aberto" }),
      card({ id: "feito", title: "Coisa entregue faz tempo", status: "concluida" }),
    ];
    claudeReply = reply([item("aberto")]);

    const res = await scoreStoriesAction({ boardId: "b" });

    expect(res.ok).toBe(true);
    expect((res as { data: { total: number } }).data.total).toBe(1);
    const secaoAlvos = lastPrompt.slice(lastPrompt.indexOf("# Os itens a pontuar"));
    expect(secaoAlvos).not.toContain("Coisa entregue faz tempo");
    // mas ele aparece como CONTEXTO do que o produto já faz
    expect(lastPrompt).toContain("JÁ FAZ hoje");
    expect(lastPrompt).toContain("Coisa entregue faz tempo");
    expect(cardsOnDisk[1].priorityCall).toBeUndefined();
  });

  it("NUNCA sobrescreve um priorityCall humano — ele vira ÂNCORA, não alvo", async () => {
    const humano = card({
      id: "meu",
      title: "Eu decidi isto",
      priorityCall: {
        rank: 3,
        rationale: "eu quero isto agora",
        source: "human",
        assessedAt: "2026-01-01T00:00:00.000Z",
        wsjf: { value: 13, urgency: 8, unlock: 8, size: 2, basis: [], cohortSize: 1, cohortAt: "2026-01-01" },
      },
    });
    cardsOnDisk = [humano, card({ id: "outro", title: "Outro card" })];
    // o modelo tenta rebaixar o card humano de propósito
    claudeReply = reply([item("meu", { value: 1, urgency: 1, unlock: 1, size: 13 }), item("outro")]);

    const res = await scoreStoriesAction({ boardId: "b", cardIds: ["meu", "outro"] });

    expect(res.ok).toBe(true);
    expect((res as { data: { skippedHuman: number } }).data.skippedHuman).toBe(1);
    // intacto, byte a byte
    expect(cardsOnDisk[0].priorityCall).toEqual(humano.priorityCall);
    // e serviu de régua para o outro
    expect(lastPrompt).toContain("eu quero isto agora");
    expect(cardsOnDisk[1].priorityCall?.rank).toBe(3);
  });

  it("reporta cobertura PARCIAL em vez de fingir que priorizou tudo", async () => {
    cardsOnDisk = ["a", "b", "c"].map((id) => card({ id, title: id }));
    claudeReply = reply([item("a")]);

    const res = await scoreStoriesAction({ boardId: "b" });

    expect(res.ok).toBe(true);
    const d = (res as { data: { scored: number; missing: string[]; total: number } }).data;
    expect(d).toMatchObject({ scored: 1, total: 3 });
    expect(d.missing.sort()).toEqual(["b", "c"]);
  });

  it("lote DEGENERADO falha alto e NÃO grava nada (ranking fantasma é pior que nenhum)", async () => {
    cardsOnDisk = ["a", "b", "c", "d", "e"].map((id) => card({ id, title: id }));
    claudeReply = reply(["a", "b", "c", "d", "e"].map((id) => item(id, { value: 8, size: 3 })));

    const res = await scoreStoriesAction({ boardId: "b" });

    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("mesma nota");
    expect(cardsOnDisk.every((c) => c.priorityCall == null)).toBe(true);
  });

  it("sem cardIds pontua SÓ quem ainda não tem score (semeio não remexe no já decidido)", async () => {
    const jaPontuado = card({
      id: "velho",
      title: "Já pontuado",
      priorityCall: {
        rank: 1,
        rationale: "antigo",
        source: "agent",
        assessedAt: "2026-01-01T00:00:00.000Z",
        wsjf: { value: 2, urgency: 2, unlock: 2, size: 3, basis: [], cohortSize: 1, cohortAt: "2026-01-01" },
      },
    });
    cardsOnDisk = [jaPontuado, card({ id: "novo", title: "Novo" })];
    claudeReply = reply([item("novo")]);

    const res = await scoreStoriesAction({ boardId: "b" });

    expect(res.ok).toBe(true);
    expect((res as { data: { total: number } }).data.total).toBe(1);
    expect(cardsOnDisk[0].priorityCall).toEqual(jaPontuado.priorityCall);
  });

  it("com cardIds REAVALIA mesmo quem já tem score (o caminho 'reavaliar este card')", async () => {
    cardsOnDisk = [
      card({
        id: "velho",
        title: "Já pontuado",
        priorityCall: {
          rank: 0,
          rationale: "antigo",
          source: "agent",
          assessedAt: "2026-01-01T00:00:00.000Z",
          wsjf: { value: 1, urgency: 1, unlock: 1, size: 13, basis: [], cohortSize: 1, cohortAt: "2026-01-01" },
        },
      }),
    ];
    claudeReply = reply([item("velho")]);

    const res = await scoreStoriesAction({ boardId: "b", cardIds: ["velho"] });

    expect(res.ok).toBe(true);
    expect(cardsOnDisk[0].priorityCall?.rank).toBe(3);
    expect(cardsOnDisk[0].priorityCall?.rationale).toBe("porque velho");
  });

  it("registra em basis que o contexto de entregues existia", async () => {
    cardsOnDisk = [
      card({ id: "a", title: "A", narrative: { role: "op", want: "x", soThat: "valor" } }),
      card({ id: "feito", title: "Entregue", status: "concluida" }),
    ];
    claudeReply = reply([item("a")]);

    await scoreStoriesAction({ boardId: "b" });

    expect(cardsOnDisk[0].priorityCall?.wsjf?.basis).toContain("soThat");
    expect(cardsOnDisk[0].priorityCall?.wsjf?.basis).toContain("entregues");
  });

  it("resposta inútil não grava nada e devolve erro legível", async () => {
    cardsOnDisk = [card({ id: "a", title: "A" })];
    claudeReply = "desculpe, não consegui";

    const res = await scoreStoriesAction({ boardId: "b" });

    expect(res.ok).toBe(false);
    expect(cardsOnDisk[0].priorityCall).toBeUndefined();
  });

  it("board sem story em aberto recusa com mensagem clara", async () => {
    cardsOnDisk = [card({ id: "feito", title: "Entregue", status: "concluida" })];
    const res = await scoreStoriesAction({ boardId: "b" });
    expect(res).toEqual({ ok: false, error: "Nenhuma story em aberto para priorizar." });
  });
});
