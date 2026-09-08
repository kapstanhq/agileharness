import { describe, expect, it } from "vitest";
import { createNdjsonParser, extractFinalResult, extractSpecialistDelegations, extractToolNames, isMaxTurnsResult, summarizeStreamEvent } from "./stream-json";
import { newRunSessionId } from "./session-id";

describe("createNdjsonParser — line-buffered NDJSON", () => {
  it("reassembles a JSON object split across chunks", () => {
    const seen: unknown[] = [];
    const p = createNdjsonParser((o) => seen.push(o));
    p.feed('{"type":"sys');
    p.feed('tem","subtype":"init"}\n');
    expect(seen).toEqual([{ type: "system", subtype: "init" }]);
  });

  it("emits multiple objects from one chunk and ignores blank lines", () => {
    const seen: unknown[] = [];
    const p = createNdjsonParser((o) => seen.push(o));
    p.feed('{"a":1}\n\n{"b":2}\n');
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("flush() drains a trailing line without a newline", () => {
    const seen: unknown[] = [];
    const p = createNdjsonParser((o) => seen.push(o));
    p.feed('{"c":3}');
    expect(seen).toEqual([]);
    p.flush();
    expect(seen).toEqual([{ c: 3 }]);
  });

  it("silently ignores non-JSON interleaved lines", () => {
    const seen: unknown[] = [];
    const p = createNdjsonParser((o) => seen.push(o));
    p.feed("plain text noise\n");
    p.feed('{"ok":true}\n');
    expect(seen).toEqual([{ ok: true }]);
  });
});

describe("extractToolNames — capability capture source", () => {
  it("returns every tool_use name in an assistant event (full mcp names included)", () => {
    expect(
      extractToolNames({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "vou checar" },
            { type: "tool_use", name: "mcp__graphify__get_pr_impact", input: {} },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    ).toEqual(["mcp__graphify__get_pr_impact", "Bash"]);
  });

  it("returns [] for non-assistant / malformed events (defensive)", () => {
    expect(extractToolNames({ type: "result", subtype: "success" })).toEqual([]);
    expect(extractToolNames({ type: "assistant", message: { content: "nope" } })).toEqual([]);
    expect(extractToolNames(null)).toEqual([]);
    expect(extractToolNames({ type: "assistant", message: { content: [{ type: "tool_use" }] } })).toEqual([]);
  });
});

describe("extractSpecialistDelegations — Task subagent_type capture (WS4)", () => {
  it("captures the subagent_type of each Task tool_use, ignoring other tools", () => {
    expect(
      extractSpecialistDelegations({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Task", input: { subagent_type: "security-reviewer", prompt: "x" } },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", name: "Task", input: { subagent_type: "performance-auditor" } },
          ],
        },
      }),
    ).toEqual(["security-reviewer", "performance-auditor"]);
  });

  it("returns [] for non-assistant / non-Task / missing subagent_type (defensive)", () => {
    expect(extractSpecialistDelegations({ type: "result" })).toEqual([]);
    expect(extractSpecialistDelegations({ type: "assistant", message: { content: [{ type: "tool_use", name: "Task", input: {} }] } })).toEqual([]);
    expect(extractSpecialistDelegations({ type: "assistant", message: { content: [{ type: "tool_use", name: "Workflow", input: { subagent_type: "x" } }] } })).toEqual([]);
    expect(extractSpecialistDelegations(null)).toEqual([]);
  });
});

describe("summarizeStreamEvent — event → console line", () => {
  it("maps a system init", () => {
    expect(summarizeStreamEvent({ type: "system", subtype: "init", model: "opus" })).toEqual({
      level: "system",
      text: "▶ sessão iniciada (opus)",
    });
  });

  it("maps assistant text and tool_use blocks", () => {
    expect(
      summarizeStreamEvent({ type: "assistant", message: { content: [{ type: "text", text: "olá" }] } }),
    ).toEqual({ level: "info", text: "olá" });

    const tool = summarizeStreamEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
    });
    expect(tool?.level).toBe("info");
    expect(tool?.text).toContain("🔧 Bash");
    expect(tool?.text).toContain("ls -la");
  });

  it("maps result success and error", () => {
    expect(summarizeStreamEvent({ type: "result", subtype: "success", num_turns: 3, total_cost_usd: 0.12 })).toEqual({
      level: "result",
      text: "✓ concluído · 3 turns · $0.120",
    });
    expect(summarizeStreamEvent({ type: "result", is_error: true, subtype: "error_during_execution" })?.level).toBe(
      "error",
    );
  });

  it("skips noisy token deltas and unknown shapes", () => {
    expect(summarizeStreamEvent({ type: "stream_event", event: { delta: { text: "x" } } })).toBeNull();
    expect(summarizeStreamEvent(null)).toBeNull();
    expect(summarizeStreamEvent({ type: "user" })).toBeNull();
  });
});

describe("newRunSessionId — fresh per run", () => {
  it("is unique across calls (so a re-run never collides with --session-id)", () => {
    expect(newRunSessionId()).not.toBe(newRunSessionId());
  });

  it("has the UUID shape the CLI accepts for --session-id", () => {
    expect(newRunSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("isMaxTurnsResult — the resumable max-turns stop signal (story-9s52tu HALF B)", () => {
  it("is TRUE for the result event whose subtype is error_max_turns (the --max-turns cap stop)", () => {
    expect(isMaxTurnsResult({ type: "result", subtype: "error_max_turns", is_error: true })).toBe(true);
  });

  it("is FALSE for a successful result", () => {
    expect(isMaxTurnsResult({ type: "result", subtype: "success" })).toBe(false);
  });

  it("is FALSE for a genuine execution error (force-deleted, NOT resumed)", () => {
    expect(isMaxTurnsResult({ type: "result", subtype: "error_during_execution", is_error: true })).toBe(false);
  });

  it("is FALSE for non-result events and junk (degrades gracefully — never false-positive)", () => {
    expect(isMaxTurnsResult({ type: "assistant", subtype: "error_max_turns" })).toBe(false); // wrong type
    expect(isMaxTurnsResult({ type: "system", subtype: "init" })).toBe(false);
    expect(isMaxTurnsResult(null)).toBe(false);
    expect(isMaxTurnsResult("error_max_turns")).toBe(false);
    expect(isMaxTurnsResult(undefined)).toBe(false);
  });
});

describe("extractFinalResult — the structured run tail (story-harness-cc #4)", () => {
  it("captures finalText + subtype + cost + turns from a success result event", () => {
    expect(
      extractFinalResult({
        type: "result",
        subtype: "success",
        result: "  Done: implemented the feature and the tests are green.  ",
        total_cost_usd: 0.42,
        num_turns: 7,
      }),
    ).toEqual({ finalText: "Done: implemented the feature and the tests are green.", subtype: "success", cost: 0.42, turns: 7 });
  });

  it("captures the stop subtype even with no final text (e.g. a max-turns stop)", () => {
    expect(extractFinalResult({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 50 })).toEqual({
      subtype: "error_max_turns",
      turns: 50,
    });
  });

  it("omits an empty/blank finalText (no noise in the return channel)", () => {
    expect(extractFinalResult({ type: "result", subtype: "success", result: "   " })).toEqual({ subtype: "success" });
  });

  it("is null for non-result events and junk (only the terminal result carries the tail)", () => {
    expect(extractFinalResult({ type: "assistant", message: { content: [] } })).toBeNull();
    expect(extractFinalResult({ type: "system", subtype: "init" })).toBeNull();
    expect(extractFinalResult(null)).toBeNull();
    expect(extractFinalResult(undefined)).toBeNull();
  });
});
