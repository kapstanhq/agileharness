// Hidratação do histórico do chat do Jido a partir do transcript DURÁVEL do CLI (a fonte única — não
// duplicamos o thread). O CLI grava cada sessão em ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl; aqui
// localizamos esse arquivo, lemos (com teto de bytes — tail para sessões longas), e o PARSEAMOS em HitlTurn[]
// no MESMO shape de segmentos que o streaming ao vivo produz, para o chat reabrir idêntico em qualquer
// dispositivo. A parte PURA (parseTranscriptTurns) é exportada para teste; a IO só localiza + lê + pagina.
//
// Formato de uma linha do transcript (verificado): objetos JSON por linha; interessam `type:"user"` e
// `type:"assistant"` (com `message.content`), pulando meta (queue-operation/attachment/ai-title/last-prompt,
// e qualquer isMeta/isSidechain). O `user` traz OU o prompt do humano (content string) OU tool_results
// (content array com blocos tool_result — NÃO é turno do humano, é a saída das tools do agente).

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";
import type { HitlSegment, HitlTurn } from "@/lib/storymap/hitl/types";
import { flattenToolResult, safeStringify, terminalChipFor, toolCallSummary } from "./protocol";
import { commandNoticeText } from "./tick-turn";

const MAX_READ_BYTES = 12 * 1024 * 1024; // teto de leitura — chats do Jido são modestos; tail para o patológico
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/; // uuid-ish; barra path traversal no nome do arquivo

// ── Localização do transcript ────────────────────────────────────────────────────────────────────────

/** Slug do dir de projeto do CLI a partir do cwd (o CLI troca `/` e `.` por `-`). */
function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Acha o transcript de uma sessão. Tenta o caminho canônico (slug do repo-root, o cwd do Jido); se não
 * existir (algoritmo de slug divergiu, ou cwd diferente), varre os dirs de projeto atrás de `<sessionId>.jsonl`.
 * Retorna o path ou null. `sessionId` é validado (uuid-ish) — nunca escapa do dir.
 */
export async function locateTranscript(sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const base = path.join(homedir(), ".claude", "projects");
  const primary = path.join(base, projectSlug(findRepoRoot()), `${sessionId}.jsonl`);
  try {
    await fs.access(primary);
    return primary;
  } catch {
    /* cai no scan */
  }
  try {
    const dirs = await fs.readdir(base, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const cand = path.join(base, d.name, `${sessionId}.jsonl`);
      try {
        await fs.access(cand);
        return cand;
      } catch {
        /* próximo */
      }
    }
  } catch {
    /* sem dir de projetos */
  }
  return null;
}

/** Teto de leitura do CABEÇALHO (o rótulo da conversa sai da PRIMEIRA fala do operador, que vem no começo do
 *  arquivo). Generoso porque o 1º prompt carrega o bloco `<contexto>` do board inteiro — mas ainda ~40x menor
 *  que ler o transcript todo só para pegar uma linha. */
const MAX_HEAD_BYTES = 512 * 1024;

/** Lê o arquivo com teto: se > MAX_READ_BYTES, lê só os últimos MAX_READ_BYTES e descarta a 1ª linha parcial. */
async function readBounded(file: string): Promise<string> {
  const st = await fs.stat(file);
  if (st.size <= MAX_READ_BYTES) return fs.readFile(file, "utf8");
  const fh = await fs.open(file, "r");
  try {
    const start = st.size - MAX_READ_BYTES;
    const buf = Buffer.alloc(MAX_READ_BYTES);
    await fh.read(buf, 0, MAX_READ_BYTES, start);
    const text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : text; // descarta a linha parcial do topo
  } finally {
    await fh.close();
  }
}

// ── Parse PURO ───────────────────────────────────────────────────────────────────────────────────────

/** Remove o wrapper de contexto + linha de modo + tails de imagem de um prompt composto → texto do humano + nº de imagens. */
export function stripComposedPrompt(raw: string): { text: string; imageCount: number } {
  let s = typeof raw === "string" ? raw : "";
  // tails de imagem: "[Imagem anexada pelo operador — abra com a tool Read: <path>]"
  const imageCount = (s.match(/\[Imagem anexada pelo operador/g) ?? []).length;
  s = s.replace(/\n*\[Imagem anexada pelo operador[^\]]*\]/g, "");
  // bloco de contexto: tudo até (e incluindo) o primeiro "</contexto>\n\n"
  const close = s.indexOf("</contexto>");
  if (close >= 0) {
    let after = s.slice(close + "</contexto>".length);
    after = after.replace(/^\s+/, ""); // consome o "\n\n" que segue o fecho
    s = after;
  }
  // linha de modo terse (composeCopilotPrompt a prepende antes do texto)
  s = s.replace(/^Responda CURTO e direto \(estilo terminal\), sem preâmbulo\.\s*/, "");
  return { text: s.trim(), imageCount };
}

/** É uma linha de transcript que devemos ignorar (meta / sidechain)? */
function isSkippable(o: Record<string, any>): boolean {
  return o.isMeta === true || o.isSidechain === true;
}

/** Um turno de agente em construção — segmentos + índice tool_use_id→posição, para casar os tool_results. */
interface AgentBuild {
  segments: HitlSegment[];
  toolIndex: Map<string, number>;
}

/**
 * Parseia as linhas de um transcript em HitlTurn[] ordenados (humano / agente-com-segmentos), agrupando toda a
 * atividade do agente (assistant + tool_results) ENTRE dois turnos do humano num único turno de agente — a mesma
 * granularidade do streaming ao vivo. Puro/determinístico. Linhas inválidas/meta são puladas.
 */
export function parseTranscriptTurns(lines: string[]): HitlTurn[] {
  const turns: HitlTurn[] = [];
  let seq = 0;
  const nextSeg = () => `h${seq++}`; // "h" de history — não colide com os "s" do streaming ao vivo
  let agent: AgentBuild | null = null;

  const flushAgent = () => {
    if (agent && agent.segments.length) turns.push({ role: "agent", message: "", segments: agent.segments });
    agent = null;
  };

  for (const line of lines) {
    let o: Record<string, any>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object" || isSkippable(o)) continue;
    const msg = o.message;

    if (o.type === "assistant" && msg && Array.isArray(msg.content)) {
      if (!agent) agent = { segments: [], toolIndex: new Map() };
      for (const b of msg.content as any[]) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          agent.segments.push({ type: "text", segId: nextSeg(), text: b.text });
        } else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          const segId = nextSeg();
          const terminalUrl = terminalChipFor(b.name, b.input) ?? undefined;
          agent.toolIndex.set(b.id, agent.segments.length);
          agent.segments.push({
            type: "tool",
            segId,
            name: b.name,
            summary: toolCallSummary(b.input),
            // "running" até PROVA em contrário — a prova é o tool_result (que fecha em done/error, abaixo).
            // Era "done" na criação, o que só valia para um transcript MORTO: lido ao vivo (o poll near-live
            // relê o arquivo enquanto o tick trabalha), a tool em VOO aparecia com o ✓ verde de concluída.
            // Daí "nenhuma ferramenta sendo usada aparece ao vivo": ela aparecia — mentindo que já terminou.
            // Num transcript completo todo tool_use tem seu tool_result, então tudo fecha em done como antes;
            // o que sobra "running" é ou uma tool em voo AGORA, ou uma que morreu sem resultado — e as duas
            // são a verdade.
            status: "running",
            input: safeStringify(b.input),
            ...(terminalUrl ? { terminalUrl } : {}),
          });
        }
      }
      continue;
    }

    if (o.type === "user" && msg) {
      const content = msg.content;
      // (a) tool_results → casam com o turno de agente em construção (não é turno do humano).
      if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
        if (agent) {
          for (const b of content as any[]) {
            if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
            const idx = agent.toolIndex.get(b.tool_use_id);
            if (idx == null) continue;
            const seg = agent.segments[idx];
            if (seg?.type === "tool") {
              agent.segments[idx] = { ...seg, status: b.is_error === true ? "error" : "done", output: safeStringify(flattenToolResult(b.content)) };
            }
          }
        }
        continue;
      }
      // (b) prompt do humano (string, ou array de blocos de texto) → fecha o agente anterior e abre o turno humano.
      const rawText = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("") : "";
      // (b1) …a menos que aquilo não seja fala de ninguém, e sim uma INVOCAÇÃO DE COMANDO. Desde o WS2A o tick
      // acorda na MESMA sessão durável que o chat lê, e seu prompt é uma slash command que o CLI expande numa
      // casca XML; tratá-la como fala do humano imprimia essa casca crua numa bolha à direita — o operador via
      // XML que nunca digitou. Vale para QUALQUER comando (o `/compact` do painel grava a mesma casca), por isso
      // a regra é da classe inteira e não só do tick. É um EVENTO, e vai como notice.
      const noticeText = commandNoticeText(rawText);
      if (noticeText) {
        flushAgent();
        turns.push({ role: "notice", kind: "tick", text: noticeText });
        continue;
      }
      const { text, imageCount } = stripComposedPrompt(rawText);
      if (!text && !imageCount) continue; // prompt vazio (ex.: só uma diretiva de sistema) — ignora
      flushAgent();
      turns.push({ role: "human", text, ...(imageCount ? { images: Array.from({ length: imageCount }, () => "") } : {}) });
      continue;
    }
    // demais tipos (system/summary/result/queue-operation/attachment/…) — irrelevantes p/ o thread visível
  }
  flushAgent();
  return turns;
}

// ── O RÓTULO de uma conversa ─────────────────────────────────────────────────────────────────────────

/** Teto do rótulo: uma linha de menu, não um parágrafo. */
const TITLE_MAX_CHARS = 72;

/**
 * O RÓTULO de uma conversa: a PRIMEIRA fala do operador nela — a mesma régua do `--resume` do CLI, e a única
 * que o operador reconhece ("aquela em que pedi o diagnóstico do train"). Puro.
 *
 * Reusa o parser do thread (uma verdade só sobre o que é fala do humano): assim um `/compact`, o prompt do
 * tick e o wrapper `<contexto>` já chegam aqui tratados — o primeiro NÃO vira rótulo (é evento, não fala) e o
 * segundo já vem descascado. Null quando a conversa ainda não tem fala humana (recém-aberta, ou só o tick
 * escreveu): rotular isso seria inventar um nome para uma conversa que ninguém começou.
 */
export function titleFromTranscript(lines: string[]): string | null {
  for (const t of parseTranscriptTurns(lines)) {
    if (t.role !== "human") continue;
    const text = t.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : text;
  }
  return null;
}

/** Lê só o CABEÇALHO do transcript (a 1ª fala do humano mora lá) e extrai o rótulo. Null se não houver
 *  transcript, fala humana, ou a leitura falhar — o chamador cai num rótulo de reserva. Nunca lança. */
export async function readTranscriptTitle(sessionId: string): Promise<string | null> {
  try {
    const file = await locateTranscript(sessionId);
    if (!file) return null;
    const fh = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(MAX_HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_HEAD_BYTES, 0);
      const text = buf.toString("utf8", 0, bytesRead);
      // a última linha pode ter sido cortada pelo teto — descarta se o trecho não terminou em "\n".
      const lines = text.split("\n");
      if (bytesRead === MAX_HEAD_BYTES && lines.length > 1) lines.pop();
      return titleFromTranscript(lines.filter((l) => l.trim()));
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

// ── IO + paginação ─────────────────────────────────────────────────────────────────────────────────

export interface CopilotHistoryPage {
  turns: HitlTurn[];
  /** offset (string) da PRÓXIMA página mais antiga, ou null se não há mais. */
  nextCursor: string | null;
}

/** Fatia a página do FIM p/ o começo: `before` = onde a página anterior começou (ausente ⇒ do fim). Pura. */
export function sliceHistoryPage(all: HitlTurn[], limit: number, before?: number): CopilotHistoryPage {
  const n = Math.min(Math.max(limit, 1), 100);
  const end = before != null && Number.isFinite(before) ? Math.min(Math.max(before, 0), all.length) : all.length;
  const start = Math.max(0, end - n);
  return { turns: all.slice(start, end), nextCursor: start > 0 ? String(start) : null };
}

/**
 * Lê o histórico de uma sessão, paginado do FIM para o começo (o chat abre no mais recente; "carregar mais
 * antigas" volta). `before` = o offset (do começo) onde a página anterior começou; ausente ⇒ a partir do fim.
 * Nunca lança — transcript ausente/ilegível ⇒ página vazia.
 */
export async function readCopilotHistory(
  sessionId: string,
  opts?: { limit?: number; before?: number },
): Promise<CopilotHistoryPage> {
  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 100);
  try {
    const file = await locateTranscript(sessionId);
    if (!file) return { turns: [], nextCursor: null };
    const text = await readBounded(file);
    const all = parseTranscriptTurns(text.split("\n").filter((l) => l.trim()));
    return sliceHistoryPage(all, limit, opts?.before);
  } catch {
    return { turns: [], nextCursor: null };
  }
}
