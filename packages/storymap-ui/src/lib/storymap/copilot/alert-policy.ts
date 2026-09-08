// QUANTO o Jido pode te interromper — a política de aviso, projetada sobre o MODO dele.
//
// O pedido do Operador: "ele pode ter níveis de interação/notificação dependendo do modo que estiver
// selecionado". O modo já existe e é o TIER (chat · copiloto · autônomo, copilot/tier.ts, ele próprio
// uma projeção de (mode, riskMatrix.deploy) — não há campo novo aqui, e nunca deve haver: um segundo
// eixo de "modo" seria uma segunda verdade sobre o mesmo botão).
//
// O GRADIENTE, em uma frase: **quanto mais autonomia ele tem, menos ele te avisa do que é cortesia —
// e nunca deixa de te avisar do que TRAVA.**
//
//   chat      — ele não age sozinho: tudo depende de você, então ele conta tudo o que está te esperando.
//   copiloto  — ele destrava o sistema mas defere produto: ainda te conta tudo (um terminal é SEU;
//               ele não tem como responder um prompt no seu lugar — `run-free` é humano em todo tier).
//   autônomo  — ele toca o trabalho de ponta a ponta e você pediu para não ser incomodado com rotina:
//               só o que BLOQUEIA chega.
//
// EXAUSTIVA POR CONSTRUÇÃO (`Record<CopilotTier, Record<AgentAlertKind, boolean>>`): um kind novo é
// ERRO DE COMPILAÇÃO até alguém decidir, para os TRÊS modos, se ele merece interromper. É a mesma
// governança que a tabela KIND_AUTONOMY do cockpit cobra — e pela mesma razão: quando o default é
// silencioso, um aviso novo nasce mudo e ninguém descobre; quando é barulhento, o operador desliga
// tudo. Nenhum dos dois é decisão — os dois são omissão.
//
// PURA (zero IO, client-safe): o navegador aplica esta régua ao receber um aviso pelo SSE, com o tier
// que a barra já conhece. Testada em alert-policy.test.ts.

import { ALERT_URGENCY, type AgentAlertKind } from "@/lib/notifications/event";
import type { CopilotTier } from "@/lib/storymap/copilot/tier";

/** Quem interrompe quem. Ver o gradiente no cabeçalho. */
const ALERTS_BY_TIER: Record<CopilotTier, Record<AgentAlertKind, boolean>> = {
  chat: {
    "terminal-waiting": true,
    "terminal-quiet": true,
    "publish-blocked": true,
  },
  copiloto: {
    "terminal-waiting": true,
    "terminal-quiet": true,
    "publish-blocked": true,
  },
  autonomo: {
    "terminal-waiting": true,
    // No modo em que ele resolve o resto sozinho, "o terminal ficou quieto" é ruído de rotina: o
    // operador escolheu esse modo justamente para não acompanhar cada passo. O que TRAVA continua
    // passando — autonomia nunca compra o direito de esconder um bloqueio.
    "terminal-quiet": false,
    // E este TRAVA: a publicação não sai sozinha (ou o trabalho sobreposto integra, ou alguém dispensa
    // o embargo). Passa nos três modos pela regra da linha acima.
    "publish-blocked": true,
  },
};

/** Todo kind que existe — derivado do domínio, para a frase abaixo nunca contar uma lista PRÓPRIA. */
const ALL_KINDS = Object.keys(ALERT_URGENCY) as AgentAlertKind[];

/** Este aviso pode interromper o operador neste modo? PURA. */
export function alertAllowed(tier: CopilotTier, kind: AgentAlertKind): boolean {
  return ALERTS_BY_TIER[tier]?.[kind] ?? false;
}

/**
 * A frase que explica o nível ao operador (o texto do painel de notificações). Uma linha por modo,
 * CONTADA a partir da mesma tabela — se a política mudar e a frase não, o teste de coerência quebra.
 */
export function alertPolicyLabel(tier: CopilotTier): string {
  const on = ALL_KINDS.filter((k) => alertAllowed(tier, k));
  if (on.length === 0) return "Não interrompe";
  if (on.length === ALL_KINDS.length) return "Avisa tudo que está te esperando";
  return "Avisa só o que trava o seu trabalho";
}
