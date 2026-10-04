// PUSH SÓ PARA O CRÍTICO — a tabela inteira, fato a fato. A política: o dono abre o Inbox quando quiser, e o celular
// só toca para o crítico (produção fora do ar, uma fonte de dados sem leitura nova por muito tempo, um serviço
// contratado que recusa o pagamento, trava de cota). Cada linha abaixo é uma decisão; a tabela esperada é ESCRITA À MÃO de propósito — se a
// política mudar, este arquivo tem de mudar junto, na frente de quem revisa.

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it, vi } from "vitest";
import { settingsPath } from "@/lib/storymap/paths";
import { ALERT_URGENCY, type AgentAlertKind } from "./event";
import {
  DEFAULT_CRITICAL_PUSH,
  DEFAULT_PUSH_POLICY,
  OPERATOR_OPT_IN_PUSH,
  PUSH_EVENT_KINDS,
  coerceNotificationSettings,
  criticalSignalPrefix,
  isPushEventKind,
  pushPolicyFrom,
  shouldPush,
  shouldSlack,
  type PushEventKind,
} from "./push-policy";
import { alertAllowed } from "@/lib/storymap/copilot/alert-policy";
import type { CopilotTier } from "@/lib/storymap/copilot/tier";
import { coerceRunnerSettings } from "@/lib/storymap/runner/config";

/** O padrão, escrito à mão: celular (push) e Slack, para CADA fato que existe. */
const EXPECTED: Record<PushEventKind, { push: boolean; slack: boolean }> = {
  "capacity-latch": { push: true, slack: true }, // a trava de cota parou a frota
  "capacity-extra-usage": { push: true, slack: true }, // trava por uso PAGO / a conta passou a gastar dinheiro
  "capacity-held-24h": { push: false, slack: false }, // o governador funcionando — painel de capacidade
  "capacity-meter-stale": { push: true, slack: true }, // o medidor parou: frota retida sem ninguém ver
  "deploy-rollback": { push: true, slack: true }, // a produção não recebeu o que foi aprovado
  "deploy-blocked": { push: false, slack: false }, // nada rodou, nada caiu — Inbox (travado)
  "critical-signal": { push: true, slack: true }, // o board declarou: sincronização parada, cópia recusada…
  "card-demand": { push: false, slack: false }, // pergunta/bloqueio/gate — Inbox
  "card-needs-you": { push: false, slack: false }, // parada manual — Inbox
  "card-moved": { push: false, slack: false }, // andou uma coluna — Kanban
  "run-failed": { push: false, slack: false }, // run morreu — Inbox (travado)
  "publish-blocked": { push: false, slack: false }, // fila de publicação parada — Entrega
  "terminal-waiting": { push: false, slack: false }, // terminal no prompt — tela aberta
  "terminal-quiet": { push: true, slack: false }, // SÓ existe quando o operador armou o sininho: é o pedido dele
  "weekly-summary": { push: true, slack: true }, // o resumo de segunda — o único não-crítico
  "locked-exec-failed": { push: true, slack: true }, // o comando travado que o DONO aprovou deu errado ou foi desfeito
};

describe("a política padrão, fato a fato (exaustiva)", () => {
  it("a tabela esperada cobre EXATAMENTE os fatos que existem — um fato novo exige uma decisão aqui", () => {
    expect([...PUSH_EVENT_KINDS].sort()).toEqual((Object.keys(EXPECTED) as PushEventKind[]).sort());
  });

  it.each(Object.entries(EXPECTED) as Array<[PushEventKind, { push: boolean; slack: boolean }]>)(
    "%s → celular=%o",
    (kind, want) => {
      expect(shouldPush(kind)).toBe(want.push);
      expect(shouldPush(kind, DEFAULT_PUSH_POLICY)).toBe(want.push);
      expect(shouldSlack(kind)).toBe(want.slack);
    },
  );

  it("o padrão empurra o crítico — trava de cota (e a de uso pago), medidor parado, deploy revertido, sinais do board, comando aprovado que deu errado — e o resumo da semana", () => {
    expect([...DEFAULT_CRITICAL_PUSH].sort()).toEqual([
      "capacity-extra-usage",
      "capacity-latch",
      "capacity-meter-stale",
      "critical-signal",
      "deploy-rollback",
      "locked-exec-failed",
      "weekly-summary",
    ]);
  });

  it("o único opt-in é o sininho do terminal (e ele nunca vai ao Slack do time)", () => {
    expect([...OPERATOR_OPT_IN_PUSH]).toEqual(["terminal-quiet"]);
    expect(shouldSlack("terminal-quiet")).toBe(false);
  });
});

describe("settings.yaml `notifications.push.critical` troca a lista", () => {
  it("a lista declarada SUBSTITUI o padrão (não soma)", () => {
    const p = pushPolicyFrom(["card-demand", "run-failed"]);
    for (const k of PUSH_EVENT_KINDS) {
      const want = k === "card-demand" || k === "run-failed" || OPERATOR_OPT_IN_PUSH.has(k);
      expect(shouldPush(k, p), k).toBe(want);
      expect(shouldSlack(k, p), k).toBe(k === "card-demand" || k === "run-failed");
    }
  });

  it("lista VAZIA é escolha: nada empurra além do opt-in do operador; ausente ⇒ o padrão", () => {
    const silent = pushPolicyFrom([]);
    expect(PUSH_EVENT_KINDS.filter((k) => shouldPush(k, silent))).toEqual(["terminal-quiet"]);
    expect(pushPolicyFrom(undefined)).toBe(DEFAULT_PUSH_POLICY);
    expect(pushPolicyFrom(null)).toBe(DEFAULT_PUSH_POLICY);
  });

  it("coerce: nome desconhecido é descartado COM aviso, duplicata some, o resto vale", () => {
    const warn = vi.fn();
    expect(coerceNotificationSettings({ push: { critical: ["capacity-latch", "bogus", "capacity-latch", 3] } }, warn)).toEqual({
      push: { critical: ["capacity-latch"] },
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/bogus/);
  });

  it("coerce: sem bloco, sem `push` ou sem lista ⇒ undefined (quem lê aplica o padrão)", () => {
    expect(coerceNotificationSettings(undefined)).toBeUndefined();
    expect(coerceNotificationSettings({})).toBeUndefined();
    expect(coerceNotificationSettings({ push: {} })).toBeUndefined();
    expect(coerceNotificationSettings({ push: { critical: "capacity-latch" } })).toBeUndefined();
    expect(coerceNotificationSettings({ push: { critical: [] } })).toEqual({ push: { critical: [] } });
  });

  it("o carregador de settings carrega o bloco (e não inventa a chave quando ausente)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(coerceRunnerSettings({ notifications: { push: { critical: ["deploy-rollback", "nope"] } } }).notifications).toEqual({
        push: { critical: ["deploy-rollback"] },
      });
      expect("notifications" in coerceRunnerSettings({})).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("isPushEventKind não aceita herança do protótipo", () => {
    expect(isPushEventKind("constructor")).toBe(false);
    expect(isPushEventKind("critical-signal")).toBe(true);
  });
});

describe("os sinais críticos DECLARADOS pelo board (board.yaml notifications.criticalTitlePrefixes)", () => {
  const prefixes = ["[sinal:doca:", "[sinal:telemetria:sem_leitura", "[sinal:cartao:"];

  it("casa pelo início do título (espaços à esquerda ignorados), devolvendo o prefixo", () => {
    expect(criticalSignalPrefix("[sinal:doca:estacao-norte] 3 bicicletas travadas", prefixes)).toBe("[sinal:doca:");
    expect(criticalSignalPrefix("  [sinal:cartao:leitor-2] leituras recusadas", prefixes)).toBe("[sinal:cartao:");
    expect(criticalSignalPrefix("[sinal:telemetria:sem_leitura] GPS mudo", prefixes)).toBe("[sinal:telemetria:sem_leitura");
  });

  it("no meio do título, com caixa diferente, prefixo vazio, ou sem prefixos declarados ⇒ não é sinal", () => {
    expect(criticalSignalPrefix("Investigar [sinal:doca:x]", prefixes)).toBeNull();
    expect(criticalSignalPrefix("[SINAL:doca:x]", prefixes)).toBeNull();
    expect(criticalSignalPrefix("qualquer", [""])).toBeNull();
    expect(criticalSignalPrefix("[sinal:doca:x]", [])).toBeNull();
    expect(criticalSignalPrefix("[sinal:doca:x]", undefined)).toBeNull();
    expect(criticalSignalPrefix(undefined, prefixes)).toBeNull();
  });
});

// Som/notificação da tela aberta e push são eixos diferentes (a tela aberta segue a régua do MODO do Jido), mas
// não podem se contradizer: um aviso que carrega um fato crítico — o que vai ao bolso do dono — nunca é
// silenciado na tela, em modo nenhum.
describe("coerência: o que empurra também toca na tela aberta, em todo modo", () => {
  // quais fatos cada kind de aviso carrega (os produtores: capacity-notify, deploy-revert, critical-signal-channel,
  // attention-watch, instrumentation)
  const EVENTS_OF: Record<AgentAlertKind, PushEventKind[]> = {
    "capacity-critical": ["capacity-latch", "capacity-extra-usage", "capacity-held-24h", "capacity-meter-stale"],
    "deploy-failed": ["deploy-rollback", "deploy-blocked"],
    "critical-signal": ["critical-signal"],
    "publish-blocked": ["publish-blocked"],
    "terminal-waiting": ["terminal-waiting"],
    "terminal-quiet": ["terminal-quiet"],
    "weekly-summary": ["weekly-summary"],
    "locked-exec": ["locked-exec-failed"],
  };

  it("todo kind de aviso tem seus fatos mapeados", () => {
    expect(Object.keys(EVENTS_OF).sort()).toEqual(Object.keys(ALERT_URGENCY).sort());
  });

  const TIERS: CopilotTier[] = ["chat", "copiloto", "autonomo"];
  // o resumo da semana empurra por padrão mas NÃO é crítico (a política do resumo): fica fora desta régua, com a dele abaixo.
  const carriesCritical = (Object.entries(EVENTS_OF) as Array<[AgentAlertKind, PushEventKind[]]>).filter(
    ([kind, events]) => kind !== "weekly-summary" && events.some((e) => DEFAULT_CRITICAL_PUSH.includes(e)),
  );

  it("o resumo da semana: vai ao bolso e não é bloqueante — com a tela aberta, o modo autônomo não o toca", () => {
    expect(ALERT_URGENCY["weekly-summary"]).toBe("pending");
    expect(alertAllowed("autonomo", "weekly-summary")).toBe(false);
  });

  it("os kinds que carregam fato crítico são exatamente estes quatro", () => {
    expect(carriesCritical.map(([k]) => k).sort()).toEqual(["capacity-critical", "critical-signal", "deploy-failed", "locked-exec"]);
  });

  it.each(carriesCritical)("%s: bloqueante e permitido em todo modo", (kind) => {
    expect(ALERT_URGENCY[kind]).toBe("blocking");
    for (const tier of TIERS) expect(alertAllowed(tier, kind), `${tier}/${kind}`).toBe(true);
  });
});

// O exemplo PUBLICADO (storymap/settings.yaml, comentado) é contrato: quem adota descomenta. Ele tem de parsear e
// dizer exatamente o padrão — senão ensina uma lista que não é a que vale.
describe("o exemplo comentado do settings.yaml publicado", () => {
  it("descomentado, é a lista padrão", () => {
    const linhas = readFileSync(settingsPath(), "utf8").split("\n");
    const ini = linhas.findIndex((l) => /^# notifications:\s*$/.test(l));
    expect(ini, "o settings.yaml publicado perdeu o exemplo `# notifications:`").toBeGreaterThan(-1);
    const bloco: string[] = [];
    for (let i = ini; i < linhas.length && linhas[i].trim() !== "#"; i++) bloco.push(linhas[i].slice(2));
    const coerced = coerceNotificationSettings((yaml.load(bloco.join("\n")) as { notifications: unknown }).notifications);
    expect([...(coerced?.push.critical ?? [])].sort()).toEqual([...DEFAULT_CRITICAL_PUSH].sort());
  });
});
