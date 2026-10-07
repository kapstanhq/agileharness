import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { BoardPaceRow } from "@/lib/storymap/runner/board-pace";

// R6 do escopo de tipos do ritmo: o TIPO é a catraca. Enquanto o board limita o que começa, toda troca de storyType que
// passa por updateCardAction (o ponto único do update_card, do painel do card e das ações do servidor) vai para a trilha
// de auditoria com antes/depois e autor; e um card que JÁ estava classificado como funcionalidade nova só o DONO troca
// para outro tipo. Classificar um card ainda novo (captura/triagem/dúvidas/especificação) segue livre para o agente.
// Os testes dirigem a ação REAL; só o disco, o ritmo e a sessão são trocados.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// «Reportar bug» (C13) dispara a cascata e grava no ledger de transições: aqui só nos interessa o tipo.
vi.mock("@/lib/notifications/server/channels/autorun-eval", async (orig) => ({ ...(await orig<object>()), evaluateAutorunOnEntry: async () => {} }));
vi.mock("@/lib/storymap/runner/transitions", async (orig) => ({ ...(await orig<object>()), appendTransition: async () => {} }));
vi.mock("@/lib/storymap/runner/merge-queue", async (orig) => ({ ...(await orig<object>()), getMergeQueue: () => ({ reconcileCardMergeEntries: async () => {} }) }));
vi.mock("@/lib/auth/action-guard", () => ({ requireSession: async () => {}, resolveActionCaller: async () => ({ kind: "owner" }) }));

let disk: Card;
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    updateCardOnDisk: async (_board: string, _id: string, fn: (prev: Card) => Card) => {
      const next = fn(disk);
      disk = next;
      return next;
    },
  };
});

const config: BoardConfig = {
  id: "oficina",
  name: "Oficina",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "enriquecer", name: "Especificar" },
    { id: "desenvolver", name: "Desenvolver" },
    { id: "concluida", name: "Concluída", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readBoardConfig: async () => config, readCards: async () => [disk], readCard: async () => disk };
});

let row: BoardPaceRow | null = null;
vi.mock("@/lib/storymap/runner/board-pace-store", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/board-pace-store")>();
  return { ...actual, boardPaceRow: () => row };
});

import { reportBugAction, updateCardAction } from "./actions";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { resetAgentActionSink, setAgentActionSink, flushAgentActions, type AgentAction } from "@/lib/storymap/runner/agent-actions";

const FIXES = ["bug", "technical", "chore", "spike"] as const;
const ownerFixes = (): BoardPaceRow => ({ board: "oficina", ownerScope: { types: [...FIXES], by: { kind: "owner" }, at: new Date().toISOString() } });

function card(over: Partial<Card> = {}): Card {
  return {
    id: "story-ex9901",
    type: "story",
    title: "Trocar a corrente da bicicleta",
    storyType: "user",
    status: "desenvolver",
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    findings: [],
    created: null,
    updated: null,
    order: 0,
    body: "",
    ...over,
  } as Card;
}

let lines: AgentAction[];
beforeEach(() => {
  lines = [];
  setAgentActionSink({ append: async (l) => void lines.push(JSON.parse(l) as AgentAction) });
  row = null;
});
afterEach(() => resetAgentActionSink());

const asAgent = <T>(fn: () => T) => runWithMcpActor({ level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" }, fn);
const retype = (storyType: Card["storyType"]) => updateCardAction({ boardId: "oficina", card: { ...disk, storyType } });
const typeLines = () => lines.filter((l) => l.tool === "updateCardAction.storyType");

describe("troca de tipo sob escopo (R6)", () => {
  it("sem escopo nenhum, a troca passa e NÃO deixa linha na trilha (a trilha é só sob escopo)", async () => {
    disk = card();
    const r = await asAgent(() => retype("chore"));
    expect(r.ok).toBe(true);
    await flushAgentActions();
    expect(typeLines()).toEqual([]);
  });

  it("com escopo, um AGENTE não troca o tipo de uma funcionalidade já classificada: recusa com a frase e registra a recusa", async () => {
    row = ownerFixes();
    disk = card();
    const r = await asAgent(() => retype("chore"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/só o dono troca o tipo/);
    expect(disk.storyType).toBe("user"); // nada gravado
    await flushAgentActions();
    expect(typeLines()).toHaveLength(1);
    expect(typeLines()[0]).toMatchObject({ outcome: "refused", board: "oficina", cardId: "story-ex9901", actor: "mcp:orch(AGILEHARNESS_MCP_TOKEN_ORCH)" });
    expect(typeLines()[0].note).toContain("Funcionalidade nova → Manutenção");
  });

  it("com escopo, o DONO troca; fica registrado antes/depois e autor", async () => {
    row = ownerFixes();
    disk = card();
    const r = await retype("technical"); // sem ator MCP = sessão do dono
    expect(r.ok).toBe(true);
    expect(disk.storyType).toBe("technical");
    await flushAgentActions();
    expect(typeLines()).toHaveLength(1);
    expect(typeLines()[0]).toMatchObject({ outcome: "executed", actor: "human:card-type", cardId: "story-ex9901" });
    expect(typeLines()[0].note).toBe("story-ex9901: tipo Funcionalidade nova → Trabalho técnico pelo dono, com o escopo do board limitado");
  });

  it.each(["triage", "enriquecer"])("com escopo, um agente CLASSIFICA um card novo (ainda em %s) e fica registrado", async (status) => {
    row = ownerFixes();
    disk = card({ status });
    const r = await asAgent(() => retype("bug"));
    expect(r.ok).toBe(true);
    expect(disk.storyType).toBe("bug");
    await flushAgentActions();
    expect(typeLines()).toHaveLength(1);
    expect(typeLines()[0]).toMatchObject({ outcome: "executed" });
    expect(typeLines()[0].note).toContain("por um agente (mcp:orch(AGILEHARNESS_MCP_TOKEN_ORCH))");
  });

  it("um agente pode trocar entre tipos de consertos, e para 'user' (não é fuga do escopo) — mas fica registrado", async () => {
    row = ownerFixes();
    disk = card({ storyType: "chore" });
    expect((await asAgent(() => retype("bug"))).ok).toBe(true);
    expect((await asAgent(() => retype("user"))).ok).toBe(true);
    await flushAgentActions();
    expect(typeLines().map((l) => l.outcome)).toEqual(["executed", "executed"]);
  });

  it("card sem storyType é 'user' (o padrão): o agente também é recusado", async () => {
    row = ownerFixes();
    disk = card({ storyType: null });
    const r = await asAgent(() => retype("spike"));
    expect(r.ok).toBe(false);
  });

  it("editar OUTRO campo (título) com escopo não é troca de tipo: nada na trilha", async () => {
    row = ownerFixes();
    disk = card();
    const r = await asAgent(() => updateCardAction({ boardId: "oficina", card: { ...disk, title: "Trocar a corrente e a pedaleira" } }));
    expect(r.ok).toBe(true);
    await flushAgentActions();
    expect(typeLines()).toEqual([]);
  });

  it("escopo vencido já não conta: a troca passa sem trilha", async () => {
    row = { board: "oficina", ownerScope: { types: [...FIXES], by: { kind: "owner" }, at: new Date(Date.now() - 7_200_000).toISOString(), until: new Date(Date.now() - 3_600_000).toISOString() } };
    disk = card();
    expect((await asAgent(() => retype("chore"))).ok).toBe(true);
    await flushAgentActions();
    expect(typeLines()).toEqual([]);
  });
});

// C13 — o tipo e o modo de um card existente só se gravam por duas portas de agente: `update_card` (que REJEITA `mode` como campo do
// pipeline e nem tem `type` no esquema) e «Reportar bug», que RE-TIPA a story como `bug` junto do `mode: fix`. Esta segunda porta
// passa pela mesma catraca: sem ela, «classifico a funcionalidade como erro» seria o atalho do escopo.
describe("«Reportar bug» sob escopo é troca de tipo (R6, C13)", () => {
  const report = (cardId = "story-ex9901") => reportBugAction({ boardId: "oficina", cardId, brief: "quebrou ao salvar", severity: "medium" });
  const bugLines = () => lines.filter((l) => l.tool === "reportBugAction.storyType");

  it("com escopo, um AGENTE não re-tipa uma funcionalidade ainda não entregue como erro: recusa, registra e não grava nada", async () => {
    row = ownerFixes();
    disk = card({ status: "desenvolver" });
    const r = await asAgent(() => report());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/só o dono troca o tipo/);
    expect(disk.storyType).toBe("user");
    expect(disk.mode).toBeUndefined();
    await flushAgentActions();
    expect(bugLines()).toHaveLength(1);
    expect(bugLines()[0]).toMatchObject({ outcome: "refused" });
    expect(bugLines()[0].note).toContain("Funcionalidade nova → Erro");
  });

  it("a funcionalidade ENTREGUE que quebrou (em revisão ou no ar) é conserto: o agente reporta, vira erro e fica registrado", async () => {
    row = ownerFixes();
    disk = card({ status: "concluida" });
    const r = await asAgent(() => report());
    expect(r.ok).toBe(true);
    expect(disk).toMatchObject({ storyType: "bug", mode: "fix" });
    await flushAgentActions();
    expect(bugLines().map((l) => l.outcome)).toEqual(["executed"]);
  });

  it("o DONO reporta bug em qualquer coluna; sob escopo fica registrado, sem escopo não deixa linha", async () => {
    row = ownerFixes();
    disk = card({ status: "desenvolver" });
    expect((await report()).ok).toBe(true);
    await flushAgentActions();
    expect(bugLines().map((l) => l.outcome)).toEqual(["executed"]);
    lines.length = 0;
    row = null;
    disk = card({ status: "desenvolver" });
    expect((await asAgent(() => report())).ok).toBe(true); // sem escopo ninguém é barrado
    await flushAgentActions();
    expect(bugLines()).toEqual([]);
  });

  it("um card que já é erro não é troca de tipo: o agente reporta sem recusa", async () => {
    row = ownerFixes();
    disk = card({ status: "desenvolver", storyType: "bug" });
    expect((await asAgent(() => report())).ok).toBe(true);
  });
});
