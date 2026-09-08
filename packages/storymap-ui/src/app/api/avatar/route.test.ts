// UPLOAD DE AVATAR — o que pode aterrissar em `public/` (story-2i89ai t6).
//
// Esta rota é a única do pacote que grava dentro de `public/`: o arquivo passa a ser servido
// estaticamente na MESMA origem do painel, e a EXTENSÃO é o que faz o Next escolher o `Content-Type`
// da resposta. Antes desta onda quem escolhia a extensão era o `Content-Type` DECLARADO pelo cliente
// — um campo do atacante. Cada teste nomeia o ataque, não a implementação.
//
// A contenção do SVG (que segue ACEITO — é capacidade do operador) mora no
// `Content-Security-Policy: sandbox` de `/avatars/**`, travado em `src/server/security-headers.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

import { POST } from "./route";

let TMP = "";
let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(async () => {
  // A rota escreve em `process.cwd()/public/avatars` — sem isto o teste sujaria o checkout vivo.
  TMP = await fs.mkdtemp(path.join(os.tmpdir(), "ah-avatar-upload-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(TMP);
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(TMP, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG_COM_SCRIPT = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/api/vps')</script></svg>`,
);
const HTML = new TextEncoder().encode(`<!DOCTYPE html><html><body><script>alert(1)</script></body></html>`);

function upload(
  file: File,
  opts: { boardId?: string; personaId?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("boardId", opts.boardId ?? "storymap");
  fd.append("personaId", opts.personaId ?? "operador");
  return POST(
    new Request("http://localhost:3008/api/avatar", {
      method: "POST",
      headers: opts.headers,
      body: fd,
    }) as never,
  );
}

const BOUNDARY = "----ah-avatar-teste";

/**
 * Monta o corpo multipart À MÃO, em chunks de 64 KiB, com um PNG de `bytes` de payload.
 *
 * À mão porque `new FormData()` + `new Request({body: fd})` faz o undici DECLARAR o `content-length` —
 * exatamente o header que o ataque OMITE. Sem montar o corpo na mão não há como exercitar o caminho em
 * que o cliente esconde o tamanho.
 */
function corpoMultipart(bytes: number): Uint8Array[] {
  const enc = new TextEncoder();
  const cabeca = enc.encode(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
  );
  const cauda = enc.encode(
    `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="boardId"\r\n\r\nstorymap\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="personaId"\r\n\r\noperador\r\n--${BOUNDARY}--\r\n`,
  );
  const CHUNK = 64 * 1024;
  const partes: Uint8Array[] = [cabeca];
  // Primeiro chunk com a assinatura de PNG: assim o único motivo possível de recusa é o TAMANHO — um
  // 413 que na verdade fosse 415 disfarçado não provaria nada sobre o teto.
  for (let escritos = 0; escritos < bytes; escritos += CHUNK) {
    const tamanho = Math.min(CHUNK, bytes - escritos);
    const chunk = new Uint8Array(tamanho);
    if (escritos === 0) chunk.set(PNG.subarray(0, Math.min(PNG.length, tamanho)));
    partes.push(chunk);
  }
  partes.push(cauda);
  return partes;
}

/**
 * A requisição como o handler a recebe, com o corpo em STREAM e um contador de bytes ENTREGUES.
 *
 * O `formData()` do fake materializa o corpo inteiro — é fielmente o que o runtime do Next entrega, e é
 * essa materialização que o teto no stream precisa tornar inalcançável. O contador vive na FONTE do
 * stream: ele mede quantos bytes a rota realmente puxou, que é a única prova de que o 413 chegou antes
 * da memória (e não depois).
 */
function requisicaoEmStream(
  chunks: Uint8Array[],
  extraHeaders: Record<string, string> = {},
): { req: NextRequest; lidos: () => number } {
  let lidos = 0;
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i++]!;
      lidos += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const headers = new Headers({ "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...extraHeaders });
  const req = { headers, body, formData: () => new Response(body, { headers }).formData() };
  return { req: req as unknown as NextRequest, lidos: () => lidos };
}

/** Os nomes realmente gravados no diretório do board — a prova do que aterrissou. */
async function written(boardId = "storymap"): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(TMP, "public", "avatars", boardId))).sort();
  } catch {
    return [];
  }
}

describe("POST /api/avatar — o que aterrissa na origem do painel", () => {
  it("o CLIENTE não escolhe a extensão do arquivo servido", async () => {
    // ATAQUE: mandar bytes de SVG (que são CÓDIGO) declarando `image/png`. Com a extensão saindo do
    // `type`, o arquivo era gravado como `.png` — servido com `Content-Type: image/png`, fora de
    // qualquer regra por extensão, e escapando do bloco de CSP que contém o SVG. Quem manda são os
    // BYTES: isto tem de aterrissar como `.svg`, dentro do perímetro que o sandbox cobre.
    const res = await upload(new File([SVG_COM_SCRIPT], "inocente.png", { type: "image/png" }));
    expect(res.status).toBe(200);
    expect((await res.json()).path).toMatch(/\/avatars\/storymap\/operador\.svg\?/);
    expect(await written()).toEqual(["operador.svg"]);
  });

  it("uma PÁGINA HTML disfarçada de imagem não aterrissa em public/", async () => {
    // ATAQUE: gravar `operador.svg` cujo conteúdo é HTML com `<script>` — um documento hospedado no
    // domínio do operador (phishing com o cadeado dele, ou XSS armazenado se a extensão mudar de
    // mãos). Nenhum byte que não seja imagem de verdade pode virar arquivo servido.
    for (const type of ["image/svg+xml", "image/png", "text/html"]) {
      const res = await upload(new File([HTML], "x.svg", { type }));
      expect(res.status, `type=${type} deveria ser recusado`).toBe(415);
    }
    expect(await written()).toEqual([]);
  });

  it("nem um executável renomeado, nem um PDF, nem texto solto", async () => {
    // `Uint8Array<ArrayBuffer>` e não `Uint8Array` cru: o `BlobPart` do lib dom exige um respaldo
    // ArrayBuffer de verdade, e o tipo largo admitiria SharedArrayBuffer (mesma nota de design/upload).
    const casos: Array<[string, Uint8Array<ArrayBuffer>]> = [
      ["elf", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0])],
      ["pdf", new TextEncoder().encode("%PDF-1.7\n%…")],
      ["shell", new TextEncoder().encode("#!/bin/sh\necho pwned\n")],
      ["vazio", new Uint8Array()],
    ];
    for (const [nome, bytes] of casos) {
      const res = await upload(new File([bytes], `${nome}.png`, { type: "image/png" }));
      expect(res.status, `${nome} deveria ser recusado`).toBe(415);
    }
    expect(await written()).toEqual([]);
  });

  it("CSRF: um <form multipart> de outro site não grava nada", async () => {
    // ATAQUE: `<form action="https://board/api/avatar" method="POST"
    // enctype="multipart/form-data">` numa página maliciosa. Form cross-site não precisa de
    // preflight, então hoje o ÚNICO obstáculo é o `SameSite=Lax` do cookie — uma camada. O
    // `Sec-Fetch-Site` que o navegador anexa é a segunda.
    for (const site of ["cross-site", "same-site"]) {
      const res = await upload(new File([PNG], "a.png", { type: "image/png" }), {
        headers: { "sec-fetch-site": site },
      });
      expect(res.status, `sec-fetch-site=${site}`).toBe(403);
    }
    expect(await written()).toEqual([]);
  });

  it("o navegador do operador (same-origin) e os clientes sem Sec-Fetch-Site seguem passando", async () => {
    // A trava não pode custar capacidade: agente headless, curl e webhook NÃO mandam o header.
    const same = await upload(new File([PNG], "a.png", { type: "image/png" }), {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(same.status).toBe(200);
    const semHeader = await upload(new File([PNG], "a.png", { type: "image/png" }), { personaId: "agente" });
    expect(semHeader.status).toBe(200);
    expect(await written()).toEqual(["agente.png", "operador.png"]);
  });

  it("corpo gigante toma 413 SEM ser bufferizado em memória", async () => {
    // ATAQUE de disponibilidade: `req.formData()` materializa o corpo INTEIRO na memória do serviço
    // VIVO antes de qualquer checagem, e route handler do Next 14 não tem limite default. Um POST de
    // gigabytes derrubava o processo — o 413 depois do buffer já custou a RAM. A prova de que o teto
    // é anterior: `formData` nem é chamado.
    let bufferizou = false;
    const fake = {
      headers: new Headers({ "content-length": String(4 * 1024 * 1024 * 1024), "content-type": "multipart/form-data; boundary=x" }),
      formData: async () => {
        bufferizou = true;
        return new FormData();
      },
    };
    const res = await POST(fake as never);
    expect(res.status).toBe(413);
    expect(bufferizou, "o corpo foi lido antes do teto — o 413 chegou tarde").toBe(false);
  });

  it("[ATAQUE] corpo gigante SEM `content-length` é abortado no teto, não materializado", async () => {
    // O pré-check de header é ignorável DE GRAÇA: quem envia é dono do framing (e qualquer proxy no
    // caminho também), então basta OMITIR o `content-length` para `req.formData()` voltar a materializar
    // o corpo INTEIRO antes de qualquer checagem. 8 MiB entregues em chunks de 64 KiB contra um processo
    // que roda como root com `Restart=always`: o preço não é acesso, é o serviço reiniciando e levando
    // os runs em voo, o merge train e a fila de publicação.
    //
    // A prova de que o teto é REAL e não pós-buffer: quantos bytes a rota chegou a PUXAR do stream.
    const { req, lidos } = requisicaoEmStream(corpoMultipart(8 * 1024 * 1024));

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(
      lidos(),
      `a rota puxou ${lidos()} bytes do corpo — o teto ainda é pós-buffer, e o atacante escolhe a memória`,
    ).toBeLessThan(3 * 1024 * 1024);
    expect(await written()).toEqual([]);
  });

  it("[ATAQUE] `content-length` MENTIROSO não compra memória", async () => {
    // Declarar 120 bytes e empurrar 8 MiB: um pré-check que confia no header declarado deixa passar, e o
    // parser materializa o que vier. O teto que vale é o contado enquanto os bytes chegam.
    const { req, lidos } = requisicaoEmStream(corpoMultipart(8 * 1024 * 1024), { "content-length": "120" });

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(lidos(), "o corpo mentiroso foi lido inteiro — o header do cliente ainda manda no teto").toBeLessThan(
      3 * 1024 * 1024,
    );
    expect(await written()).toEqual([]);
  });

  it("upload legítimo em chunks e SEM `content-length` segue passando — nenhuma capacidade removida", async () => {
    // `curl -T`, agente headless e webhook mandam `transfer-encoding: chunked` sem tamanho declarado. O
    // teto contém; ele não pode virar uma recusa seca por ausência de header (isso trancaria o operador
    // fora do próprio board pelo caminho de upload).
    const { req } = requisicaoEmStream(corpoMultipart(300 * 1024));

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await written()).toEqual(["operador.png"]);
  });

  it("id de board/persona com traversal continua recusado", async () => {
    // Trava pré-existente (o nome do arquivo é montado com esses ids) — travada aqui para não sumir
    // num refactor: sem ela o upload escreve fora de `public/avatars`.
    for (const bad of ["../../etc", "a/b", ".", "-x", ""]) {
      const res = await upload(new File([PNG], "a.png", { type: "image/png" }), { boardId: bad });
      expect(res.status, `boardId=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(await written()).toEqual([]);
  });

  it("PNG, JPG, WebP, GIF e SVG de verdade continuam aceitos — nenhuma capacidade removida", async () => {
    const reais: Array<[string, Uint8Array<ArrayBuffer>]> = [
      ["png", PNG],
      ["jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])],
      ["gif", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])],
      [
        "webp",
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]),
      ],
      ["svg", new TextEncoder().encode(`<?xml version="1.0"?>\n<!-- feito à mão -->\n<svg viewBox="0 0 1 1"/>`)],
    ];
    for (const [ext, bytes] of reais) {
      // `type` vazio de propósito: colar do clipboard e alguns clientes móveis não declaram nada, e
      // o sniff é justamente o que faz isso funcionar em vez de virar 415.
      const res = await upload(new File([bytes], "sem-tipo", { type: "" }), { personaId: `p-${ext}` });
      expect(res.status, `${ext} deveria ser aceito`).toBe(200);
      expect((await res.json()).path).toContain(`p-${ext}.${ext}`);
    }
  });
});
