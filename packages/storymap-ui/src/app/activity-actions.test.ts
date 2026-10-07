import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A ponte de leitura da ATIVIDADE dos agentes e da CHEGADA ao ar (app/activity-actions.ts). A fusão e as frases moram
// no núcleo puro (lib/storymap/activity-feed.ts, testado lá); aqui se fixa o que é só da action: lê o events.jsonl
// tolerando linha torta e linha de outro board, dá o nome do passo pelo gatilho do board, prende o `limit` entre 1 e 30
// e NUNCA lança depois da sessão (uma falha vira `{ ok: false }`). Fixtures inventadas (livraria de demonstração).

const { mockConfig, mockCards, mockTransitions, mockCopilot, state } = vi.hoisted(() => ({
  mockConfig: vi.fn(),
  mockCards: vi.fn(),
  mockTransitions: vi.fn(),
  mockCopilot: vi.fn(),
  state: { dir: "" },
}));
vi.mock("@/lib/auth/action-guard", () => ({ requireSession: async () => {} }));
vi.mock("@/lib/storymap/repo", () => ({ readBoardConfig: mockConfig, readCards: mockCards }));
vi.mock("@/lib/storymap/runner/transitions", () => ({ readTransitions: mockTransitions }));
vi.mock("@/lib/storymap/copilot/activity", () => ({ readCopilotActivity: mockCopilot }));
vi.mock("@/lib/storymap/paths", async (orig) => ({ ...(await orig<typeof import("@/lib/storymap/paths")>()), runnerStateDir: () => state.dir }));

import { getBoardActivityAction, getLiveArrivalsAction } from "./activity-actions";

const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const CONFIG = {
  id: "demo",
  statuses: [
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
    { id: "revisao", name: "Aprovar entrega" },
    { id: "concluida", name: "No ar", terminal: true },
  ],
};
const CARDS = [
  { id: "story-ex9301", title: "Buscar livro por autor", type: "story" },
  { id: "story-ex9302", title: "Cupom no carrinho", type: "story" },
];
const runLine = (cardId: string, minAgo: number, board = "demo") =>
  JSON.stringify({ type: "settled", board, cardId, trigger: "harness-do", outcome: "error", at: NOW - minAgo * 60_000 });

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "ah-activity-"));
  mockConfig.mockResolvedValue(CONFIG);
  mockCards.mockResolvedValue(CARDS);
  mockTransitions.mockResolvedValue([]);
  mockCopilot.mockResolvedValue([]);
});
afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("getBoardActivityAction", () => {
  it("lê as execuções deste board, pula a linha torta e a de outro board, e nomeia o passo pelo gatilho", async () => {
    writeFileSync(
      path.join(state.dir, "events.jsonl"),
      [runLine("story-ex9301", 5), '{"type":"settled","board":"demo",', runLine("story-ex9302", 3, "outro-board"), ""].join("\n"),
    );
    const r = await getBoardActivityAction("demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((i) => [i.cardId, i.text])).toEqual([["story-ex9301", "Parou com erro em Desenvolver."]]);
  });

  it("sem o events.jsonl, a lista é só o que os outros diários têm — nunca erro", async () => {
    const r = await getBoardActivityAction("demo");
    expect(r).toEqual({ ok: true, data: [] });
  });

  it("o `limit` fica entre 1 e 30 (0, NaN e 99 não quebram nem passam do teto)", async () => {
    writeFileSync(path.join(state.dir, "events.jsonl"), Array.from({ length: 40 }, (_, i) => runLine(i % 2 ? "story-ex9301" : "story-ex9302", i + 1)).join("\n"));
    const len = async (limit: number) => {
      const r = await getBoardActivityAction("demo", limit);
      return r.ok ? r.data.length : -1;
    };
    expect(await len(99)).toBe(30);
    expect(await len(0)).toBe(30); // 0 é «sem número»: cai no teto padrão
    expect(await len(Number.NaN)).toBe(30);
    expect(await len(3)).toBe(3);
    expect(await len(-5)).toBe(1);
  });

  it("uma falha de leitura vira `{ ok: false }` com a frase — a action não lança", async () => {
    mockCards.mockRejectedValue(new Error("disco indisponível"));
    await expect(getBoardActivityAction("demo")).resolves.toEqual({ ok: false, error: "disco indisponível" });
  });
});

describe("getLiveArrivalsAction", () => {
  it("devolve, por card, a última transição para um status TERMINAL do board", async () => {
    mockTransitions.mockResolvedValue([
      { v: 1, board: "demo", cardId: "story-ex9301", from: "revisao", to: "concluida", actor: "merge", at: "2026-03-09T10:00:00.000Z" },
      { v: 1, board: "demo", cardId: "story-ex9302", from: "desenvolver", to: "revisao", actor: "cascade", at: "2026-03-09T11:00:00.000Z" },
    ]);
    const r = await getLiveArrivalsAction("demo");
    expect(r).toEqual({ ok: true, data: { "story-ex9301": Date.parse("2026-03-09T10:00:00.000Z") } });
  });

  it("uma falha de leitura vira `{ ok: false }`", async () => {
    mockConfig.mockRejectedValue(new Error("board ilegível"));
    await expect(getLiveArrivalsAction("demo")).resolves.toEqual({ ok: false, error: "board ilegível" });
  });
});
