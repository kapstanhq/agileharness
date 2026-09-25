// The AUTONOMY KEY — human × ultra, per board, with a per-story exception. PURE (no IO, no React).
//
// The owner's table (plan v3, 2026-09-25):
//
//   decision point               human                          ultra
//   ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//   interview (user stories)     the owner answers              a PROXY answers (PRD, personas, past decisions),
//                                                               recording its premissas for audit
//   UI choice (2–3 variants)     the owner picks/comments       the proxy picks by rubric
//   delivery proof               notice after (autonomous       notice after, sample audit
//                                classes), else approve before
//   money (spend, vendor, price, the owner                      the owner — an owner-only queue; the rest of the
//   external publication, PRD)                                  board keeps moving
//
// This module answers the three questions every layer asks — the kanban tag, the MCP tools, the proxy dispatcher
// and its writer — from ONE place, so they cannot drift apart:
//   1. what mode is this story in? (`effectiveAutonomy` — the card's exception, else the board, else human);
//   2. may THIS question be answered by the proxy? (`isProxiableQuestion` — the asker's category first, and a
//      deterministic money FLOOR that can only ever make a question MORE human, never less);
//   3. does a proxy answer go on the owner's audit list? (`shouldAuditProxyAnswer` — a deterministic sample).
//
// "LLM does reasoning, code does plumbing": the proxy (runner/proxy.ts) decides WHAT to answer; this file only
// decides WHETHER it may, and it errs toward the owner every time.

import { hasOpenQuestions, openQuestions } from "./questions";
import { AUTONOMY_DEFAULT_AUDIT_SAMPLE_RATE } from "./types";
import type { AutonomyMode, BoardConfig, Card, CardQuestion, ModelTier, QuestionCategory } from "./types";

/** Where a story's mode came from — shown next to the tag so "why is this ultra?" has an answer. */
export type AutonomySource = "card" | "board" | "default";

export interface EffectiveAutonomy {
  mode: AutonomyMode;
  source: AutonomySource;
}

/** The mode a story runs in: its own exception, else the board's key, else `human`. PURE. */
export function effectiveAutonomy(
  card: Pick<Card, "autonomyMode"> | null | undefined,
  config: Pick<BoardConfig, "autonomy"> | null | undefined,
): EffectiveAutonomy {
  if (card?.autonomyMode) return { mode: card.autonomyMode, source: "card" };
  if (config?.autonomy?.mode) return { mode: config.autonomy.mode, source: "board" };
  return { mode: "human", source: "default" };
}

/** The proxy's tier when the board names none: a bounded judgement over a prepared context, not authoring. */
export const PROXY_DEFAULT_MODEL: ModelTier = "sonnet";

/** The board's proxy settings with the defaults applied. PURE. */
export function proxySettings(config: Pick<BoardConfig, "autonomy"> | null | undefined): { model: ModelTier; auditSampleRate: number } {
  const a = config?.autonomy;
  const rate = a?.auditSampleRate;
  return {
    model: a?.proxyModel ?? PROXY_DEFAULT_MODEL,
    auditSampleRate: typeof rate === "number" && Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : AUTONOMY_DEFAULT_AUDIT_SAMPLE_RATE,
  };
}

/** The categories a proxy may answer in ultra mode. `delivery` is the conductor's hand-off (notice after), and
 *  `money` is the owner's in every mode; an UNCATEGORIZED question is the owner's too. */
export const PROXIABLE_CATEGORIES: readonly QuestionCategory[] = ["interview", "ui-choice"];

/** The `[humano]` marker the conductor skill prefixes to an always-human question's context (or text). */
const OWNER_ONLY_MARKER = /^\s*\[humano\]/i;

/**
 * The money FLOOR — deliberately small and literal: price, vendor and spend words (pt/en). It only ever turns a
 * proxiable question into the owner's; it never makes one proxiable. A false positive costs the owner one
 * answer; a false negative would let a proxy commit money — so the list leans wide on exactly these words and
 * stops there (anything subtler is the asker's job: category `money`).
 */
const MONEY_TERMS =
  /\b(pre[çc]os?|pricing|prices?|fornecedor(es)?|vendors?|gastos?|spend(ing)?|or[çc]amentos?|budgets?|assinaturas?|subscriptions?|plano pago|paid plan|cobran[çc]as?|billing|custo mensal|monthly cost)\b/i;

/**
 * Is this question the OWNER's in every mode? PURE. The asker's `money` category is the primary signal; the floor
 * adds the `[humano]` marker and the money words in the text/context.
 */
export function isOwnerOnlyQuestion(q: Pick<CardQuestion, "category" | "text" | "context">): boolean {
  if (q.category === "money") return true;
  const text = `${q.text ?? ""}\n${q.context ?? ""}`;
  if (OWNER_ONLY_MARKER.test(q.text ?? "") || OWNER_ONLY_MARKER.test(q.context ?? "")) return true;
  return MONEY_TERMS.test(text);
}

/**
 * The CONSERVATIVE default category — only for the writer that genuinely cannot know: a PLAIN free-text question
 * (`ask_question` `texts`, a follow-up typed with no structure). Every other writer declares the category itself
 * (the grill/review/conductor skills, the structured `ask_question`, the steward). This can only ever point a
 * question at the OWNER: `money` when the owner-only floor matches (money words, the `[humano]` marker), and
 * NOTHING otherwise — an uncategorized question is the owner's ({@link proxyRefusal}), and guessing `interview`
 * from prose would hand a decision to the proxy on a hunch. It never returns a proxiable category. PURE.
 */
export function defaultQuestionCategory(q: Pick<CardQuestion, "text" | "context">): QuestionCategory | undefined {
  return isOwnerOnlyQuestion({ text: q.text, context: q.context }) ? "money" : undefined;
}

/** Why a question is not the proxy's — or null when it is. PURE (the dispatcher logs it; tests pin it). */
export function proxyRefusal(
  q: Pick<CardQuestion, "status" | "category" | "text" | "context" | "proxy">,
  card: Pick<Card, "autonomyMode">,
  config: Pick<BoardConfig, "autonomy">,
): string | null {
  if (q.status !== "open") return "pergunta já respondida";
  if (effectiveAutonomy(card, config).mode !== "ultra") return "story em modo human";
  // The owner REOPENED a proxy answer on audit: that question is theirs now, for good — re-proxying it would
  // overrule the very human the audit exists for.
  if (q.proxy?.auditOutcome === "reopened") return "o dono reabriu a resposta do proxy — agora é dele";
  // The proxy already handed it back (declined, or failed on it past the cap): it is the owner's for good.
  if (q.proxy?.declined) return "o proxy devolveu esta pergunta ao dono";
  if (isOwnerOnlyQuestion(q)) return "decisão de dinheiro/só do dono — nunca vai ao proxy";
  if (!q.category) return "pergunta sem categoria — é do dono (o proxy só responde interview/ui-choice)";
  if (!PROXIABLE_CATEGORIES.includes(q.category)) return `categoria '${q.category}' não é do proxy`;
  return null;
}

/** May the proxy answer this question now? PURE. */
export function isProxiableQuestion(
  q: Pick<CardQuestion, "status" | "category" | "text" | "context" | "proxy">,
  card: Pick<Card, "autonomyMode">,
  config: Pick<BoardConfig, "autonomy">,
): boolean {
  return proxyRefusal(q, card, config) === null;
}

/** The card's open questions the proxy may answer (empty when the story is human or none qualify). PURE. */
export function proxiableQuestions(card: Pick<Card, "autonomyMode" | "questions">, config: Pick<BoardConfig, "autonomy">): CardQuestion[] {
  if (!hasOpenQuestions(card)) return [];
  if (effectiveAutonomy(card, config).mode !== "ultra") return [];
  return openQuestions(card).filter((q) => isProxiableQuestion(q, card, config));
}

/** The card's open questions only the owner may answer (money / uncategorized / marked) — the owner-only queue. */
export function ownerOnlyOpenQuestions(card: Pick<Card, "questions">): CardQuestion[] {
  return openQuestions(card).filter((q) => isOwnerOnlyQuestion(q));
}

/** Below this confidence a proxy answer ALWAYS goes on the audit list, sampled or not. */
export const PROXY_LOW_CONFIDENCE = 0.5;

/**
 * A deterministic [0, 1) draw for `key` (FNV-1a) — the same answer every time for the same question, so the sample
 * is reproducible (a test pins it; an audit can re-derive why an answer was or was not sampled). PURE.
 */
export function auditDraw(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/** Does this proxy answer go on the owner's audit list? A low-confidence answer always; the rest by the sample. */
export function shouldAuditProxyAnswer(key: string, confidence: number, sampleRate: number): boolean {
  if (!(confidence >= PROXY_LOW_CONFIDENCE)) return true;
  return auditDraw(key) < sampleRate;
}

/** The stable key a proxy answer is sampled and ledgered by. */
export function proxyAnswerKey(board: string, cardId: string, questionId: string): string {
  return `${board}/${cardId}/${questionId}`;
}

/** A proxy answer still waiting for the owner's audit. */
export function isPendingProxyAudit(q: Pick<CardQuestion, "answeredBy" | "proxy">): boolean {
  return q.answeredBy === "proxy" && q.proxy?.audit === true && !q.proxy.auditedAt;
}

/** One answer the proxy returned, already validated against its question (runner/proxy.ts). */
export interface ProxyAnswerInput {
  questionId: string;
  answer: string;
  selectedOptionIds?: string[];
  assumptions: string;
  confidence: number;
}

/**
 * APPLY proxy answers to a card's questions — the writer's pure half (it runs under the card lock over a FRESH
 * read). Each answer lands only if its question is STILL open and STILL proxiable on this fresh card: the owner
 * may have answered it meanwhile, turned the story `human`, or the asker may have re-categorized it. Stamps
 * `answeredBy: "proxy"` and the audit record. Returns the new list and which ids landed (the same array when
 * none did — the caller skips the write). PURE.
 */
export function applyProxyAnswers(
  card: Pick<Card, "autonomyMode" | "questions">,
  config: Pick<BoardConfig, "autonomy">,
  board: string,
  cardId: string,
  answers: readonly ProxyAnswerInput[],
  opts: { today: string; runId?: string },
): { questions: CardQuestion[]; applied: string[] } {
  const existing = card.questions ?? [];
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const { auditSampleRate } = proxySettings(config);
  const applied: string[] = [];
  const next = existing.map((q) => {
    const a = byId.get(q.id);
    if (!a || !isProxiableQuestion(q, card, config)) return q;
    const optionIds = (a.selectedOptionIds ?? []).filter((id) => q.options?.some((o) => o.id === id));
    const text = a.answer.trim();
    if (!text && !optionIds.length) return q;
    applied.push(q.id);
    const audit = shouldAuditProxyAnswer(proxyAnswerKey(board, cardId, q.id), a.confidence, auditSampleRate);
    return {
      ...q,
      status: "answered" as const,
      answer: text || undefined,
      answeredAt: opts.today,
      answeredBy: "proxy",
      ...(optionIds.length ? { selectedOptionIds: optionIds } : {}),
      proxy: {
        assumptions: a.assumptions.trim(),
        confidence: a.confidence,
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(audit ? { audit: true } : {}),
      },
    };
  });
  return { questions: applied.length ? next : existing, applied };
}

/**
 * The proxy HANDS BACK questions to the owner — it declined them, or it failed on them past its attempt cap. The
 * hand-back is written ON the question (`proxy.declined`, with the reason as the record's text and confidence 0),
 * so every pure reader — the Inbox, the lane view, the dispatcher — sees at once that the owner must answer it,
 * with no ledger to consult. Only still-OPEN questions change. Returns the same array when nothing did. PURE.
 */
export function markProxyDeclined(
  existing: CardQuestion[],
  items: ReadonlyArray<{ questionId: string; reason: string }>,
  opts: { runId?: string } = {},
): CardQuestion[] {
  const byId = new Map(items.map((i) => [i.questionId, i.reason]));
  let changed = false;
  const next = existing.map((q) => {
    const reason = byId.get(q.id);
    if (reason === undefined || q.status !== "open" || q.proxy?.declined) return q;
    changed = true;
    return {
      ...q,
      proxy: {
        assumptions: reason.trim() || "o proxy não respondeu",
        confidence: 0,
        declined: true,
        ...(opts.runId ? { runId: opts.runId } : {}),
      },
    };
  });
  return changed ? next : existing;
}

/**
 * The owner closes an audit item: `confirmed` keeps the proxy's answer; `reopened` sends the question BACK to the
 * owner (open again, the proxy's answer kept in the record as history, so the next reader sees what was assumed).
 * Only a pending proxy audit changes; anything else returns the same array. PURE.
 */
export function resolveProxyAudit(
  existing: CardQuestion[],
  questionId: string,
  outcome: "confirmed" | "reopened",
  today: string,
): CardQuestion[] {
  const q = existing.find((x) => x.id === questionId);
  if (!q || !isPendingProxyAudit(q)) return existing;
  return existing.map((x) => {
    if (x.id !== questionId || !x.proxy) return x;
    const proxy = { ...x.proxy, auditedAt: today, auditOutcome: outcome };
    if (outcome === "confirmed") return { ...x, proxy };
    const note = `[resposta do proxy reaberta pelo dono em ${today}] ${x.answer ?? ""}`.trim();
    const { answer: _a, answeredAt: _t, answeredBy: _b, selectedOptionIds: _s, ...rest } = x;
    return {
      ...rest,
      status: "open" as const,
      // The owner must see what the proxy assumed before answering: the answer moves into the context, never lost.
      context: [x.context, note, `Premissas do proxy: ${x.proxy.assumptions}`].filter(Boolean).join("\n"),
      proxy,
    };
  });
}
