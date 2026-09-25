// O barramento de avisos aplica a política de push ÚNICA: a tela aberta (SSE) recebe TODO aviso; o celular e o
// Slack só o que a política manda — e isso vale para cada produtor, porque nenhum decide mais sozinho.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendPush, sendSlackAlert } = vi.hoisted(() => ({ sendPush: vi.fn(async () => {}), sendSlackAlert: vi.fn(async () => {}) }));
vi.mock("./channels/web-push-channel", () => ({ sendPush }));
vi.mock("./channels/slack-channel", () => ({ sendSlackAlert }));
vi.mock("./push-policy-config", async () => {
  const { DEFAULT_PUSH_POLICY } = await import("../push-policy");
  return { currentPushPolicy: () => DEFAULT_PUSH_POLICY };
});

import { publishAgentAlert, subscribeAgentAlerts } from "./alert-bus";
import { ALERT_URGENCY, type AgentAlert, type AgentAlertKind } from "../event";
import { PUSH_EVENT_KINDS, pushPolicyFrom, shouldPush, shouldSlack, type PushEventKind } from "../push-policy";
import { capacityAlert } from "@/lib/storymap/runner/capacity-notify";

const alert = (event: PushEventKind, kind: AgentAlertKind = "capacity-critical"): AgentAlert => ({
  id: `a-${event}`,
  kind,
  urgency: ALERT_URGENCY[kind],
  at: 1,
  title: `t ${event}`,
  body: "b",
  tag: "t",
  url: "/",
  event,
});

beforeEach(() => {
  sendPush.mockClear();
  sendSlackAlert.mockClear();
});

describe("publishAgentAlert — a régua única entre a tela e o bolso", () => {
  it.each(PUSH_EVENT_KINDS)("%s: SSE sempre; celular/Slack exatamente o que a política padrão diz", async (event) => {
    const seen: AgentAlert[] = [];
    const off = subscribeAgentAlerts((a) => seen.push(a));
    try {
      publishAgentAlert(alert(event));
    } finally {
      off();
    }
    expect(seen.map((a) => a.event)).toEqual([event]);
    expect(sendPush).toHaveBeenCalledTimes(shouldPush(event) ? 1 : 0);
    expect(sendSlackAlert).toHaveBeenCalledTimes(shouldSlack(event) ? 1 : 0);
  });

  it("a política em vigor (settings) muda o destino sem mexer no produtor", () => {
    publishAgentAlert(alert("capacity-latch"), pushPolicyFrom([]));
    expect(sendPush).not.toHaveBeenCalled();
    expect(sendSlackAlert).not.toHaveBeenCalled();
    publishAgentAlert(alert("publish-blocked", "publish-blocked"), pushPolicyFrom(["publish-blocked"]));
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
  });

  it("o push carrega o texto e a prioridade do aviso (bloqueante ⇒ high)", () => {
    publishAgentAlert(alert("deploy-rollback", "deploy-failed"));
    expect(sendPush).toHaveBeenCalledWith(expect.objectContaining({ title: "t deploy-rollback", priority: "high", url: "/" }));
  });
});

describe("o governador: cada borda com o seu nome na política", () => {
  it("trava e uso pago empurram; retido-24h fica no painel", () => {
    publishAgentAlert(capacityAlert({ kind: "latch", title: "Trava", body: "x" }, 1));
    publishAgentAlert(capacityAlert({ kind: "extra-usage", title: "Uso extra PAGO ligado — frota travada", body: "x" }, 2));
    expect(sendPush).toHaveBeenCalledTimes(2);
    sendPush.mockClear();
    publishAgentAlert(capacityAlert({ kind: "held-24h", title: "Retido", body: "x" }, 3));
    expect(sendPush).not.toHaveBeenCalled();
    expect(sendSlackAlert).toHaveBeenCalledTimes(2); // o Slack segue a mesma régua (as duas primeiras)
  });

  it("o MEDIDOR parado empurra (frota retida sem ninguém ver) — uma borda do governador como as outras", () => {
    publishAgentAlert(capacityAlert({ kind: "meter-stale", title: "Medidor de cota parado", body: "desde 03:10" }, 4));
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    expect(capacityAlert({ kind: "meter-stale", title: "t", body: "b" }, 4)).toMatchObject({ event: "capacity-meter-stale", tag: "capacity-meter-stale" });
  });

  it("o aviso do governador leva o fato, não uma decisão de push", () => {
    const a = capacityAlert({ kind: "held-24h", title: "t", body: "b" }, 5);
    expect(a).toMatchObject({ kind: "capacity-critical", event: "capacity-held-24h", urgency: "blocking" });
    expect(a).not.toHaveProperty("push");
  });
});
