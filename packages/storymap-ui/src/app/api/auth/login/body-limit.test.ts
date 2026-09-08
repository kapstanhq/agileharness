// OS ATAQUES QUE O TETO DE CORPO PRECISA CONTER (story-mkk680).
//
// A rota já é testada de ponta a ponta em `route.test.ts`; aqui ficam os casos que precisam apertar o
// relógio ou mentir no framing — coisas que não dá para exercitar pela rota sem esperar 5 segundos ou
// sem um proxy de verdade na frente. Cada `it` nomeia o abuso, não a função.

import { describe, expect, it } from "vitest";

import {
  LOGIN_MAX_BODY_BYTES,
  declaredBodyBytes,
  declaredTooLarge,
  readBoundedBody,
} from "./body-limit";

function post(body: BodyInit | undefined, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3008/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body }),
    duplex: "half",
  } as RequestInit);
}

describe("ATAQUE: escolher quanta memória o processo aloca", () => {
  it("o corpo declarado acima do teto é recusado sem NEM OLHAR para o stream", async () => {
    // O instrumento é um `Request` espião cujo `body` é um getter contado. É a asserção mais precisa
    // possível do "sem bufferizar": não medimos quanto foi lido — provamos que o corpo nunca foi
    // sequer acessado. (Com um Request de verdade essa medida é impossível: o undici pré-carrega um
    // chunk na construção, antes de qualquer código nosso.)
    let tocou = 0;
    const espiao = {
      headers: new Headers({ "content-type": "application/json", "content-length": String(50 * 1024 * 1024) }),
      get body(): ReadableStream<Uint8Array> | null {
        tocou += 1;
        return null;
      },
    } as unknown as Request;

    const r = await readBoundedBody(espiao);
    expect(r).toMatchObject({ status: 413, reason: "declarado" });
    expect(tocou, "olhar para o corpo já é aceitar o que o atacante declarou").toBe(0);
  });

  it("um content-length MENTIROSO não compra buffer: o teto vale durante a leitura", async () => {
    // ATAQUE: declarar 10 bytes e mandar megabytes. Nesta instalação o parser do Node corta o corpo
    // no `content-length`, mas o framing é decisão de quem está na frente do serviço — o teto não pode
    // depender de o front-end ser honesto nem de qual proxy o self-hoster escolheu.
    const grande = "y".repeat(LOGIN_MAX_BODY_BYTES * 4);
    const r = await readBoundedBody(post(grande, { "content-length": "10" }));
    expect(r).toMatchObject({ status: 413, reason: "excedeu" });
  });

  it("content-length duplicado é recusado por FORMA, não normalizado", () => {
    // Dois valores = dois tamanhos possíveis para o mesmo corpo. Escolher um é começar a divergir do
    // hop anterior, que é a semente do request smuggling.
    expect(declaredBodyBytes(new Headers({ "content-length": "10, 4000" }))).toBe("invalido");
    expect(declaredTooLarge(new Headers({ "content-length": "10, 4000" }))).toBe(true);
    // ...e um número honesto e pequeno continua passando.
    expect(declaredBodyBytes(new Headers({ "content-length": "70" }))).toBe(70);
    expect(declaredTooLarge(new Headers({ "content-length": "70" }))).toBe(false);
    // Sem header nenhum não há nada a julgar aqui — quem contém esse caso é o teto do stream.
    expect(declaredBodyBytes(new Headers())).toBe("ausente");
    expect(declaredTooLarge(new Headers())).toBe(false);
  });
});

describe("ATAQUE: prender o handler com um corpo que nunca termina", () => {
  it("o corpo que goteja é abandonado no prazo — não fica pendurado até o requestTimeout do Node", async () => {
    // Slowloris de CORPO: declarar um tamanho legítimo e entregar um byte de vez em quando. Sem prazo
    // próprio, o único limite é o `requestTimeout` default do Node (5 min) — barato para o atacante,
    // e paralelizável contra um processo que roda como root com `Restart=always`.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([123])); // "{" — e nunca mais nada
      },
    });
    const t0 = Date.now();
    const r = await readBoundedBody(post(body, { "content-length": "100" }), { timeoutMs: 25 });
    expect(r).toMatchObject({ status: 408, reason: "lento" });
    expect(Date.now() - t0, "o prazo não engatou — o handler ficaria preso").toBeLessThan(5_000);
  });

  it("o prazo é do corpo INTEIRO — gotejar dentro dele não renova o crédito para sempre", async () => {
    // Se o prazo fosse por LEITURA, um byte a cada 20ms manteria o handler vivo indefinidamente.
    let enviados = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        enviados += 1;
        await new Promise((r) => setTimeout(r, 10));
        c.enqueue(new Uint8Array([32]));
      },
    });
    const r = await readBoundedBody(post(body, { "content-length": "100" }), { timeoutMs: 60 });
    expect(r).toMatchObject({ status: 408, reason: "lento" });
    expect(enviados, "o corpo estava chegando devagar mas SEM parar — o prazo total é que corta").toBeGreaterThan(1);
  });
});

describe("o caminho legítimo — o teto não pode custar capacidade", () => {
  it("o corpo de um login real atravessa inteiro, com e sem content-length", async () => {
    const corpo = JSON.stringify({ token: "T".repeat(43), remember: true });
    const comCl = await readBoundedBody(post(corpo, { "content-length": String(Buffer.byteLength(corpo)) }));
    expect(comCl).toEqual({ ok: true, text: corpo });
    const semCl = await readBoundedBody(post(corpo));
    expect(semCl).toEqual({ ok: true, text: corpo });
  });

  it("um corpo exatamente no teto passa; um byte além, não", async () => {
    const noTeto = "a".repeat(LOGIN_MAX_BODY_BYTES);
    expect(await readBoundedBody(post(noTeto))).toEqual({ ok: true, text: noTeto });
    expect(await readBoundedBody(post(`${noTeto}a`))).toMatchObject({ status: 413 });
  });

  it("POST sem corpo nenhum não vira erro de leitura — quem julga o vazio é a rota", async () => {
    expect(await readBoundedBody(post(undefined))).toEqual({ ok: true, text: "" });
  });

  it("um corpo multibyte não é truncado no meio de um caractere", async () => {
    // O teto conta BYTES (é memória que se está protegendo), mas o texto entregue tem de ser o texto —
    // um token colado de um teclado com acento não pode chegar corrompido na comparação.
    const corpo = JSON.stringify({ token: "çãé—🙂".repeat(3) });
    expect(await readBoundedBody(post(corpo))).toEqual({ ok: true, text: corpo });
  });
});
