// O canal de web-push de ponta a ponta sob a política: com as chaves VAPID e um aparelho inscrito, NENHUMA escrita de
// board chega ao celular por padrão (o Inbox as guarda); só quando o dono lista o fato como crítico.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendNotification, policy } = vi.hoisted(() => ({
  sendNotification: vi.fn(async (_sub: unknown, _body: string) => ({})),
  policy: { current: null as null | import("../../push-policy").PushPolicy },
}));
vi.mock("web-push", () => ({ default: { setVapidDetails: () => {}, sendNotification } }));
vi.mock("../push-store", () => ({ loadSubscriptions: () => [{ endpoint: "https://push.example/1", keys: {} }], removeSubscription: () => {} }));
vi.mock("@/lib/storymap/repo", () => ({
  readBoardConfig: async () => ({ statuses: [{ id: "revisao", name: "Aprovar entrega", autorun: false }] }),
}));
const { registrySubscribers } = vi.hoisted(() => ({ registrySubscribers: [] as Array<(snap: { failures: unknown[] }) => void> }));
vi.mock("@/lib/storymap/runner/registry", () => ({
  getRunnerRegistry: () => ({ subscribe: (fn: (snap: { failures: unknown[] }) => void) => registrySubscribers.push(fn) }),
}));
vi.mock("../push-policy-config", async () => {
  const { DEFAULT_PUSH_POLICY } = await import("../../push-policy");
  return { currentPushPolicy: () => policy.current ?? DEFAULT_PUSH_POLICY };
});

import { createWebPushChannel, initRunnerFailurePush } from "./web-push-channel";
import { pushPolicyFrom } from "../../push-policy";
import type { AgileHarnessEvent } from "../../event";

const ev = (over: Partial<AgileHarnessEvent>): AgileHarnessEvent => ({ id: "1", type: "card.updated", boardId: "b", cardId: "c", at: 0, title: "C", ...over });

beforeEach(() => {
  vi.stubEnv("AGILEHARNESS_VAPID_PUBLIC_KEY", "pub");
  vi.stubEnv("AGILEHARNESS_VAPID_PRIVATE_KEY", "priv");
  vi.stubEnv("AGILEHARNESS_VAPID_SUBJECT", "mailto:ops@exemplo.org");
  sendNotification.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  policy.current = null;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createWebPushChannel sob a política de push", () => {
  it("padrão: pergunta nova, parada manual e coluna andada NÃO vão ao celular", async () => {
    const ch = createWebPushChannel()!;
    expect(ch).not.toBeNull();
    await ch.notify(ev({ demand: { type: "question", label: "Responder 1 pergunta", severity: "high" } }));
    await ch.notify(ev({ type: "card.moved", toStatus: "revisao", toStatusName: "Aprovar entrega" }));
    await ch.notify(ev({ id: "2", type: "card.moved", toStatus: "outra" }));
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("com card-demand listado: a pergunta nova vai (uma vez) e a coluna andada não", async () => {
    policy.current = pushPolicyFrom(["card-demand"]);
    const ch = createWebPushChannel()!;
    await ch.notify(ev({ demand: { type: "question", label: "Responder 1 pergunta", severity: "high" } }));
    await ch.notify(ev({ demand: { type: "question", label: "Responder 2 perguntas", severity: "high" } }));
    await ch.notify(ev({ type: "card.moved", toStatus: "revisao" }));
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toMatchObject({ title: expect.stringContaining("Precisa de você") });
  });
});

describe("a ponte de runs falhos sob a política (run-failed)", () => {
  it("padrão: um run que falhou NÃO vai ao celular (é um item TRAVADO no Inbox); listado, vai", async () => {
    initRunnerFailurePush();
    expect(registrySubscribers).toHaveLength(1);
    const fail = (at: number) => ({ board: "b", cardId: "c", trigger: "harness-do", at, reason: "exit" });
    registrySubscribers[0]({ failures: [fail(1)] });
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    policy.current = pushPolicyFrom(["run-failed"]);
    registrySubscribers[0]({ failures: [fail(1), fail(2)] }); // a 1 já foi vista; a 2 é nova
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
