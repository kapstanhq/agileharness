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
//
// O ESCOPO DE TIPOS (segundo eixo, board-pace.ts) tem a sua própria mudança, {@link changeBoardScope}, e NÃO mexe no ritmo:
//   • ESTREITOU — o que já executa TERMINA (sem `stop`: só a fila é tocada); o que está na FILA do engine e ficou fora do
//     escopo sai (só ele — o predicado por card em `stopRuns`) e é anotado (`why: "scope"`) para voltar sozinho. Os
//     condutores vivos não são estacionados; a fila do condutor espera com motivo (o pump do condutor pergunta ao portão).
//   • ALARGOU — o que o escopo segurava volta pelo MESMO caminho de uma entrada de coluna, e os cards de construção que o
//     escopo novo passou a admitir são re-varridos (a anotação sozinha não basta: o teto é de 500 e a recusa feita com a
//     linha ainda sem anotar não deixa rastro). As filas são re-bombeadas.
// A varredura do prazo faz o mesmo quando o PRAZO de um escopo vence.

import type { BoardConfig } from "@/lib/storymap/types";
import {
  applyPaceChange,
  applyScopeChange,
  effectiveScope,
  expirePace,
  featuresInDelivery,
  holdPaceEntry,
  paceChangeRefusal,
  paceInputRefusal,
  paceViewOf,
  resolveBoardGate,
  scopeAdmitsCard,
  scopeChangeRefusal,
  scopeGatesStatus,
  scopeInputRefusal,
  scopeTypesPhrase,
  scopeWaitingCount,
  type ScopeHoldCard,
  type ScopeHoldContext,
  type BoardGate,
  type BoardPaceRow,
  type BoardPaceView,
  type EffectiveScope,
  type PaceChangeInput,
  type PaceHeldEntry,
  type PaceLevel,
  type ScopeCard,
  type ScopeChange,
} from "./board-pace";
import { mutateBoardPace, readBoardPace, type BoardPaceSnapshot } from "./board-pace-store";
import { resolveConductorPolicy } from "@/lib/storymap/driver";

/**
 * O predicado por card da purga da fila: `true` = ESTE card sai da fila (está fora do escopo novo). Recebe o id do card (a
 * chave do engine é `board/cardId`). Pode ser assíncrono. Um card que o predicado não reconhece fica na fila.
 */
export type PurgeFilter = (cardId: string) => boolean | Promise<boolean>;

export interface BoardPaceDeps {
  /** a configuração do board; null = não existe ou não se lê. */
  readConfig(board: string): Promise<Pick<BoardConfig, "autorunDisabled"> | null>;
  snapshot(): BoardPaceSnapshot;
  /** ler-mudar-gravar sob a cadeia (board-pace-store.ts `mutateBoardPace`); rejeita quando a gravação falha. */
  mutate(fn: (rows: BoardPaceRow[], unreadable: boolean) => BoardPaceRow[] | null): Promise<BoardPaceRow[] | null>;
  /**
   * tira do engine o trabalho automático do board: a fila sempre; o que executa, só com `running`. Com `only`, tira só os
   * cards que o predicado aponta (a purga do ESCOPO: o que cabe no escopo novo segue na fila). Sem `only`, é o board todo
   * (a pausa).
   */
  stopRuns(board: string, reason: string, opts: { running: boolean; only?: PurgeFilter }): Promise<Array<{ cardId: string }>>;
  /** os cards do board (o escopo decide por tipo e coluna; falhar aqui só desliga a purga e a re-varredura do escopo). */
  readCards(board: string): Promise<ScopeCard[]>;
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

/** Quantos cards o devolver ao pipeline faz ao mesmo tempo (cada um lê config e card e pode despachar um condutor). */
export const GIVE_BACK_CONCURRENCY = 4;

async function giveBack(deps: BoardPaceDeps, board: string, entries: readonly PaceHeldEntry[]): Promise<number> {
  let n = 0;
  // Com concorrência LIMITADA (e não em série): alargar «Tudo» num board com dezenas de cards retidos prendia o clique por
  // segundos, e sem limite abriria dezenas de leituras de card e despachos de condutor de uma vez.
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const e = entries[next++];
      try {
        await deps.rearm(board, e);
        n += 1;
      } catch (err) {
        say(deps)(`${board}/${e.cardId}: devolver ao pipeline falhou (${err instanceof Error ? err.message : String(err)}) — o vigia de card parado o pega`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GIVE_BACK_CONCURRENCY, entries.length) }, worker));
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

// ── o ESCOPO de tipos ────────────────────────────────────────────────────────────────────────────────

export type BoardScopeOutcome =
  | { ok: false; error: string }
  | {
      ok: true;
      row: BoardPaceRow;
      gate: BoardGate;
      changed: boolean;
      /** runs da FILA do engine tirados do caminho (só os de card fora do escopo; o que executa termina). */
      purged: number;
      /** cards devolvidos ao pipeline porque o escopo alargou (anotados + re-varridos). */
      released: number;
      /** destes, os que não estavam anotados e foram achados pela re-varredura dos cards de construção. */
      rescanned: number;
      /** o arquivo de ritmo estava ilegível e foi regravado (os outros boards voltaram a `normal`). */
      rewritten: boolean;
    };

/** Os cards de construção que o escopo novo passou a admitir e o antigo recusava — o que a re-varredura devolve. PURA. */
export function newlyAdmittedCards(cards: readonly ScopeCard[], before: EffectiveScope | null, after: EffectiveScope | null): ScopeCard[] {
  return cards.filter((c) => c.type === "story" && scopeGatesStatus(c.status) && !scopeAdmitsCard(before, c, "column").admit && scopeAdmitsCard(after, c, "column").admit);
}

/**
 * ALARGOU (ou o prazo venceu): devolve as entradas que o escopo segurava e re-varre os cards de construção que o escopo novo
 * passou a admitir (cada um pelo MESMO caminho de uma entrada de coluna — idempotente). Devolve quantos de cada.
 *
 * No alargamento PARCIAL (o limite afrouxou mas ainda existe), só voltam as entradas cujo card o escopo novo admite: as que
 * continuam fora seguem anotadas — sem passar pelo pipeline à toa só para serem retidas de novo.
 */
async function giveBackScope(deps: BoardPaceDeps, board: string, released: readonly PaceHeldEntry[], before: EffectiveScope | null, after: EffectiveScope | null): Promise<{ released: number; rescanned: number }> {
  const cards = await deps.readCards(board).catch(() => null);
  if (!cards) {
    say(deps)(`${board}: ler os cards para re-varrer o que o escopo liberou falhou — o vigia de card parado e a adoção de órfãos pegam o resto`);
    return { released: await giveBack(deps, board, released), rescanned: 0 };
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  // A pergunta mais estrita (`conductor`, qualquer coluna): o card que ela admite, a coluna admite também. Card que não se
  // acha (apagado) volta — o caminho de entrada de coluna cuida dele.
  const stillOut = (e: PaceHeldEntry): boolean => {
    const c = byId.get(e.cardId);
    return !!after && !!c && c.type === "story" && !scopeAdmitsCard(after, c, "conductor").admit;
  };
  const back = released.filter((e) => !stillOut(e));
  const kept = released.filter(stillOut);
  if (kept.length) {
    // o que a mudança soltou da linha (applyScopeChange devolve TODAS as entradas ao alargar) e continua fora volta a ficar anotado
    await deps
      .mutate((rows, unreadable) => {
        if (unreadable) return null;
        const now = deps.now();
        return rows.map((r) => (r.board === board ? kept.reduce((acc, e) => holdPaceEntry(acc, e, now), r) : r));
      })
      .catch(() => null);
  }
  const n = await giveBack(deps, board, back);
  const seen = new Set(released.map((e) => e.cardId));
  const at = new Date(deps.now()).toISOString();
  const extra = newlyAdmittedCards(cards, before, after)
    .filter((c) => !seen.has(c.id))
    .map((c): PaceHeldEntry => ({ cardId: c.id, why: "scope", at }));
  return { released: n, rescanned: await giveBack(deps, board, extra) };
}

/**
 * Muda o ESCOPO de tipos de um board. Julga o pedido e QUEM pede com a linha fresca (dentro da cadeia de escrita), grava
 * e aplica os efeitos (ver o cabeçalho). Não mexe no ritmo. Nunca lança.
 */
export async function changeBoardScope(deps: BoardPaceDeps, input: ScopeChange): Promise<BoardScopeOutcome> {
  try {
    const bad = scopeInputRefusal(input);
    if (bad) return { ok: false, error: bad };
    const config = await deps.readConfig(input.board);
    if (!config) return { ok: false, error: `O board "${input.board}" não existe ou não pôde ser lido.` };
    const now = deps.now();

    const decided: { refusal: string | null; result: ReturnType<typeof applyScopeChange> | null; rewritten: boolean } = { refusal: null, result: null, rewritten: false };
    await deps.mutate((rows, unreadable) => {
      const row = rows.find((r) => r.board === input.board) ?? null;
      decided.refusal = scopeChangeRefusal(resolveBoardGate(config, row, now, unreadable), row, input.types, input.by, now);
      if (decided.refusal) return null;
      const result = applyScopeChange(row, input, now);
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
    if (!applied) return { ok: false, error: "A mudança de escopo não pôde ser aplicada." };

    const log = say(deps);
    let purged = 0;
    let released = 0;
    let rescanned = 0;
    let row = applied.row;

    // ESTREITOU: tira da fila do engine SÓ o que ficou fora do escopo novo (o que executa termina; condutores seguem).
    if (applied.narrowed) {
      const cards = await deps.readCards(input.board).catch(() => null);
      if (!cards) {
        log(`${input.board}: ler os cards falhou — a fila do engine não foi filtrada pelo escopo novo (o que entrar a partir de agora é barrado na entrada)`);
      } else {
        const byId = new Map(cards.map((c) => [c.id, c]));
        const only: PurgeFilter = (cardId) => {
          const c = byId.get(cardId);
          return !!c && !scopeAdmitsCard(applied.after, c, "column").admit;
        };
        const reason = input.reason?.trim() || `o board só começa ${applied.after ? scopeTypesPhrase(applied.after.types) : "tudo"} por enquanto`;
        const runs = await deps.stopRuns(input.board, reason, { running: false, only }).catch(() => [] as Array<{ cardId: string }>);
        purged = runs.length;
        if (runs.length) {
          const at = new Date(now).toISOString();
          const written = await deps
            .mutate((rows, unreadable) => {
              if (unreadable) return null;
              return rows.map((r) => (r.board === input.board ? runs.reduce((acc, run) => holdPaceEntry(acc, { cardId: run.cardId, why: "scope", at }, now), r) : r));
            })
            .catch(() => null);
          row = written?.find((r) => r.board === input.board) ?? row;
        }
      }
    }

    // ALARGOU (ou o limite saiu): devolve o que esperava e re-varre o que o escopo novo admite.
    if (applied.widened) {
      const back = await giveBackScope(deps, input.board, applied.released, applied.before, applied.after);
      released = back.released + back.rescanned;
      rescanned = back.rescanned;
      deps.kick();
    }

    const who = input.by.kind === "owner" ? "o dono" : `um agente${input.by.id ? ` (${input.by.id})` : ""}`;
    if (applied.changed || rewritten) {
      log(
        `${input.board}: ${who} pediu escopo ${input.types === "all" ? "tudo" : scopeTypesPhrase(input.types)}${input.reason ? ` — ${input.reason.trim()}` : ""}` +
          `${input.forMinutes ? `, por ${input.forMinutes} min` : ""} → em vigor: ${applied.after ? scopeTypesPhrase(applied.after.types) : "tudo"}; ` +
          `${purged} run(s) da fila tirado(s), ${released} card(s) devolvido(s) (${rescanned} achado(s) na re-varredura)` +
          `${rewritten ? " — o registro estava ilegível e foi regravado" : ""}`,
      );
    }
    const snap = deps.snapshot();
    return {
      ok: true,
      row,
      gate: resolveBoardGate(config, snap.rows.find((r) => r.board === input.board) ?? null, deps.now(), snap.unreadable),
      changed: applied.changed || rewritten,
      purged,
      released,
      rescanned,
      rewritten,
    };
  } catch (err) {
    return { ok: false, error: `Não consegui mudar o escopo de "${input.board}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface BoardPaceSweepReport {
  /** boards cujo PRAZO DE RITMO venceu. */
  resumed: Array<{ board: string; level: PaceLevel; released: number }>;
  /** boards cujo PRAZO DE ESCOPO venceu (`released` inclui o que a re-varredura achou). Só existe quando algum venceu. */
  scopeExpired?: Array<{ board: string; released: number; rescanned: number }>;
}

/**
 * A varredura do PRAZO: cada linha cujo prazo venceu vai para o ritmo (e o escopo) de antes, e o que a pausa — ou o
 * escopo — segurou volta ao pipeline. O portão já trata o prazo vencido como retomado; isto é o que DEVOLVE o trabalho.
 * Nunca lança.
 */
export async function sweepBoardPace(deps: BoardPaceDeps): Promise<BoardPaceSweepReport> {
  const report: BoardPaceSweepReport = { resumed: [] };
  try {
    const now = deps.now();
    if (!deps.snapshot().rows.some((r) => expirePace(r, now))) return report;
    const due: Array<NonNullable<ReturnType<typeof expirePace>> & { board: string }> = [];
    await deps.mutate((rows, unreadable) => {
      if (unreadable) return null;
      let touched = false;
      const next = rows.map((r) => {
        const e = expirePace(r, now);
        if (!e) return r;
        touched = true;
        due.push({ ...e, board: r.board });
        return e.row;
      });
      return touched ? next : null;
    });
    let kick = false;
    for (const d of due) {
      if (d.paceDue) {
        const released = await giveBack(deps, d.board, d.released);
        report.resumed.push({ board: d.board, level: d.level, released });
        say(deps)(`${d.board}: o prazo venceu — ritmo → ${d.level}; ${released} card(s) devolvido(s)`);
        if (d.faster) kick = true;
      }
      if (d.scopeDue) {
        const back = await giveBackScope(deps, d.board, d.releasedScope, d.scopeBefore, d.scopeAfter);
        (report.scopeExpired ??= []).push({ board: d.board, released: back.released + back.rescanned, rescanned: back.rescanned });
        say(deps)(`${d.board}: o prazo do escopo venceu — agora ${d.scopeAfter ? scopeTypesPhrase(d.scopeAfter.types) : "tudo"}; ${back.released + back.rescanned} card(s) devolvido(s)`);
        kick = true;
      }
    }
    if (kick) deps.kick();
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
    readCards: async (board) => {
      const { readCards } = await import("@/lib/storymap/repo");
      return readCards(board);
    },
    parkConductors: async (board) => (await import("./conductor-pause-deps")).parkBoardConductorsNow(board),
    rearm: async (board, entry) => {
      const [{ getRunnerEngine }, { evaluateAutorunOnEntry }] = await Promise.all([import("./engine"), import("@/lib/notifications/server/channels/autorun-eval")]);
      // o cancelamento (da pausa ou da purga do escopo) armou o freio anti-cascata do card; devolver é o pedido explícito de seguir
      if (entry.why === "stopped" || entry.why === "scope") getRunnerEngine().clearRecentlyCancelled(board, entry.cardId);
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

/** Muda o escopo de tipos com as portas de produção. */
export function changeBoardScopeNow(input: ScopeChange): Promise<BoardScopeOutcome> {
  return changeBoardScope(defaultBoardPaceDeps(), input);
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

async function readCardsForView(board: string): Promise<ScopeHoldCard[] | null> {
  try {
    const { readCards } = await import("@/lib/storymap/repo");
    return await readCards(board);
  } catch {
    return null;
  }
}

/** Os ids dos cards do board com um run do engine em voo (o que executa termina: não está esperando). Falhou ⇒ nenhum. */
async function inFlightCardIds(board: string): Promise<Set<string>> {
  try {
    const { getRunnerRegistry } = await import("./registry");
    return new Set(getRunnerRegistry().snapshot().running.filter((r) => r.board === board).map((r) => r.cardId));
  } catch {
    return new Set();
  }
}

/** O ritmo de um board como a tela e a tool o mostram. Board inexistente ou ilegível ⇒ null. Nunca lança. */
export async function boardPaceViewNow(board: string): Promise<BoardPaceView | null> {
  try {
    const { readBoardConfig } = await import("@/lib/storymap/repo");
    const config = await readBoardConfig(board).catch(() => null);
    if (!config) return null;
    const now = Date.now();
    const snap = readBoardPace();
    const view = paceViewOf(board, config, snap, now, await quotaForSuggestion(now));
    if (!view.scope) return view;
    // Com um escopo em vigor a tela diz QUANTAS funcionalidades esperam e quantas já construídas vão junto na próxima
    // publicação (R8: o escopo controla só o INÍCIO do trabalho, não o que já chegou à stage). Sem os cards, a projeção pura fica.
    const cards = await readCardsForView(board);
    if (!cards) return view;
    const scope = effectiveScope(snap.rows.find((r) => r.board === board) ?? null, now);
    // «Esperando» é só o que o escopo SEGURA de fato: fora os cards já conduzidos e os que um run está terminando.
    const ctx: ScopeHoldContext = { conductorFrom: resolveConductorPolicy(config)?.fromStatuses, inFlight: await inFlightCardIds(board) };
    return { ...view, scopeWaiting: scopeWaitingCount(cards, scope, ctx), featuresToShip: featuresInDelivery(cards) };
  } catch {
    return null;
  }
}
