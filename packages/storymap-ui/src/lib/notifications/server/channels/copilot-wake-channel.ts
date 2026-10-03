// copilot-wake-channel — o Jido AUTÔNOMO como um consumidor do barramento de notificações.
//
// O watcher já converte QUALQUER escrita em `storymap/boards/**` (UI, autorun headless, agente editando o .md
// na mão) num AgileHarnessEvent com a `demand` dominante do card anexada. Este channel traduz esse evento num WAKE:
// "há trabalho novo — acorde o Jido agora, não daqui a 30min".
//
// Igual ao trigger-runner-channel: SEMPRE registrado, gated AO VIVO por evento (settings.orchestrator.enabled +
// wake.enabled + o board estar em `autonomous`, tudo checado dentro de scheduleBoardWake) — assim o operador
// liga/desliga no /config sem restart. Não decide nada: quem spawna é o tick, com todos os seus gates.

import type { NotificationChannel, AgileHarnessEvent } from "../../event";
import { scheduleBoardWake, wakeReasonForEvent } from "@/lib/storymap/runner/orchestrator-wake";

export function createCopilotWakeChannel(): NotificationChannel {
  return {
    id: "copilot-wake",
    notify(event: AgileHarnessEvent): void {
      const reason = wakeReasonForEvent(event);
      if (!reason) return; // escrita irrelevante (update sem demanda, board.yaml, delete) ⇒ nem agenda
      // fire-and-forget: o dispatcher já isola exceções por channel, mas o wake nunca deve atrasar o fan-out.
      void scheduleBoardWake(event.boardId, reason);
    },
  };
}
