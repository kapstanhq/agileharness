// preserved-branches — the operator-facing view of run branches that are NOT on the merge train:
//   • failed/run/* — the safe-remove teardown PRESERVED these instead of deleting committed work
//     (a failure-classified run, or the boot reconciler reaping an orphan with un-integrated commits).
//   • run/* with NO worktree AND NO merge-queue entry — a detached settle-gap orphan (committed +
//     detached, but the merge enqueue never persisted).
// Without a surface these accumulate invisibly (only `git branch --list failed/*` shows them). This
// powers the /processes panels so the operator can SEE + DISCARD (or recover) them.
//
// THE HARD PART IS "WHAT DID THE RUN ACTUALLY CHANGE?" — and getting it wrong is what made the page
// cry wolf. A run branch is cut from `stage`, so it INHERITS every unreleased commit sitting on stage
// at that moment. Measuring it as `HEAD...branch` (the merge-base) therefore attributes that
// INHERITED code to the run: `failed/run/86689cd8` advertised "7 arquivos de código" when its own
// commit touched a single card .md — the 7 were stage's, and had long since reached main by surgical
// cherry-pick (new shas → no ancestry; rebased context → no patch-id match either). It sat in
// "Travados · precisa de intervenção" for a week, unclearable, holding nothing.
//
// After the fact neither topology nor content can separate the two — but git RECORDED the answer when
// the runner cut the branch: the ref's reflog carries `branch: Created from <sha>`, the exact base. It
// survives the rename to `failed/` and any later rewrite of stage's history. So the run's OWN work is
// `<cut-point>..<branch>`, full stop. (`resolveBase` falls back to the fork point when a reflog has
// expired — and says so, because an ESTIMATED base must never be allowed to claim a branch is safe.)
//
// SERVER-ONLY (git + repo + merge-queue singletons). The git/IO is injectable (DI) so every rule below
// is unit-tested.

import { defaultExec } from "./worktree";
import { getMergeQueue } from "./merge-queue";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { terminalStatusIds } from "@/lib/storymap/views";
import { findRepoRoot } from "@/lib/storymap/paths";
import { agentSessionIdFromBranch, resolveRunBase, runOwnWork, sessionIdFromBranch, type BaseProvenance } from "./run-base";
import { liveSessionIds, type LiveSessionIdsResult } from "./session-worktree";
import type { ExecFn } from "./worktree";
import { loadRunnerConfig } from "./config";

export type { BaseProvenance };

/** What a preserved branch actually holds — the verdict the panels render. */
export type PreservedVerdict =
  /** its work is already on HEAD (an ancestor, or its code is byte-identical there) — nothing to lose */
  | "integrated"
  /** the run's own commits touch NO code and its card is terminal/gone — a stale board transition */
  | "stale-board-data"
  /** board-data only, but the card is still live — worth a look, nothing is blocked */
  | "live-board-data"
  /** a `conflicted/*` snapshot whose card already reached terminal — the train re-drove the conflict and
   *  landed a (possibly different) solution, so this is a losing attempt, not orphaned work */
  | "superseded-by-redrive"
  /** the run's own commits carry CODE that is not on HEAD — the ONLY thing that is truly stuck */
  | "unintegrated-code"
  /** we could not establish what the run changed — fail CLOSED (ask a human), never assume it is safe */
  | "unknown";

/** One preserved/orphan run OR session branch, with the card context + a safe-to-discard verdict. */
export interface PreservedBranch {
  branch: string; // `[failed/|conflicted/]{run,agent}/<id>`
  sessionId: string;
  kind: "failed" | "conflicted" | "orphan";
  /** WS-1: `agent/*` (an agent SESSION's branch) vs `run/*` (a headless run's). Same verdict rules, same
   *  fail-closed GC — this only tells the operator WHO left it, and lets the live-session filter find it. */
  origin: "run" | "session";
  board: string | null;
  cardId: string | null;
  cardTitle: string | null;
  cardStatus: string | null;
  subject: string; // tip commit subject (what the run was doing)
  ageRelative: string; // e.g. "2 days ago"
  /** commits the RUN itself made (above its cut point) — never the stage history it inherited */
  ownCommits: number;
  /** files those commits touched */
  filesChanged: number;
  /** any `packages/**` file among them → real product code at stake */
  touchesCode: boolean;
  verdict: PreservedVerdict;
  baseProvenance: BaseProvenance;
  /** SAFE to discard (nothing un-integrated would be lost) */
  superseded: boolean;
  /** TRAVADO — a human must act. The attention panel shows these and NOTHING else. */
  needsAttention: boolean;
  /** one line answering "por que estou vendo isto?" */
  reason: string;
  /** the git command to recover the work when NOT superseded (recovery is judgment, not automation). */
  recoverHint: string;
}

/**
 * PURE: what does this branch hold?
 *
 * `codeIdenticalToHead` is the cherry-pick escape hatch: a run's code that reached main through a
 * SURGICAL cherry-pick gets a new sha (no ancestry) and a new patch-id (rebased context), so both
 * topology and `git cherry` call it un-integrated — while the content sits right there in HEAD, with
 * nothing to recover. Content is the arbiter of last resort, and it can only ever ACQUIT.
 */
export function verdictFor(facts: {
  ancestorOfHead: boolean;
  /** null = the run's base could not be established → we know nothing → fail closed */
  ownCommits: number | null;
  touchesCode: boolean;
  codeIdenticalToHead: boolean;
  cardExists: boolean;
  cardTerminal: boolean;
  /** a `conflicted/*` branch — the merge train ALWAYS re-drives a conflict (re-runs the generating
   *  skill against updated main), so a conflicted snapshot of a finished card is a losing attempt. */
  redriven: boolean;
}): PreservedVerdict {
  if (facts.ancestorOfHead) return "integrated";
  if (facts.ownCommits == null) return "unknown";
  if (facts.ownCommits === 0) return "integrated"; // the run committed nothing of its own
  if (!facts.touchesCode) return facts.cardTerminal || !facts.cardExists ? "stale-board-data" : "live-board-data";
  if (facts.codeIdenticalToHead) return "integrated";
  // Has its own code, not byte-identical on HEAD:
  if (facts.redriven && (facts.cardTerminal || !facts.cardExists)) return "superseded-by-redrive";
  return "unintegrated-code";
}

/** Safe to discard — nothing un-integrated would be lost. */
export function isSuperseded(verdict: PreservedVerdict): boolean {
  return verdict === "integrated" || verdict === "stale-board-data" || verdict === "superseded-by-redrive";
}

/**
 * TRAVADO — this branch is holding real work hostage and only a human can resolve it.
 *
 * Deliberately NOT "everything that isn't superseded":
 *  - a live-board-data branch is a curiosity, not a blockage;
 *  - an ESTIMATED base (expired reflog) cannot PROVE its inherited code is un-integrated — shouting
 *    "intervenção!" on a guess is exactly the noise that teaches an operator to ignore the panel;
 *  - a `conflicted/*` branch NEVER alarms here: the conflict is surfaced by its own merge-queue entry
 *    (the blocked-train row), and the branch itself is a snapshot the train re-drives.
 *  - a branch of a CONCLUDED card (`cardTerminal`) NEVER alarms: the card already shipped — the WINNING
 *    code is in main, via a DIFFERENT run — so this `failed/*` snapshot is a non-winning ATTEMPT, not a
 *    blockage. It lands in the archive's "revisar antes de descartar" bucket (its own code, off main, is
 *    still PRESERVED — branch-gc's keep-unmerged-code guard refuses to delete a code branch whose content
 *    isn't provably in main — so nothing is lost). Before this, a failed run of a shipped card sat in
 *    "Travados · precisam de intervenção" crying "recuperar ou descartar" while the feature was already in
 *    production (2026-07-23, acme/story-tlz0dt, `concluida`) — the exact false alarm this rule removes.
 *    (A `conflicted/*` of a terminal card was already handled — `superseded-by-redrive`; this generalizes
 *    the "the card is done, nothing is stuck" principle to the `failed/*` snapshots too.)
 * All of them land in the archive with their verdict spelled out — discardable, inspectable, unalarming.
 * `unknown` DOES escalate — not knowing is a different thing from knowing it is fine.
 */
export function needsAttention(
  verdict: PreservedVerdict,
  provenance: BaseProvenance,
  redriven = false,
  cardTerminal = false,
): boolean {
  if (verdict === "unknown") return true;
  if (redriven) return false;
  if (cardTerminal) return false; // a shipped card has no blockage — its leftover run branches are archaeology
  return verdict === "unintegrated-code" && provenance === "reflog";
}

/** The row's human sentence — why the operator is seeing it. */
export function reasonFor(verdict: PreservedVerdict, provenance: BaseProvenance, codeFiles: number): string {
  switch (verdict) {
    case "integrated":
      return "o trabalho do run já está em main — nada a recuperar";
    case "stale-board-data":
      return "só board-data, e o card já concluiu — transição obsoleta";
    case "live-board-data":
      return "só board-data de um card ainda vivo — vale um olhar, nada travado";
    case "superseded-by-redrive":
      return "conflito re-dirigido pelo train e o card já concluiu — snapshot da tentativa perdedora";
    case "unintegrated-code":
      return provenance === "reflog"
        ? `${codeFiles} arquivo(s) de código do run fora de main — recuperar ou descartar`
        : "código não integrado, mas a base do run é ESTIMADA (reflog expirou) — pode ser herança do stage";
    case "unknown":
      return "não consegui determinar o que este run mudou — confira antes de descartar";
  }
}

/** Derive the board/cardId a branch belongs to from the FIRST card file it touches. */
function cardFromFiles(files: string[]): { board: string | null; cardId: string | null } {
  for (const f of files) {
    const m = f.match(/^storymap\/boards\/([^/]+)\/cards\/(.+)\.md$/);
    if (m) return { board: m[1], cardId: m[2] };
  }
  return { board: null, cardId: null };
}

export interface PreservedBranchesDeps {
  exec: ExecFn;
  repoRoot: string;
  liveRunIds: () => Promise<string[]>;
  /**
   * WS-1/G7 — the sessionIds of agent sessions whose worktree is ALIVE (heartbeat fresh). Their `agent/<id>`
   * branch is IN USE: the session is committing onto it right now and has not submitted yet, so it has no
   * merge-queue entry and `liveRunIds` cannot see it. Without this it would look exactly like a settle-gap
   * ORPHAN — and the GC would eventually harvest a working agent's branch. Absent ⇒ no live sessions known,
   * which is safe here only because a session branch with real code is ALSO protected by the fail-closed
   * code guard downstream; supplying it is what keeps a live session's tree out of the panel entirely.
   */
  /** WS-1/G7 — resultado DISCRIMINADO de propósito: um registro ilegível não pode virar "nenhuma sessão
   *  viva" (o `[]` mudo que varria a frota inteira). Ver liveSessionIds (session-worktree.ts). */
  liveSessionIds?: () => Promise<LiveSessionIdsResult>;
  cardStatus: (
    board: string,
    cardId: string,
  ) => Promise<{ status: string | null; title: string | null; terminal: boolean } | null>;
  /** the integration branch runs are cut from (staged release); absent → the fork point falls back to HEAD. */
  stageBranch?: string;
}

/**
 * Classify ONE preserved branch — the single verdict the /processes panel AND the branch GC both read.
 * Pulls the run's base + own work from the shared `run-base` primitive (never `HEAD...branch`), so the
 * stage code a run inherited is never mistaken for the run's own. Returns null when the branch is not
 * ours to touch (a foreign ref name, or a live orphan still pending integration).
 */
export async function classifyPreservedBranch(
  deps: PreservedBranchesDeps,
  branch: string,
  live: Set<string>,
): Promise<PreservedBranch | null> {
  const q = (s: string) => JSON.stringify(s);
  const run = async (cmd: string): Promise<{ ok: boolean; stdout: string }> => {
    try {
      const { stdout } = await deps.exec(cmd, { cwd: deps.repoRoot, timeout: 30_000 });
      return { ok: true, stdout: String(stdout) };
    } catch {
      return { ok: false, stdout: "" };
    }
  };

  const kind: PreservedBranch["kind"] = branch.startsWith("failed/")
    ? "failed"
    : branch.startsWith("conflicted/")
      ? "conflicted"
      : "orphan";
  const sessionId = sessionIdFromBranch(branch);
  if (!sessionId) return null; // not a run/session branch we own — it never reaches a git command line
  const origin: PreservedBranch["origin"] = agentSessionIdFromBranch(branch) ? "session" : "run";
  // A bare `run/<id>` on the train, or a bare `agent/<id>` whose session is alive, is NOT an orphan — it is
  // work in progress. `live` unions both (the queue's runIds + the session registry's live ids), so one
  // membership test covers both populations. (G7: this is the check that keeps a working agent's branch out
  // of the panel AND out of the GC's hands.)
  if (kind === "orphan" && live.has(sessionId)) return null;

  const log = (await run(`git log -1 --format='%s|%cr' ${q(branch)}`)).stdout.trim();
  const [subject = "", ageRelative = ""] = log.split("|");

  // `--is-ancestor` exits 0 when it IS an ancestor → a throw means "not an ancestor", not an error.
  let ancestorOfHead = false;
  try {
    await deps.exec(`git merge-base --is-ancestor ${q(branch)} HEAD`, { cwd: deps.repoRoot, timeout: 15_000 });
    ancestorOfHead = true;
  } catch {
    ancestorOfHead = false;
  }

  const { base, provenance } = await resolveRunBase(deps.exec, deps.repoRoot, branch, {
    stageBranch: deps.stageBranch ?? null,
  });
  const work = await runOwnWork(deps.exec, deps.repoRoot, branch, base);
  const ownCommits = work?.commits ?? null;
  const files = work?.files ?? [];

  const codeFiles = files.filter((f) => f.startsWith("packages/"));
  const touchesCode = codeFiles.length > 0;

  // `git diff --quiet` exits 1 when the files DIFFER → a throw here is a real answer, not a failure.
  let codeIdenticalToHead = false;
  if (touchesCode) {
    const paths = codeFiles.map(q).join(" ");
    try {
      await deps.exec(`git diff --quiet ${q(branch)} HEAD -- ${paths}`, { cwd: deps.repoRoot, timeout: 30_000 });
      codeIdenticalToHead = true;
    } catch {
      codeIdenticalToHead = false;
    }
  }

  const { board, cardId } = cardFromFiles(files);
  const card = board && cardId ? await deps.cardStatus(board, cardId).catch(() => null) : null;
  const redriven = kind === "conflicted";
  const verdict = verdictFor({
    ancestorOfHead,
    ownCommits,
    touchesCode,
    codeIdenticalToHead,
    cardExists: !!card,
    cardTerminal: !!card?.terminal,
    redriven,
  });

  return {
    branch,
    sessionId,
    kind,
    origin,
    board,
    cardId,
    cardTitle: card?.title ?? null,
    cardStatus: card?.status ?? null,
    subject,
    ageRelative,
    ownCommits: ownCommits ?? 0,
    filesChanged: files.length,
    touchesCode,
    verdict,
    baseProvenance: provenance,
    superseded: isSuperseded(verdict),
    // A concluded/absent card has no blockage: a `failed/*` snapshot of a card that already shipped is a
    // non-winning attempt, not an intervention — de-alarm it (it stays in the archive's review bucket).
    needsAttention: needsAttention(verdict, provenance, redriven, !!card?.terminal),
    reason: reasonFor(verdict, provenance, codeFiles.length),
    recoverHint: base
      ? `git cherry-pick ${base}..${branch}  # ou: git diff ${base}..${branch}`
      : `git diff HEAD...${branch}`,
  };
}

/**
 * List every preserved/orphan branch of the MACHINE — `[failed/|conflicted/]{run,agent}/*` plus bare orphans
 * — with its verdict. WS-1: the `agent/*` namespace is swept by the SAME rules as `run/*` (fail-closed: code
 * that is not provably integrated is NEVER harvested); a session branch is not special, it is just younger
 * and has a live owner, which the `live` set below accounts for.
 */
export async function listPreservedRunBranches(deps: PreservedBranchesDeps): Promise<PreservedBranch[]> {
  const refs = await deps
    .exec(
      "git for-each-ref --format='%(refname:short)' " +
        "refs/heads/failed/run/ refs/heads/conflicted/run/ refs/heads/run/ " +
        "refs/heads/failed/agent/ refs/heads/conflicted/agent/ refs/heads/agent/",
      {
        cwd: deps.repoRoot,
        timeout: 30_000,
      },
    )
    .catch(() => ({ stdout: "" }));
  const branches = String(refs.stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!branches.length) return [];

  // NOT an orphan: a `run/<id>` still on the merge train, or an `agent/<id>` whose session is alive and
  // still working in its tree (G7). Both are "someone owns this" — one union, one membership test below.
  const live = new Set(await deps.liveRunIds().catch(() => []));
  const sessions = (await deps.liveSessionIds?.().catch((err) => ({ ok: false, error: String(err) }) as const)) ?? {
    ok: true as const,
    ids: [] as string[],
  };
  if (sessions.ok) {
    for (const id of sessions.ids) live.add(id);
  } else {
    // Registro ILEGÍVEL ⇒ não dá para saber de quem é cada `agent/<id>`, e "não sei" não pode virar "órfão"
    // (a classificação alimenta o GC de branches). Trata TODA branch de sessão como VIVA neste passe: o
    // custo é adiar a limpeza de uma branch morta; o custo do contrário é apagar a única cópia do trabalho
    // de uma sessão viva. Mesma doutrina do reconciler de boot — ver liveSessionIds (session-worktree.ts).
    console.warn(`[preserved-branches] registro de sessões ilegível (${sessions.error}) — toda branch agent/* tratada como VIVA neste passe.`);
    for (const branch of branches) {
      const id = agentSessionIdFromBranch(branch);
      if (id) live.add(id);
    }
  }

  const out: PreservedBranch[] = [];
  for (const branch of branches) {
    const b = await classifyPreservedBranch(deps, branch, live).catch(() => null);
    if (b) out.push(b);
  }
  // Order: the ones that need a human first, then the merely-unsuperseded, then the rest.
  return out.sort(
    (a, b) => Number(b.needsAttention) - Number(a.needsAttention) || Number(a.superseded) - Number(b.superseded),
  );
}

/** Production wiring: real git + the merge-queue's live run ids + the card status from the boards. */
export function defaultPreservedBranchesDeps(): PreservedBranchesDeps {
  return {
    exec: defaultExec,
    repoRoot: findRepoRoot(),
    liveRunIds: () => getMergeQueue().liveRunIds(),
    liveSessionIds: () => liveSessionIds(), // WS-1/G7: a live agent session's branch is never an orphan
    // o branch de integração é DECLARADO (`autorun.staging.branch`); fixar o literal aqui
  // sobrescrevia a declaração do repositório — o train já lia o declarado, as réguas de ciclo de vida não
    stageBranch: loadRunnerConfig().autorun.staging?.branch ?? "stage",
    cardStatus: async (board, cardId) => {
      const cards = await readCards(board).catch(() => []);
      const card = cards.find((c) => c.id === cardId);
      if (!card) return null;
      const config = await readBoardConfig(board).catch(() => null);
      const terminal = config ? terminalStatusIds(config).has(card.status ?? "") : false;
      return { status: card.status, title: card.title, terminal };
    },
  };
}
