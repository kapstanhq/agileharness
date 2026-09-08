// WS-1 (copilot-actionability) — the PURE lifecycle decisions of a copiloto SEED (the composer prefill that
// an escalation carries). Kept pure/isomorphic (invariant 5: RTL render tests are broken under rolldown-vite,
// so the logic that matters lives here, node-testable). The React wiring (BoardHeader/CopilotChat) is a thin
// shell over these.

import { parseEscalationRef, type EscalationRef } from "./escalation";

/** What a `?copilot=` escalation seeds into the drawer: the composer instruction + the item ref. */
export interface CopilotSeed {
  instruction: string;
  ref: EscalationRef;
}

/** Parse the raw `?copilot=` value → a ref, or null for absent/garbage/tampered — NEVER throws (invariant 6). */
export function seedFromCopilotParam(raw: string | null): EscalationRef | null {
  return parseEscalationRef(raw);
}

/** The search string WITHOUT the `copilot` param, preserving every other param (?focus= etc.); "" when empty.
 *  Used for the immediate router.replace cleanup so refresh/back never re-opens the drawer (invariant 6). */
export function stripCopilotParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("copilot");
  return params.toString();
}

// APOSENTADO (2026-07-25) — `shouldRestoreSeedDraft` / `shouldRestoreManualDraft` + seus avisos.
//
// Os dois existiam para um mundo em que um envio RECUSADO se perdia: o 409 ("já há um copiloto trabalhando neste
// board") devolvia o texto ao composer e pedia "reenvie quando o turno atual terminar". A FILA DE SAÍDA
// (`copilot/outbox.ts`) removeu a premissa — o envio é aceito na hora, fica na fila e sai sozinho quando abre
// espaço, então não há rascunho a restaurar. Manter os dois caminhos seria pior que redundante: o texto ficaria
// no composer E na fila, e o operador enviaria a mesma coisa duas vezes. O prefill do seed (o `draft` de
// abertura de uma escalação) continua vivo no CopilotChat — é outra coisa: nasce de um clique, não de um erro.
