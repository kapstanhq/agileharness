import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// story-tool-mcp-captura-inteligente — expose the smart-capture flow (propose → apply) as a
// single MCP tool, plus steer the existing surface (create_card / report_issue / preamble)
// toward it. These tests pin the MCP WIRING only: that usm_capture delegates to the existing
// server actions (proposeCardsAction / commitProposalAction — their business logic is already
// covered by smart-capture/*.test.ts + the actions), and that create_card flags orphan stubs.
// We mock @/app/actions so no real `claude -p` is spawned and no .md is ever written.

const proposeCardsAction = vi.fn();
const commitProposalAction = vi.fn();
vi.mock("@/app/actions", () => ({
  proposeCardsAction: (...a: unknown[]) => proposeCardsAction(...a),
  commitProposalAction: (...a: unknown[]) => commitProposalAction(...a),
}));

import { registerStorymapTools } from "./tools";
import type { Card } from "../types";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

function captureHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerStorymapTools(server);
  return handlers;
}

function parseResult(r: CallToolResult): unknown {
  return JSON.parse((r.content[0] as { text: string }).text);
}

/** Register the real tools onto a fake server and return each tool's meta (title/description) by name. */
function captureMetas(): Map<string, { description: string }> {
  const metas = new Map<string, { description: string }>();
  const server = {
    registerTool: (name: string, meta: { description: string }) => {
      metas.set(name, meta);
    },
  } as unknown as McpServer;
  registerStorymapTools(server);
  return metas;
}

/** A card slim() can project (it reads tasks/findings/acceptance arrays). */
function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "story-x",
    type: "story",
    title: "X",
    storyType: "user",
    status: "triage",
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
    order: 0,
    created: null,
    updated: null,
    body: "",
    ...overrides,
  } as Card;
}

beforeEach(() => {
  proposeCardsAction.mockReset();
  commitProposalAction.mockReset();
});

describe("create_card — orphan return-hint steering to usm_capture", () => {
  it("RECUSA a story sem âncora e oferece os PASSOS como candidatos", async () => {
    const out = (await captureHandlers().get("create_card")!({
      board: "storymap",
      title: "Solta",
    })) as CallToolResult;
    // Rejection is server-side (reads the real board for candidates); commitProposalAction is never called.
    expect((out.content[0] as { text: string }).text).toMatch(/sem lugar na hierarquia/);
    expect(commitProposalAction).not.toHaveBeenCalled();
  });

  it("`serves` numa USER story não é ancoragem (só entrega usa esse eixo) → recusada", async () => {
    // a user story (no storyType) with serves would have its serves DROPPED downstream → silent orphan; reject.
    const out = (await captureHandlers().get("create_card")!({
      board: "storymap",
      title: "User com serves",
      serves: "step-abc",
    })) as CallToolResult;
    expect((out.content[0] as { text: string }).text).toMatch(/sem lugar na hierarquia/);
    expect(commitProposalAction).not.toHaveBeenCalled();
  });

  it("WS6 review fix: `serves` on a DELIVERY story (technical) IS placement → created", async () => {
    commitProposalAction.mockResolvedValue({ ok: true, data: { created: [card({ storyType: "technical" })], warnings: [] } });
    const out = (await captureHandlers().get("create_card")!({
      board: "storymap",
      title: "Entrega com serves",
      storyType: "technical",
      serves: "step-abc",
    })) as CallToolResult;
    const parsed = parseResult(out) as { created: unknown[] };
    expect(parsed.created).toHaveLength(1); // not rejected — serves honored for a delivery
    expect(commitProposalAction).toHaveBeenCalled();
  });

  it("a RECUSA é que ensina o caminho — ela nomeia os candidatos e o usm_capture", async () => {
    // O antigo `returnHint` (dica pós-fato de que a story tinha caído no backlog não-mapeado) saiu junto
    // com o backlog: hoje o card sem âncora não chega a ser criado, e a orientação vive na mensagem de
    // recusa, ANTES do estrago.
    const out = (await captureHandlers().get("create_card")!({
      board: "storymap",
      title: "Solta",
    })) as CallToolResult;
    const text = (out.content[0] as { text: string }).text;
    expect(text).toMatch(/sem lugar na hierarquia/);
    expect(commitProposalAction).not.toHaveBeenCalled();
  });

  it("omits returnHint when a parent is provided", async () => {
    commitProposalAction.mockResolvedValue({
      ok: true,
      data: { created: [card({ parent: "step-1" })] },
    });
    const parsed = parseResult(
      await captureHandlers().get("create_card")!({
        board: "storymap",
        title: "Filha",
        parent: "step-1",
      }),
    ) as { returnHint?: string };
    expect(parsed.returnHint).toBeUndefined();
  });

  it("omits returnHint for an activity without parent (valid root)", async () => {
    commitProposalAction.mockResolvedValue({
      ok: true,
      data: { created: [card({ type: "activity", storyType: null })] },
    });
    const parsed = parseResult(
      await captureHandlers().get("create_card")!({
        board: "storymap",
        title: "Backbone",
        type: "activity",
      }),
    ) as { returnHint?: string };
    expect(parsed.returnHint).toBeUndefined();
  });
});

// --- t1/t2: usm_capture (propose / apply) ----------------------------------

describe("usm_capture — propose mode (wraps proposeCardsAction, writes nothing)", () => {
  it("delegates to proposeCardsAction and returns the proposal", async () => {
    const proposal = { summary: "interpretei", items: [{ tempId: "i1", type: "activity", title: "A", rationale: "r" }] };
    proposeCardsAction.mockResolvedValue({ ok: true, data: { proposal } });
    const out = await captureHandlers().get("usm_capture")!({
      board: "storymap",
      mode: "propose",
      text: "um plano com várias coisas",
    });
    expect(commitProposalAction).not.toHaveBeenCalled(); // propose writes nothing
    expect(proposeCardsAction).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: "storymap", text: "um plano com várias coisas" }),
    );
    expect(parseResult(out)).toEqual(proposal);
  });

  it("fails (no write) when text is missing in propose", async () => {
    const r = await captureHandlers().get("usm_capture")!({ board: "storymap", mode: "propose" });
    expect(r.isError).toBe(true);
    expect(proposeCardsAction).not.toHaveBeenCalled();
  });

  it("surfaces a proposeCardsAction error", async () => {
    proposeCardsAction.mockResolvedValue({ ok: false, error: "boom" });
    const r = await captureHandlers().get("usm_capture")!({
      board: "storymap",
      mode: "propose",
      text: "x",
    });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("boom");
  });
});

// --- t3/t4: description steering across the creation surface ---------------

describe("creation-surface descriptions steer toward usm_capture", () => {
  it("registers usm_capture as a tool", () => {
    expect(captureMetas().has("usm_capture")).toBe(true);
  });

  it("create_card description says when NOT to use it + cross-refs usm_capture (t3)", () => {
    const desc = captureMetas().get("create_card")!.description;
    expect(desc).toMatch(/usm_capture/);
    expect(desc.toLowerCase()).toMatch(/não use|plano completo|órf/);
  });

  it("report_issue description cross-refs usm_capture for full plans (t4)", () => {
    const desc = captureMetas().get("report_issue")!.description;
    expect(desc).toMatch(/usm_capture/);
  });

  it("usm_capture description explains both modes (propose writes nothing, apply writes)", () => {
    const desc = captureMetas().get("usm_capture")!.description;
    expect(desc).toMatch(/propose/);
    expect(desc).toMatch(/apply/);
  });
});

// story-fpf9hc — campos ricos no apply não são rejeitados pelo proposedItemShape
describe("usm_capture — apply mode com campos ricos (narrative/acceptance/body) · story-fpf9hc", () => {
  it("passes rich fields through to commitProposalAction without rejection", async () => {
    const richItems = [
      {
        tempId: "i1",
        type: "story",
        title: "Ver perfil",
        rationale: "feature de usuário",
        narrative: { role: "usuário", want: "ver meu perfil", soThat: "me apresentar" },
        acceptance: ["Dado logado, quando acesso /perfil, então vejo meus dados"],
        body: "Decisão: exibir avatar e bio acima do fold.",
      },
    ];
    commitProposalAction.mockResolvedValue({ ok: true, data: { created: [card()] } });
    await captureHandlers().get("usm_capture")!({ board: "storymap", mode: "apply", items: richItems });
    expect(commitProposalAction).toHaveBeenCalledWith(
      expect.objectContaining({ items: richItems }),
    );
  });
});

describe("usm_capture — apply mode (wraps commitProposalAction, writes hierarchy)", () => {
  const items = [
    { tempId: "a1", type: "activity", title: "Atividade", rationale: "r" },
    { tempId: "s1", type: "story", title: "Story", parent: "a1", rationale: "r" },
  ];

  it("delegates to commitProposalAction and returns slim created cards", async () => {
    commitProposalAction.mockResolvedValue({
      ok: true,
      data: { created: [card({ id: "act-1", type: "activity", storyType: null }), card({ id: "story-1", parent: "act-1" })] },
    });
    const out = await captureHandlers().get("usm_capture")!({
      board: "storymap",
      mode: "apply",
      items,
    });
    expect(commitProposalAction).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: "storymap", items }),
    );
    const parsed = parseResult(out) as { created: Array<{ id: string }> };
    expect(parsed.created.map((c) => c.id)).toEqual(["act-1", "story-1"]);
  });

  it("fails (no write) when items is missing/empty in apply", async () => {
    const r = await captureHandlers().get("usm_capture")!({ board: "storymap", mode: "apply" });
    expect(r.isError).toBe(true);
    expect(commitProposalAction).not.toHaveBeenCalled();
  });

  it("um lote fora da hierarquia é RECUSADO inteiro — não aplicado com aviso", async () => {
    // Antes o apply criava a story sem pai e devolvia um `warning` pós-fato. Hoje o commit recusa o lote,
    // então o aviso vira erro — e o agente reenvia com o backbone junto, que é o caminho certo.
    commitProposalAction.mockResolvedValue({ ok: false, error: "Nada foi criado — 1 item(ns) fora da hierarquia" });
    const out = (await captureHandlers().get("usm_capture")!({
      board: "storymap",
      mode: "apply",
      items,
    })) as CallToolResult;
    expect((out.content[0] as { text: string }).text).toMatch(/fora da hierarquia/);
  });
});
