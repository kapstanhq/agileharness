// claude-transcript — how full is a Claude session's context, read from the CLI's own transcript (JSONL).
//
// Extracted from mcp/dev-tools.ts (WS-6.4): the fleet view + the /processes page need the SAME answer the MCP
// tools give, and reaching into the MCP tool module for it would drag the MCP SDK into the page's graph (and,
// once fleet-deps existed, make a cycle: dev-tools → session-spawn → deps → dev-tools). Nothing here is
// MCP-specific — it is a file format and a threshold. `dev-tools.ts` re-exports these names, so its own tests
// (which pin this exact behaviour) keep importing them from there.
//
// SERVER-ONLY (node:fs).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Context limit (input-token budget) used to turn a session's last API input size into a percentage. 200k
 * matches the Sonnet/Opus context window the autorun spawns.
 */
const DEFAULT_CONTEXT_LIMIT = 200_000;

/** At/above this %, a session is flagged for proactive recycling (before it overflows, not after). */
export const RECYCLE_THRESHOLD = 50;

export function suggestRecycle(contextPct: number | null): boolean {
  return contextPct !== null && contextPct >= RECYCLE_THRESHOLD;
}

interface TokenUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Estimate context usage (0–100) from a Claude Code transcript (JSONL). The LAST assistant API call already
 * carries the entire prior history as its input, so its input-token count (prompt + both cache tiers) is the
 * truest snapshot of the live context size. Parses defensively per line — a malformed/!usage line is skipped,
 * not fatal. Returns `null` when no usage is found (degrade gracefully rather than report a fake 0%).
 */
export function contextPctFromTranscript(content: string, limit = DEFAULT_CONTEXT_LIMIT): number | null {
  let lastInputTokens = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as { usage?: TokenUsage; message?: { usage?: TokenUsage } };
      const usage = msg.usage ?? msg.message?.usage;
      if (usage && typeof usage.input_tokens === "number") {
        lastInputTokens =
          usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      }
    } catch {
      /* skip malformed line */
    }
  }
  if (lastInputTokens <= 0 || limit <= 0) return null;
  return Math.min(100, Math.round((lastInputTokens / limit) * 100));
}

export async function computeContextPct(filePath: string, limit = DEFAULT_CONTEXT_LIMIT): Promise<number | null> {
  try {
    return contextPctFromTranscript(await fs.readFile(filePath, "utf8"), limit);
  } catch {
    return null;
  }
}

// ── ler a CONVERSA, não a tela (M3/M6) ───────────────────────────────────────────────────────────────────

/** Um turno de conversa — o que o operador/agente chamaria de "o que ele disse". */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  at?: string;
  /** Só os NOMES das tools chamadas neste turno. O CORPO é o que estoura o orçamento de token. */
  tools?: string[];
}

export interface TranscriptRead {
  /** Total de linhas do transcript AGORA — o CURSOR para a próxima leitura incremental. */
  cursor: number;
  turns: TranscriptTurn[];
  /** Linhas puladas por já terem sido lidas numa chamada anterior (`sinceLine`). */
  skipped: number;
  /** Turnos descartados por caberem fora de `maxTurns` (o retrato é o FIM da conversa). */
  dropped: number;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Blocos `text` de um conteúdo de mensagem (string crua ou array de blocos). `thinking` fica FORA. */
function textOf(content: unknown): { text: string; tools: string[] } {
  if (typeof content === "string") return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: "", tools: [] };
  const parts: string[] = [];
  const tools: string[] = [];
  for (const raw of content) {
    const b = raw as { type?: string; text?: string; name?: string };
    // `thinking` é raciocínio privado do modelo e costuma ser o maior bloco do turno — quem pergunta
    // "o que ele respondeu?" não está pedindo isso, e incluí-lo desfaria a economia inteira.
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "tool_use" && typeof b.name === "string") tools.push(b.name);
  }
  return { text: parts.join("\n").trim(), tools };
}

/**
 * A CONVERSA de um transcript do Claude Code (JSONL), em turnos — a alternativa barata a raspar a tela.
 *
 * O PROBLEMA que ela resolve: acompanhar uma sessão custava `claude_capture`, que devolve até 40k chars
 * de terminal cru (~10k tokens) por olhada, num laço de send → esperar → capturar. E a tela é o meio
 * ERRADO: ela tem wrap, scrollback, spinner e caixa de status, então a mesma resposta lida duas vezes
 * não é o mesmo texto. O transcript é a fonte que o próprio CLI grava, e já estava no disco — o
 * `transcriptFile` da frota só era usado para calcular % de contexto.
 *
 * Linhas consecutivas do MESMO papel viram UM turno (o CLI quebra um turno em text/thinking/tool_use).
 * `tool_result` do usuário não é turno de conversa: é a máquina respondendo à máquina.
 *
 * PURA e defensiva por linha (uma linha corrompida é pulada, nunca fatal).
 */
export function parseTranscriptTurns(
  content: string,
  opts?: { maxTurns?: number; sinceLine?: number; maxChars?: number },
): TranscriptRead {
  const maxTurns = Math.max(1, opts?.maxTurns ?? 3);
  const maxChars = Math.max(200, opts?.maxChars ?? 4000);
  const sinceLine = Math.max(0, opts?.sinceLine ?? 0);
  const lines = content.split("\n");
  // O cursor conta as linhas NÃO-VAZIAS do arquivo inteiro, então ele é estável entre chamadas mesmo
  // que a última linha esteja sendo escrita neste instante.
  let cursor = 0;
  const turns: TranscriptTurn[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const index = cursor;
    cursor += 1;
    if (index < sinceLine) continue;
    let msg: TranscriptLine;
    try {
      msg = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (msg.type !== "assistant" && msg.type !== "user") continue;
    const role = msg.type === "assistant" ? "assistant" : "user";
    const { text, tools } = textOf(msg.message?.content);
    if (!text && !tools.length) continue; // tool_result puro: máquina falando com máquina

    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      if (text) last.text = last.text ? `${last.text}\n${text}` : text;
      if (tools.length) last.tools = [...(last.tools ?? []), ...tools];
      if (msg.timestamp) last.at = msg.timestamp;
      continue;
    }
    turns.push({
      role,
      text,
      ...(msg.timestamp ? { at: msg.timestamp } : {}),
      ...(tools.length ? { tools } : {}),
    });
  }

  const dropped = Math.max(0, turns.length - maxTurns);
  const tail = turns.slice(-maxTurns).map((t) => ({
    ...t,
    text: t.text.length > maxChars ? `${t.text.slice(0, maxChars)}\n…[truncado: ${t.text.length} chars]` : t.text,
  }));
  return { cursor, turns: tail, skipped: sinceLine, dropped };
}

/** {@link parseTranscriptTurns} sobre um arquivo. `null` quando ele não dá para ler. */
export async function readTranscriptTurns(
  filePath: string,
  opts?: { maxTurns?: number; sinceLine?: number; maxChars?: number },
): Promise<TranscriptRead | null> {
  try {
    return parseTranscriptTurns(await fs.readFile(filePath, "utf8"), opts);
  } catch {
    return null;
  }
}

/**
 * Find the Claude Code transcript (`.jsonl`) most likely created by a session spawned at `since`: the newest
 * `.jsonl` under `~/.claude/projects/<encoded-cwd>/` with mtime > since. Best-effort — any fs hiccup degrades
 * to `null` (contextPct just stays null downstream). `projectsDir` is injectable for tests.
 */
export async function findNewTranscript(
  since: number,
  projectsDir = path.join(os.homedir(), ".claude", "projects"),
): Promise<string | null> {
  try {
    const subs = await fs.readdir(projectsDir, { withFileTypes: true });
    let best: { file: string; mtime: number } | null = null;
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const subPath = path.join(projectsDir, sub.name);
      let files: string[];
      try {
        files = await fs.readdir(subPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(subPath, f);
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs > since && (!best || st.mtimeMs > best.mtime)) best = { file: full, mtime: st.mtimeMs };
        } catch {
          /* skip unreadable file */
        }
      }
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}
