// TETO DE CORPO E DE TEMPO DO ÚNICO POST PÚBLICO DO SERVIÇO (story-mkk680).
//
// O que estes dois tetos IMPEDEM: que um não-autenticado escolha quanta memória o processo aloca, e
// por quanto tempo ele fica pendurado esperando um corpo que talvez nunca termine de chegar.
// `/api/auth/login` é a ÚNICA rota POST fora do portão (`public-routes.ts`, motivo "pre-session"), o
// serviço roda como root com `Restart=always`, e o preço de um OOM aqui não é "acesso": é o processo
// reiniciando e levando consigo os runs em voo, o merge train e a fila de publicação.
//
// MEDIDO no `node_modules` ANTES de afirmar que não existia teto nenhum:
//   • `experimental.serverActions.bodySizeLimit` (next.config.js:59) é lido em UM lugar só —
//     `next/dist/server/app-render/action-handler.js`. Cobre Server Actions, não Route Handlers.
//   • o outro "Body exceeded … limit" vive em `next/dist/server/api-utils/node/parse-body.js`, o
//     bodyParser do Pages Router, que este app não usa.
//   Nenhum dos dois passa perto de um Route Handler do App Router: `await req.json()` bufferiza o que
//   vier. O único teto que restava era o `requestTimeout` do Node (5 min) — tarde e caro demais.
//
// POR QUE UM MÓDULO E NÃO DUAS LINHAS NO `route.ts`: um arquivo de rota do App Router não pode
// exportar nada além dos handlers HTTP e dos campos de config — o type-check que o `next build` gera
// (`next-types-plugin`) reprova qualquer export extra ("is not a valid Route export field"). O teto
// tem de ser testável isolado, então mora aqui do lado, fora da rota.
//
// O QUE NÃO FIZEMOS, E POR QUÊ: recusar de saída todo corpo sem `content-length` (o `411 Length
// Required` que o card sugeria). O teto no STREAM já contém o corpo sem tamanho declarado — ele nunca
// materializa mais de um chunk além do teto —, enquanto a recusa seca apostaria no framing de quem
// está na frente do serviço: se algum proxy reencaminhasse o login em `transfer-encoding: chunked`, o
// dono ficaria trancado FORA do próprio board, que é a única porta de entrada da UI. E isso não daria
// para descobrir em produção sem POSTar no login. Teto que contém sem apostar > recusa que aposta.

/**
 * Teto do corpo do login. Um login legítimo é `{"token":"<43 chars>","remember":true}` — ~70 bytes.
 * 4 KiB dá folga de duas ordens de grandeza para um token maior e ainda cabe num único pacote.
 */
export const LOGIN_MAX_BODY_BYTES = 4096;

/**
 * Teto de tempo para o corpo INTEIRO chegar. Impede o slowloris de corpo: um cliente que declara
 * 4000 bytes e entrega um por minuto mantém um handler nosso vivo com o `requestTimeout` default do
 * Node (5 min) como único limite — barato para ele, caro para nós, e repetível em paralelo.
 */
export const LOGIN_BODY_TIMEOUT_MS = 5_000;

/** O que o `content-length` apresentado diz — ou por que ele não é utilizável. */
export type DeclaredBodyBytes = number | "ausente" | "invalido";

/**
 * Lê o `content-length` julgando a FORMA, não a intenção.
 *
 * `invalido` cobre o que a nossa aritmética e o parser de quem está na frente leriam DIFERENTE —
 * `+1e9`, `0x10`, sinal, espaço interno, e principalmente o header DUPLICADO (que `Headers.get`
 * entrega como `"10, 4000"`). Divergência de tamanho entre dois hops é a semente de request
 * smuggling; aqui ela é recusada em vez de normalizada.
 */
export function declaredBodyBytes(headers: Headers): DeclaredBodyBytes {
  const raw = headers.get("content-length");
  if (raw === null) return "ausente";
  const t = raw.trim();
  if (!/^\d{1,15}$/.test(t)) return "invalido";
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : "invalido";
}

/**
 * O corpo é recusável SÓ pelos headers? Chame ANTES de tocar em `req.body`.
 *
 * É o que faz o 413 sair sem bufferizar nada: um `content-length` de 64 MiB é recusado com o stream
 * do corpo intocado, então o atacante não consegue nos fazer alocar o que ele declarou — e nem
 * ocupar o handler pelo tempo de transferir.
 */
export function declaredTooLarge(headers: Headers, maxBytes: number = LOGIN_MAX_BODY_BYTES): boolean {
  const d = declaredBodyBytes(headers);
  return d === "invalido" || (typeof d === "number" && d > maxBytes);
}

export type BoundedBody =
  | { ok: true; text: string }
  /** o `content-length` já não cabia — o corpo NÃO foi lido. */
  | { ok: false; status: 413; reason: "declarado" }
  /** o corpo passou do teto durante a leitura (sem `content-length`, ou com um mentiroso). */
  | { ok: false; status: 413; reason: "excedeu" }
  /** o corpo não chegou inteiro dentro do prazo. */
  | { ok: false; status: 408; reason: "lento" }
  /** o stream do corpo quebrou no meio. */
  | { ok: false; status: 400; reason: "ilegivel" };

function concat(partes: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of partes) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/**
 * Materializa o corpo com teto de BYTES e teto de TEMPO — nesta ordem, e o de bytes antes de ler.
 *
 * Duas travas, porque uma só não fecha:
 *   1. o `content-length` é julgado primeiro e o corpo é recusado com o stream intocado;
 *   2. quem NÃO declara tamanho (ou declara um mentiroso — a decisão de framing é do proxy, não
 *      nossa) é contido durante a leitura: passou do teto, cancelamos o reader e devolvemos 413. O
 *      pior caso de memória vira "teto + um chunk", não "o que o cliente quiser".
 * O prazo é do corpo INTEIRO (um timer, não um por leitura): sem isso, entregar um byte por vez
 * dentro do prazo renovaria o crédito para sempre.
 *
 * Nunca lança: todo desfecho é um valor que a rota traduz em status.
 */
export async function readBoundedBody(
  req: Request,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<BoundedBody> {
  const maxBytes = opts.maxBytes ?? LOGIN_MAX_BODY_BYTES;
  const timeoutMs = opts.timeoutMs ?? LOGIN_BODY_TIMEOUT_MS;

  if (declaredTooLarge(req.headers, maxBytes)) return { ok: false, status: 413, reason: "declarado" };

  const body = req.body;
  // Sem stream = sem corpo (POST vazio). A rota decide o que fazer com texto vazio; aqui não há o
  // que conter.
  if (!body) return { ok: true, text: "" };

  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<{ prazoEstourou: true }>((resolve) => {
    timer = setTimeout(() => resolve({ prazoEstourou: true }), timeoutMs);
  });

  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const passo = await Promise.race([reader.read(), prazo]);
      if ("prazoEstourou" in passo) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 408, reason: "lento" };
      }
      if (passo.done) break;
      const chunk = passo.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        // Cancelar (e não só parar de ler) é o que aplica contrapressão no cliente em vez de deixar
        // o resto do corpo enfileirado no socket à nossa custa.
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413, reason: "excedeu" };
      }
      partes.push(chunk);
    }
  } catch {
    return { ok: false, status: 400, reason: "ilegivel" };
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { ok: true, text: new TextDecoder("utf-8").decode(concat(partes, total)) };
}
