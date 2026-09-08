import { describe, it, expect } from "vitest";
import { isMcpTokenValid, MIN_TOKEN_LEN } from "./auth";

// A realistic 43-char base64url token (what the generator emits).
const GOOD = "BmO3T4aa7PEw6NxIST7aIJfg8iEBFws8OAxLPjB4khY";

describe("isMcpTokenValid — fail-closed posture", () => {
  it("refuses when the expected secret is undefined", () => {
    expect(isMcpTokenValid(GOOD, undefined)).toBe(false);
  });

  it("refuses when the expected secret is empty", () => {
    expect(isMcpTokenValid(GOOD, "")).toBe(false);
  });

  it("refuses a weak expected secret below the minimum length", () => {
    const weak = "x".repeat(MIN_TOKEN_LEN - 1);
    // Even an EXACT match against a too-short secret must not authenticate.
    expect(isMcpTokenValid(weak, weak)).toBe(false);
  });

  it("authenticates an expected secret at exactly the minimum length", () => {
    // story-7q83gx — o piso deixou de ser só COMPRIMENTO. Este caso mede o comprimento mínimo com
    // entropia real (o que um gerador emite), porque é isso que tem de continuar autenticando.
    const min = GOOD.slice(0, MIN_TOKEN_LEN);
    expect(min).toHaveLength(MIN_TOKEN_LEN);
    expect(isMcpTokenValid(min, min)).toBe(true);
  });

  it("refuses a DEGENERATE expected secret even at/above the minimum length", () => {
    // A asserção que este caso substituiu dizia que `"y".repeat(MIN_TOKEN_LEN)` autenticava — ela
    // fixava por escrito o buraco do story-7q83gx: o segredo MAIS exposto do sistema (endpoint MCP
    // na internet pública, tools que rodam `claude --dangerously-skip-permissions`) aceitando uma
    // string que um humano digita de memória. Comprimento nunca foi prova de imprevisibilidade.
    for (const degenerado of ["y".repeat(MIN_TOKEN_LEN), "y".repeat(64), "abcdefgh".repeat(5)]) {
      expect(isMcpTokenValid(degenerado, degenerado)).toBe(false);
    }
  });
});

describe("isMcpTokenValid — comparison", () => {
  it("accepts an exact match of a strong token", () => {
    expect(isMcpTokenValid(GOOD, GOOD)).toBe(true);
  });

  it("rejects a wrong token of the SAME length", () => {
    const wrong = "A" + GOOD.slice(1); // same length, first char differs
    expect(wrong.length).toBe(GOOD.length);
    expect(isMcpTokenValid(wrong, GOOD)).toBe(false);
  });

  it("rejects a token that is a prefix of the secret (length mismatch)", () => {
    expect(isMcpTokenValid(GOOD.slice(0, GOOD.length - 1), GOOD)).toBe(false);
  });

  it("rejects a token that is the secret plus extra (length mismatch)", () => {
    expect(isMcpTokenValid(GOOD + "z", GOOD)).toBe(false);
  });

  it("rejects an empty provided token against a valid secret", () => {
    expect(isMcpTokenValid("", GOOD)).toBe(false);
  });
});
