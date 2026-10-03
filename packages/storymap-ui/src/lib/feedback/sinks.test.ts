import { describe, expect, it } from "vitest";
import { coerceAnnotationBatch } from "./schema";
import { type SinkDeps, pickSink } from "./sinks";

function fakeDeps() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const deps: SinkDeps = {
    reportIssue: async (input) => {
      calls.push(["reportIssue", input]);
      return { ok: true, data: { card: { id: "story-new1" } } };
    },
    refineCard: async (input) => {
      calls.push(["refineCard", input]);
      return { ok: true, data: { card: { id: String(input.cardId) } } };
    },
    sendToTerminal: async (input) => {
      calls.push(["sendToTerminal", input]);
      return { ok: true };
    },
  };
  return { calls, deps };
}

describe("feedback sinks (broker routing)", () => {
  it("routes an unlinked batch to triage and returns the created card id", async () => {
    const b = coerceAnnotationBatch({ link: { board: "storymap" }, pins: [{ note: "x", anchor: { selector: "a.b" } }] });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const sink = pickSink(b.batch);
    expect(sink?.id).toBe("triage");
    const { calls, deps } = fakeDeps();
    const res = await sink!.run(b.batch, deps);
    expect(res.ok).toBe(true);
    expect(res.cardId).toBe("story-new1");
    expect(calls[0][0]).toBe("reportIssue");
    expect(String(calls[0][1].text)).toContain("a.b");
    expect(String(calls[0][1].boardId)).toBe("storymap");
  });

  it("routes a card-linked batch to refine (reopens the SAME card, brief carries the selector)", async () => {
    const b = coerceAnnotationBatch({
      link: { kind: "card", board: "storymap", cardId: "story-z" },
      pins: [{ note: "mudar CTA", anchor: { selector: "main > button.cta", text: "Ir" } }],
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const sink = pickSink(b.batch);
    expect(sink?.id).toBe("refine");
    const { calls, deps } = fakeDeps();
    const res = await sink!.run(b.batch, deps);
    expect(res.ok).toBe(true);
    expect(res.cardId).toBe("story-z"); // attached to the SAME card, not a new one
    expect(calls[0][0]).toBe("refineCard");
    const arg = calls[0][1] as Record<string, unknown>;
    expect(arg.cardId).toBe("story-z");
    expect(String(arg.brief)).toContain("main > button.cta");
  });

  it("falls back to triage when the refine can't apply (feedback not lost)", async () => {
    const b = coerceAnnotationBatch({
      link: { kind: "card", board: "storymap", cardId: "story-z" },
      pins: [{ note: "x", anchor: { selector: "#h" } }],
    });
    if (!b.ok) return;
    const calls: Array<[string, Record<string, unknown>]> = [];
    const deps: SinkDeps = {
      refineCard: async (input) => {
        calls.push(["refineCard", input]);
        return { ok: false, error: "Só stories podem ser refinadas." };
      },
      reportIssue: async (input) => {
        calls.push(["reportIssue", input]);
        return { ok: true, data: { card: { id: "story-triage9" } } };
      },
      sendToTerminal: async () => ({ ok: true }),
    };
    const res = await pickSink(b.batch)!.run(b.batch, deps);
    expect(res.ok).toBe(true);
    expect(res.cardId).toBe("story-triage9");
    expect(calls.map((c) => c[0])).toEqual(["refineCard", "reportIssue"]);
  });

  it("routes a session-linked batch to the terminal (claude_send round-trip)", async () => {
    const b = coerceAnnotationBatch({
      link: { kind: "session", board: "storymap", sessionId: "sess-abc" },
      pins: [{ note: "ajustar isso", anchor: { selector: "header .logo" } }],
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const sink = pickSink(b.batch);
    expect(sink?.id).toBe("terminal");
    const { calls, deps } = fakeDeps();
    const res = await sink!.run(b.batch, deps);
    expect(res.ok).toBe(true);
    expect(calls[0][0]).toBe("sendToTerminal");
    const arg = calls[0][1] as Record<string, unknown>;
    expect(arg.sessionId).toBe("sess-abc");
    expect(String(arg.text)).toContain("header .logo");
  });

  it("surfaces a sink failure detail instead of throwing", async () => {
    const b = coerceAnnotationBatch({ link: { board: "storymap" }, pins: [{ note: "y", anchor: { selector: "#h" } }] });
    if (!b.ok) return;
    const deps: SinkDeps = {
      reportIssue: async () => ({ ok: false, error: "triagem indisponível" }),
      refineCard: async () => ({ ok: true, data: { card: { id: "x" } } }),
      sendToTerminal: async () => ({ ok: true }),
    };
    const res = await pickSink(b.batch)!.run(b.batch, deps);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("triagem indisponível");
  });

  it("has no sink for a batch missing a board (nothing can accept it)", async () => {
    const b = coerceAnnotationBatch({ link: {}, pins: [{ note: "y", anchor: { selector: "#h" } }] });
    if (!b.ok) return;
    expect(pickSink(b.batch)).toBeNull();
  });
});
