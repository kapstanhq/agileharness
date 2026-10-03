// O TETO DE GASTO DO CARD (card-budget.ts) ligado à produção: o settings vivo, a leitura da cota do governador de
// capacidade, o ledger de telemetria do card mais a estimativa das sessões vivas, e a escrita da pergunta sob a
// trava do card. Tudo como o próprio serviço — nenhuma server action no caminho.

import { isConducted } from "@/lib/storymap/driver";
import { nextQuestionId } from "@/lib/storymap/questions";
import { listBoards, readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
import type { Card } from "@/lib/storymap/types";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { deliverToSession, probeLiveTmuxSessions, sessionRunsClaude } from "@/lib/vps/tmux";
import { readWorktreeSessionCost } from "@/lib/vps/session-cost";
import { getCapacityGovernor } from "./capacity-service";
import {
  approveAsSystem,
  budgetQuestion,
  budgetRaiseDecision,
  effectiveCardBudgetUSD,
  judgeBudgetRequest,
  openBudgetRequests,
  quotaPace,
  sweepCardBudgets,
  type BudgetSweepCard,
  type BudgetVerdict,
  type QuotaReading,
} from "./card-budget";
import { isLiveConductor } from "./conductor";
import { loadRunnerConfig } from "./config";
import { appendSystemDecision } from "./decision-log";
import { isSessionAlive } from "./session-liveness";
import { allSessions, type AgentSession } from "./session-worktree";
import { getTelemetryStore } from "./telemetry";
import { boardGateNow } from "./board-pace-store";

const today = () => new Date().toISOString().slice(0, 10);

function capUSD(): number | null {
  const cap = loadRunnerConfig().autorun.cardBudgetUSD;
  return typeof cap === "number" && cap > 0 ? cap : null;
}

function quota(): QuotaReading | null {
  try {
    const r = getCapacityGovernor().snapshot().reading;
    return r ? { usage7dPct: r.usage7dPct, usage5hPct: r.usage5hPct, resetsAt7d: r.resetsAt7d, stale: r.stale } : null;
  } catch {
    return null; // sem governador não há leitura — a régua do ritmo trata como «fora do ritmo»
  }
}

/** O que os runs e as sessões JÁ ENCERRADAS do card custaram (o ledger). Nunca lança: leitura que falha conta 0. */
async function ledgerUSD(board: string, cardId: string): Promise<number> {
  const records = await getTelemetryStore()
    .listByCard(board, cardId)
    .catch(() => []);
  return records.reduce((acc, r) => acc + (r.costUSD ?? 0), 0);
}

/** O gasto do card AGORA: o ledger mais a estimativa das sessões de condutor vivas. */
async function spentUSD(board: string, cardId: string, sessions: readonly AgentSession[]): Promise<number> {
  let live = 0;
  for (const s of sessions) {
    if (s.board !== board || s.cardId !== cardId || s.driver !== "conductor") continue;
    live += (await readWorktreeSessionCost(s.worktreePath ?? s.cwd ?? null).catch(() => null))?.costUSD ?? 0;
  }
  return (await ledgerUSD(board, cardId)) + live;
}

/** O teto do settings e o gasto do card AGORA (ledger + sessões vivas) — o que a régua do ciclo extra lê
 *  (runner/extra-cycle.ts) para saber se o ciclo cabe no teto ou precisa pedir aumento. */
export async function cardSpendNow(board: string, cardId: string): Promise<{ capUSD: number | null; spentUSD: number }> {
  return { capUSD: capUSD(), spentUSD: await spentUSD(board, cardId, await allSessions().catch(() => [])) };
}

export type RequestBudgetResult =
  | { ok: false; error: string }
  | { ok: true; verdict: BudgetVerdict["kind"]; approved: boolean; capUSD: number | null; spentUSD: number; questionId?: string; detail?: string };

/**
 * O condutor pede um teto maior para o card (a tool `request_budget`). Dentro do envelope e com a cota no ritmo, o
 * sistema aprova na hora; senão o pedido vira uma pergunta de dinheiro aberta — que espera a cota (e é aprovada pela
 * varredura) ou espera o dono. Idempotente: com um pedido de teto ainda aberto, devolve o que já existe.
 */
export async function requestBudgetNow(input: { board: string; cardId: string; toUSD: number; reason: string }): Promise<RequestBudgetResult> {
  const { board, cardId } = input;
  const toUSD = Math.round(input.toUSD * 100) / 100;
  if (!Number.isFinite(toUSD) || !(toUSD > 0)) return { ok: false, error: "toUSD precisa ser um valor positivo em dólares" };
  if (!input.reason?.trim()) return { ok: false, error: "diga o que falta e quanto custa (reason)" };
  const card = await readCard(board, cardId).catch(() => null);
  if (!card) return { ok: false, error: `card não encontrado: ${cardId}` };
  const cap = capUSD();
  const settings = loadRunnerConfig().autorun.budgetRaise;
  const now = Date.now();
  const spent = await spentUSD(board, cardId, await allSessions().catch(() => []));
  const pending = openBudgetRequests(card)[0];
  if (pending) {
    return { ok: true, verdict: "owner", approved: false, capUSD: effectiveCardBudgetUSD(cap, card), spentUSD: spent, questionId: pending.questionId, detail: "já há um pedido de teto aberto neste card — espere a resposta dele" };
  }
  const verdict = judgeBudgetRequest({ capUSD: cap, card, toUSD, pace: quotaPace(quota(), now, settings), settings });
  if (verdict.kind === "no-cap") return { ok: true, verdict: verdict.kind, approved: true, capUSD: null, spentUSD: spent, detail: "este alvo não declara teto de gasto por card" };
  if (verdict.kind === "not-needed") return { ok: true, verdict: verdict.kind, approved: true, capUSD: verdict.capUSD, spentUSD: spent, detail: "o valor pedido já cabe no teto em vigor" };

  let questionId = "";
  const written = await updateCardOnDisk(board, cardId, (fresh) => {
    if (openBudgetRequests(fresh).length) return null; // outra chamada chegou antes
    questionId = nextQuestionId(fresh.questions ?? []);
    const q = budgetQuestion({ id: questionId, toUSD, capUSD: cap as number, spentUSD: spent, reason: input.reason, verdict, today: today() });
    return { ...fresh, questions: [...(fresh.questions ?? []), verdict.kind === "approved" ? approveAsSystem(q, verdict.why, today()) : q] };
  });
  if (!written || !questionId) return { ok: false, error: "não foi possível registrar o pedido no card (tente de novo)" };

  if (verdict.kind === "approved") {
    await appendSystemDecision(budgetRaiseDecision({ board, card, questionId, capUSD: cap as number, toUSD, why: verdict.why, at: new Date(now).toISOString() })).catch(() => {});
    console.log(`[card-budget] ${board}/${cardId}: teto US$ ${cap} → US$ ${toUSD} aprovado pelo sistema no pedido (${verdict.why})`);
    return { ok: true, verdict: verdict.kind, approved: true, capUSD: toUSD, spentUSD: spent, questionId, detail: verdict.why };
  }
  console.log(`[card-budget] ${board}/${cardId}: pedido de teto US$ ${cap} → US$ ${toUSD} ${verdict.kind === "wait-quota" ? "espera a cota voltar ao ritmo" : "é do dono"} (${verdict.why})`);
  return { ok: true, verdict: verdict.kind, approved: false, capUSD: effectiveCardBudgetUSD(cap, card), spentUSD: spent, questionId, detail: verdict.why };
}

/**
 * Por que este card NÃO pode receber um condutor agora — ou null. O que já foi gasto (o ledger: runs e sessões
 * encerradas) chegou ao teto em vigor. É a metade em CÓDIGO do teto para card conduzido (antes era só texto da skill).
 */
export async function conductorBudgetRefusal(board: string, card: Card): Promise<string | null> {
  const cap = effectiveCardBudgetUSD(capUSD(), card);
  if (cap == null) return null;
  const spent = await ledgerUSD(board, card.id);
  return spent >= cap ? `o card chegou ao teto de gasto (US$ ${spent.toFixed(2)} de US$ ${cap}) — só segue com um aumento aprovado` : null;
}

const WARNED_KEY = Symbol.for("agileharness.card-budget.warned");
const LAST_SWEEP_KEY = Symbol.for("agileharness.card-budget.lastSweep");
/** A varredura do tick da frota. No máximo a cada 5 min (ela lê os transcripts das sessões vivas). */
export const CARD_BUDGET_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;

export async function maybeSweepCardBudgets(now: number = Date.now()): Promise<unknown> {
  const store = globalThis as unknown as { [LAST_SWEEP_KEY]?: number; [WARNED_KEY]?: Map<string, number> };
  if (now - (store[LAST_SWEEP_KEY] ?? 0) < CARD_BUDGET_SWEEP_MIN_INTERVAL_MS) return null;
  store[LAST_SWEEP_KEY] = now;
  return sweepCardBudgets({
    masterEnabled: () => loadRunnerConfig().autorun.enabled,
    capUSD,
    settings: () => loadRunnerConfig().autorun.budgetRaise,
    quota,
    cards: async () => {
      const probe = await probeLiveTmuxSessions().catch(() => ({ ok: false as const, reason: "sonda falhou" }));
      const live = probe.ok ? new Set(probe.names) : null;
      const sessions = await allSessions().catch(() => [] as AgentSession[]);
      const out: BudgetSweepCard[] = [];
      for (const b of await listBoards()) {
        const config = await readBoardConfig(b.id).catch(() => null);
        if (!config || boardGateNow(b.id, config).held) continue;
        for (const card of await readCards(b.id).catch(() => [] as Card[])) {
          if (config.statuses.find((s) => s.id === card.status)?.terminal) continue;
          // sem a sonda não se sabe quem está vivo: ninguém é avisado (os pedidos abertos seguem sendo julgados)
          const session = live && isConducted(card) ? sessions.find((s) => s.board === b.id && s.cardId === card.id && !!s.tmuxSession && isLiveConductor(s, live, (x) => isSessionAlive(x, now))) : undefined;
          if (!session && !openBudgetRequests(card).length) continue;
          out.push({
            board: b.id,
            card,
            spentUSD: session ? await spentUSD(b.id, card.id, sessions) : await ledgerUSD(b.id, card.id),
            liveConductor: session?.tmuxSession ? { sessionId: session.sessionId, tmuxSession: session.tmuxSession } : null,
          });
        }
      }
      return out;
    },
    approve: async (board, cardId, questionId, why) => {
      let done = false;
      await updateCardOnDisk(board, cardId, (fresh) => {
        const q = fresh.questions?.find((x) => x.id === questionId);
        if (!q || q.status !== "open") return null; // alguém respondeu antes (o dono): a resposta dele vale
        done = true;
        return { ...fresh, questions: (fresh.questions ?? []).map((x) => (x.id === questionId ? approveAsSystem(x, why, today()) : x)) };
      });
      return done;
    },
    wake: async (board, cardId, questionId) => {
      const { wakeConductorNow } = await import("./conductor-pause-deps");
      await wakeConductorNow(board, cardId, [questionId], "system");
    },
    warn: async (tmux, line) => {
      if (!(await sessionRunsClaude(tmux))) return false;
      return (await deliverToSession(tmux, line, { submit: true })).ok;
    },
    record: appendSystemDecision,
    warned: (store[WARNED_KEY] ??= new Map()),
  });
}
