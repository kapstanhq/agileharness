// O dispatcher registra o canal dos SINAIS CRÍTICOS do board — sem esta linha a declaração em board.yaml
// (`notifications.criticalTitlePrefixes`) seria aceita, coerida e INERTE: o monitor do produto gritaria e o dono
// não ouviria. E o da AUDITORIA de entregas autônomas, pelo mesmo motivo: sem ele o modo ultra nunca amostraria.

import { describe, expect, it, vi } from "vitest";

const { criticalNotify, auditNotify } = vi.hoisted(() => ({ criticalNotify: vi.fn(async () => {}), auditNotify: vi.fn(async () => {}) }));
vi.mock("./channels/delivery-audit-channel", () => ({
  createDeliveryAuditChannel: () => ({ id: "delivery-audit", notify: auditNotify }),
}));
vi.mock("./channels/critical-signal-channel", () => ({
  createCriticalSignalChannel: () => ({ id: "critical-signal", notify: criticalNotify }),
}));
vi.mock("./channels/trigger-runner-channel", () => ({ createTriggerRunnerChannel: () => ({ id: "trigger-runner", notify: () => {} }) }));
vi.mock("./channels/copilot-wake-channel", () => ({ createCopilotWakeChannel: () => ({ id: "copilot-wake", notify: () => {} }) }));
vi.mock("./channels/web-push-channel", () => ({ createWebPushChannel: () => null, initRunnerFailurePush: () => {} }));
vi.mock("./channels/slack-channel", () => ({ createSlackChannel: () => null }));

import { getDispatcher } from "./dispatcher";

describe("getDispatcher", () => {
  it("entrega cada evento de board ao canal de sinais críticos", async () => {
    // o dispatcher é um singleton do processo: garante que ESTE teste monta um novo, com os canais mockados acima
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("storymap.notifications.dispatcher")];
    const event = { id: "1", type: "card.created" as const, boardId: "b", cardId: "c", title: "[sinal:x] y", at: 0 };
    await getDispatcher().dispatch(event);
    expect(criticalNotify).toHaveBeenCalledWith(event);
    // e ao canal da auditoria de entregas autônomas (modo ultra) — sem ele a amostra nunca aconteceria
    expect(auditNotify).toHaveBeenCalledWith(event);
  });
});
