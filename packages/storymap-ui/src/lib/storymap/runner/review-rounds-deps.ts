// O PORTÃO do teto de rodadas de revisão, com o disco (review-rounds.ts é a régua pura). Quem vai abrir um conserto de
// revisão pergunta aqui primeiro e recebe, junto com o «pode», a MARCA de cadeia que o conserto tem de nascer carregando
// (na mesma escrita que o cria): abaixo do teto, «abra»; no teto, com uma rodada que o dono pagou, «abra a extra»; no
// teto sem ela, a pergunta vai ao card de onde o conserto nasceria (uma só — uma aberta em qualquer card da árvore não é
// repetida) e a resposta é «perguntei»; depois de o dono aceitar o risco ou mandar parar, «não abra» sem perguntar de
// novo. A árvore é lida em TODOS os boards (um conserto roteado conta). O teto vem de `autorun.reviewRoundsCap`.

import { addStructuredQuestions, type StructuredQuestionInput } from "@/lib/storymap/questions";
import { listBoards, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { CAP_STOP_DEFER_REASON, deferralFor } from "@/lib/storymap/deferral";
import { updateCardOnDisk } from "@/lib/storymap/write";
import type { ReviewChainMark } from "@/lib/storymap/types";
import { loadRunnerConfig } from "./config";
import { appendRoundAnswer, readRoundAnswers } from "./review-rounds-ledger";
import {
  DEFAULT_REVIEW_ROUNDS_CAP,
  ROUNDS_CAP_QUESTION_PREFIX,
  chainRootOf,
  chainTree,
  cycleOf,
  reviewRoundVerdict,
  roundChoiceOf,
  roundsCapQuestionInput,
  type BoardCard,
  type RoundAnswer,
} from "./review-rounds";

export type ReviewRoundsGate = "open" | "open-extra" | "asked" | "accepted" | "stopped";

export interface ReviewRoundsDecision {
  gate: ReviewRoundsGate;
  /** a marca que o conserto aberto agora carrega (só com `open`/`open-extra`; null quando a árvore não pôde ser lida). */
  mark: ReviewChainMark | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** O teto declarado (ou o padrão). */
export function reviewRoundsCap(): number {
  return loadRunnerConfig().autorun.reviewRoundsCap ?? DEFAULT_REVIEW_ROUNDS_CAP;
}

/** Os cards de todos os boards do alvo. */
export async function readAllBoardCards(): Promise<BoardCard[]> {
  const out: BoardCard[] = [];
  for (const b of await listBoards()) {
    for (const card of await readCards(b.id).catch(() => [])) out.push({ board: b.id, card });
  }
  return out;
}

/**
 * Pode abrir mais uma rodada de conserto a partir de `board/fromId`? `summary` = o que a revisão deixou aberto, para a
 * pergunta ao dono. Falha ao ler ⇒ «open» sem marca (o comportamento de antes do teto — nunca esconde um conserto por
 * erro de leitura).
 */
export async function reviewRoundsGate(
  board: string,
  fromId: string,
  summary: string,
  cap: number = reviewRoundsCap(),
  /** quem grava a pergunta — padrão: direto no card; o MCP passa a ação do servidor (o mesmo caminho do ask_question). */
  ask: (board: string, cardId: string, q: StructuredQuestionInput) => Promise<void> = askOnDisk,
  readAll: () => Promise<BoardCard[]> = readAllBoardCards,
  /** `severe` = a revisão achou um bloqueante (pergunta de novo mesmo depois de «aceitar»/«parar»); `answers` = o registro. */
  opts: { severe?: boolean; answers?: () => Promise<RoundAnswer[]> } = {},
): Promise<ReviewRoundsDecision> {
  let all: BoardCard[];
  let answers: RoundAnswer[];
  try {
    [all, answers] = await Promise.all([readAll(), (opts.answers ?? readRoundAnswers)()]);
  } catch {
    return { gate: "open", mark: null };
  }
  const v = reviewRoundVerdict(board, fromId, all, cap, { answers, severe: opts.severe });
  switch (v.state) {
    case "open":
      return { gate: "open", mark: v.mark };
    case "open-extra":
      return { gate: "open-extra", mark: v.mark };
    case "pending":
      return { gate: "asked", mark: null };
    case "accepted":
      return { gate: "accepted", mark: null };
    case "stopped":
      return { gate: "stopped", mark: null };
    case "ask": {
      const from = all.find((x) => x.board === board && x.card.id === fromId)?.card as { title?: string } | undefined;
      await ask(board, fromId, roundsCapQuestionInput({ title: from?.title ?? fromId, rounds: v.rounds, summary }));
      return { gate: "asked", mark: null };
    }
  }
}

/**
 * A marca de um conserto que NÃO passa pelo portão (o conserto que o DONO mandou abrir pelo Inbox): ele conta na árvore
 * mesmo assim. Falha ao ler ⇒ null.
 */
export async function reviewChainMarkFor(board: string, fromId: string, readAll: () => Promise<BoardCard[]> = readAllBoardCards): Promise<ReviewChainMark | null> {
  try {
    return reviewRoundVerdict(board, fromId, await readAll(), Number.MAX_SAFE_INTEGER, {}).mark;
  } catch {
    return null;
  }
}

/**
 * A resposta do DONO à pergunta do teto, registrada pelo SERVIDOR (answerQuestionAction chama; nunca um agente). Com
 * «Parar», adia os membros VIVOS da árvore em todos os boards (o card da pergunta já foi adiado na escrita da resposta).
 * Devolve o que foi registrado (null quando a pergunta não é a do teto ou a opção não é uma das três). Nunca lança.
 */
export async function recordRoundsCapAnswer(
  input: { board: string; cardId: string; questionId: string; text: string; selectedOptionIds?: string[]; by: string },
  deps: { readAll?: () => Promise<BoardCard[]>; append?: (a: RoundAnswer) => Promise<void>; defer?: (board: string, cardId: string) => Promise<void>; now?: () => number } = {},
): Promise<RoundAnswer | null> {
  if (!input.text.startsWith(ROUNDS_CAP_QUESTION_PREFIX)) return null;
  const choice = roundChoiceOf(input.selectedOptionIds);
  if (!choice) return null;
  try {
    const all = await (deps.readAll ?? readAllBoardCards)();
    const root = chainRootOf(input.board, input.cardId, all);
    const tree = chainTree(root, all);
    const answer: RoundAnswer = {
      root,
      choice,
      at: new Date((deps.now ?? Date.now)()).toISOString(),
      cycle: cycleOf(tree.root?.card),
      board: input.board,
      cardId: input.cardId,
      questionId: input.questionId,
    };
    await (deps.append ?? ((a) => appendRoundAnswer(a)))(answer);
    if (choice === "stop") {
      const defer = deps.defer ?? ((b: string, id: string) => deferOnStop(b, id, input.by));
      for (const x of [...(tree.root ? [tree.root] : []), ...tree.members]) {
        if (x.board === input.board && x.card.id === input.cardId) continue;
        await defer(x.board, x.card.id).catch(() => {});
      }
    }
    return answer;
  } catch (err) {
    console.error("[review-rounds] a resposta do dono ao teto não pôde ser registrada:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Adia um membro vivo da árvore (terminal ou já adiado fica como está). */
async function deferOnStop(board: string, cardId: string, by: string): Promise<void> {
  const config = await readBoardConfig(board);
  const today = new Date().toISOString().slice(0, 10);
  await updateCardOnDisk(board, cardId, (fresh) => {
    if (fresh.deferred || config.statuses.find((s) => s.id === fresh.status)?.terminal) return null;
    return { ...fresh, deferred: deferralFor({ reason: CAP_STOP_DEFER_REASON, today, by, rootId: fresh.id, cardId: fresh.id }) };
  });
}

async function askOnDisk(board: string, cardId: string, q: StructuredQuestionInput): Promise<void> {
  await updateCardOnDisk(board, cardId, (prev) => ({
    ...prev,
    questions: addStructuredQuestions(prev.questions ?? [], [q], "system:review-rounds", today()),
  }));
}
