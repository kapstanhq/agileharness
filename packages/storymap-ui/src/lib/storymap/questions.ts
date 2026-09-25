// HITL questions — PURE helpers over a card's `questions[]`. No IO, no React (node-unit-testable). The
// server actions (answerQuestionAction / askQuestionsAction), the /perguntas queue, and harness-grill all
// derive from these, so the ask/answer invariant lives in ONE place (mirrors reopen.ts / findings.ts).

import { isQuestionCategory } from "./types";
import type { Card, CardQuestion, QuestionCategory } from "./types";

/** The card's questions still awaiting a human answer. */
export function openQuestions(card: Pick<Card, "questions">): CardQuestion[] {
  return (card.questions ?? []).filter((q) => q.status === "open");
}

/** True when the card has ≥1 unanswered question (drives the card badge + the /perguntas queue). */
export function hasOpenQuestions(card: Pick<Card, "questions">): boolean {
  return openQuestions(card).length > 0;
}

/** Next free `q<N>` id given the existing questions (max numeric suffix + 1) — never reuses an id,
 * even one freed by an answered/removed question, so references stay stable. */
export function nextQuestionId(existing: CardQuestion[]): string {
  let max = 0;
  for (const q of existing) {
    const m = /^q(\d+)$/.exec(q.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `q${max + 1}`;
}

/**
 * APPEND new OPEN questions (one per text) authored by `askedBy` on `today`. Pure. Blank texts are
 * dropped, and a text already present VERBATIM as an open question is not duplicated (so a re-run of
 * harness-grill refreshes the queue without stacking duplicates). Existing questions are preserved.
 */
export function addQuestions(
  existing: CardQuestion[],
  texts: string[],
  askedBy: string,
  today: string,
): CardQuestion[] {
  const openTexts = new Set(existing.filter((q) => q.status === "open").map((q) => q.text.trim()));
  let next = existing.slice();
  for (const raw of texts) {
    const text = raw.trim();
    if (!text || openTexts.has(text)) continue;
    openTexts.add(text);
    next = [...next, { id: nextQuestionId(next), text, askedBy, askedAt: today, status: "open" }];
  }
  return next;
}

/**
 * ANSWER one question by id — flips it to `answered`, stamping the answer + `today`. Pure (new array).
 * Accepts either a free-text answer OR structured option selections (or both). No-op only when BOTH
 * answer is blank AND no options are selected (so an option-only response is valid without free text).
 */
export function answerQuestion(
  existing: CardQuestion[],
  questionId: string,
  answer: string,
  today: string,
  selectedOptionIds?: string[],
  answeredBy?: string,
): CardQuestion[] {
  const text = answer.trim();
  const hasOptions = (selectedOptionIds?.length ?? 0) > 0;
  if (!text && !hasOptions) return existing;
  return existing.map((q) =>
    q.id === questionId
      ? {
          ...q,
          status: "answered" as const,
          answer: text || undefined,
          answeredAt: today,
          ...(hasOptions ? { selectedOptionIds } : {}),
          // F6.3 — só carimba quando != human (default lean; "copilot" quando o agente apurou o fato).
          ...(answeredBy && answeredBy !== "human" ? { answeredBy } : {}),
        }
      : q,
  );
}

/**
 * Resolve every still-OPEN question as STALE — the card reached a TERMINAL column (done/archived)
 * without the human answering, so the question is moot and must not strand as "precisa de você" on a
 * shipped card (the orphan-questions bug: harness-grill asks, nothing closes them, the card advances past
 * them). Marks open → answered with a system note (preserves the forensic record of the ask);
 * already-answered questions are untouched. Pure + idempotent (no open question → returns input as-is).
 */
export function resolveStaleQuestions(existing: CardQuestion[], today: string): CardQuestion[] {
  if (!existing.some((q) => q.status === "open")) return existing;
  return existing.map((q) =>
    q.status === "open"
      ? { ...q, status: "answered" as const, answer: "(sem resposta — card concluído/arquivado)", answeredAt: today }
      : q,
  );
}

/** One STRUCTURED question an agent asks through `ask_question` — the shape `harness-grill`/`harness-review`
 *  write in the card file, now reachable over MCP (so a conductor mid-build asks it on main, at once). */
export interface StructuredQuestionInput {
  text: string;
  context?: string;
  options?: Array<{ label: string; pros?: string[]; cons?: string[]; recommended?: boolean }>;
  mode?: "single" | "multi";
  /** the agent's recommended answer in prose — for a question with NO discrete options. */
  recommendation?: string;
  /** WHAT KIND of decision this is — the autonomy key's primary signal (autonomy.ts). */
  category?: QuestionCategory;
}

/**
 * Why a structured question is malformed — or null. PURE. The rules are the ones the `/perguntas` queue renders
 * against: a non-empty text; options (when given) 2–8 with non-empty labels; at most ONE `recommended` (two
 * recommendations are no recommendation); `recommendation` prose only for a question WITHOUT options (with
 * options the recommendation is the flagged option — two channels for one opinion would disagree eventually).
 */
export function structuredQuestionError(q: StructuredQuestionInput): string | null {
  if (!q.text?.trim()) return "pergunta sem texto";
  const opts = q.options ?? [];
  if (opts.length === 1) return `"${q.text.slice(0, 60)}": uma opção só não é escolha — dê 2 ou mais, ou nenhuma (texto livre)`;
  if (opts.length > 8) return `"${q.text.slice(0, 60)}": ${opts.length} opções — no máximo 8`;
  if (opts.some((o) => !o.label?.trim())) return `"${q.text.slice(0, 60)}": opção sem rótulo`;
  if (opts.filter((o) => o.recommended).length > 1) return `"${q.text.slice(0, 60)}": mais de uma opção recomendada — marque no máximo UMA`;
  if (opts.length && q.recommendation?.trim()) {
    return `"${q.text.slice(0, 60)}": \`recommendation\` é para pergunta SEM opções — com opções, marque a recomendada com recommended:true`;
  }
  return null;
}

/**
 * APPEND structured OPEN questions (the same dedup rule as {@link addQuestions}: a text already open verbatim is
 * not duplicated). Option ids are `o1…oN` within each question. Pure; call {@link structuredQuestionError} first.
 */
export function addStructuredQuestions(
  existing: CardQuestion[],
  questions: StructuredQuestionInput[],
  askedBy: string,
  today: string,
): CardQuestion[] {
  const openTexts = new Set(existing.filter((q) => q.status === "open").map((q) => q.text.trim()));
  let next = existing.slice();
  for (const raw of questions) {
    const text = raw.text.trim();
    if (!text || openTexts.has(text)) continue;
    openTexts.add(text);
    const options = (raw.options ?? []).map((o, i) => ({
      id: `o${i + 1}`,
      label: o.label.trim(),
      ...(o.pros?.length ? { pros: o.pros.map((p) => p.trim()).filter(Boolean) } : {}),
      ...(o.cons?.length ? { cons: o.cons.map((c) => c.trim()).filter(Boolean) } : {}),
      ...(o.recommended ? { recommended: true } : {}),
    }));
    next = [
      ...next,
      {
        id: nextQuestionId(next),
        text,
        askedBy,
        askedAt: today,
        status: "open" as const,
        ...(options.length ? { options, mode: raw.mode ?? "single" } : {}),
        ...(raw.context?.trim() ? { context: raw.context.trim() } : {}),
        ...(!options.length && raw.recommendation?.trim() ? { recommendation: raw.recommendation.trim() } : {}),
        ...(isQuestionCategory(raw.category) ? { category: raw.category } : {}),
      },
    ];
  }
  return next;
}
