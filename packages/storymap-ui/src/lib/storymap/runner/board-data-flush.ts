// board-data-flush (#2) — a DEBOUNCED, scoped commit+push of live board data (`storymap/boards/**`).
//
// The strategy bancada (AssistedEditor → approve/reject governance) and the other board-data write actions
// edit the board LIVE on disk (board.yaml + governance/*.json + cards) but do NOT commit — the versioning
// only happens later, when an autorun run settles a `board: estado vivo` commit. So a session that only edits
// strategy (no run) leaves the work uncommitted until something else happens to run, and a deploy pre-flight
// would have seen it as dirty (the recurring governance/ untracked gap).
//
// This closes it WITHOUT a per-action commit storm: any board-data write action can call
// scheduleBoardDataFlush(), which (re)arms a short debounce timer; the timer fires ONE scoped commit+push
// that coalesces every edit in the quiet window. It reuses the SAME machinery the engine's no-worktree
// settle uses — commitBoardStateAndPush (stages ONLY `storymap/boards/**`, aborts on a code-touching diff,
// fail-open push) routed through the per-cwd serialCommit mutex so it never races the engine/merge-train on
// `.git/index.lock`. Best-effort throughout: a failure logs and never throws to the caller.
//
// SERVER-ONLY (real git via defaultExec). Process-global singleton timer (one per server process).

import { serialCommit } from "./commit-serializer";
import { defaultWorktreeOps } from "./worktree";
import { findRepoRoot } from "@/lib/storymap/paths";
// A política de versionamento (commitar? empurrar? este processo pode?) — ver board-data-policy.ts
// para o porquê de as três perguntas serem separadas.
import { isBoardDataWriterArmed, planBoardDataFlush } from "./board-data-policy";

// Quiet window before a flush fires. Coalesces a burst of edits (approve N changes, edit M cards) into one
// commit. Tunable via env for the VPS; a floor keeps it from degenerating into a per-edit commit storm.
const DEBOUNCE_MS = Math.max(1000, Number(process.env.AGILEHARNESS_BOARD_FLUSH_MS) || 5000);
const FLUSH_MESSAGE = "board: estado vivo (bancada)";

let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let rearm = false;

/**
 * (Re)arm the debounced board-data flush. Cheap + synchronous — safe to call fire-and-forget from any
 * server action after it writes board data. No-op under test (VITEST) so unit tests never shell out to git.
 * The timer is unref'd: it never holds the process open (a pending flush at shutdown is simply skipped —
 * the next boot/run commits the same delta, since it is read from disk, not from this timer's memory).
 */
export function scheduleBoardDataFlush(): void {
  if (process.env.VITEST) return;
  // Auditoria 2026-08-19 — DUAS travas antes do timer, e as duas faltavam.
  //
  // (1) O motor INERTE não versiona. Até aqui o flush era o único efeito de escrita no repo que não
  //     passava pelo portão do boot: um servidor de validação, ou qualquer instância subida de dentro
  //     de um `git worktree`, commitava no repositório compartilhado. Era um defeito conhecido desta
  //     casa ("storymap em worktree auto-commita board-data") e a régua para fechá-lo já existia.
  // (2) Quem quiser a ferramenta como editor puro desliga o commit por declaração.
  //
  // As duas saem em silêncio de propósito: a edição JÁ está no disco e na tela; o que não acontece é
  // o versionamento, e um `console.warn` por tecla digitada não ajudaria ninguém.
  if (!planBoardDataFlush(process.env, isBoardDataWriterArmed()).versiona) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runFlush();
  }, DEBOUNCE_MS);
  timer.unref?.();
}

async function runFlush(): Promise<void> {
  // A flush already in flight → re-arm once after it settles, so an edit that landed mid-flush is not lost.
  if (flushing) {
    rearm = true;
    return;
  }
  flushing = true;
  try {
    const repoRoot = findRepoRoot();
    // serialCommit: share the per-cwd mutex with the engine's boundary commits + the merge train so this
    // never races them on `.git/index.lock`. commitBoardStateAndPush is scoped (only storymap/boards/**),
    // empty-diff-guarded (clean → no no-op commit), and fail-open on push.
    // EMPURRAR é uma decisão separada de COMMITAR: o push escreve num remoto que esta ferramenta não
    // escolheu — pode ser compartilhado, protegido, ou disparar CI na conta de outra pessoa. Sem a
    // declaração, versiona local e para aí (as duas operações já existem; o que muda é qual delas o
    // chamador escolhe, não um parâmetro novo no caminho de escrita).
    const plano = planBoardDataFlush(process.env, isBoardDataWriterArmed());
    if (!plano.versiona) return; // o env pode ter mudado entre o agendamento e o disparo
    const empurrar = plano.empurra;
    const res = await serialCommit(repoRoot, () =>
      empurrar
        ? defaultWorktreeOps.commitBoardStateAndPush(repoRoot, FLUSH_MESSAGE)
        : defaultWorktreeOps.commitBoardState(repoRoot, FLUSH_MESSAGE).then((r) => ({ ...r, pushed: false })),
    );
    if (res.committed) {
      const destino = empurrar ? `push ${res.pushed ? "ok" : "falhou (não-fatal)"}` : "local (push desligado)";
      console.log(`[board-flush] board data versionada (${FLUSH_MESSAGE}); ${destino}`);
    }
  } catch (err) {
    // Never throw to the caller — a board-data commit failure (secret-scan block, code-touching diff guard,
    // git outage) must not break the UI action that scheduled it. The next flush/run recovers the delta.
    console.error("[board-flush] flush falhou (não-fatal):", err instanceof Error ? err.message : err);
  } finally {
    flushing = false;
    if (rearm) {
      rearm = false;
      scheduleBoardDataFlush();
    }
  }
}
