// A REGRA DE EXPANSÃO do modo só-negócio (decisão do operador). PURA (zero IO; o MCP `rollout_readiness` lê
// o ledger, os cards e o registro de decisões e chama isto).
//
// O só-negócio fica no board-piloto até ele provar que funciona: N histórias NO AR (num status `delivered`) sem
// NENHUM toque técnico do dono (a medida de touches.ts — nem salto técnico, nem pergunta técnica respondida
// por ele). N é `autonomy.rolloutCleanStories` (10, declarado no `_base`). Só isso diz "pronto para estender": a
// decisão de ligar outro board continua do dono, e este módulo não liga nada.
//
// O piloto é todo board cujo modo EFETIVO é só-negócio (`autonomy.mode: ultra`). A contagem começa quando o modo
// passou a valer: o `since` explícito, senão a primeira decisão que o sistema registrou naquele board (o registro de
// decisões só existe em só-negócio), senão o ledger inteiro — e o relatório diz qual valeu.

import { deliveredStatusIds } from "./delivered";
import { touchesPerStory } from "./touches";
import type { BoardConfig, Card } from "./types";
import type { Transition } from "./runner/transitions";

/** O default do código — o mesmo que o `_base` declara. */
export const ROLLOUT_CLEAN_STORIES_DEFAULT = 10;

export interface RolloutBoardInput {
  id: string;
  name: string;
  config: BoardConfig;
  cards: Card[];
  /** a primeira decisão do sistema registrada neste board (ISO), quando há. */
  firstSystemDecisionAt?: string | null;
}

export interface RolloutBoardReport {
  board: string;
  name: string;
  since: string | null;
  /** de onde veio o `since`. */
  sinceSource: "explicit" | "first-system-decision" | "whole-ledger";
  required: number;
  /** histórias no ar no período. */
  live: number;
  /** as que foram ao ar sem toque técnico do dono — a contagem que vale. */
  clean: string[];
  /** as que tiveram toque técnico do dono, e quantos. */
  touched: Array<{ cardId: string; title?: string; technical: number }>;
  ready: boolean;
}

export interface RolloutReport {
  pilots: RolloutBoardReport[];
  ready: boolean;
  /** a linha para o dono: «Pronto para estender a outros boards: sim|não — N/10». */
  line: string;
}

/** O N declarado pelo board (`autonomy.rolloutCleanStories`), senão o default. PURA. */
export function rolloutRequired(config: Pick<BoardConfig, "autonomy">): number {
  const n = config.autonomy?.rolloutCleanStories;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : ROLLOUT_CLEAN_STORIES_DEFAULT;
}

/** A prontidão de UM board-piloto. PURA. */
export function rolloutBoardReport(transitions: readonly Transition[], board: RolloutBoardInput, since?: string | null): RolloutBoardReport {
  const from = since ?? board.firstSystemDecisionAt ?? null;
  const sinceSource: RolloutBoardReport["sinceSource"] = since ? "explicit" : board.firstSystemDecisionAt ? "first-system-decision" : "whole-ledger";
  const delivered = deliveredStatusIds(board.config);
  const liveIds = new Set(
    transitions.filter((t) => t.board === board.id && delivered.has(t.to) && (!from || t.at >= from)).map((t) => t.cardId),
  );
  const report = touchesPerStory(transitions, { board: board.id, cards: board.cards, config: board.config, ...(from ? { since: from } : {}) });
  const clean: string[] = [];
  const touched: RolloutBoardReport["touched"] = [];
  for (const s of report.stories) {
    if (!liveIds.has(s.cardId)) continue;
    const technical = s.human.technical + s.answers.technical;
    if (technical === 0) clean.push(s.cardId);
    else touched.push({ cardId: s.cardId, ...(s.title ? { title: s.title } : {}), technical });
  }
  const required = rolloutRequired(board.config);
  return { board: board.id, name: board.name, since: from, sinceSource, required, live: liveIds.size, clean, touched, ready: clean.length >= required };
}

/**
 * A prontidão da expansão: os boards-piloto (modo efetivo só-negócio) e a linha para o dono. Pronto só quando TODO
 * piloto chegou ao seu N; sem piloto, não está pronto (não há o que provar). PURA.
 */
export function rolloutReadiness(transitions: readonly Transition[], boards: readonly RolloutBoardInput[], opts: { since?: string | null } = {}): RolloutReport {
  const pilots = boards.filter((b) => b.config.autonomy?.mode === "ultra").map((b) => rolloutBoardReport(transitions, b, opts.since));
  const ready = pilots.length > 0 && pilots.every((p) => p.ready);
  const count = pilots.length === 1 ? `${pilots[0].clean.length}/${pilots[0].required}` : pilots.map((p) => `${p.name} ${p.clean.length}/${p.required}`).join(", ");
  const line = pilots.length
    ? `Pronto para estender a outros boards: ${ready ? "sim" : "não"} — ${count} histórias no ar sem toque técnico seu`
    : "Pronto para estender a outros boards: não — nenhum board está em só-negócio";
  return { pilots, ready, line };
}
