import { describe, expect, it } from "vitest";

import { MIN_SESSION_SECRET_LEN, signSession, verifySession } from "@/lib/auth/session";

const SECRET = "s".repeat(MIN_SESSION_SECRET_LEN);
const OTHER_SECRET = "o".repeat(MIN_SESSION_SECRET_LEN);
const TOKEN = "t".repeat(MIN_SESSION_SECRET_LEN);
const OTHER_TOKEN = "u".repeat(MIN_SESSION_SECRET_LEN);

const sign = (o: Partial<Parameters<typeof signSession>[0]> = {}) =>
  signSession({ sessionSecret: SECRET, operatorToken: TOKEN, now: 1_000, ...o });
const verify = (token: string | null | undefined, o: Partial<Parameters<typeof verifySession>[0]> = {}) =>
  verifySession({ token, sessionSecret: SECRET, operatorToken: TOKEN, now: 2_000, ...o });

describe("cookie de sessão", () => {
  it("assina e verifica um round-trip", async () => {
    expect(await verify(await sign())).toBe(true);
  });

  it("recusa depois de expirar", async () => {
    const token = await sign({ ttlMs: 100 });
    expect(await verify(token, { now: 1_050 })).toBe(true);
    expect(await verify(token, { now: 1_101 })).toBe(false);
  });

  it("ROTACIONAR O TOKEN DO OPERADOR derruba as sessões vivas", async () => {
    // O ponto todo: quem troca o token está reagindo a um vazamento. Se o cookie sobrevivesse à
    // troca, o atacante continuaria dentro e o operador acharia que revogou o acesso.
    const token = await sign();
    expect(await verify(token)).toBe(true);
    expect(await verify(token, { operatorToken: OTHER_TOKEN })).toBe(false);
  });

  it("rotacionar o segredo de sessão também derruba", async () => {
    const token = await sign();
    expect(await verify(token, { sessionSecret: OTHER_SECRET })).toBe(false);
  });

  it("recusa payload adulterado (esticar o exp exige a chave)", async () => {
    const token = await sign({ ttlMs: 100 });
    const forgedPayload = Buffer.from(JSON.stringify({ exp: 9_999_999_999 })).toString("base64url");
    expect(await verify(`${forgedPayload}.${token.split(".")[1]}`)).toBe(false);
  });

  it("recusa assinatura adulterada", async () => {
    const token = await sign();
    const [payload, sig] = token.split(".");
    const flipped = `${sig.slice(0, -1)}${sig.at(-1) === "A" ? "B" : "A"}`;
    expect(await verify(`${payload}.${flipped}`)).toBe(false);
  });

  it("fail-closed em entrada malformada — nunca lança para o middleware", async () => {
    for (const bad of [undefined, null, "", "semponto", ".", "a.", ".b", "$$$.###", "a.b.c"]) {
      expect(await verify(bad)).toBe(false);
    }
  });

  it("fail-closed com segredo OU token fraco — serviço mal configurado tranca, não abre", async () => {
    const weak = "x".repeat(MIN_SESSION_SECRET_LEN - 1);
    await expect(sign({ sessionSecret: weak })).rejects.toThrow();
    await expect(sign({ operatorToken: weak })).rejects.toThrow();

    const token = await sign();
    expect(await verify(token, { sessionSecret: weak })).toBe(false);
    expect(await verify(token, { operatorToken: weak })).toBe(false);
    expect(await verify(token, { sessionSecret: "" })).toBe(false);
    expect(await verify(token, { operatorToken: "" })).toBe(false);
  });

  it("o separador da chave não deixa dois pares distintos colidirem", async () => {
    // Sem separador, ("ab","c") e ("a","bc") gerariam o MESMO material de chave e um cookie
    // assinado sob um par validaria sob o outro.
    const a = await signSession({ sessionSecret: `${SECRET}X`, operatorToken: TOKEN, now: 1_000 });
    const okCross = await verifySession({
      token: a,
      sessionSecret: SECRET,
      operatorToken: `X${TOKEN}`,
      now: 2_000,
    });
    expect(okCross).toBe(false);
  });
});
