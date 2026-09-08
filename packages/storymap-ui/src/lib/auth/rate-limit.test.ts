import { describe, expect, it } from "vitest";

import {
  checkAttempt,
  clientKey,
  LOGIN_POLICY,
  pruneAttempts,
  recordFailure,
  recordSuccess,
  type AttemptRecord,
} from "@/lib/auth/rate-limit";

const state = () => new Map<string, AttemptRecord>();

describe("trava de força-bruta do login", () => {
  it("bloqueia na enésima falha e informa quanto falta", () => {
    const s = state();
    for (let i = 1; i < LOGIN_POLICY.maxFailures; i += 1) {
      const v = recordFailure(s, "ip", 1_000, LOGIN_POLICY);
      expect(v.allowed).toBe(true);
      expect(v.remaining).toBe(LOGIN_POLICY.maxFailures - i);
    }
    const last = recordFailure(s, "ip", 1_000, LOGIN_POLICY);
    expect(last.allowed).toBe(false);
    expect(last.retryAfterMs).toBe(LOGIN_POLICY.lockoutMs);
    expect(checkAttempt(s, "ip", 1_000, LOGIN_POLICY).allowed).toBe(false);
  });

  it("libera quando o bloqueio expira — e NÃO re-bloqueia na primeira tentativa seguinte", () => {
    const s = state();
    for (let i = 0; i < LOGIN_POLICY.maxFailures; i += 1) recordFailure(s, "ip", 1_000, LOGIN_POLICY);
    const after = 1_000 + LOGIN_POLICY.lockoutMs + 1;
    expect(checkAttempt(s, "ip", after, LOGIN_POLICY).allowed).toBe(true);
    // Se o histórico sobrevivesse ao lockout, esta única falha re-bloquearia na hora.
    const v = recordFailure(s, "ip", after, LOGIN_POLICY);
    expect(v.allowed).toBe(true);
    expect(v.remaining).toBe(LOGIN_POLICY.maxFailures - 1);
  });

  it("esquece falhas que saíram da janela", () => {
    const s = state();
    recordFailure(s, "ip", 1_000, LOGIN_POLICY);
    recordFailure(s, "ip", 1_000, LOGIN_POLICY);
    const later = 1_000 + LOGIN_POLICY.windowMs + 1;
    expect(checkAttempt(s, "ip", later, LOGIN_POLICY).remaining).toBe(LOGIN_POLICY.maxFailures);
  });

  it("um acerto zera a contagem", () => {
    const s = state();
    recordFailure(s, "ip", 1_000, LOGIN_POLICY);
    recordSuccess(s, "ip");
    expect(checkAttempt(s, "ip", 1_000, LOGIN_POLICY).remaining).toBe(LOGIN_POLICY.maxFailures);
  });

  it("as travas são independentes por chave", () => {
    const s = state();
    for (let i = 0; i < LOGIN_POLICY.maxFailures; i += 1) recordFailure(s, "atacante", 1_000, LOGIN_POLICY);
    expect(checkAttempt(s, "atacante", 1_000, LOGIN_POLICY).allowed).toBe(false);
    expect(checkAttempt(s, "operador", 1_000, LOGIN_POLICY).allowed).toBe(true);
  });

  it("NÃO isenta loopback — a lição do ClawJacked", () => {
    const s = state();
    for (let i = 0; i < LOGIN_POLICY.maxFailures; i += 1) recordFailure(s, "127.0.0.1", 1_000, LOGIN_POLICY);
    expect(checkAttempt(s, "127.0.0.1", 1_000, LOGIN_POLICY).allowed).toBe(false);
  });

  it("prune descarta chaves ociosas mas preserva bloqueio vivo", () => {
    const s = state();
    // Os dois relógios PRECISAM diferir: como `windowMs === lockoutMs`, travar e envelhecer no
    // mesmo instante não deixa nenhum momento em que um esteja morto e o outro vivo.
    recordFailure(s, "antigo", 0, LOGIN_POLICY);
    for (let i = 0; i < LOGIN_POLICY.maxFailures; i += 1) recordFailure(s, "preso", 1_000, LOGIN_POLICY);
    const t = LOGIN_POLICY.windowMs + 500; // "antigo" já saiu da janela; "preso" ainda está trancado
    pruneAttempts(s, t, LOGIN_POLICY);
    expect(s.has("antigo")).toBe(false);
    expect(s.has("preso")).toBe(true);
    expect(checkAttempt(s, "preso", t, LOGIN_POLICY).allowed).toBe(false);
  });
});

describe("identidade do cliente", () => {
  it("usa o ÚLTIMO salto do x-forwarded-for — o que o NOSSO proxy escreveu", () => {
    // Os anteriores, quando existem, vieram de quem chamou. Com o Caddy (que SUBSTITUI o header)
    // só há um; a diferença aparece se alguém puser um CDN na frente.
    expect(clientKey(new Headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientKey(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientKey(new Headers({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("IGNORA x-real-ip — o Caddy não o sanitiza, então ele é texto do atacante", () => {
    // Medido: `curl -H 'X-Real-IP: 6.6.6.6'` atravessa o Caddy INTACTO. Enquanto era fallback,
    // bastava rotacioná-lo a cada tentativa para a trava nunca fechar.
    expect(clientKey(new Headers({ "x-real-ip": "6.6.6.6" }))).toBe("sem-proxy");
    expect(clientKey(new Headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "6.6.6.6" }))).toBe(
      "203.0.113.7",
    );
  });

  it("um cabeçalho forjado não consegue mais criar baldes infinitos", () => {
    const forged = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((ip) =>
      clientKey(new Headers({ "x-forwarded-for": `${ip}, 203.0.113.7` })),
    );
    // Todas as tentativas caem no MESMO balde (o IP real), então a trava conta de verdade.
    expect(new Set(forged).size).toBe(1);
  });

  it("sem proxy nenhum, todos caem num balde só (conservador de propósito)", () => {
    expect(clientKey(new Headers())).toBe("sem-proxy");
  });

  it("atrás de proxy, clientes distintos NÃO dividem a mesma trava", () => {
    // Sem isto, um atacante trancaria o operador legítimo de fora — DoS trivial.
    expect(clientKey(new Headers({ "x-forwarded-for": "203.0.113.7" }))).not.toBe(
      clientKey(new Headers({ "x-forwarded-for": "203.0.113.8" })),
    );
  });
});
