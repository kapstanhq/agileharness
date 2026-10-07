// Copiloto agêntico (F1) — o IO que dirige UM turno headless do chat paired: spawn nativo do CLI
// (`claude -p --output-format stream-json`) com tools nativas (--dangerously-skip-permissions) + MCP storymap
// FULL, memória por sessão (--session-id/--resume), watchdog, e cancel real (mata o processo). A parte pura
// (argv, classificação de evento) mora em protocol.ts; aqui é só processo + registries.
//
// SEGURANÇA: a conversa do board (propósito `copilot`) é a CENTRAL DE COMANDO do dono (fase 6) — token MCP full + Bash
// nativo + skip-permissions, em qualquer modo do board. É o processo MAIS PODEROSO do sistema e é seguro SÓ porque a
// rota que o chama (/api/copilot/turn) fica atrás do login — NUNCA expor /api/copilot/* fora do auth. Mesmo modelo de
// confiança de um `claude` interativo na VPS. O que o contém (copilot/chat-powers.ts): as tools nativas são uma lista
// do PERMITIDO sem shell fora da trava dura do host; toda ação vai para a trilha de auditoria em nome do chat
// (copilot/chat-audit.ts — MCP pela guarda, nativas pelo stream daqui); e a régua de confirmação da persona.
//
// As conversas de TELA (documento, vocabulário) declaram `ro` + Write/Edit negadas no próprio propósito. O LIMITE, dito
// em voz alta: Bash fica (poder de diagnóstico), então a garantia delas é sobre o BOARD, não sobre o repositório.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { findRepoRoot } from "../paths";
import { loadRunnerConfig } from "../runner/config";
import { buildOrchestratorMcpConfig } from "../runner/orchestrator-spawn";
import { docChatCaller } from "../mcp/caller";
import { sanitizeSpawnEnv } from "../runner/spawn-env";
import { createNdjsonParser } from "../runner/stream-json";
import { hitlPurposeById, resolveHitlPrompt } from "../hitl/purpose-registry";
import { readBoardConfig } from "../repo";
import { copilotTier } from "./tier";
import { chatSpawnPlan } from "./chat-powers";
import { createChatNativeRecorder } from "./chat-audit";
import { hardDenyHookInstalled } from "../runner/claude-settings";
import { resolveCopilotModelEffort } from "./model";
import { rememberModelResolution } from "./model-resolution";
import { getHelperRegistry } from "@/lib/vps/helper-registry";
import {
  assistantContextTokens,
  buildCopilotTurnArgs,
  createCopilotInterpreter,
  mcpUnavailableText,
  BOARD_UNCONFIGURED_CLAUSE,
  RESUME_SESSION_MISSING_RE,
  type CopilotSseEvent,
} from "./protocol";
import { recordCopilotTurnUsage, writeCopilotSessionPointer } from "./session-store";
import { resolvedClaudeBin } from "../runner/claude-bin";

const DEFAULT_TIMEOUT_MS = Number(process.env.AGILEHARNESS_COPILOT_TIMEOUT_MS) || 600_000;
/** Uma entrada `LIVE` órfã além disto (o teto do turno + folga) é ignorada e removida por hasLiveCopilotTurn —
 *  backstop de TTL p/ que nem um processo zumbi segure o 409 indefinidamente até o restart do serviço. */
const LIVE_TTL_MS = DEFAULT_TIMEOUT_MS + 60_000;

/** Delay aguardável — o killTree espera entre o SIGTERM e o SIGKILL. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Mata a ÁRVORE (grupo de processos) do turno. No POSIX o child é spawnado `detached`, então o `claude` + cada
 * subprocesso que ele forka (netos: Bash de tool, servidores MCP) formam um PROCESS GROUP liderado pelo pid do
 * child — sinalizar o pid NEGATIVO alcança um neto de tool PENDURADO que um `child.kill()` seco orfanaria (e que,
 * herdando o pipe de stdout, ATRASA/impede o `close`). Escala SIGTERM → poll(150ms) → SIGKILL, confirmando a
 * morte via kill(-pid, 0) (lança ESRCH quando o grupo sumiu). Fallback p/ pid seco se o envio ao grupo lança
 * (edge não-detached). No Windows, `taskkill /T /F` já mata a árvore. Espelha o killTree do engine.ts (story-#30).
 *
 * `killProcess` é injetável p/ um teste unitário afirmar a escalada SIGTERM→SIGKILL contra um processo FAKE sem
 * sinalizar um real. Assíncrono — o watchdog/cancel aguardam a derrubada confirmada.
 */
export async function killTree(
  child: ChildProcess,
  killProcess: (pid: number, signal?: NodeJS.Signals | 0) => void = process.kill.bind(process),
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    await delay(200);
    return;
  }
  // POSIX: sinaliza o GRUPO (pid negativo); cai no pid seco se aquilo lança (edge não-detached).
  const sig = (s: NodeJS.Signals | 0): void => {
    try {
      killProcess(-pid, s);
    } catch {
      try {
        killProcess(pid, s);
      } catch {
        /* já morreu (ESRCH) */
      }
    }
  };
  const groupAlive = (): boolean => {
    try {
      killProcess(-pid, 0); // 0 = sonda de vida; lança ESRCH quando o grupo está vazio
      return true;
    } catch {
      try {
        killProcess(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  };
  sig("SIGTERM");
  await delay(150);
  if (groupAlive()) {
    sig("SIGKILL"); // claude ignorou o SIGTERM → derruba o grupo inteiro à força
    await delay(100);
  }
}

// ── Registries globalThis-pinned (sobrevivem ao HMR do Next e são a MESMA instância entre bundles de rota;
//    um Map module-level daria instâncias separadas → cancel/binding viram no-op silencioso). Mesmo truque de
//    getHelperRegistry/dev-tools. ──────────────────────────────────────────────────────────────────────────
interface LiveTurn {
  boardId: string;
  /**
   * A RAIA da conversa (ver `boardScope`/`ideaScope`). A concorrência é chaveada por ela, não pelo board: o
   * chat do board é uma raia (compartilhada com o tick autônomo), e cada Ideia aberta é outra. Sem isto,
   * conversar dentro de uma Ideia tomaria o único slot do board e travaria o Jido — e vice-versa.
   */
  scope: string;
  sessionId: string;
  child: ChildProcess;
  /** epoch ms do spawn — backstop de TTL contra entradas órfãs (processo zumbi que nunca fecha). */
  startedAt: number;
  /** encerra o turno de forma idempotente (limpa o LIVE, resolve a tentativa, encerra o helper). É o `finish`
   *  do turno, exposto na entrada p/ o cancel (killCopilotTurn) e o watchdog o dispararem sem depender do `close`. */
  settle: () => void;
}
const g = globalThis as unknown as {
  __copilotLiveTurns?: Map<string, LiveTurn>;
  __copilotSessionScope?: Map<string, string>;
  __copilotReservedTurns?: Map<string, number>;
};
const LIVE: Map<string, LiveTurn> = (g.__copilotLiveTurns ??= new Map());
/** sessionId → raia da sessão. Um --resume noutra raia é rejeitado (contexto não vaza entre conversas). */
const SESSION_SCOPE: Map<string, string> = (g.__copilotSessionScope ??= new Map());
/** raia → epoch ms da RESERVA do slot de turno (ver reserveCopilotTurnSlot). */
const RESERVED: Map<string, number> = (g.__copilotReservedTurns ??= new Map());

/**
 * As RAIAS. Uma raia = uma conversa que corre sozinha: um turno em voo por raia, sessão própria, e nenhuma
 * bloqueia a outra. O chat do board é a raia histórica (e a que o tick autônomo compartilha); cada TELA com
 * chat (ver copilot/chat-surfaces) ganha a sua, porque conversar numa tela não pode parar a orquestração.
 *
 * Por TELA e não por artefato (decisão do Operador): a tela de Ideias tem UMA conversa que enxerga todas as
 * ideias. Uma raia por ideia multiplicaria sessão, histórico e processo por algo que ninguém pediu para
 * separar — e quem explora uma ideia quase sempre está comparando com as outras.
 *
 * O prefixo é o que impede colisão: sem ele um board chamado `x` e uma view chamada `x` cairiam na mesma chave.
 */
export const boardScope = (boardId: string) => `board:${boardId}`;
export const viewScope = (boardId: string, view: string) => `view:${boardId}:${view}`;

const liveKey = (scope: string, sessionId: string) => `${scope}::${sessionId}`;

/** Entrada órfã além do TTL (turno morto/zumbi que nunca fechou) → tratada como ausente. */
function isExpired(entry: LiveTurn): boolean {
  return Date.now() - entry.startedAt > LIVE_TTL_MS;
}

/** Já existe um turno VIVO p/ (raia, session)? A rota devolve 409 se sim (1 turno por sessão). Uma entrada além
 *  do TTL é removida e tratada como ausente — nenhum turno morto segura o 409 indefinidamente. */
export function hasLiveCopilotTurn(scope: string, sessionId: string): boolean {
  const key = liveKey(scope, sessionId);
  const entry = LIVE.get(key);
  if (!entry) return false;
  if (isExpired(entry)) {
    LIVE.delete(key);
    return false;
  }
  return true;
}

/** Reserva órfã além do TTL (a rota morreu sem liberar) → tratada como ausente. O TTL é o mesmo do turno porque
 *  a reserva cobre o turno INTEIRO (a rota só a solta quando o processo termina). */
function hasReservation(scope: string): boolean {
  const at = RESERVED.get(scope);
  if (at === undefined) return false;
  if (Date.now() - at > LIVE_TTL_MS) {
    RESERVED.delete(scope);
    return false;
  }
  return true;
}

/** A RAIA está ocupada? (uma raia = uma conversa) — turno já registrado OU slot reservado. É a régua ÚNICA que a
 *  rota do turno usa p/ barrar dois turnos concorrentes na mesma conversa (duplo-clique, aba dupla, fila
 *  re-tentando). Remove entradas/reservas expiradas. */
export function hasLiveCopilotTurnInScope(scope: string): boolean {
  let found = false;
  for (const [key, entry] of LIVE) {
    if (entry.scope !== scope) continue;
    if (isExpired(entry)) {
      LIVE.delete(key);
      continue;
    }
    found = true;
  }
  return found || hasReservation(scope);
}

/**
 * O CHAT DO BOARD está ocupado? É o que o dispatcher do tick pergunta antes de acordar — o tick resume a MESMA
 * sessão do chat do board, então um turno pareado ali corromperia o transcript.
 *
 * Repare no recorte: só a raia do board conta. Uma conversa dentro de uma Ideia roda em raia própria, com
 * sessão própria, e por isso NÃO segura o tick (nem é segurada por ele) — que é o ponto inteiro das raias.
 */
export function hasLiveCopilotTurnForBoard(boardId: string): boolean {
  return hasLiveCopilotTurnInScope(boardScope(boardId));
}

/**
 * RESERVA SÍNCRONA do slot de turno do board — o que fecha a janela TOCTOU do 409.
 *
 * O registro de turno vivo (`LIVE.set`) só acontece DEPOIS de vários awaits do setup do spawn (mkdtemp,
 * readBoardConfig, writeFile da persona/MCP). Entre o check da rota e esse set cabia um segundo POST: dois
 * `claude` resumindo a MESMA sessão do board — exatamente o que o 409 existe para impedir. Enquanto o cliente
 * desistia no primeiro 409 a janela era estreita e teórica; com a FILA do chat re-tentando sozinha ela deixou de
 * ser (duas abas saindo do backoff no mesmo instante a acertam). Checar-e-marcar aqui roda no MESMO tick do event
 * loop, antes de qualquer await — não há interleave possível.
 *
 * Quem reserva DEVE liberar (`release`, idempotente) quando o turno termina — a rota faz isso no `finally` do
 * stream. O TTL acima é o backstop se a rota morrer no meio.
 */
export function reserveCopilotTurnSlot(scope: string): { ok: true; release: () => void } | { ok: false } {
  if (hasLiveCopilotTurnInScope(scope)) return { ok: false };
  RESERVED.set(scope, Date.now());
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      RESERVED.delete(scope);
    },
  };
}

/** Resume cross-raia? true = a sessão está atrelada a OUTRA conversa (a rota rejeita — evita vazar contexto:
 *  retomar no chat do board uma sessão que nasceu dentro de uma Ideia despejaria a exploração ali). */
export function resumeScopeMismatch(sessionId: string, scope: string): boolean {
  const bound = SESSION_SCOPE.get(sessionId);
  return bound !== undefined && bound !== scope;
}

/** Cancela o turno em voo: tenta a chave exata; senão mata qualquer turno vivo DESTA raia (fallback re-keyed). */
export function killCopilotTurn(scope: string, sessionId?: string): boolean {
  if (sessionId) {
    const key = liveKey(scope, sessionId);
    const exact = LIVE.get(key);
    if (exact) {
      void killTree(exact.child); // grupo SIGTERM→SIGKILL (assíncrono; belt do exit handler)
      exact.settle(); // 3.1b — settla o turno JÁ (resolve a tentativa + encerra o helper); antes o match exato NÃO limpava → 409 preso
      LIVE.delete(key); // libera o 409 na hora (o settle também limpa; explícito p/ não depender do closure)
      return true;
    }
  }
  let killed = false;
  for (const [key, t] of LIVE) {
    if (t.scope === scope) {
      void killTree(t.child);
      t.settle();
      LIVE.delete(key);
      killed = true;
    }
  }
  return killed;
}

export interface CopilotTurnRequest {
  boardId: string;
  /** prompt JÁ composto (bloco <contexto> + texto do humano + tails de imagem). vai por stdin. */
  prompt: string;
  /** presente ⇒ resume; ausente ⇒ fresh (cunha um uuid). */
  sessionId?: string;
  model?: string;
  effort?: string;
  /** a raia (ver boardScope/ideaScope). Ausente ⇒ o chat do board — o comportamento histórico. */
  scope?: string;
  /** qual PROPÓSITO do HITL dá a persona deste turno. Ausente ⇒ "copilot" (o Jido do board). */
  purposeId?: string;
}

// F3.3 — a resolução mudou de casa (copilot/model.ts) para que o SPAWN DO TICK também a use sem fechar um ciclo
// de import (este módulo importa runner/orchestrator-spawn). Re-exportada aqui porque os consumidores antigos
// (copilot-actions.ts) a importam deste ponto — é o mesmo símbolo, não uma segunda verdade.
export { resolveCopilotModelEffort };

/**
 * Dirige UM turno do Jido: monta persona + config MCP, spawna, streama eventos via `onEvent`, e resolve
 * quando o processo fecha. Faz o fallback resume→fresh UMA vez (assinatura RESUME_SESSION_MISSING_RE) cunhando
 * um novo session id (reportado ao cliente via `init {fresh:true}`). Nunca lança — falhas viram evento `error`.
 * Retorna o session id ATIVO no início (a rota usa p/ a chave de cancel/binding); o cliente aprende o id real
 * pelos eventos `init`.
 */
export async function runCopilotTurn(
  req: CopilotTurnRequest,
  onEvent: (ev: CopilotSseEvent) => void,
): Promise<{ sessionId: string; done: Promise<void> }> {
  // O PROPÓSITO primeiro: é ele que declara o tier (o Explorador é sonnet/medium; o Jido é opus). Resolver o
  // modelo antes de saber o propósito era o que fazia o tier declarado no registro virar letra morta.
  const purposeId = req.purposeId ?? "copilot";
  const purpose = hitlPurposeById(purposeId);
  if (!purpose) throw new Error(`propósito HITL desconhecido: ${purposeId}`);
  const { model, effort } = resolveCopilotModelEffort(req.model, req.effort, purposeId);
  const bin = resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
  const cwd = findRepoRoot();
  const port = Number(process.env.PORT) || 3008;

  // Env saneado (nunca o env cru do next-server) + IS_SANDBOX=1 só quando root POSIX (o CLI recusa root sem ele).
  const baseEnv = sanitizeSpawnEnv(process.env);
  const env =
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0
      ? { ...baseEnv, IS_SANDBOX: "1" }
      : baseEnv;

  // Arquivos temporários do turno: persona (--append-system-prompt-file, re-emitida todo turno = compaction-proof,
  // idiom do engine) + config MCP (só a superfície storymap; token no arquivo, não no env do filho).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-turn-"));
  const personaPath = path.join(dir, "persona.txt");
  const scope = req.scope ?? boardScope(req.boardId);
  // A persona é a do propósito, com a régua de política que o registro anexa (a central de comando, no chat do board).
  // A CLÁUSULA DE MODO do board (tier.ts `tierPersonaClause`: «Autônomo decide e publica sozinho», os playbooks do
  // tique) NÃO entra mais aqui: ela é a régua dos agentes AUTÔNOMOS; nesta conversa o dono está presente e a régua é
  // a de confirmação (decisão do dono, fase 6).
  await fs.writeFile(personaPath, resolveHitlPrompt(purpose), "utf8");
  // Duas portas DISTINTAS, e é bom que sejam: o TOKEN decide quais tools MCP existem naquele run (filtro server-side,
  // mcp/register.ts levelAllows), e `tools`/`deniedTools` decidem quais tools NATIVAS o CLI monta. O propósito manda
  // quando opina (o Jido do board declara `full`; as conversas de tela, `ro`); sem opinião, o modo do board decide.
  // o modo só é lido quando decide algo (um propósito sem opinião); fail-open a `chat` ⇒ o recorte conservador
  const tier = purpose.mcpLevel === undefined ? copilotTier((await readBoardConfig(req.boardId).catch(() => null))?.orchestrator ?? null) : "chat";
  // A TRAVA DURA do host é a contenção dos poderes amplos (chat-powers.ts): ela é conferida nos settings que ESTA sessão
  // carrega (o cwd é a raiz do alvo). Sem ela, a conversa roda só leitura e o turno diz o porquê.
  const hardDeny = hardDenyHookInstalled(cwd);
  const { mcpLevel, tools, deniedTools, guardMissing } = chatSpawnPlan(purpose, tier, { hardDeny });
  // Fail-CLOSED no nível read-only: sem o token `ro` provisionado, degradar para o full reabriria em silêncio
  // exatamente o que este bloco fecha. Melhor rodar SEM MCP (o operador vê o aviso `mcp-unavailable`) do que
  // rodar com mais poder do que o estado/propósito promete. "Sem MCP" é ZERO MCP: a argv leva
  // `--strict-mcp-config` sempre (protocol.ts buildCopilotTurnArgs) — nunca os conectores do operador.
  const token = (mcpLevel === "ro" ? process.env.AGILEHARNESS_MCP_TOKEN_RO : process.env.AGILEHARNESS_MCP_TOKEN)?.trim();
  let mcpConfigPath: string | undefined;
  if (token) {
    mcpConfigPath = path.join(dir, "mcp.json");
    // a conversa do board se nomeia (mcp/caller.ts): o que ela fizer não é confundido com uma sessão da frota. A
    // conversa da PÁGINA de um documento leva a página no rótulo: é ela, e só ela, que `write_doc` aceita no PRD
    // (o dono está olhando aquela página) — um run ou a conversa de outra tela propõem.
    const docView = purposeId === "doc-editor" && scope.startsWith(`view:${req.boardId}:`) ? scope.slice(`view:${req.boardId}:`.length) : null;
    const caller = docView ? docChatCaller(req.boardId, docView) : ({ kind: "copilot-chat", id: req.boardId } as const);
    await fs.writeFile(mcpConfigPath, buildOrchestratorMcpConfig(token, port, caller), "utf8");
  } else {
    // quick-fix chat-mcp: sem token, a persona diz que a conexão com o board não está configurada (e proíbe
    // mandar "autorizar o conector do claude.ai"). Só acrescenta — não mexe na persona montada acima.
    await fs.appendFile(personaPath, `\n\n${BOARD_UNCONFIGURED_CLAUSE}`, "utf8");
  }

  const cleanupFiles = () => {
    void fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const initialSessionId = req.sessionId?.trim() || randomUUID();

  const done = new Promise<void>((resolve) => {
    // Uma tentativa de spawn. Resolve com {missing, sawFinal} p/ o orquestrador do fallback decidir.
    const attempt = (sessionId: string, resume: boolean): Promise<{ missing: boolean; sawFinal: boolean }> =>
      new Promise((resolveAttempt) => {
        const args = buildCopilotTurnArgs({ model, effort, sessionId, resume, mcpConfigPath, systemPromptPath: personaPath, deniedTools, tools });
        let child: ChildProcess;
        try {
          // story-#30 / WS-3: `detached` no POSIX faz o `claude` + os netos de tool que ele forka um PROCESS
          // GROUP (líder = pid do child), p/ killTree sinalizar o pid negativo e derrubar um neto pendurado
          // junto em vez de orfaná-lo. NÃO no Windows (taskkill /T já mata a árvore; detached lá abre console).
          child = spawn(bin, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env, detached: process.platform !== "win32" });
        } catch (err) {
          onEvent({ kind: "error", message: `Não consegui iniciar o Jido (${bin}): ${err instanceof Error ? err.message : String(err)}` });
          resolveAttempt({ missing: false, sawFinal: false });
          return;
        }

        const key = liveKey(scope, sessionId);
        // `settle` é reatribuído p/ o `finish` real logo abaixo (mesmo tick síncrono — nenhum caller externo
        // interleava antes disso); o default seguro só limpa o LIVE caso algo o dispare cedo demais.
        const liveEntry: LiveTurn = { boardId: req.boardId, scope, sessionId, child, startedAt: Date.now(), settle: () => LIVE.delete(key) };
        LIVE.set(key, liveEntry);
        SESSION_SCOPE.set(sessionId, scope);

        const reg = getHelperRegistry();
        // O rótulo vem do PROPÓSITO: em /processes o operador precisa distinguir o Jido do board de uma
        // exploração de Ideia — dois processos `claude` com o mesmo nome seriam indistinguíveis na hora de
        // decidir qual matar.
        const helperId = reg.start({ label: `${purpose.label} · ${req.boardId}`, view: "copilot", board: req.boardId });
        if (child.pid) reg.setPid(helperId, child.pid);

        if (!mcpConfigPath) {
          onEvent({ kind: "frame", level: "system", code: "mcp-unavailable", text: mcpUnavailableText(mcpLevel) });
        }
        if (guardMissing) {
          onEvent({
            kind: "frame",
            level: "system",
            code: "guard-missing",
            text: "⚠ A trava dura do host não está instalada — esta conversa roda só leitura (sem shell, sem editar). Veja o item no Inbox.",
          });
        }

        let stderr = "";
        let sawFinal = false;
        let settled = false;
        let emittedTerminal = false; // já mandamos final/error ao cliente? (evita "interrompido" duplicado no close)
        // Um interpretador POR SPAWN — o estado de streaming (índices de bloco, tool ids) vive só neste turno.
        const interp = createCopilotInterpreter();
        // O REGISTRO das tools nativas que agem (shell, escrita de arquivo): a guarda do MCP nunca as vê — só este stream.
        const nativeLog = createChatNativeRecorder(req.boardId);
        // MEDIDOR da sessão — o tamanho do contexto é o da ÚLTIMA chamada de modelo do turno, NÃO o agregado do
        // evento `result` (que soma o cache_read de cada iteração de tool e explodia p/ "1635k" num chat novo).
        let ctxTokens: number | null = null;
        const parser = createNdjsonParser((obj) => {
          const ctx = assistantContextTokens(obj);
          if (ctx !== null) ctxTokens = ctx;
          // a trilha lê o stream CRU: o pedido grava na hora (antes de rodar) e a chamada de um subagente entra igual
          nativeLog.feed(obj);
          for (const ev of interp.feed(obj)) {
            // QUAL Opus? O apelido pedido (`opus`) é uma promessa — "o mais recente da família"; o id de
            // fato só existe aqui, no init que o CLI anuncia. Anotamos o par para a tela poder mostrar a
            // VERSÃO em vez de um apelido mudo. Best-effort e mudo: rótulo não vale um turno quebrado.
            if (ev.kind === "init" && ev.model) void rememberModelResolution(model, ev.model).catch(() => {});
            if (ev.kind === "final") {
              sawFinal = true;
              // O CLI já reportava usage/custo por turno e nós jogávamos fora. Guardar aqui é o que deixa a UI
              // dizer "45k de contexto, 12 turnos, $1.20" — e o operador decidir entre seguir, /compact ou
              // limpar. Best-effort (nunca quebra o turno).
              // Medidor da conversa — gravado na RAIA dela: cada conversa tem o seu roster, o seu histórico e
              // o seu medidor. (Antes isto era gated ao board porque o roster era por board; agora não é.)
              if (ctxTokens !== null || ev.usage) {
                void recordCopilotTurnUsage(scope, sessionId, {
                  contextTokens: ctxTokens,
                  costUSD: ev.usage?.costUSD ?? null,
                }).catch(() => {});
              }
            }
            if (ev.kind === "final" || ev.kind === "error") emittedTerminal = true;
            onEvent(ev);
          }
        });

        const timer = setTimeout(() => {
          emittedTerminal = true;
          onEvent({ kind: "error", message: `Copiloto não respondeu em ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s — encerrado.` });
          // 3.1a — mata o GRUPO (SIGTERM→SIGKILL, alcança um neto de tool pendurado) e ENTÃO settla, mesmo que
          // o `close` nunca venha (processo zumbi): finish é idempotente, o exit/close do kill o re-dispara sem
          // efeito. Sem isto o registro de turno-vivo (o 409) sobrevivia até o restart do serviço.
          void killTree(child).finally(() => finish({ missing: false, sawFinal }));
        }, DEFAULT_TIMEOUT_MS);
        (timer as unknown as { unref?: () => void }).unref?.(); // nunca segurar o event loop só pelo watchdog

        // Libera o REGISTRO (LIVE = o 409, e o helper) assim que o processo MORRE, sem esperar o stdio fechar — um
        // neto de tool pendurado pode herdar o pipe de stdout e segurar o `close` muito depois do `claude` já ter
        // morrido. Idempotente (roda no `exit` e, de novo, dentro do `finish`).
        let registryReleased = false;
        const releaseRegistry = () => {
          if (registryReleased) return;
          registryReleased = true;
          reg.end(helperId);
          LIVE.delete(key);
        };

        const finish = (result: { missing: boolean; sawFinal: boolean }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          releaseRegistry();
          resolveAttempt(result);
        };
        // 3.1b — o cancel (killCopilotTurn) e o watchdog settlam o turno por AQUI, sem depender do `close`.
        liveEntry.settle = () => finish({ missing: false, sawFinal });

        child.stdout?.on("data", (d) => parser.feed(d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        child.on("error", (e) => {
          emittedTerminal = true;
          onEvent({ kind: "error", message: `Falha ao executar o Jido (${bin}): ${e.message}` });
          finish({ missing: false, sawFinal });
        });
        // 3.1 — a MORTE do processo (`exit`) libera o LIVE (o 409) na hora, sem depender do `close`, que um neto
        // de tool pendurado (membro do grupo detached) pode segurar aberto muito depois do `claude` morrer.
        child.on("exit", () => releaseRegistry());
        // O `close` (stdio drenado) é onde a DECISÃO acontece: o stderr já está completo p/ a detecção de
        // sessão-sumida (resume→fresh) e o stdout p/ o `sawFinal` — mover a decisão p/ o `exit` leria ambos cedo
        // demais (bolha "interrompido" espúria no caminho feliz + quebra do fallback resume→fresh). finish é idempotente.
        child.on("close", () => {
          parser.flush();
          const missing = !sawFinal && RESUME_SESSION_MISSING_RE.test(stderr);
          // Fechou sem terminal e NÃO é o caso de sessão-sumida (que re-spawna fresh) → o processo foi
          // interrompido (crash/kill/OOM) com o serviço vivo. Emite um erro CLARO (nunca um turno mudo).
          // No restart do serviço o cliente nem recebe isto (conexão cai) — ele recupera pelo próprio catch.
          if (!missing && !emittedTerminal) {
            emittedTerminal = true;
            onEvent({ kind: "error", message: "O turno foi interrompido antes de concluir (o processo encerrou sem resposta). Tente de novo." });
          }
          finish({ missing, sawFinal });
        });

        // Alimenta o prompt e fecha o stdin → o CLI começa a responder.
        child.stdin?.write(req.prompt);
        child.stdin?.end();
      });

    void (async () => {
      try {
        // Cliente aprende o session id ASAP (antes do init do CLI, ~1s) — persiste + habilita cancel imediato.
        onEvent({ kind: "init", sessionId: initialSessionId });
        // Ponteiro durável raia→sessionId (persistência cross-dispositivo do histórico) — best-effort.
        // Escrito na RAIA: ele elege a conversa ABERTA daquela raia. Foi o que impediu, desde o começo, que
        // uma conversa de outra tela sequestrasse o chat do board (o tick resume pelo ponteiro do board).
        void writeCopilotSessionPointer(scope, initialSessionId);
        const first = await attempt(initialSessionId, Boolean(req.sessionId));
        if (Boolean(req.sessionId) && first.missing && !first.sawFinal) {
          // Sessão sumiu do disco (restart, GC) → re-spawn FRESH uma vez com id novo; cliente troca via init.fresh.
          const freshId = randomUUID();
          onEvent({ kind: "init", sessionId: freshId, fresh: true });
          void writeCopilotSessionPointer(scope, freshId); // o ponteiro segue a sessão NOVA
          await attempt(freshId, false);
        }
      } finally {
        cleanupFiles();
        resolve();
      }
    })();
  });

  return { sessionId: initialSessionId, done };
}
