// board-data-flush (#2) — a DEBOUNCED, scoped commit+push of live board data (`storymap/boards/**`).
//
// The strategy bancada (AssistedEditor → approve/reject governance), the card writes (updateCardOnDisk / writeCard —
// every status move, finding and deploy stamp the service makes) and the other board-data write actions
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

import { type QuarantinedFile } from "./board-quarantine";
import { serialCommit } from "./commit-serializer";
import { elideCredentialBytes, upsertFindingIfChanged } from "./findings";
import { quote } from "./git";
import { defaultExec, defaultWorktreeOps } from "./worktree";
import { findRepoRoot } from "@/lib/storymap/paths";
import type { Finding } from "@/lib/storymap/types";
// A política de versionamento (commitar? empurrar? este processo pode?) — ver board-data-policy.ts
// para o porquê de as três perguntas serem separadas.
import { isBoardDataWriterArmed, planBoardDataFlush } from "./board-data-policy";

// Quiet window before a flush fires. Coalesces a burst of edits (approve N changes, edit M cards) into one
// commit. Tunable via env for the VPS; a floor keeps it from degenerating into a per-edit commit storm.
const DEBOUNCE_MS = Math.max(1000, Number(process.env.AGILEHARNESS_BOARD_FLUSH_MS) || 5000);
// O TETO da espera. Um debounce puro rearma o timer a cada escrita: com escritas mais frequentes que a janela quieta ele
// NUNCA dispara (starvation). Num caso real, o laço de publicação escrevia um card a cada poucos segundos por horas e o
// versionamento não rodou uma vez. Com o teto, uma rajada contínua é versionada no mais tardar a cada `MAX_WAIT_MS`.
// Derivado do knob que JÁ existe (12× a janela quieta = 60 s no default): escala junto com ele, sem uma segunda variável
// de ambiente para o operador aprender e para o catálogo documentar.
const MAX_WAIT_MS = DEBOUNCE_MS * 12;
// Falha transitória (index.lock disputado com o train, um git ocupado): volta a tentar sozinho, em vez de esperar um
// próximo write que pode não vir — o card ficaria sujo no disco até alguém mexer de novo.
const RETRY_MS = 30_000;
const MAX_RETRIES = 4;
const FLUSH_MESSAGE = "board: estado vivo (bancada)";

/**
 * Quanto esperar antes do próximo disparo: a janela quieta, mas nunca além do teto contado desde o PRIMEIRO write da
 * rajada. PURA.
 */
export function nextFlushDelayMs(burstStartedAt: number, now: number, debounceMs: number, maxWaitMs: number): number {
  return Math.max(0, Math.min(debounceMs, burstStartedAt + maxWaitMs - now));
}

export interface FlushSchedulerDeps {
  debounceMs: number;
  maxWaitMs: number;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** o trabalho do disparo (fire-and-forget: o agendador não espera nem propaga erro) */
  fire(): void;
}

/** O agendador do flush — debounce COM teto. Separado do módulo para ser testável com relógio e timers injetados. */
export function createFlushScheduler(deps: FlushSchedulerDeps): { schedule(): void; pending(): boolean } {
  let handle: unknown = null;
  let burstStartedAt: number | null = null;
  return {
    schedule() {
      const now = deps.now();
      burstStartedAt ??= now;
      if (handle !== null) deps.clearTimer(handle);
      handle = deps.setTimer(() => {
        handle = null;
        burstStartedAt = null;
        deps.fire();
      }, nextFlushDelayMs(burstStartedAt, now, deps.debounceMs, deps.maxWaitMs));
    },
    pending: () => handle !== null,
  };
}

// ── QUARENTENA (WP5-F1) — o ACHADO ────────────────────────────────────────────────────────────────────────
//
// O flush era tudo-ou-nada: UM arquivo que o secret-scan recusava travava a versão do board INTEIRO (dezenas de vezes,
// um identificador longo em crase que um agente escreveu no corpo de um card). O isolamento em si mora no commit
// de board-data (commitBoardDataScoped → board-quarantine.ts), o ponto único por onde passam também as fronteiras do
// engine e do train; este módulo é o dono só do AVISO: o card em quarentena ganha um achado dizendo o que o scanner
// apontou, e o achado fecha sozinho quando o card volta limpo e é versionado. O scan NÃO afrouxa.

/** O id do achado de quarentena no card — um por card, reescrito no lugar. */
export const QUARANTINE_FINDING_ID = "board-data-quarantine";
const CARD_PATH_RE = /^storymap\/boards\/([^/]+)\/cards\/([^/]+)\.md$/;

/** PURA — o achado que o card em quarentena carrega. `line` sai da primeira citação `<caminho>:<linha>`. */
export function quarantineFinding(q: QuarantinedFile): Finding {
  const at = q.detail.indexOf(`${q.path}:`);
  const line = at >= 0 ? Number(/^\d+/.exec(q.detail.slice(at + q.path.length + 1))?.[0]) : NaN;
  return {
    id: QUARANTINE_FINDING_ID,
    lens: "security",
    severity: "high",
    title: "card fora do versionamento: o secret-scan recusou um trecho dele",
    detail: elideCredentialBytes(
      "O scanner de segredos do repositório recusou este card, então ele ficou FORA do commit do board (o resto foi " +
        "versionado) e, até sair de lá, o conteúdo dele só existe no disco. Conserto: tire do card o valor apontado " +
        "(ou reescreva o trecho para não ter a forma de credencial) — o próximo flush versiona o card e fecha este achado.\n" +
        q.detail,
    ).slice(0, 600),
    file: q.path,
    ...(Number.isFinite(line) && line > 0 ? { line } : {}),
    status: "open",
  };
}

/** Quem fecha o achado sozinho quando o card volta limpo — o carimbo que separa «fechado pelo flush» de «triado». */
const QUARANTINE_CLOSER = "board-flush";

/**
 * WP5-F2 — os achados do card depois de uma quarentena, ou null (nada a escrever). PURA. A comparação de
 * `upsertFindingIfChanged` inclui o `status`: um achado que o DONO triou (aceitou o risco, `wontfix`) voltava a
 * `open` no flush seguinte, sem nada novo. Agora a triagem humana do MESMO achado (mesmo texto do scanner) é
 * respeitada; um achado fechado pelo próprio flush (o card voltou limpo e saiu de novo) ou um trecho NOVO reabre.
 */
export function quarantineFindingUpdate(findings: readonly Finding[], q: QuarantinedFile): Finding[] | null {
  const next = quarantineFinding(q);
  const cur = findings.find((f) => f.id === QUARANTINE_FINDING_ID);
  const triaged = cur && cur.status !== "open" && cur.statusBy !== QUARANTINE_CLOSER;
  if (triaged && (cur.detail ?? "") === (next.detail ?? "")) return null;
  return upsertFindingIfChanged([...findings], next);
}

/**
 * WP5-F2 — os caminhos dos cards com achado de quarentena ABERTO. PURA. Semeia, uma vez por processo, o conjunto que
 * o flush acompanha: antes ele só existia na memória de quem pôs em quarentena, e depois de um restart o achado de um
 * card que já tinha sido limpo nunca fechava.
 */
export function openQuarantinePaths(boards: ReadonlyArray<{ id: string; cards: ReadonlyArray<{ id: string; findings?: readonly Finding[] }> }>): string[] {
  const out: string[] = [];
  for (const b of boards) {
    for (const c of b.cards) {
      const f = c.findings?.find((x) => x.id === QUARANTINE_FINDING_ID && x.status === "open");
      if (f) out.push(f.file && CARD_PATH_RE.test(f.file) ? f.file : `storymap/boards/${b.id}/cards/${c.id}.md`);
    }
  }
  return out;
}

/** Os caminhos em quarentena que o flush acompanha até verem versionados — para fechar o achado quando saírem. */
const inQuarantine = new Set<string>();
/** O conjunto acima já foi semeado pelos achados abertos no disco (uma vez por processo)? */
let quarantineSeeded = false;

async function seedQuarantineFromDisk(): Promise<void> {
  if (quarantineSeeded) return;
  quarantineSeeded = true;
  try {
    const { listBoards, readCards } = await import("@/lib/storymap/repo");
    const boards: Array<{ id: string; cards: Awaited<ReturnType<typeof readCards>> }> = [];
    for (const b of await listBoards()) boards.push({ id: b.id, cards: await readCards(b.id).catch(() => []) });
    for (const p of openQuarantinePaths(boards)) inQuarantine.add(p);
  } catch (err) {
    console.error("[board-flush] semear a quarentena a partir do disco falhou (não-fatal):", err instanceof Error ? err.message : err);
  }
}

/** Grava (ou mantém) o achado de quarentena no card. Arquivo que não é card só é registrado no log. Nunca lança. */
async function flagQuarantined(q: QuarantinedFile): Promise<void> {
  const m = CARD_PATH_RE.exec(q.path);
  if (!m) {
    console.error(`[board-flush] QUARENTENA: ${q.path} ficou fora do commit (secret-scan): ${q.detail.slice(0, 200)}`);
    return;
  }
  try {
    // import tardio: write.ts importa este módulo (o agendador do flush) — o ciclo não pode existir na carga
    const { updateCardOnDisk } = await import("@/lib/storymap/write");
    await updateCardOnDisk(m[1], m[2], (card) => {
      const findings = quarantineFindingUpdate(card.findings ?? [], q);
      return findings ? { ...card, findings } : null; // idêntico ou triado ⇒ sem escrita (sem laço escrita→flush)
    });
  } catch (err) {
    console.error(`[board-flush] achado de quarentena em ${q.path} falhou (não-fatal):`, err instanceof Error ? err.message : err);
  }
}

/** O arquivo saiu da quarentena (versionado limpo): o achado vira `fixed`. Nunca lança. */
async function clearQuarantined(relPath: string): Promise<void> {
  const m = CARD_PATH_RE.exec(relPath);
  if (!m) return;
  try {
    const { updateCardOnDisk } = await import("@/lib/storymap/write");
    const today = new Date().toISOString().slice(0, 10);
    await updateCardOnDisk(m[1], m[2], (card) => {
      if (!(card.findings ?? []).some((f) => f.id === QUARANTINE_FINDING_ID && f.status === "open")) return null;
      return {
        ...card,
        findings: (card.findings ?? []).map((f) =>
          f.id === QUARANTINE_FINDING_ID && f.status === "open" ? { ...f, status: "fixed" as const, statusBy: QUARANTINE_CLOSER, statusAt: today } : f,
        ),
      };
    });
  } catch (err) {
    console.error(`[board-flush] fechar o achado de quarentena de ${relPath} falhou (não-fatal):`, err instanceof Error ? err.message : err);
  }
}

let flushing = false;
let rearm = false;
let retries = 0;

const scheduler = createFlushScheduler({
  debounceMs: DEBOUNCE_MS,
  maxWaitMs: MAX_WAIT_MS,
  now: Date.now,
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.(); // never holds the process open
    return t;
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  fire: () => void runFlush(),
});

/**
 * (Re)arm the debounced board-data flush. Cheap + synchronous — safe to call fire-and-forget from any
 * server action after it writes board data. No-op under test (VITEST) so unit tests never shell out to git.
 * The timer is unref'd: it never holds the process open (a pending flush at shutdown is simply skipped —
 * the next boot/run commits the same delta, since it is read from disk, not from this timer's memory).
 */
export function scheduleBoardDataFlush(): void {
  if (process.env.VITEST) return;
  // Auditoria — DUAS travas antes do timer, e as duas faltavam.
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
  scheduler.schedule();
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
    retries = 0;
    if (res.committed) {
      const destino = empurrar ? `push ${res.pushed ? "ok" : "falhou (não-fatal)"}` : "local (push desligado)";
      console.log(`[board-flush] board data versionada (${FLUSH_MESSAGE}); ${destino}`);
    }
    // Fora do serializador: o achado é uma escrita de card (o lock do card, não o do índice).
    const git = (args: string) => defaultExec(`git ${args}`, { cwd: repoRoot, timeout: 30_000 });
    const quarantined = res.quarantined ?? [];
    const now = new Set(quarantined.map((q) => q.path));
    await seedQuarantineFromDisk();
    for (const q of quarantined) {
      inQuarantine.add(q.path); // o commit já registrou a quarentena no journal; aqui é o achado no card
      await flagQuarantined(q);
    }
    for (const p of [...inQuarantine]) {
      if (now.has(p)) continue;
      const pending = await git(`status --porcelain -- ${quote(p)}`).then((r) => r.stdout.trim(), () => "?");
      if (pending !== "") continue; // ainda fora do git (ou ilegível): o achado fica
      inQuarantine.delete(p);
      await clearQuarantined(p);
    }
  } catch (err) {
    // Never throw to the caller — a board-data commit failure (secret-scan block, code-touching diff guard,
    // git outage) must not break the UI action that scheduled it. The next flush/run recovers the delta.
    console.error("[board-flush] flush falhou (não-fatal):", err instanceof Error ? err.message : err);
    if (retries < MAX_RETRIES) {
      retries += 1;
      const t = setTimeout(() => scheduleBoardDataFlush(), RETRY_MS * retries);
      t.unref?.();
    }
  } finally {
    flushing = false;
    if (rearm) {
      rearm = false;
      scheduleBoardDataFlush();
    }
  }
}
