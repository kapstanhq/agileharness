// HITL questions — PURE helpers over a card's `questions[]`. No IO, no React (node-unit-testable). The
// server actions (answerQuestionAction / askQuestionsAction), the /perguntas queue, and harness-grill all
// derive from these, so the ask/answer invariant lives in ONE place (mirrors reopen.ts / findings.ts).

import type { Card, CardQuestion } from "./types";

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
