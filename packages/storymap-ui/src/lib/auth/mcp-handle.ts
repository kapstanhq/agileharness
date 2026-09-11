// HANDLE REVOGÁVEL — TIRAR O SEGREDO DE EXECUÇÃO DE DENTRO DA URL (story-h8tmzh).
//
// ⚠️ NÃO importe este módulo do middleware: usa `node:fs`/`node:crypto`, que não existem no runtime
// Edge onde o Next 14 roda middleware (mesma fronteira de `lib/auth/token.ts`).
//
// ── O DANO, MEDIDO ────────────────────────────────────────────────────────────────────────────
//
// Hoje a credencial VIAJA NO PATH: `/api/mcp/<segredo>/mcp`. Consequência medida (story-u4yf1i):
// **174 gravações do token em texto claro** — 168 no journal do Caddy, 6 em `/var/log/syslog*` e
// rotacionados — de 2026-06-06 a 2026-07-29, produzidas pelo logger de ERRO DEFAULT do Caddy, que
// registra o URI inteiro. Nenhuma misconfiguração: um token no path é um token que vaza em todo log
// de toda camada, e o default de um dos intermediários já vazou.
//
// ── POR QUE O PATH NÃO PODE SIMPLESMENTE SAIR ─────────────────────────────────────────────────
//
// O conector MCP do CHAT WEB do Claude conecta da nuvem da Anthropic e a UI dele não deixa colar um
// bearer header (só OAuth client id/secret) — a URL colada é o único carregador de credencial que
// existe ali. Essa é a superfície que fica. As outras (MCP em terminal, navegador logado no celular
// ou no desktop) não precisam do path e migram para header/cookie por outro caminho desta onda.
//
// ── O QUE O HANDLE COMPRA, E O QUE ELE **NÃO** COMPRA ─────────────────────────────────────────
//
// CORREÇÃO HONESTA da premissa do card, que fala de um "connectorId **público**": um handle
// apresentado no path AUTENTICA, logo é uma credencial portadora como qualquer outra. Chamá-lo de
// público seria teatro — quem lê o log do proxy e copia o handle entra, até a revogação. O ganho
// real são três propriedades que o token do env NÃO tem:
//
//   1. REVOGÁVEL NA HORA, sem restart. Trocar `AGILEHARNESS_MCP_TOKEN` exige reiniciar o serviço, e o
//      guardrail do projeto proíbe reiniciá-lo sem autorização — é por isso que a rotação está, na
//      prática, TRAVADA, e é por isso que o token vazado ficou vivo 54 dias. O registro daqui é
//      relido a cada resolução, então `revokeMcpHandle` corta o acesso no request seguinte.
//   2. ESCOPÁVEL. O handle carrega o próprio nível (`ro`/`write`/`orch`/`full`), então o que vaza no
//      log pode não ser a autoridade máxima. Emitir `full` continua permitido — contenção que
//      custasse autonomia estaria errada.
//   3. DESACOPLADO DO ENV. Revogar um handle não obriga a rotacionar o `AGILEHARNESS_MCP_TOKEN` (nem o
//      contrário): os dois caminhos são independentes, e é isso que torna a revogação uma ação
//      barata. ⚠️ NÃO leia isso como "o handle só vale para o MCP": `api/runner/perimeter.ts` resolve
//      pela MESMA função, então um handle com nível suficiente TAMBÉM abre as 4 rotas
//      `/api/runner/*` (cada uma exige um mínimo — `ro` nas de leitura, `orch` nos webhooks que
//      mutam). O raio de dano de um handle `full`/`orch` vazado no log de um intermediário inclui,
//      portanto, dirigir o deploy — o que o CONTÉM é o nível com que ele foi emitido, não a rota.
//
// O que ele NÃO compra: sigilo do valor em trânsito (o path segue sendo logável), nem defesa contra
// quem lê o log ANTES de você revogar. A janela de dano deixa de ser "até o próximo restart
// autorizado" e passa a ser "até o operador clicar" — é contenção, não invisibilidade.
//
// ── COMPATIBILIDADE É REQUISITO, NÃO CORTESIA ─────────────────────────────────────────────────
//
// O token legado (`AGILEHARNESS_MCP_TOKEN` e os escopados de `settings.mcpTokens`) CONTINUA valendo no
// path, com a MESMA ordem de resolução de hoje. O handle é caminho ADICIONAL. Quebrar o legado
// pararia o conector do dono — isso seria remoção de capacidade, não hardening. `McpCredential.via`
// diz QUAL caminho entrou, que é o dado de que a depreciação futura precisa (e a atribuição no
// ledger, story-et6a4j).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { AuthFailureReason } from "@/lib/auth/auth-audit";
import { isMcpTokenValid, maskSecret } from "@/lib/storymap/mcp/auth";
import { MCP_TOKEN_ENV } from "@/lib/storymap/mcp/token-bootstrap";
import { runnerStateDir } from "@/lib/storymap/paths";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { withKeyedLock } from "@/lib/storymap/serialize";
import type { McpLevel } from "@/lib/storymap/types";

/**
 * O prefixo que torna o handle RECONHECÍVEL num log ou num commit acidental.
 *
 * Convenção de token com prefixo (`ghp_`, `sk-`): a forma é o que deixa um varredor de segredo
 * julgar por FORMA em vez de por lista de nomes de variável — a mesma régua que `scan-secrets.mjs`
 * já aplica nesta onda.
 */
export const MCP_HANDLE_PREFIX = "ahk_";

/** O id PÚBLICO: 12 hex. Não autentica nada — é o nome pelo qual o operador revoga e o log cita. */
const HANDLE_ID_RE = /^[0-9a-f]{12}$/;
/** A parte SECRETA: exatamente 32 bytes em base64url, como `token.ts`/`token-bootstrap.ts` geram. */
const HANDLE_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** Granularidade de `lastUsedAt` — ver `touchHandle` para por que ela é grossa de propósito. */
export const HANDLE_TOUCH_THROTTLE_MS = 60 * 1000;

export const MCP_HANDLES_VERSION = 1;

export interface McpHandleRecord {
  /** id público (12 hex) — o que aparece em log/ledger e o que `revokeMcpHandle` recebe. */
  id: string;
  /** sha-256 (hex) do handle COMPLETO. O valor apresentável nunca é persistido. */
  digest: string;
  level: McpLevel;
  /** rótulo do operador ("conector do chat web") — para ele saber o que está queimando ao revogar. */
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface McpHandleRegistry {
  v: number;
  handles: McpHandleRecord[];
}

/** Onde o registro mora, a 0600, junto do resto do estado do runner (gitignorado). */
export function mcpHandlesPath(): string {
  return path.join(runnerStateDir(), "mcp-handles.json");
}

/**
 * Quebra o valor apresentado nas duas partes — ou `null` quando ele não tem a FORMA de um handle.
 *
 * O piso de forma sobre a parte SECRETA é um controle, não validação cosmética: sem ele, quem
 * conseguisse escrever no registro plantaria o digest de um segredo adivinhável (`sha256(".senha")`)
 * e autenticaria com ele. Exigir os 43 chars base64url que o gerador SEMPRE produz mantém a porta
 * fechada mesmo com um registro adulterado. Julgar a forma do que o atacante MANDOU não é oráculo —
 * ele já sabe o que mandou; o que nunca é medido aqui é o segredo esperado.
 */
export function parseMcpHandle(presented: string): { id: string; secret: string } | null {
  const v = String(presented ?? "").trim();
  if (!v.startsWith(MCP_HANDLE_PREFIX)) return null;
  const corpo = v.slice(MCP_HANDLE_PREFIX.length);
  const ponto = corpo.indexOf(".");
  if (ponto < 0) return null;
  const id = corpo.slice(0, ponto);
  const secret = corpo.slice(ponto + 1);
  if (!HANDLE_ID_RE.test(id) || !HANDLE_SECRET_RE.test(secret)) return null;
  return { id, secret };
}

/** True quando o valor TEM a forma de handle (não diz nada sobre ele ser vivo). */
export function looksLikeMcpHandle(presented: string): boolean {
  return parseMcpHandle(presented) != null;
}

/**
 * sha-256 do handle inteiro — id E segredo.
 *
 * Sem KDF de propósito: a entrada tem 256 bits de aleatoriedade, e o custo de um Argon/scrypt só
 * compra algo contra segredo de BAIXA entropia (senha humana). Cobrir o par id+segredo é o que
 * impede casar um segredo válido com outro id (ou vice-versa) para escapar de uma revogação.
 */
function handleDigest(handle: string): string {
  return createHash("sha256").update(handle, "utf8").digest("hex");
}

/** Compara digests em tempo constante. Comprimento diferente ⇒ false (timingSafeEqual lançaria). */
function digestEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * Lê o registro. SEM CACHE, de propósito: é exatamente essa releitura que faz a revogação valer no
 * request seguinte, sem o restart que o guardrail do projeto proíbe. Um cache em memória aqui
 * transformaria "revoguei" em "revogo quando puder reiniciar", que é o defeito que este módulo existe
 * para eliminar. O arquivo tem poucas entradas — o custo é um `stat`+parse por resolução.
 *
 * Tolerante: arquivo ausente/corrompido devolve registro vazio (⇒ nenhum handle autentica), nunca
 * lança. Fail-CLOSED: perder o registro fecha handles, não abre.
 *
 * SEM LOCK, também de propósito — e isso é uma decisão de segurança, não uma economia. Ler é seguro
 * porque toda escrita aterrissa por `rename` atômico (`persist`), então nenhum leitor vê arquivo pela
 * metade. Se a LEITURA esperasse o lock, quem conseguisse criar/segurar `mcp-handles.json.lock` (ou
 * um lock órfão de um processo morto) faria TODA autenticação por handle parar de responder — um
 * lock de arquivo viraria botão de negação de serviço sobre o perímetro.
 */
export async function readMcpHandles(): Promise<McpHandleRegistry> {
  const raw = await fsp.readFile(mcpHandlesPath(), "utf8").catch(() => "");
  if (!raw.trim()) return { v: MCP_HANDLES_VERSION, handles: [] };
  try {
    const obj = JSON.parse(raw) as Partial<McpHandleRegistry>;
    const handles = Array.isArray(obj?.handles) ? obj.handles : [];
    return {
      v: typeof obj?.v === "number" ? obj.v : MCP_HANDLES_VERSION,
      handles: handles.filter(
        (h): h is McpHandleRecord =>
          !!h && typeof h.id === "string" && typeof h.digest === "string" && typeof h.level === "string",
      ),
    };
  } catch {
    console.warn("[mcp-handle] registro ilegível — nenhum handle autentica até ser corrigido");
    return { v: MCP_HANDLES_VERSION, handles: [] };
  }
}

/** Escrita atômica a 0600: temp por pid + rename, para um leitor nunca ver arquivo pela metade. */
async function persist(reg: McpHandleRegistry): Promise<void> {
  const file = mcpHandlesPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // `mode` em `writeFile` só vale na CRIAÇÃO — daí o chmod explícito, que também cobre um arquivo
  // pré-existente com modo folgado (0644 herdado de uma edição manual).
  await fsp.writeFile(tmp, JSON.stringify(reg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, file);
  await fsp.chmod(file, 0o600);
}

// ── O LOCK ENTRE PROCESSOS — sem ele a REVOGAÇÃO MENTE ───────────────────────────────────────────
//
// O que este lock IMPEDE: que uma revogação já gravada seja DESFEITA por outro processo que estava
// com uma fotografia velha do registro em mãos.
//
// O defeito é concreto, não teórico. Toda mutação aqui é read-modify-write do arquivo INTEIRO
// (`readMcpHandles` → mexe → `persist`), e `withKeyedLock` (serialize.ts) serializa só DENTRO de um
// processo — o próprio doc-comment dele diz isso. Contra um segundo processo é last-writer-wins, o
// mesmo mecanismo que já reabriu 2 blockers fechados no board-data (colisão #2, acme/story-qb8z2c).
// E o caminho de operador que o `--revoke-mcp-handle` cria é EXATAMENTE um segundo processo: o
// serviço vivo, no meio de um `touchHandle` (lastUsedAt), regravaria o registro sem o `revokedAt` e o
// handle vazado voltaria a autenticar — em silêncio, sem nada no rastro. Uma revogação que pode ser
// desfeita não é uma revogação; é uma mensagem falsa para o operador.
//
// Por que arquivo de lock e não "append-only com último-vence": o registro é um documento único que
// TAMBÉM é lido no caminho de autenticação, e um formato append-only exigiria compactação (mais um
// escritor). Exclusão mútua + RE-LEITURA DENTRO da seção crítica resolve os dois lados com um
// `open(..., "wx")`, que é atômico no POSIX e não depende de biblioteca nenhuma.
//
// CUSTO DE AUTONOMIA: ZERO. Ninguém perde capacidade — emitir `full`, revogar e listar seguem
// existindo; o que muda é que duas mãos não escrevem o arquivo ao mesmo tempo.

/** O lock fica AO LADO do registro (mesmo dir 0700-ish do runner), nunca em /tmp compartilhado. */
export function mcpHandlesLockPath(): string {
  return `${mcpHandlesPath()}.lock`;
}

/**
 * A partir de quando um lock é considerado MORTO (processo levou SIGKILL no meio da seção crítica).
 *
 * Generoso de propósito: a seção crítica é ler/mexer/gravar alguns KB de JSON — milissegundos. 15s
 * nunca acontece com um processo vivo, então quebrar depois disso não corta ninguém no meio; e um
 * limite curto teria o efeito oposto do desejado (dois escritores dentro da seção ao mesmo tempo).
 */
export const HANDLE_LOCK_STALE_MS = 15_000;

/** Teto de espera de um comando de operador. Maior que {@link HANDLE_LOCK_STALE_MS} para que um lock
 *  órfão seja QUEBRADO em vez de fazer o comando desistir — desistir deixaria o registro travado
 *  para sempre por um processo que já morreu. */
export const HANDLE_LOCK_WAIT_MS = 20_000;

/** Espera do `touchHandle`: curta de propósito — ver `touchHandle`. */
export const HANDLE_LOCK_TOUCH_WAIT_MS = 2_000;

const HANDLE_LOCK_POLL_MS = 15;

/** O lock estava em outras mãos além do teto de espera. Nome próprio para o operador entender. */
export class McpHandleRegistryLockedError extends Error {
  constructor(file: string) {
    super(
      `registro de handles TRAVADO por outro processo além do teto de espera (${HANDLE_LOCK_WAIT_MS}ms). ` +
        `Lock: ${file}. Confira quem o detém (o arquivo carrega o pid) e, se o processo morreu, ` +
        `remova-o à mão.`,
    );
    this.name = "McpHandleRegistryLockedError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Quebra um lock ÓRFÃO — e SÓ ele. `true` quando o caminho ficou livre para uma nova tentativa.
 *
 * O que o `rename` impede: que dois processos que julgaram o MESMO lock morto o movam os dois. Ele é
 * atômico, então só um vence — mas a atomicidade vale para UM inode, e é aí que estava a corrida: entre
 * o `stat` que julga e o `rename` que age, o VIZINHO pode ter quebrado o órfão e criado o lock DELE. O
 * `rename` então move um inode que ninguém julgou — o lock recém-adquirido de quem já está dentro da
 * seção crítica —, e passam a existir DOIS escritores no registro, ou seja o last-writer-wins que apaga
 * um `revokedAt`: o defeito que este módulo existe para não ter, de volta pela porta do conserto.
 *
 * O controle é comparar a fotografia com o que foi movido. Depois do `rename` o inode é NOSSO e pode
 * ser inspecionado sem corrida: se o `mtime` dele não é o do órfão que julgamos, ele é lock VIVO de
 * outro processo e é DEVOLVIDO — por `link`, que falha se o caminho já existir e portanto nunca
 * sobrescreve quem tenha adquirido nesse meio-tempo.
 */
async function quebrarLockOrfao(file: string): Promise<boolean> {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return true; // já sumiu — tente de novo
  if (Date.now() - st.mtimeMs <= HANDLE_LOCK_STALE_MS) return false;
  const morto = `${file}.${process.pid}.orfao`;
  const venceu = await fsp.rename(file, morto).then(
    () => true,
    () => false,
  );
  if (!venceu) return false;

  const movido = await fsp.stat(morto).catch(() => null);
  // Mesmo inode ⇒ mesmo mtime do julgamento. Um mtime novo só existe se o arquivo movido foi CRIADO
  // depois da nossa leitura, isto é, se ele é o lock vivo do vizinho.
  if (movido && Date.now() - movido.mtimeMs <= HANDLE_LOCK_STALE_MS) {
    // `link` primeiro porque ele NÃO sobrescreve: se um terceiro já adquiriu o caminho nesse
    // meio-tempo, ele falha com EEXIST e o certo é justamente não fazer nada. Qualquer OUTRO erro
    // (filesystem sem hardlink, EPERM) cai no `rename`: devolver o lock por cima é pior que perfeito,
    // mas APAGÁ-LO seria voltar exatamente ao bug que este ramo existe para não ter.
    const devolveu = await fsp.link(morto, file).then(
      () => true,
      (err: NodeJS.ErrnoException) => err?.code === "EEXIST",
    );
    if (!devolveu) await fsp.rename(morto, file).catch(() => {});
    await fsp.unlink(morto).catch(() => {});
    return false;
  }

  console.warn(`[mcp-handle] lock órfão removido (${file}) — algum processo morreu no meio de uma escrita`);
  await fsp.unlink(morto).catch(() => {});
  return true;
}

/**
 * Roda `fn` como ÚNICO escritor do registro — dentro deste processo (withKeyedLock) E contra
 * qualquer outro (o arquivo de lock). Toda leitura de que a mutação dependa tem de acontecer DENTRO
 * de `fn`: é a re-leitura sob lock que faz uma revogação de outro processo ser VISTA em vez de
 * sobrescrita.
 */
export async function withMcpHandlesLock<T>(fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T> {
  const file = mcpHandlesLockPath();
  const teto = opts?.waitMs ?? HANDLE_LOCK_WAIT_MS;
  return withKeyedLock("mcp-handles", async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const limite = Date.now() + teto;
    for (;;) {
      // `wx` = criar-ou-falhar. É a primitiva de exclusão: o SO garante que só um processo cria.
      const fh = await fsp.open(file, "wx", 0o600).catch((err: NodeJS.ErrnoException) => {
        if (err?.code === "EEXIST") return null;
        throw err;
      });
      if (fh) {
        // O pid e a hora ficam DENTRO do lock para o operador saber quem travar culpar. Nenhum
        // segredo entra aqui — o registro ao lado já é 0600 e este arquivo é só um sinalizador.
        await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`).catch(() => {});
        await fh.close().catch(() => {});
        try {
          return await fn();
        } finally {
          await fsp.unlink(file).catch(() => {});
        }
      }
      await quebrarLockOrfao(file);
      if (Date.now() >= limite) throw new McpHandleRegistryLockedError(file);
      await sleep(HANDLE_LOCK_POLL_MS);
    }
  });
}

export interface CreatedMcpHandle {
  /** O ÚNICO momento em que o valor apresentável existe. Não é persistido nem re-derivável. */
  handle: string;
  record: McpHandleRecord;
  file: string;
}

/**
 * EMITE um handle novo — a pedido EXPLÍCITO do operador, nunca por boot.
 *
 * Mesma postura de `generateAndPersistMcpToken`: geração automática faria toda instalação nascer com
 * uma credencial VIVA para a superfície que spawna `claude --dangerously-skip-permissions`. Aqui o
 * nível é OBRIGATÓRIO e sem default — emitir `full` tem de ser uma escolha escrita, não o que
 * acontece quando ninguém decidiu.
 */
export async function createMcpHandle(input: {
  level: McpLevel;
  label?: string;
  now?: number;
}): Promise<CreatedMcpHandle> {
  const now = input.now ?? Date.now();
  return withMcpHandlesLock(async () => {
    const reg = await readMcpHandles();
    let id = randomBytes(6).toString("hex");
    while (reg.handles.some((h) => h.id === id)) id = randomBytes(6).toString("hex");
    const handle = `${MCP_HANDLE_PREFIX}${id}.${randomBytes(32).toString("base64url")}`;
    const record: McpHandleRecord = {
      id,
      digest: handleDigest(handle),
      level: input.level,
      ...(input.label ? { label: input.label.trim().slice(0, 80) } : {}),
      createdAt: new Date(now).toISOString(),
    };
    reg.handles.push(record);
    reg.v = MCP_HANDLES_VERSION;
    await persist(reg);
    return { handle, record, file: mcpHandlesPath() };
  });
}

/**
 * REVOGA um handle pelo id público. Efeito no request seguinte — sem restart.
 *
 * A entrada NÃO é apagada: um handle revogado que volta a ser apresentado é sinal de vazamento EM
 * USO, e só dá para nomeá-lo se o registro ainda o conhece. Apagar transformaria esse sinal em um
 * "desconhecida" indistinguível de um scanner qualquer.
 *
 * ⚠️ Roda sob {@link withMcpHandlesLock} porque o chamador NORMAL é um SEGUNDO PROCESSO (o comando
 * `--revoke-mcp-handle`, com o serviço vivo). Sem o lock entre processos, o `touchHandle` do serviço
 * regravaria o registro sem o `revokedAt` e o handle vazado voltaria a autenticar em silêncio.
 */
export async function revokeMcpHandle(
  id: string,
  now: number = Date.now(),
): Promise<"revogado" | "ja-revogado" | "desconhecido"> {
  return withMcpHandlesLock(async () => {
    const reg = await readMcpHandles();
    const rec = reg.handles.find((h) => h.id === id);
    if (!rec) return "desconhecido";
    if (rec.revokedAt) return "ja-revogado";
    rec.revokedAt = new Date(now).toISOString();
    await persist(reg);
    return "revogado";
  });
}

/** O que o operador PODE ver de um handle. Sem `digest` — ver {@link mcpHandleSummary}. */
export interface McpHandlePublicSummary {
  id: string;
  level: McpLevel;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/**
 * A projeção PÚBLICA de um handle — o que o `--list-mcp-handles` imprime.
 *
 * Campo por campo, NUNCA um spread do registro. O que essa escolha IMPEDE: que um campo sensível
 * acrescentado ao `McpHandleRecord` amanhã caia no terminal do operador (e no scrollback, e no
 * handoff colado num chat) só porque ninguém lembrou de filtrar. O `digest` fica de fora hoje: ele
 * não autentica — há teste provando —, mas publicá-lo não compra nada e é material para ataque
 * offline se um dia o segredo perder entropia.
 */
export function mcpHandleSummary(rec: McpHandleRecord): McpHandlePublicSummary {
  return {
    id: rec.id,
    level: rec.level,
    ...(rec.label ? { label: rec.label } : {}),
    createdAt: rec.createdAt,
    ...(rec.lastUsedAt ? { lastUsedAt: rec.lastUsedAt } : {}),
    ...(rec.revokedAt ? { revokedAt: rec.revokedAt } : {}),
  };
}

/** Todos os handles conhecidos, na projeção pública, mais novos primeiro. */
export async function listMcpHandles(): Promise<McpHandlePublicSummary[]> {
  const reg = await readMcpHandles();
  return reg.handles
    .map(mcpHandleSummary)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

let touchChain: Promise<void> = Promise.resolve();

/**
 * Marca `lastUsedAt` com granularidade GROSSA e fora do caminho crítico.
 *
 * `lastUsedAt` é sinal forense ("este handle ainda está em uso" / "este está morto e pode ser
 * revogado sem medo"), não um contador de requisições — e um write por request faria a rota MCP
 * tocar o disco em toda chamada, inclusive nas polladas de `/api/runner/pulse`. Falha aberto: um
 * erro de disco aqui não pode recusar uma credencial válida.
 *
 * ⚠️ ESTE é o escritor que podia DESFAZER uma revogação: ele regrava o registro INTEIRO, então uma
 * revogação feita por outro processo entre a leitura e a gravação era apagada — o handle vazado
 * voltava a autenticar. Duas coisas impedem isso agora: o lock ENTRE PROCESSOS e a re-leitura DENTRO
 * dele (o `revokedAt` recém-gravado é visto e a função desiste). A espera é CURTA e a desistência é
 * silenciosa de propósito: perder um `lastUsedAt` custa um sinal forense; travar o caminho de
 * autenticação por 20s custaria a superfície.
 */
function touchHandle(id: string, now: number): void {
  touchChain = touchChain
    .then(() =>
      withMcpHandlesLock(async () => {
        const reg = await readMcpHandles();
        const rec = reg.handles.find((h) => h.id === id);
        if (!rec || rec.revokedAt) return;
        const anterior = rec.lastUsedAt ? Date.parse(rec.lastUsedAt) : Number.NEGATIVE_INFINITY;
        if (Number.isFinite(anterior) && now - anterior < HANDLE_TOUCH_THROTTLE_MS) return;
        rec.lastUsedAt = new Date(now).toISOString();
        await persist(reg);
      }, { waitMs: HANDLE_LOCK_TOUCH_WAIT_MS }),
    )
    .catch((err) =>
      console.warn("[mcp-handle] lastUsedAt não gravou (não-fatal):", err instanceof Error ? err.message : err),
    );
}

/** Resolve quando todo `lastUsedAt` pendente foi persistido. Nunca rejeita. */
export function flushHandleTouches(): Promise<void> {
  return touchChain;
}

/** O veredito da resolução de um HANDLE. `revogado` é sinal de vazamento em uso — ver abaixo. */
export type McpHandleVerdict =
  | { outcome: "ok"; record: McpHandleRecord }
  /** o valor não tem a forma de handle ⇒ tente o caminho legado. */
  | { outcome: "nao-e-handle" }
  /** forma de handle, mas nada vivo casa. */
  | { outcome: "desconhecido" }
  | { outcome: "revogado"; handleId: string; revokedAt: string };

/**
 * Resolve o valor apresentado contra o registro de handles.
 *
 * ⚠️ O veredito é para o RASTRO, nunca para a RESPOSTA: a rota MCP continua devolvendo 404 nu em
 * qualquer recusa. Distinguir "revogado" de "desconhecido" na resposta entregaria ao atacante um
 * oráculo sobre quais handles já existiram.
 */
export async function resolveMcpHandle(presented: string, now: number = Date.now()): Promise<McpHandleVerdict> {
  const parsed = parseMcpHandle(presented);
  if (!parsed) return { outcome: "nao-e-handle" };
  const reg = await readMcpHandles();
  const digest = handleDigest(String(presented).trim());
  // Casa por id (público, não-secreto) e confirma com o digest em tempo constante — o id só reduz a
  // lista; quem decide é a comparação constante.
  const rec = reg.handles.find((h) => h.id === parsed.id && digestEquals(h.digest, digest));
  if (!rec) return { outcome: "desconhecido" };
  if (rec.revokedAt) return { outcome: "revogado", handleId: rec.id, revokedAt: rec.revokedAt };
  touchHandle(rec.id, now);
  return { outcome: "ok", record: rec };
}

/** Um tier de token LEGADO: a env que segura o segredo e o nível que ele concede. */
export interface McpTokenTier {
  tokenEnv: string;
  level: McpLevel;
}

/**
 * Os tiers legados NA ORDEM DE RESOLUÇÃO DE HOJE: o primário (`full`) primeiro, depois cada entrada
 * de `settings.mcpTokens`. Reproduz `resolveActor` da route — a ordem é comportamento observável e
 * mudá-la mudaria silenciosamente o nível de alguém.
 */
export function legacyMcpTokenTiers(): McpTokenTier[] {
  const escopados = (() => {
    try {
      return loadRunnerConfig().mcpTokens ?? [];
    } catch {
      return []; // config ilegível ⇒ só o primário; nunca fail-open para um tier inventado
    }
  })();
  return [{ tokenEnv: MCP_TOKEN_ENV, level: "full" as McpLevel }, ...escopados];
}

/**
 * O ambiente como MAPA de consulta, e não `NodeJS.ProcessEnv`.
 *
 * `process.env` é assinável para isto, então o chamador de produção não muda; o motivo do tipo largo
 * é o teste poder injetar um tier escopado sem precisar montar um `ProcessEnv` inteiro (que nesta
 * base exige `NODE_ENV`) — e um controle que só é exercitável com ginástica é um controle que ninguém
 * exercita.
 */
export type EnvLookup = Record<string, string | undefined>;

/** Por onde a credencial que autenticou chegou — o dado que a depreciação do path vai medir. */
export type McpCredentialVia = "handle" | "token-legado";

export interface McpCredential {
  level: McpLevel;
  via: McpCredentialVia;
  /** presente em `token-legado`: a env que segura o segredo. */
  tokenEnv?: string;
  /** presente em `handle`: o id público. */
  handleId?: string;
  label?: string;
}

/**
 * Compara o valor apresentado com os tiers legados, na ordem. `isMcpTokenValid` é quem julga (piso
 * de força sobre o segredo CONFIGURADO + comparação em tempo constante) — não há segunda régua aqui.
 */
export function resolveLegacyMcpToken(
  presented: string,
  env: EnvLookup = process.env,
  tiers: McpTokenTier[] = legacyMcpTokenTiers(),
): McpCredential | null {
  for (const t of tiers) {
    if (isMcpTokenValid(presented, env[t.tokenEnv])) {
      return { level: t.level, via: "token-legado", tokenEnv: t.tokenEnv };
    }
  }
  return null;
}

export type McpCredentialResolution =
  | { ok: true; credential: McpCredential }
  | { ok: false; reason: AuthFailureReason; handleId?: string };

/**
 * A resolução ÚNICA da credencial do perímetro MCP: handle OU token legado, dizendo qual entrou.
 *
 * Ordem e por quê: handle primeiro (é a forma reconhecível e o caminho que queremos observar), legado
 * depois (compatibilidade). Um handle REVOGADO NÃO cai para o legado — cair seria transformar uma
 * revogação num "tenta o outro caminho" e apagar o sinal de vazamento em uso.
 *
 * O `reason` sai no vocabulário de `auth-audit.ts` (uma verdade só para o rastro), e é para o LEDGER:
 * a resposta da rota segue 404 nu em todos os casos.
 */
export async function resolveMcpCredential(
  presented: string,
  opts?: { env?: EnvLookup; now?: number; tiers?: McpTokenTier[] },
): Promise<McpCredentialResolution> {
  const valor = String(presented ?? "").trim();
  if (!valor) return { ok: false, reason: "ausente" };

  const v = await resolveMcpHandle(valor, opts?.now ?? Date.now());
  if (v.outcome === "ok") {
    return {
      ok: true,
      credential: {
        level: v.record.level,
        via: "handle",
        handleId: v.record.id,
        ...(v.record.label ? { label: v.record.label } : {}),
      },
    };
  }
  if (v.outcome === "revogado") return { ok: false, reason: "handle-revogado", handleId: v.handleId };

  const legado = resolveLegacyMcpToken(valor, opts?.env ?? process.env, opts?.tiers ?? legacyMcpTokenTiers());
  if (legado) return { ok: true, credential: legado };
  return { ok: false, reason: "desconhecida" };
}

/**
 * O rótulo de ATOR para o ledger (`agent-actions`, story-et6a4j) — atribuição sem segredo.
 *
 * `env:<VAR>` ou `handle:<id>`: nenhum dos dois autentica, e os dois identificam a credencial usada,
 * que é o que faz um incidente ser reconstruível. NUNCA monte esse rótulo a partir do valor
 * apresentado — foi assim que 174 linhas de log ganharam um token.
 */
export function mcpActorLabel(credential: McpCredential): string {
  if (credential.via === "handle") return `handle:${credential.handleId ?? "?"}`;
  return `env:${credential.tokenEnv ?? MCP_TOKEN_ENV}`;
}

/**
 * Descreve para log o valor apresentado que NÃO autenticou. Delega a `maskSecret` (mcp/auth.ts) — só
 * o comprimento sai, nem prefixo nem sufixo. Existe para ninguém "melhorar" o log com um
 * `slice(0,8)`, que entregaria 8 chars do segredo a quem lê o journal.
 */
export function describeAttemptedCredential(presented: string | undefined | null): string {
  return maskSecret(presented);
}
