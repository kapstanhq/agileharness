import { describe, expect, it } from "vitest";
import { DependencyGraph, detectCycle, topologicalOrder, type DepEdge } from "./dep-graph";
import type { BlockedEntry } from "./types";
import type { StatusDef } from "@/lib/storymap/types";

const codeDef: StatusDef = { id: "desenvolver", name: "Desenvolver" };

// Build a BlockedEntry waiting on `deps` ("board/cardId" keys). blockedSince is fixed so the
// tests never read the clock (deterministic).
function entry(board: string, cardId: string, deps: string[]): BlockedEntry {
  return {
    board,
    cardId,
    trigger: "harness-do",
    def: codeDef,
    depsRemaining: new Set(deps),
    failedDeps: new Set(),
    blockedSince: 0,
  };
}

describe("DependencyGraph — register / isBlocked / listBlocked", () => {
  it("registers an entry and reports it blocked", () => {
    const g = new DependencyGraph();
    g.register(entry("sm", "b", ["sm/a"]));
    expect(g.isBlocked("sm", "b")).toBe(true);
    expect(g.isBlocked("sm", "a")).toBe(false);
    expect(g.listBlocked().map((e) => e.cardId)).toEqual(["b"]);
  });

  it("forget() drops an entry without releasing it; clear() empties the graph", () => {
    const g = new DependencyGraph();
    g.register(entry("sm", "b", ["sm/a"]));
    g.register(entry("sm", "c", ["sm/a"]));
    expect(g.forget("sm", "b")).toBe(true);
    expect(g.forget("sm", "b")).toBe(false); // idempotent
    expect(g.isBlocked("sm", "b")).toBe(false);
    g.clear();
    expect(g.listBlocked()).toHaveLength(0);
  });
});

describe("DependencyGraph.onSettled — dependency resolution", () => {
  it("an unrelated settle is a no-op (resolve without matching deps)", () => {
    const g = new DependencyGraph();
    g.register(entry("sm", "b", ["sm/a"]));
    expect(g.onSettled("sm", "z", "ok")).toEqual([]); // nothing depended on z
    expect(g.isBlocked("sm", "b")).toBe(true); // b still waits for a
  });

  it("releases a single-dep entry when its predecessor settles ok", () => {
    const g = new DependencyGraph();
    g.register(entry("sm", "b", ["sm/a"]));
    const released = g.onSettled("sm", "a", "ok");
    expect(released.map((e) => e.cardId)).toEqual(["b"]);
    expect(g.isBlocked("sm", "b")).toBe(false); // removed from the graph on release
  });

  it("releases a multi-dep entry only after ALL predecessors settle ok", () => {
    const g = new DependencyGraph();
    g.register(entry("sm", "c", ["sm/a", "sm/b"]));
    expect(g.onSettled("sm", "a", "ok")).toEqual([]); // b still pending
    expect(g.isBlocked("sm", "c")).toBe(true);
    const released = g.onSettled("sm", "b", "ok");
    expect(released.map((e) => e.cardId)).toEqual(["c"]);
    expect(g.isBlocked("sm", "c")).toBe(false);
  });

  it("releases every waiter on the same predecessor at once", () => {
    const g = new DependencyGraph();
    g.register(entry("sm", "b", ["sm/a"]));
    g.register(entry("sm", "c", ["sm/a"]));
    const released = g.onSettled("sm", "a", "ok").map((e) => e.cardId).sort();
    expect(released).toEqual(["b", "c"]);
  });
});

describe("DependencyGraph.onSettled — terminal failure → blocked-by-failure", () => {
  it("a failed predecessor marks the dependent blocked-by-failure and never releases it", () => {
    const g = new DependencyGraph();
    g.register(entry("sm", "b", ["sm/a"]));
    const released = g.onSettled("sm", "a", "error");
    expect(released).toEqual([]); // NOT released
    expect(g.isBlocked("sm", "b")).toBe(true); // stays — awaits the operator
    const e = g.listBlocked()[0];
    expect([...e.failedDeps]).toEqual(["sm/a"]);
    expect(e.depsRemaining.size).toBe(0);
  });

  it("a later ok-settled dep does NOT release an entry already tainted by a failure", () => {
    const g = new DependencyGraph();
    g.register(entry("sm", "c", ["sm/a", "sm/b"]));
    expect(g.onSettled("sm", "a", "error")).toEqual([]); // a failed
    const released = g.onSettled("sm", "b", "ok"); // last dep ok, but failedDeps is non-empty
    expect(released).toEqual([]);
    expect(g.isBlocked("sm", "c")).toBe(true);
  });

  it.each(["error", "timeout", "exit", "oom-killed"] as const)(
    "treats outcome %s as a terminal failure",
    (outcome) => {
      const g = new DependencyGraph();
      g.register(entry("sm", "b", ["sm/a"]));
      expect(g.onSettled("sm", "a", outcome)).toEqual([]);
      expect(g.listBlocked()[0].failedDeps.has("sm/a")).toBe(true);
    },
  );
});

describe("detectCycle / topologicalOrder — DFS cycle guard", () => {
  const nodes = ["a", "b", "c"];

  it("returns null for an acyclic graph (A→B→C)", () => {
    const edges: DepEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    expect(detectCycle(nodes, edges)).toBeNull();
    expect(topologicalOrder(nodes, edges)).toEqual(["a", "b", "c"]);
  });

  it("detects a direct cycle (A→B→A) via DFS and reports the path", () => {
    const edges: DepEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];
    const cycle = detectCycle(["a", "b"], edges);
    expect(cycle).not.toBeNull();
    // the path closes on itself (first === last)
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(["a", "b"]));
  });

  it("detects a longer cycle (A→B→C→A)", () => {
    const edges: DepEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ];
    expect(detectCycle(nodes, edges)).not.toBeNull();
  });

  it("topologicalOrder throws on a cyclic graph", () => {
    const edges: DepEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];
    expect(() => topologicalOrder(["a", "b"], edges)).toThrow(/ciclo/);
  });

  it("topologicalOrder keeps independent nodes in input order", () => {
    expect(topologicalOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });
});
