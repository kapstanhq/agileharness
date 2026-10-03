// O que uma ação de servidor FEZ, dito de um jeito que o dono não confunda
// «comecei» com «terminei». PURE e client-safe: o servidor devolve, o toast lê.
//
// Antes as ações devolviam `{ ok: true }` e o botão escrevia «<rótulo>: ok» — inclusive quando o efeito real
// (uma publicação em produção) só tinha sido DISPARADO e falhava depois, em silêncio. Três
// desfechos, e só eles:
//   · `done`    — o que a ação faz já aconteceu (o card mudou de coluna, o aviso foi triado);
//   · `started` — algo assíncrono começou (publicação, execução de agente); se falhar, o card diz (B2: o finding
//                 `entry-effect-failed`, ou o travado da execução);
//   · `refused` — nada aconteceu, e a mensagem diz por quê.

import { ENTRY_EFFECT_WHAT } from "./entry-effect-failure";
import type { EntryEffect } from "./types";

export type ActionOutcome =
  | { status: "done"; message: string }
  | { status: "started"; message: string }
  | { status: "refused"; message: string };

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** O efeito de entrada de `stepName` foi disparado — roda depois; se falhar, o card diz. PURE. */
export function entryEffectStartedOutcome(effect: EntryEffect, stepName: string): ActionOutcome {
  return {
    status: "started",
    message: `${capitalize(ENTRY_EFFECT_WHAT[effect])} começou em «${stepName}». Se não der certo, o card e o Inbox dizem por quê.`,
  };
}

/** O card foi para `stepName` (sem efeito assíncrono na entrada). PURE. */
export function movedOutcome(stepName: string): ActionOutcome {
  return { status: "done", message: `O card foi para «${stepName}».` };
}

/** Uma nova execução do agente começou neste card. PURE. */
export function runStartedOutcome(stepName: string | null): ActionOutcome {
  return {
    status: "started",
    message: `O agente começou a rodar de novo${stepName ? ` em «${stepName}»` : ""}. Acompanhe em Processos; se falhar, o Inbox mostra.`,
  };
}
