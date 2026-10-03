// F3 — lógica PURA da UI da matriz de risco (sem React), p/ ser testável (o teste não consegue importar o
// .tsx sob rolldown-vite). As disposições oferecíveis a uma classe: NEVER_AUTO (deploy/destructive e, após
// F5.0, run/merge-resolve) só ask/never — o clamp do kernel fica VISÍVEL na UI, não só silencioso.

import { NEVER_AUTO_RISK_CLASSES, type RiskClass, type RiskDisposition } from "../types";

export function dispositionsFor(cls: RiskClass): RiskDisposition[] {
  return NEVER_AUTO_RISK_CLASSES.includes(cls) ? ["ask", "never"] : ["auto", "ask", "never"];
}
