import { describe, expect, it } from "vitest";
import { extractResult } from "./claude";

// extractResult unwraps `claude --output-format json`'s envelope. A regression here
// either surfaces an opaque/wrong error in the capture modal or — worse — feeds an
// error envelope to parseProposal as if it were a valid result.
describe("extractResult", () => {
  it("returns the .result string from a success envelope", () => {
    expect(extractResult('{"result":"a proposta","is_error":false}')).toBe("a proposta");
  });

  it("throws when the envelope is an error (is_error: true)", () => {
    expect(() => extractResult('{"result":"deu ruim","is_error":true}')).toThrow(/Claude retornou erro/);
  });

  it("throws on empty output", () => {
    expect(() => extractResult("   ")).toThrow(/não retornou saída/i);
  });

  it("falls through to the raw text when stdout is plain (non-JSON) text", () => {
    expect(extractResult("  resposta em texto puro  ")).toBe("resposta em texto puro");
  });

  it("falls through to the raw trimmed JSON when there is no `result` key", () => {
    expect(extractResult('{"foo":1}')).toBe('{"foo":1}');
  });

  it("falls through when `result` is present but not a string", () => {
    expect(extractResult('{"result":123}')).toBe('{"result":123}');
  });
});
