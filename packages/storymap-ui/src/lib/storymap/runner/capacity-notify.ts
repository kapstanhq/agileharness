// capacity-notify — a ÚNICA saída do governador de capacidade para o barramento de avisos. Separada do serviço para
// que ele seja testável sem o barramento (o serviço recebe o notificador por injeção). Se um aviso vai ao celular e
// ao Slack NÃO se decide aqui: é a política de push única (notifications/push-policy), aplicada pelo barramento
// sobre o `event` do aviso — o dono pediu push SÓ para o que é crítico, e um segundo ponto de decisão seria onde o
// ruído voltaria.
//
// Os eventos que chegam aqui (e só eles), cada um com o seu nome na política:
//   · `latch`      — a trava engatou (automática, ou por uma tool/ação)      → `capacity-latch` (empurra);
//   · `extra-usage`— o uso extra PAGO foi ligado (e, se novo, travou a frota) → `capacity-extra-usage` (empurra);
//   · `held-24h`   — um trabalho automático está retido há mais de 24h       → `capacity-held-24h` (só o painel);
//   · `meter-stale`— o medidor de uso parou (a frota fica retida sem ninguém ver) → `capacity-meter-stale` (empurra).
// Espera por ritmo diário, leitura defasada por pouco tempo ou teto de 5h NÃO notificam: são o governador
// funcionando. Uma leitura parada além de `governor.meterStallMinutes` já não é "defasada": é o `meter-stale`.

import type { AgentAlert } from "@/lib/notifications/event";
import { ALERT_URGENCY } from "@/lib/notifications/event";
import type { PushEventKind } from "@/lib/notifications/push-policy";
import { publishAgentAlert } from "@/lib/notifications/server/alert-bus";

export type CapacityCriticalKind = "latch" | "extra-usage" | "held-24h" | "meter-stale";

/** O nome de cada borda do governador no vocabulário da política de push. */
export const CAPACITY_PUSH_EVENT: Record<CapacityCriticalKind, PushEventKind> = {
  latch: "capacity-latch",
  "extra-usage": "capacity-extra-usage",
  "held-24h": "capacity-held-24h",
  // o MEDIDOR parou (a leitura de uso envelheceu depois de já ter sido vista): o governador retém a frota inteira
  // e ninguém percebe — o token que renovaria a leitura nunca recebe tráfego. Uma vez por episódio.
  "meter-stale": "capacity-meter-stale",
};

export interface CapacityCriticalNotice {
  kind: CapacityCriticalKind;
  title: string;
  body: string;
}

/** O aviso do barramento para um evento crítico. PURA — exportada para o teste. */
export function capacityAlert(n: CapacityCriticalNotice, now: number): AgentAlert {
  return {
    id: `capacity-${n.kind}-${now}`,
    kind: "capacity-critical",
    urgency: ALERT_URGENCY["capacity-critical"],
    at: now,
    title: n.title,
    body: n.body,
    // um por tipo: duas trocas de trava colapsam numa notificação no celular em vez de empilhar
    tag: `capacity-${n.kind}`,
    // o painel de capacidade vive no medidor da barra de topo, presente em toda página
    url: "/",
    event: CAPACITY_PUSH_EVENT[n.kind],
  };
}

/** O notificador de produção: o barramento de avisos (SSE sempre; push e Slack pela política). Nunca lança. */
export function notifyCapacityCritical(n: CapacityCriticalNotice, now: number = Date.now()): void {
  try {
    publishAgentAlert(capacityAlert(n, now));
  } catch (err) {
    console.error("[capacity] aviso falhou:", err instanceof Error ? err.message : err);
  }
}
