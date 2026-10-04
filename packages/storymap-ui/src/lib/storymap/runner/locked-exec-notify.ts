// locked-exec-notify — a saída da «Execução aprovada» para o barramento de avisos. Decisão do dono: o celular só toca
// quando algo deu ERRADO (falhou, foi desfeito, não pôde rodar); o sucesso fica no Inbox e no card. Se o aviso vai ao
// celular quem decide é a política de push única (`locked-exec-failed`), não este arquivo.

import type { AgentAlert } from "@/lib/notifications/event";
import { ALERT_URGENCY } from "@/lib/notifications/event";
import { publishAgentAlert } from "@/lib/notifications/server/alert-bus";
import type { LockedExecRecord } from "./locked-exec";

/** Os estados que avisam. `done` NÃO está aqui (sucesso não empurra); `rejected`/`kept` são gestos do próprio dono. */
export const LOCKED_EXEC_ALERT_STATUSES = new Set(["failed", "undone", "stale", "expired"] as const);

function headline(r: LockedExecRecord): string {
  switch (r.status) {
    case "undone":
      return r.autoUndone ? "Comando aprovado deu errado e foi desfeito" : "Comando aprovado foi desfeito";
    case "stale":
      return "Comando aprovado não rodou: a situação mudou";
    case "expired":
      return "Comando aprovado não rodou a tempo";
    default:
      return "Comando aprovado falhou";
  }
}

/** O aviso do barramento para um registro num estado que avisa (ou null). PURA — exportada para o teste. */
export function lockedExecAlert(r: LockedExecRecord, now: number): AgentAlert | null {
  if (!(LOCKED_EXEC_ALERT_STATUSES as Set<string>).has(r.status)) return null;
  const body = `${r.summary.slice(0, 160)}${r.error ? ` — ${r.error.slice(0, 200)}` : ""}`;
  return {
    id: `locked-exec-${r.id}-${r.status}-${now}`,
    kind: "locked-exec",
    urgency: ALERT_URGENCY["locked-exec"],
    at: now,
    title: headline(r),
    body,
    // um por pedido: falhar e depois desfazer colapsam numa notificação só
    tag: `locked-exec-${r.id}`,
    url: `/board/${encodeURIComponent(r.board)}/inbox`,
    boardId: r.board,
    event: "locked-exec-failed",
  };
}

/** O notificador de produção. Nunca lança. */
export function notifyLockedExec(r: LockedExecRecord, now: number = Date.now()): void {
  try {
    const a = lockedExecAlert(r, now);
    if (a) publishAgentAlert(a);
  } catch (err) {
    console.error("[locked-exec] aviso falhou:", err instanceof Error ? err.message : err);
  }
}
