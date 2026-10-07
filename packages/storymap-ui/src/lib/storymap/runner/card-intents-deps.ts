// A CAIXA DE CORREIO DO CARD (card-intents.ts) ligada à produção: o registro em `.runner/card-intents.jsonl`, o
// registro de sessões e a sonda do tmux (os do despacho do condutor, fleet-deps.ts) e a MESMA entrega de linha que as
// respostas usam (lib/vps/tmux.ts — só um pane que prova rodar o claude recebe texto).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { Card } from "@/lib/storymap/types";
import { deliverToSession, sessionRunsClaude } from "@/lib/vps/tmux";
import { isLiveConductor } from "./conductor";
import { defaultConductorDeps } from "./fleet-deps";
import { sessionCardIds } from "./session-worktree";
import {
  forwardMoveAt,
  moveUndoPlan,
  noteOwnerCardIntent,
  ownerMoveRevertRefusal,
  parseCardIntents,
  type CardIntent,
  type CardIntentDeps,
  type CardIntentKind,
} from "./card-intents";

/** Quantos bytes do fim do registro a régua do «não desfazer» lê (o registro só cresce com ações do dono). */
const TAIL_BYTES = 512 * 1024;

export function cardIntentsPath(): string {
  return path.join(runnerStateDir(), "card-intents.jsonl");
}

async function appendIntent(intent: CardIntent): Promise<void> {
  const file = cardIntentsPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(intent)}\n`, "utf8");
}

/** O fim do registro (as ações mais recentes). Ilegível/ausente ⇒ vazio. */
export async function readRecentCardIntents(file: string = cardIntentsPath()): Promise<CardIntent[]> {
  try {
    const stat = await fsp.stat(file);
    const fh = await fsp.open(file, "r");
    try {
      const len = Math.min(stat.size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, stat.size - len);
      const text = buf.toString("utf8");
      // a primeira linha de um recorte pode estar pela metade: parseCardIntents descarta a torta
      return parseCardIntents(text);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

export function defaultCardIntentDeps(): CardIntentDeps {
  const base = defaultConductorDeps();
  return {
    append: appendIntent,
    livePane: async (board, cardId) => {
      const live = await base.liveTmux().catch(() => null);
      if (live === null) return undefined;
      // fase 7: o condutor de um LOTE é o do item também (`sessionCardIds`) — a caixa de correio do item chega a ele
      const s = (await base.sessions()).find((x) => x.board === board && sessionCardIds(x).includes(cardId) && !!x.tmuxSession && isLiveConductor(x, live, base.heartbeatAlive, base.treeGone));
      return s?.tmuxSession ?? null;
    },
    runsClaude: (tmux) => sessionRunsClaude(tmux),
    deliver: async (tmux, text) => (await deliverToSession(tmux, text, { submit: true })).ok,
    newId: () => `ci-${randomUUID()}`,
  };
}

/**
 * Uma linha FIXA só para o condutor VIVO do card — sem retomar um card estacionado (quem chama decide que não há o que
 * retomar). true se entregue. Nunca lança.
 */
export async function noticeLiveConductorNow(board: string, cardId: string, line: string): Promise<boolean> {
  try {
    const deps = defaultCardIntentDeps();
    const pane = await deps.livePane(board, cardId);
    return !!pane && (await deps.runsClaude(pane)) && (await deps.deliver(pane, line));
  } catch {
    return false;
  }
}

/** A ação do DONO num card (fire-and-forget do chamador; nunca lança). `card` = o card ANTES da ação. */
export function noteOwnerCardIntentNow(
  board: string,
  card: Pick<Card, "id" | "routing"> | null | undefined,
  kind: CardIntentKind,
  move?: { from?: string | null; to?: string | null },
): Promise<CardIntent | null> {
  return noteOwnerCardIntent(defaultCardIntentDeps(), { board, card, kind, ...(move ?? {}) }).catch(() => null);
}

/**
 * O «Desfazer» de um movimento do dono (o recibo do Inbox, receipt-undo.ts): desfaz SÓ o que aquele movimento disparou
 * ({@link moveUndoPlan}) — o run do engine que nasceu com ele e o despacho do condutor que ainda não virou sessão — e
 * avisa o condutor vivo (a caixa de correio). Nunca lança.
 */
export async function undoForwardMoveEffects(
  board: string,
  card: Pick<Card, "id" | "routing">,
  forward: { from: string; to: string },
): Promise<{ killedRun: boolean; droppedDispatch: boolean }> {
  const out = { killedRun: false, droppedDispatch: false };
  try {
    const [{ readTransitions }, { getRunnerRegistry }, conductor] = await Promise.all([import("./transitions"), import("./registry"), import("./conductor")]);
    const movedAtMs = forwardMoveAt(await readTransitions({ board, cardId: card.id }).catch(() => []), forward.from, forward.to);
    const run = getRunnerRegistry().snapshot().running.find((r) => r.board === board && r.cardId === card.id) ?? null;
    const base = defaultConductorDeps();
    const queued = (await base.queue.load().catch(() => [])).find((e) => e.board === board && e.cardId === card.id) ?? null;
    const live = await base.liveTmux().catch(() => null);
    const liveConductor =
      live === null || (await base.sessions().catch(() => [])).some((s) => s.board === board && sessionCardIds(s).includes(card.id) && isLiveConductor(s, live, base.heartbeatAlive, base.treeGone));
    const plan = moveUndoPlan({ movedAtMs, run, queued, liveConductor });
    if (plan.killRun) {
      const { getRunnerEngine } = await import("./engine");
      out.killedRun = (await getRunnerEngine().forceRelease(board, card.id)).released === true;
    }
    if (plan.dropDispatch) {
      await conductor.withConductorDispatchLock(async () => {
        if (await conductor.dropQueuedConductorCard(base.queue, board, card.id)) {
          await base.clearDriver(board, card.id);
          out.droppedDispatch = true;
        }
      });
    }
  } catch (err) {
    console.error(`[card-intents] ${board}/${card.id}: o desfazer não conferiu o que o movimento disparou — ${err instanceof Error ? err.message : String(err)}`);
  }
  // o condutor vivo fica sabendo (o desfazer do recibo não passa pelo moveCardAction)
  void noteOwnerCardIntentNow(board, card, "undo-move", { from: forward.to, to: forward.from });
  return out;
}

/** A régua do `move_card` de um agente: desfaria o último movimento do dono? O motivo, ou null. */
export async function ownerMoveRevertHold(board: string, card: Pick<Card, "id" | "status">, to: string): Promise<string | null> {
  return ownerMoveRevertRefusal(await readRecentCardIntents(), board, card, to);
}
