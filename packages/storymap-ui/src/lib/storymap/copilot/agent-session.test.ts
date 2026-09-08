import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  boardScope,
  hasLiveCopilotTurn,
  hasLiveCopilotTurnForBoard,
  hasLiveCopilotTurnInScope,
  viewScope,
  killCopilotTurn,
  killTree,
  reserveCopilotTurnSlot,
} from "./agent-session";

// The live-turn registry is globalThis-pinned (survives HMR) — the module and this test share the SAME Map.
interface FakeEntry {
  boardId: string;
  scope: string;
  sessionId: string;
  child: ChildProcess;
  startedAt: number;
  settle: () => void;
}
const g = globalThis as unknown as { __copilotLiveTurns?: Map<string, FakeEntry>; __copilotReservedTurns?: Map<string, number> };
const LIVE = (): Map<string, FakeEntry> => (g.__copilotLiveTurns ??= new Map());
const RESERVED = (): Map<string, number> => (g.__copilotReservedTurns ??= new Map());

const DEFAULT_TIMEOUT_MS = Number(process.env.USM_COPILOT_TIMEOUT_MS) || 600_000;
const TTL_MS = DEFAULT_TIMEOUT_MS + 60_000;

// A LiveTurn shaped like the module's, with a no-pid child (killTree early-returns → never signals a real pid).
// A chave do registro é `<raia>::<sessão>` (liveKey) — as raias são o que mantém o chat do board e a
// conversa de uma TELA independentes.
function fakeEntry(scope: string, sessionId: string, startedAt: number, settle: () => void = () => {}): FakeEntry {
  const boardId = scope.split(":")[1] ?? "acme";
  return { boardId, scope, sessionId, child: { pid: undefined } as unknown as ChildProcess, startedAt, settle };
}
const key = (scope: string, sessionId: string) => `${scope}::${sessionId}`;
const NEST = boardScope("acme");

beforeEach(() => {
  LIVE().clear();
  RESERVED().clear();
});
afterEach(() => {
  LIVE().clear();
  RESERVED().clear();
});

describe("agent-session live-turn registry (WS-3)", () => {
  it("hasLiveCopilotTurn: a fresh entry is live; an entry past the TTL is evicted and reads as absent (3.1)", () => {
    const k = key(NEST, "s1");
    LIVE().set(k, fakeEntry(NEST, "s1", Date.now()));
    expect(hasLiveCopilotTurn(NEST, "s1")).toBe(true);

    // Orphan past the TTL (a zombie that never closed) — ignored AND removed, so it can't hold the 409 forever.
    LIVE().set(k, fakeEntry(NEST, "s1", Date.now() - TTL_MS - 1));
    expect(hasLiveCopilotTurn(NEST, "s1")).toBe(false);
    expect(LIVE().has(k)).toBe(false);
  });

  it("hasLiveCopilotTurnForBoard: true for any fresh turn on the board; stale entries evicted (3.4)", () => {
    expect(hasLiveCopilotTurnForBoard("acme")).toBe(false);

    LIVE().set(key(NEST, "s1"), fakeEntry(NEST, "s1", Date.now()));
    expect(hasLiveCopilotTurnForBoard("acme")).toBe(true);
    expect(hasLiveCopilotTurnForBoard("orbit")).toBe(false); // other board unaffected

    LIVE().clear();
    LIVE().set(key(NEST, "old"), fakeEntry(NEST, "old", Date.now() - TTL_MS - 1));
    expect(hasLiveCopilotTurnForBoard("acme")).toBe(false); // only a stale entry → not live
    expect(LIVE().has(key(NEST, "old"))).toBe(false); // evicted
  });

  it("killCopilotTurn exact match: settles + clears LIVE immediately (3.1b — was a no-op before)", () => {
    const settle = vi.fn();
    LIVE().set(key(NEST, "s1"), fakeEntry(NEST, "s1", Date.now(), settle));
    expect(killCopilotTurn(NEST, "s1")).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(LIVE().has(key(NEST, "s1"))).toBe(false); // 409 released on cancel
  });

  it("killCopilotTurn fallback: kills+settles every live turn of the SCOPE when the session key doesn't match", () => {
    const settle = vi.fn();
    LIVE().set(key(NEST, "real"), fakeEntry(NEST, "real", Date.now(), settle));
    expect(killCopilotTurn(NEST, "stale-key")).toBe(true); // exact miss → fallback by scope
    expect(settle).toHaveBeenCalledTimes(1);
    expect(LIVE().has(key(NEST, "real"))).toBe(false);
  });

  it("killCopilotTurn: false + no side effects when nothing matches the scope", () => {
    const other = boardScope("orbit");
    LIVE().set(key(other, "s1"), fakeEntry(other, "s1", Date.now()));
    expect(killCopilotTurn(NEST, "s1")).toBe(false);
    expect(LIVE().has(key(other, "s1"))).toBe(true);
  });
});

// As RAIAS. Cada TELA com chat corre em raia própria: ela não pode tomar o único slot do board (que travaria o
// Jido e o tick autônomo), nem ser derrubada quando alguém cancela o chat do board.
describe("agent-session — raias independentes (board × tela)", () => {
  const IDEIAS = viewScope("acme", "ideias");

  it("um turno na tela de Ideias não ocupa o chat do board (nem o gate do tick)", () => {
    LIVE().set(key(IDEIAS, "s1"), fakeEntry(IDEIAS, "s1", Date.now()));
    expect(hasLiveCopilotTurnInScope(IDEIAS)).toBe(true);
    expect(hasLiveCopilotTurnForBoard("acme")).toBe(false); // ← o Jido segue livre
  });

  it("o chat do board ocupado não impede conversar noutra tela (e vice-versa)", () => {
    const board = reserveCopilotTurnSlot(NEST);
    expect(board.ok).toBe(true);
    expect(reserveCopilotTurnSlot(NEST).ok).toBe(false); // a MESMA raia continua serializada
    expect(reserveCopilotTurnSlot(IDEIAS).ok).toBe(true); // outra raia é independente
  });

  it("duas telas diferentes são raias diferentes; a MESMA tela continua com 1 turno em voo", () => {
    expect(reserveCopilotTurnSlot(IDEIAS).ok).toBe(true);
    expect(reserveCopilotTurnSlot(IDEIAS).ok).toBe(false);
    expect(reserveCopilotTurnSlot(viewScope("acme", "inbox")).ok).toBe(true);
  });

  it("cancelar o chat do board NÃO mata a conversa de outra tela em voo", () => {
    const settleView = vi.fn();
    LIVE().set(key(NEST, "b1"), fakeEntry(NEST, "b1", Date.now()));
    LIVE().set(key(IDEIAS, "i1"), fakeEntry(IDEIAS, "i1", Date.now(), settleView));
    expect(killCopilotTurn(NEST, "b1")).toBe(true);
    expect(settleView).not.toHaveBeenCalled();
    expect(LIVE().has(key(IDEIAS, "i1"))).toBe(true);
  });

  it("o prefixo da raia impede colisão entre um board e uma tela de mesmo nome", () => {
    expect(boardScope("x")).not.toBe(viewScope("x", "x"));
  });
});

// A RESERVA é o que fecha a janela TOCTOU entre o check da rota e o `LIVE.set` (que só acontece depois de vários
// awaits do setup do spawn). Enquanto o cliente desistia no primeiro 409 a janela era teórica; com a FILA do chat
// re-tentando sozinha, duas abas saindo do backoff no mesmo instante a acertam.
describe("agent-session — reserva do slot de turno da raia", () => {
  it("reservar OCUPA a raia: a segunda reserva é recusada (dois POSTs no mesmo tick)", () => {
    const first = reserveCopilotTurnSlot(NEST);
    expect(first.ok).toBe(true);
    expect(hasLiveCopilotTurnForBoard("acme")).toBe(true); // a régua única já vê o board ocupado
    expect(reserveCopilotTurnSlot(NEST).ok).toBe(false); // ← a corrida que o 409 tinha de pegar
    expect(reserveCopilotTurnSlot(boardScope("orbit")).ok).toBe(true); // outro board é independente
  });

  it("um turno JÁ registrado também barra a reserva (o caminho inverso da mesma trava)", () => {
    LIVE().set(key(NEST, "s1"), fakeEntry(NEST, "s1", Date.now()));
    expect(reserveCopilotTurnSlot(NEST).ok).toBe(false);
    expect(RESERVED().has(NEST)).toBe(false); // recusa NÃO deixa reserva pendurada
  });

  it("release libera a raia e é idempotente (o `finally` do stream pode rodar mais de uma vez)", () => {
    const slot = reserveCopilotTurnSlot(NEST);
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;
    slot.release();
    expect(hasLiveCopilotTurnForBoard("acme")).toBe(false);
    slot.release(); // 2ª vez: no-op
    // e não pode derrubar a reserva de um turno NOVO que já começou na mesma raia
    const next = reserveCopilotTurnSlot(NEST);
    expect(next.ok).toBe(true);
    slot.release();
    expect(hasLiveCopilotTurnForBoard("acme")).toBe(true);
  });

  it("reserva órfã além do TTL não segura a raia para sempre (backstop se a rota morrer)", () => {
    RESERVED().set(NEST, Date.now() - TTL_MS - 1);
    expect(hasLiveCopilotTurnForBoard("acme")).toBe(false);
    expect(RESERVED().has(NEST)).toBe(false); // evicta ao ler
    expect(reserveCopilotTurnSlot(NEST).ok).toBe(true);
  });
});

describe("killTree — POSIX process-group kill with SIGTERM→SIGKILL escalation (WS-3/3.2)", () => {
  const posix = process.platform !== "win32";

  it.runIf(posix)("escalates to SIGKILL on the GROUP when the process ignores SIGTERM", async () => {
    const signals: Array<{ pid: number; sig: NodeJS.Signals | 0 | undefined }> = [];
    // Fake process that never dies: the liveness probe (signal 0) always succeeds → still alive after SIGTERM.
    const killProcess = vi.fn((pid: number, sig?: NodeJS.Signals | 0) => {
      signals.push({ pid, sig });
    });
    await killTree({ pid: 4242 } as unknown as ChildProcess, killProcess);
    // SIGTERM to the NEGATIVE pid (the group), the liveness probe found it alive, then SIGKILL to the group.
    expect(signals).toContainEqual({ pid: -4242, sig: "SIGTERM" });
    expect(signals).toContainEqual({ pid: -4242, sig: 0 });
    expect(signals).toContainEqual({ pid: -4242, sig: "SIGKILL" });
  });

  it.runIf(posix)("stops at SIGTERM when the group is already gone (no wasted SIGKILL)", async () => {
    const seen: Array<NodeJS.Signals | 0 | undefined> = [];
    const killProcess = vi.fn((_pid: number, sig?: NodeJS.Signals | 0) => {
      seen.push(sig);
      if (sig === 0) throw new Error("ESRCH"); // probe: the group is already empty
    });
    await killTree({ pid: 4242 } as unknown as ChildProcess, killProcess);
    expect(seen).toContain("SIGTERM");
    expect(seen).not.toContain("SIGKILL");
  });

  it("no-op when the child has no pid (never signals)", async () => {
    const killProcess = vi.fn();
    await killTree({ pid: undefined } as unknown as ChildProcess, killProcess);
    expect(killProcess).not.toHaveBeenCalled();
  });
});
