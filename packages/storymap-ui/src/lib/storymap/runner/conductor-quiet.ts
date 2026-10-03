// HÁ QUANTO TEMPO um condutor está quieto no prompt — o sinal que o vigia de card parado e o passe de estacionar leem.
//
// A fonte de primeira mão é a foto do vigia de terminais (attention-watch.ts). Ela tem um limite que cegava os dois
// consumidores: depois de um restart do serviço o vigia só declara `idle` uma sessão que ELE viu trabalhar, então um
// condutor que já estava parado antes do restart nunca aparecia como quieto (cada publicação da
// ferramenta reiniciava o relógio de todo mundo). A segunda fonte sobrevive ao restart: o transcript da sessão (o
// CLI escreve nele a cada turno) e a tela de agora — parada no prompt, sem o rodapé de trabalho e sem tarefa em
// segundo plano. O transcript diz HÁ QUANTO; a tela diz que não é um turno longo nem uma espera por subagentes.

//
// WP5-F2 — mais duas testemunhas, as duas de primeira mão:
//   • os PROCESSOS do pane: uma suíte disparada em segundo plano (`&`, nohup) não aparece no rodapé do CLI, mas é um
//     filho vivo do claude (um condutor que esperava uma suíte parecia parado). Medido no host:
//     condutor em repouso tem ZERO filhos; cada chamada de ferramenta é um filho. O filho vivo é um FATO ao lado da
//     quietude (`childBusy`), nunca a apaga: um dev server subido no VERIFICAR, um watcher ou um servidor MCP stdio
//     também são filhos, e vivem para sempre — zerar a quietude por eles deixava o condutor invisível para o estacionar
//     do dono, para a escada e para o aviso do vigia. Quanto tempo o filho segura a vaga é de quem consome, com teto
//     (conductor-pause.ts `CHILD_WORK_WINDOW_FACTOR`);
//   • o ÚLTIMO TURNO do transcript: um turno que morreu num erro de transporte («API Error: The response stopped
//     arriving», sobrecarga) deixa o pane no prompt, sem pergunta e sem pausa — ninguém volta sozinho (o condutor
//     ficava assim até o dono digitar «continue»).

import type { TerminalAttention } from "@/lib/terminal/attention";
import type { AgentSession } from "./session-worktree";

/** O rodapé do CLI enquanto um turno roda. */
const WORKING = /esc to interrupt|para interromper|\bctrl\+c to (?:stop|cancel)\b/i;
/** Subagentes ou comandos em segundo plano vivos: o turno principal espera POR ELES — não está parado. */
const BACKGROUND = /↓ to manage|Waiting for \d+ background|background (?:agent|task|command)s? (?:still )?running/i;
/** A caixa de entrada do CLI, vazia ou com a sugestão em cinza. */
const PROMPT_BOX = /^\s*❯(?:\s|$)/;

/** A tela mostra o CLI parado na caixa de entrada, sem nada rodando? PURA. */
export function paneRestsAtPrompt(screen: string | null | undefined): boolean {
  if (!screen) return false;
  const tail = screen
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .slice(-10);
  if (!tail.some((l) => PROMPT_BOX.test(l))) return false;
  const text = tail.join("\n");
  return !WORKING.test(text) && !BACKGROUND.test(text);
}

/** Uma linha da tabela de processos — só o que a árvore do pane precisa. */
export interface PaneProc {
  pid: number;
  ppid: number;
  /** este processo É o binário do claude (process-attribution.ts `isClaudeProcess`). */
  claude: boolean;
}

/**
 * O claude deste pane tem processo FILHO vivo (uma ferramenta rodando, uma suíte em segundo plano, um job)? PURA.
 * `null` = não dá para saber (nenhum claude na árvore do pane, ou tabela vazia) — quem chama trata como «não sei»,
 * nunca como «quieto». Só os DESCENDENTES do claude contam: o shell que hospeda o claude não é trabalho.
 */
export function paneHasLiveChildren(panePids: readonly number[], procs: readonly PaneProc[]): boolean | null {
  if (!panePids.length || !procs.length) return null;
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) childrenOf.set(p.ppid, [...(childrenOf.get(p.ppid) ?? []), p.pid]);
  const isClaude = new Set(procs.filter((p) => p.claude).map((p) => p.pid));
  // a raiz do agente: o primeiro claude descendo do pane (o pane pode ser o próprio claude, ou um shell que o lançou)
  const seen = new Set<number>();
  const queue = [...panePids];
  while (queue.length) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (isClaude.has(pid)) return (childrenOf.get(pid) ?? []).length > 0;
    for (const c of childrenOf.get(pid) ?? []) queue.push(c);
  }
  return null;
}

/** O começo da mensagem que o CLI sintetiza quando a resposta não chegou inteira (versões sem a marca `isApiErrorMessage`). */
const TRANSPORT_ERROR = /^(?:API Error\b|Request timed out\b|Connection error\b)/i;

interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message?: { content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join(" ");
}

/**
 * O ÚLTIMO TURNO da conversa morreu num erro de transporte? PURA — o texto do erro, ou null. Lê o fim do transcript
 * de trás para frente e para no primeiro registro da conversa principal: uma mensagem do assistente (é ela que diz)
 * ou do usuário (alguém já falou depois — inclusive a linha de retomar que o serviço digita). Linhas de sistema,
 * snapshots, subagentes (`isSidechain`) e linhas truncadas são puladas. Forma medida no CLI 2.1.287:
 * `{"type":"assistant","isApiErrorMessage":true,"message":{"model":"<synthetic>","content":[{"type":"text",
 * "text":"API Error: The response stopped arriving. …"}]}}`, seguida de um `system/turn_duration`.
 */
export function lastTurnTransportError(chunk: string | null | undefined): string | null {
  if (!chunk) return null;
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || rec.isSidechain === true || rec.isMeta === true) continue;
    if (rec.type === "user") return null;
    if (rec.type !== "assistant") continue;
    // Só a mensagem que o CLI SINTETIZA para o erro conta (a marca, ou o texto que começa com «API Error») — o assistente
    // falando de um erro de API no meio de uma resposta normal não é um turno cortado.
    const text = textOf(rec.message?.content).trim();
    return rec.isApiErrorMessage === true || TRANSPORT_ERROR.test(text.split("\n")[0]?.slice(0, 40) ?? "") ? text.slice(0, 160) || "API Error" : null;
  }
  return null;
}

export interface QuietIo {
  /** as últimas linhas do pane, ou null se não deu para capturar. */
  capture(tmux: string): Promise<string | null>;
  /** o instante da última escrita do arquivo (ms), ou null. */
  mtimeMs(file: string): Promise<number | null>;
  /** o claude do pane tem filho vivo? `null` = não sei. Ausente ⇒ não é consultado. */
  busy?(tmux: string): Promise<boolean | null>;
  /** o fim do transcript (alguns KB), ou null. Ausente ⇒ o último turno não é lido. */
  tail?(file: string): Promise<string | null>;
}

export interface ConductorQuiet {
  /** há quanto tempo a sessão está quieta no prompt; null = trabalhando, ou não dá para saber. */
  quietForMs: number | null;
  /** um prompt DESENHADO na tela (menu, s/N) — digitar ali seria respondê-lo. */
  asking: boolean;
  /** só quando quieta: o último turno morreu num erro de transporte (o texto do erro). */
  transportError?: string;
  /**
   * só quando quieta: o claude do pane tem filho vivo — ou a sonda não soube dizer (na dúvida, pode ser trabalho). Não
   * apaga `quietForMs`: quem consome decide por quanto tempo isso segura a vaga.
   */
  childBusy?: true;
}

/** Um transcript mexido há menos que isto é um turno que acabou de terminar (ou está no meio): cedo para julgar. */
const MIN_TRANSCRIPT_QUIET_MS = 2 * 60_000;

/** O veredito para UMA sessão. Nunca lança; sem fato suficiente responde «não sei» (`quietForMs: null`). */
export async function conductorQuiet(session: Pick<AgentSession, "tmuxSession" | "transcriptFile">, attention: TerminalAttention | undefined, now: number, io: QuietIo): Promise<ConductorQuiet> {
  if (attention?.kind === "asking") return { quietForMs: null, asking: true };
  try {
    let quietForMs: number;
    if (attention?.kind === "idle") quietForMs = Math.max(0, now - attention.since);
    else {
      if (!session.tmuxSession || !session.transcriptFile) return { quietForMs: null, asking: false };
      const mtime = await io.mtimeMs(session.transcriptFile);
      if (mtime == null) return { quietForMs: null, asking: false };
      const age = now - mtime;
      if (age < MIN_TRANSCRIPT_QUIET_MS) return { quietForMs: null, asking: false };
      if (!paneRestsAtPrompt(await io.capture(session.tmuxSession))) return { quietForMs: null, asking: false };
      quietForMs = age;
    }
    // Filho vivo PODE ser trabalho (a suíte em segundo plano); «não sei» conta igual quando a sonda existe.
    const childBusy = !!io.busy && !!session.tmuxSession && (await io.busy(session.tmuxSession)) !== false;
    const transportError = io.tail && session.transcriptFile ? lastTurnTransportError(await io.tail(session.transcriptFile)) : null;
    return { quietForMs, asking: false, ...(transportError ? { transportError } : {}), ...(childBusy ? { childBusy: true as const } : {}) };
  } catch {
    return { quietForMs: null, asking: false };
  }
}
