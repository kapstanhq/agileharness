// O REGISTRO DO CHAT — toda ação da conversa do Jido entra na trilha de auditoria (`agent-actions.jsonl`), em nome dela.
//
// POR QUE EXISTE (AGENTS-ARCH §2 item 2): a conversa do board monta o token `full` do operador, e a guarda por chamada
// (mcp/guard.ts) devolvia `null` para esse token ANTES de qualquer registro — em 3.304 linhas da trilha, 0 eram do
// chat. O chat ao lado do dono tinha MAIS poder e MENOS registro que qualquer agente autônomo. A decisão do dono (fase 6)
// manteve os poderes amplos e exigiu o registro: o chat «passa pela guarda e deixa registro».
//
// O QUE ISTO NÃO FAZ: governar o chat pela matriz de risco do board. A matriz é a régua dos agentes AUTÔNOMOS (ninguém
// presente); aplicada ao chat ela recusaria `claude_kill` (`destructive: never`) que o dono pede na conversa, ou abriria
// no Inbox uma aprovação para algo que ele acabou de confirmar na tela. O chat é contido pela trava dura do host, pela
// régua de confirmação da persona e por ESTE registro — que é o que deixa um incidente reconstruível.
//
// Duas fontes, as duas aqui:
//   - as tools do MCP: a guarda chama `recordChatMcpCall` no ramo do token `full` (só quando quem chama se declarou
//     uma conversa do Jido — atribuição; o operador com o próprio conector não é o chat);
//   - as tools NATIVAS que mudam algo (shell e arquivos): o turno (agent-session.ts) as vê passar no stream e as
//     registra pelo `createChatNativeRecorder` — a guarda do MCP nunca as enxerga.

//
// O QUE A LINHA GUARDA (fase 6, achado de segurança): o bastante para RECONSTRUIR o que rodou. A chamada do MCP leva os
// argumentos (o comando de `term_new`, o texto de `claude_send`, o prompt de `run_task`); o shell nativo leva o comando
// inteiro; um texto longo guarda o COMEÇO e o FIM (um enchimento na frente não esconde o efeito no fim) e o hash do todo.
// A linha nativa nasce no PEDIDO (`requested`), não no desfecho — um turno cancelado, morto pelo relógio ou com um job em
// segundo plano não some da trilha —, e a chamada feita por um SUBAGENTE entra igual (o stream as marca com
// `parent_tool_use_id`; o gravador lê o stream cru, não os eventos de tela do interpretador).

import { createHash } from "node:crypto";
import type { RiskClass } from "@/lib/storymap/types";
import type { McpActor } from "@/lib/storymap/mcp/actor";
import type { McpCaller } from "@/lib/storymap/mcp/caller";
import { appendAgentAction, type AppendAgentActionInput } from "@/lib/storymap/runner/agent-actions";

/** O board de uma conversa do Jido (o chat do board ou a conversa de uma página de documento), ou null. PURA. */
export function chatBoardOf(caller: McpCaller | null | undefined): string | null {
  if (!caller) return null;
  if (caller.kind === "copilot-chat") return caller.id;
  if (caller.kind === "doc-chat") {
    const dot = caller.id.lastIndexOf(".");
    return dot > 0 ? caller.id.slice(0, dot) : caller.id;
  }
  return null;
}

/** A atribuição do chat na trilha — `chat:<board>`, distinta do tique (`copilot:<board>`) e dos condutores. PURA. */
export function chatAttribution(board: string): string {
  return `chat:${board}`;
}

const NOTE_MCP = "chat do dono (token do operador): registrado, sem a matriz de risco — a confirmação é na conversa";

function cardIdOf(args: unknown): string | undefined {
  const c = (args as Record<string, unknown> | null | undefined)?.cardId;
  return typeof c === "string" && c.trim() ? c.trim() : undefined;
}

/** Quanto do começo e do fim de um argumento longo a linha guarda. */
export const AUDIT_ARGS_EDGE = 4_000;

/**
 * Os argumentos como a trilha os guarda: o texto inteiro até 2 × {@link AUDIT_ARGS_EDGE}; acima disso o COMEÇO e o FIM
 * (o enchimento de um lado não esconde o outro) — e sempre o sha256 do texto inteiro, que identifica o que rodou. PURA.
 */
export function auditArgs(value: unknown): { args: string; argsSha256: string } {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  } catch {
    text = String(value);
  }
  const argsSha256 = createHash("sha256").update(text).digest("hex");
  if (text.length <= AUDIT_ARGS_EDGE * 2) return { args: text, argsSha256 };
  return { args: `${text.slice(0, AUDIT_ARGS_EDGE)}…[${text.length - AUDIT_ARGS_EDGE * 2} caracteres omitidos]…${text.slice(-AUDIT_ARGS_EDGE)}`, argsSha256 };
}

/**
 * A linha da trilha para uma tool do MCP chamada pela conversa, ou null quando não há o que registrar: quem chamou não
 * se declarou uma conversa do Jido, ou a tool é de LEITURA (ler não é agir — a trilha é das ações). PURA.
 */
export function chatMcpActionEntry(actor: McpActor | undefined, name: string, cls: RiskClass, args: unknown): AppendAgentActionInput | null {
  const board = chatBoardOf(actor?.caller);
  if (!actor || !board || cls === "read") return null;
  const argBoard = (args as Record<string, unknown> | null | undefined)?.board;
  return {
    actor: actor.tokenEnv,
    caller: chatAttribution(board),
    role: "chat",
    board: typeof argBoard === "string" && argBoard.trim() ? argBoard.trim() : board,
    cardId: cardIdOf(args),
    tool: name,
    cls,
    disposition: "auto",
    outcome: "executed",
    note: NOTE_MCP,
    // o QUE rodou (o comando de um terminal, o texto digitado, o prompt de uma tarefa) — começo, fim e hash
    ...auditArgs(args),
  };
}

/** Registra a chamada (fire-and-forget; a trilha nunca quebra a tool). Devolve se registrou. */
export function recordChatMcpCall(
  actor: McpActor | undefined,
  name: string,
  cls: RiskClass,
  args: unknown,
  append: (e: AppendAgentActionInput) => Promise<void> | void = appendAgentAction,
): boolean {
  const entry = chatMcpActionEntry(actor, name, cls, args);
  if (!entry) return false;
  void Promise.resolve(append(entry)).catch(() => {});
  return true;
}

/**
 * As tools NATIVAS que AGEM (shell e escrita de arquivo). Classe `run-free`: é o que está fora de toda matriz — o shell
 * só responde à trava dura do host. Leitura (Read/Grep/Glob/Web*) não entra: a trilha é das ações.
 */
export const CHAT_NATIVE_ACTING_TOOLS: ReadonlySet<string> = new Set(["Bash", "Edit", "Write"]);

const MAX_SUMMARY = 160;

/** O que a linha diz da chamada nativa: o comando (ou a descrição dele) do shell, o arquivo de uma edição. PURA. */
export function nativeCallSummary(tool: string, rawInput: string | undefined): string {
  let input: Record<string, unknown> = {};
  try {
    const parsed = rawInput ? JSON.parse(rawInput) : {};
    if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
  } catch {
    input = {};
  }
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
  const text = tool === "Bash" ? pick("command") || pick("description") : pick("file_path");
  const flat = text.replace(/\s+/g, " ");
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat;
}

/** A linha da trilha para uma tool nativa que terminou, ou null quando ela não age. PURA. */
export function chatNativeActionEntry(board: string, tool: string, rawInput: string | undefined, ok: boolean): AppendAgentActionInput | null {
  if (!CHAT_NATIVE_ACTING_TOOLS.has(tool)) return null;
  const what = nativeCallSummary(tool, rawInput);
  return {
    caller: chatAttribution(board),
    role: "chat",
    board,
    tool: `native:${tool}`,
    cls: "run-free",
    disposition: "auto",
    // um erro pode ser falha do comando OU recusa da trava dura do host — o stream não distingue; a nota diz isso
    outcome: ok ? "executed" : "refused",
    note: `${ok ? "chat do dono" : "chat do dono — voltou com erro (falha ou recusa da trava dura)"}${what ? ` · ${what}` : ""}`,
  };
}

/**
 * O que a linha do PEDIDO guarda de uma chamada nativa: o comando INTEIRO do shell (começo, fim e hash); de uma edição, o
 * arquivo e o hash do conteúdo — nunca o conteúdo (um arquivo escrito pode carregar o que não cabe numa trilha). PURA.
 */
export function nativeCallArgs(tool: string, input: unknown): { args: string; argsSha256: string } {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (tool === "Bash") return auditArgs(typeof o.command === "string" ? o.command : "");
  const { argsSha256 } = auditArgs(input);
  const file = typeof o.file_path === "string" ? o.file_path : typeof o.notebook_path === "string" ? o.notebook_path : "";
  return { args: JSON.stringify({ file_path: file }), argsSha256 };
}

/** A linha do PEDIDO de uma chamada nativa que age (nasce antes de ela rodar), ou null. PURA. */
export function chatNativeRequestEntry(board: string, tool: string, input: unknown, toolUseId: string, parentToolUseId?: string | null): AppendAgentActionInput | null {
  if (!CHAT_NATIVE_ACTING_TOOLS.has(tool)) return null;
  let raw: string | undefined;
  try {
    raw = JSON.stringify(input ?? {});
  } catch {
    raw = undefined;
  }
  const what = nativeCallSummary(tool, raw);
  return {
    caller: chatAttribution(board),
    role: "chat",
    board,
    tool: `native:${tool}`,
    cls: "run-free",
    disposition: "auto",
    outcome: "requested",
    note: `chat do dono — pedido${parentToolUseId ? " (por um subagente)" : ""}${what ? ` · ${what}` : ""}`,
    ...nativeCallArgs(tool, input),
    toolUseId,
    ...(parentToolUseId ? { parentToolUseId } : {}),
  };
}

/**
 * O gravador das tools nativas de UM turno: lê o stream-json CRU do CLI (o mesmo objeto que alimenta o interpretador).
 * O PEDIDO grava na hora em que o modelo o emite (o `tool_use` do evento `assistant`, inclusive o de um subagente — o
 * evento traz `parent_tool_use_id`); o DESFECHO grava quando o `tool_result` chega, com o mesmo `toolUseId`. Um turno que
 * morre no meio deixa o pedido na trilha. Nunca lança.
 */
export function createChatNativeRecorder(
  board: string,
  append: (e: AppendAgentActionInput) => Promise<void> | void = appendAgentAction,
): { feed: (obj: unknown) => void } {
  const calls = new Map<string, { name: string; input?: string; parent?: string }>();
  const write = (e: AppendAgentActionInput | null) => {
    if (e) void Promise.resolve(append(e)).catch(() => {});
  };
  return {
    feed(obj) {
      try {
        if (!obj || typeof obj !== "object") return;
        const e = obj as { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } };
        const parent = typeof e.parent_tool_use_id === "string" && e.parent_tool_use_id ? e.parent_tool_use_id : undefined;
        if (!Array.isArray(e.message?.content)) return;
        if (e.type === "assistant") {
          for (const b of e.message.content as Array<Record<string, unknown>>) {
            if (b?.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string") continue;
            if (calls.has(b.id) || !CHAT_NATIVE_ACTING_TOOLS.has(b.name)) continue;
            let input: string | undefined;
            try {
              input = JSON.stringify(b.input ?? {});
            } catch {
              input = undefined;
            }
            calls.set(b.id, { name: b.name, input, ...(parent ? { parent } : {}) });
            write(chatNativeRequestEntry(board, b.name, b.input, b.id, parent));
          }
        } else if (e.type === "user") {
          for (const b of e.message.content as Array<Record<string, unknown>>) {
            if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
            const c = calls.get(b.tool_use_id);
            if (!c) continue;
            calls.delete(b.tool_use_id);
            const entry = chatNativeActionEntry(board, c.name, c.input, b.is_error !== true);
            write(entry ? { ...entry, toolUseId: b.tool_use_id, ...(c.parent ? { parentToolUseId: c.parent } : {}) } : null);
          }
        }
      } catch {
        /* a trilha nunca quebra o turno */
      }
    },
  };
}
