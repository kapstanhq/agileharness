// Dependency graph for dependency-aware enqueueing (story-mcp-enfileiramento-lote-dependencias).
//
// A card B declared to depend on A only gets a worktree + starts running AFTER A reaches a
// terminal state. This module tracks the cards HELD waiting (`BlockedEntry`) and, as each
// predecessor settles, decides who is now free to run. It is the data layer behind the MCP
// `enqueue_batch` tool: the tool validates the graph (cycles) and the engine drives release.
//
// PURITY: the graph holds NO reference to the engine. `onSettled` RETURNS the entries now
// ready to run; the engine (its onComplete listener) launches them. That keeps this class a
// pure data structure — unit-testable on Bun with no engine, no spawn, no clock dependency.
//
// EPHEMERALITY: a process singleton (RAM only), mirroring RunnerRegistry. A restart drops a
// partial batch by design — the orchestrator re-sends it (documented on the MCP tool).

import type { RunOutcome } from "./journal";
import type { BlockedEntry } from "./types";

/** A dependency edge: `from` must settle before `to` may start. Keys are "board/cardId". */
export interface DepEdge {
  from: string;
  to: string;
}

export class DependencyGraph {
  private blocked = new Map<string, BlockedEntry>(); // "board/cardId" → entry

  private key(board: string, cardId: string): string {
    return `${board}/${cardId}`;
  }

  /** Hold a card until every predecessor in its `depsRemaining` settles. */
  register(entry: BlockedEntry): void {
    this.blocked.set(this.key(entry.board, entry.cardId), entry);
  }

  /** Is this card currently held (blocked, including blocked-by-failure)? */
  isBlocked(board: string, cardId: string): boolean {
    return this.blocked.has(this.key(board, cardId));
  }

  /**
   * A predecessor run SETTLED. Drop it from every waiter's `depsRemaining`; on a TERMINAL
   * FAILURE (any outcome ≠ "ok") record it in `failedDeps` so the waiter becomes
   * blocked-by-failure and is NEVER auto-released (it awaits the operator). Returns the
   * entries whose LAST dependency just settled ok — removed from the graph here; the caller
   * (engine) launches them, keeping this class engine-free.
   */
  onSettled(board: string, cardId: string, outcome: RunOutcome): BlockedEntry[] {
    const depKey = this.key(board, cardId);
    const released: BlockedEntry[] = [];
    for (const [entryKey, entry] of this.blocked) {
      if (!entry.depsRemaining.delete(depKey)) continue; // this waiter didn't depend on it
      if (outcome !== "ok") {
        // blocked-by-failure — wait for the operator, don't cancel. story-vbkazs: a "cancelled"
        // predecessor is also ≠ "ok", so its dependents STAY HELD here (locked decision: a deliberate
        // operator cancel is INCOMPLETE work — it is never a green light to auto-release downstream).
        entry.failedDeps.add(depKey);
        continue;
      }
      if (entry.depsRemaining.size === 0 && entry.failedDeps.size === 0) {
        this.blocked.delete(entryKey);
        released.push(entry);
      }
    }
    return released;
  }

  /** Everything still waiting (observability + the enqueue_batch response). */
  listBlocked(): BlockedEntry[] {
    return [...this.blocked.values()];
  }

  /** Forget a card WITHOUT releasing it (e.g. force-cancelled). Idempotent. */
  forget(board: string, cardId: string): boolean {
    return this.blocked.delete(this.key(board, cardId));
  }

  /** Drop all entries (process reset / test isolation). */
  clear(): void {
    this.blocked.clear();
  }
}

/**
 * Detect a cycle over `nodes` given dependency `edges` (`from` must precede `to`), via a
 * three-color DFS. Returns the cycle path closing on itself (e.g. ["a","b","a"]) when one
 * exists, else null. Pure — the `enqueue_batch` tool calls it BEFORE registering anything so
 * a circular batch (A→B→A) is rejected with a descriptive error instead of wedging the graph.
 */
export function detectCycle(nodes: string[], edges: DepEdge[]): string[] | null {
  const adj = new Map<string, string[]>();
  const ensure = (n: string) => {
    if (!adj.has(n)) adj.set(n, []);
  };
  for (const n of nodes) ensure(n);
  for (const e of edges) {
    ensure(e.from);
    ensure(e.to);
    adj.get(e.from)!.push(e.to);
  }

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of adj.keys()) color.set(n, WHITE);
  const stack: string[] = [];
  let cycle: string[] | null = null;

  const dfs = (u: string): boolean => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        // back-edge to a node still on the stack → cycle from v … u, closed with v.
        cycle = [...stack.slice(stack.indexOf(v)), v];
        return true;
      }
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    stack.pop();
    return false;
  };

  for (const n of adj.keys()) {
    if (color.get(n) === WHITE && dfs(n)) break;
  }
  return cycle;
}

/**
 * Topological order (predecessors first) of `nodes` given `edges`, via Kahn's algorithm.
 * Independent nodes keep their `nodes` input order (stable). THROWS on a cycle — call
 * {@link detectCycle} first for the friendly message; this is the hard backstop.
 */
export function topologicalOrder(nodes: string[], edges: DepEdge[]): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const ensure = (n: string) => {
    if (!indeg.has(n)) {
      indeg.set(n, 0);
      adj.set(n, []);
    }
  };
  for (const n of nodes) ensure(n);
  for (const e of edges) {
    ensure(e.from);
    ensure(e.to);
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  const queue = [...indeg.keys()].filter((n) => (indeg.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj.get(u) ?? []) {
      const d = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, d);
      if (d === 0) queue.push(v);
    }
  }
  if (order.length !== indeg.size) {
    throw new Error("ciclo de dependências detectado — não há ordem topológica");
  }
  return order;
}

const KEY = Symbol.for("storymap.runner.depGraph");
const store = globalThis as unknown as { [KEY]?: DependencyGraph };

/** The process-global dependency graph (survives Next dev HMR; shared by engine + MCP tools). */
export function getDependencyGraph(): DependencyGraph {
  return (store[KEY] ??= new DependencyGraph());
}
