import { afterEach, describe, expect, it } from "vitest";
import { logHumanActionAction } from "./audit-actions";
import { resetAgentActionSink, setAgentActionSink, type AgentAction } from "@/lib/storymap/runner/agent-actions";

afterEach(() => resetAgentActionSink());

// appendAgentAction is fire-and-forget (chained onto a resolved writeChain via a microtask), so give the
// serialized write a tick to land before asserting.
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("logHumanActionAction (D7 human-click trail)", () => {
  it("writes one ledger line with actor human:<surface> after a sensitive click", async () => {
    const lines: string[] = [];
    setAgentActionSink({ append: async (l) => { lines.push(l); } });

    const res = await logHumanActionAction({
      surface: "kanban",
      tool: "resolveMergeConflictAction",
      cls: "merge-resolve",
      boardId: "storymap",
      cardId: "c1",
      note: "resolve-merge:merged",
    });
    expect(res).toEqual({ ok: true });

    await flush();
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as AgentAction;
    expect(rec.actor).toBe("human:kanban");
    expect(rec.cls).toBe("merge-resolve");
    expect(rec.tool).toBe("resolveMergeConflictAction");
    expect(rec.disposition).toBe("auto");
    expect(rec.outcome).toBe("executed");
    expect(rec.board).toBe("storymap");
    expect(rec.note).toContain("card=c1");
  });

  it("sanitizes a hostile surface to 'unknown' before it becomes the actor", async () => {
    const lines: string[] = [];
    setAgentActionSink({ append: async (l) => { lines.push(l); } });
    await logHumanActionAction({ surface: "Bad Surface!!", tool: "x", cls: "run" });
    await flush();
    expect(JSON.parse(lines[0]).actor).toBe("human:unknown");
  });

  it("never rejects even when the sink throws (fail-open ledger — README risk 1)", async () => {
    setAgentActionSink({ append: async () => { throw new Error("disk full"); } });
    await expect(logHumanActionAction({ surface: "kanban", tool: "x", cls: "deploy" })).resolves.toEqual({ ok: true });
    await flush();
  });
});
