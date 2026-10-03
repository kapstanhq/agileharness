// parkBoardConductorsNow (conductor-pause-deps.ts) com o recorte por card — a assinatura coerente com a purga da fila do
// engine. O ESCOPO DE TIPOS (board-pace.ts) não usa o recorte (estreitar deixa os condutores vivos terminarem), mas a pausa
// «parar agora» e um modo «parar» futuro do escopo pedem a MESMA mão: estacionar só os condutores dos cards apontados.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPark, mockSessions } = vi.hoisted(() => ({
  mockPark: vi.fn(async (_deps: { sessions: () => Promise<Array<{ cardId?: string }>> }, _board: string) => [] as Array<{ cardId: string; tmuxSession: string }>),
  mockSessions: { value: [] as Array<Record<string, unknown>> },
}));

vi.mock("@/lib/terminal/attention-watch", () => ({ currentTerminalAttention: () => [] }));
vi.mock("@/lib/terminal/tmux", () => ({ capturePane: async () => "" }));
vi.mock("@/lib/vps/tmux", () => ({ deliverToSession: async () => ({ ok: true }), pressOptionKey: async () => ({ ok: true }), sessionRunsClaude: async () => true }));
vi.mock("./conductor-quiet", () => ({ conductorQuiet: async () => ({ asking: false }) }));
vi.mock("./conductor-pause", () => ({ parkBoardConductors: mockPark, parkWaitingConductors: async () => ({}), wakeConductor: async () => "none" }));
vi.mock("./stall-watch-deps", () => ({ QUIET_IO: {} }));
vi.mock("./permission-prompt-heal", () => ({ healPermissionPrompts: async () => ({}) }));
vi.mock("./permission-prompt", () => ({ lastPendingToolUse: () => null }));
vi.mock("./fleet-deps", () => ({
  defaultConductorDeps: () => ({
    sessions: async () => mockSessions.value,
    liveTmux: async () => new Set<string>(),
    heartbeatAlive: () => true,
    treeGone: () => false,
    readCard: async () => null,
    readBoardConfig: async () => null,
    queue: { load: async () => [] },
  }),
  pumpConductorsNow: async () => ({}),
}));

import { parkBoardConductorsNow } from "./conductor-pause-deps";

const session = (sessionId: string, board: string, cardId: string) => ({ sessionId, board, cardId, driver: "conductor", tmuxSession: `agent-${cardId}` });

describe("parkBoardConductorsNow — o recorte por card", () => {
  beforeEach(() => {
    mockPark.mockClear();
    mockSessions.value = [session("s1", "acme", "story-a"), session("s2", "acme", "story-b"), session("s3", "outro", "story-c")];
  });

  it("sem recorte: o passe enxerga todas as sessões (o comportamento da pausa «parar agora»)", async () => {
    await parkBoardConductorsNow("acme");
    const deps = mockPark.mock.calls[0][0];
    expect((await deps.sessions()).map((s) => s.cardId)).toEqual(["story-a", "story-b", "story-c"]);
  });

  it("com recorte: o passe enxerga SÓ as sessões dos cards apontados", async () => {
    await parkBoardConductorsNow("acme", (cardId) => cardId === "story-b");
    const deps = mockPark.mock.calls[0][0];
    expect((await deps.sessions()).map((s) => s.cardId)).toEqual(["story-b"]);
  });

  it("recorte assíncrono funciona; um predicado que rejeita deixa a sessão de fora (na dúvida, ninguém é estacionado)", async () => {
    await parkBoardConductorsNow("acme", async (cardId) => {
      if (cardId === "story-a") throw new Error("falhou");
      return true;
    });
    const deps = mockPark.mock.calls[0][0];
    expect((await deps.sessions()).map((s) => s.cardId)).toEqual(["story-b"]);
  });

  it("recorte vazio: nenhuma sessão é pedida a estacionar", async () => {
    await parkBoardConductorsNow("acme", () => false);
    const deps = mockPark.mock.calls[0][0];
    expect(await deps.sessions()).toEqual([]);
  });
});
