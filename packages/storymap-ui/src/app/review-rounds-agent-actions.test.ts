// O PORTÃO ÚNICO do teto de rodadas nas ações de criação (M2): todo caminho de criação de um AGENTE pelo MCP —
// `create_card`, `usm_capture apply` (commitProposalAction) e `report_issue` (createCardAction) — passa pelo mesmo
// portão (runner/review-rounds-agent.ts). Rodada ⇒ o card nasce marcado na mesma escrita; teto ⇒ nada nasce. O
// operador e o próprio serviço não passam por ele (o serviço marca os consertos dele pelo próprio portão). Disco e portão
// falsos; fixtures inventadas (uma oficina de bicicletas).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

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
vi.mock("@/lib/storymap/organize-only", () => ({ organizeOnlyNow: () => false }));
const gate = { calls: [] as Array<{ boardId: string; summary: string }>, next: { kind: "none" } as unknown };
vi.mock("@/lib/storymap/runner/review-rounds-agent", () => ({
  agentRoundsDecision: async (input: { boardId: string; summary: string }) => {
    gate.calls.push({ boardId: input.boardId, summary: input.summary });
    return gate.next;
  },
}));

import { readBoardConfig, readCards, coerceCard } from "@/lib/storymap/repo";
import { writeCard } from "@/lib/storymap/write";
import { commitProposalAction, createCardAction } from "@/app/actions";
import { runAsService, runWithMcpActor } from "@/lib/storymap/mcp/actor";
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

const step = coerceCard("step-ex9801", { type: "step", title: "Levar a bicicleta" }, "") as Card;
const userStory = coerceCard("story-ex9802", { type: "story", storyType: "user", title: "Pedir a revisão da bicicleta", parent: "step-ex9801", status: "triage" }, "") as Card;
const reviewed = coerceCard("story-ex9803", { type: "story", storyType: "technical", title: "Trocar a corrente", serves: "story-ex9802", status: "triage" }, "") as Card;

const STAMP = { labels: ["rodada-de-revisao"], links: [{ rel: "relates-to" as const, to: "story-ex9803" }], reviewChain: { root: "oficina/story-ex9803", round: 2 } };
const asAgent = <T,>(fn: () => Promise<T>) => runWithMcpActor({ level: "write" }, fn);
const item = (over: Partial<ProposedItem> = {}): ProposedItem => ({
  tempId: "i1",
  type: "story",
  title: "Ajustar a tensão da corrente nova",
  storyType: "technical",
  serves: "story-ex9802",
  rationale: "a revisão pediu",
  ...over,
});
const newCard = (over: Partial<Card> = {}): Card =>
  ({ ...coerceCard("story-ex9810", { type: "story", storyType: "bug", title: "A corrente nova salta na terceira marcha", serves: "story-ex9802", status: "triage" }, ""), ...over }) as Card;

beforeEach(() => {
  process.env.AGILEHARNESS_INTAKE = "0";
  gate.calls.length = 0;
  gate.next = { kind: "none" };
  vi.mocked(readBoardConfig).mockResolvedValue(config);
  vi.mocked(readCards).mockResolvedValue([step, userStory, reviewed]);
  vi.mocked(writeCard).mockReset();
});

describe("o portão do teto nas ações de criação (agente pelo MCP)", () => {
  it("captura aplicada (usm_capture): rodada ⇒ as stories nascem com a marca, na mesma escrita", async () => {
    gate.next = { kind: "stamp", stamp: STAMP, origin: { board: "oficina", cardId: "story-ex9803" } };
    const r = await asAgent(() => commitProposalAction({ boardId: "oficina", via: "capture", items: [item()] }));
    expect(r.ok).toBe(true);
    expect(gate.calls).toHaveLength(1);
    const written = vi.mocked(writeCard).mock.calls.map((c) => c[1] as Card);
    expect(written[0]).toMatchObject({ labels: ["rodada-de-revisao"], reviewChain: { root: "oficina/story-ex9803", round: 2 } });
    expect(written[0].links).toEqual(expect.arrayContaining([{ rel: "relates-to", to: "story-ex9803" }]));
  });

  it("captura aplicada no TETO: nada é criado e a nota diz por quê", async () => {
    gate.next = { kind: "held", nota: "A cadeia chegou ao teto; não abra outro card.", origin: { board: "oficina", cardId: "story-ex9803" } };
    const r = await asAgent(() => commitProposalAction({ boardId: "oficina", via: "capture", items: [item()] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/teto/);
    expect(writeCard).not.toHaveBeenCalled();
  });

  it("relato livre (report_issue → createCardAction): rodada ⇒ marcado; teto ou recusa ⇒ nada", async () => {
    gate.next = { kind: "stamp", stamp: STAMP, origin: { board: "oficina", cardId: "story-ex9803" } };
    const ok = await asAgent(() => createCardAction({ boardId: "oficina", card: newCard(), via: "triage" }));
    expect(ok.ok).toBe(true);
    expect(vi.mocked(writeCard).mock.calls[0][1]).toMatchObject({ reviewChain: { root: "oficina/story-ex9803" }, labels: ["rodada-de-revisao"] });

    vi.mocked(writeCard).mockReset();
    gate.next = { kind: "held", nota: "teto: a pergunta foi ao dono", origin: { board: "oficina", cardId: "story-ex9803" } };
    expect((await asAgent(() => createCardAction({ boardId: "oficina", card: newCard(), via: "triage" }))).ok).toBe(false);
    gate.next = { kind: "refuse", error: "continuesFrom fora da cadeia" };
    expect((await asAgent(() => createCardAction({ boardId: "oficina", card: newCard(), via: "triage" }))).ok).toBe(false);
    expect(writeCard).not.toHaveBeenCalled();
  });

  it("o create_card já passou pelo portão (roundsChecked) ⇒ a ação não passa de novo", async () => {
    await asAgent(() => commitProposalAction({ boardId: "oficina", via: "mcp", items: [item()], roundsChecked: true }));
    expect(gate.calls).toHaveLength(0);
  });

  it("o próprio serviço (system) e a chamada interna não passam pelo portão do agente", async () => {
    await asAgent(() => createCardAction({ boardId: "oficina", card: newCard(), via: "triage", system: true }));
    await runAsService(() => commitProposalAction({ boardId: "oficina", via: "capture", items: [item()] }));
    expect(gate.calls).toHaveLength(0);
  });
});

describe("nenhuma tool de criação escreve card por fora das ações (o portão único não tem desvio)", () => {
  it("as tools do MCP não chamam writeCard/createCardOnDisk direto", () => {
    const dir = path.join(__dirname, "..", "lib", "storymap", "mcp");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /\bwriteCard\(|createCardOnDisk\(/.test(readFileSync(path.join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
