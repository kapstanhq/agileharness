// critical-signal channel — o jeito GENÉRICO de um sinal do PRODUTO chegar ao bolso do dono.
//
// O dono pediu push para "fonte de eventos parada há mais de 24h" e "fornecedor sem crédito" — fatos que só o
// produto conhece (o monitor do scraper, o de créditos), nunca o AgileHarness. O núcleo não pode saber o que é
// "fonte" nem "fornecedor" de ninguém (ferramenta genérica): quem sabe é o BOARD. O contrato é um prefixo de título:
// o monitor do produto cria um card `[sinal:scraper:…] …`, e o board declara em `board.yaml`
//
//   notifications:
//     criticalTitlePrefixes: ["[sinal:scraper:", "[sinal:sources:source_silent", "[sinal:credits:"]
//
// Um card que NASCE com um desses prefixos vira o aviso `critical-signal` no barramento — SSE para a tela aberta e,
// pela política de push (é crítico por padrão), celular e Slack. UMA vez por card: o watcher só emite
// `card.created` para um card novo (a semente do boot é silenciosa) e este canal ainda lembra quem já avisou.

import type { AgentAlert, AgileHarnessEvent, NotificationChannel } from "../../event";
import { ALERT_URGENCY } from "../../event";
import { criticalSignalPrefix } from "../../push-policy";
import { cardHref } from "@/lib/storymap/deep-links";
import type { BoardConfig } from "@/lib/storymap/types";

/** O aviso de um sinal crítico. PURA — exportada para o teste. */
export function criticalSignalAlert(event: AgileHarnessEvent, prefix: string, now: number): AgentAlert {
  const board = event.boardName ?? event.boardId;
  return {
    id: `critical-signal-${event.boardId}-${event.cardId}`,
    kind: "critical-signal",
    urgency: ALERT_URGENCY["critical-signal"],
    at: now,
    title: `Sinal crítico — ${board}`,
    body: event.title ?? prefix,
    tag: `critical-signal:${event.boardId}:${event.cardId}`,
    url: cardHref(event.boardId, event.cardId ?? ""),
    boardId: event.boardId,
    event: "critical-signal",
  };
}

/** Quantos cards o canal lembra (o bastante para nenhuma reentrega do watcher repetir; limitado para não crescer). */
const REMEMBERED_MAX = 2000;

export interface CriticalSignalDeps {
  readBoardConfig(board: string): Promise<Pick<BoardConfig, "notifications"> | null>;
  publish(alert: AgentAlert): void;
  now?(): number;
}

/** O canal do dispatcher. Sempre registrado — um board sem prefixos declarados nunca emite nada. */
export function createCriticalSignalChannel(deps: CriticalSignalDeps): NotificationChannel {
  const signalled = new Set<string>();
  return {
    id: "critical-signal",
    async notify(event: AgileHarnessEvent) {
      if (event.type !== "card.created" || !event.cardId) return;
      const key = `${event.boardId}/${event.cardId}`;
      if (signalled.has(key)) return;
      const config = await deps.readBoardConfig(event.boardId).catch(() => null);
      const prefix = criticalSignalPrefix(event.title, config?.notifications?.criticalTitlePrefixes);
      if (!prefix) return;
      signalled.add(key);
      if (signalled.size > REMEMBERED_MAX) signalled.delete(signalled.values().next().value as string);
      deps.publish(criticalSignalAlert(event, prefix, (deps.now ?? Date.now)()));
    },
  };
}
