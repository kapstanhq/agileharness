// A VERIFICAÇÃO DE ENTRADA nas actions de criação: um AGENTE (ator MCP) que pede card no board errado, fora do padrão
// ou duplicado NÃO cria nada e recebe o porquê; o próprio serviço (chamada interna) nunca é barrado — o card entra, e
// marcado para revisão quando o board é outro; o lote inteiro cai junto. Disco, boards e modelo falsos; fixtures
// inventadas (uma oficina e o galpão comum).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/repo")>()),
  readBoardConfig: vi.fn(),
  readCards: vi.fn(),
}));
vi.mock("@/lib/storymap/write", () => ({
  writeCard: vi.fn(),
  deleteCardFile: vi.fn(),
  updateCardOnDisk: vi.fn(),
  writeBoardConfig: vi.fn(),
  withCreateLock: <T>(_b: string, fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/storymap/runner/engine", () => ({ getRunnerEngine: vi.fn() }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: vi.fn() }));
const organize = { boards: new Set<string>() };
vi.mock("@/lib/storymap/organize-only", () => ({ organizeOnlyNow: (b: string) => organize.boards.has(b) }));

import { readBoardConfig, readCards, coerceCard } from "@/lib/storymap/repo";
import { writeBoardConfig, writeCard } from "@/lib/storymap/write";
import { commitProposalAction, createCardAction, updateBoardConfigAction } from "@/app/actions";
import { currentMcpActor, runAsService, runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { setIntakeDepsForTesting, type IntakeDeps } from "@/lib/storymap/runner/card-intake-deps";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { ProposedItem } from "@/lib/storymap/smart-capture/types";

const config: BoardConfig = {
  id: "oficina",
  name: "Oficina",
  package: "apps/oficina",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "concluida", name: "No ar", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
} as BoardConfig;

const step = coerceCard("step-ex9721", { type: "step", title: "Levar a bicicleta" }, "") as Card;
const userStory = coerceCard("story-ex9722", { type: "story", storyType: "user", title: "Pedir a revisão da bicicleta", parent: "step-ex9721", status: "triage" }, "") as Card;

const decisions: unknown[] = [];
const deps: IntakeDeps = {
  settings: () => ({ enabled: true, similarity: 0.75, llm: { enabled: true, maxUsdPerCall: 0.05, maxCallsPerHour: 5, maxUsdPerHour: 1 } }),
  boards: async () => [
    { id: "oficina", name: "Oficina", package: "apps/oficina" },
    { id: "galpao", name: "Galpão", package: "libs/comum", ownsPaths: ["ops/publicar/"] },
  ],
  readConfig: async () => config,
  readCards: async () => [step, userStory],
  readScope: async () => null,
  ask: async () => '{"board":"galpao","confidence":0.95,"why":"é da publicação"}',
  admission: () => null,
  cacheGet: async () => null,
  cacheSet: async () => {},
  hourUsage: async () => ({ calls: 0, usd: 0 }),
  book: async () => {},
  record: async (e) => void decisions.push(e),
  bump: async () => {},
  now: () => Date.UTC(2026, 6, 1),
};

const item = (over: Partial<ProposedItem> = {}): ProposedItem => ({
  tempId: "i1",
  type: "story",
  title: "Mostrar o prazo da revisão no pedido",
  storyType: "technical",
  serves: "story-ex9722",
  rationale: "o dono pediu",
  ...over,
});
const asAgent = <T,>(fn: () => Promise<T>) => runWithMcpActor({ level: "write" }, fn);

const prevEnv = process.env.AGILEHARNESS_INTAKE;
beforeEach(() => {
  process.env.AGILEHARNESS_INTAKE = "1";
  setIntakeDepsForTesting(deps);
  decisions.length = 0;
  vi.mocked(readBoardConfig).mockResolvedValue(config);
  vi.mocked(readCards).mockResolvedValue([step, userStory]);
  vi.mocked(writeCard).mockReset();
  organize.boards.clear();
});
afterEach(() => {
  setIntakeDepsForTesting(null);
  process.env.AGILEHARNESS_INTAKE = prevEnv;
});

describe("commitProposalAction (create_card / usm_capture apply) com um AGENTE", () => {
  it("board errado pelos arquivos ⇒ nada é criado e a recusa diz o board certo", async () => {
    const r = await asAgent(() => commitProposalAction({ boardId: "oficina", via: "mcp", items: [item({ files: ["ops/publicar/etapa.mjs"] })] }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/board certo: galpao/);
    expect(writeCard).not.toHaveBeenCalled();
    expect(decisions).toHaveLength(1);
  });

  it("fora do padrão ⇒ recusa dizendo o que corrigir", async () => {
    const r = await asAgent(() => commitProposalAction({ boardId: "oficina", via: "mcp", items: [item({ title: "Ver story-ex9790" })] }));
    expect((r as { error: string }).error).toMatch(/id de um card/);
    expect(writeCard).not.toHaveBeenCalled();
  });

  it("duplicado de um card aberto ⇒ recusa apontando o existente", async () => {
    const r = await asAgent(() => commitProposalAction({ boardId: "oficina", via: "mcp", items: [item({ title: "Pedir a revisão da bicicleta" })] }));
    expect((r as { error: string }).error).toMatch(/card existente: story-ex9722/);
  });

  it("um item ruim derruba o LOTE inteiro (nada pela metade)", async () => {
    const r = await asAgent(() =>
      commitProposalAction({ boardId: "oficina", via: "capture", items: [item(), item({ tempId: "i2", title: "Publicar com prova", files: ["ops/publicar/x.mjs"] })] }),
    );
    expect(r.ok).toBe(false);
    expect(writeCard).not.toHaveBeenCalled();
  });

  it("card bom ⇒ criado normalmente", async () => {
    const r = await asAgent(() => commitProposalAction({ boardId: "oficina", via: "mcp", items: [item({ files: ["apps/oficina/pedido/prazo.ts"] })] }));
    expect(r.ok).toBe(true);
    expect(writeCard).toHaveBeenCalledTimes(1);
  });

  it("uma revisão humana nesta tela (humanReviewed) não passa pela verificação", async () => {
    const r = await asAgent(() =>
      commitProposalAction({ boardId: "oficina", via: "capture", humanReviewed: true, items: [item({ files: ["ops/publicar/x.mjs"] })] }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("createCardAction", () => {
  const card = (over: Partial<Card> = {}): Card =>
    ({ ...coerceCard("story-ex9723", { type: "story", storyType: "technical", title: "Mostrar o prazo da revisão no pedido", status: "triage", serves: "story-ex9722" }, ""), ...over }) as Card;

  it("um AGENTE pedindo no board errado ⇒ recusado, nada escrito", async () => {
    const r = await asAgent(() => createCardAction({ boardId: "oficina", card: card(), files: ["ops/publicar/x.mjs"] }));
    expect(r.ok).toBe(false);
    expect(writeCard).not.toHaveBeenCalled();
  });

  it("o próprio SERVIÇO (chamada interna) nunca é barrado: o card entra marcado para revisão", async () => {
    const r = await createCardAction({ boardId: "oficina", card: card(), files: ["ops/publicar/x.mjs"], via: "triage" });
    expect(r.ok).toBe(true);
    expect(vi.mocked(writeCard).mock.calls[0][1]).toMatchObject({ needsHumanReview: true });
  });

  it("a dúvida vai ao modelo; com resposta confiante de outro board, o agente é recusado", async () => {
    const r = await asAgent(() => createCardAction({ boardId: "oficina", card: card({ body: "Coisa do Galpão: a etapa de publicar trava." }) }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/galpao/);
  });
});

// O trabalho do SERVIÇO disparado de dentro de um request MCP (um efeito de entrada, o produtor de provas, a auditoria)
// HERDA o ator MCP pelo AsyncLocalStorage — atravessa promessas e callbacks. A criação desse trabalho declara a origem
// (`system: true`) e não é julgada como «agente».
describe("criação do serviço disparada dentro de um request de agente", () => {
  const longTitle = "Conserto: a publicação de «" + "Mostrar o prazo da revisão no pedido com o detalhe de cada etapa da oficina e das peças".padEnd(110, " x") + "» pede uma prova";
  const fix = (): Card =>
    ({ ...coerceCard("story-ex9724", { type: "story", storyType: "technical", title: longTitle, status: "triage", serves: "story-ex9722" }, "") }) as Card;

  it("o ator MCP atravessa uma promessa e um callback (a premissa do conserto)", async () => {
    const seen = await asAgent(() => new Promise<unknown>((resolve) => setTimeout(() => void Promise.resolve().then(() => resolve(currentMcpActor())), 0)));
    expect(seen).toMatchObject({ level: "write" });
  });

  it("sem `system`, o conserto de título longo vindo do efeito seria recusado como se fosse do agente", async () => {
    const r = await asAgent(async () => {
      await Promise.resolve();
      return createCardAction({ boardId: "oficina", card: fix(), via: "triage" });
    });
    expect(r.ok).toBe(false);
  });

  it("com `system: true`, o mesmo conserto ENTRA (aviso, nunca recusa) — mesmo dentro do request do agente", async () => {
    const r = await asAgent(async () => {
      await Promise.resolve();
      return createCardAction({ boardId: "oficina", card: fix(), via: "triage", system: true });
    });
    expect(r.ok).toBe(true);
    expect(writeCard).toHaveBeenCalledTimes(1);
  });

  it("board só de organização recusa a criação do serviço qualquer que seja o chamador (agente, operador ou interno)", async () => {
    organize.boards.add("oficina");
    const viaAgent = await asAgent(() => createCardAction({ boardId: "oficina", card: fix(), via: "triage", system: true }));
    const viaCommit = await asAgent(() => commitProposalAction({ boardId: "oficina", via: "triage", system: true, items: [item()] }));
    expect(viaAgent.ok).toBe(false);
    expect(viaCommit.ok).toBe(false);
    expect(writeCard).not.toHaveBeenCalled();
    // e um AGENTE organizando à mão (sem `system`) segue podendo criar — é organização
    const manual = await asAgent(() => commitProposalAction({ boardId: "oficina", via: "mcp", items: [item({ files: ["apps/oficina/pedido/prazo.ts"] })] }));
    expect(manual.ok).toBe(true);
  });

  it("runAsService zera o ator MCP para o trabalho do serviço", async () => {
    const inside = await asAgent(async () => runAsService(() => currentMcpActor()));
    expect(inside).toBeUndefined();
  });
});

// `organizeOnly` é chave de GOVERNANÇA: um agente por MCP salva a configuração do board, mas não liga nem desliga o modo.
describe("updateBoardConfigAction e o modo só de organização", () => {
  it("um AGENTE que tenta ligar ou desligar o modo é recusado; nada é gravado", async () => {
    vi.mocked(writeBoardConfig).mockReset();
    const on = await asAgent(() => updateBoardConfigAction({ boardId: "oficina", config: { ...config, organizeOnly: true } }));
    expect(on.ok).toBe(false);
    vi.mocked(readBoardConfig).mockResolvedValue({ ...config, organizeOnly: true });
    const off = await asAgent(() => updateBoardConfigAction({ boardId: "oficina", config: { ...config } }));
    expect(off.ok).toBe(false);
    expect(writeBoardConfig).not.toHaveBeenCalled();
  });

  it("um AGENTE que salva o resto sem mexer no modo segue podendo", async () => {
    vi.mocked(writeBoardConfig).mockReset();
    vi.mocked(readBoardConfig).mockResolvedValue({ ...config, organizeOnly: true });
    const r = await asAgent(() => updateBoardConfigAction({ boardId: "oficina", config: { ...config, organizeOnly: true, name: "Oficina 2" } }));
    expect(r.ok).toBe(true);
    expect(writeBoardConfig).toHaveBeenCalledTimes(1);
  });
});
