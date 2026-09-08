// The MEDIDORES of a running service — the honest answer to "isso aí está produzindo alguma coisa?".
//
// The home's Terminais block and /processes used to answer that with a green dot (`status === "running"`)
// and an uptime that grows on its own. Neither is evidence: a session stuck for 80h and one burning 40k
// tokens/min rendered identically. This module defines what IS evidence, from signals the box already has:
//
//   • state    — the CLI's OWN busy/idle flag (`PaneClaude.status`), not a heuristic of ours. It is the
//                only source that distinguishes "escrevendo código" from "esperando você responder".
//   • context  — how much of the window the session has burned (readSessionContext), the recycle signal.
//   • diff     — lines the session's worktree has produced since its base. The hardest proof of work.
//   • cost     — US$/tokens, for the runner runs that report them.
//
// ISOMORPHIC (zero `node:*` imports) so the client components can import the types and the pure
// predicates. The IO that actually reads the box lives in `service-meters-io.ts` — importing THAT from a
// client component is what would drag `node:child_process` into the browser bundle.
//
// Honesty contract: every field degrades to `null`, never to a zero. `diff: null` means "não sei medir
// esta sessão" (no worktree); `{added: 0, removed: 0}` means "medi, e ela não escreveu nada" — the UI must
// be able to tell those apart, because the second one is a finding and the first one is not.

import { cliFlagExpired } from "../terminal/attention";
// `import type` é apagado na compilação — o módulo do lado do servidor NÃO entra no bundle do cliente,
// e o vocabulário de "por que não há contexto" continua tendo UMA definição.
import type { ContextAbsentReason } from "./pane-claude-map";
import type { ServiceKind, ServiceStatus } from "./types";

/** What the service is DOING — distinct from `ServiceStatus`, which only says the process exists. */
export type WorkState = "working" | "waiting" | "failed" | "done";

/**
 * WHERE the state came from, so the UI can say it in a tooltip instead of asserting a confidence it
 * doesn't have. `cli` is the trustworthy one (the agent's own flag); `status` is the weakest (we only
 * knew the process was alive) — the very signal the green dot used to present as certainty.
 *
 * `stale` is `cli` DEPOIS DE VENCIDO: havia um flag, a tela o desmentiu (ver cliFlagIsStale), e o que
 * sobra é "o processo existe". Ele é um valor PRÓPRIO, e não uma dobra em `status`, porque uma demoção
 * silenciosa se parece exatamente com um medidor que nunca funcionou — quem for depurar precisa
 * distinguir "não havia agente para perguntar" de "o agente respondeu e a resposta apodreceu".
 */
export type StateSource = "cli" | "run" | "status" | "stale";

export interface DiffStat {
  files: number;
  added: number;
  removed: number;
  /** new files git has not been told about yet — they contribute 0 lines to `added`, so a session that
   *  ONLY created files would otherwise read as "+0 −0", the exact false negative this module exists to kill. */
  untracked: number;
}

export interface ServiceMeter {
  state: WorkState;
  source: StateSource;
  /** % of the context window burned; null when there is no transcript to read (a plain shell) */
  contextPct: number | null;
  /**
   * POR QUE não há percentual, quando não há — `null` só quando há (`contextPct` preenchido).
   *
   * Existe porque "—" estava dizendo duas coisas incompatíveis com o mesmo símbolo: "esta sessão é
   * nova (ou você acabou de dar /clear) e ainda não teve um turno para medir" e "eu não consegui ler".
   * A primeira é um estado normal e esperado; a segunda é um defeito. Renderizá-las igual fazia um
   * `/clear` parecer o medidor quebrando.
   */
  contextAbsent: ContextAbsentReason | null;
  /** idade (ms) da leitura de contexto — a UI marca uma leitura velha em vez de fingir que é de agora */
  contextAgeMs: number | null;
  model: string | null;
  /** reasoning effort the session's last turn ran at (`xhigh`, `high`, …); null when unknown — read
   *  from the transcript, never guessed from the operator's default */
  effort: string | null;
  costUSD: number | null;
  tokens: number | null;
  /** null = not measurable (no worktree); zeroed = measured and empty */
  diff: DiffStat | null;
}

/** Kinds whose live process IS a turn in flight: a headless `claude -p` child does not sit at a prompt. */
const HEADLESS_KINDS = new Set<ServiceKind>(["runner-run", "helper-agent"]);

/**
 * PURE. The work state, resolved by descending trust: a terminal outcome first (it is a fact), then the
 * CLI's own busy/idle flag CORROBORATED BY THE SCREEN, then the headless-child inference, and only then
 * the bare process status.
 *
 * `claudeStatus` is whatever the pidfile wrote (`"busy"` / `"idle"` / anything the CLI adds later). Only
 * `busy` is read as working — an unknown value falls to `waiting` rather than claiming activity we can't
 * see, because over-reporting work is what the green dot already did.
 *
 * As TRÊS testemunhas que podem desmentir o flag (ele é um latch que o CLI escreve só na transição, e
 * uma sessão parqueada carrega `busy` indefinidamente — medido: 21,9h com a tela congelada, e 42,6h com
 * a tela PISCANDO por causa de um job em background):
 *   • `screenStillMs`     — há quanto tempo o pane não muda. Enganável por qualquer repaint.
 *   • `transcriptIdleMs`  — há quanto tempo o transcript não recebe uma linha. Imune a repaint.
 *   • `flagAgeMs`         — há quanto tempo o flag atual foi gravado. Protege o turno longo e silencioso.
 * Passar `null`/omitir qualquer uma significa "não olhei" e mantém o comportamento antigo — sem
 * evidência não há demoção. Ver `cliFlagExpired`, onde a régua e as medições estão documentadas.
 */
export function deriveWorkState(input: {
  status: ServiceStatus;
  kind: ServiceKind;
  claudeStatus?: string | null;
  /** ms desde a última mudança na TELA do pane; null/ausente = sem evidência de tela */
  screenStillMs?: number | null;
  /** ms desde a última escrita no TRANSCRIPT da sessão; null/ausente = não medido */
  transcriptIdleMs?: number | null;
  /** ms desde que o CLI gravou o flag atual (`statusUpdatedAt`); null/ausente = não sabido */
  flagAgeMs?: number | null;
}): { state: WorkState; source: StateSource } {
  if (input.status === "failed" || input.status === "interrupted") return { state: "failed", source: "status" };
  if (input.status === "done") return { state: "done", source: "status" };

  const flag = input.claudeStatus?.trim().toLowerCase();
  if (flag) {
    // A evidência desmentiu o flag: cai para o que ainda é verdade — o processo existe. NUNCA para o
    // estado oposto: afirmar "ocioso" com base em ausência de dado seria o mesmo erro, espelhado.
    if (
      cliFlagExpired({
        screenStillMs: input.screenStillMs,
        transcriptIdleMs: input.transcriptIdleMs,
        flagAgeMs: input.flagAgeMs,
      })
    ) {
      return { state: "waiting", source: "stale" };
    }
    return { state: flag === "busy" ? "working" : "waiting", source: "cli" };
  }

  if (HEADLESS_KINDS.has(input.kind) && input.status === "running") return { state: "working", source: "run" };

  return { state: "waiting", source: "status" };
}

const SHORTSTAT_FILES = /(\d+)\s+files?\s+changed/;
const SHORTSTAT_ADDED = /(\d+)\s+insertions?\(\+\)/;
const SHORTSTAT_REMOVED = /(\d+)\s+deletions?\(-\)/;

/**
 * PURE. `" 3 files changed, 128 insertions(+), 31 deletions(-)"` → the counts. git omits whichever clause
 * is zero (a pure-deletion commit has no `insertions(+)` at all), so each is matched independently and
 * defaults to 0. Empty/unparseable input → null: "não consegui medir" is not "mediu zero".
 */
export function parseShortstat(text: string): Omit<DiffStat, "untracked"> | null {
  const files = SHORTSTAT_FILES.exec(text);
  if (!files) return null;
  return {
    files: Number(files[1]),
    added: Number(SHORTSTAT_ADDED.exec(text)?.[1] ?? 0),
    removed: Number(SHORTSTAT_REMOVED.exec(text)?.[1] ?? 0),
  };
}

/**
 * PURE. Which registered worktree a process is writing into, judged by its CWD.
 *
 * The obvious join — `session.tmuxSession` → `service.tmuxSession` — is WRONG in practice, and measurably
 * so: a session opened by `worktree_open` from a Claude Code session is not tmux-hosted, so its
 * `tmuxSession` is null (verified against the live box: both fleet rows carried a branch and a tree, and
 * no tmux handle). Keying on it left `diff` null for exactly the sessions the diff exists to measure.
 *
 * The cwd is direct evidence instead of a registry coincidence: a process running inside
 * `.worktrees/agent-<id>` IS writing to that tree. Longest-prefix so a nested tree wins over its parent,
 * and the boundary check keeps `agent-1` from swallowing `agent-12`.
 */
export function matchWorktree<T extends { worktreePath: string }>(
  cwd: string | null | undefined,
  trees: T[],
): T | null {
  if (!cwd) return null;
  let best: T | null = null;
  for (const t of trees) {
    const root = t.worktreePath.replace(/\/+$/, "");
    if (cwd !== root && !cwd.startsWith(root + "/")) continue;
    if (!best || root.length > best.worktreePath.replace(/\/+$/, "").length) best = t;
  }
  return best;
}

/** PURE. Did this session produce anything at all? Drives the "sem escrita" vs "—" split in the UI. */
export function diffIsEmpty(d: DiffStat | null): boolean {
  return d != null && d.added === 0 && d.removed === 0 && d.untracked === 0;
}

/**
 * PURE. The meter for a service the collector has not answered for yet (first paint, or a row it could not
 * read). Falls back to the ONE thing the list itself knows — the process status and kind — reusing
 * `deriveWorkState` so the client's optimistic state can never disagree with the server's rule.
 */
export function meterFallback(svc: { status: ServiceStatus; kind: ServiceKind }): ServiceMeter {
  const { state, source } = deriveWorkState({ status: svc.status, kind: svc.kind });
  return {
    state,
    source,
    contextPct: null,
    // O coletor ainda não respondeu por esta linha: isso NÃO é "sessão nova" nem "ilegível" — é o
    // primeiro quadro. `null` aqui e `contextPct: null` juntos são o "ainda não sei" da UI.
    contextAbsent: null,
    contextAgeMs: null,
    model: null,
    effort: null,
    costUSD: null,
    tokens: null,
    diff: null,
  };
}
