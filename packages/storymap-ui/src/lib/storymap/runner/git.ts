// Shared git/exec helpers for the autorun runner — the single home for the small PURE git plumbing
// that was copy-pasted across worktree.ts / merge-queue.ts / release.ts. B6 / the dedup pass.
// Behavior-neutral: each helper is byte-identical to the copies it replaces. Pure (zero imports) so
// anything can use it without pulling node:child_process.
//
// NOTE: `defaultExec` lives next to its `ExecFn` type in worktree.ts (one cast, one place) — the
// `GitExec` param of `makeGit` below is the structural shape of that same surface, kept local so this
// file stays import-free. `quote`/`execErrorDetail` are the two string helpers; `makeGit` (B6) is the
// `git(args)` wrapper factory that unifies merge-queue's `gitAt`/`git` and release's `git`.

/**
 * Quote a shell token (a path / branch / pathspec) by wrapping it in double quotes. The inputs here
 * are controlled (repo-relative paths, branch names, SHAs), so always-quote is sufficient. This is
 * the ALWAYS-quote variant shared by worktree/merge-queue/release; engine.ts keeps its own
 * `quoteArg` (conditional `/\s/`-based) which is a deliberately different policy.
 */
export function quote(token: string): string {
  return `"${token}"`;
}

/**
 * Best-effort human-readable detail from a failed exec/child-process error: prefer stderr, then
 * stdout, then message, then the stringified error itself, capped to `cap` chars. Callers keep their
 * own trailing fallback (`|| \`exit ${code}\``, `|| "secret-scan falhou"`, …) for the empty case.
 */
export function execErrorDetail(err: unknown, cap = 300): string {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return String(e?.stderr || e?.stdout || e?.message || err || "").slice(0, cap);
}

/** Result of one git invocation, with the exit code CAPTURED rather than thrown: a non-zero exit
 *  comes back as `ok:false` (code/stderr populated) instead of a reject. Shared by the merge train
 *  (merge-queue.ts) and the release promotion (release.ts). */
export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The minimal async exec surface {@link makeGit} drives — STRUCTURALLY an `ExecFn` (worktree.ts),
 *  declared locally so git.ts stays import-free. The default `ExecFn` is assignable to it. */
export type GitExec = (
  command: string,
  opts: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** A bound git runner: `git(args)` runs `git <args>` in the factory's default cwd; pass a 2nd arg to
 *  run in ANOTHER working tree (the Fase 4a split operates on the stage worktree too). NEVER throws —
 *  the exit comes back as a {@link GitResult}. */
export type GitRunner = (args: string, cwd?: string) => Promise<GitResult>;

/**
 * Build a {@link GitRunner} over an injected exec — THE single home for the `git <args>` wrapper that
 * was copy-pasted as release.ts's `git` and merge-queue.ts's `gitAt`/`git`. One try/catch maps a
 * thrown child-process error to a `GitResult`: `code` from `err.code`, `stdout`/`stderr` from the
 * error (falling back to `err.message`). Behavior-neutral — byte-identical to the merge-queue body
 * it replaces (release's copy lacked the always-unused `code`, a harmless superset here).
 */
export function makeGit(exec: GitExec, opts: { cwd: string; timeoutMs: number }): GitRunner {
  return async (args, cwd = opts.cwd) => {
    try {
      const { stdout, stderr } = await exec(`git ${args}`, { cwd, timeout: opts.timeoutMs });
      return { ok: true, code: 0, stdout, stderr };
    } catch (e: unknown) {
      const err = e as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
      return {
        ok: false,
        code: typeof err?.code === "number" ? err.code : null,
        stdout: typeof err?.stdout === "string" ? err.stdout : "",
        stderr: String(err?.stderr ?? err?.message ?? ""),
      };
    }
  };
}

/**
 * The robust, FAIL-OPEN `git push origin HEAD` shared by EVERY checkout writer that lands commits on a
 * shared branch (the merge train's `pushToOrigin`, the release promotion, and — story-ex0052 FIX 1 —
 * the engine's no-worktree board-data settle). Extracted here (B6 dedup) so the three callers can never
 * drift in their reconciliation behavior.
 *
 * Behavior — byte-identical to the merge-queue `pushToOrigin`/`reconcileWithOrigin` it replaces:
 *   1. `git push origin HEAD` (CUMULATIVE — carries every unpushed local commit, so a single failure is
 *      recovered by the NEXT successful push; the caller must treat a `false` as non-fatal).
 *   2. On a NON-fast-forward rejection (origin advanced — another checkout / a manual push landed commits
 *      this checkout lacks), RECONCILE: `git fetch origin <branch>` + `git merge --no-edit FETCH_HEAD`
 *      (MERGE, not rebase, so local commit SHAs — and any diff snapshots taken against them — stay valid),
 *      then retry the push ONCE. board data (main) and code (stage) touch DISJOINT paths across checkouts,
 *      so the merge auto-resolves clean in the common case. On any conflict/error during reconcile, ABORT
 *      (`git merge --abort`) to leave the tree pristine and DON'T retry — the cumulative next push recovers.
 *
 * NEVER throws and NEVER mutates the tree destructively on failure: the worst case is `{ pushed: false }`
 * with origin left behind by exactly this checkout's local commits, which the next push will carry.
 * `branch` (for the reconcile fetch) is read from `rev-parse --abbrev-ref HEAD`, defaulting to `main`.
 */
export async function pushHeadToOrigin(
  git: GitRunner,
  scan: PrePushScan,
): Promise<{ pushed: boolean; detail?: string; held?: boolean }> {
  const branch = (await git(`rev-parse --abbrev-ref HEAD`)).stdout.trim() || "main";
  // O PORTÃO (scan pré-push + retenção persistida) vem ANTES de qualquer push — ver prePushGate. O push leva o SHA
  // que o portão varreu (pushTarget), nunca um `HEAD` resolvido depois: um commit que caísse entre o scan e o push
  // sairia sem ter sido varrido.
  const gate = await prePushGateAt(git, branch, scan);
  if (gate.held) return { pushed: false, held: true, detail: gate.held.slice(0, 300) };
  let pushed = await git(`push origin ${pushTarget(branch, gate.sha)} --no-follow-tags`);
  if (!pushed.ok) {
    const fetched = await git(`fetch origin ${quote(branch)}`);
    if (fetched.ok) {
      const merged = await git(`merge --no-edit FETCH_HEAD`);
      if (merged.ok) {
        // o merge criou um commit novo (não varrido): o portão de novo, e o retry leva o sha que ELE varreu
        const again = await prePushGateAt(git, branch, scan);
        if (again.held) return { pushed: false, held: true, detail: again.held.slice(0, 300) };
        pushed = await git(`push origin ${pushTarget(branch, again.sha)} --no-follow-tags`); // retry after pulling origin's advance in
      } else {
        await git(`merge --abort`); // conflict/error → restore the pre-merge tip; origin reconciled by hand
      }
    }
  }
  if (pushed.ok) return { pushed: true };
  return { pushed: false, detail: (pushed.stderr || `exit ${pushed.code}`).slice(0, 200) };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// O PORTÃO PRÉ-PUSH — compartilhado por TODO caminho que publica um checkout (o push do merge train em
// main e em `stage`, o settle de board-data do engine via pushHeadToOrigin, a promoção do release).
//
// O QUE ISTO FECHA: o push é CUMULATIVO — leva todo commit local que origin não tem, inclusive um que
// nenhum scan viu (o processo morreu entre o commit e o scan) ou que o scan REPROVOU e o desfazer não
// conseguiu tirar do HEAD. Enquanto o portão morava só no train, o próximo `board: estado vivo` do engine
// (frequente) ou a promoção do release publicava esse commit por conta própria.
//
// Duas camadas, nesta ordem:
//  1. a RETENÇÃO PERSISTIDA: o ref por-worktree {@link PUSH_HOLD_REF} aponta o commit envenenado. Vive no
//     git dir (sobrevive a restart) e é por worktree (`refs/worktree/*`: main e `stage` têm cada um o seu).
//     Vale enquanto o commit envenenado for ancestral do HEAD — «consertar para a frente» (um commit novo
//     que apaga o segredo) NÃO solta: a história publicada levaria o segredo. Solta quando o operador tira o
//     commit (`git reset` para antes dele) ou apaga o ref (falso-positivo, decisão humana).
//  2. o SCAN de tudo o que o push publica — por COMMIT (`--per-commit`, nunca o diff líquido) e com as
//     mensagens; achado ou erro do scanner ⇒ grava a retenção (envenenado = HEAD) e recusa.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/** A árvore vazia do git — o lado velho do range quando origin não tem nada que o HEAD alcance. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Ref POR WORKTREE que retém a publicação: aponta o commit envenenado. */
export const PUSH_HOLD_REF = "refs/worktree/harness-push-hold";
/** O HEAD de antes do commit envenenado (quando conhecido): o HEAD voltar a ele também solta a retenção. */
export const PUSH_HOLD_BASE_REF = "refs/worktree/harness-push-hold-base";
/**
 * O ACEITE do operador para um FALSO-POSITIVO: aponta o último commit cujos achados ele aceitou. Solta a retenção
 * cujo commit envenenado é ancestral dele (ou ele mesmo), e o range do próximo scan COMEÇA depois dele — sem isto,
 * apagar a retenção não adiantava: o push seguinte varria o mesmo range, achava o mesmo falso-positivo e retinha de
 * novo (um pragma não entra num commit que já existe; a única saída era reescrever a história). Os commits DEPOIS
 * do aceite seguem varridos por inteiro. Por worktree, como a retenção.
 */
export const PUSH_ACK_REF = "refs/worktree/harness-push-ack";

const isSha = (s: string): boolean => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s);

/** O que o `git push` publica: o SHA varrido no branch (`<sha>:refs/heads/<branch>`); sem sha (HEAD ilegível) ou
 *  com HEAD destacado, o `HEAD` simbólico de antes. */
export function pushTarget(branch: string, sha: string | null | undefined): string {
  return sha && isSha(sha) && branch !== "HEAD" ? quote(`${sha}:refs/heads/${branch}`) : "HEAD";
}

/** O sha de um ref (`null` se não existir ou não tiver forma de sha). */
async function readRefSha(git: GitRunner, ref: string, cwd?: string): Promise<string | null> {
  const r = await git(`rev-parse --verify --quiet ${ref}`, cwd);
  const sha = r.ok ? r.stdout.trim() : "";
  return isSha(sha) ? sha : null;
}

/** `a` é ancestral de (ou igual a) `b`? Só o exit 0 conta como sim. */
async function isAncestorOf(git: GitRunner, a: string, b: string, cwd?: string): Promise<boolean> {
  return (await git(`merge-base --is-ancestor ${quote(a)} ${quote(b)}`, cwd)).ok;
}

/** O veredito do scanner sobre um range: `null` = limpo; senão achado (exit 2) ou erro interno (≠ 2). */
export type PrePushScan = (range: string) => Promise<{ internalError: boolean; detail: string } | null>;

/**
 * O range que o push de `branch` publica: `<merge-base>..HEAD`. A BASE é o merge-base com o tracking ref —
 * nunca o tracking ref em si (com o ref divergido de HEAD, depois de um reconcile abortado, um diff de dois
 * pontos contaria o que origin APAGOU como adicionado: retenção falsa que não solta). Sem `origin/<branch>`
 * (o primeiro push de um branch), cai para o merge-base com `origin/HEAD` e `origin/main`; sem nenhum, o
 * HEAD inteiro (`<árvore vazia>..HEAD` — nunca `HEAD~1`, que sub-varre e nem existe num commit raiz).
 */
export async function prePushRange(git: GitRunner, branch: string, cwd?: string, tip = "HEAD"): Promise<string> {
  let base: string | null = null;
  for (const ref of [`refs/remotes/origin/${branch}`, "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]) {
    const mb = await git(`merge-base ${quote(tip)} ${quote(ref)}`, cwd);
    const sha = mb.ok ? mb.stdout.trim() : "";
    if (isSha(sha)) {
      base = sha;
      break;
    }
  }
  // O ACEITE do operador (PUSH_ACK_REF): quando ele está ENTRE a base e a ponta, o range começa nele — os achados
  // até ali foram aceitos como falso-positivo. Fora dessa linha (outro ramo, já publicado) ele não muda nada.
  const ack = await readRefSha(git, PUSH_ACK_REF, cwd);
  if (ack && (await isAncestorOf(git, ack, tip, cwd)) && (base === null || (await isAncestorOf(git, base, ack, cwd)))) {
    base = ack;
  }
  return `${base ?? EMPTY_TREE}..${tip}`;
}

/** A retenção persistida deste checkout, ou `null` (sem o ref, ou ilegível). */
export async function readPushHold(git: GitRunner, cwd?: string): Promise<{ poisoned: string; base: string | null } | null> {
  const r = await git(`rev-parse --verify --quiet ${PUSH_HOLD_REF}`, cwd);
  const poisoned = r.ok ? r.stdout.trim() : "";
  if (!isSha(poisoned)) return null;
  const b = await git(`rev-parse --verify --quiet ${PUSH_HOLD_BASE_REF}`, cwd);
  const base = b.ok ? b.stdout.trim() : "";
  return { poisoned, base: isSha(base) ? base : null };
}

/** Grava a retenção: envenenado = o HEAD atual; `base` = o HEAD de antes dele, quando conhecido. A mensagem
 *  do reflog é FIXA (nunca o motivo, que carrega texto do scanner e passaria pelo shell). */
export async function setPushHold(git: GitRunner, base: string | null, cwd?: string, poisoned?: string): Promise<boolean> {
  const head = poisoned && isSha(poisoned) ? poisoned : (await git(`rev-parse HEAD`, cwd)).stdout.trim();
  if (!isSha(head)) return false;
  const set = await git(`update-ref -m "harness push hold" ${PUSH_HOLD_REF} ${quote(head)}`, cwd);
  if (base && isSha(base) && base !== head) {
    await git(`update-ref -m "harness push hold" ${PUSH_HOLD_BASE_REF} ${quote(base)}`, cwd);
  } else {
    await git(`update-ref -d ${PUSH_HOLD_BASE_REF}`, cwd);
  }
  return set.ok;
}

/** Apaga a retenção persistida (best-effort). */
export async function clearPushHold(git: GitRunner, cwd?: string): Promise<void> {
  await git(`update-ref -d ${PUSH_HOLD_REF}`, cwd);
  await git(`update-ref -d ${PUSH_HOLD_BASE_REF}`, cwd);
}

/** A retenção ainda vale? Solta só quando o HEAD voltou à base, o operador ACEITOU o envenenado como
 *  falso-positivo ({@link PUSH_ACK_REF} nele ou depois dele) OU o envenenado deixou de ser ancestral do HEAD
 *  (exit 1 do `--is-ancestor`); qualquer outra incerteza RETÉM. */
export async function pushHoldActive(git: GitRunner, hold: { poisoned: string; base: string | null }, cwd?: string): Promise<boolean> {
  const head = (await git(`rev-parse HEAD`, cwd)).stdout.trim();
  if (hold.base && head === hold.base) return false;
  const ack = await readRefSha(git, PUSH_ACK_REF, cwd);
  if (ack && (await isAncestorOf(git, hold.poisoned, ack, cwd))) return false;
  const anc = await git(`merge-base --is-ancestor ${quote(hold.poisoned)} HEAD`, cwd);
  return anc.ok || anc.code !== 1;
}

/**
 * O QUE FAZER com uma retenção — os dois jeitos de soltá-la, com o checkout explícito (`git -C <top>`: os refs são
 * por worktree, e o comando rodado no checkout errado não solta nada). Solta sozinha na próxima volta do train.
 */
export function pushHoldHowTo(hold: { poisoned: string; base: string | null }, top?: string | null): string {
  const at = top ? `git -C ${quote(top)}` : "git";
  const undo = hold.base ? `${at} reset --soft ${hold.base}` : `${at} reset --soft ${hold.poisoned}^`;
  return (
    `Para soltar: (a) SEGREDO DE VERDADE — tire do HEAD os commits não publicados que o achado aponta ` +
    `(\`${undo}\` volta ao que origin já tem, com as mudanças staged; apague o segredo e commite de novo) — ` +
    `consertar para a frente não solta, a história levaria o segredo; (b) FALSO-POSITIVO confirmado — ` +
    `\`${at} update-ref ${PUSH_ACK_REF} ${hold.poisoned}\` aceita os achados até esse commit (o próximo scan começa depois dele).`
  );
}

/** Texto do motivo de uma retenção persistida — com os dois jeitos de soltá-la. */
export function pushHoldReason(branch: string, hold: { poisoned: string; base: string | null }, top?: string | null): string {
  return (
    `push para origin/${branch} RETIDO: o commit local ${hold.poisoned.slice(0, 12)} não pode ser publicado ` +
    `(secret-scan reprovou ou o desfazer não o tirou do HEAD). ${pushHoldHowTo(hold, top)}`
  );
}

/**
 * O portão de todo push: devolve o MOTIVO (e o push não sai) ou `null` (pode publicar). Ver o bloco acima.
 * Sem remoto `origin` não há o que publicar (o push falha sozinho) ⇒ não varre.
 */
export async function prePushGate(git: GitRunner, branch: string, scan: PrePushScan, cwd?: string): Promise<string | null> {
  return (await prePushGateAt(git, branch, scan, cwd)).held;
}

/**
 * {@link prePushGate} com o SHA que ele varreu: `held` = o motivo (o push não sai); senão `sha` é a ponta do range
 * varrido — o chamador publica ESTE sha ({@link pushTarget}), nunca um `HEAD` resolvido depois do scan. `sha: null`
 * só sem `origin` (nada a publicar) ou com o HEAD ilegível (o push cai no `HEAD` simbólico, como antes).
 */
/** O veredito de {@link prePushGateAt}: retido (`held` = o motivo) ou liberado com o sha varrido. */
export type PrePushGateResult = { held: string; sha?: undefined } | { held: null; sha: string | null };

export async function prePushGateAt(git: GitRunner, branch: string, scan: PrePushScan, cwd?: string): Promise<PrePushGateResult> {
  const topRes = await git(`rev-parse --show-toplevel`, cwd);
  const top = topRes.ok ? topRes.stdout.trim() || null : null;
  const hold = await readPushHold(git, cwd);
  if (hold) {
    if (await pushHoldActive(git, hold, cwd)) return { held: pushHoldReason(branch, hold, top) };
    await clearPushHold(git, cwd); // o operador tirou o commit envenenado, aceitou o falso-positivo, ou o HEAD voltou à base
  }
  if (!(await git(`remote get-url origin`, cwd)).ok) return { held: null, sha: null };
  const headRaw = (await git(`rev-parse HEAD`, cwd)).stdout.trim();
  const sha = isSha(headRaw) ? headRaw : null;
  const range = await prePushRange(git, branch, cwd, sha ?? "HEAD");
  let blocked: { internalError: boolean; detail: string } | null;
  try {
    blocked = await scan(range);
  } catch (err) {
    blocked = { internalError: true, detail: String(err instanceof Error ? err.message : err) };
  }
  if (!blocked) return { held: null, sha };
  if (blocked.internalError) {
    // Só o ACHADO persiste: um erro interno (timeout, maxBuffer) também recusa ESTE push (fail-closed), mas o
    // próximo push varre de novo — persistir travaria a publicação num tropeço transitório até alguém intervir.
    return {
      held: `secret-scan pré-push FALHOU (erro interno do scanner) sobre ${range} em ${branch} — fail-closed, push retido (o próximo push varre de novo): ${blocked.detail}`,
    };
  }
  // A base da retenção é a BASE do range (o que origin já tem, ou o último aceite): voltar o HEAD a ela tira TODO
  // commit varrido — o achado pode estar em qualquer um deles, não só no último.
  const rangeBase = range.slice(0, range.indexOf(".."));
  const holdBase = isSha(rangeBase) && rangeBase !== EMPTY_TREE ? rangeBase : null;
  await setPushHold(git, holdBase, cwd, sha ?? undefined);
  const poisoned = sha ?? (await readPushHold(git, cwd))?.poisoned ?? null;
  return {
    held:
      `secret-scan pré-push DETECTOU secret em commit local não publicado (${range}, por commit, diff e mensagens) em ${branch}: ${blocked.detail}` +
      (poisoned ? ` — ${pushHoldHowTo({ poisoned, base: holdBase }, top)}` : ""),
  };
}
