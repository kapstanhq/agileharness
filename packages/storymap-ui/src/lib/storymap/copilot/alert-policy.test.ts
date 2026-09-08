import { describe, expect, it } from "vitest";
import { alertAllowed, alertPolicyLabel } from "./alert-policy";
import { ALERT_URGENCY, type AgentAlertKind } from "@/lib/notifications/event";
import type { CopilotTier } from "./tier";

const TIERS: CopilotTier[] = ["chat", "copiloto", "autonomo"];
const KINDS = Object.keys(ALERT_URGENCY) as AgentAlertKind[];

describe("alertAllowed — o gradiente por modo", () => {
  it("o que TRAVA passa em TODOS os modos (autonomia não compra o direito de esconder bloqueio)", () => {
    for (const tier of TIERS) expect(alertAllowed(tier, "terminal-waiting")).toBe(true);
  });

  it("a cortesia ('ficou quieto') cala no autônomo e fala nos demais", () => {
    expect(alertAllowed("chat", "terminal-quiet")).toBe(true);
    expect(alertAllowed("copiloto", "terminal-quiet")).toBe(true);
    expect(alertAllowed("autonomo", "terminal-quiet")).toBe(false);
  });

  it("todo kind tem decisão explícita em todo modo (nada cai num default silencioso)", () => {
    for (const tier of TIERS) {
      for (const kind of KINDS) {
        expect(typeof alertAllowed(tier, kind)).toBe("boolean");
      }
    }
  });

  it("um kind desconhecido não interrompe ninguém (fail-closed)", () => {
    expect(alertAllowed("chat", "kind-que-nao-existe" as AgentAlertKind)).toBe(false);
  });

  it("um tier desconhecido não interrompe ninguém (fail-closed)", () => {
    expect(alertAllowed("nao-existe" as CopilotTier, "terminal-waiting")).toBe(false);
  });
});

describe("ALERT_URGENCY", () => {
  it("classifica cada kind em blocking/pending", () => {
    expect(ALERT_URGENCY["terminal-waiting"]).toBe("blocking");
    expect(ALERT_URGENCY["terminal-quiet"]).toBe("pending");
  });
});

describe("alertPolicyLabel — a frase segue a tabela, não o contrário", () => {
  it("diz 'tudo' quando o modo deixa passar todos os kinds", () => {
    expect(alertPolicyLabel("chat")).toContain("tudo");
    expect(alertPolicyLabel("copiloto")).toContain("tudo");
  });

  it("diz 'só o que trava' quando o modo filtra a cortesia", () => {
    expect(alertPolicyLabel("autonomo")).toContain("trava");
  });

  it("a frase é COERENTE com alertAllowed em todo modo", () => {
    for (const tier of TIERS) {
      const on = KINDS.filter((k) => alertAllowed(tier, k)).length;
      const label = alertPolicyLabel(tier);
      if (on === KINDS.length) expect(label).toContain("tudo");
      else if (on === 0) expect(label).toContain("Não interrompe");
      else expect(label).toContain("trava");
    }
  });
});
