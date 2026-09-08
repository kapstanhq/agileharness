// WS-9 (9.2) — generateTasksForIdeaAction guards the 1-idea→1-story auto-mint.
//
// Decisão do Operador (D15 / ADR-064): quando uma ideia JÁ é endereçada por uma story ativa, gerar
// MAIS stories duplica a trilha de entrega — exatamente o anti-padrão do incidente 07-15 (2 opps, cada uma
// → 1 story 1:1). Então a action recusa (needsConfirm) a menos que venha `force:true`. Primeira geração
// (nada endereça a idea ainda) passa livre. Também cobre a proveniência (9.4) estampada no body do container.

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storymap/repo", () => ({
  readBoardConfig: vi.fn(),
  readCards: vi.fn(),
}));
vi.mock("@/lib/storymap/write", () => ({ updateCardOnDisk: vi.fn() }));
vi.mock("@/lib/storymap/draft", () => ({ makeDraftCard: vi.fn() }));
// The action delegates the container creation to startCaptureAction — mock it so the test asserts WHETHER
// (and with what body) it fires, without touching the filesystem/autorun.
vi.mock("./actions", () => ({
  startCaptureAction: vi.fn(async () => ({ ok: true, data: { card: { id: "story-container" } } })),
  createCardAction: vi.fn(async () => ({ ok: true, data: { card: {} } })),
}));

import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { startCaptureAction } from "./actions";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { ideaFingerprint } from "@/lib/storymap/idea";
import { appendToIdeaAction, generateTasksForIdeaAction } from "./idea-actions";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const board: BoardConfig = {
  id: "test-board",
  name: "Test",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "desenvolver", name: "Desenvolver" },
    { id: "concluida", name: "Concluída", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

function card(over: Partial<Card> & { id: string; type: Card["type"] }): Card {
  return {
    title: over.title ?? over.id,
    storyType: over.type === "story" ? "user" : null,
    status: null,
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    rice: { reach: null, impact: null, confidence: null, effort: null },
    kano: null,
    funnelStage: null,
    findings: [],
    created: null,
    updated: null,
    order: 0,
    body: "",
    ...over,
  } as Card;
}

const idea = card({
  id: "idea-dor",
  type: "idea",
  title: "Dor central",
  idea: { statement: "Usuário se perde no feed", evidence: null, status: "open" },
});

const mockedReadBoardConfig = vi.mocked(readBoardConfig);
const mockedReadCards = vi.mocked(readCards);
const mockedStartCapture = vi.mocked(startCaptureAction);

beforeEach(() => {
  vi.clearAllMocks();
  mockedReadBoardConfig.mockResolvedValue(board);
  mockedStartCapture.mockResolvedValue({ ok: true, data: { card: { id: "story-container" } as Card } });
});

describe("generateTasksForIdeaAction — WS-9 (9.2) guard", () => {
  it("proceeds normally when NO story addresses the idea yet (first generation)", async () => {
    mockedReadCards.mockResolvedValue([idea]);
    const res = await generateTasksForIdeaAction({ boardId: "test-board", cardId: "idea-dor" });
    expect(res.ok).toBe(true);
    expect(mockedStartCapture).toHaveBeenCalledOnce();
  });

  it("REFUSES (needsConfirm) when a NON-TERMINAL story already addresses the idea", async () => {
    const activeStory = card({
      id: "story-sol",
      type: "story",
      title: "A solução",
      status: "desenvolver", // non-terminal
      links: [{ rel: "addresses", to: "idea-dor" }],
    });
    mockedReadCards.mockResolvedValue([idea, activeStory]);
    const res = await generateTasksForIdeaAction({ boardId: "test-board", cardId: "idea-dor" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected block");
    expect(res.needsConfirm).toBe(true);
    expect(res.addressedBy).toEqual([{ id: "story-sol", title: "A solução" }]);
    expect(res.error).toMatch(/duplica a trilha de entrega/i);
    // and it did NOT create the container.
    expect(mockedStartCapture).not.toHaveBeenCalled();
  });

  it("does NOT count a TERMINAL story as an active blocker (concluída → generation proceeds)", async () => {
    const doneStory = card({
      id: "story-old",
      type: "story",
      status: "concluida", // terminal
      links: [{ rel: "addresses", to: "idea-dor" }],
    });
    mockedReadCards.mockResolvedValue([idea, doneStory]);
    const res = await generateTasksForIdeaAction({ boardId: "test-board", cardId: "idea-dor" });
    expect(res.ok).toBe(true);
    expect(mockedStartCapture).toHaveBeenCalledOnce();
  });

  it("force:true bypasses the guard even with an active addressing story", async () => {
    const activeStory = card({
      id: "story-sol",
      type: "story",
      status: "desenvolver",
      links: [{ rel: "addresses", to: "idea-dor" }],
    });
    mockedReadCards.mockResolvedValue([idea, activeStory]);
    const res = await generateTasksForIdeaAction({ boardId: "test-board", cardId: "idea-dor", force: true });
    expect(res.ok).toBe(true);
    expect(mockedStartCapture).toHaveBeenCalledOnce();
  });

  it("stamps visible PROVENANCE (9.4) on the container body — actor + via bancada + statement", async () => {
    mockedReadCards.mockResolvedValue([idea]);
    await generateTasksForIdeaAction({ boardId: "test-board", cardId: "idea-dor", actor: "maria" });
    const arg = mockedStartCapture.mock.calls[0][0] as { text: string; scopeIdeaId?: string };
    expect(arg.text).toMatch(/Origem: criado por maria via bancada de Ideias em \d{4}-\d{2}-\d{2}/);
    expect(arg.text).toMatch(/Usuário se perde no feed/);
    expect(arg.scopeIdeaId).toBe("idea-dor");
  });

  it("defaults the provenance actor to 'operador' when none is given", async () => {
    mockedReadCards.mockResolvedValue([idea]);
    await generateTasksForIdeaAction({ boardId: "test-board", cardId: "idea-dor" });
    const arg = mockedStartCapture.mock.calls[0][0] as { text: string };
    expect(arg.text).toMatch(/criado por operador via bancada/);
  });
});

// ── A escrita do EXPLORADOR (classe de risco `idea-write`) ────────────────────────────────────────────
//
// O que estes testes travam NÃO é a funcionalidade — é a CONTENÇÃO. Esta é a única escrita que um token de
// LEITURA monta; se ela puder apagar o que o humano escreveu, ou tocar um card do pipeline, a decisão de
// montá-la no `ro` deixa de se sustentar. A contenção tem de ser estrutural, não um pedido à persona.
describe("appendToIdeaAction — o agente SOMA, nunca apaga", () => {
  const idea = (over: Partial<Card> = {}): Card =>
    card({
      id: "idea-selo",
      type: "idea",
      body: "nota do humano\n",
      idea: { statement: "o selo perde o significado", evidence: "3 relatos", status: "exploring", keyAssumption: "a premissa do humano", candidateSolutions: ["limitar a 3"] },
      ...over,
    } as Partial<Card> & { id: string; type: Card["type"] });

  /** Roda o mutator que a action passa ao updateCardOnDisk e devolve o card resultante. */
  async function run(input: Parameters<typeof appendToIdeaAction>[0], fresh: Card): Promise<Card | null> {
    let out: Card | null = null;
    vi.mocked(updateCardOnDisk).mockImplementation((...args: unknown[]) => {
      // O reset do mock dispara uma chamada SEM argumentos (vitest); ignore-a, senão ela mascara o teste.
      const fn = args[2] as ((c: Card) => Card | null) | undefined;
      if (typeof fn !== "function") return Promise.resolve(null);
      out = fn(fresh);
      return Promise.resolve(out);
    });
    await appendToIdeaAction(input);
    return out;
  }

  beforeEach(() => vi.mocked(updateCardOnDisk).mockReset());

  it("RECUSA um card que não é ideia (o pipeline está fora do alcance desta tool)", async () => {
    const story = card({ id: "story-1", type: "story" });
    expect(await run({ boardId: "b", cardId: "story-1", note: "oi" }, story)).toBeNull();
  });

  it("campo vazio NÃO limpa o que já estava escrito", async () => {
    const out = await run({ boardId: "b", cardId: "idea-selo", statement: "   ", evidence: "" }, idea());
    expect(out?.idea?.statement).toBe("o selo perde o significado");
    expect(out?.idea?.evidence).toBe("3 relatos");
    expect(out?.idea?.keyAssumption).toBe("a premissa do humano");
  });

  it("a nota é ACRESCENTADA ao corpo, assinada — o texto do humano continua lá", async () => {
    const out = await run({ boardId: "b", cardId: "idea-selo", note: "apurei em foo.ts:12 que o selo é sempre true" }, idea());
    expect(out?.body).toContain("nota do humano");
    expect(out?.body).toContain("apurei em foo.ts:12");
    expect(out?.body).toMatch(/> _explorador · \d{4}-\d{2}-\d{2}_/);
    expect(out?.body?.indexOf("nota do humano")).toBeLessThan(out!.body!.indexOf("apurei em"));
  });

  it("caminhos possíveis são UNIDOS (com dedup), não trocados", async () => {
    const out = await run({ boardId: "b", cardId: "idea-selo", candidateSolutions: ["limitar a 3", "ordenar por relevância"] }, idea());
    expect(out?.idea?.candidateSolutions).toEqual(["limitar a 3", "ordenar por relevância"]);
  });

  it("não alcança status, pai, links nem o estado da exploração", async () => {
    const before = idea({ status: null, parent: "step-x" });
    const out = await run(
      { boardId: "b", cardId: "idea-selo", note: "n", statement: "novo enunciado" } as Parameters<typeof appendToIdeaAction>[0],
      before,
    );
    expect(out?.status).toBe(before.status);
    expect(out?.parent).toBe(before.parent);
    expect(out?.idea?.status).toBe("exploring"); // o estado da exploração é decisão do humano
  });
});

// A impressão digital que sustenta o anti-clobber do bloco `idea` (updateCardAction expectedIdea). Ela tem de
// ser ESTÁVEL sob reordenação de chaves — a persistência esparsa faz `delete` + re-atribuição o tempo todo, e
// `JSON.stringify` cru depende da ordem de inserção (a mesma armadilha que quebrou o no-op ≡ no-write do doc).
describe("ideaFingerprint — a base do anti-clobber", () => {
  const base = { statement: "s", evidence: "e", status: "open" as const, keyAssumption: "k", candidateSolutions: ["a"] };

  it("é estável sob reordenação de chaves", () => {
    const reordenado = { candidateSolutions: ["a"], keyAssumption: "k", status: "open" as const, evidence: "e", statement: "s" };
    expect(ideaFingerprint(reordenado)).toBe(ideaFingerprint(base));
  });

  it("MUDA quando o agente escreve num campo — é isso que o save do humano tem de detectar", () => {
    expect(ideaFingerprint({ ...base, evidence: "o que o explorador apurou" })).not.toBe(ideaFingerprint(base));
  });

  it("NÃO muda com o estado da exploração (quem o move é o humano, por outra superfície)", () => {
    expect(ideaFingerprint({ ...base, status: "exploring" })).toBe(ideaFingerprint(base));
  });
});
