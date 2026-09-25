// capacity-notify — a ÚNICA saída do governador de capacidade para o celular/Slack. Separada do serviço para que
// ele seja testável sem o barramento (o serviço recebe o notificador por injeção) e para que a lista do que é
// CRÍTICO more em um lugar só: o dono pediu push SÓ para o que é crítico, e um segundo ponto de envio seria
// onde o ruído voltaria.
//
// Os três eventos que chegam aqui (e só eles):
//   · `latch`      — a trava engatou (automática, ou por uma tool/ação);
//   · `extra-usage`— o uso extra PAGO foi ligado na conta;
//   · `held-24h`   — um trabalho automático está retido há mais de 24h.
// Espera por ritmo diário, leitura defasada ou teto de 5h NÃO notificam: são o governador funcionando.

import type { AgentAlert } from "@/lib/notifications/event";
import { ALERT_URGENCY } from "@/lib/notifications/event";
import { publishAgentAlert } from "@/lib/notifications/server/alert-bus";
import { sendSlackAlert } from "@/lib/notifications/server/channels/slack-channel";

export type CapacityCriticalKind = "latch" | "extra-usage" | "held-24h" | "meter-stale";

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
    push: true,
  };
}

/** O notificador de produção: SSE + push (pelo barramento de avisos) + Slack. Nunca lança. */
export function notifyCapacityCritical(n: CapacityCriticalNotice, now: number = Date.now()): void {
  try {
    publishAgentAlert(capacityAlert(n, now));
  } catch (err) {
    console.error("[capacity] aviso falhou:", err instanceof Error ? err.message : err);
  }
  void sendSlackAlert(n.title, n.body);
}
