// 3.1 — PURE helpers to make a board's OPEN questions answerable INLINE in the copiloto chat, reusing the HITL
// OptionChips stack (no second write path — the actual answer goes through the SAME answerQuestionAction the
// /perguntas queue uses). Two id namespaces keep the chip clicks unambiguous:
//   - "q:<cardId>:<questionId>"  → a QUESTION chip (in the greeting): clicking it enters "answer mode".
//   - "a:<optionId>"             → an ANSWER-OPTION chip (the question's own suggested options).
// Node-unit-testable (no React/IO).

import type { CardQuestion, QuestionOption } from "@/lib/storymap/types";

export interface OpenQuestionRef {
  cardId: string;
  cardTitle: string;
  question: CardQuestion;
}

const QUESTION_CHIP_PREFIX = "q:";
const ANSWER_CHIP_PREFIX = "a:";

function truncate(s: string, n = 64): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** One clickable chip per open question, for the greeting turn. id encodes card + question so the click maps back. */
export function questionChipOptions(open: OpenQuestionRef[]): QuestionOption[] {
  return open.map((o) => ({
    id: `${QUESTION_CHIP_PREFIX}${o.cardId}:${o.question.id}`,
    label: `${o.cardId}: ${truncate(o.question.text)}`,
  }));
}

/** Parse a question-chip id back to its {cardId, questionId}, or null if it isn't one (guards the prefix). */
export function parseQuestionChipId(id: string): { cardId: string; questionId: string } | null {
  if (!id.startsWith(QUESTION_CHIP_PREFIX)) return null;
  const parts = id.split(":"); // "q", cardId, questionId — card ids + question ids carry no ":"
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return { cardId: parts[1], questionId: parts[2] };
}

/** The question's OWN suggested options as answer chips (ids re-namespaced "a:" so they never collide with the
 *  question chips). Returns null when the question is pure free-text (no discrete options). */
export function answerOptionsFor(question: CardQuestion): { options: QuestionOption[]; mode: "single" | "multi" } | null {
  if (!question.options?.length) return null;
  return {
    options: question.options.map((opt) => ({ ...opt, id: `${ANSWER_CHIP_PREFIX}${opt.id}` })),
    mode: question.mode ?? "single",
  };
}

/** Strip the "a:" namespace back to the real QuestionOption ids for answerQuestionAction. Non-answer ids drop. */
export function mapBackAnswerIds(ids: readonly string[]): string[] {
  return ids.filter((id) => id.startsWith(ANSWER_CHIP_PREFIX)).map((id) => id.slice(ANSWER_CHIP_PREFIX.length));
}
