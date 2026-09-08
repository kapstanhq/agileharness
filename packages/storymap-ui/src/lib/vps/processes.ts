// The unified "running services" data layer for the /processes page.
//
// It bridges the TWO disjoint worlds of Claude on this box:
//   1. Headless autorun runs (`claude -p`) — card-linked (board/cardId/sessionId), tracked
//      live in the runner registry + durably in the journal. Not a tmux session, so not
//      directly attachable; resumable via `claude --resume <sessionId>` in a terminal.
//   2. tmux sessions (`claude` master, `shell`, ad-hoc, and the `card-<board>__<cardId>`
//      sessions we materialize to resume a run) — attachable in the web terminal, but the
//      only card link is encoded in the session NAME.
// listRunningServices() folds both into one RunningService[] (see ./types), resolving card
// titles from the boards and pairing a runner run with its materialized terminal session.
//
// SERVER-ONLY (reads the registry/journal singletons + spawns tmux/ps). Never import from a
// client component — the /api/processes route and server actions are the entry points.

import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { getRunnerJournal } from "@/lib/storymap/runner/journal";
import { allSessions, type AgentSession } from "@/lib/storymap/runner/session-worktree";
import { listBoards, readCards } from "@/lib/storymap/repo";
import { listPaneOwners, listProcesses, listSessions } from "./tmux";
import { attributeClaudeProcesses } from "./process-attribution";
import { laneOf, type BoardSource, type OriginKind, type RunningService, type ServiceKind, type ServiceStatus } from "./types";
import { deriveActivity } from "../terminal/phrase";
import { loadPrefs, type TerminalPrefs } from "../terminal/prefs-store";

const TRIGGER_LABEL: Record<string, string> = { "harness-sync-card": "sincronizar" };
const prettyTrigger = (t: string): string => TRIGGER_LABEL[t] ?? t;

/** The tmux session name for a card's resume terminal. `__` splits board↔card (slugs have
 * no `_`, so the split is unambiguous even when both contain hyphens). Exported so the
 * resume action and the classifier agree on one convention. */
export function cardSessionName(board: string, cardId: string): string {
  return `card-${board}__${cardId}`;
}

/**
 * `tmux session → board` para as sessões da FROTA (`worktree_open` / `claude_new`).
 *
 * O nome de um tmux só carrega board na convenção `card-<board>__<cardId>` (acima). Uma sessão da
 * frota chama-se `agent-<id>` — o board dela existe, mas mora no REGISTRO, não no nome. Sem esta
 * junção a linha chega à home sem board e some de todos os recortes, apesar de ter sido aberta
 * PARA um board.
 *
 * Só entra quem tem os dois campos: sessão sem board (self-dev, D2) não vira chave vazia.
 * Pura — testada direto.
 */
export function fleetBoardByTmux(
  sessions: ReadonlyArray<Pick<AgentSession, "tmuxSession" | "board">>,
): Map<string, string> {
  const byTmux = new Map<string, string>();
  for (const s of sessions) if (s.tmuxSession && s.board) byTmux.set(s.tmuxSession, s.board);
  return byTmux;
}

/**
 * DE QUEM É este terminal — o board da linha e a ORIGEM dessa atribuição, em uma regra só.
 *
 * Três fontes, nesta ordem, e a ordem É a decisão de desenho:
 *   1. `card`   — o nome carrega o board (`card-<board>__<cardId>`, classifyTmux)
 *   2. `fleet`  — o registro da frota sabe (worktree_open / claude_new)
 *   3. `manual` — o operador vinculou à mão (terminal-prefs)
 *
 * **A ESTRUTURA VENCE A PREFERÊNCIA, e o manual só preenche o VAZIO.** Um terminal de
 * `card-acme__story-x` reapontado para `orbit` faria a home do orbit listar o terminal de um
 * card do acme — o recorte por board deixaria de significar o que promete. Por isso a UI mostra o
 * board travado (com a origem) em vez de um seletor, e a rota PATCH recusa a troca fail-closed.
 *
 * Note que isto é o INVERSO da regra do apelido (`operatorLabel`, logo abaixo), onde o operador
 * vence o rótulo derivado — de propósito: apelido é display puro, board é estrutura. Não "corrija"
 * a assimetria.
 *
 * Pura — testada direto.
 */
export function boardForTmux(
  name: string,
  derivedBoard: string | undefined,
  fleetBoards: ReadonlyMap<string, string>,
  prefs: TerminalPrefs,
): { board?: string; boardSource?: BoardSource } {
  if (derivedBoard) return { board: derivedBoard, boardSource: "card" };
  const fleet = fleetBoards.get(name);
  if (fleet) return { board: fleet, boardSource: "fleet" };
  const manual = prefs[name]?.board?.trim();
  if (manual) return { board: manual, boardSource: "manual" };
  return {};
}

/** Classify a tmux session by name → kind + label + (for card sessions) the card link. Exported so
 *  the terminal attention watcher labels a session EXACTLY like this list does (one naming rule). */
export function classifyTmux(name: string): { kind: ServiceKind; label: string; board?: string; cardId?: string } {
  // The master session is `claude` OR `claude-<who>` (e.g. `claude-jonatas`) — the box's real master
  // carries a suffix, and matching only the bare `claude` mislabeled it as an ad-hoc human shell.
  if (name === "claude" || name.startsWith("claude-")) return { kind: "tmux-master", label: "Claude master (interativo)" };
  if (name === "shell") return { kind: "tmux-shell", label: "Shell (bash)" };
  const m = name.match(/^card-(.+?)__(.+)$/);
  if (m) return { kind: "tmux-card", label: `Terminal · ${m[2]}`, board: m[1], cardId: m[2] };
  // F2 — terminais criados pelo Jido via term_new (prefixo cop-).
  if (name.startsWith("cop-")) return { kind: "tmux-copilot", label: `Copiloto · ${name.slice(4)}` };
  return { kind: "tmux-adhoc", label: name };
}

/**
 * The label the operator SEES for a terminal: their explicit alias (renamed on the /terminal page,
 * persisted per tmux NAME in terminal-prefs) is the REAL name and wins over the name-derived
 * `classifyTmux` label. Without an alias the derived label stands. This is the SAME precedence the
 * terminal picker applies (enrich.ts `deriveLabel`, whose first branch is the alias) — so the home
 * Terminais panel, /processes and the picker all show ONE name instead of the raw tmux name /
 * generic "Shell (bash)" the operator never chose. Pure so it is unit-tested directly.
 */
export function operatorLabel(
  derived: string,
  tmuxSession: string | undefined,
  prefs: TerminalPrefs,
): string {
  const alias = tmuxSession ? prefs[tmuxSession]?.alias?.trim() : undefined;
  return alias || derived;
}

const STATUS_RANK: Record<ServiceStatus, number> = {
  running: 0,
  interrupted: 1,
  failed: 2,
  idle: 3,
  done: 4,
};

/** Map the durable journal origin → the operator-facing OriginKind shown/filtered on /processes. */
const JOURNAL_ORIGIN: Record<"autorun" | "manual" | "conflict-redrive", OriginKind> = {
  autorun: "kanban",
  manual: "manual",
  "conflict-redrive": "merge",
};

/** Origin for a STANDALONE tmux session (one NOT paired with a runner run): a hand-opened
 *  master/shell/card terminal reads as "manual"; any other ad-hoc session as "externo". */
function tmuxOrigin(kind: ServiceKind): OriginKind {
  return kind === "tmux-adhoc" ? "externo" : "manual";
}

/** The kinds whose terminal is a Claude AGENT (vs a plain shell) — drives the `agent` flag and the
 *  home "Claude" badge. tmux-shell/tmux-adhoc are NOT agents by name, but are promoted in step (5)
 *  when a live `claude` is found inside their process tree. */
const CLAUDE_KINDS: ReadonlySet<ServiceKind> = new Set<ServiceKind>([
  "runner-run",
  "tmux-master",
  "tmux-card",
  "tmux-copilot",
  "claude-external",
  "helper-agent",
]);
export const isAgentKind = (kind: ServiceKind): boolean => CLAUDE_KINDS.has(kind);

/**
 * Every running (or recently-interrupted/failed) Claude service on the box, newest-first
 * within each status bucket (running → interrupted → failed → idle). Best-effort: a tmux
 * or ps failure degrades to fewer rows, never throws.
 */
export async function listRunningServices(): Promise<RunningService[]> {
  const registry = getRunnerRegistry();
  const snap = registry.snapshot();
  const journal = getRunnerJournal();
  const prefs = loadPrefs(); // operator terminal aliases — best-effort, `{}` on missing/corrupt file

  const [journalEntries, sessions, boards, fleet] = await Promise.all([
    journal.list().catch(() => []),
    listSessions().catch(() => []),
    listBoards().catch(() => [] as Array<{ id: string; name: string }>),
    // O board de uma sessão da frota — best-effort como todo o resto: registro ilegível degrada uma
    // coluna, nunca derruba a lista.
    allSessions().catch(() => [] as AgentSession[]),
  ]);
  const fleetBoards = fleetBoardByTmux(fleet);

  // Resolve card titles once across all boards (board/cardId → title).
  const titles = new Map<string, string>();
  await Promise.all(
    boards.map(async (b) => {
      for (const c of await readCards(b.id).catch(() => [])) titles.set(`${b.id}/${c.id}`, c.title);
    }),
  );
  const titleOf = (board?: string, cardId?: string) =>
    board && cardId ? titles.get(`${board}/${cardId}`) : undefined;

  // Origin lens: the run's durable journal entry carries WHO started it (autorun/manual/
  // conflict-redrive). Index it by card key so the live/failed rows can read it back — the
  // ephemeral RunnerRun itself doesn't store origin. Default to "kanban" (the autorun cascade
  // is the overwhelming common case for a card-linked run).
  const originByKey = new Map<string, OriginKind>();
  for (const e of journalEntries) {
    if (e.origin) originByKey.set(`${e.board}/${e.cardId}`, JOURNAL_ORIGIN[e.origin]);
  }

  const services: RunningService[] = [];
  const seenRunKeys = new Set<string>(); // `${board}/${cardId}` already represented by a run row

  // 1) Live runner runs.
  for (const r of snap.running) {
    const key = `${r.board}/${r.cardId}`;
    seenRunKeys.add(key);
    const usage = r.usage ?? registry.getUsage(r.board, r.cardId);
    services.push({
      id: `run:${key}`,
      kind: "runner-run",
      lane: laneOf("runner-run"),
      label: `${prettyTrigger(r.trigger)} · ${titleOf(r.board, r.cardId) ?? r.cardId}`,
      status: "running",
      origin: originByKey.get(key) ?? "kanban",
      // Um run é card-linked por construção — board estrutural, nunca escolhível.
      board: r.board,
      boardSource: "card",
      cardId: r.cardId,
      cardTitle: titleOf(r.board, r.cardId),
      trigger: r.trigger,
      sessionId: r.sessionId,
      attachable: true,
      agent: true,
      startedAt: r.startedAt,
      costUSD: usage?.costUSD ?? null,
      tokens: usage?.tokens ?? null,
    });
  }

  // 2) Recently-failed runs (registry, 15-min TTL).
  for (const f of snap.failures) {
    const key = `${f.board}/${f.cardId}`;
    if (seenRunKeys.has(key)) continue;
    seenRunKeys.add(key);
    const sessionId = registry.lastSessionId(f.board, f.cardId);
    services.push({
      id: `run:${key}`,
      kind: "runner-run",
      lane: laneOf("runner-run"),
      label: `${prettyTrigger(f.trigger)} · ${titleOf(f.board, f.cardId) ?? f.cardId}`,
      status: "failed",
      origin: originByKey.get(key) ?? "kanban",
      board: f.board,
      boardSource: "card",
      cardId: f.cardId,
      cardTitle: titleOf(f.board, f.cardId),
      trigger: f.trigger,
      sessionId,
      attachable: !!sessionId,
      agent: true,
      startedAt: null,
      outcome: f.reason,
      detail: f.detail,
      costUSD: registry.getUsage(f.board, f.cardId)?.costUSD ?? null,
      tokens: registry.getUsage(f.board, f.cardId)?.tokens ?? null,
    });
  }

  // 3) Journal entries still "running" but with NO live run = interrupted by a crash/restart
  //    → resumable. (Clean finishes were flipped to "done"; done entries are history, omitted.)
  //    story-9s52tu HALF B (MEDIUM #3): distinguish a max-turns RESUMABLE entry (`resumable` +
  //    outcome "max-turns") — a run that settled cleanly at its turn budget and is AWAITING resume
  //    (the in-process resume couldn't claim a slot yet; boot recovery / the next settle resumes it
  //    with the counter intact) — from a genuine CRASH interrupt. Same "interrupted" bucket (both are
  //    resumable + have no live process) but a distinct detail so the operator reads "aguardando resume"
  //    vs "interrompido", and never mistakes a deliberate turn-budget pause for a crash.
  for (const e of journalEntries) {
    if (e.status !== "running") continue;
    const key = `${e.board}/${e.cardId}`;
    if (seenRunKeys.has(key)) continue;
    seenRunKeys.add(key);
    const awaitingResume = e.resumable === true && e.outcome === "max-turns";
    services.push({
      id: `run:${key}`,
      kind: "runner-run",
      lane: laneOf("runner-run"),
      label: `${prettyTrigger(e.trigger)} · ${titleOf(e.board, e.cardId) ?? e.cardId}`,
      status: "interrupted",
      origin: e.origin ? JOURNAL_ORIGIN[e.origin] : "kanban",
      board: e.board,
      boardSource: "card",
      cardId: e.cardId,
      cardTitle: titleOf(e.board, e.cardId),
      trigger: e.trigger,
      sessionId: e.sessionId,
      attachable: true,
      agent: true,
      startedAt: e.startedAt,
      pid: e.pid,
      detail: awaitingResume
        ? `max-turns — aguardando resume${e.maxTurnsResumeCount ? ` (${e.maxTurnsResumeCount}×)` : ""} (\`claude --resume\`)`
        : "interrompido (sem processo vivo) — retomável",
    });
  }

  // 4) tmux sessions (attachable terminals). A `card-…` session enriches its run row (gives
  //    it an attachable terminal) instead of duplicating it; everything else is its own row.
  //    Status starts at `idle` and is promoted to `running` in (5) ONLY if a live agent is found
  //    INSIDE the session's process tree — a terminal someone left attached at a bash prompt is
  //    not work, and an unattached session with a live agent IS.
  for (const s of sessions) {
    const cls = classifyTmux(s.name);
    if (cls.kind === "tmux-card" && cls.board && cls.cardId) {
      const existing = services.find((x) => x.id === `run:${cls.board}/${cls.cardId}`);
      if (existing) {
        existing.tmuxSession = s.name;
        existing.attached = s.attached;
        continue;
      }
    }
    // O NOME manda quando ele carrega o board (`card-…`); senão vale o que a frota sabe daquela
    // sessão; e só então o vínculo que o operador fez à mão. Só o board é adotado, nunca o cardId:
    // um vínculo de card muda rótulo, link e o tail de console da linha, e a pergunta aqui é apenas
    // "de quem é este terminal". Ver boardForTmux para o porquê da ordem.
    const attributed = boardForTmux(s.name, cls.board, fleetBoards, prefs);
    services.push({
      id: `tmux:${s.name}`,
      kind: cls.kind,
      lane: laneOf(cls.kind),
      label: cls.label,
      status: "idle",
      origin: tmuxOrigin(cls.kind),
      board: attributed.board,
      boardSource: attributed.boardSource,
      cardId: cls.cardId,
      cardTitle: titleOf(cls.board, cls.cardId),
      tmuxSession: s.name,
      attachable: true,
      attached: s.attached,
      startedAt: s.createdAt,
      agent: isAgentKind(cls.kind),
      runtimeCmd: s.command || undefined,
      activity: deriveActivity(s.paneTitle, s.command, s.path, s.name) || undefined,
    });
  }

  // 5) The box's REAL agents. `attributeClaudeProcesses` decides two things a command-line grep
  //    never could: WHO IS AN AGENT (the kernel's `comm`, so a bash that merely mentions claude —
  //    or any Bash tool call sourcing `/root/.claude/…` — is not one) and WHO OWNS IT (the process
  //    tree: a live run's session uuid → that run's row; a tmux pane ancestor → that session's row;
  //    a claude ancestor → folded into the root agent). Owned agents only ANNOTATE their row
  //    (pid/uptime/liveness) — never a duplicate. What is left is a claude nobody in the system
  //    started (SSH/by hand): one "externo" row, inspectable and killable, but NOT pipeline work.
  //    Best-effort: a ps/tmux failure degrades to no annotations, never throws.
  try {
    const [procs, panes] = await Promise.all([listProcesses(), listPaneOwners()]);
    const knownRunSessionIds = new Set(
      services.map((s) => s.sessionId?.toLowerCase()).filter((x): x is string => !!x),
    );
    const agents = attributeClaudeProcesses({ procs, panes, knownRunSessionIds });
    const byRunSession = new Map(
      services.filter((s) => s.sessionId).map((s) => [s.sessionId!.toLowerCase(), s]),
    );
    const byTmuxSession = new Map(services.filter((s) => s.tmuxSession).map((s) => [s.tmuxSession!, s]));

    for (const { proc, owner, headless, childPids } of agents) {
      const row =
        owner.kind === "run"
          ? byRunSession.get(owner.sessionId)
          : owner.kind === "tmux"
            ? byTmuxSession.get(owner.session)
            : undefined;

      if (row) {
        if (row.pid == null) row.pid = proc.pid;
        if (!row.uptimeText && row.startedAt == null) row.uptimeText = proc.etime;
        // A terminal that HOSTS a live agent is working, attached or not — and IS a Claude terminal
        // now, even if its NAME classified it as an ad-hoc shell (someone launched claude into it).
        if (row.kind.startsWith("tmux-")) {
          row.status = "running";
          row.agent = true;
          if (!row.detail) {
            row.detail = childPids.length
              ? `Claude vivo (${childPids.length + 1} processos) · ${proc.etime}`
              : `Claude vivo · ${proc.etime}`;
          }
        }
        continue;
      }

      services.push({
        id: `proc:${proc.pid}`,
        kind: "claude-external",
        lane: laneOf("claude-external"),
        label: headless ? "claude solto (headless)" : "claude solto (interativo)",
        status: "running",
        origin: "externo",
        attachable: false,
        agent: true,
        pid: proc.pid,
        uptimeText: proc.etime,
        detail: proc.args.length > 120 ? `${proc.args.slice(0, 120)}…` : proc.args,
      });
    }
  } catch {
    /* ps/tmux unavailable → no annotations, no external rows (best-effort) */
  }

  // Honor the operator's chosen terminal name everywhere a tmux session surfaces (home Terminais,
  // /processes list + detail): a session the operator renamed on the /terminal page must show that
  // real name, not the raw tmux name or the generic classifyTmux label. Covers both standalone tmux
  // rows and a run row that adopted a card terminal (both carry `tmuxSession`).
  for (const s of services) {
    if (!s.tmuxSession) continue;
    // O APELIDO viaja separado do rótulo, e não é redundância: `label` é o que se MOSTRA (apelido ou,
    // na falta dele, o derivado), enquanto o campo de renomear precisa saber se existe um apelido de
    // verdade. Pré-preenchendo com `label`, salvar congelava o rótulo derivado como apelido manual —
    // e o nome parava de acompanhar o que a sessão faz.
    const alias = prefs[s.tmuxSession]?.alias?.trim();
    if (alias) s.alias = alias;
    s.label = operatorLabel(s.label, s.tmuxSession, prefs);
  }

  services.sort(
    (a, z) => STATUS_RANK[a.status] - STATUS_RANK[z.status] || (z.startedAt ?? 0) - (a.startedAt ?? 0),
  );
  return services;
}

/** One service by its id (`run:<board>/<cardId>` or `tmux:<name>`), or null. */
export async function getRunningService(id: string): Promise<RunningService | null> {
  return (await listRunningServices()).find((s) => s.id === id) ?? null;
}
