// convergence — IS THIS DELTA ALREADY IN THAT TARGET? One canonical answer, measured by CONTENT.
//
// Every mechanism that "re-applies" or "checks whether it did the work" had grown its OWN ruler, and each
// broke differently under concurrency: the promotion replayed a commitRange against a main that already
// carried the code (it collided with itself); the C2 guard equated "this run wrote nothing" with "nothing
// was delivered" and deadlocked a card whose fix had landed in a PRIOR run; the branch-gc proved
// integration with `--is-ancestor` — blind to cherry-pick (new sha) — so it never harvested and the garbage
// became immortal. Three mechanisms, three rulers, one question: is the delta CONTAINED in the target?
//
// THE ASYMMETRY IS THE CONTRACT (the same philosophy documented at length in run-base.ts):
//   • `landed` is POSITIVE PROOF and is the ONLY verdict that authorizes ACTING — advancing a card,
//     stamping build evidence, skipping a respawn, harvesting a branch.
//   • `unknown` and `partial` NEVER authorize an advance nor a destructive action. Whoever ACCUSES needs
//     proof; whoever ACQUITS may err on the safe side. A false `landed` loses work; a false `absent` costs
//     one spawn or keeps one branch alive. The prices are not comparable, so the layers below only ever
//     move a verdict TOWARDS `landed` on evidence they can demonstrate.
//
// THE LAYERS (cheapest first, short-circuiting) — all preceded by "does this delta change ANY file?",
// because an empty range is an ancestor of everything and layer 1 would prove it `landed` vacuously:
//   1. ancestry      — `merge-base --is-ancestor head target`: the trivial case (the target descends from
//                      the delta's head).
//   2. patch-id      — cherry-pick-safe: `git patch-id --stable` over the range's OWN commits vs the
//                      target's commits since the merge-base. ALL contained ⇒ landed; SOME ⇒ `partial`
//                      (a real half-landing — never re-tested by layer 3, which could only acquit it);
//                      NONE ⇒ fall through (a squash changes every patch-id).
//   3. post-image    — the delta's FINAL content, compared in the delta's OWN pathspec (never the whole
//                      tree — any unrelated advance of the target would then read as a false `absent`).
//                      Identical ⇒ landed. This is what catches squash/reword/rebase, where both the sha
//                      and the patch-id changed but the content that matters is right there.
//   4. anything else — a git failure or a timeout is NOT an answer: `unknown` (never "absent").
//
// HONEST RESIDUAL (autocrítica G11): a delta that landed by SQUASH and was then EDITED in the target
// escapes all three layers — the patch-id changed (layer 2) AND the post-image changed (layer 3) — so the
// verdict is `absent` and the system stays CONSERVATIVE (it re-spawns / keeps the branch, exactly like
// today). That is the right side of the error, and it means the C2 deadlock keeps ONE rare case whose way
// out is the manual unblock that exists today (a human marks the evidence). Do NOT close it with a loose
// "containment per file" heuristic: a false `landed` is worse than a rare manual unblock.
//
// CONSUMERS (this header is the single source — a new mechanism must NOT invent its own ruler):
//   • C2/O3.5 build-evidence guard (engine.ts) — before decreeing `sucesso-fantasma`, ask whether the
//     card's expected delta is already in the run's base. `landed` ⇒ stamp `buildEvidence` and let the
//     legitimate advance through. Spec: storymap/boards/storymap/cards/story-uae2ag.md.
//   • redrive pre-check (engine.ts `redrive`) — before re-spawning harness-do for a card whose prior run
//     preserved a branch with code, ask whether that branch's own work is already in the new base.
//     `landed` ⇒ do not spawn ($0), stamp instead.
//   • branch-gc (branch-gc.ts) — a preserved branch whose own work landed by CONTENT may be harvested
//     (`harvested-landed-content`); `partial`/`unknown` keep it (`kept-unmerged-code` stays fail-closed).
//   • session teardown (worktree.ts `disposeRunBranch`) — before PRESERVING a branch as `failed/*`, ask
//     whether its own work already landed. Without this the teardown measured integration as a COUNT OF
//     SHAS (`rev-list --count base..branch`), which the train's patch-based split can never decrement — so
//     EVERY session that ever committed was labelled `failed/agent/<id>`, however completely it landed.
//     Both this and the branch-gc go through `branchWorkLandedInMainOrStage` (below) — one ruler, one bug.
//   • deploy settle (deploy-reconcile.ts) — TWO borrowings, zero new rulers: `shaContainedIn` is the
//     ancestry primitive behind makeGitContains/measureDeployAncestry ("is the card's released sha inside
//     the published sha?"), and `rangeLandedBySplit` is what proves the DATA-ONLY limbo class (a card whose
//     commitRange has an EMPTY code half terminates on its data half having landed in main).
//   • [release.ts already measures the real delta against main since 033ee72e6 — aligning it to this
//     primitive is opportunistic, NOT done here.]
//
// The range's own work ALWAYS comes from `resolveRunBase` (the reflog cut point) — never from HEAD or a
// bare merge-base. That single confusion produced three independent bugs; run-base.ts's header tells the
// story and the lesson holds here verbatim.

import type { ExecFn } from "./worktree";

export type Landedness =
  /** POSITIVE PROOF the delta is in the target — the only verdict that authorizes acting */
  | "landed"
  /** some of the range's commits are in the target, some are not — a real half-landing */
  | "partial"
  /** we looked and could not find it — CONSERVATIVE, not a licence to destroy */
  | "absent"
  /** git failed / timed out / a ref does not resolve — we know NOTHING */
  | "unknown";

export interface DeltaRange {
  /** where the delta starts (exclusive) — for a run branch, ALWAYS the reflog cut point (run-base.ts) */
  base: string;
  /** where the delta ends (inclusive) */
  head: string;
}

export interface DeltaLandedOpts {
  range: DeltaRange;
  /** the ref the delta should be contained in: "main" | "stage" | a run's baseCommit sha */
  target: string;
  /**
   * WS-1 — measure only the HALF of the delta under these paths (as `git diff -- <pathspec>` takes them).
   * Omitted ⇒ the whole delta against one ref, byte-identical to the pre-WS-1 behaviour.
   *
   * Exists because the train SPLITS the work: code → `stage`, board-data → `main`. A run that touches both
   * is ONE commit whose delta lives in TWO refs, so measuring it whole against either ref proves nothing —
   * it answered `absent` for work that had fully landed, and `absent` is what makes the redrive re-implement
   * published code (~$13/card, the qb8z2c pattern). The pathspec is what lets ONE ruler ask the question the
   * mechanism actually answers: "is MY code half in `stage`?" and "is MY data half in `main`?".
   *
   * Callers should reach for {@link branchWorkLandedBySplit} rather than passing this by hand — it derives
   * the two pathspecs from `partitionPaths`, the SAME function the train routes with.
   */
  paths?: readonly string[];
  /** per-command budget. Generous by design: an overrun is `unknown`, and `unknown` blocks nothing. */
  timeoutMs?: number;
}

export interface DeltaLandedResult {
  verdict: Landedness;
  /** operator-facing one-liner (PT-BR) — rides logs/findings, so it says WHICH layer answered */
  detail: string;
}

/** Generous per-command budget: these ranges are a run's own work (small) and the target side is bounded
 *  by the merge-base, so in practice this is milliseconds — the budget only catches a hung git. */
const DEFAULT_TIMEOUT_MS = 60_000;

const q = (s: string) => JSON.stringify(s);
const SHA_LINE = /^[0-9a-f]{7,40}$/i;

/**
 * git with the EXIT CODE preserved — the whole module depends on telling "1 = the answer is no" apart from
 * "128 = the question was malformed". Collapsing them (the usual `catch → ""`) is how a broken git turns
 * into "the branch is empty, harvest it". `code: -1` ⇒ no exit code at all (timeout/kill/spawn error).
 */
async function git(
  exec: ExecFn,
  repoRoot: string,
  cmd: string,
  timeout: number,
): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(cmd, { cwd: repoRoot, timeout });
    return { code: 0, stdout: String(stdout ?? "") };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown };
    const code = typeof e?.code === "number" ? e.code : -1;
    return { code, stdout: String(e?.stdout ?? "") };
  }
}

/** Resolve a ref to a commit sha, or null when it does not exist. Every layer below assumes the three refs
 *  resolve — that is what makes a later non-zero exit an ANSWER instead of an error. */
async function resolveCommit(exec: ExecFn, repoRoot: string, ref: string, timeout: number): Promise<string | null> {
  const r = await git(exec, repoRoot, `git rev-parse --verify --quiet ${q(`${ref}^{commit}`)}`, timeout);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA_LINE.test(sha) ? sha : null;
}

/** The TRINARY answer of {@link shaContainedIn} — `unknown` is a first-class verdict, never a boolean. */
export type ShaContainment = "contained" | "not-contained" | "unknown";

/**
 * IS `inner` CONTAINED IN `outer`'s history? — the module's layer-1 ancestry question as a standalone,
 * never-throwing primitive (`git merge-base --is-ancestor`, which is REFLEXIVE: a sha contains itself).
 * The exit-code discipline is the whole point (see `git()` above): exit 0 = yes, exit 1 = a REAL "no",
 * anything else (128, timeout, no exit code at all) = `unknown` — a failure is never an answer. TRINARY on
 * purpose: collapsing `unknown` into "no" is a fail-closed decision that belongs to the CALLER
 * (deploy-reconcile's makeGitContains makes exactly that call), never to this primitive.
 *
 * CONSUMERS: layer 1 of {@link deltaLanded} (below) and deploy-reconcile.ts (makeGitContains — the
 * deploy-truth ancestry ruler "is the card's released sha inside the published sha?", plus the self-deploy
 * settle). ONE primitive, because two hand-rolled ancestor calls reading exit codes differently is exactly
 * how the face canary was born (deploy-truth anti-requirement: never two rulers for one question).
 */
export async function shaContainedIn(
  exec: ExecFn,
  repoRoot: string,
  opts: { inner: string; outer: string; timeoutMs?: number },
): Promise<ShaContainment> {
  const inner = opts.inner?.trim();
  const outer = opts.outer?.trim();
  if (!inner || !outer) return "unknown";
  const r = await git(
    exec,
    repoRoot,
    `git merge-base --is-ancestor ${q(inner)} ${q(outer)}`,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (r.code === 0) return "contained";
  if (r.code === 1) return "not-contained";
  return "unknown";
}

/**
 * The patch-ids of a range's OWN commits, keyed by patch-id → commit sha. `--stable` so the id does not
 * depend on file order (the default algorithm is not reproducible across git configs). Merges carry no
 * patch of their own and are excluded. `null` ⇒ git failed (the caller must NOT read that as "empty").
 */
async function patchIdsOf(
  exec: ExecFn,
  repoRoot: string,
  range: string,
  timeout: number,
): Promise<Map<string, string> | null> {
  // `git log -p` emits the `commit <sha>` header patch-id reads to pair each id with its commit.
  const r = await git(
    exec,
    repoRoot,
    `git log --no-merges -p --format=${q("commit %H")} ${q(range)} | git patch-id --stable`,
    timeout,
  );
  if (r.code !== 0) return null;
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const [patchId, commit] = line.trim().split(/\s+/);
    if (patchId && SHA_LINE.test(patchId)) out.set(patchId, commit ?? "");
  }
  return out;
}

/**
 * Is the OWN delta of `range` (base..head) already CONTAINED in `target` — by content, not by sha?
 *
 * PURE over the injected `exec` (like run-base.ts): every git call is read-only, so this is safe to run
 * against a live repo from a tick. NEVER throws — a failure is the `unknown` verdict, which authorizes
 * nothing. See the module header for the layers, the asymmetry contract and the honest residual.
 */
export async function deltaLanded(
  exec: ExecFn,
  repoRoot: string,
  opts: DeltaLandedOpts,
): Promise<DeltaLandedResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { base, head } = opts.range;
  if (!base?.trim() || !head?.trim() || !opts.target?.trim()) {
    return { verdict: "unknown", detail: "range/alvo incompleto — nada a medir" };
  }

  // Refs first: a ref that does not resolve makes every later exit code meaningless.
  const [baseSha, headSha, targetSha] = await Promise.all([
    resolveCommit(exec, repoRoot, base, timeout),
    resolveCommit(exec, repoRoot, head, timeout),
    resolveCommit(exec, repoRoot, opts.target, timeout),
  ]);
  if (!baseSha || !headSha || !targetSha) {
    const missing = [!baseSha && base, !headSha && head, !targetSha && opts.target].filter(Boolean).join(", ");
    return { verdict: "unknown", detail: `ref não resolvida (${missing}) — não dá para medir convergência` };
  }

  // The delta's files — the pathspec layer 3 measures in, and the cheapest "is there anything here?".
  // Asked BEFORE the layers, so `landed` can NEVER come back vacuously true: an EMPTY range is an ancestor
  // of everything downstream, and layer 1 would happily "prove" it — handing a consumer a licence it never
  // earned (a card whose commitRange collapsed to base==head would get build evidence stamped for an
  // implementation that does not exist). A delta that changes nothing proves nothing about the target; the
  // branch with no own work is already acquitted upstream, by run-base/verdictFor.
  // WS-1: `paths` narrows the delta to ONE half (code or data). Everything downstream — the emptiness guard
  // and layer 3's pathspec — then speaks about that half only, because `files` IS the half.
  const pathspec = opts.paths?.length ? ` -- ${opts.paths.map(q).join(" ")}` : "";
  const namesRes = await git(exec, repoRoot, `git diff --name-only ${q(baseSha)}..${q(headSha)}${pathspec}`, timeout);
  if (namesRes.code !== 0) return { verdict: "unknown", detail: `git diff --name-only falhou (exit ${namesRes.code})` };
  const files = namesRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (files.length === 0) {
    // NOTE (WS-1): with `paths`, an empty result means "this run has no such half" — which is NOT the same
    // claim as `absent` ("the work is not in the target"). That distinction is `n/a`, and it is decided by
    // {@link branchWorkLandedBySplit}, which partitions the delta and therefore KNOWS a half is empty
    // without asking git twice. Reaching this line with `paths` means a caller hand-built a pathspec that
    // matches nothing — for which `absent` (prove nothing, authorize nothing) remains the right answer.
    return { verdict: "absent", detail: `o range ${short(baseSha)}..${short(headSha)} não muda arquivo nenhum — não há delta a provar` };
  }

  // ── Layer 1 — ancestry: the target descends from the delta's head — the standalone primitive above
  // ({@link shaContainedIn}: exit 0 = ancestor, 1 = not; anything else = we know nothing).
  const anc = await shaContainedIn(exec, repoRoot, { inner: headSha, outer: targetSha, timeoutMs: timeout });
  if (anc === "contained") return { verdict: "landed", detail: `${short(headSha)} é ancestral de ${opts.target} (ancestralidade)` };
  if (anc === "unknown") return { verdict: "unknown", detail: "git merge-base --is-ancestor falhou (ancestralidade não medida)" };

  // ── Layer 2 — patch-id containment (cherry-pick-safe). The target side is bounded by the merge-base, so
  // a long-lived target costs no more than the divergence itself.
  //
  // WS-1 — SKIPPED under `paths`, and this is load-bearing, not an optimization. A patch-id is computed per
  // COMMIT over the WHOLE commit; a mixed code+data commit therefore has ONE id that matches NEITHER of the
  // two disjoint patches the train applied. That alone would be a harmless false negative — except that a
  // PARTIAL hit short-circuits to `partial` below, and `partial` blocks EVERY consumer. Under partition,
  // that would be a spurious `partial` manufactured by asking a whole-commit question about half a commit.
  // Nothing is lost: layer 2 exists for cherry-picks (new sha, same patch-id), and the train does not
  // cherry-pick — it re-applies a patch and commits, which changes the patch-id too. Layer 3 is what
  // actually catches the train's own mechanism, with or without this layer.
  if (!opts.paths?.length) {
    const mine = await patchIdsOf(exec, repoRoot, `${baseSha}..${headSha}`, timeout);
    if (mine === null) return { verdict: "unknown", detail: "git patch-id do range próprio falhou" };
    if (mine.size > 0) {
      const mb = await git(exec, repoRoot, `git merge-base ${q(baseSha)} ${q(targetSha)}`, timeout);
      const mbSha = mb.stdout.trim();
      if (mb.code !== 0 || !SHA_LINE.test(mbSha)) {
        return { verdict: "unknown", detail: `git merge-base(${short(baseSha)}, ${opts.target}) falhou (exit ${mb.code})` };
      }
      const theirs = await patchIdsOf(exec, repoRoot, `${mbSha}..${targetSha}`, timeout);
      if (theirs === null) return { verdict: "unknown", detail: `git patch-id de ${opts.target} falhou` };
      const contained = [...mine.keys()].filter((id) => theirs.has(id));
      if (contained.length === mine.size) {
        return {
          verdict: "landed",
          detail: `os ${mine.size} commit(s) próprios do range têm equivalente em ${opts.target} (patch-id — cherry-pick)`,
        };
      }
      if (contained.length > 0) {
        // A REAL half-landing. Layer 3 could only ever acquit it, and `partial` already blocks every
        // consumer — so it short-circuits here (spec §5.1) rather than buying a stronger claim on a
        // situation that needs a human anyway.
        return {
          verdict: "partial",
          detail: `${contained.length}/${mine.size} commit(s) do range estão em ${opts.target} — aterrissagem PARCIAL`,
        };
      }
    }
  }

  // ── Layer 3 — post-image equality in the delta's OWN pathspec (squash/reword/rebase land here: the sha
  // and the patch-id both changed, but the content that matters is already in the target). Scoped to the
  // delta's files ON PURPOSE: measuring the whole tree would turn any unrelated advance of the target into
  // a false `absent`. `git diff --quiet` exits 1 when they DIFFER → that is an answer, not a failure.
  const paths = files.map(q).join(" ");
  const same = await git(exec, repoRoot, `git diff --quiet ${q(headSha)} ${q(targetSha)} -- ${paths}`, timeout);
  if (same.code === 0) {
    return {
      verdict: "landed",
      detail: `o conteúdo final dos ${files.length} arquivo(s) do delta é idêntico em ${opts.target} (pós-imagem — squash/reword)`,
    };
  }
  if (same.code !== 1) return { verdict: "unknown", detail: `git diff --quiet falhou (exit ${same.code})` };

  return {
    verdict: "absent",
    detail: `o delta ${short(baseSha)}..${short(headSha)} não está em ${opts.target} (nem ancestralidade, nem patch-id, nem pós-imagem)`,
  };
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * The delta a card is EXPECTED to have produced, from the durable ranges the pipeline already persists.
 * Structural on purpose (no Card import): this module stays pure git, so the primitive travels without the
 * board model. Precedence: `commitRange` (the review/QA-validated delta — the most precise statement of
 * "the change this card is") over `diffSnapshot` (the merge-back's base..mergeCommit — present once the run
 * branch was deleted). `null` when the card carries NEITHER: a card with no recorded delta gives us nothing
 * to prove, and inventing one (e.g. from the file list) is exactly the loose heuristic the residual above
 * says NOT to add — the caller keeps its conservative behaviour.
 */
export function expectedDeltaOf(
  card:
    | {
        commitRange?: { base?: string | null; head?: string | null } | null;
        diffSnapshot?: { base?: string | null; mergeCommit?: string | null } | null;
      }
    | null
    | undefined,
): DeltaRange | null {
  const cr = card?.commitRange;
  if (cr?.base && cr?.head) return { base: cr.base, head: cr.head };
  const ds = card?.diffSnapshot;
  if (ds?.base && ds?.mergeCommit) return { base: ds.base, head: ds.mergeCommit };
  return null;
}

/** The engine's port over {@link deltaLanded} (DI — a fake in tests, real git in prod). */
export type DeltaLandedFn = (opts: DeltaLandedOpts) => Promise<DeltaLandedResult>;

/**
 * deploy-truth FOLLOW-UP A — the RANGE-based sibling of {@link branchWorkLandedBySplit}: the SAME partition
 * (`partitionPaths` with the train's own {@link STAGING_CODE_PREFIXES}) and the SAME per-half measurement
 * ({@link deltaLanded} under `paths`), taken over an EXPLICIT {@link DeltaRange} instead of a branch. Exists
 * for the caller that holds a card's durable `commitRange` (the review-validated base..head) and NO branch
 * at all — the run branch is long deleted and no receipt id is derivable from a range, so the branch-based
 * ruler cannot answer. Consequently: no run-base resolution (the range IS the statement of the work) and no
 * WS-2 receipt precedence (there is nothing to key it by) — pure WS-1 measurement, one ruler, zero copies.
 *
 * Doctrine inherited verbatim: an empty range ⇒ `{code: "absent", data: "absent"}` (an empty delta proves
 * nothing — never a vacuous `landed`); an empty HALF ⇒ `n/a`, decided HERE from the partition — exactly like
 * {@link branchWorkLandedBySplit}'s `judge` — so the empty half never reaches git and a data-only range never
 * depends on `stage` even existing; an unresolved ref / failed diff ⇒ `{unknown, unknown}`. NEVER throws.
 *
 * Returns only the two half-verdicts (no `detail`/`base` of {@link SplitLandedness} — a range has no run
 * base to surface, and the consumer stamps its own proof narrative).
 *
 * CONSUMERS: deploy-reconcile.ts (`measureDataOnlySettle` — the data-only limbo class: a card whose
 * commitRange has an EMPTY code half (`code: "n/a"`) is proven published when its data half landed in main,
 * because for board-data the runtime's main IS production).
 */
/**
 * A FORMA DECLARADA por ESTE repositório — `autorun.staging.{codePrefixes,branch}` —, com a constante
 * do train como último recurso.
 *
 * POR QUE EXISTE (fase 3, 2026-08-21): as réguas de ciclo de vida caíam direto em
 * `STAGING_CODE_PREFIXES` (`["packages/"]`) e no literal `"stage"`, porque NENHUM dos três chamadores
 * de produção passava o valor declarado. Não era um problema só de adotante: este monorepo declara
 * `["packages/", "tools/web-terminal/"]`, então um branch que tocasse `tools/web-terminal/` já era
 * particionado errado aqui. Num repositório de layout PLANO (`src/` na raiz) a metade de código saía
 * com ZERO arquivo e o código inteiro era procurado em `main`, onde ele nunca esteve — e o veredito
 * "o trabalho deste branch aterrissou?" é o que decide preservar como `failed/*` ou deletar, e o que
 * o fleet view chama de trabalho encalhado.
 *
 * Mesma correção que `commitBoardDataScoped` (worktree.ts) já tinha recebido na onda 1, e pelo mesmo
 * motivo: a régua tem de perguntar ao que foi CONFIGURADO, não à constante desta casa.
 *
 * `??` e não `.length`: um `codePrefixes: []` é uma declaração DELIBERADA ("nada aqui é código" ⇒
 * staging inerte) e não pode ser sobrescrita pela constante. NUNCA lança — settings ilegível devolve a
 * constante, que é o comportamento de antes.
 */
async function formaDeclarada(
  opts: { codePrefixes?: readonly string[]; stageBranch?: string } = {},
): Promise<{ codePrefixes: readonly string[]; stageBranch: string }> {
  const { STAGING_CODE_PREFIXES } = await import("./config");
  let declarado: { codePrefixes?: readonly string[]; branch?: string } | undefined;
  try {
    const { loadRunnerConfig } = await import("./config");
    declarado = loadRunnerConfig().autorun.staging;
  } catch {
    declarado = undefined; // settings ilegível ⇒ a constante, como antes
  }
  return {
    codePrefixes: opts.codePrefixes ?? declarado?.codePrefixes ?? STAGING_CODE_PREFIXES,
    stageBranch: opts.stageBranch ?? declarado?.branch?.trim() ?? "stage",
  };
}

export async function rangeLandedBySplit(
  exec: ExecFn,
  repoRoot: string,
  opts: {
    range: DeltaRange;
    /** where the CODE half must be contained (default "stage" — where the train puts code) */
    codeRef?: string;
    /** where the DATA half must be contained (default "main" — where the train puts board-data) */
    dataRef?: string;
    /** the path prefixes that count as CODE — defaults to the train's own STAGING_CODE_PREFIXES */
    codePrefixes?: readonly string[];
    timeoutMs?: number;
  },
): Promise<Pick<SplitLandedness, "code" | "data">> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    // Dynamic, like branchWorkLandedBySplit below: convergence.ts stays pure git in its STATIC graph.
    const [{ partitionPaths }, forma] = await Promise.all([import("./staging"), formaDeclarada(opts)]);
    const { base, head } = opts.range;
    if (!base?.trim() || !head?.trim()) return { code: "unknown", data: "unknown" };
    const [baseSha, headSha] = await Promise.all([
      resolveCommit(exec, repoRoot, base, timeout),
      resolveCommit(exec, repoRoot, head, timeout),
    ]);
    if (!baseSha || !headSha) return { code: "unknown", data: "unknown" };
    const names = await git(exec, repoRoot, `git diff --name-only ${q(baseSha)}..${q(headSha)}`, timeout);
    if (names.code !== 0) return { code: "unknown", data: "unknown" };
    const files = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length === 0) return { code: "absent", data: "absent" }; // empty-range doctrine (see header)
    const part = partitionPaths(files, forma.codePrefixes);
    const range = { base: baseSha, head: headSha };
    const judge = async (half: readonly string[], target: string): Promise<HalfVerdict> => {
      if (half.length === 0) return "n/a"; // the empty half never reaches git (see doctrine above)
      const res = await deltaLanded(exec, repoRoot, { range, target, paths: half, timeoutMs: timeout });
      return res.verdict;
    };
    const [code, data] = await Promise.all([
      judge(part.code, opts.codeRef ?? "stage"),
      judge(part.data, opts.dataRef ?? "main"),
    ]);
    return { code, data };
  } catch {
    return { code: "unknown", data: "unknown" };
  }
}

/**
 * ADR-065 — DID THIS BRANCH'S OWN WORK LAND IN main OR stage? The question every branch-lifecycle decision
 * asks: the branch-gc (may I harvest this?) and the session teardown (may I delete this, or must I preserve
 * it as `failed/*`?). ONE implementation, because two would drift — and they did: this was duplicated inline
 * in instrumentation.ts, where it carried a bug the other copy had already been fixed for (below).
 *
 * The range is the branch's OWN work — `resolveRunBase`'s cut point .. branch — NEVER `HEAD...branch`, which
 * would re-attribute the stage code the branch INHERITED to the branch itself (the confusion run-base.ts
 * exists to kill). The target is main OR stage because the train SPLITS: code lands on `stage`, board-data on
 * `main`, so a session's work is routinely half in each.
 *
 * ONLY AN EXACT BASE MAY AUTHORIZE. An ESTIMATED base (`fork-point`, expired reflog) can only OVER-report the
 * branch's own work, so proving THAT inflated range landed would prove something else. But "exact" is
 * `isExactBase` — reflog OR base-ref — NOT the literal `=== "reflog"`: a session branch's exact base is the
 * `refs/agent-base/<id>` ref (the `worktree_refresh` rebase invalidates the reflog), so testing for the
 * reflog alone made EVERY `agent/*` branch unprovable — permanently `unknown`, permanently un-harvestable.
 * worktree.ts's `hasOwnCommits` already carries this exact warning; the copy in instrumentation.ts did not.
 *
 * Verdicts: `landed` (POSITIVE proof, in either ref) wins immediately. Otherwise the WEAKEST answer survives:
 * a git hiccup on one ref must not read as a clean `absent`, or the journal would claim we looked when we
 * could not. NEVER throws — a failure is `unknown`, which authorizes nothing.
 */
export async function branchWorkLandedInMainOrStage(
  exec: ExecFn,
  repoRoot: string,
  branch: string,
  opts: { stageBranch?: string; refs?: readonly string[] } = {},
): Promise<Landedness> {
  // WS-1: the split ruler IS this ruler now — `refs` (a legacy escape hatch no caller uses) still takes the
  // old whole-delta loop, so the seam stays available without keeping two live implementations.
  if (opts.refs) return branchWorkLandedInRefs(exec, repoRoot, branch, opts.refs, opts.stageBranch);
  const split = await branchWorkLandedBySplit(exec, repoRoot, branch, { stageBranch: opts.stageBranch });
  return projectSplitVerdict(split);
}

/** The pre-WS-1 loop: is the WHOLE delta in ANY one of `refs`? Retained only for an explicit `refs` caller. */
async function branchWorkLandedInRefs(
  exec: ExecFn,
  repoRoot: string,
  branch: string,
  refs: readonly string[],
  stageBranch?: string,
): Promise<Landedness> {
  try {
    const { isExactBase, resolveRunBase } = await import("./run-base");
    const { base, provenance } = await resolveRunBase(exec, repoRoot, branch, { stageBranch: stageBranch ?? "stage" });
    if (!base || !isExactBase(provenance)) return "unknown";
    let weakest: Landedness = "absent";
    for (const ref of refs) {
      const res = await deltaLanded(exec, repoRoot, { range: { base, head: branch }, target: ref });
      if (res.verdict === "landed") return "landed";
      if (res.verdict === "unknown") weakest = "unknown";
      else if (res.verdict === "partial" && weakest !== "unknown") weakest = "partial";
    }
    return weakest;
  } catch {
    return "unknown";
  }
}

/** A half's verdict. `n/a` = THIS RUN HAS NO SUCH HALF — a claim about the run, not about the target. */
export type HalfVerdict = Landedness | "n/a";

/** The branch's work as the train actually applies it: the code half and the data half, judged separately. */
export interface SplitLandedness {
  /** the `packages/**` half vs `stage` */
  code: HalfVerdict;
  /** the board-data half vs `main` */
  data: HalfVerdict;
  /** operator-facing one-liner (PT-BR) naming what answered each half */
  detail: string;
  /** the EXACT base the halves were measured from (the cut point). Absent when the base was unresolvable —
   *  in which case both halves are `unknown`. Surfaced so a caller that RECORDS the proof (the redrive's
   *  build-evidence stamp) can cite the real range instead of inventing a label for it. */
  base?: string;
}

/**
 * WS-1 — DID THIS BRANCH'S WORK LAND, MEASURED THE WAY THE TRAIN APPLIES IT? The one ruler that finally
 * agrees with the mechanism it measures: the train partitions a run's diff with `partitionPaths` and applies
 * TWO disjoint patches to TWO refs (code → `stage`, board-data → `main`). Every ruler before this one asked
 * whether the WHOLE delta was in ONE ref — a question a split run can never answer yes to, however
 * completely it landed. That false `absent` is the whole Class A defect: the redrive read it as "not done"
 * and re-implemented code that was already published (the qb8z2c pattern, ~$13 a turn), while the teardown
 * read it as "not integrated" and branded every session that ever committed `failed/agent/*`.
 *
 * It imports `partitionPaths` from staging.ts — the SAME function the train routes with (merge-queue.ts) —
 * ON PURPOSE. The old ruler's header PROMISED this split in prose ("the train SPLITS: code lands on stage,
 * board-data on main, so a session's work is routinely half in each") and then measured the whole delta
 * against each ref anyway: an invariant documented and not implemented, which survived only by a topological
 * accident (`syncStageWithReleased` leaves `stage ⊇ main`'s board-data) that does NOT cover the redrive.
 * Sharing the partitioner means the ruler and the router cannot drift again — by construction, not by
 * vigilance.
 *
 * THE HALVES ARE NOT SYMMETRIC, and pretending otherwise is the trap:
 *   • CODE → `stage` is solidly measurable. Nobody mutates `packages/**` between the branch commit and the
 *     measurement, so layer 3 answers exactly the right question.
 *   • DATA → `main` is STRUCTURALLY unprovable by git. The board is LIVE: the service mutates the card
 *     (status, findings, tasks) AFTER the train applied the patch, so the post-image diverges BY DESIGN. No
 *     git measurement separates "did not land" from "landed and the board moved on". That residual is why
 *     WS-2's receipt exists — this function is honest about it rather than guessing.
 *
 * `n/a` (empty half) is decided HERE, from the partition, and is deliberately NOT `absent`: a board-data-only
 * run (the MAJORITY of runs) has no code, and "has no code" is not "its code failed to land". The train
 * already models it this way (`entry.split.dataLanded = true; // pure-code run: nothing to land on main`) —
 * without the distinction, every pure-data run would become a false `absent` of code, trading one bug for a
 * more frequent one. `n/a` is contained in {@link HalfVerdict} and never reaches a `Landedness` consumer:
 * {@link projectSplitVerdict} folds it away.
 *
 * NEVER throws; a git failure is `unknown` in THAT half only (the weakest survives, per half).
 */
export async function branchWorkLandedBySplit(
  exec: ExecFn,
  repoRoot: string,
  branch: string,
  opts: { stageBranch?: string; codePrefixes?: readonly string[]; codeRef?: string; dataRef?: string } = {},
): Promise<SplitLandedness> {
  try {
    // Dynamic, like run-base below: convergence.ts stays pure git in its STATIC graph, so the primitive
    // still travels without dragging the board model (config.ts pulls fs + yaml + the card types).
    const [{ isExactBase, resolveRunBase, sessionIdFromBranch }, { partitionPaths }, forma] = await Promise.all([
      import("./run-base"),
      import("./staging"),
      formaDeclarada(opts),
    ]);
    const codeRef = opts.codeRef ?? forma.stageBranch;
    const dataRef = opts.dataRef ?? "main";

    const { base, provenance } = await resolveRunBase(exec, repoRoot, branch, {
      stageBranch: forma.stageBranch,
    });
    // An ESTIMATED base can only OVER-report the branch's own work, so proving THAT inflated range landed
    // would prove something else. "Exact" is `isExactBase` — reflog OR base-ref — never the literal
    // `=== "reflog"`: a session branch's exact base is `refs/agent-base/<id>` (worktree_refresh's rebase
    // invalidates the reflog), and testing the reflog alone made every `agent/*` branch permanently unknown.
    if (!base || !isExactBase(provenance)) {
      return { code: "unknown", data: "unknown", detail: "base do run não é exata (reflog/base-ref) — nada a autorizar" };
    }

    const namesRes = await git(exec, repoRoot, `git diff --name-only ${q(base)}..${q(branch)}`, DEFAULT_TIMEOUT_MS);
    if (namesRes.code !== 0) {
      return { code: "unknown", data: "unknown", detail: `git diff --name-only falhou (exit ${namesRes.code})` };
    }
    const files = namesRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const part = partitionPaths(files, forma.codePrefixes);

    // WS-2 — THE RECEIPT PROVES; ITS ABSENCE REFUTES NOTHING. The train applied each half and witnessed it
    // (landings.ts); reading that witness is both correct and free. The precedence is the whole safety
    // argument, and it is one-directional ON PURPOSE:
    //   receipt ⇒ `landed`  — positive proof; no git measured, none needed.
    //   no receipt ⇒ fall through to the git ruler — NEVER `absent` by absence.
    // Every run older than the ledger has no line, and they all landed: reading absence as `absent` would
    // have the branch-gc delete the history on the first boot. This adds a source of `landed`, and NO source
    // of `absent` — the same asymmetry this module opens with (whoever ACCUSES needs proof).
    //
    // It is also what finally answers the DATA half, which git structurally cannot (the live board mutates
    // the card after the patch). Side benefit: a half with a receipt costs no git at all.
    // The receipt is keyed by runId, and the branch name carries it (`run/<uuid>`, `agent/<uuid>`, and the
    // `conflicted/`/`failed/` renames the preservation stacks in front — sessionIdFromBranch peels them).
    // A branch that is not ours (no uuid) simply has no receipt ⇒ the git fallback, as before.
    const runId = sessionIdFromBranch(branch);
    const receiptFor = async (half: "code" | "data"): Promise<string | null> => {
      if (!runId) return null;
      try {
        const { readLanding } = await import("./landings");
        const r = await readLanding(runId, half);
        if (!r) return null;
        return r.empty
          ? `recibo: metade vazia neste run (nada a aterrissar)`
          : `recibo: o train aterrissou em ${r.ref}${r.sha ? ` (${r.sha.slice(0, 8)})` : ""} às ${r.at}`;
      } catch {
        return null; // a broken ledger is "no witness" ⇒ the git fallback ⇒ today's behaviour
      }
    };

    const judge = async (
      halfName: "code" | "data",
      half: readonly string[],
      target: string,
    ): Promise<{ v: HalfVerdict; d: string }> => {
      const receipt = await receiptFor(halfName);
      // An EMPTY-half receipt and an empty partition are the same fact from two witnesses; either is enough.
      if (half.length === 0) return { v: "n/a", d: receipt ?? `sem metade (0 arquivo) para ${target}` };
      if (receipt) return { v: "landed", d: receipt };
      const res = await deltaLanded(exec, repoRoot, { range: { base, head: branch }, target, paths: half });
      return { v: res.verdict, d: res.detail };
    };
    const [code, data] = await Promise.all([judge("code", part.code, codeRef), judge("data", part.data, dataRef)]);
    return {
      code: code.v,
      data: data.v,
      detail: `código→${codeRef}: ${code.d} | dados→${dataRef}: ${data.d}`,
      base,
    };
  } catch (err) {
    return {
      code: "unknown",
      data: "unknown",
      detail: `medição de convergência falhou: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Fold a {@link SplitLandedness} into the single {@link Landedness} the legacy consumers read. `landed` iff
 * EVERY half either landed or does not exist; `unknown` in any half contaminates the whole (a git hiccup must
 * never read as a clean `absent`); otherwise the weakest survives. This is the ONLY place `n/a` disappears,
 * which is what keeps it from leaking into teardown/branch-gc/the C2 guard as a value they'd read as failure.
 */
export function projectSplitVerdict(split: SplitLandedness): Landedness {
  const halves: HalfVerdict[] = [split.code, split.data];
  if (halves.some((h) => h === "unknown")) return "unknown";
  if (halves.every((h) => h === "landed" || h === "n/a")) {
    // Both halves `n/a` = the branch changes nothing at all. An empty delta proves nothing about the target,
    // and layer 1 would "prove" it vacuously — the guard deltaLanded already fixes for the whole-delta case.
    if (halves.every((h) => h === "n/a")) return "absent";
    return "landed";
  }
  if (halves.some((h) => h === "partial")) return "partial";
  return "absent";
}
