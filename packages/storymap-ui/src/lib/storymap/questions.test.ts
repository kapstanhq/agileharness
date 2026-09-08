import { describe, expect, it } from "vitest";
import { addQuestions, answerQuestion, hasOpenQuestions, nextQuestionId, openQuestions } from "./questions";
import type { CardQuestion } from "./types";

const q = (id: string, text: string, status: CardQuestion["status"] = "open"): CardQuestion => ({ id, text, status });

describe("openQuestions / hasOpenQuestions", () => {
  it("returns only the unanswered questions", () => {
    const qs = [q("q1", "a"), q("q2", "b", "answered"), q("q3", "c")];
    expect(openQuestions({ questions: qs }).map((x) => x.id)).toEqual(["q1", "q3"]);
    expect(hasOpenQuestions({ questions: qs })).toBe(true);
  });
  it("is false/empty when there are none or all answered", () => {
    expect(hasOpenQuestions({ questions: undefined })).toBe(false);
    expect(hasOpenQuestions({ questions: [q("q1", "a", "answered")] })).toBe(false);
    expect(openQuestions({ questions: undefined })).toEqual([]);
  });
});

describe("nextQuestionId", () => {
  it("is max numeric suffix + 1; never reuses (counts answered too)", () => {
    expect(nextQuestionId([])).toBe("q1");
    expect(nextQuestionId([q("q1", "a"), q("q2", "b", "answered")])).toBe("q3");
    // a gap (q1 removed) does not get reused
    expect(nextQuestionId([q("q3", "c")])).toBe("q4");
    // non-q ids are ignored
    expect(nextQuestionId([q("custom", "c")])).toBe("q1");
  });
});

describe("addQuestions", () => {
  it("appends one OPEN question per text with author + date and incrementing ids", () => {
    const out = addQuestions([], ["Quem é o usuário?", "Qual a métrica de sucesso?"], "harness-grill", "2026-06-11");
    expect(out).toEqual([
      { id: "q1", text: "Quem é o usuário?", askedBy: "harness-grill", askedAt: "2026-06-11", status: "open" },
      { id: "q2", text: "Qual a métrica de sucesso?", askedBy: "harness-grill", askedAt: "2026-06-11", status: "open" },
    ]);
  });
  it("drops blanks and does not duplicate a text already OPEN (re-run refresh)", () => {
    const existing = [q("q1", "Quem é o usuário?")];
    const out = addQuestions(existing, ["  ", "Quem é o usuário?", "Nova pergunta"], "harness-grill", "2026-06-11");
    expect(out.map((x) => x.text)).toEqual(["Quem é o usuário?", "Nova pergunta"]);
    expect(out[1].id).toBe("q2");
  });
  it("preserves answered questions and can re-ask a text that was already ANSWERED", () => {
    const existing = [q("q1", "Quem é o usuário?", "answered")];
    const out = addQuestions(existing, ["Quem é o usuário?"], "operator", "2026-06-11");
    expect(out).toHaveLength(2); // the answered one is not an OPEN dup → re-asked as q2
    expect(out[1]).toMatchObject({ id: "q2", text: "Quem é o usuário?", status: "open" });
  });
});

describe("answerQuestion", () => {
  it("flips the matching question to answered, stamping answer + date", () => {
    const out = answerQuestion([q("q1", "a"), q("q2", "b")], "q2", "  porque sim  ", "2026-06-11");
    expect(out[0]).toEqual({ id: "q1", text: "a", status: "open" });
    expect(out[1]).toEqual({ id: "q2", text: "b", status: "answered", answer: "porque sim", answeredAt: "2026-06-11" });
  });
  it("is a no-op for a blank answer or an unknown id", () => {
    const existing = [q("q1", "a")];
    expect(answerQuestion(existing, "q1", "   ", "2026-06-11")).toBe(existing);
    expect(answerQuestion(existing, "nope", "x", "2026-06-11")).toEqual(existing);
  });
  it("F6.3 — stamps answeredBy ONLY when != human (default lean: human omits the field)", () => {
    const base = [q("q1", "a")];
    // human (default / explicit) → no answeredBy on the card (stays lean)
    expect(answerQuestion(base, "q1", "resposta", "2026-06-11")[0]).not.toHaveProperty("answeredBy");
    expect(answerQuestion(base, "q1", "resposta", "2026-06-11", undefined, "human")[0]).not.toHaveProperty("answeredBy");
    // copilot (the agent apurou o fato) → stamped
    const byCopilot = answerQuestion(base, "q1", "resposta", "2026-06-11", undefined, "copilot")[0];
    expect(byCopilot).toMatchObject({ status: "answered", answer: "resposta", answeredBy: "copilot" });
  });
});
