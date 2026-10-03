import { describe, expect, it } from "vitest";

import { generateSecret, isOperatorTokenValid, MIN_OPERATOR_TOKEN_LEN } from "@/lib/auth/token";

const GOOD = "t".repeat(MIN_OPERATOR_TOKEN_LEN);

describe("token do operador", () => {
  it("aceita o token exato", () => {
    expect(isOperatorTokenValid(GOOD, GOOD)).toBe(true);
  });

  it("recusa token errado do mesmo tamanho", () => {
    expect(isOperatorTokenValid(`${"t".repeat(MIN_OPERATOR_TOKEN_LEN - 1)}X`, GOOD)).toBe(false);
  });

  it("recusa prefixo e sufixo — comparação não é por 'começa com'", () => {
    expect(isOperatorTokenValid(GOOD.slice(0, -1), GOOD)).toBe(false);
    expect(isOperatorTokenValid(`${GOOD}extra`, GOOD)).toBe(false);
  });

  it("FAIL-CLOSED quando o serviço não tem token configurado", () => {
    // Sem isto, uma instalação sem token autenticaria contra "" e abriria para qualquer um.
    for (const expected of [undefined, "", "curto", "x".repeat(MIN_OPERATOR_TOKEN_LEN - 1)]) {
      expect(isOperatorTokenValid("", expected)).toBe(false);
      expect(isOperatorTokenValid(GOOD, expected)).toBe(false);
      expect(isOperatorTokenValid(expected ?? "", expected)).toBe(false);
    }
  });

  it("o segredo gerado tem entropia suficiente e passa o próprio piso", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(MIN_OPERATOR_TOKEN_LEN);
    // base64url — seguro para colar em URL, env e arquivo sem escaping.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(isOperatorTokenValid(a, a)).toBe(true);
  });
});
