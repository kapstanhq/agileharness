// Item 3 — a CONFIRMAÇÃO honesta que o header mostra ao trocar o modo do board. Reflete o estado REAL: um
// board autônomo só AGE se (a) o tick global está armado (settings.enabled), (b) o token do orquestrador
// (AGILEHARNESS_MCP_TOKEN_ORCH) está no serviço e (c) a matriz de risco lhe deu permissão de escrever no board.
// Faltando qualquer um, `autonomous` fica INERTE ou só-leitura — e o operador precisa VER isso, senão acha que
// o Jido está trabalhando quando não está.
//
// A verdade mora em copilot-status (fonte ÚNICA, compartilhada com o chip PERSISTENTE do header): este módulo
// só a veste de toast. Antes o toast era a única superfície que dizia "inerte" — e ele sumia em 8s, deixando um
// "auto" aceso mentindo na tela. Puro (sem React) → testável.

import type { OrchestratorMode, RiskDisposition } from "@/lib/storymap/types";
import { copilotStatus } from "./copilot-status";

export interface ActivationState {
  /** o modo que ACABOU de ser gravado. */
  mode: OrchestratorMode;
  /** tick global armado (settings.orchestrator.enabled). */
  enabled: boolean;
  /** AGILEHARNESS_MCP_TOKEN_ORCH presente no serviço → o tick consegue spawnar o orquestrador. */
  orchTokenPresent: boolean;
  /** cadência do tick (min), p/ dizer quando o Jido age. */
  tickMinutes: number;
  /** a disposição RESOLVIDA de `write-board` — decide entre "age sozinho" e "só lê e pede aprovação". */
  writeBoard?: RiskDisposition;
}

export interface ActivationNotice {
  level: "ok" | "warn";
  text: string;
}

/**
 * Traduz a troca de modo numa confirmação honesta: autonomous → "vai agir" só quando armado, com token E com
 * permissão de escrita; senão diz exatamente O QUE falta. paired/off → o que passa a valer. Pura.
 */
export function activationNotice(s: ActivationState): ActivationNotice {
  const st = copilotStatus({
    mode: s.mode,
    enabled: s.enabled,
    orchTokenPresent: s.orchTokenPresent,
    writeBoard: s.writeBoard ?? "ask",
  });
  if (st.level === "auto-active") {
    return {
      level: "ok",
      text: `Autônomo ligado — o Jido age sozinho neste board (tick a cada ${s.tickMinutes}min, e acorda na hora quando algo trava ou cai no cockpit; disparei um agora).`,
    };
  }
  return { level: st.tone === "warn" ? "warn" : "ok", text: st.detail };
}
