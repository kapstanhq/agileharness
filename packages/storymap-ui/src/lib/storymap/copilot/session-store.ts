// Persistência CROSS-DISPOSITIVO das conversas do chat do Jido — o ROSTER `board → conversas` (uma aberta,
// as anteriores recuperáveis). A álgebra é pura e mora em `chat-roster.ts`; aqui só a IO: ler, aplicar e
// gravar, sempre dentro do keyed-lock do board.
//
// O thread REAL não é duplicado: ele já vive, durável, no transcript que o CLI grava por sessão
// (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl). O que se perdia ao fechar o navegador era o sessionId
// (morava só no sessionStorage, por-aba). Guardamos SÓ os ponteiros, para que a UI, aberta de qualquer
// navegador/dispositivo, resolva sessionId → hidrate do transcript (ver transcript-history.ts).
//
// Onde: `.runner/copilot-sessions/<board>.json` — estado de RUNTIME, NÃO vai pro git (o transcript referenciado
// só existe nesta máquina; um ponteiro commitado seria lixo em outro checkout, e o snapshot "estado vivo" do
// autorun poderia varrê-lo). `.runner/` é gitignored, junto do journal/telemetria.
//
// "Nova conversa" — TOMBSTONE DURÁVEL (a barreira do lado servidor). Fechar a conversa não pode ser só mudar o
// ponteiro: os DOIS escritores (writeCopilotSessionPointer no INÍCIO de cada turno/tick e recordCopilotTurnUsage
// no FIM) carregam o sessionId da vez, e um turno da sessão X ainda EM VOO quando o operador clica "Nova
// conversa" re-apontaria o board para X DEPOIS — reabrindo sozinha a conversa que ele acabou de fechar. O guard
// antigo vivia só na memória do cliente (clearedSessionIdRef): evaporava no refresh e não impedia o servidor.
// Então o fechamento grava `discardedSessionId: X` e todo escritor o RESPEITA (a álgebra faz isso); só uma
// sessão NOVA — ou a retomada EXPLÍCITA do operador — o supera. As operações serializam pelo MESMO keyed-lock
// por board → o read-modify-write não interleava (senão o fechamento e um straggler dariam last-writer-wins).
//
// O que MUDOU com o roster: "Nova conversa" deixou de ser uma DELEÇÃO. A conversa fechada continua listada
// (recuperável com um toque, como o `--resume` do CLI); o tombstone segue existindo, mas agora significa
// "fechada", não "descartada". Nenhum transcript é apagado por este módulo, nunca — nem o da conversa que o
// teto expulsa do roster (ela só deixa de ser oferecida).

import { promises as fs } from "node:fs";
import path from "node:path";
import { runnerStateDir, sanitizeId } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";
import {
  EMPTY_ROSTER,
  activateChat,
  activeChat,
  forgetChats,
  recordChatTurn,
  resumeChat,
  setChatTitle,
  startNewChat,
  type ChatRoster,
  type CopilotChatEntry,
} from "./chat-roster";

export type { CopilotChatEntry } from "./chat-roster";
export { MAX_RECOVERABLE_CHATS } from "./chat-roster";

/**
 * O roster é por RAIA (ver copilot/agent-session `boardScope`/`viewScope`): cada conversa tem o seu histórico,
 * o seu "nova conversa" e o seu medidor. Um roster por board só funcionava quando existia um chat só.
 *
 * O nome do arquivo preserva o LEGADO: a raia do board continua sendo `<board>.json` — renomear o arquivo
 * apagaria da tela o histórico que o operador já tem. Uma raia de tela vira `<board>--<view>.json`. Um valor
 * SEM prefixo é aceito e tratado como board (era assim que todos os callers chamavam antes desta mudança).
 */
function chatFileFor(scope: string): string {
  if (scope.startsWith("board:")) return sanitizeId(scope.slice("board:".length));
  if (scope.startsWith("view:")) return sanitizeId(scope.slice("view:".length).replace(/:/g, "--"));
  return sanitizeId(scope); // legado: boardId cru
}

/** Serializa TODAS as mutações do roster de UMA raia, para o read-modify-write não interleavar. */
function pointerLockKey(scope: string): string {
  return `copilot-pointer:${chatFileFor(scope)}`;
}

/** `.runner/copilot-sessions/<raia>.json` — o roster durável de UMA conversa. */
export function copilotSessionPointerPath(scope: string): string {
  return path.join(runnerStateDir(), "copilot-sessions", `${chatFileFor(scope)}.json`);
}

export interface CopilotSessionPointer {
  sessionId: string;
  updatedAt: string; // ISO
  /** MEDIDOR da conversa ABERTA — o que o operador precisa p/ decidir entre seguir, compactar ou começar outra. */
  stats?: CopilotSessionStats;
}

export interface CopilotSessionStats {
  /** ISO do PRIMEIRO turno desta conversa. */
  startedAt: string;
  /** ISO do último turno — a "idade" que a UI mostra ("ociosa há 40min"). */
  lastTurnAt: string;
  /** turnos do operador nesta conversa. */
  turns: number;
  /**
   * TAMANHO DO CONTEXTO depois do último turno: input (prompt + os dois caches, tudo que o modelo LEU) +
   * output do último turno. Não é a soma dos turnos — o input do turno N já contém a conversa inteira até ali,
   * então somar contaria a mesma conversa N vezes.
   */
  contextTokens: number;
  /** custo acumulado da conversa (soma dos turnos — aqui somar é correto). */
  costUSD: number;
}

// ── Disco ↔ roster ────────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Coerção defensiva de UMA entrada (um arquivo de outra versão não pode derrubar o chat). */
function coerceEntry(raw: unknown): CopilotChatEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const sessionId = str(e.sessionId);
  if (!sessionId) return null;
  return {
    sessionId,
    ...(str(e.title) ? { title: str(e.title) } : {}),
    startedAt: str(e.startedAt),
    lastTurnAt: str(e.lastTurnAt),
    turns: num(e.turns),
    contextTokens: num(e.contextTokens),
    costUSD: num(e.costUSD),
  };
}

/**
 * Lê o roster do disco. Nunca lança (ausente/corrompido ⇒ roster vazio) e nunca serializa — quem precisa do
 * RMW atômico já roda dentro do keyed-lock.
 *
 * MIGRA o formato antigo (`{sessionId, stats}` — um ponteiro só, sem histórico) para uma lista de uma
 * conversa: o operador que atualiza o serviço no meio de uma investigação não perde o fio dela.
 */
async function readRoster(scope: string): Promise<ChatRoster> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(copilotSessionPointerPath(scope), "utf8")) as Record<string, unknown>;
  } catch {
    return EMPTY_ROSTER;
  }
  if (!raw || typeof raw !== "object") return EMPTY_ROSTER;
  // `sessionId` é o nome LEGADO do ponteiro ativo (formato pré-roster).
  const activeSessionId = str(raw.activeSessionId) || str(raw.sessionId) || null;
  const discardedSessionId = str(raw.discardedSessionId) || null;
  const chats = Array.isArray(raw.chats)
    ? raw.chats.map(coerceEntry).filter((c): c is CopilotChatEntry => c !== null)
    : [];
  if (!chats.length && activeSessionId) {
    // formato legado: a única conversa conhecida é a apontada, com as stats soltas na raiz.
    const s = (raw.stats ?? {}) as Record<string, unknown>;
    chats.push({
      sessionId: activeSessionId,
      startedAt: str(s.startedAt) || str(raw.updatedAt),
      lastTurnAt: str(s.lastTurnAt) || str(raw.updatedAt),
      turns: num(s.turns),
      contextTokens: num(s.contextTokens),
      costUSD: num(s.costUSD),
    });
  }
  // Um ativo que não está na lista não é ativo (arquivo editado/truncado à mão).
  const active = activeSessionId && chats.some((c) => c.sessionId === activeSessionId) ? activeSessionId : null;
  return { activeSessionId: active, discardedSessionId, chats };
}

/** Grava o roster. Best-effort: uma falha de IO nunca quebra o chat (só não persiste desta vez). */
async function writeRoster(scope: string, r: ChatRoster, now: number): Promise<void> {
  const p = copilotSessionPointerPath(scope);
  const rec = {
    ...(r.activeSessionId ? { activeSessionId: r.activeSessionId } : {}),
    ...(r.discardedSessionId ? { discardedSessionId: r.discardedSessionId } : {}),
    updatedAt: new Date(now).toISOString(),
    chats: r.chats,
  };
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

/**
 * O RMW atômico: lê o roster, aplica a transformação PURA e grava se algo mudou. Todo escritor deste módulo
 * passa por aqui — é o que garante que lock, migração de formato e "não gravar à toa" existam em UM lugar.
 * Nunca lança; devolve o roster resultante (ou o lido, quando a transformação não mudou nada).
 */
async function mutate(
  scope: string,
  fn: (r: ChatRoster) => ChatRoster | null,
  now = Date.now(),
): Promise<ChatRoster> {
  return withKeyedLock(pointerLockKey(scope), async () => {
    let current = EMPTY_ROSTER;
    try {
      current = await readRoster(scope);
      const next = fn(current);
      if (!next || next === current) return current;
      await writeRoster(scope, next, now);
      return next;
    } catch {
      return current; // best-effort
    }
  });
}

// ── Leitura ───────────────────────────────────────────────────────────────────────────────────────────

/** Lê o ponteiro da conversa ABERTA (null quando não há nenhuma). Nunca lança. */
export async function readCopilotSessionPointer(scope: string): Promise<CopilotSessionPointer | null> {
  const r = await readRoster(scope).catch(() => EMPTY_ROSTER);
  const c = activeChat(r);
  if (!c) return null;
  return {
    sessionId: c.sessionId,
    updatedAt: c.lastTurnAt || c.startedAt,
    // Conversa sem nenhum turno ainda não tem medidor (era `stats` ausente no formato antigo).
    ...(c.turns > 0 ? { stats: { startedAt: c.startedAt, lastTurnAt: c.lastTurnAt, turns: c.turns, contextTokens: c.contextTokens, costUSD: c.costUSD } } : {}),
  };
}

/** O roster inteiro (a aberta + as recuperáveis), para a lista de conversas da UI. Nunca lança. */
export async function readCopilotChats(scope: string): Promise<ChatRoster> {
  return readRoster(scope).catch(() => EMPTY_ROSTER);
}

// ── Escrita ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Grava/atualiza o ponteiro do board (chamado quando um turno resolve seu sessionId — fresh ou resume) e
 * registra a conversa no roster. Respeita o tombstone: um turno da conversa recém-fechada não a reabre.
 */
export async function writeCopilotSessionPointer(scope: string, sessionId: string, now = Date.now()): Promise<void> {
  const sid = sessionId?.trim();
  if (!sid) return;
  const iso = new Date(now).toISOString();
  await mutate(scope, (r) => activateChat(r, sid, iso), now);
}

/**
 * Registra o USO de UM turno que acabou (o evento `result` do CLI) no medidor da conversa dele. Se a conversa
 * não é a aberta, o medidor DELA é atualizado sem roubar a tela (ver chat-roster). Best-effort: uma falha de
 * IO só perde o medidor daquele turno.
 */
export async function recordCopilotTurnUsage(
  scope: string,
  sessionId: string,
  usage: { contextTokens?: number | null; costUSD?: number | null },
  now = Date.now(),
): Promise<void> {
  const sid = sessionId?.trim();
  if (!sid) return;
  const iso = new Date(now).toISOString();
  await mutate(scope, (r) => recordChatTurn(r, sid, usage, iso), now);
}

/**
 * "Nova conversa": FECHA a conversa aberta (que segue no histórico, recuperável) e grava o tombstone. O
 * history/medidor veem vazio na hora, e um turno em voo da conversa fechada não a reabre. Nunca lança.
 */
export async function startNewCopilotChat(scope: string, now = Date.now()): Promise<void> {
  await mutate(scope, (r) => startNewChat(r), now);
}

/**
 * RETOMA uma conversa do histórico — o gesto explícito do operador (a única coisa que supera o tombstone).
 * `false` quando a sessão não está no roster: recuperar o que a lista não oferece transformaria um id
 * qualquer em ponteiro do board.
 */
export async function resumeCopilotChat(scope: string, sessionId: string, now = Date.now()): Promise<boolean> {
  const sid = sessionId?.trim();
  if (!sid) return false;
  const after = await mutate(scope, (r) => resumeChat(r, sid), now);
  return after.activeSessionId === sid;
}

/**
 * A passada de MANUTENÇÃO da lista, em UMA escrita: cacheia os rótulos que a UI acabou de resolver do
 * transcript e esquece o que não abre mais (transcript coletado pelo GC do CLI — só o ponteiro é esquecido;
 * nenhum arquivo é tocado).
 *
 * As duas coisas andam juntas de propósito: elas nascem da MESMA varredura (abrir a lista) e, separadas,
 * custavam um lock + um write por conversa — seis escritas para desenhar um menu. Best-effort: nunca lança.
 */
export async function reconcileCopilotChats(
  scope: string,
  input: { titles?: readonly { sessionId: string; title: string }[]; gone?: readonly string[] },
  now = Date.now(),
): Promise<void> {
  const titles = input.titles ?? [];
  const gone = input.gone ?? [];
  if (!titles.length && !gone.length) return;
  await mutate(
    scope,
    (r) => {
      let next = forgetChats(r, gone);
      for (const t of titles) next = setChatTitle(next, t.sessionId, t.title);
      return next === r ? null : next;
    },
    now,
  );
}
