// O registro do servidor das respostas do dono ao teto de rodadas, e o que a resposta faz: grava a escolha com a raiz e
// o ciclo; «Parar» adia os membros VIVOS da árvore em qualquer board. Fixtures inventadas (uma oficina de bicicletas).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRoundAnswer, readRoundAnswers, reviewRoundsLedgerPath } from "./review-rounds-ledger";
import { recordRoundsCapAnswer } from "./review-rounds-deps";
import { ROUNDS_CAP_QUESTION_PREFIX, type BoardCard, type RoundAnswer } from "./review-rounds";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const bc = (board: string, id: string, over: Partial<BoardCard["card"]> = {}): BoardCard => ({ board, card: { id, labels: [], links: [], ...over } });
const ROOT = "oficina/story-ex7101";
const tree = (): BoardCard[] => [
  bc("oficina", "story-ex7101"),
  bc("oficina", "story-ex7102", { reviewChain: { root: ROOT, round: 2 } }),
  bc("galpao", "story-ex7103", { reviewChain: { root: ROOT, round: 2 } }),
  bc("galpao", "story-ex7999"),
];
const text = `${ROUNDS_CAP_QUESTION_PREFIX} a revisão de «Freios» achou problema de novo, depois de 2 rodadas. Como seguir?`;

describe("o registro", () => {
  it("grava e relê; linhas tortas são puladas; sem arquivo ⇒ vazio", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "rounds-ledger-"));
    expect(await readRoundAnswers(dir)).toEqual([]);
    const a: RoundAnswer = { root: ROOT, choice: "extra", at: "2026-03-02T00:00:00Z", cycle: "-|-", board: "oficina", cardId: "story-ex7102", questionId: "q1" };
    await appendRoundAnswer(a, dir);
    writeFileSync(reviewRoundsLedgerPath(dir), `${JSON.stringify(a)}\n{torta\n{"root":"x","choice":"comprar","at":"1"}\n`);
    expect(await readRoundAnswers(dir)).toEqual([a]);
  });
});

describe("recordRoundsCapAnswer — a resposta do dono", () => {
  const run = async (selected: string[], q = text) => {
    const appended: RoundAnswer[] = [];
    const deferred: string[] = [];
    const r = await recordRoundsCapAnswer(
      { board: "oficina", cardId: "story-ex7102", questionId: "q1", text: q, selectedOptionIds: selected, by: "human" },
      { readAll: async () => tree(), append: async (a) => void appended.push(a), defer: async (b, id) => void deferred.push(`${b}/${id}`), now: () => Date.parse("2026-03-02T00:00:00Z") },
    );
    return { r, appended, deferred };
  };

  it("«Pagar» registra a escolha com a raiz e o ciclo, sem adiar nada", async () => {
    const { r, appended, deferred } = await run(["o2"]);
    expect(r).toMatchObject({ root: ROOT, choice: "extra", cycle: "-|-" });
    expect(appended).toHaveLength(1);
    expect(deferred).toEqual([]);
  });

  it("«Parar» adia os outros membros da árvore em TODOS os boards (não os de fora dela)", async () => {
    const { appended, deferred } = await run(["o3"]);
    expect(appended[0].choice).toBe("stop");
    expect(deferred.sort()).toEqual(["galpao/story-ex7103", "oficina/story-ex7101"]);
  });

  it("uma pergunta que não é a do teto, ou sem uma das três opções, não registra nada", async () => {
    expect((await run(["o3"], "Qual cor?")).r).toBeNull();
    expect((await run(["o9"])).r).toBeNull();
  });
});
