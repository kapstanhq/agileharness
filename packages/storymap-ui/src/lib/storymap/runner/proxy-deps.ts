// The ULTRA proxy dispatcher (runner/proxy.ts), wired to production. Resolved PER CALL like the conductor's deps:
// the master switch, the thresholds and the claude binary come from the LIVE settings, so a toggle needs no restart.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { applyProxyAnswers, effectiveQuestionCategory, markProxyDeclined, ownerOnlyOpenQuestions, proxySettings } from "@/lib/storymap/autonomy";
import { ownerClassesOf } from "@/lib/storymap/owner-classes";
import {
  applyQuestionClassification,
  buildQuestionClassifierPrompt,
  parseQuestionClassification,
  type QuestionClassificationResult,
} from "@/lib/storymap/question-classifier";
import { runClaudeJson } from "@/lib/storymap/smart-capture/claude";
import { proxyAnswerEntries } from "@/lib/storymap/system-decisions";
import { appendSystemDecision, newSystemDecisionId } from "./decision-log";
import { decideAdvance } from "@/lib/storymap/advance";
import { isConducted } from "@/lib/storymap/driver";
import { runnerStateDir } from "@/lib/storymap/paths";
import { boardPersonas, readPrdWithContext } from "@/lib/storymap/board-strategy";
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
import { getCapacityGovernor } from "./capacity-service";
import type { GateVerdict } from "./capacity-governor";
import { allSessions } from "./session-worktree";
import { getTelemetryStore } from "./telemetry";
import { blindQuestion, spawnProxy, type OwnerDecision, type ProxyRequest, type ProxyResult } from "./proxy-spawn";
import { proxyCard, sweepProxy, type ProxyDispatchDeps, type ProxyLedgerEntry, type ProxyLedgerStore, type ProxySweepReport } from "./proxy";
import { boardGateNow } from "./board-pace-store";

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

/** As palavras que contam para a relevância (minúsculas, sem acento, 4+ letras). PURA. */
function relevanceWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
}

/**
 * The OWNER's past answers on this board — what the proxy imitates. The proxy's own answers never count (a proxy
 * learning from itself would drift away from the owner). Fase 6 — a ORDEM: primeiro as CORREÇÕES do dono (perguntas em
 * que ele reabriu a resposta do procurador e respondeu ele mesmo), depois as mais PARECIDAS com `query` (as palavras em
 * comum com a pergunta de agora), e só então as mais recentes. Sem `query`, correções e depois recência. PURA.
 */
export function ownerDecisions(cards: readonly Card[], query?: string): OwnerDecision[] {
  const out: Array<OwnerDecision & { at: string; score: number }> = [];
  const wanted = query ? relevanceWords(query) : null;
  for (const c of cards) {
    for (const q of c.questions ?? []) {
      if (q.status !== "answered" || (q.answeredBy && q.answeredBy !== "human")) continue;
      if (q.answer?.startsWith("(sem resposta")) continue; // auto-resolved on a terminal — not a decision
      const picked = (q.selectedOptionIds ?? []).map((id) => q.options?.find((o) => o.id === id)?.label).filter(Boolean);
      const answer = [picked.join(" + "), q.answer].filter(Boolean).join(" — ");
      if (!answer) continue;
      let score = 0;
      if (wanted) for (const w of relevanceWords(`${c.title} ${q.text}`)) if (wanted.has(w)) score++;
      const correction = q.proxy?.auditOutcome === "reopened";
      out.push({ cardTitle: c.title, question: q.text, answer, at: q.answeredAt ?? "", score, ...(correction ? { correction: true as const } : {}) });
    }
  }
  return out
    .sort((a, b) => Number(!!b.correction) - Number(!!a.correction) || b.score - a.score || b.at.localeCompare(a.at))
    .map(({ at: _at, score: _score, ...d }) => d);
}

async function buildRequest(board: string, card: Card, config: BoardConfig, questions: CardQuestion[]): Promise<ProxyRequest> {
  const [prd, personas, guide, cards, wireframes, pack] = await Promise.all([
    // o PRD + o contexto dos agentes (decisões já tomadas, restrições…) — a trava das decisões do dono lê os dois
    readPrdWithContext(board).catch(() => null),
    // as personas da seção «Personas» do PRD, com o `board.yaml` como piso legado
    boardPersonas(board, config).catch(() => config.personas),
    readStyleGuide(board).catch(() => null),
    readCards(board).catch(() => [] as Card[]),
    questions.some((q) => effectiveQuestionCategory(q) === "ui-choice") ? readWireframe(board, card.id).catch(() => null) : Promise.resolve(null),
    // fase 6 — o PACOTE DE CONTEXTO do card (context-pack.ts, sem IA): o PRD POR SEÇÃO, sempre com o «Fora do escopo»,
    // as classes do dono e as correções dele no topo — no lugar do PRD inteiro cortado em 12 mil caracteres, que chegava
    // sem as seções do fim (restrições, riscos, «pronto quando»)
    import("@/lib/storymap/context-pack").then((m) => m.loadContextPack(board, card.id)).catch(() => null),
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
    ...(card.techPreference ? { techPreference: card.techPreference } : {}),
    prd,
    personas: personas.map((p) => ({ id: p.id, name: p.name, ...(p.role ? { role: p.role } : {}), ...(p.prompt ? { prompt: p.prompt } : {}) })),
    styleGuide: guide ? styleGuideToPrompt(guide) : null,
    history: ownerDecisions(cards, [card.title, ...questions.map((q) => q.text)].join(" ")),
    ...(pack?.text ? { contextPack: pack.text } : {}),
    // as classes do dono DESTE board: o proxy que recusa por ser decisão dele diz qual (o Inbox mostra a classe)
    ownerClasses: ownerClassesOf(config).map((c) => ({ id: c.id, label: c.label, ...(c.description ? { description: c.description } : {}) })),
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
  // o registro do que o proxy decidiu em nome do dono — uma entrada por resposta, com o «Desfazer» (reabrir para ele);
  // a escolha de tela guarda as alternativas.
  if (card && applied.length) {
    const at = new Date().toISOString();
    for (const e of proxyAnswerEntries(board, card, applied, { at, idOf: () => newSystemDecisionId() })) await appendSystemDecision(e);
  }
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
async function declineQuestions(board: string, cardId: string, items: Array<{ questionId: string; reason: string; ownerClass?: string }>, runId: string): Promise<void> {
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
  // O MESMO acordar da resposta do dono (conductor-pause.ts): com condutor vivo a linha é digitada; com o card
  // ESTACIONADO e nada mais aberto, ele volta para a frente da fila. Import dinâmico: as deps puxam fleet-deps,
  // que importa este módulo.
  const { wakeConductorNow } = await import("./conductor-pause-deps");
  await wakeConductorNow(board, cardId, questionIds, "proxy");
}

/**
 * O teto de custo de UMA chamada do classificador — é uma classificação de poucas linhas. 0,50 desde que o
 * modelo é sonnet (era haiku com 0,25): o preço por token dobrou e o piso de contexto do CLI não encolheu.
 */
export const CLASSIFIER_BUDGET_USD = 0.5;
const CLASSIFIER_TIMEOUT_MS = 90_000;

/**
 * SÓ-NEGÓCIO — classifica as perguntas sem categoria numa chamada BARATA (sonnet, esforço medium, teto de custo,
 * sem ferramentas: `runClaudeJson` roda em `--permission-mode plan` e sem MCP). O modelo julga; a validação e a
 * escrita são código (question-classifier.ts). Nunca lança — qualquer falha é `{ error }` e nada é aplicado.
 */
async function classifyWithModel(
  board: string,
  card: Card,
  config: BoardConfig,
  questions: CardQuestion[],
): Promise<{ results: QuestionClassificationResult[] } | { error: string }> {
  const classes = ownerClassesOf(config);
  const prompt = buildQuestionClassifierPrompt({
    boardName: config.name,
    ownerClasses: classes,
    card: { id: card.id, title: card.title, storyType: card.storyType },
    questions: questions.map((q) => ({
      id: q.id,
      text: q.text,
      ...(q.context ? { context: q.context } : {}),
      ...(q.options?.length ? { options: q.options.map((o) => o.label) } : {}),
    })),
  });
  try {
    const raw = await runClaudeJson(prompt, {
      // Sonnet em esforço medium, não low: esta é a TRAVA das decisões do dono (dinheiro, marca, PRD, dados de
      // pessoas) — um falso negativo deixa o proxy responder sozinho. Em low o Sonnet 5.5 pula o raciocínio.
      model: "sonnet",
      effort: "medium",
      maxBudgetUSD: CLASSIFIER_BUDGET_USD,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
      context: { label: "Classificar perguntas", board, cardId: card.id },
    });
    const parsed = parseQuestionClassification(raw, questions.map((q) => q.id), classes.map((c) => c.id));
    return "error" in parsed ? parsed : { results: parsed.results };
  } catch (err) {
    return { error: `classificador falhou: ${String(err instanceof Error ? err.message : err).slice(0, 200)}` };
  }
}

/** Grava os vereditos pelo escritor único (sob o lock, sobre o card FRESCO) — os ids que aterrissaram. */
async function applyClassification(board: string, cardId: string, results: QuestionClassificationResult[]): Promise<string[]> {
  let landed: string[] = [];
  await updateCardOnDisk(board, cardId, (fresh) => {
    const before = fresh.questions ?? [];
    const next = applyQuestionClassification(before, results, { by: "classifier", at: new Date().toISOString().slice(0, 10) });
    landed = next.filter((q, i) => q !== before[i]).map((q) => q.id);
    return next === before ? null : { ...fresh, questions: next };
  });
  return landed;
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

/**
 * A admissão do proxy, na ordem: a JANELA DA CONTA (o governador de capacidade — o proxy é AUTOMAÇÃO: ninguém
 * está no teclado quando ele dispara) e depois a CAIXA (RAM/load). Retido ⇒ o motivo, e o dispatcher espera
 * (a próxima varredura re-pergunta); nunca descarta a pergunta. PURA.
 */
export function proxyAdmissionReason(account: GateVerdict, boxRefusal: string | null): string | null {
  if (!account.admit) return `janela da conta: ${account.detail}`;
  return boxRefusal;
}

/** A admissão de uma AUTOMAÇÃO de decisão (o proxy, o juiz da triagem): a janela da conta, depois a caixa. */
export function automationAdmission(): string | null {
  const t = loadRunnerConfig().autorun.scheduler?.thresholds;
  const r = t ? probeVpsResources() : null;
  const box = t && r && isVpsOverloaded(r, t) ? `RAM livre ${Math.round(r.freeRamMb)}MB / load ${r.loadAvg1.toFixed(2)}` : null;
  return proxyAdmissionReason(getCapacityGovernor().admission("automation"), box);
}

export function defaultProxyDeps(): ProxyDispatchDeps {
  return {
    ledger: diskProxyLedger(),
    listBoards: async () => (await listBoards()).map((b) => b.id),
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    readCards: (board) => readCards(board),
    masterEnabled: () => loadRunnerConfig().autorun.enabled,
    boardGate: boardGateNow,
    admission: automationAdmission,
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
    classify: classifyWithModel,
    applyClassification,
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
