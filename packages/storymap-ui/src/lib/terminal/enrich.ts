// The JOIN behind GET /api/terminal/sessions — one enriched object per LIVE tmux session, keyed on
// the tmux NAME (the `?b=` identity), so non-card sessions (shell, master, cop-*, agent-*, adhoc)
// degrade gracefully. Bridges four sources the terminal page can't reach on its own:
//   • lib/terminal/tmux  listSessions()        → identity: name/attached/cwd/command/paneTitle
//   • lib/vps/processes  listRunningServices() → rich: friendly label, live "Claude vivo" detail,
//                                                 card link, cost/tokens, running/idle status
//   • runner sessions.json  allSessions()      → durable `task` for card-less fleet agents
//   • lib/terminal/git   branchAndDirty(cwd)   → the "⎇ branch ●" bar affordance
//   • lib/vps/kill-guard assessKill()          → the fail-closed `protected` verdict (DISPLAY only;
//                                                 the DELETE route re-derives it authoritatively)
//
// Server-only. Cost note: this fans out several tmux/ps spawns per call (listRunningServices and the
// kill-guard gather each probe the box independently). Acceptable for a single-operator tool polled
// ~4s; if session counts grow, share one process snapshot between them (RISK #7 in the build plan).

import { listSessions } from "./tmux";
import { intentionalTitle, shortPath, stripSpinner } from "./phrase";
import { branchAndDirty } from "./git";
import { loadPrefs } from "./prefs-store";
import { listRunningServices } from "@/lib/vps/processes";
import { gatherKillSnapshots, assessKill } from "@/lib/vps/kill-guard";
import { allSessions } from "@/lib/storymap/runner/session-worktree";
import type { BoardSource, RunningService } from "@/lib/vps/types";

export type PhraseSource = "pane_title" | "detail" | "task" | "command" | "none";

export interface EnrichedSession {
  /** tmux name = identity + `?b=` key (ALWAYS present) */
  name: string;
  /** operator display alias, or null */
  alias: string | null;
  pinned: boolean;

  attached: boolean;
  windows: number;
  createdAt: number | null;
  cwd: string;
  command: string;
  paneTitle: string;

  /** ServiceKind from the unified list, or null for a session ps-attribution never saw */
  kind: string | null;
  lane: string | null;
  /** friendly display label (see deriveLabel) */
  label: string;

  /** null for shell, master, cop-, adhoc, agent- sessions (no card) */
  card: { board: string; cardId: string; title: string | null } | null;

  /**
   * O board que este terminal serve, e de onde veio essa atribuição (ver `boardForTmux`). `null` =
   * sem board — um estado legítimo: o terminal segue nas telas da MÁQUINA (/processes, /terminal),
   * só não entra no recorte de nenhuma home.
   *
   * `boardSource` é o que diz se a página pode OFERECER a troca: `card`/`fleet` são estruturais
   * (travados), `manual` é do operador. A rota PATCH re-deriva isso e é quem realmente decide.
   */
  board: string | null;
  boardSource: BoardSource | null;

  status: "running" | "idle";
  /** "what it is doing" line (see derivePhrase) */
  phrase: string;
  phraseSource: PhraseSource;

  branch: string | null;
  dirty: boolean | null;

  /** cost only exists for card runner runs (registry usage); null otherwise */
  cost: { usd: number; tokens: number | null } | null;

  /** never-kill verdict — DISPLAY only; the DELETE route re-derives it */
  protected: boolean;
  protectReason: string;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Is `label` just the raw session name (i.e. classifyTmux had nothing better)? */
function isRawName(label: string | undefined, name: string): boolean {
  return !label || label === name;
}

export function deriveLabel(name: string, alias: string | null, svc: RunningService | undefined, task: string | undefined): string {
  if (alias) return alias;
  if (svc?.board && svc?.cardId && svc.cardTitle) return `${svc.cardId} · ${svc.cardTitle}`;
  if (svc && !isRawName(svc.label, name)) return svc.label;
  if (task) return `Agente · ${clip(task, 40)}`;
  // Nomes-crus convencionais viram rótulos legíveis (a interface chama a sessão tmux de "terminal").
  if (name === "shell") return "Terminal do servidor";
  return name;
}

export function derivePhrase(
  paneTitle: string,
  svc: RunningService | undefined,
  task: string | undefined,
  command: string,
  cwd: string,
  name: string,
): { phrase: string; source: PhraseSource } {
  if (intentionalTitle(paneTitle, command, name)) return { phrase: stripSpinner(paneTitle), source: "pane_title" };
  if (svc?.detail) return { phrase: svc.detail, source: "detail" };
  if (task) return { phrase: task, source: "task" };
  if (command) return { phrase: cwd ? `${command} · ${shortPath(cwd)}` : command, source: "command" };
  return { phrase: "", source: "none" };
}

export async function buildEnrichedSessions(): Promise<EnrichedSession[]> {
  const [tmuxSessions, services, agentSessions, killSnap] = await Promise.all([
    listSessions(),
    listRunningServices().catch(() => [] as RunningService[]),
    allSessions().catch(() => []),
    gatherKillSnapshots(),
  ]);
  const prefs = loadPrefs();

  const svcByTmux = new Map(services.filter((s) => s.tmuxSession).map((s) => [s.tmuxSession as string, s]));
  const taskByTmux = new Map(
    agentSessions.filter((s) => s.tmuxSession).map((s) => [s.tmuxSession as string, s.task]),
  );

  // Git per UNIQUE cwd (bounds the git spawns — many sessions share a cwd).
  const gitByCwd = new Map<string, { branch: string | null; dirty: boolean | null }>();
  await Promise.all(
    [...new Set(tmuxSessions.map((s) => s.path).filter(Boolean))].map(async (cwd) => {
      gitByCwd.set(cwd, await branchAndDirty(cwd));
    }),
  );

  return tmuxSessions.map((t) => {
    const svc = svcByTmux.get(t.name);
    const pref = prefs[t.name] ?? {};
    const alias = pref.alias ?? null;
    const task = taskByTmux.get(t.name);
    const git = gitByCwd.get(t.path) ?? { branch: null, dirty: null };
    const verdict = killSnap
      ? assessKill(t.name, killSnap)
      : { protected: true, reason: "estado indisponível — recusado por segurança" };

    const card =
      svc?.board && svc?.cardId ? { board: svc.board, cardId: svc.cardId, title: svc.cardTitle ?? null } : null;
    const { phrase, source } = derivePhrase(t.paneTitle, svc, task, t.command, t.path, t.name);

    return {
      name: t.name,
      alias,
      pinned: !!pref.pinned,
      attached: t.attached,
      windows: t.windows,
      createdAt: t.createdAt,
      cwd: t.path,
      command: t.command,
      paneTitle: t.paneTitle,
      kind: svc?.kind ?? null,
      lane: svc?.lane ?? null,
      label: deriveLabel(t.name, alias, svc, task),
      card,
      // Já resolvido (com a precedência card→frota→manual) em listRunningServices — esta camada só
      // o repassa. Uma sessão que a atribuição por ps nunca viu não tem svc e, portanto, board.
      board: svc?.board ?? null,
      boardSource: svc?.boardSource ?? null,
      status: svc?.status === "running" ? "running" : "idle",
      phrase,
      phraseSource: source,
      branch: git.branch,
      dirty: git.dirty,
      cost: svc && svc.costUSD != null ? { usd: svc.costUSD, tokens: svc.tokens ?? null } : null,
      protected: verdict.protected,
      protectReason: verdict.reason,
    };
  });
}
