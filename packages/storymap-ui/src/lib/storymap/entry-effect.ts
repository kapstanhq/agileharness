// B3 — decisão PURA do efeito-ao-entrar de um step. Separada da server action (actions.ts, "use server",
// onde todo export tem de ser async) justamente para ser TESTÁVEL sem disparar git/systemd reais: o teste
// cobre QUAL efeito dispara numa transição (o gating que regride silenciosamente — "deploy no card errado"),
// enquanto os efeitos em si (promoteStageToMain/deployBoard) já são testados no nível git. actions.ts faz o
// dispatch (ENTRY_EFFECTS) executando o efeito que esta função decide.

import { conductorEntryVerdict, isConducted } from "./driver";
import type { BoardConfig, Card, EntryEffect, RiskClass } from "./types";

/**
 * Qual EntryEffect uma transição de status dispara — ou null. Dispara SÓ numa MUDANÇA REAL de status
 * (`prevStatus !== toStatus`) para um step que declara `onEnter` no board.yaml. Um reorder/reparent na
 * mesma coluna (mesmo status) ou um step sem `onEnter` retorna null. Pure.
 */
export function entryEffect(
  config: BoardConfig,
  toStatus: string | null | undefined,
  prevStatus: string | null | undefined,
): EntryEffect | null {
  if (!toStatus || prevStatus === toStatus) return null;
  return config.statuses.find((s) => s.id === toStatus)?.onEnter ?? null;
}

/**
 * F5.3 — a RISK CLASS DINÂMICA de um move_card, pelo EFEITO da COLUNA-ALVO (não pelo verbo "mover"):
 *   - deploy: a coluna tem um onEnter (promote/deploy) → o move dispara uma ação irreversível de pipeline.
 *   - run: a coluna é autorun COM trigger → o move dispara um harness-* headless (--dangerously-skip-permissions).
 *   - write-board: um move benigno (coluna manual / sem efeito) — editar o card sem disparar pipeline.
 * O guard classifica o ALVO ANTES do commit da mutação (o efeito é pós-commit — checar "ao redor do effect"
 * seria tarde demais). Um reorder/reparent na mesma coluna (mesmo status) é write-board. Pure — p/ teste.
 */
export function moveRiskClass(
  config: BoardConfig,
  toStatus: string | null | undefined,
  fromStatus: string | null | undefined,
  /**
   * The card being moved, when the caller has it. It changes the answer in exactly two ways, both about WHAT
   * THE MOVE SPAWNS (the rule of this function), never about the verb:
   *   - a CONDUCTED card (routing.driver: conductor) spawns no column skill on entry — the cascade is silent
   *     for it — so an armed column is a benign `write-board` landing (the conductor's projection);
   *   - a NOT-yet-conducted story entering the board's conductor `fromStatus` opens an interactive conductor
   *     session → `run` (the same class as arming a column: an agent is spawned without another call).
   * Absent ⇒ the legacy column-only classification (byte-identical).
   */
  card?: Pick<Card, "type" | "capture" | "container" | "routing"> | null,
): RiskClass {
  if (!toStatus || fromStatus === toStatus) return "write-board";
  if (entryEffect(config, toStatus, fromStatus)) return "deploy";
  if (card && !isConducted(card) && conductorEntryVerdict({ ...card, status: toStatus }, config).dispatch) return "run";
  if (card && isConducted(card)) return "write-board";
  const status = config.statuses.find((s) => s.id === toStatus);
  if (status?.autorun === true && status.trigger) return "run";
  return "write-board";
}
