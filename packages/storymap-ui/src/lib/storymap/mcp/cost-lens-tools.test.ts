// As duas PORTAS MCP que conhecem o alvo — `record_cost_projection` (a moeda) e `add_finding` (as lentes de revisão).
// Ambas leem `storymap/settings.yaml → target` a cada chamada e decidem, ANTES de tocar o card, o que o alvo aceita.
// Fixtures INVENTADAS (oficina de bicicletas, livraria): nada aqui vem de um alvo real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

const recordCostImpactAction = vi.fn();
const addFindingAction = vi.fn();
vi.mock("@/app/actions", () => ({
  recordCostImpactAction: (...a: unknown[]) => recordCostImpactAction(...a),
  addFindingAction: (...a: unknown[]) => addFindingAction(...a),
}));

let target: unknown;
vi.mock("@/lib/storymap/runner/config", async (orig) => ({
  ...(await orig<typeof import("../runner/config")>()),
  loadRunnerConfig: () => ({ target, autorun: { enabled: true } }),
}));

let boardConfig: unknown;
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("../repo")>()),
  readBoardConfig: async () => {
    if (!boardConfig) throw new Error("board inexistente");
    return boardConfig;
  },
}));

import matter from "gray-matter";
import { registerStorymapTools } from "./tools";
import { addOrRefreshFinding } from "../card-evidence";
import { applyCostImpact, costImpactVerdict } from "../cost-impact";
import { coerceAutonomy, coerceCard } from "../repo";
import { reviewLensesOf, coerceTargetProfile } from "../target-profile";
import { serializeCard } from "../write";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

function capture(): { handlers: Map<string, ToolHandler>; metas: Map<string, { inputSchema: z.ZodRawShape; description: string }> } {
  const handlers = new Map<string, ToolHandler>();
  const metas = new Map<string, { inputSchema: z.ZodRawShape; description: string }>();
  const server = {
    registerTool: (name: string, meta: { inputSchema: z.ZodRawShape; description: string }, handler: ToolHandler) => {
      handlers.set(name, handler);
      metas.set(name, meta);
    },
  } as unknown as McpServer;
  registerStorymapTools(server);
  return { handlers, metas };
}
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

const verdict = (over: Record<string, unknown> = {}) => ({ owner: false, reason: "projeta dentro do teto", ...over });

beforeEach(() => {
  recordCostImpactAction.mockReset();
  addFindingAction.mockReset();
  target = undefined;
  boardConfig = { id: "oficina", autonomy: { mode: "ultra" } };
});

describe("record_cost_projection — a moeda é do board/alvo, nunca do agente", () => {
  const call = { board: "oficina", cardId: "story-ex9978", scope: "infra", assumptions: "mais uma instância mínima para a vitrine" };

  it("o schema aceita os nomes neutros e os antigos (DEPRECATED), todos opcionais; a descrição não fala em R$", () => {
    const { metas } = capture();
    const meta = metas.get("record_cost_projection")!;
    expect(Object.keys(meta.inputSchema)).toEqual(
      expect.arrayContaining(["monthlyAmount", "baselineMonthlyAmount", "monthlyBRL", "baselineMonthlyBRL"]),
    );
    for (const k of ["monthlyAmount", "baselineMonthlyAmount", "monthlyBRL", "baselineMonthlyBRL"]) {
      expect((meta.inputSchema[k] as z.ZodType).safeParse(undefined).success, k).toBe(true);
    }
    expect(meta.description).toContain("target.currency");
    expect(meta.description).toContain("DEPRECATED");
    expect(meta.description).not.toMatch(/R\$/);
    for (const k of ["monthlyAmount", "baselineMonthlyAmount"]) expect((meta.inputSchema[k] as { description?: string }).description ?? "").not.toMatch(/R\$/);
  });

  it("SEM moeda declarada em lugar nenhum: recusa acionável e NÃO toca o card", async () => {
    const out = await capture().handlers.get("record_cost_projection")!({ ...call, monthlyAmount: 20 });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("target.currency");
    expect(text(out)).toContain("autonomy.budget.currency");
    expect(recordCostImpactAction).not.toHaveBeenCalled();
  });

  it("nenhum dos dois números: recusa pedindo monthlyAmount", async () => {
    target = coerceTargetProfile({ currency: { code: "USD", locale: "en-US" } });
    const out = await capture().handlers.get("record_cost_projection")!(call);
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/informe monthlyAmount/);
  });

  it("COM declaração (livraria, USD): monthlyAmount vai à ação na moeda do alvo; a resposta mantém {ok, decider, reason} e ganha currency", async () => {
    target = coerceTargetProfile({ currency: { code: "USD", locale: "en-US" } });
    recordCostImpactAction.mockResolvedValue({ ok: true, data: { verdict: verdict() } });
    const out = await capture().handlers.get("record_cost_projection")!({ ...call, monthlyAmount: 20, baselineMonthlyAmount: 40, by: "harness-conductor" });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(text(out))).toEqual({ ok: true, decider: "system", reason: "projeta dentro do teto", currency: "USD" });
    expect(recordCostImpactAction).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: "oficina",
        cardId: "story-ex9978",
        by: "harness-conductor",
        impact: expect.objectContaining({ monthlyAmount: 20, baselineMonthlyAmount: 40, currency: { code: "USD", locale: "en-US" } }),
      }),
    );
  });

  it("a chamada ANTIGA do condutor (só monthlyBRL) num alvo BRL: ok, mesma resposta, mesma entrada que a neutra", async () => {
    target = coerceTargetProfile({ currency: { code: "BRL", locale: "pt-BR" } });
    boardConfig = { id: "oficina", autonomy: { mode: "ultra", budget: { cashMonthlyBRL: 1500, infraMonthlyBRL: 90 } } };
    recordCostImpactAction.mockResolvedValue({ ok: true, data: { verdict: verdict({ owner: true, reason: "acima do teto" }) } });
    const handler = capture().handlers.get("record_cost_projection")!;
    const old = await handler({ ...call, monthlyBRL: 20, baselineMonthlyBRL: 70 });
    expect(JSON.parse(text(old))).toEqual({ ok: true, decider: "owner", reason: "acima do teto", currency: "BRL" });
    const neu = await handler({ ...call, monthlyAmount: 20, baselineMonthlyAmount: 70 });
    expect(JSON.parse(text(neu))).toEqual(JSON.parse(text(old)));
    expect(recordCostImpactAction.mock.calls[0][0]).toEqual(recordCostImpactAction.mock.calls[1][0]);
  });

  it("as duas grafias iguais: ok; diferentes: erro; monthlyBRL num alvo USD: recusa citando monthlyAmount", async () => {
    target = coerceTargetProfile({ currency: { code: "BRL" } });
    recordCostImpactAction.mockResolvedValue({ ok: true, data: { verdict: verdict() } });
    const handler = capture().handlers.get("record_cost_projection")!;
    expect((await handler({ ...call, monthlyAmount: 20, monthlyBRL: 20 })).isError).toBeFalsy();
    expect((await handler({ ...call, monthlyAmount: 20, monthlyBRL: 21 })).isError).toBe(true);
    target = coerceTargetProfile({ currency: { code: "USD" } });
    const refused = await handler({ ...call, monthlyBRL: 20 });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/USD.*monthlyAmount/);
  });

  it("a recusa da ação volta como erro; board inexistente não chega à ação", async () => {
    target = coerceTargetProfile({ currency: { code: "BRL" } });
    recordCostImpactAction.mockResolvedValue({ ok: false, error: "card não encontrado" });
    const handler = capture().handlers.get("record_cost_projection")!;
    expect((await handler({ ...call, monthlyAmount: 1 })).isError).toBe(true);
    boardConfig = undefined;
    recordCostImpactAction.mockClear();
    expect((await handler({ ...call, monthlyAmount: 1 })).isError).toBe(true);
    expect(recordCostImpactAction).not.toHaveBeenCalled();
  });
});

describe("add_finding — as lentes aceitas são as embutidas + as que o ALVO declarou", () => {
  const call = { board: "oficina", cardId: "story-ex9979", severity: "high", title: "freio sem teste de carga" };
  const lensesPassed = () => (addFindingAction.mock.calls.at(-1)![0] as { finding: { lenses: ReadonlySet<string> } }).finding.lenses;

  it("o schema aceita um slug livre (a pertinência é checada com o alvo na mão) e a descrição manda ver o vocabulário do alvo", () => {
    const meta = capture().metas.get("add_finding")!;
    expect((meta.inputSchema.lens as z.ZodType).safeParse("freios").success).toBe(true);
    expect((meta.inputSchema.lens as z.ZodType).safeParse(undefined).success).toBe(true);
    expect(meta.description).toContain("target.reviewLenses");
    expect((meta.inputSchema.lens as { description?: string }).description).toContain("target.reviewLenses");
    expect((meta.inputSchema.lens as { description?: string }).description).not.toMatch(/ledger|kiosk/);
  });

  it("SEM declaração: a ação recebe só as embutidas — e a regra pura recusa 'freios' listando-as e dizendo onde declarar", async () => {
    addFindingAction.mockResolvedValue({ ok: true, data: { id: "general-1", created: true, changed: true } });
    await capture().handlers.get("add_finding")!({ ...call, lens: "freios" });
    const lenses = lensesPassed();
    expect([...lenses].sort()).toEqual(["design", "general", "perf", "security", "testing"]);
    const r = addOrRefreshFinding([], { severity: "high", title: "x", lens: "freios", lenses });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("security");
      expect(r.error).toContain("target.reviewLenses.freios");
    }
  });

  it("COM declaração: o conjunto soma as lentes do alvo e a regra pura aceita 'freios' (id gerado freios-1)", async () => {
    target = coerceTargetProfile({ reviewLenses: { freios: { name: "Freios", description: "pinças, cabos e pastilhas" } } });
    addFindingAction.mockResolvedValue({ ok: true, data: { id: "freios-1", created: true, changed: true } });
    const out = await capture().handlers.get("add_finding")!({ ...call, lens: "freios" });
    expect(out.isError).toBeFalsy();
    const lenses = lensesPassed();
    expect(lenses.has("freios")).toBe(true);
    expect(lenses.has("security")).toBe(true);
    const r = addOrRefreshFinding([], { severity: "high", title: "x", lens: "freios", lenses });
    expect(r.ok && r.id).toBe("freios-1");
  });

  it("a recusa da ação (lente não declarada) volta como erro da tool", async () => {
    addFindingAction.mockResolvedValue({ ok: false, error: 'lente "freios" não declarada' });
    const out = await capture().handlers.get("add_finding")!({ ...call, lens: "freios" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("não declarada");
  });
});

// ══ UM ALVO QUE DECLARA MOEDA E LENTES PRÓPRIAS ══════════════════════════════════════════════════════════════════════
// Cenário inventado: uma cooperativa de reparos que cobra em francos suíços e revisa com UMA lente de domínio (sem agente
// próprio) e um único revisor trocado. Prova que as duas portas leem a declaração do alvo de ponta a ponta: a razão sai na
// moeda declarada, o disco grava a grafia NEUTRA, a chamada com o nome antigo (*BRL) é recusada e as lentes são as
// embutidas + a de domínio.
describe("um alvo que declara moeda e lentes próprias", () => {
  const declared = {
    currency: { code: "CHF", locale: "de-CH" },
    reviewLenses: {
      aros: { name: "Aros e raios", description: "tensão dos raios, empeno do aro" },
      testing: { agent: "conferente-de-bancada" },
    },
  };
  const budgetRaw = { mode: "ultra", budget: { infraMonthly: 240, cashMonthly: 900 } };

  it("record_cost_projection: razão na moeda do alvo e o disco na grafia neutra (monthlyAmount + currency)", async () => {
    target = coerceTargetProfile(declared);
    const autonomy = coerceAutonomy(budgetRaw);
    boardConfig = { id: "oficina", autonomy };
    let saved = coerceCard("story-ex9981", { type: "story", storyType: "technical", title: "Balcão de retirada" }, "");
    recordCostImpactAction.mockImplementation(async ({ impact, by }: { impact: Parameters<typeof costImpactVerdict>[0]; by: string }) => {
      const v = costImpactVerdict(impact, { autonomy });
      saved = applyCostImpact(saved, impact, v, { by, at: "2026-11-14" });
      return { ok: true, data: { card: saved, verdict: v } };
    });
    const handler = capture().handlers.get("record_cost_projection")!;
    const out = await handler({ board: "oficina", cardId: "story-ex9981", monthlyAmount: 35, baselineMonthlyAmount: 130, scope: "infra", assumptions: "uma fila de mensagens gerenciada", by: "agente-de-teste" });
    const body = JSON.parse(text(out));
    expect(body).toMatchObject({ ok: true, decider: "system", currency: "CHF" });
    expect(body.reason).toContain("CHF 165");
    expect(body.reason).not.toMatch(/R\$/);
    const onDisk = matter(serializeCard(saved)).data.costImpact;
    expect(onDisk).toMatchObject({ monthlyAmount: 35, baselineMonthlyAmount: 130, currency: "CHF", scope: "infra", decider: "system" });
    expect(onDisk).not.toHaveProperty("monthlyBRL");
  });

  it("a chamada com o nome antigo (*BRL) num alvo que cobra em outra moeda é RECUSADA antes de tocar o card", async () => {
    target = coerceTargetProfile(declared);
    boardConfig = { id: "oficina", autonomy: coerceAutonomy(budgetRaw) };
    const out = await capture().handlers.get("record_cost_projection")!({ board: "oficina", cardId: "story-ex9982", monthlyBRL: 35, scope: "infra", assumptions: "x", by: "agente-de-teste" });
    expect(out.isError).toBe(true);
    expect(recordCostImpactAction).not.toHaveBeenCalled();
  });

  it("as lentes: as embutidas + a de domínio; add_finding aceita a declarada e recusa a que não existe", () => {
    const t = coerceTargetProfile(declared);
    const ids = reviewLensesOf(t).map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(["security", "testing", "perf", "general", "design", "aros"]));
    const set = new Set(ids);
    expect(addOrRefreshFinding([], { severity: "low", title: "t", lens: "aros", lenses: set }).ok).toBe(true);
    for (const lens of ["raios", "Aros"]) expect(addOrRefreshFinding([], { severity: "low", title: "t", lens, lenses: set }).ok, lens).toBe(false);
    expect(reviewLensesOf(t).find((l) => l.id === "testing")).toMatchObject({ agent: "conferente-de-bancada", declared: true });
  });
});
