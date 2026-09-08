// ATAQUE (5) do action-guard: `next/headers` INDISPONÍVEL (story-rwlu34).
//
// Arquivo próprio porque o ataque é o MÓDULO não carregar — e isso tem de valer para o arquivo
// inteiro. Desfazer o mock no meio do `action-guard.test.ts` devolvia o `next/headers` REAL aos
// testes seguintes (que passavam por acidente, classificados como `in-process`), então a fronteira
// é o arquivo, não o `it`.
//
// O QUE ESTE TESTE IMPEDE: que "não consegui nem carregar o módulo que lê o cookie" seja lido como
// "não estou dentro de uma request" — o veredito que PERMITE. Um import que falha não estabelece
// fato nenhum sobre o chamador; a única resposta segura é recusar.

import { describe, expect, it, vi } from "vitest";
import { requireSession, resolveActionCaller, UnauthenticatedActionError } from "./action-guard";

vi.mock("next/headers", () => {
  throw new Error("Cannot find module 'next/headers' (simulado)");
});

describe("action-guard — next/headers indisponível", () => {
  it("recusa em vez de assumir chamada interna", async () => {
    await expect(resolveActionCaller()).resolves.toBeNull();
    await expect(requireSession("publishStagedAction")).rejects.toThrow(UnauthenticatedActionError);
  });

  it("a recusa nomeia o motivo (escopo não verificável), não 'sem sessão'", async () => {
    await expect(requireSession("deleteCardAction")).rejects.toMatchObject({
      code: "AH_ACTION_UNAUTHENTICATED",
      reason: "unverifiable-scope",
    });
  });
});
