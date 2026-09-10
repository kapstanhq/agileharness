// branch GC — HARVEST the preserved run branches (conflicted/run/*, failed/run/*, orphan run/*) whose
// work is provably not at risk, and raise a stale advisory (never delete) for anything uncertain.
//
// Runs IN-PROCESS in the recovery-sweep tick (idle-gated so its git subprocesses never fight the merge
// train). It used to prove "integrated" with `merge-base --is-ancestor` against main/stage — the SAME
// topological blindness that made /processes cry wolf: a run branch is cut from `stage`, so it is never
// an ancestor of main, and code that reached main by SURGICAL cherry-pick gets a new sha (no ancestry)
// AND a new patch-id (rebased context). Under that test almost nothing ever qualified as integrated, so
// the GC harvested nothing and 23 branches piled up — the "lixo imortal".
//
// It now shares the ONE verdict the /processes panel renders (classifyPreservedBranch): the run's own
// work measured from its reflog cut point, cherry-picks acquitted by content, conflicted snapshots of
// finished cards recognised as redrive losers. HARVEST exactly the SUPERSEDED verdicts (integrated /
// stale-board-data / superseded-by-redrive) once older than the window; everything else is KEPT, and a
// non-superseded branch older than the stale window raises a one-time advisory. A verdict this cannot
// establish (`unknown`) is never harvested — fail closed.
//
// WS-5.4 (storymap-parallel-work): the fail-closed code guard below (`keep-unmerged-code`) proves safety by
// ANCESTRY, which is exactly the blindness described above — so a branch whose code reached main/stage by
// cherry-pick or squash is kept FOREVER, immortal garbage by a different door. The convergence primitive
// (convergence.ts) answers the same question by CONTENT: a branch whose own work (`cut-point..branch`) is
// `landed` in main OR stage may be harvested (`harvested-landed-content`). `partial`/`unknown` keep it —
// only POSITIVE proof releases a code branch, never a guess.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { Landedness } from "./convergence";
import type { PreservedBranch } from "./preserved-branches";

export type BranchGcAction =
  | "harvest"
  | "keep"
  | "stale-advisory"
  | "keep-unmerged-code"
  /** WS-5.4 — harvested because its own work is provably in main/stage BY CONTENT (cherry-pick/squash),
   *  which ancestry alone could never see. A distinct action (not plain `harvest`) so the journal says
   *  WHICH proof released the branch. */
  | "harvested-landed-content"
  /** F0 (ADR-067) — o branch SERIA apagado, e não foi, porque `AGILEHARNESS_REAPER_MODE=report` está
   *  ligado. Ação distinta pelo mesmo motivo das outras: o journal precisa dizer POR QUE a linha existe,
   *  e "o freio estava puxado" é um desfecho diferente de "decidi manter". A alternativa era um
   *  `as never` no call-site — e silenciar o compilador exatamente onde o freio de segurança deposita a
   *  prova é o pior lugar possível para fazê-lo (achado de revisão). */
  | "reaper-report-only"
  /** Colhida porque é uma TENTATIVA PERDEDORA de um card que PROVADAMENTE entregou: o redrive a
   *  substituiu, o card é terminal, e o delta PRÓPRIO do card (`commitRange`/`diffSnapshot`) mede
   *  `landed`. Ação distinta das irmãs pelo mesmo motivo delas: o journal tem de dizer QUAL prova
   *  soltou a branch — aqui a prova é sobre o CARD, não sobre a branch. */
  | "harvested-card-delivered";

/** Harvest a SUPERSEDED preserved branch only after it has been idle this many days (a grace window in
 *  case a human wanted to eyeball it first). */
export const BRANCH_GC_HARVEST_AFTER_DAYS = 7;
/** A non-superseded branch older than this raises a stale advisory (visibility only; NEVER deleted). */
export const BRANCH_GC_STALE_AFTER_DAYS = 30;

/**
 * PURE classification over the shared verdict.
 *   WS-2.3 FAIL-CLOSED (autonomy-reliability): a branch that carries CODE (`touchesCode`) whose code is NOT
 *     provably on main/stage (`codeIntegrated === false`) is NEVER harvested — verdict `keep-unmerged-code`.
 *     This is the belt over the verdict's suspenders: a `superseded-by-redrive` snapshot whose code never
 *     reached either branch (the qb8z2c loss vector — the ONLY copies of the fix live in conflicted/run/*)
 *     would otherwise be `superseded: true` → harvested → PERMANENT loss. Only topological/content
 *     integration into main/stage releases a code branch to the GC.
 *   WS-5.4: `contentLanded` (own work provably in main/stage BY CONTENT — convergence.ts) RELEASES a branch
 *     the ancestry check could not clear, and is itself proof that nothing is lost ⇒ `harvested-landed-content`
 *     once past the SAME grace window. It is consulted FIRST because it is the STRONGEST evidence here: it
 *     answers the question `codeIntegrated` only approximates. Absent/false ⇒ no effect (it can only acquit).
 *   superseded (nothing un-integrated is lost) + older than harvestAfterDays ⇒ harvest.
 *   NOT superseded + older than staleAfterDays ⇒ stale advisory (unique/uncertain work → keep, flag).
 *   everything else ⇒ keep.
 * A non-superseded branch is NEVER harvested regardless of age — that includes `unknown` (fail closed).
 * `touchesCode`/`codeIntegrated` are optional: absent ⇒ the code guard is OFF (the pre-WS-2.3 behavior,
 * for callers/tests that don't compute integration). runBranchGc supplies them from the injected check.
 */
export function classifyBranch(
  b: {
    superseded: boolean;
    ageDays: number;
    touchesCode?: boolean;
    codeIntegrated?: boolean;
    /** WS-5.4: deltaLanded(cut-point..branch, main|stage) === "landed" — POSITIVE proof, never a guess. */
    contentLanded?: boolean;
    /**
     * O CARD desta tentativa perdedora ENTREGOU, provadamente: verdict `superseded-by-redrive` (que já
     * exige `cardTerminal || !cardExists`) **E** o delta próprio do card (`commitRange`/`diffSnapshot`,
     * medido por `rangeLandedBySplit`) veio `landed`. Só o chamador sabe disto — ele tem o card.
     */
    cardDelivered?: boolean;
  },
  opts: { harvestAfterDays: number; staleAfterDays: number },
): BranchGcAction {
  if (b.contentLanded) return b.ageDays > opts.harvestAfterDays ? "harvested-landed-content" : "keep";
  // ── A tentativa perdedora de um card que ENTREGOU ────────────────────────────────────────────────
  //
  // Precede o guard fail-closed abaixo DE PROPÓSITO, e este é o ponto inteiro da regra.
  //
  // O guard (`touchesCode && !codeIntegrated`) nasceu do incidente qb8z2c: um snapshot
  // `superseded-by-redrive` cujo código nunca chegou a main nem a stage seria colhido e as ÚNICAS
  // cópias do fix morreriam com ele. O medo é legítimo e continua valendo — mas ele é sobre o CARD, não
  // sobre a branch: "o card terminou" nunca provou "o trabalho do card aterrissou" (foi exatamente o
  // falso-done que custou ~US$13 em reimplementação).
  //
  // O que mudou é que agora existe régua para a pergunta certa. `superseded-by-redrive` já garante que
  // o card é terminal e que um redrive substituiu esta tentativa; somando a prova de CONTEÚDO de que o
  // delta do card aterrissou, a tentativa perdedora é demonstravelmente descartável — não por
  // suposição, por medição. Sem essa prova (`absent`/`partial`/`unknown`/card sem range), NADA muda: o
  // guard segura como sempre segurou.
  //
  // Medido em 2026-07-27: 9 das 18 branches presas caem aqui, e TRÊS delas são as tentativas perdedoras
  // do próprio qb8z2c — o guard estava preservando a evidência do incidente que ele existe para
  // prevenir, muito depois de o incidente estar resolvido, porque a régua dele é ancestralidade (cega a
  // cherry-pick/squash) e não convergência.
  if (b.cardDelivered) return b.ageDays > opts.harvestAfterDays ? "harvested-card-delivered" : "keep";
  if (b.touchesCode && b.codeIntegrated === false) return "keep-unmerged-code"; // never harvest un-integrated code
  if (b.superseded) return b.ageDays > opts.harvestAfterDays ? "harvest" : "keep";
  return b.ageDays > opts.staleAfterDays ? "stale-advisory" : "keep";
}

/** Days since a branch's tip commit (unix seconds). null when unknown or clock-skewed into the future. */
export function ageDaysFromUnix(committerUnix: number | null, now: number): number | null {
  if (committerUnix == null || !Number.isFinite(committerUnix)) return null;
  const days = (now - committerUnix * 1000) / 86_400_000;
  return days >= 0 ? days : null; // future-dated (clock skew) → unknown, never harvest
}

export interface BranchGcJournalEntry {
  at: string;
  branch: string;
  action: BranchGcAction;
  ageDays: number;
  verdict: PreservedBranch["verdict"];
  superseded: boolean;
  deleted: boolean;
}

export interface BranchGcDeps {
  /** the shared classifier over EVERY preserved branch (failed/* + conflicted/* + orphan run/*). */
  listPreserved: () => Promise<PreservedBranch[]>;
  /** age (in days) of a branch's tip — injected so the decision stays pure/testable. */
  ageDaysOf: (branch: string) => Promise<number | null>;
  /** delete a harvested branch (`git branch -D`); returns whether it actually went. */
  deleteBranch: (branch: string) => Promise<boolean>;
  /** epoch ms now (injected for determinism). */
  now: number;
  /** default TRUE: log the plan, delete NOTHING. Flip via AGILEHARNESS_BRANCH_GC_ENABLED (see instrumentation). */
  dryRun: boolean;
  harvestAfterDays?: number;
  staleAfterDays?: number;
  /** record harvests + NEW stale advisories (append to branch-gc.jsonl in prod; a collector in tests). */
  journal: (entry: BranchGcJournalEntry) => void | Promise<void>;
  /** advisories already journaled this process — so a repeating tick doesn't re-log the SAME advisory
   *  10 times an hour forever (the old GC wrote 2480 duplicate lines). A Set the caller keeps alive.
   *  WS-2.3: also dedupes the `keep-unmerged-code` journal line (same lifetime, same repeat problem). */
  advisedThisRun?: Set<string>;
  /** WS-2.3 (autonomy-reliability): "is this branch's CODE provably on main OR stage?" — the topological
   *  ancestor check the GC uses to FAIL-CLOSED on un-integrated code. Injected (read-only git); ABSENT ⇒
   *  the code guard is OFF (pre-WS-2.3 behavior). Consulted ONLY for `touchesCode` branches whose verdict
   *  is not already "integrated" (content-acquitted) → at most one is-ancestor per stuck code branch. */
  codeReachedMainOrStage?: (branch: string) => Promise<boolean>;
  /** WS-5.4: "is this branch's own work (`cut-point..branch`) contained in main OR stage BY CONTENT?" —
   *  the shared convergence ruler (convergence.ts `deltaLanded`), which sees the cherry-pick/squash that
   *  ancestry structurally cannot. Injected (read-only git); ABSENT ⇒ the content path is OFF (pre-WS-5.4
   *  behavior — a cherry-picked code branch stays `keep-unmerged-code`). Consulted ONLY for a code branch
   *  the CHEAPER ancestry check already failed to clear → at most one convergence probe per stuck branch,
   *  and never for a branch already being kept for other reasons. Only `landed` releases it; anything else
   *  (including a thrown probe) keeps the branch — fail-closed, unchanged. */
  contentLandedInMainOrStage?: (branch: string) => Promise<Landedness>;
  /**
   * "O CARD desta branch entregou, provadamente?" — consultado SOMENTE para um snapshot
   * `superseded-by-redrive` que as duas provas anteriores não soltaram. Um `git` a mais por branch
   * presa, e só uma vez cada.
   *
   * A implementação de produção é `expectedDeltaOf(card)` + `rangeLandedBySplit` (a MESMA primitiva de
   * convergência que o deploy-reconcile usa para a classe data-only) — nunca uma régua nova: duas
   * réguas para uma pergunta é a classe de bug que o canário do rosto documenta.
   * AUSENTE ⇒ a regra fica DESLIGADA e o guard fail-closed segue igual. Erro/rejeição ⇒ `false`.
   */
  cardDeliveredLanded?: (b: PreservedBranch) => Promise<boolean>;
}

/**
 * Sweep the preserved run branches once: classify each via the shared verdict, delete the aged-out
 * SUPERSEDED ones (unless dryRun), journal every harvest + each NEW stale advisory. Tolerant — one
 * branch's git hiccup skips it, never throws. Returns the journal entries (for tests + the tick log).
 */
export async function runBranchGc(deps: BranchGcDeps): Promise<BranchGcJournalEntry[]> {
  const harvestAfter = deps.harvestAfterDays ?? BRANCH_GC_HARVEST_AFTER_DAYS;
  const staleAfter = deps.staleAfterDays ?? BRANCH_GC_STALE_AFTER_DAYS;
  const advised = deps.advisedThisRun ?? new Set<string>();

  const preserved = await deps.listPreserved().catch(() => [] as PreservedBranch[]);

  const out: BranchGcJournalEntry[] = [];
  for (const b of preserved) {
    let ageDays: number | null;
    try {
      ageDays = await deps.ageDaysOf(b.branch);
    } catch {
      continue; // couldn't date it → conservative skip
    }
    if (ageDays == null) continue;

    // WS-2.3: is the branch's CODE safe (already on main/stage)? Only ask for CODE branches not already
    // content-acquitted ("integrated"). Absent dep ⇒ assume integrated (guard OFF, pre-WS-2.3). Any error
    // in the check ⇒ NOT integrated (fail-closed — a code branch we can't clear is never harvested).
    let codeIntegrated = true;
    let contentLanded = false;
    if (b.touchesCode && b.verdict !== "integrated") {
      codeIntegrated = deps.codeReachedMainOrStage
        ? await deps.codeReachedMainOrStage(b.branch).catch(() => false)
        : true;
      // WS-5.4: ancestry said no — but a cherry-pick/squash has no ancestry, so ask the ONE ruler that
      // measures CONTENT before condemning the branch to `keep-unmerged-code` forever. Only "landed"
      // (positive proof) counts; "partial"/"absent"/"unknown"/a thrown probe all keep it (fail-closed).
      if (!codeIntegrated && deps.contentLandedInMainOrStage) {
        const verdict = await deps.contentLandedInMainOrStage(b.branch).catch((): Landedness => "unknown");
        contentLanded = verdict === "landed";
      }
    }

    // A terceira prova, e a mais estreita: só para o snapshot que o redrive já superou (verdict
    // `superseded-by-redrive` ⇒ o card é terminal por construção) e que as duas anteriores não
    // soltaram. Qualquer outra branch nunca chega a fazer esta pergunta.
    let cardDelivered = false;
    if (!contentLanded && b.verdict === "superseded-by-redrive" && deps.cardDeliveredLanded) {
      cardDelivered = await deps.cardDeliveredLanded(b).catch(() => false);
    }

    const action = classifyBranch(
      { superseded: b.superseded, ageDays, touchesCode: b.touchesCode, codeIntegrated, contentLanded, cardDelivered },
      { harvestAfterDays: harvestAfter, staleAfterDays: staleAfter },
    );
    if (action === "keep") continue;
    // A stale advisory / kept-unmerged-code line repeats every tick for the branch's whole life — journal
    // it ONCE per process (both share the same repeat problem the `advised` set was built for).
    if (action === "stale-advisory" || action === "keep-unmerged-code") {
      if (advised.has(b.branch)) continue;
      advised.add(b.branch);
    }

    let deleted = false;
    if ((action === "harvest" || action === "harvested-landed-content" || action === "harvested-card-delivered") && !deps.dryRun) {
      deleted = await deps.deleteBranch(b.branch).catch(() => false);
    }

    const entry: BranchGcJournalEntry = {
      at: new Date(deps.now).toISOString(),
      branch: b.branch,
      action,
      ageDays: Math.floor(ageDays),
      verdict: b.verdict,
      superseded: b.superseded,
      deleted,
    };
    await deps.journal(entry);
    out.push(entry);
  }
  return out;
}

/** Production helper: age of a branch tip in days via `git log -1 --format=%ct`. null on any failure. */
export function makeAgeDaysOf(
  exec: (cmd: string, opts: { cwd: string; timeout?: number }) => Promise<{ stdout: string | Buffer }>,
  repoRoot: string,
  now: number,
): (branch: string) => Promise<number | null> {
  return async (branch: string) => {
    try {
      const { stdout } = await exec(`git log -1 --format=%ct ${JSON.stringify(branch)}`, { cwd: repoRoot, timeout: 15_000 });
      const ct = Number(String(stdout).trim());
      return ageDaysFromUnix(Number.isFinite(ct) ? ct : null, now);
    } catch {
      return null;
    }
  };
}

/**
 * A linha que o MODO RELATÓRIO produz (F0 · ADR-067). Tipo PRÓPRIO, e não um `BranchGcJournalEntry`
 * com campos inventados: no ponto em que o freio intercepta, o call-site tem o branch e o instante, não
 * o veredito nem a idade — que são calculados dentro do `runBranchGc`. A versão anterior forjava esses
 * campos com um `as never`, e silenciar o compilador exatamente onde o freio de segurança deposita a
 * prova é o pior lugar possível para fazê-lo (achado de revisão). Quem lê o journal distingue as duas
 * formas pelo `action`.
 */
export interface BranchGcReportOnlyEntry {
  at: string;
  branch: string;
  action: "reaper-report-only";
  /** o ponto da linha: o branch SERIA apagado e não foi, porque o freio estava puxado. */
  deleted: false;
}

/** Production journal sink — append one JSONL line to storymap/.runner/branch-gc.jsonl. Best-effort. */
export async function appendBranchGcJournal(entry: BranchGcJournalEntry | BranchGcReportOnlyEntry): Promise<void> {
  try {
    await fsp.appendFile(path.join(runnerStateDir(), "branch-gc.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn("[branch-gc] journal append falhou:", err instanceof Error ? err.message : err);
  }
}
