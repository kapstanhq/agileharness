// O FEED `card-live` — os fatos vivos que a linha de estado do card (card-live-status.ts) precisa e que o navegador
// NÃO tinha: quem (sessão) está em cada card e em que bloco, a fila do condutor, o limite de ações por hora de cada
// board e o juiz da triagem. As execuções do motor e a fila da integração já andam no SSE (`runner`, `merge-queue`);
// os terminais que esperam o operador também (`terminals`). Este feed completa o retrato, no MESMO stream.
//
// CUSTO, por construção (um board tem centenas de cards; o feed não pode custar por card):
//   • UM coletor por processo, ligado só enquanto há uma página aberta (contagem de assinantes, como o de métricas);
//   • a cada {@link CARD_LIVE_POLL_MS}: o registro de sessões (um JSON pequeno), a fila do condutor (idem), o FIM do
//     ledger de ações (os últimos {@link ACTIONS_TAIL_BYTES}, nunca o arquivo inteiro) e um `tmux list-sessions`;
//   • o tamanho do trabalho (`git diff --shortstat`) SÓ das sessões vivas com árvore, no máximo uma vez a cada
//     {@link DIFF_MIN_INTERVAL_MS} por sessão — nunca por render, nunca por card;
//   • a EVIDÊNCIA de trabalho de cada sessão viva ({@link sessionEvidence}): um `stat` do transcript, um da pasta, e a
//     tela SÓ quando o transcript está quieto há 2 min ou mais (é conductorQuiet quem decide quando olhar);
//   • o quadro só sai quando MUDOU (comparado por texto).
// As partes que decidem são PURAS e exportadas (testadas em card-live-feed.test.ts); o IO fica na casca.

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { promisify } from "node:util";
import { agentActionsPath } from "@/lib/storymap/paths";
import type { BoardThrottleFact, CardLiveFeed, CardQueueFact, CardSessionFact, DiffStat } from "@/lib/storymap/card-live-status";
import { latestActivity } from "@/lib/storymap/agent-presence";
import type { TerminalAttention } from "@/lib/terminal/attention";
import type { AgentAction } from "./agent-actions";
import type { ConductorQueueEntry } from "./conductor";
import { conductorQuiet, type QuietIo } from "./conductor-quiet";
import type { AgentSession } from "./session-worktree";
import { isSessionAlive } from "./session-liveness";
import { parseShortstat } from "./diff";

export const CARD_LIVE_POLL_MS = 15_000;
export const DIFF_MIN_INTERVAL_MS = 60_000;
export const ACTIONS_TAIL_BYTES = 64 * 1024;

// ── PURAS ──────────────────────────────────────────────────────────────────────────────────────────────

/** «14 files changed, 442 insertions(+), 8 deletions(-)» → {additions, deletions, files}. PURA. */
export function shortstatToDiff(out: string): DiffStat {
  const files = /(\d+)\s+files?\s+changed/.exec(out);
  return { ...parseShortstat(out), files: files ? Number(files[1]) : 0 };
}

/** A hora da volta de uma linha `throttled` — o campo, ou (linhas antigas) o ISO dentro da nota. PURA. */
function retryAfterOf(a: AgentAction): string | undefined {
  if (a.retryAfter) return a.retryAfter;
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.exec(a.note ?? "")?.[0];
}

/**
 * Os boards com o limite de ações por hora FECHADO agora: a última ação freada de cada board cuja volta ainda
 * está no futuro. PURA.
 */
export function throttleWindows(actions: readonly AgentAction[], now: number): BoardThrottleFact[] {
  const byBoard = new Map<string, BoardThrottleFact>();
  for (const a of actions) {
    if (a.outcome !== "throttled" || !a.board) continue;
    const until = retryAfterOf(a);
    const untilMs = until ? Date.parse(until) : NaN;
    if (!Number.isFinite(untilMs) || untilMs <= now) continue;
    const prev = byBoard.get(a.board);
    if (!prev || Date.parse(a.at) > Date.parse(prev.at)) byBoard.set(a.board, { board: a.board, at: a.at, until: new Date(untilMs).toISOString() });
  }
  return [...byBoard.values()];
}

/** A posição de cada card na fila do condutor, por board, na ordem do arquivo (= a ordem de despacho). PURA. */
export function conductorQueueFacts(entries: readonly ConductorQueueEntry[]): CardQueueFact[] {
  const totals = new Map<string, number>();
  for (const e of entries) totals.set(e.board, (totals.get(e.board) ?? 0) + 1);
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const position = (seen.get(e.board) ?? 0) + 1;
    seen.set(e.board, position);
    return {
      board: e.board,
      cardId: e.cardId,
      position,
      total: totals.get(e.board) ?? position,
      queuedAt: e.queuedAt,
      ...(e.lastWaitKind ? { waitKind: e.lastWaitKind } : {}),
      ...(e.lastWaitReason ? { waitReason: e.lastWaitReason } : {}),
    };
  });
}

/**
 * Está viva? Quem tem tmux vive enquanto a tmux responde; sem sonda (`liveTmux === null`) ou sem tmux, vale o
 * heartbeat. PURA — a mesma régua do contador de condutores (conductor.ts `isLiveConductor`).
 */
export function sessionIsLive(s: AgentSession, liveTmux: ReadonlySet<string> | null, now: number): boolean {
  if (s.tmuxSession && liveTmux) return liveTmux.has(s.tmuxSession);
  return isSessionAlive(s, now);
}

/** A evidência de trabalho de UMA sessão viva, como o feed a carrega — quem decide com ela é agent-presence.ts. */
export type SessionEvidence = Pick<CardSessionFact, "lastActivityAt" | "busy" | "zombie">;

/** As sessões VIVAS que trabalham num card, no formato do feed, com a evidência medida. PURA. */
export function sessionFacts(
  sessions: readonly AgentSession[],
  liveTmux: ReadonlySet<string> | null,
  now: number,
  diffs: ReadonlyMap<string, DiffStat | null>,
  evidence: ReadonlyMap<string, SessionEvidence> = new Map(),
): CardSessionFact[] {
  return sessions
    .filter((s) => !!s.board && !!s.cardId && sessionIsLive(s, liveTmux, now))
    .map((s) => ({
      board: s.board!,
      cardId: s.cardId!,
      sessionId: s.sessionId,
      role: s.role,
      conductor: s.driver === "conductor",
      ...(s.tmuxSession ? { tmuxSession: s.tmuxSession } : {}),
      openedAt: s.openedAt,
      heartbeatAt: s.heartbeatAt,
      ...(s.progress ? { progress: s.progress } : {}),
      diff: diffs.get(s.sessionId) ?? null,
      // sem medida (a sonda falhou), ao menos o que o registro já provou — nunca o heartbeat
      ...(evidence.get(s.sessionId) ?? (s.lastActivityAt ? { lastActivityAt: s.lastActivityAt } : {})),
    }));
}

/** O IO da evidência: o de conductorQuiet (tela, mtime) mais «a pasta existe?» (null = não deu para saber). */
export interface EvidenceIo extends QuietIo {
  exists(dir: string): Promise<boolean | null>;
}

/**
 * A evidência de trabalho de UMA sessão viva. Nunca lança; sem fato, devolve só o que o registro já provou.
 *   • ZUMBI: a pasta de trabalho dela sumiu com o tmux vivo (o condutor descartou a árvore e o terminal sobrou) — não é
 *     agente; nada mais é medido. «Não deu para saber» (null) nunca vira zumbi.
 *   • lastActivityAt: o mais novo entre o registro (relato, submit/refresh, o tick), a escrita do transcript AGORA e o
 *     relato — a última atividade PROVADA.
 *   • busy: a tela mostra um turno rodando (uma suíte longa não escreve no transcript). Quem decide QUANDO olhar a tela é
 *     conductorQuiet — só com o transcript quieto há 2 min ou mais e sem veredito do vigia —; se ele olhou e não a achou
 *     parada no prompt, é trabalho agora. Uma captura que falhou (tela null) não é prova de nada.
 */
export async function sessionEvidence(s: AgentSession, attention: TerminalAttention | undefined, now: number, io: EvidenceIo): Promise<SessionEvidence> {
  try {
    const dir = s.worktreePath ?? s.cwd;
    if (dir && (await io.exists(dir).catch(() => null)) === false) return { zombie: true };
    const wrote = s.transcriptFile ? await io.mtimeMs(s.transcriptFile).catch(() => null) : null;
    const seen: { screen: string | null } = { screen: null };
    const quiet = await conductorQuiet(s, attention, now, {
      mtimeMs: async () => wrote, // o mesmo `stat` — conductorQuiet só pergunta pelo transcript desta sessão
      capture: async (tmux) => (seen.screen = await io.capture(tmux)),
    });
    const at = latestActivity(s.lastActivityAt, wrote, s.progress?.at);
    const busy = seen.screen != null && quiet.quietForMs == null && !quiet.asking;
    return { ...(at != null ? { lastActivityAt: new Date(at).toISOString() } : {}), ...(busy ? { busy: true } : {}) };
  } catch {
    return s.lastActivityAt ? { lastActivityAt: s.lastActivityAt } : {};
  }
}

/** Medir o diff desta sessão agora? Só com árvore e base, e no máximo uma vez por intervalo. PURA. */
export function diffIsDue(s: AgentSession, last: { at: number } | undefined, now: number, minIntervalMs = DIFF_MIN_INTERVAL_MS): boolean {
  if (!s.worktreePath || !s.baseCommit) return false;
  return !last || now - last.at >= minIntervalMs;
}

// ── a casca (IO) ───────────────────────────────────────────────────────────────────────────────────────

const execFileP = promisify(execFile);

/** O FIM do ledger de ações (nunca o arquivo inteiro), linhas inteiras só. */
async function readActionsTail(file = agentActionsPath(), bytes = ACTIONS_TAIL_BYTES): Promise<AgentAction[]> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    fh = await fsp.open(file, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // a primeira linha do recorte pode estar pela metade
    const out: AgentAction[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l) as AgentAction);
      } catch {
        /* linha corrompida: pula */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    await fh?.close().catch(() => {});
  }
}

export interface CardLiveSources {
  loadSessions(): Promise<AgentSession[]>;
  loadConductorQueue(): Promise<ConductorQueueEntry[]>;
  readActions(): Promise<AgentAction[]>;
  /** os nomes das tmux vivas, ou null quando a sonda não respondeu. */
  liveTmux(): Promise<ReadonlySet<string> | null>;
  judging(): string[];
  /** `git diff --shortstat <base>` na árvore da sessão. */
  measureDiff(worktreePath: string, baseCommit: string): Promise<DiffStat | null>;
  /** a foto do vigia de terminais — o primeiro fato que conductorQuiet lê (asking / idle desde quando). */
  attention(): readonly TerminalAttention[];
  /** o IO da evidência de trabalho ({@link sessionEvidence}). */
  evidenceIo: EvidenceIo;
  now?(): number;
}

async function defaultSources(): Promise<CardLiveSources> {
  const [{ makeSessionStore }, { diskConductorQueueStore }, { probeLiveTmuxSessions }, { triageJudgeInFlight }, { currentTerminalAttention }, { capturePane }] =
    await Promise.all([
      import("./session-worktree"),
      import("./conductor"),
      import("@/lib/vps/tmux"),
      import("./triage-judge"),
      import("@/lib/terminal/attention-watch"),
      import("@/lib/terminal/tmux"),
    ]);
  const sessions = makeSessionStore();
  const queue = diskConductorQueueStore();
  return {
    loadSessions: () => sessions.load(),
    loadConductorQueue: () => queue.load(),
    readActions: () => readActionsTail(),
    async liveTmux() {
      const probe = await probeLiveTmuxSessions().catch(() => null);
      return probe && probe.ok ? new Set(probe.names) : null;
    },
    judging: () => triageJudgeInFlight(),
    attention: () => currentTerminalAttention(),
    evidenceIo: {
      // as mesmas 40 linhas que o vigia de card parado captura (stall-watch-deps.ts QUIET_IO)
      capture: (tmux) => capturePane(tmux, 40),
      async mtimeMs(file) {
        try {
          return (await fsp.stat(file)).mtimeMs;
        } catch {
          return null;
        }
      },
      async exists(dir) {
        try {
          await fsp.stat(dir);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
        }
      },
    },
    async measureDiff(worktreePath, baseCommit) {
      try {
        // GIT_OPTIONAL_LOCKS=0: a árvore é de um agente TRABALHANDO — um `git diff` comum atualiza o índice por
        // oportunidade e pega o `index.lock`, e o `git add`/`commit` dele falharia no meio com «index.lock exists».
        const { stdout } = await execFileP("git", ["-C", worktreePath, "diff", "--shortstat", baseCommit], {
          timeout: 10_000,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        });
        return shortstatToDiff(stdout);
      } catch {
        return null;
      }
    },
  };
}

type Listener = (feed: CardLiveFeed) => void;

export class CardLiveHub {
  private listeners = new Set<Listener>();
  private last: CardLiveFeed | null = null;
  private lastText = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private diffs = new Map<string, { at: number; stat: DiffStat | null }>();

  constructor(private sourcesFactory: () => Promise<CardLiveSources> = defaultSources) {}

  /** Um retrato novo. Nunca lança: uma fonte que falha vira vazio, as outras seguem. */
  async collect(): Promise<CardLiveFeed> {
    const src = await this.sourcesFactory();
    const now = (src.now ?? Date.now)();
    const [sessions, queue, actions, liveTmux] = await Promise.all([
      src.loadSessions().catch(() => []),
      src.loadConductorQueue().catch(() => []),
      src.readActions().catch(() => []),
      src.liveTmux().catch(() => null),
    ]);
    const live = sessions.filter((s) => !!s.board && !!s.cardId && sessionIsLive(s, liveTmux, now));
    for (const s of live) {
      if (!diffIsDue(s, this.diffs.get(s.sessionId), now)) continue;
      const stat = await src.measureDiff(s.worktreePath!, s.baseCommit!).catch(() => null);
      this.diffs.set(s.sessionId, { at: now, stat });
    }
    const liveIds = new Set(live.map((s) => s.sessionId));
    for (const id of [...this.diffs.keys()]) if (!liveIds.has(id)) this.diffs.delete(id);
    const diffMap = new Map([...this.diffs].map(([id, d]) => [id, d.stat]));
    let judging: string[] = [];
    try {
      judging = src.judging();
    } catch {
      judging = [];
    }
    let attention = new Map<string, TerminalAttention>();
    try {
      attention = new Map(src.attention().map((t) => [t.session, t] as const));
    } catch {
      /* sem a foto do vigia, conductorQuiet cai no transcript + tela */
    }
    const evidence = new Map<string, SessionEvidence>();
    await Promise.all(
      live.map(async (s) => {
        evidence.set(s.sessionId, await sessionEvidence(s, s.tmuxSession ? attention.get(s.tmuxSession) : undefined, now, src.evidenceIo));
      }),
    );
    this.last = {
      at: now,
      sessions: sessionFacts(live, liveTmux, now, diffMap, evidence),
      queue: conductorQueueFacts(queue),
      throttles: throttleWindows(actions, now),
      judging,
    };
    return this.last;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const feed = await this.collect();
      const { at: _at, ...rest } = feed;
      const text = JSON.stringify(rest);
      if (text === this.lastText) return; // nada mudou — nenhum quadro
      this.lastText = text;
      for (const fn of this.listeners) {
        try {
          fn(feed);
        } catch {
          this.listeners.delete(fn);
        }
      }
    } catch {
      /* uma leitura que falha não pode travar o intervalo */
    } finally {
      this.polling = false;
    }
  }

  /** Assina um stream SSE. Liga o coletor no primeiro assinante; desliga no último. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.last) fn(this.last);
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), CARD_LIVE_POLL_MS);
      void this.poll();
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.lastText = "";
      }
    };
  }
}

const KEY = Symbol.for("agileharness.cardLiveHub");
const store = globalThis as unknown as { [KEY]?: CardLiveHub };

export function getCardLiveHub(): CardLiveHub {
  return (store[KEY] ??= new CardLiveHub());
}
