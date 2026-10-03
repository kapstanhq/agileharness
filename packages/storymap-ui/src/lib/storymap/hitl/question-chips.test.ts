import { describe, expect, it } from "vitest";
import {
  questionChipOptions,
  parseQuestionChipId,
  answerOptionsFor,
  mapBackAnswerIds,
  type OpenQuestionRef,
} from "./question-chips";
import type { CardQuestion } from "@/lib/storymap/types";

const q = (over: Partial<CardQuestion> = {}): CardQuestion => ({ id: "q1", text: "Qual o público?", status: "open", ...over });

describe("question-chips (3.1) — perguntas abertas do board viram chips inline no chat", () => {
  it("questionChipOptions: 1 chip/pergunta, id q:<card>:<qid>, label com card + texto truncado", () => {
    const open: OpenQuestionRef[] = [{ cardId: "story-a", cardTitle: "T", question: q({ id: "q2", text: "Texto curto" }) }];
    const chips = questionChipOptions(open);
    expect(chips).toHaveLength(1);
    expect(chips[0].id).toBe("q:story-a:q2");
    expect(chips[0].label).toContain("story-a");
    expect(chips[0].label).toContain("Texto curto");
  });

  it("parseQuestionChipId: round-trip; rejeita ids que não são de pergunta ou incompletos", () => {
    expect(parseQuestionChipId("q:story-a:q2")).toEqual({ cardId: "story-a", questionId: "q2" });
    expect(parseQuestionChipId("a:opt1")).toBeNull(); // é chip de resposta, não de pergunta
    expect(parseQuestionChipId("q:incompleto")).toBeNull();
    expect(parseQuestionChipId("qualquer")).toBeNull();
  });

  it("answerOptionsFor: mapeia as opções da pergunta com ids a:<opt> preservando label; null p/ free-text", () => {
    const withOpts = q({ options: [{ id: "o1", label: "Público A" }, { id: "o2", label: "Público B" }], mode: "single" });
    const mapped = answerOptionsFor(withOpts);
    expect(mapped?.mode).toBe("single");
    expect(mapped?.options.map((o) => o.id)).toEqual(["a:o1", "a:o2"]);
    expect(mapped?.options[0].label).toBe("Público A"); // label preservado
    expect(answerOptionsFor(q())).toBeNull(); // sem options → pergunta free-text
  });

  it("mapBackAnswerIds: remove o prefixo a: e ignora ids que não são de resposta (round-trip vs answerQuestion)", () => {
    expect(mapBackAnswerIds(["a:o1", "a:o2", "q:x:y"])).toEqual(["o1", "o2"]);
    expect(mapBackAnswerIds([])).toEqual([]);
  });
});
