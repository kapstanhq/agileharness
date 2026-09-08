import { NextResponse, type NextRequest } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// A régua do `content-length` é a MESMA do outro POST público (o login). Uma segunda régua local
// divergiria na primeira manutenção — e é o header duplicado/ilegível (que `declaredBodyBytes` recusa
// em vez de normalizar) o detalhe que uma reescrita à mão perde.
import { declaredTooLarge } from "../auth/login/body-limit";

// Persona avatar upload. Saves the image under public/avatars/<board>/<persona>.<ext> (served
// statically by Next) and returns the public path the caller stores on the persona. The board/
// persona ids are slug-shaped and validated to block path traversal; only small raster/SVG images
// are accepted. AI doodle generation will reuse the SAME storage path later (it just writes the
// generated PNG here instead of an uploaded one).
//
// ── story-2i89ai t6 — ESTA ROTA GRAVA NA NOSSA PRÓPRIA ORIGEM ──────────────────────────────────
// O destino é `public/`, servido estaticamente na MESMA origem do painel. Logo, o que entra aqui
// vira documento alcançável por URL, e o tipo do arquivo decide se é desenho ou CÓDIGO. Três travas,
// cada uma nomeando o que IMPEDE:
//
//  1. A EXTENSÃO SAI DOS BYTES, nunca do `type` declarado pelo cliente. Impede que um POST escolha o
//     nome do arquivo servido: com o `type` mandando, um corpo qualquer (HTML, shell, um SVG com
//     `<script>`) era gravado com a extensão que o atacante pediu, e a extensão é o que faz o Next
//     escolher o `Content-Type` da resposta. Mesma disciplina do `design-upload-guard.ts` (D12) —
//     duas listas de propósito: a de design é png/jpg/webp, esta mantém svg/gif porque o operador
//     desenha personas, e o SVG fica CONTIDO pelo `Content-Security-Policy: sandbox` que o
//     `next.config.js` aplica em `/avatars/**` (sem `allow-scripts` ⇒ script morto, origem opaca).
//  2. TETO ANTES DE BUFFERIZAR, e o teto REAL contado DURANTE a leitura. `req.formData()` materializa
//     o corpo INTEIRO em memória antes de qualquer checagem de tamanho — e route handler do Next 14
//     não tem limite default (só server action tem). Impede que um POST de gigabytes derrube o serviço
//     vivo por memória. Só o `content-length` NÃO fecha: quem envia é dono do framing e basta OMITIR o
//     header (ou mentir nele) para o pré-check virar decoração — por isso o teto também vive no STREAM
//     do corpo, onde o pior caso de memória é "teto + um chunk" independente do que foi declarado.
//  3. `Sec-Fetch-Site` cross-site é recusado. Impede o CSRF clássico (`<form
//     enctype="multipart/form-data">` em outro site), que hoje está barrado por UMA camada só: o
//     `SameSite=Lax` do cookie. Ausência do header NÃO bloqueia — agente/curl/webhook não o mandam,
//     e tirar capacidade deles seria o desfecho proibido.
export const runtime = "nodejs";

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/i;
const MAX_BYTES = 2_000_000;

/**
 * Teto do CORPO inteiro, não só do arquivo: o envelope multipart (boundaries, cabeçalhos de parte, os
 * campos `boardId`/`personaId`) soma alguns bytes por cima da imagem, e um teto justo demais recusaria
 * um upload legítimo de 2 MB. A folga é generosa de propósito — o que o teto precisa impedir é a ordem
 * de grandeza (gigabytes), não o quilobyte.
 */
const MAX_BODY_BYTES = MAX_BYTES + 64 * 1024;

/** Extensões possíveis — a chave é o veredito do sniff, não o `type` do cliente. */
type AvatarKind = "png" | "jpg" | "webp" | "gif" | "svg";

const MAGIC: ReadonlyArray<{ kind: AvatarKind; test: (b: Uint8Array) => boolean }> = [
  { kind: "png", test: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { kind: "jpg", test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { kind: "gif", test: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
  // WEBP = container RIFF: bytes 0-3 "RIFF" e 8-11 "WEBP" (4-7 são o tamanho).
  {
    kind: "webp",
    test: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && b.length >= 12 && starts(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
];

function starts(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((m, i) => bytes[i] === m);
}

/**
 * SVG é texto, não tem número mágico — então a régua é a FORMA do documento: depois de BOM, espaços,
 * prólogo XML, comentários e um DOCTYPE simples, o primeiro elemento tem de ser `<svg`.
 *
 * O que isso impede: gravar QUALQUER texto com a extensão `.svg` (uma página HTML com `<script>`, um
 * shell script, um payload de phishing hospedado no domínio do operador). Um DOCTYPE com subconjunto
 * interno (`[ <!ENTITY …> ]`) não casa e é recusado — fail-closed de propósito, é o vizinho do XXE.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  // 2 KiB de cabeça bastam: o prólogo de um SVG legítimo é curtíssimo, e decodificar o arquivo
  // inteiro só para farejar seria trabalho (e memória) por nada.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 2048)).replace(/^﻿/, "");
  return /^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE\s+svg[^[>]*>\s*)*<svg[\s/>]/i.test(head);
}

function sniffAvatarKind(bytes: Uint8Array): AvatarKind | null {
  for (const { kind, test } of MAGIC) if (test(bytes)) return kind;
  return looksLikeSvg(bytes) ? "svg" : null;
}

/** A marca de que o teto ESTOUROU, e não que o multipart veio torto. O parser rejeita as duas coisas —
 *  sem esta marca o atacante trocaria o 413 honesto por um 400 barato, e o operador perderia o único
 *  sinal de que alguém está empurrando corpos grandes. */
interface TetoDoCorpo {
  excedido: boolean;
}

/**
 * Envelopa o stream do corpo contando os bytes DURANTE a leitura e ERRANDO o stream no teto.
 *
 * O que isto IMPEDE: que o cliente escolha quanta memória o processo aloca simplesmente **omitindo** o
 * `content-length` — o framing é decisão de quem envia (e de qualquer proxy no caminho), então um
 * pré-check de header sozinho é ignorável de graça. Aqui o corpo é BINÁRIO e vai para o parser
 * multipart, por isso o teto vive num envelope de stream em vez de devolver texto como o
 * `readBoundedBody` do login (`../auth/login/body-limit.ts`) — a política é a mesma: contar, cancelar,
 * 413; o pior caso de memória é "teto + um chunk".
 */
function corpoComTeto(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  marca: TetoDoCorpo,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const passo = await reader.read();
      if (passo.done) {
        controller.close();
        return;
      }
      total += passo.value.byteLength;
      if (total > maxBytes) {
        marca.excedido = true;
        // Cancelar (e não só parar de ler) é o que aplica contrapressão no cliente, em vez de deixar o
        // resto do corpo enfileirado no socket à nossa custa.
        void reader.cancel().catch(() => {});
        controller.error(new Error("corpo acima do teto"));
        return;
      }
      controller.enqueue(passo.value);
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/** Parseia o multipart lendo o corpo pelo envelope com teto. Sem stream (POST sem corpo) não há o que
 *  conter — o parser devolve o erro de forma, que a rota traduz em 400. */
function lerFormDataComTeto(req: NextRequest, marca: TetoDoCorpo): Promise<FormData> {
  const body = req.body as ReadableStream<Uint8Array> | null;
  if (!body) return req.formData();
  return new Response(corpoComTeto(body, MAX_BODY_BYTES, marca), {
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  }).formData();
}

export async function POST(req: NextRequest) {
  // Trava 3 — antes de qualquer leitura de corpo. Só um NAVEGADOR manda `Sec-Fetch-Site`, e só ele
  // pode ser a arma do CSRF; cliente que não manda (agente, curl, script) passa como sempre.
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    return NextResponse.json({ error: "origem não permitida para upload." }, { status: 403 });
  }

  // Trava 2, primeira metade — o que o cliente DECLAROU, julgado pela régua do login: um corpo grande
  // anunciado é recusado com o stream do corpo intocado, e um `content-length` duplicado/ilegível é
  // recusado em vez de normalizado (divergência de tamanho entre dois hops é semente de smuggling).
  if (declaredTooLarge(req.headers, MAX_BODY_BYTES)) {
    return NextResponse.json({ error: "Imagem muito grande (máx. 2 MB)." }, { status: 413 });
  }

  // Trava 2, segunda metade — o teto REAL. Não depende de o cliente ter declarado nada: os bytes são
  // contados enquanto chegam e a leitura é abortada no teto, então OMITIR o `content-length` (ou mentir
  // nele) deixa de comprar memória do serviço.
  const teto: TetoDoCorpo = { excedido: false };
  let form: FormData;
  try {
    form = await lerFormDataComTeto(req, teto);
  } catch {
    if (teto.excedido) {
      return NextResponse.json({ error: "Imagem muito grande (máx. 2 MB)." }, { status: 413 });
    }
    return NextResponse.json({ error: "Requisição inválida (esperado multipart/form-data)." }, { status: 400 });
  }

  const file = form.get("file");
  const boardId = String(form.get("boardId") ?? "");
  const personaId = String(form.get("personaId") ?? "");

  if (!(file instanceof File)) return NextResponse.json({ error: "Nenhum arquivo enviado." }, { status: 400 });
  if (!SAFE_ID.test(boardId) || !SAFE_ID.test(personaId))
    return NextResponse.json({ error: "Identificador de board/persona inválido." }, { status: 400 });

  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Imagem muito grande (máx. 2 MB)." }, { status: 413 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_BYTES) return NextResponse.json({ error: "Imagem muito grande (máx. 2 MB)." }, { status: 413 });

  // Trava 1 — o veredito dos BYTES é quem escolhe a extensão. `file.type` só serve para a mensagem
  // de erro; um cliente que manda `image/jpg`, ou nada (colar do clipboard), continua funcionando.
  const ext = sniffAvatarKind(bytes);
  if (!ext) {
    return NextResponse.json(
      { error: "Formato não suportado — use PNG, JPG, WebP, SVG ou GIF." },
      { status: 415 },
    );
  }

  const dir = path.join(process.cwd(), "public", "avatars", boardId);
  await mkdir(dir, { recursive: true });
  const filename = `${personaId}.${ext}`;
  await writeFile(path.join(dir, filename), bytes);

  // Cache-bust so the <img> refreshes immediately after a re-upload to the same filename.
  return NextResponse.json({ path: `/avatars/${boardId}/${filename}?v=${Date.now()}` });
}
