// O REGISTRO DO SERVIDOR das respostas do dono ao teto de rodadas de revisão (review-rounds.ts). As respostas que contam
// — «pagar mais uma rodada», «aceitar o risco», «parar» — são lidas DAQUI, não do frontmatter do card: o frontmatter é
// escrito por agentes no worktree deles, e uma resposta forjada lá não pode comprar rodadas nem encerrar uma cadeia.
// Quem grava é só a action da resposta (answerQuestionAction), do lado do servidor. Fica em
// `runnerStateDir()/review-rounds.jsonl` — o estado do runner, fora do alcance de escrita do sandbox de um agente.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { RoundAnswer } from "./review-rounds";

const FILE = "review-rounds.jsonl";

export function reviewRoundsLedgerPath(dir: string = runnerStateDir()): string {
  return path.join(dir, FILE);
}

/** Acrescenta uma resposta (nunca lança para o chamador além do erro de disco). */
export async function appendRoundAnswer(answer: RoundAnswer, dir?: string): Promise<void> {
  const file = reviewRoundsLedgerPath(dir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(answer)}\n`, "utf8");
}

/** As respostas registradas (linhas ilegíveis são puladas). Sem arquivo ⇒ nenhuma. */
export async function readRoundAnswers(dir?: string): Promise<RoundAnswer[]> {
  let text: string;
  try {
    text = await fsp.readFile(reviewRoundsLedgerPath(dir), "utf8");
  } catch {
    return [];
  }
  const out: RoundAnswer[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<RoundAnswer>;
      if (typeof o.root === "string" && (o.choice === "accept" || o.choice === "extra" || o.choice === "stop") && typeof o.at === "string") {
        out.push({ root: o.root, choice: o.choice, at: o.at, cycle: typeof o.cycle === "string" ? o.cycle : "", board: String(o.board ?? ""), cardId: String(o.cardId ?? ""), questionId: String(o.questionId ?? "") });
      }
    } catch {
      /* linha ilegível */
    }
  }
  return out;
}
