// MUDAR O RITMO DE UM BOARD (board-pace.ts) — a ação e os efeitos dela. Núcleo com as portas injetadas; a produção
// (engine, fila do condutor, entrada de coluna) é ligada em {@link defaultBoardPaceDeps}.
//
// O QUE A MUDANÇA FAZ, além de gravar a linha:
//   • ENTROU em pausa — os runs automáticos do board que estavam na FILA saem dela (pausar é «nada novo começa»); com
//     `stop` («parar agora») os que estavam EXECUTANDO também param, e cada condutor vivo recebe o pedido de estacionar
//     (guardar o estado no card, commitar, encerrar). O que foi parado fica anotado na linha.
//   • SAIU da pausa — cada card anotado (run parado, disparo de coluna retido) volta pelo MESMO caminho de uma entrada de
//     coluna, e as filas são re-bombeadas na hora (não há borda que as acorde).
//   • ACELEROU (devagar → normal) — as filas são re-bombeadas.
// A varredura ({@link sweepBoardPace}) faz o mesmo quando o PRAZO de uma pausa vence.

import type { BoardConfig } from "@/lib/storymap/types";
import {
  applyPaceChange,
  expirePace,
  holdPaceEntry,
  paceChangeRefusal,
  paceInputRefusal,
  paceViewOf,
  resolveBoardGate,
  type BoardGate,
  type BoardPaceRow,
  type BoardPaceView,
  type PaceChangeInput,
  type PaceHeldEntry,
  type PaceLevel,
} from "./board-pace";
import { mutateBoardPace, readBoardPace, type BoardPaceSnapshot } from "./board-pace-store";

export interface BoardPaceDeps {
  /** a configuração do board; null = não existe ou não se lê. */
  readConfig(board: string): Promise<Pick<BoardConfig, "autorunDisabled"> | null>;
  snapshot(): BoardPaceSnapshot;
  /** ler-mudar-gravar sob a cadeia (board-pace-store.ts `mutateBoardPace`); rejeita quando a gravação falha. */
  mutate(fn: (rows: BoardPaceRow[], unreadable: boolean) => BoardPaceRow[] | null): Promise<BoardPaceRow[] | null>;
  /** tira do engine o trabalho automático do board: a fila sempre; o que executa, só com `running`. */
  stopRuns(board: string, reason: string, opts: { running: boolean }): Promise<Array<{ cardId: string }>>;
  /** pede a cada condutor vivo do board que estacione; devolve os que receberam o pedido. */
  parkConductors(board: string): Promise<Array<{ cardId: string }>>;
  /** devolve UM card retido ao pipeline (o caminho de uma entrada de coluna). */
  rearm(board: string, entry: PaceHeldEntry): Promise<void>;
  /** re-bombeia as filas (engine e condutor) agora. */
  kick(): void;
  now(): number;
  log?(line: string): void;
}

export type BoardPaceOutcome =
  | { ok: false; error: string }
  | {
      ok: true;
      row: BoardPaceRow;
      gate: BoardGate;
      changed: boolean;
      /** runs automáticos tirados do caminho (fila e, em `stop`, os que executavam). */
      stopped: number;
      /** condutores que receberam o pedido de estacionar. */
      parked: number;
      /** cards devolvidos ao pipeline na saída da pausa. */
      released: number;
      /** o arquivo de ritmo estava ilegível e foi regravado (os outros boards voltaram a `normal`). */
      rewritten: boolean;
    };

const say = (deps: BoardPaceDeps) => deps.log ?? ((l: string) => console.log(`[board-pace] ${l}`));

async function giveBack(deps: BoardPaceDeps, board: string, entries: readonly PaceHeldEntry[]): Promise<number> {
  let n = 0;
  for (const e of entries) {
    try {
      await deps.rearm(board, e);
      n += 1;
    } catch (err) {
      say(deps)(`${board}/${e.cardId}: devolver ao pipeline falhou (${err instanceof Error ? err.message : String(err)}) — o vigia de card parado o pega`);
    }
  }
  return n;
}

/**
 * Muda o ritmo de um board. Julga o pedido e QUEM pede com a linha fresca (dentro da cadeia de escrita), grava e aplica
 * os efeitos. Nunca lança.
 */
export async function changeBoardPace(deps: BoardPaceDeps, input: PaceChangeInput): Promise<BoardPaceOutcome> {
  try {
    const bad = paceInputRefusal(input);
    if (bad) return { ok: false, error: bad };
    const config = await deps.readConfig(input.board);
    if (!config) return { ok: false, error: `O board "${input.board}" não existe ou não pôde ser lido.` };
    const now = deps.now();

    // O que a cadeia de escrita decidiu (um objeto: o TypeScript não acompanha `let` atribuído dentro do callback).
    const decided: { refusal: string | null; result: ReturnType<typeof applyPaceChange> | null; rewritten: boolean } = { refusal: null, result: null, rewritten: false };
    await deps.mutate((rows, unreadable) => {
      const row = rows.find((r) => r.board === input.board) ?? null;
      decided.refusal = paceChangeRefusal(resolveBoardGate(config, row, now, unreadable), row, input.level, input.by, now);
      if (decided.refusal) return null;
      const result = applyPaceChange(row, input, now);
      decided.result = result;
      // Ilegível: a gravação do dono é o que cura o arquivo — mesmo que o pedido não mude nada.
      if (unreadable) {
        decided.rewritten = true;
        return [result.row];
      }
      if (!result.changed) return null;
      return row ? rows.map((r) => (r.board === input.board ? result.row : r)) : [...rows, result.row];
    });
    if (decided.refusal) return { ok: false, error: decided.refusal };
    const applied = decided.result;
    const rewritten = decided.rewritten;
    if (!applied) return { ok: false, error: "A mudança de ritmo não pôde ser aplicada." };

    const log = say(deps);
    let stopped = 0;
    let parked = 0;
    let row = applied.row;
    // Entrou em pausa (ou a pausa virou «parar agora»): o que está na fila sai sempre; o que executa, só em `stop`.
    if (applied.enteredPause || applied.stopNow) {
      const reason = input.reason?.trim() || "o board foi pausado";
      const runs = await deps.stopRuns(input.board, reason, { running: applied.mode === "stop" }).catch(() => [] as Array<{ cardId: string }>);
      stopped = runs.length;
      if (runs.length) {
        const at = new Date(now).toISOString();
        const written = await deps
          .mutate((rows, unreadable) => {
            if (unreadable) return null;
            return rows.map((r) => (r.board === input.board ? runs.reduce((acc, run) => holdPaceEntry(acc, { cardId: run.cardId, why: "stopped", at }, now), r) : r));
          })
          .catch(() => null);
        row = written?.find((r) => r.board === input.board) ?? row;
      }
      if (applied.stopNow) parked = (await deps.parkConductors(input.board).catch(() => [] as Array<{ cardId: string }>)).length;
    }
    const released = applied.released.length ? await giveBack(deps, input.board, applied.released) : 0;
    if (applied.changed && applied.level !== "paused") deps.kick();

    const who = input.by.kind === "owner" ? "o dono" : `um agente${input.by.id ? ` (${input.by.id})` : ""}`;
    if (applied.changed || rewritten) {
      log(
        `${input.board}: ${who} pediu ${input.level}${input.mode ? ` (${input.mode})` : ""}${input.reason ? ` — ${input.reason.trim()}` : ""}` +
          `${input.forMinutes ? `, por ${input.forMinutes} min` : ""} → em vigor: ${applied.level}; ${stopped} run(s) tirado(s), ${parked} condutor(es) estacionando, ${released} card(s) devolvido(s)` +
          `${rewritten ? " — o registro estava ilegível e foi regravado" : ""}`,
      );
    }
    const snap = deps.snapshot();
    return {
      ok: true,
      row,
      gate: resolveBoardGate(config, snap.rows.find((r) => r.board === input.board) ?? null, deps.now(), snap.unreadable),
      changed: applied.changed || rewritten,
      stopped,
      parked,
      released,
      rewritten,
    };
  } catch (err) {
    return { ok: false, error: `Não consegui mudar o ritmo de "${input.board}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface BoardPaceSweepReport {
  resumed: Array<{ board: string; level: PaceLevel; released: number }>;
}

/**
 * A varredura do PRAZO: cada linha cujo prazo venceu vai para o ritmo de antes, e o que a pausa segurou volta ao
 * pipeline. O portão já trata o prazo vencido como retomado; isto é o que DEVOLVE o trabalho. Nunca lança.
 */
export async function sweepBoardPace(deps: BoardPaceDeps): Promise<BoardPaceSweepReport> {
  const report: BoardPaceSweepReport = { resumed: [] };
  try {
    const now = deps.now();
    if (!deps.snapshot().rows.some((r) => expirePace(r, now))) return report;
    const due: Array<{ board: string; level: PaceLevel; released: PaceHeldEntry[]; faster: boolean }> = [];
    await deps.mutate((rows, unreadable) => {
      if (unreadable) return null;
      let touched = false;
      const next = rows.map((r) => {
        const e = expirePace(r, now);
        if (!e) return r;
        touched = true;
        due.push({ board: r.board, level: e.level, released: e.released, faster: e.faster });
        return e.row;
      });
      return touched ? next : null;
    });
    for (const d of due) {
      const released = await giveBack(deps, d.board, d.released);
      report.resumed.push({ board: d.board, level: d.level, released });
      say(deps)(`${d.board}: o prazo venceu — ritmo → ${d.level}; ${released} card(s) devolvido(s)`);
    }
    if (due.some((d) => d.faster)) deps.kick();
  } catch (err) {
    say(deps)(`varredura do prazo falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
  return report;
}

/** As portas de produção. O engine e a entrada de coluna entram por import tardio: puxam a árvore inteira do runner. */
export function defaultBoardPaceDeps(): BoardPaceDeps {
  return {
    readConfig: async (board) => {
      const { readBoardConfig } = await import("@/lib/storymap/repo");
      return readBoardConfig(board).catch(() => null);
    },
    snapshot: () => readBoardPace(),
    mutate: (fn) => mutateBoardPace(fn),
    stopRuns: async (board, reason, opts) => {
      const { getRunnerEngine } = await import("./engine");
      return getRunnerEngine().stopBoardAutomation(board, reason, opts);
    },
    parkConductors: async (board) => (await import("./conductor-pause-deps")).parkBoardConductorsNow(board),
    rearm: async (board, entry) => {
      const [{ getRunnerEngine }, { evaluateAutorunOnEntry }] = await Promise.all([import("./engine"), import("@/lib/notifications/server/channels/autorun-eval")]);
      // o cancelamento da pausa armou o freio anti-cascata do card; a retomada é o pedido explícito de seguir
      if (entry.why === "stopped") getRunnerEngine().clearRecentlyCancelled(board, entry.cardId);
      await evaluateAutorunOnEntry(board, entry.cardId);
    },
    kick: () => {
      void import("./engine").then(({ getRunnerEngine }) => getRunnerEngine().kick()).catch(() => {});
      void import("./fleet-deps").then(({ pumpConductorsNow }) => pumpConductorsNow()).catch(() => {});
    },
    now: () => Date.now(),
  };
}

/** Muda o ritmo com as portas de produção. */
export function changeBoardPaceNow(input: PaceChangeInput): Promise<BoardPaceOutcome> {
  return changeBoardPace(defaultBoardPaceDeps(), input);
}

/** A varredura do prazo com as portas de produção — o tick da frota a chama. */
export function sweepBoardPaceNow(): Promise<BoardPaceSweepReport> {
  return sweepBoardPace(defaultBoardPaceDeps());
}

/**
 * A leitura da cota para a SUGESTÃO de ritmo: a mesma régua do teto de gasto do card («no ritmo da semana»). Sem leitura,
 * ou com leitura velha, devolve null — a sugestão não sai de um palpite.
 */
async function quotaForSuggestion(now: number): Promise<{ onPace: boolean; detail: string } | null> {
  try {
    const [{ getCapacityGovernor }, { quotaPace, DEFAULT_BUDGET_RAISE }, { loadRunnerConfig }] = await Promise.all([
      import("./capacity-service"),
      import("./card-budget"),
      import("./config"),
    ]);
    const r = getCapacityGovernor().snapshot().reading;
    if (!r || r.stale) return null;
    return quotaPace({ usage7dPct: r.usage7dPct, usage5hPct: r.usage5hPct, resetsAt7d: r.resetsAt7d, stale: r.stale }, now, loadRunnerConfig().autorun.budgetRaise ?? DEFAULT_BUDGET_RAISE);
  } catch {
    return null;
  }
}

/** O ritmo de um board como a tela e a tool o mostram. Board inexistente ou ilegível ⇒ null. Nunca lança. */
export async function boardPaceViewNow(board: string): Promise<BoardPaceView | null> {
  try {
    const { readBoardConfig } = await import("@/lib/storymap/repo");
    const config = await readBoardConfig(board).catch(() => null);
    if (!config) return null;
    const now = Date.now();
    return paceViewOf(board, config, readBoardPace(), now, await quotaForSuggestion(now));
  } catch {
    return null;
  }
}
