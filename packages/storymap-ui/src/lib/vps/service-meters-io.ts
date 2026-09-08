// SERVER-ONLY half of the service meters: the reads that turn a `RunningService` into a `ServiceMeter`.
// The types and the pure predicates live in `service-meters.ts`, which is isomorphic — keep `node:*`
// imports on THIS side of the line so a client component importing a meter type never drags the box
// into the browser bundle.
//
// A SEPARATE endpoint from /api/processes for the reason /api/terminal/meter is separate from
// /api/terminal/sessions: the list route is polled every 8s and already costs several tmux/ps spawns.
// Folding a transcript read plus two git spawns per service into it would push it past its own interval,
// and the client's poll guard would then start skipping polls in silence.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { paneClaudeMap, type ContextAbsentReason, type PaneResolution } from "./pane-claude-map";
import { readSessionContext, readTranscriptIdle } from "./transcript-usage";
import { screenStillness } from "@/lib/terminal/attention-watch";
import { allSessions } from "@/lib/storymap/runner/session-worktree";
import { deriveWorkState, matchWorktree, parseShortstat, type DiffStat, type ServiceMeter } from "./service-meters";
import type { RunningService } from "./types";

const pexec = promisify(execFile);

/** Every git call is bounded and non-fatal: a meter is a nicety, never a reason for the page to fail. */
const GIT_TIMEOUT_MS = 2500;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await pexec("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Lines produced in `worktreePath` since `baseCommit` — committed work AND the working tree in one
 * measure, because "o agente commitou" and "o agente escreveu" are the same claim to an operator asking
 * whether the session did anything.
 *
 * Two spawns: `diff --shortstat <base>` counts tracked lines; `ls-files --others` counts the new files
 * that diff structurally cannot see.
 */
export async function readDiffStat(worktreePath: string, baseCommit?: string): Promise<DiffStat | null> {
  const out = await git(worktreePath, ["diff", "--shortstat", ...(baseCommit ? [baseCommit] : [])]);
  if (out == null) return null; // not a worktree / git refused → not measurable
  const parsed = parseShortstat(out) ?? { files: 0, added: 0, removed: 0 };
  const others = await git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  const untracked = others ? others.split("\n").filter((l) => l.trim().length > 0).length : 0;
  return { ...parsed, untracked };
}

/** The pidfile's claude handle, whichever side of the resolution it landed on. */
function claudeOf(pane: PaneResolution | undefined) {
  if (!pane) return null;
  return pane.ok ? pane.pane.claude : pane.claude;
}

/**
 * Há quanto tempo o CLI gravou o flag atual. `null` quando o pidfile não carrega o carimbo (CLI mais
 * antigo) — ausência, nunca zero, que a régua leria como "acabou de mudar de estado".
 *
 * `Math.max(0, …)`: um carimbo no futuro (relógio ajustado entre a escrita e a leitura) vira "agora",
 * que é o valor CONSERVADOR aqui — nunca demove o flag por causa de um relógio.
 */
function flagAge(statusUpdatedAt: number | null, now: number): number | null {
  if (statusUpdatedAt == null || !Number.isFinite(statusUpdatedAt)) return null;
  return Math.max(0, now - statusUpdatedAt);
}


/**
 * The meters for every service in `services`, keyed by `service.id`.
 *
 * ONE pane snapshot for the whole list (`paneClaudeMap`) rather than a `resolvePaneLive` per row — the
 * resolution is a box-wide read, and doing it per service would multiply the tmux/ps spawns by the number
 * of terminals on screen. The per-service work after that is one bounded transcript pread plus, for the
 * sessions that own a worktree, the two git spawns above.
 */
export async function collectServiceMeters(services: RunningService[]): Promise<Record<string, ServiceMeter>> {
  const [panes, sessions] = await Promise.all([
    paneClaudeMap().catch(() => new Map<string, PaneResolution>()),
    allSessions().catch(() => []),
  ]);
  // A tela é a testemunha independente do flag busy/idle do pidfile — leitura de memória do vigia, que
  // já amostra todo pane a cada 6s. Sem custo novo e sem um segundo relógio (ver attention-watch.ts).
  const still = screenStillness();

  // The fleet registry is what knows a session's tree and the sha it was cut from. The JOIN back to a
  // running service is by CWD, not by tmux handle — see matchWorktree.
  const trees = sessions
    .filter((s) => Boolean(s.worktreePath))
    .map((s) => ({ worktreePath: s.worktreePath!, baseCommit: s.baseCommit }));

  const now = Date.now();

  const entries = await Promise.all(
    services.map(async (svc): Promise<[string, ServiceMeter]> => {
      const pane = svc.tmuxSession ? panes.get(svc.tmuxSession) : undefined;

      let contextPct: number | null = null;
      let contextAbsent: ContextAbsentReason | null = null;
      let contextAgeMs: number | null = null;
      let model: string | null = null;
      // The effort has ONE source — the transcript record. The pidfile does not carry it, and the
      // operator's `effortLevel` in settings is a default a session may have overridden with `/effort`.
      let effort: string | null = null;
      let cwd: string | null = null;
      // A TERCEIRA testemunha do flag (ver deriveWorkState): quando o transcript foi escrito pela
      // última vez. Precisa ser lida ANTES do estado — por isso a leitura de contexto subiu para cá.
      let transcriptIdleMs: number | null = null;

      if (pane?.ok) {
        cwd = pane.pane.cwd;
        const [ctx, idle] = await Promise.all([
          // O `cwd` é o terceiro argumento por um motivo concreto: sem ele a janela de contexto de uma
          // sessão sem pin cai no id PELADO do transcript (200k) mesmo quando ela roda a variante de 1M —
          // e um agente 20% cheio aparecia como 98%, vermelho, pedindo reciclagem.
          readSessionContext(pane.pane.transcriptPath, pane.pane.model, pane.pane.cwd).catch(() => null),
          readTranscriptIdle(pane.pane.transcriptPath, now).catch(() => null),
        ]);
        transcriptIdleMs = idle;
        contextPct = ctx?.pct ?? null;
        model = ctx?.model ?? pane.pane.model ?? null;
        effort = ctx?.effort ?? null;
        const readAt = ctx?.at ? Date.parse(ctx.at) : NaN;
        contextAgeMs = Number.isFinite(readAt) ? Math.max(0, now - readAt) : null;
        // Sem percentual, DIGA QUAL ausência é. `idle != null` prova que o arquivo existe (o mesmo
        // stat), então uma sessão recém-limpa é "no-usage" — normal — e não "unreadable" — defeito.
        if (contextPct == null) contextAbsent = idle != null ? "no-usage" : "unreadable";
      } else if (pane) {
        contextAbsent = pane.reason;
      }
      // `pane` ausente (linha sem pane tmux — um run headless) fica com contextAbsent null: esta
      // superfície não resolve contexto para essas linhas, e afirmar um motivo seria inventar um.

      const { state, source } = deriveWorkState({
        status: svc.status,
        kind: svc.kind,
        claudeStatus: claudeOf(pane)?.status ?? null,
        screenStillMs: svc.tmuxSession ? (still.get(svc.tmuxSession) ?? null) : null,
        transcriptIdleMs,
        flagAgeMs: flagAge(claudeOf(pane)?.statusUpdatedAt ?? null, now),
      });

      const tree = matchWorktree(cwd, trees);
      const diff = tree ? await readDiffStat(tree.worktreePath, tree.baseCommit) : null;

      return [
        svc.id,
        {
          state,
          source,
          contextPct,
          contextAbsent,
          contextAgeMs,
          model,
          effort,
          costUSD: svc.costUSD ?? null,
          tokens: svc.tokens ?? null,
          diff,
        },
      ];
    }),
  );

  return Object.fromEntries(entries);
}
