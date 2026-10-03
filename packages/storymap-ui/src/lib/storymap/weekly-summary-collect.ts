// O RESUMO DA SEMANA lido do disco (weekly-summary.ts é a régua pura). Servidor: todos os boards, o ledger de
// transições, o registro de decisões do sistema, a telemetria das execuções e os itens do Inbox — só leitura.

import { diskHealthLedger } from "./health/health-deps";
import { collectBoardInbox } from "./inbox/collect";
import { localTimeFormatter } from "./inbox/copy";
import { ownerDecisionsWaiting, type OwnerWaiting } from "./owner-waiting";
import { listBoards } from "./repo";
import { readSystemDecisions } from "./runner/decision-log";
import { diskTelemetryStore } from "./runner/telemetry";
import { readTransitions } from "./runner/transitions";
import { rolloutReadiness } from "./rollout";
import { buildWeeklySummary, mondayOf, weekWindow, type WeeklyBoardInput, type WeeklySummary } from "./weekly-summary";

/** O fuso do dono: o do ritmo diário do governador (`governor.timezone`); ausente, o do host (owner-timezone.ts). */
export { ownerTimeZone } from "./owner-timezone";
import { ownerTimeZone } from "./owner-timezone";

/** O resumo da semana que começa em `monday` (ausente ⇒ a semana corrente). Nunca lança por um board ilegível. */
export async function collectWeeklySummary(monday?: string, now: number = Date.now()): Promise<WeeklySummary> {
  const tz = ownerTimeZone();
  const week = weekWindow(monday ?? mondayOf(now, tz), tz);
  const summaries = await listBoards();
  const boards: WeeklyBoardInput[] = [];
  const waiting: OwnerWaiting[] = [];
  const fmt = localTimeFormatter(now, tz);
  for (const s of summaries) {
    // O Inbox do board: a MESMA leitura do badge — o que espera o dono é o Decidir dele (onda 2).
    const inbox = await collectBoardInbox(s.id, now).catch(() => null);
    if (!inbox) continue;
    boards.push({ id: s.id, name: s.name, config: inbox.config, cards: inbox.cards });
    waiting.push(...ownerDecisionsWaiting(inbox.entries, inbox.config, now, fmt));
  }
  const [transitions, decisions, runs, health] = await Promise.all([
    readTransitions().catch(() => []),
    readSystemDecisions().catch(() => []),
    diskTelemetryStore().load().catch(() => []),
    // a tendência da saúde da ferramenta: as leituras que o tick gravou (health.jsonl); ausente ⇒ a seção some
    diskHealthLedger().read().catch(() => []),
  ]);
  waiting.sort((a, b) => (a.since ?? "9999").localeCompare(b.since ?? "9999"));
  const firstDecision = (board: string) => decisions.filter((d) => d.board === board).map((d) => d.at).sort()[0] ?? null;
  const { ready, line } = rolloutReadiness(transitions, boards.map((b) => ({ ...b, firstSystemDecisionAt: firstDecision(b.id) })));
  return buildWeeklySummary({ week, boards, transitions, decisions, runs, waiting, rollout: { ready, line }, health });
}
