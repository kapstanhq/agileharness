// O PORTÃO DENTRO DA AÇÃO, SOB ATAQUE (story-rwlu34).
//
// Cada `it` deste arquivo descreve um ATAQUE, não uma implementação: "o que um chamador da rede
// consegue fazer para ser classificado como o PRÓPRIO SERVIÇO". A pergunta importa porque a classe
// `in-process` PERMITE — e ela permite as 122 actions mutantes, inclusive apagar card, spawnar
// agente e publicar em produção.
//
// A superfície do ataque é estreita e específica: `resolveActionCaller` só decide "não estou dentro
// de uma request" a partir do que `cookies()` faz. O `cookies()` do Next 14.2.35 tem CINCO caminhos
// de throw, e apenas UM significa "fora de request". Os outros quatro acontecem DENTRO de um render
// (cache scope, `dynamic = "error"`, prerender PPR) ou nem chegam a `cookies()` (o import falhando)
// — e três deles são `Error` GENÉRICOS, indistinguíveis do primeiro pela classe. Por isso os erros
// destes testes não são escritos à mão: são produzidos chamando as FUNÇÕES REAIS do Next instalado
// (`getExpectedRequestStore`, `trackDynamicDataAccessed`). Um upgrade do Next que mude a forma de
// qualquer um desses sinais quebra ESTE arquivo — que é onde queremos descobrir, não em produção.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { cookies as cookiesDoNext } from "next/dist/server/request/cookies.js";
import ReactParaPostpone from "react";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { classifyScopeThrow, requireSession, resolveActionCaller, UnauthenticatedActionError } from "./action-guard";

/**
 * O que o `cookies()` falso faz nesta rodada. Um holder `vi.hoisted` porque a factory do `vi.mock`
 * é içada acima dos imports — e é a ÚNICA porta para mandar `cookies()` estourar com o objeto exato
 * que o Next estouraria.
 */
const stub = vi.hoisted(() => ({
  /** `cookies()` estoura nesta rodada? Flag separada do valor para `null`/`undefined` serem lançáveis. */
  throwing: false,
  /** o valor que `cookies()` lança. */
  thrown: undefined as unknown,
  /** o cookie de sessão que o request "carrega"; undefined = request sem cookie. */
  cookie: undefined as string | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: () => {
    if (stub.throwing) throw stub.thrown;
    return { get: (name: string) => (name === SESSION_COOKIE && stub.cookie ? { value: stub.cookie } : undefined) };
  },
}));

/** `cookies()` passa a estourar `value` — inclusive `null`/`undefined`, que são lançáveis em JS. */
function cookiesThrows(value: unknown): void {
  stub.throwing = true;
  stub.thrown = value;
}

/** O que a função REAL do Next lança naquele ramo — nunca uma cópia escrita à mão. */
function realThrow(run: () => void): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  throw new Error("premissa do teste falhou: o caminho do Next não lançou nada");
}

const ROTA = "/board/storymap/inbox";

/**
 * O throw REAL do `cookies()` do Next, sob o escopo que se quer exercitar.
 *
 * NO NEXT 15 OS CAMINHOS DE THROW MUDARAM DE CASA, e a mudança melhora este teste. No 14 eles moravam
 * em helpers (`getExpectedRequestStore`, `trackDynamicDataAccessed`) e o teste os chamava DIRETO —
 * o que exigia acreditar que o helper era o mesmo código que `cookies()` percorre. No 15 a lógica foi
 * EMBUTIDA em `server/request/cookies.js`: um `if (workStore.dynamicShouldError)`, um
 * `switch (workUnitStore.type)`, e o `throwForMissingRequestStore` no fim. Então agora o teste chama
 * o `cookies()` de verdade, e a fidelidade deixa de ser uma suposição.
 *
 * Por que espionar `getStore` em vez de `run()`: sob vitest o ALS do Next é o `FakeAsyncLocalStorage`,
 * cujo `run()` estoura com "Invariant: AsyncLocalStorage accessed in runtime where it is not
 * available" (MEDIDO no 15.5.21, como já era no 14). O spy troca SÓ a consulta ao escopo; todo o
 * corpo de `cookies()` — os `if`, o `switch`, a construção de cada erro — executa de verdade.
 */
function throwDoCookiesReal(work: unknown, unit: unknown): unknown {
  const a = vi.spyOn(workAsyncStorage, "getStore").mockReturnValue(work as never);
  const b = vi.spyOn(workUnitAsyncStorage, "getStore").mockReturnValue(unit as never);
  try {
    return realThrow(() => {
      cookiesDoNext();
    });
  } finally {
    a.mockRestore();
    b.mockRestore();
  }
}

const STRONG_SECRET = "s".repeat(40);
const STRONG_TOKEN = "t".repeat(40);

describe("action-guard — os cinco caminhos de throw do cookies()", () => {
  const savedSecret = process.env[SESSION_SECRET_ENV];
  const savedToken = process.env[TOKEN_ENV];

  beforeEach(() => {
    stub.throwing = false;
    stub.cookie = undefined;
    process.env[SESSION_SECRET_ENV] = STRONG_SECRET;
    process.env[TOKEN_ENV] = STRONG_TOKEN;
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env[SESSION_SECRET_ENV];
    else process.env[SESSION_SECRET_ENV] = savedSecret;
    if (savedToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = savedToken;
  });

  // ── o ÚNICO caminho que significa "fora de request" (autonomia: o serviço chamando a si mesmo) ──

  it("o serviço fora de qualquer request (tick, fs.watch, teste) segue passando como in-process", async () => {
    // O erro REAL que o `cookies()` do Next lança quando NÃO há store nenhum (o `throwForMissingRequestStore`
    // no fim da função) — é exatamente o que ele lança no tick do copiloto e no callback do fs.watch.
    // Este é o único caminho sem espião: sem store é o estado natural do processo de teste.
    cookiesThrows(realThrow(() => { cookiesDoNext(); }));
    await expect(resolveActionCaller()).resolves.toBe("in-process");
    await expect(requireSession("moveCardAction")).resolves.toBe("in-process");
  });

  // ── os caminhos que NÃO significam isso: todos têm de NEGAR ──────────────────────────────────────

  it("ataque (2): cookies() estourando dentro de unstable_cache não vira chamada interna", async () => {
    cookiesThrows(throwDoCookiesReal({ route: ROTA }, { type: "unstable-cache" }));
    await expect(resolveActionCaller()).resolves.toBeNull();
    await expect(requireSession("deleteCardAction")).rejects.toThrow(UnauthenticatedActionError);
  });

  it('ataque (3): rota com dynamic = "error" (StaticGenBailoutError) não vira chamada interna', async () => {
    cookiesThrows(throwDoCookiesReal({ route: ROTA, dynamicShouldError: true }, undefined));
    await expect(resolveActionCaller()).resolves.toBeNull();
    await expect(requireSession("deployAction")).rejects.toThrow(UnauthenticatedActionError);
  });

  it("ataque (4): o bail-out de prerender (PPR) não vira chamada interna", async () => {
    // PREMISSA EXPLÍCITA, E AUTO-INVALIDANTE. Com React 19 estável `unstable_postpone` NÃO existe
    // (MEDIDO: react 19.2.8 → `typeof React.unstable_postpone === "undefined"`), então o
    // `postponeWithTracking` do ramo `prerender-ppr` cai no `assertPostpone()` e o que sai é o
    // invariante — não o sinal de postpone. Continua sendo um throw REAL do caminho REAL nesta
    // configuração, que é o que o produto veria; e continua tendo de NEGAR. A asserção abaixo existe
    // para o dia em que alguém trocar o React por um que tenha postpone: aí a FORMA do erro muda, o
    // que este `it` alimenta deixa de ser o que produção veria, e o teste avisa em vez de mentir.
    expect(
      typeof (ReactParaPostpone as { unstable_postpone?: unknown }).unstable_postpone,
      "React ganhou unstable_postpone: o ramo PPR agora produz o sinal de postpone e não o invariante — " +
        "re-derive o que este teste alimenta antes de confiar nele",
    ).toBe("undefined");
    cookiesThrows(throwDoCookiesReal({ route: ROTA }, { type: "prerender-ppr", dynamicTracking: { dynamicAccesses: [] } }));
    await expect(resolveActionCaller()).resolves.toBeNull();
    await expect(requireSession("killProcessAction")).rejects.toThrow(UnauthenticatedActionError);
  });

  // ── DOIS CAMINHOS QUE O NEXT 15 ACRESCENTOU, e que a migração encontrou ──────────────────────────
  // Não são tradução do que existia: são ramos NOVOS de `cookies()` (server/request/cookies.js) que
  // lançam sem significar "fora de request". Entram aqui porque a régua deste arquivo é a CLASSE
  // ("todo throw que não seja o de request ausente NEGA"), e uma classe se defende enumerando o que
  // a versão corrente realmente produz — não o que a anterior produzia.

  it("ataque (7, novo no 15): cookies() dentro de after(...) não vira chamada interna", async () => {
    cookiesThrows(throwDoCookiesReal({ route: ROTA }, { type: "request", phase: "after" }));
    await expect(resolveActionCaller()).resolves.toBeNull();
    await expect(requireSession("deleteCardAction")).rejects.toThrow(UnauthenticatedActionError);
  });

  it("ataque (8, novo no 15): o InvariantError de prerender-client não vira chamada interna", async () => {
    cookiesThrows(throwDoCookiesReal({ route: ROTA }, { type: "prerender-client" }));
    await expect(resolveActionCaller()).resolves.toBeNull();
    await expect(requireSession("deployAction")).rejects.toThrow(UnauthenticatedActionError);
  });

  // ataque (5) — o import de `next/headers` falhando — mora em
  // `action-guard-headers-unavailable.test.ts`: ele exige que o módulo NUNCA carregue no arquivo
  // inteiro, e desfazer o mock no meio deste aqui deixaria os testes seguintes falando com o
  // `next/headers` de verdade (o que os fazia passar por acidente).

  it("ataque (6): um throw de forma DESCONHECIDA não vira chamada interna", async () => {
    // A regra é fail-closed por DEFAULT, não uma lista negra: qualquer coisa fora do sinal
    // reconhecido — um TypeError de um adapter quebrado, uma string, um `digest` que não é o do
    // Next, um `throw null` — NEGA. É esta linha de base que faz um Next futuro, com um caminho de
    // throw que ninguém enumerou ainda, nascer recusado em vez de nascer permitido.
    for (const thrown of [
      new TypeError("cookies is not a function"),
      "boom",
      { digest: "OUTRA_COISA" },
      new Error(`cookies foi chamado fora de request`), // a frase, mas sem o slug do doc do Next
      null,
      undefined,
    ]) {
      cookiesThrows(thrown);
      await expect(resolveActionCaller()).resolves.toBeNull();
    }
  });

  // ── o protocolo do Next que NÃO pode ser engolido ───────────────────────────────────────────────

  it("o bail-out DYNAMIC_SERVER_USAGE continua subindo intacto (não vira veredito nenhum)", async () => {
    // Se o guard engolisse este, a página seria congelada como estática e a ação passaria a rodar
    // sem nunca ver cookie. Ele é re-lançado para o Next fazer o que faria sem o guard.
    // No 15 quem produz o DYNAMIC_SERVER_USAGE é o ramo `prerender-legacy` do `cookies()`, via
    // `throwToInterruptStaticGeneration`. A asserção do digest logo abaixo é a prova de que este
    // teste continua alimentando o protocolo do framework, e não outro erro qualquer.
    const bailout = throwDoCookiesReal({ route: ROTA, isStaticGeneration: true }, { type: "prerender-legacy", revalidate: 10 });
    expect((bailout as { digest?: string }).digest).toBe("DYNAMIC_SERVER_USAGE");
    cookiesThrows(bailout);
    await expect(resolveActionCaller()).rejects.toBe(bailout);
  });

  // ── autonomia: os dois chamadores legítimos que NÃO são o processo ──────────────────────────────

  it("o agente headless (ator MCP no ALS) passa mesmo com cookies() estourando", async () => {
    cookiesThrows(throwDoCookiesReal({ route: ROTA }, { type: "unstable-cache" }));
    const caller = await runWithMcpActor({ level: "full" }, () => resolveActionCaller());
    expect(caller).toBe("mcp-token");
  });

  it("o operador com cookie assinado válido passa como operator-session", async () => {
    stub.cookie = await signSession({ sessionSecret: STRONG_SECRET, operatorToken: STRONG_TOKEN });
    await expect(resolveActionCaller()).resolves.toBe("operator-session");
  });

  it("um request HTTP SEM cookie válido é recusado (o anônimo da rede)", async () => {
    stub.cookie = undefined;
    await expect(resolveActionCaller()).resolves.toBeNull();
    stub.cookie = "forjado.assinatura-errada";
    await expect(resolveActionCaller()).resolves.toBeNull();
  });
});

// O kernel puro, testado direto porque DENTRO do vitest não existe request store para simular: o
// Next monta o `FakeAsyncLocalStorage` quando `globalThis.AsyncLocalStorage` não foi injetado (o
// polyfill mora em `dist/server/node-environment.js`, que só o servidor carrega), e o fake devolve
// `undefined` em todo `getStore()` e ESTOURA em `run()`. A combinação mais perigosa — "o ALS diz que
// HÁ request e ainda assim `cookies()` estourou" — só é expressável aqui.
describe("classifyScopeThrow — o veredito exige TRÊS fatos concordando", () => {
  /** O sinal REAL de "fora de request scope" do Next instalado. */
  const outsideScope = realThrow(() => {
    cookiesDoNext();
  });

  it("o sinal do Next com os dois stores AUSENTES é a única porta para in-process", () => {
    expect(classifyScopeThrow({ thrown: outsideScope, hasRequestStore: false, hasStaticStore: false })).toBe(
      "outside-request",
    );
  });

  it("o mesmo sinal com os oráculos INDISPONÍVEIS ainda passa (a forma do erro sustenta sozinha)", () => {
    // Um oráculo que não pôde ser consultado responde `null` = "não sei", nunca `false`. Se "não sei"
    // trancasse, um upgrade que renomeasse o módulo do ALS mataria o tick do copiloto — capacidade
    // perdida por um detalhe de bundling.
    expect(classifyScopeThrow({ thrown: outsideScope, hasRequestStore: null, hasStaticStore: null })).toBe(
      "outside-request",
    );
  });

  it("ATAQUE: o ALS diz que HÁ request e cookies() estourou o sinal de 'sem request' ⇒ NEGA", () => {
    // Contradição entre dois oráculos nunca vira permissão. É o caminho de um throw que acontece
    // ANTES de o Next procurar o request store (trackDynamicDataAccessed) com request VIVO.
    expect(classifyScopeThrow({ thrown: outsideScope, hasRequestStore: true, hasStaticStore: false })).toBe(
      "unverifiable",
    );
  });

  it("ATAQUE: dentro de um render/cache scope (staticGenerationStore vivo) ⇒ NEGA", () => {
    expect(classifyScopeThrow({ thrown: outsideScope, hasRequestStore: false, hasStaticStore: true })).toBe(
      "unverifiable",
    );
  });

  it("o bail-out dinâmico é protocolo do framework mesmo com request vivo (re-lançar, não classificar)", () => {
    const bailout = throwDoCookiesReal({ route: ROTA, isStaticGeneration: true }, { type: "prerender-legacy", revalidate: 10 });
    expect(classifyScopeThrow({ thrown: bailout, hasRequestStore: true, hasStaticStore: true })).toBe(
      "framework-signal",
    );
  });

  it("nenhum dos outros throws REAIS do cookies() prova ausência de request", () => {
    const attacks = [
      throwDoCookiesReal({ route: ROTA }, { type: "unstable-cache" }),
      throwDoCookiesReal({ route: ROTA, dynamicShouldError: true }, undefined),
      throwDoCookiesReal({ route: ROTA }, { type: "prerender-ppr", dynamicTracking: { dynamicAccesses: [] } }),
      throwDoCookiesReal({ route: ROTA }, { type: "request", phase: "after" }),
      throwDoCookiesReal({ route: ROTA }, { type: "prerender-client" }),
    ];
    for (const thrown of attacks) {
      // Com TODOS os fatos do lado do atacante (oráculos indisponíveis), a forma do erro segura.
      expect(classifyScopeThrow({ thrown, hasRequestStore: null, hasStaticStore: null })).toBe("unverifiable");
    }
  });
});
