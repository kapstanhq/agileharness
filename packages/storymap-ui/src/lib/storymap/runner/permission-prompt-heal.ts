// O PASSE QUE DESTRAVA PEDIDOS DE PERMISSÃO DA FROTA — a regra de permission-prompt.ts, aplicada a cada sessão viva.
//
// Roda no tick da frota (conductor-pause-deps.ts). Para cada sessão com um pedido de permissão de FERRAMENTA na tela:
// espera a carência (um humano que olha o terminal tem a vez), julga pelo comando exato do transcript e responde —
// aprova o falso positivo provado, recusa o que o isolamento não prova, e recusa o que não consegue julgar quando o
// prazo vence. Nunca responde pergunta do agente ao dono (parseToolPrompt devolve null para ela) e nunca digita nada
// além de UMA tecla de opção. Cada resposta vira uma decisão do sistema no registro (o dono lê, não decide). Nunca lança.

import type { SystemDecision } from "@/lib/storymap/system-decisions";
import { isLiveSession } from "./conductor";
import {
  PROMPT_GRACE_MS,
  PROMPT_MAX_ANSWERS,
  judgeToolPrompt,
  noKey,
  parseToolPrompt,
  yesKey,
  type PendingToolUse,
  type PromptRoots,
  type PromptVerdict,
  type ToolPrompt,
} from "./permission-prompt";
import type { AgentSession } from "./session-worktree";

/** O que o passe lembra de cada sessão entre ticks. */
export interface PromptMemo {
  /** a impressão do pedido que está na tela — um pedido NOVO zera a carência. */
  fingerprint: string;
  /** quando este pedido foi visto pela primeira vez (epoch ms). */
  seenAt: number;
  /** quantas respostas o sistema já deu a esta sessão (laço pedido→recusa→pedido). */
  answers: number;
}
export type PromptHealState = Map<string, PromptMemo>;

export interface PromptHealDeps {
  sessions(): Promise<AgentSession[]>;
  liveTmux(): Promise<ReadonlySet<string> | null>;
  heartbeatAlive(s: AgentSession): boolean;
  /** o pane roda o binário do claude? (nunca digitar numa tecla em um shell) */
  runsClaude(tmux: string): Promise<boolean>;
  /** a tela do pane (as últimas linhas); null = não deu para ler. */
  screen(tmux: string): Promise<string | null>;
  /** a chamada de ferramenta sem resultado no transcript da sessão (e dos subagentes dela); null = não achou. */
  pendingTool(s: AgentSession): Promise<PendingToolUse | null>;
  /** o isolamento da sessão. */
  roots(s: AgentSession): PromptRoots;
  /** pressiona UMA tecla de opção no pane. */
  press(tmux: string, key: string): Promise<boolean>;
  record?(entry: SystemDecision): Promise<void>;
  newId?(): string;
  now?(): number;
  log?(line: string): void;
  state: PromptHealState;
}

export interface PromptHealReport {
  approved: Array<{ tmuxSession: string; cardId?: string }>;
  rejected: Array<{ tmuxSession: string; cardId?: string }>;
  /** pedidos vistos que ainda esperam (carência ou prazo). */
  waiting: Array<{ tmuxSession: string; ageMs: number; why: string }>;
}

const fingerprintOf = (p: ToolPrompt, pending: PendingToolUse | null): string =>
  `${p.header}|${p.warning ?? ""}|${typeof pending?.input.command === "string" ? pending.input.command.slice(0, 120) : ""}`;

export async function healPermissionPrompts(deps: PromptHealDeps): Promise<PromptHealReport> {
  const log = deps.log ?? ((l: string) => console.log(`[prompt-heal] ${l}`));
  const report: PromptHealReport = { approved: [], rejected: [], waiting: [] };
  try {
    const live = await deps.liveTmux().catch(() => null);
    if (live === null) return report;
    const now = (deps.now ?? Date.now)();
    const seen = new Set<string>();
    for (const s of await deps.sessions()) {
      const tmux = s.tmuxSession;
      if (!tmux || !isLiveSession(s, live, deps.heartbeatAlive)) continue;
      const screen = await deps.screen(tmux).catch(() => null);
      const prompt = screen ? parseToolPrompt(screen) : null;
      if (!prompt) continue; // sem pedido de permissão na tela (ou é uma pergunta do agente: do humano)
      if (!(await deps.runsClaude(tmux))) continue;
      seen.add(s.sessionId);
      const pending = await deps.pendingTool(s).catch(() => null);
      const fp = fingerprintOf(prompt, pending);
      let memo = deps.state.get(s.sessionId);
      if (!memo || memo.fingerprint !== fp) memo = { fingerprint: fp, seenAt: now, answers: memo?.answers ?? 0 };
      deps.state.set(s.sessionId, memo);
      const ageMs = now - memo.seenAt;
      if (ageMs < PROMPT_GRACE_MS) {
        report.waiting.push({ tmuxSession: tmux, ageMs, why: "carência: um humano que está olhando tem a vez" });
        continue;
      }
      if (memo.answers >= PROMPT_MAX_ANSWERS) {
        report.waiting.push({ tmuxSession: tmux, ageMs, why: `o sistema já respondeu ${memo.answers} pedidos desta sessão — o resto é de um humano` });
        continue;
      }
      const verdict: PromptVerdict = judgeToolPrompt(prompt, pending, deps.roots(s), ageMs);
      if (verdict.action === "unjudged") {
        report.waiting.push({ tmuxSession: tmux, ageMs, why: verdict.why });
        continue;
      }
      const key = verdict.action === "approve" ? yesKey(prompt) : noKey(prompt);
      if (!key) {
        report.waiting.push({ tmuxSession: tmux, ageMs, why: "a tela não tem a opção a pressionar" });
        continue;
      }
      if (!(await deps.press(tmux, key))) continue; // tenta de novo no próximo passe
      deps.state.set(s.sessionId, { ...memo, answers: memo.answers + 1 });
      (verdict.action === "approve" ? report.approved : report.rejected).push({ tmuxSession: tmux, ...(s.cardId ? { cardId: s.cardId } : {}) });
      log(`${s.board ?? "-"}/${s.cardId ?? "-"} (${tmux}): pedido de permissão ${verdict.action === "approve" ? "APROVADO" : "RECUSADO"} depois de ${Math.round(ageMs / 60_000)} min — ${verdict.why}`);
      if (deps.record && s.board) {
        const cmd = typeof pending?.input.command === "string" ? pending.input.command.replace(/\s+/g, " ").slice(0, 160) : prompt.header.slice(0, 160);
        await deps
          .record({
            v: 1,
            id: deps.newId?.() ?? `prompt-${s.sessionId}-${now}`,
            at: new Date(now).toISOString(),
            board: s.board,
            ...(s.cardId ? { cardId: s.cardId } : {}),
            agent: "system",
            kind: "stall-retry",
            what:
              verdict.action === "approve"
                ? `Liberou um comando seguro que a sessão de ${s.cardId ?? "um agente"} esperava aprovar (parada havia ${Math.round(ageMs / 60_000)} min)`
                : `Recusou um pedido de permissão que travava a sessão de ${s.cardId ?? "um agente"} havia ${Math.round(ageMs / 60_000)} min`,
            why: `${verdict.why}. Comando: ${cmd}`,
          })
          .catch((err) => log(`o registro da decisão falhou — ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    // O pedido saiu da tela: a carência recomeça no próximo, mas a contagem de respostas fica (o laço
    // pedido→recusa→pedido volta com outro pedido; zerar aqui o esconderia). Sessão que sumiu do registro sai do estado.
    const known = new Set((await deps.sessions().catch(() => [])).map((x) => x.sessionId));
    for (const [id, memo] of deps.state) {
      if (seen.has(id)) continue;
      if (!known.has(id) || memo.answers === 0) deps.state.delete(id);
      else deps.state.set(id, { ...memo, fingerprint: "", seenAt: 0 });
    }
  } catch (err) {
    log(`o passe de pedidos de permissão falhou — ${err instanceof Error ? err.message : String(err)}`);
  }
  return report;
}
