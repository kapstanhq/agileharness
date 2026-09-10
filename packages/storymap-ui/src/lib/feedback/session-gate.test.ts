// story-14xvpa passo 2 / issue #2 — as rotas de feedback saíram do portão; a sessão é verificada AQUI.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { hasBoardSession, readCookie, SESSION_REQUIRED_ERROR } from "./session-gate";

const SECRET = "segredo-de-sessao-de-teste-000000000001";
const TOKEN = "token-do-operador-de-teste-0000000000001";
const headers = (h: Record<string, string>) => new Headers(h);

describe("readCookie — um cookie pelo nome, sem decodificar", () => {
  it("acha o cookie entre vários, com espaços e ordem arbitrária", () => {
    expect(readCookie("a=1; ah_session=abc.def ; z=9", "ah_session")).toBe("abc.def");
  });
  it("nome exato: um cookie com prefixo parecido não conta", () => {
    expect(readCookie("ah_session_old=x; xah_session=y", "ah_session")).toBeUndefined();
  });
  it("vazio, ausente ou sem '=' ⇒ undefined", () => {
    expect(readCookie(null, "ah_session")).toBeUndefined();
    expect(readCookie("ah_session=", "ah_session")).toBeUndefined();
    expect(readCookie("garbage", "ah_session")).toBeUndefined();
  });
});

describe("hasBoardSession — a MESMA verifySession do middleware, lida do header Cookie", () => {
  beforeEach(() => {
    process.env.AGILEHARNESS_SESSION_SECRET = SECRET;
    process.env.AGILEHARNESS_AUTH_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.AGILEHARNESS_SESSION_SECRET;
    delete process.env.AGILEHARNESS_AUTH_TOKEN;
    vi.useRealTimers();
  });
  it("sessão assinada com os segredos do serviço ⇒ true", async () => {
    const v = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });
    expect(await hasBoardSession(headers({ cookie: `${SESSION_COOKIE}=${v}` }))).toBe(true);
  });
  it("sem cookie ⇒ false; cookie forjado ⇒ false", async () => {
    expect(await hasBoardSession(headers({}))).toBe(false);
    expect(await hasBoardSession(headers({ cookie: `${SESSION_COOKIE}=eyJleHAiOjl9.zzz` }))).toBe(false);
  });
  it("sessão expirada ⇒ false", async () => {
    const v = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN, ttlMs: 1000, now: 1_000_000 });
    expect(await hasBoardSession(headers({ cookie: `${SESSION_COOKIE}=${v}` }), process.env, 1_000_000 + 500)).toBe(true);
    expect(await hasBoardSession(headers({ cookie: `${SESSION_COOKIE}=${v}` }), process.env, 1_000_000 + 2000)).toBe(false);
  });
  it("serviço sem segredo na env TRANCA (fail-closed), mesmo com um cookie bem formado", async () => {
    const v = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });
    expect(await hasBoardSession(headers({ cookie: `${SESSION_COOKIE}=${v}` }), {})).toBe(false);
  });
  it("o texto da recusa é o do middleware — o cliente não distingue a camada", () => {
    expect(SESSION_REQUIRED_ERROR).toBe("não autenticado — faça login no AgileHarness");
  });
});

// A rota do SHOT, de ponta a ponta: a única leitura de screenshot da tela do operador.
describe("/api/feedback/shot — same-origin exige a sessão do operador nos DOIS métodos", () => {
  beforeEach(() => {
    process.env.AGILEHARNESS_SESSION_SECRET = SECRET;
    process.env.AGILEHARNESS_AUTH_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.AGILEHARNESS_SESSION_SECRET;
    delete process.env.AGILEHARNESS_AUTH_TOKEN;
    delete process.env.AGILEHARNESS_FEEDBACK_INGEST_TOKENS;
  });
  const sameOrigin = { origin: "http://board.local", host: "board.local", "sec-fetch-site": "same-origin" };
  it("POST same-origin SEM sessão ⇒ 401 antes de decodificar a imagem", async () => {
    const { POST } = await import("@/app/api/feedback/shot/route");
    const res = await POST(
      new Request("http://board.local/api/feedback/shot", {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin },
        body: JSON.stringify({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(SESSION_REQUIRED_ERROR);
  });
  it("POST same-origin COM sessão passa do portão (400 = chegou à validação da imagem)", async () => {
    const cookie = `${SESSION_COOKIE}=${await signSession({ sessionSecret: SECRET, operatorToken: TOKEN })}`;
    const { POST } = await import("@/app/api/feedback/shot/route");
    const res = await POST(
      new Request("http://board.local/api/feedback/shot", {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin, cookie },
        body: JSON.stringify({ dataUrl: "data:image/png;base64,AAAA" }),
      }),
    );
    expect(res.status).toBe(400);
  });
  it("GET same-origin SEM sessão ⇒ 401 (ninguém lê um screenshot do operador sem estar logado)", async () => {
    const { GET } = await import("@/app/api/feedback/shot/route");
    const res = await GET(
      new Request("http://board.local/api/feedback/shot?board=storymap&batch=ab12&file=shot-1.png", {
        method: "GET",
        headers: sameOrigin,
      }),
    );
    expect(res.status).toBe(401);
  });
  it("o relay (token, sem cookie, sem sessão na env) continua entrando pela própria lane", async () => {
    delete process.env.AGILEHARNESS_SESSION_SECRET;
    delete process.env.AGILEHARNESS_AUTH_TOKEN;
    process.env.AGILEHARNESS_FEEDBACK_INGEST_TOKENS = "acme:token-de-repasse-do-app-0001";
    const { POST } = await import("@/app/api/feedback/shot/route");
    const res = await POST(
      new Request("http://board.local/api/feedback/shot", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ah-ingest": "token-de-repasse-do-app-0001" },
        body: JSON.stringify({ dataUrl: "data:image/png;base64,AAAA" }),
      }),
    );
    expect(res.status).toBe(400); // passou da lane; recusado pela imagem inválida, não por sessão
  });
});
