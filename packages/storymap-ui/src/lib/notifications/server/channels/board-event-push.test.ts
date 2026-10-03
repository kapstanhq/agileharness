// A metade "escrita de board" da política de push: o que uma escrita de card É para o celular — um fato
// (card-demand / card-needs-you / card-moved) ou nada — e o gate do Slack sobre a mesma classificação.

import { describe, expect, it, vi } from "vitest";

const { readBoardConfig, policy } = vi.hoisted(() => ({
  readBoardConfig: vi.fn(async () => ({
    statuses: [
      { id: "revisao", name: "Aprovar entrega", autorun: false },
      { id: "merge", name: "Integrar", autorun: true },
      { id: "concluida", name: "No ar", terminal: true },
    ],
  })),
  policy: { current: null as null | import("../../push-policy").PushPolicy },
}));
vi.mock("@/lib/storymap/repo", () => ({ readBoardConfig }));
vi.mock("../push-policy-config", async () => {
  const { DEFAULT_PUSH_POLICY } = await import("../../push-policy");
  return { currentPushPolicy: () => policy.current ?? DEFAULT_PUSH_POLICY };
});

import { BoardEventPushClassifier, slackWorthyBoardEvent } from "./board-event-push";
import { pushPolicyFrom } from "../../push-policy";
import type { AgileHarnessEvent } from "../../event";

const ev = (over: Partial<AgileHarnessEvent>): AgileHarnessEvent => ({ id: "1", type: "card.updated", boardId: "b", cardId: "c", at: 0, ...over });
const q = { type: "question", label: "Responder 1 pergunta", severity: "high" };

describe("BoardEventPushClassifier — o fato de cada escrita", () => {
  it("demanda pendente ⇒ card-demand UMA vez por tipo; some e volta ⇒ de novo", () => {
    const c = new BoardEventPushClassifier();
    expect(c.classify(ev({ demand: q }), null)).toBe("card-demand");
    expect(c.classify(ev({ demand: { ...q, label: "Responder 2 perguntas" } }), null)).toBeNull(); // mesmo tipo
    expect(c.classify(ev({ demand: { type: "blocker", label: "b", severity: "high" } }), null)).toBe("card-demand");
    expect(c.classify(ev({}), null)).toBeNull(); // sem demanda: esquece
    expect(c.classify(ev({ demand: { type: "blocker", label: "b", severity: "high" } }), null)).toBe("card-demand");
  });

  it("card.created com demanda NÃO é fato (captura em massa seria uma tempestade)", () => {
    expect(new BoardEventPushClassifier().classify(ev({ type: "card.created", demand: q }), null)).toBeNull();
  });

  it("card.moved: parada manual ⇒ card-needs-you; coluna automática/terminal/desconhecida ⇒ card-moved", () => {
    const c = new BoardEventPushClassifier();
    expect(c.classify(ev({ type: "card.moved" }), { autorun: false })).toBe("card-needs-you");
    expect(c.classify(ev({ type: "card.moved" }), { autorun: true })).toBe("card-moved");
    expect(c.classify(ev({ type: "card.moved" }), { terminal: true })).toBe("card-moved");
    expect(c.classify(ev({ type: "card.moved" }), null)).toBe("card-moved");
  });

  it("updated/deleted/board.updated sem demanda nunca são fato", () => {
    const c = new BoardEventPushClassifier();
    for (const type of ["card.updated", "card.deleted", "board.updated", "card.created"] as const) expect(c.classify(ev({ type }), null)).toBeNull();
  });
});

describe("slackWorthyBoardEvent — o Slack segue a mesma régua", () => {
  it("política padrão: NENHUMA escrita de board vai ao Slack — e nem se lê o board.yaml", async () => {
    policy.current = null;
    readBoardConfig.mockClear();
    const c = new BoardEventPushClassifier();
    for (const e of [ev({ demand: q }), ev({ type: "card.moved", toStatus: "revisao" }), ev({ type: "card.created", title: "x" })]) {
      expect(await slackWorthyBoardEvent(c, e)).toBe(false);
    }
    expect(readBoardConfig).not.toHaveBeenCalled();
  });

  it("com card-needs-you na lista: só a entrada numa parada manual passa", async () => {
    policy.current = pushPolicyFrom(["card-needs-you"]);
    try {
      const c = new BoardEventPushClassifier();
      expect(await slackWorthyBoardEvent(c, ev({ type: "card.moved", toStatus: "revisao" }))).toBe(true);
      expect(await slackWorthyBoardEvent(c, ev({ type: "card.moved", toStatus: "merge" }))).toBe(false);
      expect(await slackWorthyBoardEvent(c, ev({ demand: q }))).toBe(false);
    } finally {
      policy.current = null;
    }
  });
});
