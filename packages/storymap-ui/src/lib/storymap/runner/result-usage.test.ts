import { describe, expect, it } from "vitest";
import { extractResultUsage } from "./stream-json";

describe("extractResultUsage", () => {
  it("pulls cost + summed tokens + turns from a result event, splitting input/output", () => {
    const ev = {
      type: "result",
      total_cost_usd: 0.1234,
      num_turns: 7,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 },
    };
    // tokens = soma dos quatro (inalterado); inputTokens = input + cacheCreation + cacheRead; outputTokens = output só.
    expect(extractResultUsage(ev)).toEqual({
      costUSD: 0.1234,
      tokens: 135,
      numTurns: 7,
      inputTokens: 115,
      outputTokens: 20,
    });
  });

  it("returns null for non-result events / non-objects", () => {
    expect(extractResultUsage({ type: "assistant" })).toBeNull();
    expect(extractResultUsage({ type: "system", subtype: "init" })).toBeNull();
    expect(extractResultUsage(null)).toBeNull();
    expect(extractResultUsage("x")).toBeNull();
  });

  it("degrades each field independently when usage/cost is missing", () => {
    expect(extractResultUsage({ type: "result" })).toEqual({
      costUSD: null,
      tokens: null,
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
    });
    expect(extractResultUsage({ type: "result", total_cost_usd: 0 })).toEqual({
      costUSD: 0,
      tokens: null,
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
    });
    expect(extractResultUsage({ type: "result", usage: {} })).toEqual({
      costUSD: null,
      tokens: null,
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("reports inputTokens with output absent and vice-versa (independent degradation)", () => {
    expect(extractResultUsage({ type: "result", usage: { input_tokens: 8, cache_read_input_tokens: 2 } })).toEqual({
      costUSD: null,
      tokens: 10,
      numTurns: null,
      inputTokens: 10,
      outputTokens: null,
    });
    expect(extractResultUsage({ type: "result", usage: { output_tokens: 42 } })).toEqual({
      costUSD: null,
      tokens: 42,
      numTurns: null,
      inputTokens: null,
      outputTokens: 42,
    });
  });
});
