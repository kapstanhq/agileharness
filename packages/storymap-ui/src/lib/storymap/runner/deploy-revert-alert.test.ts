// "Produção fora do ar" na política de push: um deploy que falhou e REVERTEU o card vira UM aviso `deploy-failed`
// no barramento — `deploy-rollback` (empurra) quando o deploy rodou e falhou, `deploy-blocked` (só o Inbox) quando a
// publicação foi recusada antes de rodar. O segundo callback do MESMO deploy (onDone + webhook) não avisa de novo.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const { publishAgentAlert, state } = vi.hoisted(() => ({
  publishAgentAlert: vi.fn(),
  state: { card: null as unknown as Card },
}));
vi.mock("@/lib/notifications/server/alert-bus", () => ({ publishAgentAlert }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: async () => {} }));
vi.mock("./transitions", () => ({ appendTransition: async () => {} }));
vi.mock("@/lib/storymap/write", () => ({
  updateCardOnDisk: async (_b: string, _id: string, fn: (c: Card) => Card | null) => {
    const next = fn(state.card);
    if (next) state.card = next;
    return next;
  },
}));
const config: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "release", name: "Liberar", autorun: false },
    { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
    { id: "concluida", name: "No ar", terminal: true, delivered: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};
vi.mock("@/lib/storymap/repo", () => ({ readBoardConfig: async () => config }));

import { deployFailureAlert, deployFailurePushEvent, revertCardOnDeployFailure } from "./deploy-revert";
import { shouldPush } from "@/lib/notifications/push-policy";

const card = (): Card => ({ id: "c", type: "story", title: "Checkout novo", status: "deploy", findings: [] }) as unknown as Card;

beforeEach(() => {
  publishAgentAlert.mockClear();
  state.card = card();
});

describe("deployFailurePushEvent — o deploy que rodou × o que foi recusado antes", () => {
  it.each([
    [undefined, "deploy-rollback"],
    ["deploy", "deploy-rollback"],
    ["deploy-noop", "deploy-rollback"],
    ["face-stale", "deploy-rollback"],
    ["self-deploy", "deploy-rollback"],
    ["release", "deploy-blocked"],
    ["freshness", "deploy-blocked"],
  ] as const)("fase %s ⇒ %s", (phase, event) => {
    expect(deployFailurePushEvent({ phase })).toBe(event);
  });
});

describe("revertCardOnDeployFailure avisa UMA vez por revert", () => {
  it("deploy falhou ⇒ card volta a Liberar + UM aviso deploy-rollback, que empurra por padrão", async () => {
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    expect(state.card.status).toBe("release");
    expect(publishAgentAlert).toHaveBeenCalledTimes(1);
    const a = publishAgentAlert.mock.calls[0][0];
    expect(a).toMatchObject({ kind: "deploy-failed", event: "deploy-rollback", boardId: "b", url: "/board/b/inbox" });
    expect(a.body).toContain("Checkout novo");
    expect(shouldPush(a.event)).toBe(true);

    // o segundo callback do MESMO deploy (webhook atrasado): o card já está em Liberar ⇒ nenhum aviso novo
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    expect(publishAgentAlert).toHaveBeenCalledTimes(1);
  });

  it("preflight de frescor recusou ⇒ o aviso é deploy-blocked (fica no Inbox, não empurra)", async () => {
    await revertCardOnDeployFailure("b", "c", { phase: "freshness", reason: "3 commits atrás" });
    expect(publishAgentAlert).toHaveBeenCalledTimes(1);
    expect(publishAgentAlert.mock.calls[0][0]).toMatchObject({ event: "deploy-blocked" });
    expect(shouldPush("deploy-blocked")).toBe(false);
  });

  it("card fora de um status revertível (só o carimbo limpo) ⇒ nenhum aviso — não houve revert", async () => {
    state.card = { ...card(), status: "desenvolver", deployFiredAt: "2026-09-25T00:00:00Z" } as Card;
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    expect(publishAgentAlert).not.toHaveBeenCalled();
  });

  it("deployFailureAlert é puro e carrega o título do finding", () => {
    const a = deployFailureAlert("b", "c", null, { title: "Deploy de produção falhou" }, {}, 7);
    expect(a).toMatchObject({ at: 7, body: "b: Deploy de produção falhou", tag: "deploy-failed:b:c" });
  });
});
