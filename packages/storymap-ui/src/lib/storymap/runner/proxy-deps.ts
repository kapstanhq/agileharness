// The ULTRA proxy dispatcher (runner/proxy.ts), wired to production. Resolved PER CALL like the conductor's deps:
// the master switch, the thresholds and the claude binary come from the LIVE settings, so a toggle needs no restart.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { applyProxyAnswers, markProxyDeclined, ownerOnlyOpenQuestions, proxySettings } from "@/lib/storymap/autonomy";
import { decideAdvance } from "@/lib/storymap/advance";
import { isConducted } from "@/lib/storymap/driver";
import { boardDocPath, runnerStateDir } from "@/lib/storymap/paths";
import { openQuestions } from "@/lib/storymap/questions";
import { listBoards, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { readStyleGuide, readWireframe } from "@/lib/storymap/sidecars";
import { styleGuideToPrompt } from "@/lib/storymap/style-guide";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { deliverToSession, sessionRunsClaude } from "@/lib/vps/tmux";
import type { BoardConfig, Card, CardQuestion } from "@/lib/storymap/types";
import { resolvedClaudeBin } from "./claude-bin";
import { loadRunnerConfig } from "./config";
import { isVpsOverloaded, probeVpsResources } from "./scheduler";
import { allSessions } from "./session-worktree";
import { getTelemetryStore } from "./telemetry";
import { blindQuestion, spawnProxy, type OwnerDecision, type ProxyRequest, type ProxyResult } from "./proxy-spawn";
import { proxyCard, sweepProxy, type ProxyDispatchDeps, type ProxyLedgerEntry, type ProxyLedgerStore, type ProxySweepReport } from "./proxy";

/** `storymap/.runner/proxy-ledger.json` — the per-question attempt counter (gitignored with the rest of .runner/). */
export function proxyLedgerPath(): string {
  return path.join(runnerStateDir(), "proxy-ledger.json");
}

/** Disk ledger — atomic temp+rename; unreadable reads as EMPTY (worst case: one more bounded attempt). */
export function diskProxyLedger(file: string = proxyLedgerPath()): ProxyLedgerStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { entries?: unknown };
        const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
        return list.filter(
          (e): e is ProxyLedgerEntry =>
            !!e && typeof e === "object" && typeof (e as ProxyLedgerEntry).key === "string" && typeof (e as ProxyLedgerEntry).attempts === "number",
        );
      } catch {
        return [];
      }
    },
    async persist(entries) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteFile(file, JSON.stringify({ v: 1, entries }, null, 2));
    },
  };
}

/** The OWNER's past answers on this board, most recent first — what the proxy imitates. The proxy's own answers
 *  never count (a proxy learning from itself would drift away from the owner). */
export function ownerDecisions(cards: readonly Card[]): OwnerDecision[] {
  const out: Array<OwnerDecision & { at: string }> = [];
  for (const c of cards) {
    for (const q of c.questions ?? []) {
      if (q.status !== "answered" || (q.answeredBy && q.answeredBy !== "human")) continue;
      if (q.answer?.startsWith("(sem resposta")) continue; // auto-resolved on a terminal — not a decision
      const picked = (q.selectedOptionIds ?? []).map((id) => q.options?.find((o) => o.id === id)?.label).filter(Boolean);
      const answer = [picked.join(" + "), q.answer].filter(Boolean).join(" — ");
      if (!answer) continue;
      out.push({ cardTitle: c.title, question: q.text, answer, at: q.answeredAt ?? "" });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).map(({ at: _at, ...d }) => d);
}

async function buildRequest(board: string, card: Card, config: BoardConfig, questions: CardQuestion[]): Promise<ProxyRequest> {
  const [prd, guide, cards, wireframes] = await Promise.all([
    fsp.readFile(boardDocPath(board, "prd"), "utf8").catch(() => null),
    readStyleGuide(board).catch(() => null),
    readCards(board).catch(() => [] as Card[]),
    questions.some((q) => q.category === "ui-choice") ? readWireframe(board, card.id).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    board,
    cardId: card.id,
    cardTitle: card.title,
    storyType: card.storyType,
    narrative: card.narrative
      ? { role: card.narrative.role ?? undefined, want: card.narrative.want ?? undefined, soThat: card.narrative.soThat ?? undefined }
      : null,
    acceptance: card.acceptance ?? [],
    body: card.body,
    prd,
    personas: config.personas.map((p) => ({ id: p.id, name: p.name, ...(p.role ? { role: p.role } : {}), ...(p.prompt ? { prompt: p.prompt } : {}) })),
    styleGuide: guide ? styleGuideToPrompt(guide) : null,
    history: ownerDecisions(cards),
    questions: questions.map(blindQuestion).filter((q): q is NonNullable<typeof q> => q !== null),
    // Screens only — the canvas's comparison NOTE carries the asker's recommendation and stays out (invariant 1).
    variants: (wireframes?.artifacts ?? [])
      .filter((a) => a.kind === "screen")
      .map((a) => ({ id: a.id, title: a.title, html: a.html ?? a.content })),
    model: proxySettings(config).model,
  };
}

/**
 * The writer: the proxy's answers over a FRESH read, under the card lock (applyProxyAnswers re-judges each one).
 * Then — only for a card NO conductor drives — the same Dúvidas resume `answerQuestionAction` performs when the
 * last question is answered: the grill step is a pause, and an answered pause resumes the cascade (gate-checked).
 */
async function applyAnswers(board: string, cardId: string, answers: Parameters<ProxyDispatchDeps["apply"]>[2], runId: string): Promise<string[]> {
  const config = await readBoardConfig(board);
  let applied: string[] = [];
  const card = await updateCardOnDisk(board, cardId, (fresh) => {
    const r = applyProxyAnswers(fresh, config, board, cardId, answers, { today: new Date().toISOString().slice(0, 10), runId });
    applied = r.applied;
    return r.applied.length ? { ...fresh, questions: r.questions } : null;
  });
  if (!card || !applied.length || isConducted(card)) return applied;
  const inGrill = config.statuses.find((s) => s.id === card.status)?.trigger === "harness-grill";
  if (inGrill && openQuestions(card).length === 0) {
    const decision = decideAdvance(card, config);
    if (decision.action === "advance") {
      const { moveCardAction } = await import("@/app/actions");
      await moveCardAction({ boardId: board, cardId, status: decision.to }).catch(() => {});
    }
  }
  return applied;
}

/** Hand questions back to the owner ON the card (`proxy.declined`) — see autonomy.ts `markProxyDeclined`. */
async function declineQuestions(board: string, cardId: string, items: Array<{ questionId: string; reason: string }>, runId: string): Promise<void> {
  await updateCardOnDisk(board, cardId, (fresh) => {
    const next = markProxyDeclined(fresh.questions ?? [], items, { runId });
    return next === (fresh.questions ?? []) ? null : { ...fresh, questions: next };
  });
}

/**
 * Tell the card's LIVE conductor that its questions were answered — the "continuar" the owner would type. The text
 * is a fixed template (ids from our own card, never caller text), delivered only to a session registered as THIS
 * card's conductor AND verified to be running the claude binary (never a shell) — the steward's
 * notifyActor reasoning (steward-deps.ts). Best-effort: a conductor that misses it resumes on the operator's word.
 */
async function resumeConductor(board: string, cardId: string, questionIds: string[]): Promise<void> {
  const session = (await allSessions()).find((s) => s.driver === "conductor" && s.board === board && s.cardId === cardId && s.tmuxSession);
  if (!session?.tmuxSession) return;
  // deliverToSession would type a single line into a SHELL too — so the claude-binary check is made here, first.
  if (!(await sessionRunsClaude(session.tmuxSession))) return;
  const fresh = (await readCards(board).catch(() => [] as Card[])).find((c) => c.id === cardId);
  const ownerLeft = fresh ? ownerOnlyOpenQuestions(fresh).length : 0;
  const text =
    `continuar — o PROXY (modo ultra) respondeu ${questionIds.join(", ")} neste card, com premissas registradas. ` +
    `Releia o card (get_card) antes de seguir.` +
    (ownerLeft ? ` Restam ${ownerLeft} pergunta(s) só do dono abertas: siga no que não depende delas.` : "");
  await deliverToSession(session.tmuxSession, text, { submit: true });
}

async function bookCost(board: string, cardId: string, result: ProxyResult, startedAt: number, model: string): Promise<void> {
  if (result.costUSD == null) return;
  await getTelemetryStore().recordRun({
    id: `proxy:${result.runId}`,
    board,
    cardId,
    trigger: "harness-proxy",
    startedAt,
    durationMs: Math.max(0, Date.now() - startedAt),
    turns: null,
    inputTokens: null,
    outputTokens: null,
    costUSD: result.costUSD,
    model,
    effort: null,
    // null on purpose (like a conductor session): a proxy is not a column step, never a run handoff.
    summary: null,
    toolsUsed: null,
    specialistsUsed: null,
    toolGap: null,
    role: "proxy",
    // `ok` whatever the proxy decided: an unanswered question is the owner's, not a stuck card.
    status: "ok",
  });
}

export function defaultProxyDeps(): ProxyDispatchDeps {
  return {
    ledger: diskProxyLedger(),
    listBoards: async () => (await listBoards()).map((b) => b.id),
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    readCards: (board) => readCards(board),
    masterEnabled: () => loadRunnerConfig().autorun.enabled,
    admission: () => {
      const t = loadRunnerConfig().autorun.scheduler?.thresholds;
      if (!t) return null;
      const r = probeVpsResources();
      return isVpsOverloaded(r, t) ? `RAM livre ${Math.round(r.freeRamMb)}MB / load ${r.loadAvg1.toFixed(2)}` : null;
    },
    buildRequest,
    spawn: async (req) => {
      let claudeBin: string;
      try {
        claudeBin = resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
      } catch (err) {
        return { runId: "none", error: `binário claude indisponível: ${err instanceof Error ? err.message : String(err)}` };
      }
      return spawnProxy(req, { claudeBin });
    },
    apply: applyAnswers,
    decline: declineQuestions,
    bookCost,
    resumeConductor,
  };
}

/** The fleet-tick sweep with production deps. */
export function sweepProxyNow(): Promise<ProxySweepReport> {
  return sweepProxy(defaultProxyDeps());
}

/** The sweep is the SAFETY NET (the ask-time nudge is the normal door) — so it walks the boards at most this often,
 *  not on every 60 s fleet tick. */
export const PROXY_SWEEP_MIN_INTERVAL_MS = 5 * 60_000;
const LAST_SWEEP_KEY = Symbol.for("agileharness.proxy.lastSweep");

/** The fleet tick's call: a sweep when the last one is older than {@link PROXY_SWEEP_MIN_INTERVAL_MS}, else nothing. */
export async function maybeSweepProxy(now: number = Date.now()): Promise<ProxySweepReport | null> {
  const store = globalThis as unknown as { [LAST_SWEEP_KEY]?: number };
  if (now - (store[LAST_SWEEP_KEY] ?? 0) < PROXY_SWEEP_MIN_INTERVAL_MS) return null;
  store[LAST_SWEEP_KEY] = now;
  return sweepProxyNow();
}

/** The ask-time nudge: one card, right after a question lands (fire-and-forget by the caller). */
export function nudgeProxy(board: string, cardId: string): Promise<unknown> {
  return proxyCard(defaultProxyDeps(), board, cardId);
}
