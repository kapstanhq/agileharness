// O REGISTRO do que os agentes decidiram por você (o antigo /board/<b>/acompanhar), dentro de «Os agentes estão
// cuidando» (fase 3). As últimas 24 horas já estão em «Resolvido hoje» (receipts.resolvedToday); aqui ficam os dias
// anteriores, até REGISTRY_DAYS, com o porquê e o «Desfazer» — a MESMA linha (ResolvedEntry) e o mesmo desfazer
// (UndoControl → undoSystemDecisionAction, que confere a pré-condição no servidor).
//
// SÓ SERVIDOR: lê o ledger das decisões (runner/decision-log). As rotas do Inbox chamam e passam o resultado à tela.

import { readSystemDecisions } from "@/lib/storymap/runner/decision-log";
import { agentLabel, followUpItems, undoLabel, type SystemDecision } from "@/lib/storymap/system-decisions";
import { RESOLVED_WINDOW_MS, type ResolvedEntry } from "@/lib/storymap/inbox/receipts";

/** Quantos dias o registro alcança. */
export const REGISTRY_DAYS = 7;

/** As decisões dos agentes de cada board entre `REGISTRY_DAYS` atrás e o começo de «Resolvido hoje». PURA. */
export function systemRegistry(decisions: readonly SystemDecision[], boards: ReadonlyArray<{ id: string; name: string }>, now: number): ResolvedEntry[] {
  const since = new Date(now - REGISTRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date(now - RESOLVED_WINDOW_MS).toISOString();
  const out: ResolvedEntry[] = [];
  for (const b of boards) {
    for (const d of followUpItems(decisions, { board: b.id, since })) {
      if (d.at >= until) continue;
      out.push({
        key: `s:${d.id}`,
        boardId: b.id,
        boardName: b.name,
        at: d.at,
        who: "sistema",
        whoLabel: agentLabel(d.agent),
        what: d.why ? `${d.what} — por quê: ${d.why}` : d.what,
        itemId: `sd:${d.id}`,
        ...(d.cardId ? { cardId: d.cardId } : {}),
        ...(d.undoable && d.undo ? { undo: { source: "system" as const, id: d.id, label: undoLabel(d.undo), ...(d.undo.kind === "reopen-card" ? { reopens: true } : {}) } } : {}),
        ...(d.undoneAt ? { undoneAt: d.undoneAt } : {}),
      });
    }
  }
  return out.sort((a, z) => z.at.localeCompare(a.at));
}

/** O registro dos boards dados, lido do disco. Um ledger ilegível não derruba o Inbox: o registro fica vazio. */
export async function readSystemRegistry(boards: ReadonlyArray<{ id: string; name: string }>, now: number = Date.now()): Promise<ResolvedEntry[]> {
  const decisions = await readSystemDecisions(boards.length === 1 ? { board: boards[0].id } : undefined).catch(() => []);
  return systemRegistry(decisions, boards, now);
}
