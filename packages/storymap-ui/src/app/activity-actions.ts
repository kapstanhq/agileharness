"use server";

// A ATIVIDADE DOS AGENTES da 2ª barra do Kanban — a ponte de leitura, e nada mais: lê os três diários do board (o
// ledger de transições, as execuções encerradas em `.runner/events.jsonl` e o diário do Jido) e entrega ao núcleo puro
// (lib/storymap/activity-feed.ts), que funde, classifica e escreve as frases. Só leitura; depois da sessão verificada
// NUNCA lança — um diário ilegível vira lista menor, e qualquer falha vira `{ ok: false }` (o chip diz que a atividade
// está indisponível, não uma tela de erro). Sem sessão o guard recusa, como em toda action.

import { promises as fs } from "node:fs";
import path from "node:path";
import { requireSession } from "@/lib/auth/action-guard";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { runnerStateDir } from "@/lib/storymap/paths";
import { isConducted } from "@/lib/storymap/driver";
import { readTransitions } from "@/lib/storymap/runner/transitions";
import type { RunEvent } from "@/lib/storymap/runner/event-log";
import { readCopilotActivity } from "@/lib/storymap/copilot/activity";
import { ACTIVITY_LIMIT, mergeActivity, type ActivityItem } from "@/lib/storymap/activity-feed";
import { liveArrivals } from "@/lib/storymap/kanban-features";

type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Quanto de cada diário entra na fusão: folga sobre o teto da lista (a fusão descarta card fora do board e duplicatas). */
const PER_SOURCE = 120;

/** As execuções encerradas deste board (as últimas `PER_SOURCE`). Arquivo ausente ou linha torta ⇒ pula. */
async function readRunEvents(boardId: string): Promise<RunEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(runnerStateDir(), "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: RunEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as RunEvent;
      if (ev && ev.board === boardId && typeof ev.cardId === "string" && typeof ev.at === "number") out.push(ev);
    } catch {
      /* escrita parcial — pula */
    }
  }
  return out.slice(-PER_SOURCE);
}

/**
 * A atividade dos agentes neste board, da mais recente para a mais antiga (no máximo `limit`, teto 30). O guard é a
 * PRIMEIRA instrução, fora do `try` (action-guard-exhaustiveness): sem sessão recusa; o resto nunca lança.
 */
export async function getBoardActivityAction(boardId: string, limit: number = ACTIVITY_LIMIT): Promise<Result<ActivityItem[]>> {
  await requireSession("getBoardActivityAction");
  try {
    const [config, cards, transitions, runs, copilot] = await Promise.all([
      readBoardConfig(boardId),
      readCards(boardId),
      readTransitions({ board: boardId }).catch(() => []),
      readRunEvents(boardId),
      readCopilotActivity(boardId, PER_SOURCE).catch(() => []),
    ]);
    const names = new Map(config.statuses.map((s) => [s.id, s.name] as const));
    const byTrigger = new Map<string, string>();
    for (const s of config.statuses) if (s.trigger && !byTrigger.has(s.trigger)) byTrigger.set(s.trigger, s.name);
    const items = mergeActivity(
      { transitions: transitions.slice(-PER_SOURCE), runs, copilot },
      {
        cards: new Map(cards.map((c) => [c.id, { title: c.title, conducted: isConducted(c) }] as const)),
        statusName: (id) => names.get(id),
        triggerStep: (t) => byTrigger.get(t),
      },
      Math.min(ACTIVITY_LIMIT, Math.max(1, Math.floor(limit) || ACTIVITY_LIMIT)),
    );
    return { ok: true, data: items };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * QUANDO cada card do board chegou ao ar (epoch ms por id): a última transição do ledger para um status terminal
 * (kanban-features `liveArrivals`). É o que a raia No ar e o resumo «+N hoje» leem — nunca a última escrita do card.
 * Card sem transição legível fica de fora (a tela omite o número). O guard é a PRIMEIRA instrução; o resto nunca lança.
 */
export async function getLiveArrivalsAction(boardId: string): Promise<Result<Record<string, number>>> {
  await requireSession("getLiveArrivalsAction");
  try {
    const [config, transitions] = await Promise.all([readBoardConfig(boardId), readTransitions({ board: boardId }).catch(() => [])]);
    const terminal = new Set(config.statuses.filter((s) => s.terminal === true).map((s) => s.id));
    return { ok: true, data: Object.fromEntries(liveArrivals(transitions, terminal)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * O TÍTULO de cada card do board (id → título), para a conversa do Jido trocar o id cru que o agente escreve
 * («story-…») pelo nome do card, como link (copilot/card-links `linkCardIds`). O guard é a PRIMEIRA instrução; o
 * resto nunca lança (sem leitura, a conversa mostra o texto como veio).
 */
export async function getCardTitlesAction(boardId: string): Promise<Result<Record<string, string>>> {
  await requireSession("getCardTitlesAction");
  try {
    const cards = await readCards(boardId);
    return { ok: true, data: Object.fromEntries(cards.map((c) => [c.id, c.title] as const)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
