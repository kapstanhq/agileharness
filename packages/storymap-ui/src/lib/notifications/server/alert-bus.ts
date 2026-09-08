// alert-bus — o fan-out dos AVISOS do agente (`AgentAlert`), irmão do dispatcher de eventos de board.
//
// POR QUE UM BARRAMENTO SEPARADO do `dispatcher`: aquele fan-out entrega AgileHarnessEvents (escritas de
// board) a canais que assinam ESCRITAS. Um aviso não é uma escrita — ele nasce de um observador da
// máquina (hoje, o vigia de terminais) e já vem com título/corpo/urgência decididos. Enfiá-lo no
// mesmo canal exigiria que cada consumidor de card passasse a distinguir "isto é um card?" em todo
// handler, e o `describeEvent` (que assume um card) teria de virar um `switch` de dois mundos.
//
// DUAS SAÍDAS, e só duas:
//   • SSE  — sempre. O navegador recebe e decide o efeito local (som/notificação) pela política do
//            modo do Jido (copilot/alert-policy) + os toggles do operador. O servidor NÃO decide o
//            volume de quem está com a tela aberta: quem está olhando é quem manda.
//   • PUSH — só quando o PRODUTOR marcou `push` (ver AgentAlert). É o caminho que alcança a aba
//            fechada; por isso ele é explícito, e não um efeito colateral de "urgência alta".
//
// Process-global (sobrevive ao HMR) e best-effort: um aviso nunca pode derrubar quem o produziu.

import type { AgentAlert } from "../event";
import { sendPush } from "./channels/web-push-channel";

type Sink = (alert: AgentAlert) => void;

interface AlertBus {
  sinks: Set<Sink>;
}

const KEY = Symbol.for("storymap.notifications.alertBus");
const store = globalThis as unknown as { [KEY]?: AlertBus };

function bus(): AlertBus {
  return (store[KEY] ??= { sinks: new Set() });
}

/** Assina o barramento (a rota SSE faz isto por conexão). Devolve o cancelador. */
export function subscribeAgentAlerts(fn: Sink): () => void {
  const b = bus();
  b.sinks.add(fn);
  return () => b.sinks.delete(fn);
}

/** Quantos streams estão ouvindo (diagnóstico/testes). */
export function agentAlertSinkCount(): number {
  return bus().sinks.size;
}

/**
 * Publica UM aviso. Síncrono para quem chama (o push sai em fire-and-forget) e à prova de exceção:
 * um sink morto é descartado em vez de travar o laço.
 */
export function publishAgentAlert(alert: AgentAlert): void {
  const b = bus();
  for (const fn of [...b.sinks]) {
    try {
      fn(alert);
    } catch {
      b.sinks.delete(fn); // stream já fechado
    }
  }
  if (!alert.push) return;
  void sendPush({
    title: alert.title,
    body: alert.body,
    tag: alert.tag,
    url: alert.url,
    // `blocking` acorda a tela; `pending` chega sem estardalhaço. É o único lugar em que a urgência
    // vira comportamento no servidor — e ela é DADO do aviso, não uma inferência daqui.
    priority: alert.urgency === "blocking" ? "high" : "normal",
  }).catch((err) => console.error("[alert-bus] push falhou:", err instanceof Error ? err.message : err));
}
