// Entry effects (B3) — the side-effectful actions a card triggers when it ENTERS a step that
// declares an `onEnter` effect: `promote-stage` (publish staged code stage→main) and `deploy-board`
// (ship the released code to Live). Extracted from actions.ts so BOTH the human-move path
// (moveCardAction) AND the autorun cascade (autorun-eval `forward`) fire them through ONE dispatch —
// WITHOUT the autorun module importing actions.ts, which would be a cycle (actions.ts already imports
// evaluateAutorunOnEntry). Before this extraction the cascade silently advanced a card PAST
// release/deploy without ever promoting or deploying (it only wrote the new status).
//
// SERVER-ONLY (real git + deploy). Each effect is best-effort and never throws to its caller.

import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { promoteStageToMain, type PromoteResult } from "./release";
import { releaseCodePrefixes } from "./release-scope";
import { deployBoard, type DeployResult } from "./deploy";
import { getPendingSelfDeploy } from "./pending-self-deploy";
import { revertCardOnDeployFailure } from "./deploy-revert";
import { serialCommit } from "./commit-serializer";
import { integratedShas, liveWorkInRepo } from "./concurrent-work";
import { isLiveMergeStatus } from "./merge-status";
import { makeSessionStore, isSessionAlive } from "./session-worktree";
import { publishEmbargoTtlMs } from "./session-liveness";
import { getMergeQueue } from "./merge-queue";
import { defaultExec } from "./worktree";
import { loadRunnerConfig } from "./config";
import { climbLadder, isResolved, type ResolutionResult } from "./semantic-resolution";
import { makeJudgePort } from "./resolution-judge-spawn";
import { deltaLanded } from "./convergence";
import { findRepoRoot } from "@/lib/storymap/paths";
import { listBoards, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import type { EntryEffect } from "@/lib/storymap/types";

import { formatAnalysisText } from "@/lib/storymap/resolution-analysis";
import { resolvedClaudeBin } from "./claude-bin";

// A régua de "entrada VIVA no train" mora em `merge-status.ts`. Aqui havia uma cópia hardcoded da lista
// — uma de quatro; ver o cabeçalho de lá sobre por que isso é a mesma classe de defeito que já custou
// trabalho invisível nesta feature.

/**
 * story-5vv8n1 — the RELEASE decision the deploy/terminal gate reads. `fireReleaseStaged` returns this so
 * `firePromoteAndDeploy` can tell a legit no-op (deploy on, card stays terminal) from a real promotion
 * FAILURE (suppress deploy + revert the card) — instead of the old `void`+`console.log` that shipped a lie.
 */
export interface ReleaseOutcome {
  /** new code actually landed on main this run. */
  promoted: boolean;
  /** may the deploy proceed + the card stay in the optimistic terminal? (true for promote + legit no-ops). */
  deployable: boolean;
  /** the code is NOT live → the card must be reverted, never claim "No Ar". A real FAILURE (apply-failed,
   *  blocked, out-of-scope, no-prefix) or a deliberate DEFERRAL (`concurrent-work`, live work on the same
   *  files) — both leave main without the code, which is what the card must not lie about. `reason` tells
   *  the two apart for whoever reads it. */
  revert: boolean;
  /** the deploy is EXPECTED to do real work (new code was promoted) → a ~0s no-drift deploy is then a lie (t5). */
  expectWork: boolean;
  /** story-efwo30 — the files the release promoted to main, threaded to the deploy so it can decide whether
   *  to ALSO publish the mosaico.app merged web face (touchesComposedFace). Empty for a no-op/failed promote. */
  changedFiles: string[];
  outcome: PromoteResult["outcome"];
  reason?: string;
  /** Quem segura a publicação, quando `outcome === "concurrent-work"` — ver `PromoteResult.clashes`. É o
   *  que deixa a Entrega apontar a LINHA do bloqueador em vez de procurar o uuid dentro da frase. */
  heldBy?: string[];
}

/**
 * PURE — classify a promote result into the deploy/terminal decision. The ONLY place the `promoted:false`
 * ambiguity is resolved: idempotency + nothing-to-release are DEPLOYABLE no-ops; out-of-scope / apply-failed
 * / blocked / no-prefix are FAILURES that must revert the card. Exhaustive over PromoteOutcome (a new outcome
 * won't compile until it's classified here). Exported for tests.
 */
export function classifyRelease(r: PromoteResult): ReleaseOutcome {
  const base = {
    promoted: r.promoted,
    outcome: r.outcome,
    reason: r.reason,
    changedFiles: r.changedFiles ?? [],
    ...(r.clashes?.length ? { heldBy: r.clashes.map((c) => c.owner) } : {}),
  };
  switch (r.outcome) {
    case "promoted":
      return { ...base, deployable: true, revert: false, expectWork: true };
    case "already-promoted":
    case "nothing-staged":
      return { ...base, deployable: true, revert: false, expectWork: false };
    case "out-of-scope":
    case "apply-failed":
    case "blocked":
    case "no-prefix":
    // A fronteira de promoção estava à frente do que main realmente tem: o código segue staged e NÃO vivo.
    // Mesmo destino de `out-of-scope` (o irmão dele): não deployável e o card volta, porque deixá-lo
    // reivindicar "No Ar" com o código fora da main é exatamente o falso positivo que esses desfechos
    // existem para impedir.
    case "frontier-stale":
      return { ...base, deployable: false, revert: true, expectWork: false };
    // A publicação foi ADIADA porque outra sessão está viva nos mesmos arquivos. Nada quebrou e nada se
    // perdeu — mas o código NÃO está em main, então o card não pode reivindicar "No Ar": ele volta e
    // publica depois, quando aquele trabalho integrar. Compartilha o destino de uma falha (`revert`)
    // porque o que decide o retorno é "o código não está vivo", não "algo quebrou"; o `reason` é que
    // distingue um adiamento de um defeito para quem lê.
    case "concurrent-work":
      return { ...base, deployable: false, revert: true, expectWork: false };
  }
}

/**
 * story-4eqltw — the package prefix of every board EXCEPT `selfBoardId`, each normalized to a trailing slash.
 * Handed to promoteStageToMain as `otherBoardPrefixes` so the out-of-scope probe over the SHARED `stage` branch
 * EXCLUDES foreign-board code: each board promotes on its own frontier (refs/promoted/<board>), so another
 * board's un-promoted staged code (most often packages/storymap-ui/, the dev tool on its own cadence) is never
 * THIS release's scoping failure. The releasing board's OWN package is deliberately skipped — it must still
 * promote (and out-of-scope-detect) its own code. Best-effort: any read failure yields a smaller/empty set,
 * degrading to the pre-fix global probe — never throws (fireReleaseStaged is best-effort end to end).
 */
/**
 * board → prefixo do pacote dele, para a sonda de concorrência traduzir o board que uma sessão ADOTADA
 * declara no território que ela ocupa. Best-effort (um board ilegível some do mapa): a sonda é uma
 * proteção adicional, nunca um ponto de indisponibilidade.
 */
async function boardPackagePrefixes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const b of await listBoards().catch(() => [])) {
    const cfg = await readBoardConfig(b.id).catch(() => null);
    if (cfg?.package) out.set(b.id, `${cfg.package.replace(/\/+$/, "")}/`);
  }
  return out;
}

async function otherBoardPackagePrefixes(selfBoardId: string): Promise<string[]> {
  const boards = await listBoards().catch(() => []);
  const prefixes: string[] = [];
  for (const b of boards) {
    if (b.id === selfBoardId) continue; // never exclude the releasing board's own package
    const cfg = await readBoardConfig(b.id).catch(() => null);
    if (cfg?.package) prefixes.push(`${cfg.package.replace(/\/+$/, "")}/`);
    // story-zr1cmf — a board's declared deployable SURFACES (paths outside its `package`, e.g. the Caddy-served
    // web terminal) are ALSO its OWN release's concern on the shared `stage`. Exclude them here so THIS board's
    // empty release is never mis-flagged `out-of-scope` by another board's staged-but-unreleased surface — the
    // same false-revert the package exclusion (story-4eqltw) closes, extended to surfaces routed to stage.
    for (const s of cfg?.deploy?.surfaces ?? []) prefixes.push(`${s.prefix.replace(/\/+$/, "")}/`);
  }
  return prefixes;
}

/**
 * WS-10.4/D14 — render a per-hunk analysis into the operator-facing failure body. Plain text (not JSON): this
 * lands in a card finding / a revert reason a HUMAN reads. Deliberately leads with the verdict and the file —
 * the operator's first question is "which one is genuinely mine to decide?". PURE — exported for tests.
 */
export function formatAnalysis(a: ResolutionResult): string {
  // WS-10.5 — the wording (and the all-or-nothing rule it names) moved to the PURE `resolution-analysis`
  // module so Inbox's panel and this text render the SAME vocabulary. This module is server-only (git,
  // disk); the panel is a client surface — a shared module with zero imports is the only way both can read
  // one source. Signature and output unchanged; this stays the caller's entry point.
  return formatAnalysisText(a);
}

/**
 * WS-10.4 — climb the ladder for a release's `apply-failed`, and (only on a rung-2 resolution) make the
 * judge's artifact the new `stage` so the caller's RETRY is an ordinary release.
 *
 * The invariant-1 dance is the subtle part and it is deliberate: the judge NEVER writes to stage/main — it
 * commits its resolution to its OWN branch in its OWN worktree. What lands here is a `update-ref` of `stage`
 * to that branch, which is the NORMAL ref mechanism, followed by a re-run of the UNCHANGED
 * promoteStageToMain. So the resolved code still faces the real delta computation, the real `--3way`, the
 * real secret-scan and the real push. The judge moved a ref; it did not publish anything.
 *
 * Fail-closed + best-effort: any failure returns the analysis (or null) WITHOUT touching `stage`, and the
 * caller reports the original failure. NEVER throws.
 */
async function climbReleaseLadder(
  repoRoot: string,
  stageBranch: string,
  failed: PromoteResult,
): Promise<ResolutionResult | null> {
  const files = failed.divergentFiles ?? [];
  if (files.length === 0) return null;
  const enabled = loadRunnerConfig().autorun.mergeTrain?.semanticResolution ?? true;
  try {
    const result = await climbLadder(
      {
        exec: defaultExec,
        repoRoot,
        enabled,
        judge: makeJudgePort({ claudeBin: resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin }), exec: defaultExec, repoRoot }),
        deltaLandedFn: (o) => deltaLanded(defaultExec, repoRoot, o),
      },
      {
        // OURS = the released branch (what main holds NOW); THEIRS = stage (the incoming staged text). The
        // orientation matters: rung 1 resolves by KEEPING `ours`, and for a release "keep main" is exactly
        // right — main is live, and an equivalent-modulo-whitespace stage has nothing to add to it.
        sides: { ours: failed.branch, theirs: stageBranch, files },
        // BASE = a base do 3-way que REPROVOU (a fronteira da promoção), nunca `ours`: um diff gerado a
        // partir de `ours` aplica em `ours` por TAUTOLOGIA, então com `base: failed.branch` o juiz
        // respondia "o delta aplicou LIMPO na base atual — não há divergência a julgar" para TODO conflito
        // de release e escalava fail-closed sem nunca julgar (story-tlz0dt, 2026-07-21). O fallback para
        // `failed.branch` cobre só resultados legados sem o campo (o degrau 2 vira no-op honesto neles).
        base: failed.divergentBase ?? failed.branch,
        origin: "release",
        conflictDetail: failed.reason,
        // No `range` on purpose: the release's delta base is the board's promotion frontier, which is
        // release.ts's private business (spec §10.4: do NOT touch the delta mechanics). Rung 0 is therefore
        // skipped here — `already-promoted` ALREADY covers the converged case upstream (033ee72e6 returns it
        // before we could ever see `apply-failed`), so a rung 0 here would be a second ruler for a question
        // release.ts has already answered correctly.
      },
    );
    if (!isResolved(result.outcome) || !result.resolvedRef) return result;
    // Rung 2 resolved ⇒ o conteúdo julgado precisa chegar ao `stage` para que o RETRY do chamador seja uma
    // release comum. ENXERTAR, nunca APONTAR — ver graftResolvedFilesOntoStage.
    try {
      await graftResolvedFilesOntoStage(repoRoot, stageBranch, result.resolvedRef, files);
    } catch (err) {
      console.error(`[release] enxertar a resolução em ${stageBranch} falhou:`, err instanceof Error ? err.message : err);
      return { ...result, outcome: "judge-failed", detail: `${result.detail} — mas não foi possível levar a resolução para ${stageBranch}` };
    }
    return result;
  } catch (err) {
    console.error("[release] escada semântica falhou (não-fatal):", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Leva o conteúdo resolvido pelo juiz para o `stage` ENXERTANDO-O como um commit NOVO no topo do stage, e não
 * apontando o ref do stage para a árvore do juiz.
 *
 * POR QUE (defeito real, medido em produção 2026-07-20): a árvore do juiz é cortada de `ours` — a branch
 * RELEASED (main) — e recebe só os arquivos divergentes. Ela NÃO contém a história do stage. Um
 * `update-ref stage → essa árvore` portanto DESCARTA todo o código não-liberado de outros cards e sessões que
 * o stage carrega. No momento da medição o stage tinha 10+ commits não-liberados de dois pacotes distintos
 * (`packages/acmeapp` do card em conflito e `packages/storymap-ui` de seis sessões de agente) — resolver o
 * conflito de UM card teria apagado silenciosamente o trabalho de todos os outros. O `stage` é uma branch
 * COMPARTILHADA por todo o repo; nada que resolve um conflito de um board pode reescrevê-la por inteiro.
 *
 * O enxerto é plumbing pura (índice temporário + commit-tree): nunca toca o worktree do stage (a engrenagem
 * interna do merge train), não faz checkout, e produz UM commit cujo pai é o tip atual do stage — então toda
 * a história não-liberada sobrevive por construção. Só os `files` divergentes mudam; um arquivo que a
 * resolução DELETOU é removido do índice (`--force-remove`), não deixado para trás.
 *
 * Lança em qualquer falha (o chamador é fail-closed e reporta a análise sem mexer no stage).
 */
export async function graftResolvedFilesOntoStage(
  repoRoot: string,
  stageBranch: string,
  resolvedRef: string,
  files: readonly string[],
): Promise<void> {
  const sh = async (cmd: string): Promise<string> => {
    const out = await defaultExec(cmd, { cwd: repoRoot, timeout: 30_000 });
    return typeof out === "string" ? out : ((out as { stdout?: string })?.stdout ?? "");
  };
  const idx = path.join(os.tmpdir(), `harness-graft-${randomUUID()}.index`);
  const env = `GIT_INDEX_FILE=${JSON.stringify(idx)}`;
  try {
    // 1 — o índice temporário PARTE do stage (não da árvore do juiz): tudo que o stage tem é o ponto de partida.
    await sh(`${env} git read-tree ${JSON.stringify(stageBranch)}`);
    // 2 — sobrescreve APENAS os arquivos divergentes com a versão resolvida (ou os remove, se resolvida = ausente).
    for (const f of files) {
      const entry = (await sh(`git ls-tree ${JSON.stringify(resolvedRef)} -- ${JSON.stringify(f)}`)).trim();
      if (!entry) {
        await sh(`${env} git update-index --force-remove -- ${JSON.stringify(f)}`);
        continue;
      }
      const m = entry.match(/^(\d{6})\s+\w+\s+([0-9a-f]{40})/);
      if (!m) throw new Error(`ls-tree ilegível para ${f}: ${entry.slice(0, 120)}`);
      await sh(`${env} git update-index --add --cacheinfo ${m[1]},${m[2]},${JSON.stringify(f)}`);
    }
    // 3 — materializa a árvore e commita COM O STAGE COMO PAI; só então move o ref.
    const tree = (await sh(`${env} git write-tree`)).trim();
    if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error(`write-tree devolveu algo inesperado: ${tree.slice(0, 80)}`);
    const parent = (await sh(`git rev-parse ${JSON.stringify(stageBranch)}`)).trim();
    const msg = `usm(resolve): resolução do juiz enxertada em ${stageBranch} (${files.length} arquivo(s))`;
    const commit = (await sh(`git commit-tree ${tree} -p ${parent} -m ${JSON.stringify(msg)}`)).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit-tree devolveu algo inesperado: ${commit.slice(0, 80)}`);
    await sh(`git update-ref ${JSON.stringify(`refs/heads/${stageBranch}`)} ${commit} ${parent}`);
  } finally {
    await fsp.rm(idx, { force: true }).catch(() => {});
  }
}

/**
 * Fase 4b — fire the RELEASE when a card enters an `onEnter: promote-stage` step (the `release` column):
 * promote the staged code `stage` → `main` (path-scoped) and stamp `releasedAt` on every staged card of
 * the board. BOARD-SCOPED (#4): the promotion pathspec is narrowed to THIS board's `package` (e.g.
 * `packages/acmeapp/**`) so publishing one app does NOT drag every other board's staged code to main along
 * with it (the single-stage-branch footgun). A board without a `package` falls back to the global
 * `staging.codePrefixes` (legacy). Best-effort and NEVER throws to the caller. A secret-scan block leaves
 * the cards UN-stamped (the code never reached main).
 */
export async function fireReleaseStaged(
  boardId: string,
  opts?: { excludeSessionId?: string; overrideEmbargo?: boolean },
): Promise<ReleaseOutcome> {
  const staging = loadRunnerConfig().autorun.staging;
  // staging OFF → there is no stage→main promotion at all; treat as a benign no-op (never a revert).
  if (!staging?.enabled)
    return { promoted: false, deployable: true, revert: false, expectWork: false, changedFiles: [], outcome: "nothing-staged", reason: "staging desabilitado" };
  const repoRoot = findRepoRoot();
  // Rastro do override: uma guarda dispensada em silêncio é indistinguível de uma guarda que nunca rodou.
  if (opts?.overrideEmbargo) {
    console.warn(
      `[release ${boardId}] EMBARGO DISPENSADO a pedido explícito (overrideEmbargo): a sonda de trabalho vivo NÃO será consultada nesta publicação`,
    );
  }
  // SCOPE the promotion to THIS board's package. Without it, promoteStageToMain over the global
  // staging.codePrefixes (`packages/`) publishes EVERY board's staged code together — so releasing acme
  // would also ship whatever orbit/nimbus left on `stage`. Deriving the prefix from BoardConfig.package
  // keeps each release isolated to its own app. The scoped prefix is always a subset of the global one
  // (every deployable app lives under `packages/`), so the clobber guard in promoteStageToMain is intact.
  const config = await readBoardConfig(boardId).catch(() => null);
  // story-r4qdap — the release scope is the board's OWN package PLUS any `sharedPackages` it legitimately
  // touches (e.g. acme fixing code in packages/acme-shared/ or packages/orbit/). Each is normalized to
  // a trailing-slash prefix so a shared-package delta is PROMOTED instead of tripping the out-of-scope revert
  // (story-5vv8n1). Safe/idempotent across boards that share a package: there is a SINGLE `stage` branch, so
  // every board promotes the SAME delta — the first lands it, the rest are `already-promoted` no-ops (no
  // duplicate commit, no conflict; promoteStageToMain's --3way + empty-commit guard). A board without a
  // `package` still falls back to the global `staging.codePrefixes` (legacy).
  // story-zr1cmf — the board's deployable SURFACES (paths outside `package`, e.g. tools/web-terminal/) join
  // the promote scope, so a surface change staged WITH the code is promoted stage→main instead of being
  // stranded on stage (or, when the scoped diff is empty, tripping the out-of-scope revert). Same trailing-
  // slash normalization as package/sharedPackages via the shared map below.
  // A derivação vive em `release-scope.ts` (pura): a página de Entrega mede o delta que ESTA promoção
  // levaria, e as duas têm de ler o escopo do mesmo lugar — duas cópias divergem no primeiro campo novo.
  const codePrefixes = releaseCodePrefixes(config, staging.codePrefixes);
  // story-4eqltw — the OTHER boards' packages, excluded from the out-of-scope probe so foreign-board code left
  // on the shared `stage` (each board promotes on its own frontier) never mis-reverts THIS board's release.
  const otherBoardPrefixes = await otherBoardPackagePrefixes(boardId);
  // #37 lock: route the release's main commit through the per-cwd mutex shared with the engine's
  // boundary-1 start commit and the merge train's boundary-2 commit (commit-serializer, keyed by
  // repoRoot). Without it, the release's `apply --index` + `commit` on main can race a concurrent
  // train integration on `.git/index.lock` (fatal) — silently leaving the staged code UN-promoted
  // while the card advances past release. promoteStageToMain never throws, so the chain always advances.
  // WS-10.4 — ONE promote closure, called for the first attempt AND for the post-resolution retry. A retry
  // that re-declared these arguments would be a SECOND definition of "what this release promotes" — the
  // duplicated-ruler bug class (D15). The retry is the SAME release, run again over a stage the judge fixed.
  // UMA definição da sonda, criada antes do closure de promote e reusada pela tentativa E pelo retry —
  // pelo mesmo motivo que `promote` é um closure só (D15): dois lugares declarando "como se mede trabalho
  // vivo" são duas réguas, e a segunda apodrece. Fail-open de propósito: se a sonda falhar, a publicação
  // segue como sempre seguiu — ela é proteção adicional, não um novo ponto de indisponibilidade.
  const probeConcurrentWork = async () => {
    try {
      const now = Date.now();
      // A janela do EMBARGO, não a da reaper (publishEmbargoTtlMs). Uma sessão calada há horas não pode
      // segurar produção só porque ainda está dentro do TTL generoso que existe para não APAGAR a árvore
      // dela: as duas decisões têm risco oposto (ver o doc-comment de PUBLISH_EMBARGO_TTL_MS). Antes daqui
      // o embargo herdava as 6h e uma sessão morta parava o board inteiro por um turno de trabalho.
      const sessions = (await makeSessionStore().load()).filter((s) => isSessionAlive(s, now, publishEmbargoTtlMs()));
      const trainEntries = getMergeQueue().getSnapshot().entries;
      const queued = trainEntries
        .filter((e) => isLiveMergeStatus(e.status))
        .map((e) => ({ runId: e.runId, branch: e.branch, baseCommit: e.baseCommit }));
      // A FRONTEIRA DE INTEGRAÇÃO de cada sessão: o sha que o train comprovadamente aterrissou. É o que
      // deixa a sonda medir "o que ainda NÃO integrou" por uma verdade local à sessão, em vez de inferi-la
      // de um diff contra o stage — que latcha em ON assim que duas sessões tocam o mesmo arquivo (o
      // deadlock de 2026-07-28, documentado em concurrent-work.ts `integrationRef`).
      const integrated = integratedShas(trainEntries);
      // Só resolvido quando há sessão ADOTADA viva — nenhuma leitura de board no caso normal.
      const boardPackage = sessions.some((s) => s.adopted && s.board)
        ? await boardPackagePrefixes()
        : undefined;
      return await liveWorkInRepo({
        exec: defaultExec,
        repoRoot,
        sessions,
        queued,
        // O HEAD do stage de onde a promoção parte: mede o trabalho COMMITADO de cada sessão como
        // divergência do stage, para que o trabalho JÁ integrado (o próprio código que vamos publicar)
        // não conte como concorrente e trave a promoção a cada tick com N sessões vivas (fix 2026-07-23).
        integrationRef: staging.branch,
        integrated,
        // Exclui a sessão que PEDIU esta publicação: o trabalho dela já está em `stage` — é justamente o
        // que vamos promover —, então contá-la como "trabalho vivo concorrente" faria toda publicação
        // disparada de dentro de uma sessão VIVA (o fluxo ADR-065: submit → publish_when_idle → discard)
        // se auto-bloquear PARA SEMPRE (`concurrent-work` a cada tick, nunca aterrissa). É exatamente para
        // isto que `liveWorkInRepo` tem `excludeSessionId`; faltava apenas o caminho da fila passá-lo.
        excludeSessionId: opts?.excludeSessionId,
        boardPackage: boardPackage && ((b) => boardPackage.get(b)),
      });
    } catch {
      return [];
    }
  };
  const promote = () =>
    serialCommit(repoRoot, () =>
      promoteStageToMain({
        exec: defaultExec,
        repoRoot,
        stageBranch: staging.branch,
        codePrefixes,
        // story-5vv8n1 — hand the GLOBAL code roots so a scoped-empty diff can be told apart: real staged code
        // OUTSIDE this board's scope is a promotion FAILURE (out-of-scope), not a legit nothing-to-release.
        allCodePrefixes: staging.codePrefixes,
        // story-4eqltw — but EXCLUDE the OTHER boards' packages from that probe: their un-promoted code on the
        // shared `stage` is their own release's concern, not a scoping failure of this board (the revert loop).
        otherBoardPrefixes,
        // story-m6sl8i — key the promotion frontier (`refs/promoted/<board>`) to THIS board, so a stage shared
        // by N boards doesn't re-diff from a frozen merge-base and re-include already-promoted deltas.
        board: boardId,
        // A guarda de concorrência da publicação. O `serialCommit` acima resolve a corrida de `.git/index.lock`
        // (dois escritores na mesma árvore), mas NÃO a corrida semântica: publicar um arquivo que outra sessão
        // está reescrevendo neste instante. Até aqui isso era mitigado à mão — uma nota de embargo num card —,
        // que só protege o card em que alguém lembrou de escrever. Fail-open de propósito: se a sonda falhar,
        // a publicação segue (o comportamento de sempre); ela é uma proteção adicional, não um novo ponto de
        // indisponibilidade.
        //
        // VÁLVULA DE ESCAPE (auditada): `overrideEmbargo` dispensa a guarda para ESTA publicação e só para
        // ela. Existe porque toda outra recusa deste sistema tem saída para o operador (o train devolve o
        // conflito à sessão, o finding escala para a Inbox, `allowNewer` cobre o `superseded`) e esta não
        // tinha nenhuma: com uma sessão sobreposta que não integra, as únicas saídas eram destruir a árvore
        // de outra pessoa ou fazer git na mão — e o sistema ficava incapaz de publicar até o conserto do
        // próprio bug que o travava (2026-07-27). Nunca é default: só chega aqui por pedido explícito.
        concurrentWork: opts?.overrideEmbargo ? undefined : probeConcurrentWork,
      }),
    );
  let result = await promote();
  // WS-10.4/D14 — THE CATEGORY-2 CASE, the one the sister session (033ee72e6) closed as "always needs a
  // human". `apply-failed` means `stage` and `main` each carry a DIFFERENT text for the same region — most
  // often the SAME fix that reached main out-of-band (a rescue cherry-pick), worded differently. Before that
  // failure reaches the operator it climbs the ladder:
  //   cosmetic  ⇒ the judge resolves it, we RETRY the release over the resolved stage — through the SAME
  //               promoteStageToMain, so the delta mechanics, the secret-scan and every guard run untouched;
  //   substantive/failed ⇒ the reported failure GAINS the per-hunk analysis in its body.
  // The delta mechanics of `033ee72e6` are DELIBERATELY not touched (spec §10.4): we do not re-measure, re-
  // scope or re-apply anything — the ladder runs strictly BEFORE the report, and a resolution re-enters by
  // calling the very same function again. Never throws (fireReleaseStaged is best-effort end to end).
  let ladder: ResolutionResult | null = null;
  if (result.outcome === "apply-failed" && (result.divergentFiles?.length ?? 0) > 0) {
    ladder = await climbReleaseLadder(repoRoot, staging.branch, result);
    if (ladder && isResolved(ladder.outcome)) {
      console.log(`[release ${boardId}] escada semântica resolveu a divergência (${ladder.detail}) — republicando`);
      // The judge committed the resolution onto `stage` itself? NO — it never writes to stage/main
      // (invariant 1). `climbReleaseLadder` fast-forwards `stage` to the judge's artifact through the
      // normal ref mechanism, so this retry is an ORDINARY release of an ordinary stage.
      result = await promote();
    }
  }

  const decision = classifyRelease(result);
  if (decision.revert) {
    // WS-10.4 — the failure the operator reads now carries the ANALYSIS, per hunk, when the ladder produced
    // one. This is the message the sister session improved (it named the divergent files); the ladder adds
    // WHY each one is a genuine decision — so "diverge" becomes "hunk X is substantive because …".
    if (ladder && ladder.hunks.length > 0) {
      decision.reason = `${decision.reason ?? ""}\n\n${formatAnalysis(ladder)}`.trim();
    } else if (ladder) {
      decision.reason = `${decision.reason ?? ""}\n[escada semântica: ${ladder.detail}]`.trim();
    }
    // story-5vv8n1 — a REAL promotion failure: the code did NOT reach main. Do NOT stamp releasedAt (the
    // code isn't live) and surface it LOUDLY (was a silent console.log). The caller (firePromoteAndDeploy)
    // reverts the card instead of letting it claim "No Ar".
    console.error(`[release ${boardId}] FALHA de promoção (${result.outcome}): ${result.reason} — deploy NÃO será disparado`);
    return decision;
  }
  // The staged code is now live on `main` (promoted now, or already promoted) → stamp the cards.
  const today = new Date().toISOString().slice(0, 10);
  // A EVIDÊNCIA durável: o sha de main que — após esta promoção bem-sucedida — comprovadamente contém o código
  // destes cards. Qualquer deploy futuro rodado num commit DESCENDENTE dele carrega o código deles, e é isso que
  // permite reconciliar um `deploy-failure` contra a realidade (deploy-reconcile.ts) mesmo quando a publicação
  // foi feita FORA do board (pela CLI). `commitRange.head` NÃO serviria: é o head do branch do run, e a promoção
  // aplica um PATCH — o sha em main é outro (medido: 2 de 3 shas dos cards travados não eram ancestrais de main,
  // embora o código estivesse lá). Quem o reporta é o release (dono do git); ausente ⇒ os cards ficam sem
  // evidência e simplesmente não são reconciliados — nunca o contrário.
  const releasedSha = result.mainSha;
  const cards = await readCards(boardId);
  for (const c of cards) {
    if (c.stagedAt && !c.releasedAt) {
      await updateCardOnDisk(boardId, c.id, (card) => ({
        ...card,
        releasedAt: today,
        ...(releasedSha ? { releasedSha } : {}),
      })).catch(() => {});
    }
  }
  console.log(
    `[release ${boardId}] ${result.promoted ? `promovido ${result.commit?.slice(0, 8)} (push ${result.pushed ? "ok" : "falhou"})` : result.reason}`,
  );
  return decision;
}

/**
 * Recuperação de deploy (incidente 2026-07-09, gap do story-g9kxo9): num RE-ENTRY no Deploy (card
 * revertido para `release` por falha de deploy → humano reentra), o promote devolve `already-promoted`/
 * `nothing-staged` com `changedFiles` VAZIO — então `touchesComposedFace` nunca re-armava a face e o card
 * voltava a "No ar" com a face quebrada (o "reentre no Deploy" do finding era uma promessa vazia).
 * Deriva os arquivos que ESTE card shipou do seu `commitRange` durável (git diff base..head — os commits
 * já estão no repo, promovidos numa entrada anterior). Best-effort: sem commitRange / git falhou → [].
 */
async function deriveCardChangedFiles(boardId: string, cardId: string, repoRoot: string): Promise<string[]> {
  const cards = await readCards(boardId).catch(() => []);
  const range = cards.find((c) => c.id === cardId)?.commitRange;
  if (!range?.base || !range?.head) return [];
  try {
    const out = await defaultExec(`git diff --name-only ${range.base} ${range.head}`, {
      cwd: repoRoot,
      timeout: 30_000,
    });
    return out.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
  } catch {
    return []; // commits podados/inalcançáveis → degrada para o comportamento pré-fix (sem face)
  }
}

/**
 * Fase 4c — fire the board DEPLOY when a card enters an `onEnter: deploy-board` step (the `deploy` column):
 * publish the released code to Live. Board-aware off `BoardConfig.package` (storymap → detached
 * rebuild+restart; product → orch-deploy). Best-effort, never throws to the caller.
 */
export async function fireDeployBoard(
  boardId: string,
  cardId?: string,
  opts?: { expectWork?: boolean; changedFiles?: string[] },
): Promise<DeployResult | undefined> {
  const config = await readBoardConfig(boardId);
  const repoRoot = findRepoRoot();
  // story-harness-adk G3: thread the board id + the card that triggered the deploy so the registry's
  // onDone can revert THAT card if the deploy fails (the card already entered "No ar" optimistically).
  // story-5vv8n1 (t5): thread `expectWork` — when the release just promoted NEW code, a diff-aware deploy
  // MUST do real work; a ~0s no-drift settle then means the code never shipped → onDone reverts.
  // story-efwo30: thread the promoted `changedFiles` so a face-touching release ALSO publishes the mosaico.app web.
  // Re-entry recovery: promote sem diff (já promovido) + card conhecido → deriva do commitRange do card.
  let changedFiles = opts?.changedFiles ?? [];
  if (changedFiles.length === 0 && cardId) {
    changedFiles = await deriveCardChangedFiles(boardId, cardId, repoRoot);
  }
  // Deploy agnóstico (D-AG1/D-AG3) — thread the board's DECLARED descriptor (config.deploy) down to the
  // routing and, ONLY when one is declared, the card's releasedSha (the agent prompt's "which sha to
  // publish"). Boards without the block pay zero extra IO and route byte-identically. This module stays
  // agnostic: the descriptor is opaque config plumbing — no product/tool name crosses here (agnostic-lint).
  let releasedSha: string | undefined;
  if (config.deploy && cardId) {
    const boardCards = await readCards(boardId).catch(() => []);
    releasedSha = boardCards.find((c) => c.id === cardId)?.releasedSha;
  }
  const result = await deployBoard({
    exec: defaultExec,
    repoRoot,
    boardPackage: config.package,
    board: boardId,
    cardId,
    expectWork: opts?.expectWork,
    changedFiles,
    boardDeploy: config.deploy,
    releasedSha,
  });
  console.log(`[deploy ${boardId}] ${result.fired ? `disparado (${result.tool})` : result.reason}`);
  // A outra metade da evidência (deploy-reconcile.ts): QUAIS alvos precisam subir para este card estar vivo.
  // Quem os NOMEIA é a camada de deploy (result.targets) — este módulo é agnóstico de produto (agnostic-lint) e
  // só registra o que lhe é devolvido. Sem este carimbo a reconciliação teria de adivinhar as unidades
  // relevantes, e "todas" seria estrito demais (uma unidade sem drift nunca é republicada → o card nunca
  // sararia). O self-deploy do storymap não devolve alvos: ele fecha o loop pelo webhook de settle, e ficar sem
  // `deployTargets` só significa que a reconciliação não opina sobre ele — nunca que ela erra.
  if (cardId && result.targets?.length) {
    const deployTargets = result.targets;
    await updateCardOnDisk(boardId, cardId, (card) => ({ ...card, deployTargets })).catch((err) =>
      console.error(`[deploy ${boardId}/${cardId}] stamp deployTargets falhou:`, err instanceof Error ? err.message : err),
    );
  }
  // WS1.1 + deploy-truth (D-DT7) — EVERY card-triggered deploy arms the watchdog now, not only the
  // self-deploy that armed a webhook: since the terminal is settle-gated (WS-3), the card WAITS in the
  // deploy step, and a settle that never arrives (dead restart, killed orch-deploy child, service crash
  // mid-deploy) would strand it there silently. deployFiredAt is what lets the deploy-unsettled demand
  // surface a card stuck in "Publicando" past its SLA. Cleared by the settle only WITH proof (or on
  // failure by the revert). Best-effort (a failed stamp only forfeits the watchdog, never the deploy).
  if (result.fired && cardId) {
    await updateCardOnDisk(boardId, cardId, (card) => ({ ...card, deployFiredAt: new Date().toISOString() })).catch(
      (err) => console.error(`[deploy ${boardId}/${cardId}] stamp deployFiredAt falhou:`, err instanceof Error ? err.message : err),
    );
  }
  // deploy-truth WS-3 — NOTHING fired and nothing ever will (board without a deployable package / target
  // not in the allowlist — NOT the in-flight collision, which re-dispatches below): no settle event will
  // ever advance this card out of "Publicando". Attempt an immediate evidence settle: a NO-CODE card
  // (chore/spike — the positive declaresCode rule) advances to the terminal right away (there is nothing
  // to publish, hence nothing to prove — D-DT8); a CODE card stays PUT with the watchdog armed (stamped
  // here) so the human is escalated instead of the card lying "No ar". Fail-closed either way.
  if (!result.fired && !result.inFlight && cardId) {
    await updateCardOnDisk(boardId, cardId, (card) => ({ ...card, deployFiredAt: new Date().toISOString() })).catch(
      () => {},
    );
    const { settleDeploySuccess } = await import("./deploy-reconcile");
    await settleDeploySuccess(boardId, cardId, { source: "reconcile-evidence" }).catch(() => {});
  }
  // 1.5 — a SECOND storymap self-deploy that fires while the first is still building can't start (the fixed
  // systemd unit is busy → result.inFlight). Without parking it, the card sits in "No ar" with NO deployFiredAt,
  // NO settle and NO watchdog — a silent terminal. Enqueue it durably; the in-flight deploy's settle
  // (deploy-webhook → redispatchPendingSelfDeploy) re-dispatches it. Scoped to the storymap self-deploy.
  if (result.inFlight && cardId && result.tool === "systemd-restart") {
    await getPendingSelfDeploy()
      .enqueue(boardId, cardId)
      .catch((err) =>
        console.error(
          `[deploy ${boardId}/${cardId}] enfileirar self-deploy pendente falhou:`,
          err instanceof Error ? err.message : err,
        ),
      );
    console.warn(
      `[deploy ${boardId}/${cardId}] self-deploy concorrente — card enfileirado p/ re-disparo no settle do deploy em curso`,
    );
  }
  return result;
}

/** DI surface for {@link redispatchPendingSelfDeploy} — the store take + the deploy fire + the watchdog stamp,
 *  all injectable so the unit test never touches disk/systemd. Defaults wire the real IO. */
export interface RedispatchSelfDeployDeps {
  take(): Promise<{ board: string; cardId: string } | null>;
  fire(board: string, cardId: string): Promise<DeployResult | undefined>;
  /** stamp deployFiredAt=now so the existing deploy-unsettled watchdog covers a re-dispatch that ALSO can't fire. */
  stampUnsettled(board: string, cardId: string): Promise<void>;
}

const defaultRedispatchDeps: RedispatchSelfDeployDeps = {
  take: () => getPendingSelfDeploy().take(),
  fire: (board, cardId) => fireDeployBoard(board, cardId),
  stampUnsettled: async (board, cardId) => {
    await updateCardOnDisk(board, cardId, (card) => ({ ...card, deployFiredAt: new Date().toISOString() })).catch(
      (err) =>
        console.error(
          `[deploy ${board}/${cardId}] stamp deployFiredAt (fallback re-disparo) falhou:`,
          err instanceof Error ? err.message : err,
        ),
    );
  },
};

/**
 * 1.5 — at a self-deploy SETTLE (the deploy-webhook), take the parked self-deploy (if any) and re-dispatch it.
 * On success fireDeployBoard stamps deployFiredAt so the re-dispatched deploy's OWN settle clears it. If the
 * re-dispatch ALSO collides (still inFlight — a third deploy is running, or the settling unit isn't reaped
 * yet) or throws, stamp deployFiredAt as a DEFENSIVE fallback so the existing deploy-unsettled watchdog
 * surfaces it after the SLA — never a silent terminal. Best-effort: never throws (a settle handler must not
 * break on a re-dispatch). Returns what happened (for tests / the caller's log).
 */
export async function redispatchPendingSelfDeploy(
  deps: RedispatchSelfDeployDeps = defaultRedispatchDeps,
): Promise<"none" | "fired" | "requeued-unsettled"> {
  const entry = await deps.take().catch(() => null);
  if (!entry) return "none";
  const result = await deps.fire(entry.board, entry.cardId).catch((err) => {
    console.error(
      `[deploy ${entry.board}/${entry.cardId}] re-disparo do self-deploy pendente falhou:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  });
  if (result?.fired) {
    console.log(`[deploy ${entry.board}/${entry.cardId}] self-deploy pendente RE-DISPARADO no settle`);
    return "fired";
  }
  // still inFlight (or fire threw) → the card would again lie "No ar" without a settle. Stamp deployFiredAt so
  // the deploy-unsettled watchdog (demands.ts) raises the demand after the SLA (defensive fallback).
  await deps.stampUnsettled(entry.board, entry.cardId).catch(() => {});
  console.warn(
    `[deploy ${entry.board}/${entry.cardId}] re-disparo do self-deploy falhou/em curso — deployFiredAt marcado p/ o watchdog cobrir`,
  );
  return "requeued-unsettled";
}

/**
 * ADR-059 — the DEPLOY action's CHAINED effect (the human touch #2). In the collapsed delivery model the
 * card rests in `release` "pronto-mas-ainda-não-no-ar" (code on `stage`, NOT yet on main); the single
 * Deploy click is what promotes AND publishes. So entering `deploy` (Publicar) fires, IN ORDER:
 *   1. `fireReleaseStaged` — promote staged code `stage` → `main` (path-scoped) + stamp `releasedAt`. This
 *      runs FIRST and is awaited so the deploy never restarts onto code that isn't on main yet. BOARD-SCOPED
 *      (#4): only THIS board's `package` is promoted, not all of `stage`. If the promote is secret-scan blocked it leaves cards un-stamped
 *      (best-effort, never throws) — the deploy still fires (the build runs before the restart, so a
 *      no-op promote can't ship bad code; the operator's verify-then-claim catches an un-promoted card).
 *   2. `fireDeployBoard` — rebuild+restart (storymap) / orch-deploy (product). Detached, best-effort.
 * Best-effort + never throws to the caller (the move/forward stays done; both steps are idempotent and
 * retriable on a re-entry). The optimistic `autoEnterTerminal` forward to `concluida` happens in the
 * cascade kernel AFTER this dispatches — the harness-ship runbook proves health post-fact (No ar é otimista).
 */
/**
 * Devolve o {@link ReleaseOutcome} em vez de `void`: o efeito SABE se o código aterrissou, e engolir essa
 * informação foi o que deixou a fila de publicação carimbar `published` num promote recusado
 * (2026-07-23 — `concurrent-work`, deploy suprimido, pedido dado como publicado). Quem dispara por
 * onEnter continua podendo ignorar o retorno (ENTRY_EFFECTS é `Promise<unknown>`).
 */
export async function firePromoteAndDeploy(
  boardId: string,
  cardId?: string,
  opts?: { excludeSessionId?: string; overrideEmbargo?: boolean },
): Promise<ReleaseOutcome> {
  const release = await fireReleaseStaged(boardId, opts);
  // story-5vv8n1 — GATE the deploy + terminal on the release. A REAL promotion failure (out-of-scope /
  // apply-failed / blocked / no-prefix) means the code is NOT on main: suppress the deploy and REVERT the
  // card (reopen mode:'fix' → desenvolver) so the optimistic autoEnterTerminal never claims a false "No Ar".
  // A legit no-op (idempotent / nothing-staged) is deployable and stays terminal.
  if (release.revert) {
    if (cardId) {
      await revertCardOnDeployFailure(boardId, cardId, { phase: "release", reason: release.reason });
    } else {
      console.error(
        `[promote-and-deploy ${boardId}] release falhou (${release.outcome}) sem cardId — deploy suprimido, card não revertido`,
      );
    }
    return release;
  }
  await fireDeployBoard(boardId, cardId, { expectWork: release.expectWork, changedFiles: release.changedFiles });
  return release;
}

/** Dispatch dos efeitos-ao-entrar (B3). Adicionar um efeito = 1 valor no enum EntryEffect (types) + 1
 *  entry aqui. moveCardAction E a cascata (autorun-eval) executam o efeito que entryEffect() decide. */
export const ENTRY_EFFECTS: Record<EntryEffect, (boardId: string, cardId?: string) => Promise<unknown>> = {
  // promote-stage discards fireReleaseStaged's ReleaseOutcome (that's only consumed by the promote-and-deploy
  // gate); as a standalone onEnter effect it's fire-and-forget like the others.
  "promote-stage": async (boardId) => {
    await fireReleaseStaged(boardId);
  },
  "deploy-board": fireDeployBoard,
  "promote-and-deploy": firePromoteAndDeploy,
};

/**
 * Fire the onEnter effect of a step a card just ENTERED — the SINGLE bridge shared by the human-move
 * path (moveCardAction) and the autorun cascade (autorun-eval `forward`). Best-effort: a failed effect
 * logs and never throws (the move/forward stays done; the effect is retriable on the next entry).
 */
export async function runEntryEffect(effect: EntryEffect, boardId: string, cardId?: string): Promise<void> {
  await ENTRY_EFFECTS[effect](boardId, cardId);
}
