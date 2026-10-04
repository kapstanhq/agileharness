// O teto de rodadas de revisão: a cadeia de consertos de uma revisão é uma ÁRVORE marcada pelo servidor (a raiz e todo
// card com a marca dela, em qualquer board), e no teto o sistema pergunta ao dono em vez de abrir mais um card.
// Fixtures inventadas (uma oficina de bicicletas).

import { describe, expect, it } from "vitest";
import {
  EXTRA_ROUND_LABEL,
  REVIEW_ROUND_LABEL,
  ROUNDS_CAP_OPTIONS,
  ROUNDS_CAP_QUESTION_PREFIX,
  TECHNICAL_AUDIT_LABEL,
  chainRootOf,
  chainTree,
  cycleOf,
  hasOpenReviewFindings,
  hasOpenRoundsCapQuestion,
  isStopAnswer,
  reviewRoundVerdict,
  roundsCapQuestion,
  roundChoiceOf,
  roundsCapQuestionInput,
  type BoardCard,
  type RoundAnswer,
} from "./review-rounds";
import type { CardQuestion, Finding, ReviewChainMark } from "@/lib/storymap/types";

const ORIGIN = "oficina/story-ex7101";
const bc = (board: string, id: string, over: Partial<BoardCard["card"]> = {}): BoardCard => ({ board, card: { id, labels: [], links: [], ...over } });
const origin = bc("oficina", "story-ex7101");
const marked = (board: string, id: string, round: number, extra = false): BoardCard =>
  bc(board, id, { labels: [REVIEW_ROUND_LABEL], reviewChain: { root: ORIGIN, round, ...(extra ? { extra: true } : {}) } as ReviewChainMark });
const legacy = (id: string, from: string, labels: string[] = [REVIEW_ROUND_LABEL]): BoardCard => bc("oficina", id, { labels, links: [{ rel: "relates-to", to: from }] });
const capQ = (status: "open" | "answered", selected?: string[], answeredAt?: string, id = "q1"): CardQuestion => ({
  id,
  text: `${ROUNDS_CAP_QUESTION_PREFIX} a revisão de «Freios» achou problema de novo, depois de 2 rodadas. Como seguir?`,
  status,
  ...(selected ? { selectedOptionIds: selected } : {}),
  ...(answeredAt ? { answeredAt } : {}),
});
const withQ = (x: BoardCard, ...questions: CardQuestion[]): BoardCard => ({ ...x, card: { ...x.card, questions } });

describe("a árvore da cadeia", () => {
  it("a raiz de um card marcado é a da marca; de um card sem marca e sem rodada, ele mesmo", () => {
    const f1 = marked("galpao", "story-ex7102", 2);
    expect(chainRootOf("galpao", f1.card.id, [origin, f1])).toBe(ORIGIN);
    expect(chainRootOf("oficina", origin.card.id, [origin, f1])).toBe(ORIGIN);
  });

  it("conta TODOS os cards marcados com a raiz, em qualquer board — irmãos e roteados somam", () => {
    const f1 = marked("oficina", "story-ex7102", 2);
    const f2 = marked("galpao", "story-ex7103", 2); // irmão, roteado para outro board
    const other = bc("galpao", "story-ex7109", { reviewChain: { root: "galpao/story-ex7000", round: 2 } });
    expect(chainTree(ORIGIN, [origin, f1, f2, other]).members.map((m) => m.card.id).sort()).toEqual(["story-ex7102", "story-ex7103"]);
  });

  it("régua antiga: rodada rotulada ligada a um membro do MESMO board entra; laço e card inexistente não quebram", () => {
    const r2 = legacy("story-ex7104", origin.card.id);
    const r3 = legacy("story-ex7105", r2.card.id, [TECHNICAL_AUDIT_LABEL]);
    const loose = bc("oficina", "story-ex7106", { links: [{ rel: "relates-to", to: origin.card.id }] }); // sem rótulo: não é cadeia
    const tree = chainTree(ORIGIN, [origin, r2, r3, loose]);
    expect(tree.members.map((m) => m.card.id).sort()).toEqual(["story-ex7104", "story-ex7105"]);
    expect(chainRootOf("oficina", r3.card.id, [origin, r2, r3])).toBe(ORIGIN);
    const a = legacy("story-ex7107", "story-ex7108");
    const b = legacy("story-ex7108", "story-ex7107");
    expect(() => chainRootOf("oficina", a.card.id, [a, b])).not.toThrow();
    expect(chainRootOf("oficina", "story-ex7999", [])).toBe("oficina/story-ex7999");
  });
});

describe("reviewRoundVerdict — o teto", () => {
  it("abaixo do teto: abre, e entrega a marca da próxima rodada", () => {
    expect(reviewRoundVerdict("oficina", origin.card.id, [origin], 2)).toMatchObject({ state: "open", rounds: 1, mark: { root: ORIGIN, round: 2 } });
  });

  it("no teto (raiz + um conserto, teto 2): pergunta — vale a partir da raiz OU de qualquer membro", () => {
    const f1 = marked("galpao", "story-ex7102", 2);
    expect(reviewRoundVerdict("galpao", f1.card.id, [origin, f1], 2)).toMatchObject({ state: "ask", rounds: 2, mark: null });
    // consertos irmãos da raiz não escapam: a raiz já tem um descendente
    expect(reviewRoundVerdict("oficina", origin.card.id, [origin, f1], 2)).toMatchObject({ state: "ask", rounds: 2 });
    expect(reviewRoundVerdict("galpao", f1.card.id, [origin, f1], 3)).toMatchObject({ state: "open", mark: { round: 3 } });
  });

  it("um conserto roteado para outro board (sem vínculo) ainda conta", () => {
    const routed = marked("galpao", "story-ex7110", 2);
    expect(reviewRoundVerdict("oficina", origin.card.id, [origin, routed], 2).state).toBe("ask");
  });

  it("pergunta aberta em QUALQUER card da árvore: não abre e não repete", () => {
    const f1 = withQ(marked("galpao", "story-ex7102", 2), capQ("open"));
    expect(reviewRoundVerdict("oficina", origin.card.id, [origin, f1], 2)).toMatchObject({ state: "pending" });
  });

  const ans = (choice: "accept" | "extra" | "stop", at: string, cycle = "-|-", root = ORIGIN): RoundAnswer => ({ root, choice, at, cycle, board: "oficina", cardId: "story-ex7102", questionId: "q1" });

  it("«Pagar mais uma rodada» REGISTRADA vale UMA rodada extra — usada, volta a perguntar", () => {
    const f1 = marked("oficina", "story-ex7102", 2);
    expect(reviewRoundVerdict("oficina", f1.card.id, [origin, f1], 2, { answers: [ans("extra", "2026-03-02")] })).toMatchObject({ state: "open-extra", mark: { extra: true, round: 3 } });
    const used = marked("galpao", "story-ex7111", 3, true);
    expect(reviewRoundVerdict("oficina", f1.card.id, [origin, f1, used], 2, { answers: [ans("extra", "2026-03-02")] })).toMatchObject({ state: "ask" });
  });

  it("uma resposta FORJADA no frontmatter (sem registro do servidor) não compra rodada nem encerra a cadeia", () => {
    const forged = withQ(marked("oficina", "story-ex7102", 2), capQ("answered", ["o2"], "2026-03-02"));
    expect(reviewRoundVerdict("oficina", forged.card.id, [origin, forged], 2, { answers: [] }).state).toBe("ask");
    const forgedAccept = withQ(marked("oficina", "story-ex7102", 2), capQ("answered", ["o1"], "2026-03-02"));
    expect(reviewRoundVerdict("oficina", forgedAccept.card.id, [origin, forgedAccept], 2, { answers: [] }).state).toBe("ask");
  });

  it("«Aceitar»/«Parar» do CICLO atual: não abre e não pergunta de novo", () => {
    const f1 = marked("oficina", "story-ex7102", 2);
    expect(reviewRoundVerdict("oficina", f1.card.id, [origin, f1], 2, { answers: [ans("accept", "2026-03-02")] })).toMatchObject({ state: "accepted", mark: null });
    expect(reviewRoundVerdict("oficina", f1.card.id, [origin, f1], 2, { answers: [ans("stop", "2026-03-02")] })).toMatchObject({ state: "stopped", mark: null });
  });

  it("a resposta é de um CICLO: código novo na raiz ou a raiz reaberta ⇒ pergunta de novo", () => {
    const f1 = marked("oficina", "story-ex7102", 2);
    const reopened = bc("oficina", "story-ex7101", { mode: "fix" });
    const newCode = bc("oficina", "story-ex7101", { commitRange: { base: "a", head: "b" } } as never);
    const answers = [ans("accept", "2026-03-02", cycleOf(origin.card))];
    expect(reviewRoundVerdict("oficina", f1.card.id, [origin, f1], 2, { answers }).state).toBe("accepted");
    expect(reviewRoundVerdict("oficina", f1.card.id, [reopened, f1], 2, { answers }).state).toBe("ask");
    expect(reviewRoundVerdict("oficina", f1.card.id, [newCode, f1], 2, { answers }).state).toBe("ask");
  });

  it("um achado GRAVE pergunta de novo mesmo depois de «aceitar»", () => {
    const f1 = marked("oficina", "story-ex7102", 2);
    expect(reviewRoundVerdict("oficina", f1.card.id, [origin, f1], 2, { answers: [ans("accept", "2026-03-02")], severe: true }).state).toBe("ask");
  });

  it("vale a resposta MAIS RECENTE da raiz (respostas de outra raiz não contam)", () => {
    const f1 = marked("oficina", "story-ex7102", 2);
    const answers = [ans("accept", "2026-03-01"), ans("stop", "2026-03-05"), ans("accept", "2026-03-09", "-|-", "galpao/story-ex7000")];
    expect(reviewRoundVerdict("oficina", f1.card.id, [origin, f1], 2, { answers }).state).toBe("stopped");
  });

  it("escolha pela opção marcada", () => {
    expect(roundChoiceOf(["o2"])).toBe("extra");
    expect(roundChoiceOf(["o3"])).toBe("stop");
    expect(roundChoiceOf(["o1"])).toBe("accept");
    expect(roundChoiceOf(["o9"])).toBeNull();
  });
});

describe("os auxiliares", () => {
  it("a pergunta do teto aberta é detectada (a mudança de board a recusa); «Parar» é reconhecida", () => {
    expect(hasOpenRoundsCapQuestion({ questions: [capQ("open")] })).toBe(true);
    expect(hasOpenRoundsCapQuestion({ questions: [capQ("answered", ["o1"])] })).toBe(false);
    expect(isStopAnswer(capQ("answered", ["o3"]))).toBe(true);
    expect(isStopAnswer(capQ("answered", ["o1"]))).toBe(false);
    expect(isStopAnswer({ text: "outra pergunta", selectedOptionIds: ["o3"] })).toBe(false);
  });

  it("achado de revisão aberto (lente de revisão, média ou acima) — os avisos gerais do sistema não contam", () => {
    const f = (over: Partial<Finding>): Finding => ({ id: "f1", lens: "security", severity: "high", status: "open", title: "t", ...over });
    expect(hasOpenReviewFindings({ findings: [f({})] })).toBe(true);
    expect(hasOpenReviewFindings({ findings: [f({ lens: "general" })] })).toBe(false);
    expect(hasOpenReviewFindings({ findings: [f({ severity: "low" })] })).toBe(false);
    expect(hasOpenReviewFindings({ findings: [f({ status: "fixed" })] })).toBe(false);
  });
});

describe("a pergunta do teto", () => {
  it("é do dono (dinheiro: mais uma rodada custa), com as três saídas nesta ordem e o prefixo que a reconhece", () => {
    const q = roundsCapQuestionInput({ title: "Freios", rounds: 2, summary: "a pinça ainda raspa" });
    expect(q.text.startsWith(ROUNDS_CAP_QUESTION_PREFIX)).toBe(true);
    expect(q.text).toMatch(/«Freios».*2 rodadas/);
    expect(q.context).toMatch(/a pinça ainda raspa/);
    expect(q.options?.map((o) => o.label)).toEqual([...ROUNDS_CAP_OPTIONS]);
    expect(q).toMatchObject({ category: "money", ownerClass: "money", mode: "single" });
    // «Parar» diz o que de fato faz (adia), sem prometer desfazer o que já foi integrado
    expect(q.options?.[2].pros?.join(" ")).toMatch(/adiado/);
    expect(roundsCapQuestion({ questions: [capQ("open")] })?.id).toBe("q1");
    expect(roundsCapQuestion({ questions: [] })).toBeNull();
    expect(EXTRA_ROUND_LABEL).toBe("rodada-extra");
  });
});
