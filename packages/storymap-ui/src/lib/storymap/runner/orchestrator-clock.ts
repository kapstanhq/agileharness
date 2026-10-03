// orchestrator-clock.ts — o RELÓGIO do Jido autônomo: QUANDO o próximo tick roda (timer global) e se há
// um WAKE (acordar por evento) agendado para um board. É o read-model que responde "quanto falta p/ o próximo
// tick?" no header — sem ele a UI só podia dizer "a cada 30min" (uma cadência, não um horário).
//
// Estado de PROCESSO, globalThis-pinned (mesmo idiom do dispatcher/registries/LIVE do Jido): um Map
// module-level daria instâncias SEPARADAS entre bundles de rota (o timer escreve numa, a server action lê a
// outra) → o header leria sempre vazio. Só o timer/scheduler ESCREVEM; o overview LÊ. Sem IO, sem React.

export interface PendingWake {
  board: string;
  /** por que o Jido vai acordar (o evento que o disparou) — mostrado ao operador. */
  reason: string;
  /** epoch ms em que o wake dispara (fim do debounce). */
  dueAt: number;
}

interface ClockState {
  /** epoch ms do próximo tick do TIMER global; undefined ⇒ timer desarmado. */
  nextTickAt?: number;
  /** cadência atual do timer (ms) — a UI explica "a cada Xmin". */
  intervalMs?: number;
  /** wakes em voo (debounce), por board. */
  wakes: Map<string, PendingWake>;
}

const KEY = Symbol.for("storymap.orchestrator.clock");
const store = globalThis as unknown as { [KEY]?: ClockState };

function clock(): ClockState {
  return (store[KEY] ??= { wakes: new Map() });
}

/** O timer se re-armou: o próximo tick global cai em `nextTickAt`. Chamado pelo onArm do startOrchestratorTick. */
export function armClock(nextTickAt: number, intervalMs: number): void {
  const c = clock();
  c.nextTickAt = nextTickAt;
  c.intervalMs = intervalMs;
}

/** O timer parou (stop()) — sem próximo tick. */
export function disarmClock(): void {
  const c = clock();
  c.nextTickAt = undefined;
  c.intervalMs = undefined;
}

/** Um wake foi agendado p/ `board` (debounce em voo). */
export function setPendingWake(w: PendingWake): void {
  clock().wakes.set(w.board, w);
}

/** O wake do board disparou (ou foi cancelado). */
export function clearPendingWake(board: string): void {
  clock().wakes.delete(board);
}

export interface ClockView {
  /** ISO do próximo tick do timer global (ausente ⇒ desarmado). */
  nextTickAt?: number;
  intervalMs?: number;
  /** o wake em voo DESTE board, quando há. */
  pendingWake?: PendingWake;
}

/** Snapshot do relógio para o read-model (o `board` filtra o wake em voo). PURO em relação ao estado. */
export function readClock(board?: string): ClockView {
  const c = clock();
  const pendingWake = board ? c.wakes.get(board) : undefined;
  return {
    nextTickAt: c.nextTickAt,
    intervalMs: c.intervalMs,
    ...(pendingWake ? { pendingWake } : {}),
  };
}

/** Só p/ teste: zera o relógio do processo. */
export function resetClock(): void {
  store[KEY] = { wakes: new Map() };
}
