// story-harness-adk G1/G3 + P0/story-2p5zuy — REVERT a card the harness optimistically forwarded to
// "No ar"/concluida when its production deploy FAILED. The deploy (onEnter effect) is fire-and-forget and
// the cascade auto-enters the terminal status OPTIMISTICALLY (autoEnterTerminal), so a failed deploy used
// to leave the card lying "shipped" with un-published code and NO recovery.
//
// A deploy failure is a DEPLOY/RELEASE concern, NOT a code defect (P0/story-2p5zuy): it is frequently
// external/infra (an unrelated package broke the batched deploy — the nimbus case) or a promotion issue,
// NOT something the code-fix skill can repair. The OLD behavior reopened it as mode:'fix' in `desenvolver`,
// where harness-fix (a CODE skill) diagnosed "not an app defect" and NO-OP'd forever, freezing the card. So
// instead of a code-fix reopen, this REVERTS the card to `release` (the human "Liberar" parada —
// "ready but NOT live") and stamps an informative (non-blocker) finding naming the failure. The human
// resolves any external cause, then clicks Deploy → the deploy step's onEnter (promote-and-deploy →
// deployBoard) re-runs, re-publishing the backend (diff-aware) AND the mosaico.app face (touchesComposedFace).
// Human-gated, so a failure whose cause is unfixed never auto-retry-loops (deploy stays HITL).
//
// SERVER-ONLY. The revert TRANSFORM is split out as pure functions (unit-testable); revertCardOnDeployFailure
// does the IO and is best-effort: it logs and NEVER throws (a deploy callback must not break on a revert
// that can't land).

import { updateCardOnDisk } from "@/lib/storymap/write";
import { readBoardConfig } from "@/lib/storymap/repo";
import { DEPLOY_FAILURE_FINDING_ID, isDeployStep } from "@/lib/storymap/demands";
import { terminalStatusIds } from "@/lib/storymap/views";
import { evaluateAutorunOnEntry } from "@/lib/notifications/server/channels/autorun-eval";
import { logFileFor } from "./product-deploy";
import { upsertFinding } from "./findings";
import { appendTransition } from "./transitions";
import type { BoardConfig, Card, Finding } from "@/lib/storymap/types";

export interface DeployFailureDetail {
  pkg?: string;
  exitCode?: number;
  /** story-5vv8n1 — WHICH publish phase failed, so the finding names the real cause:
   *   - "release"     → stage→main promotion failed (out-of-scope / apply-failed / blocked); code never left stage.
   *   - "deploy-noop" → the deploy settled exit-0 but did NO work (~0s, no drift) → code not actually live.
   *   - "face-stale"  → the face deploy REPORTED success but the canary saw mosaico.app still serving an OLD
   *                     x-build-sha (silent-CDN class): the shipped bundle is not actually live (P0/VERIFY).
   *   - "deploy" (default) → the orch-deploy exited non-zero. */
  phase?: "release" | "deploy" | "deploy-noop" | "face-stale" | "self-deploy";
  /** story-5vv8n1 — the underlying reason (e.g. the promote result's reason) surfaced into the finding. */
  reason?: string;
  /** WS1.1 — tail of the self-deploy build/restart log (already base64-decoded by the webhook route), woven
   *  into the finding so a failed self-deploy carries its WHY, not just "falhou". */
  logTail?: string;
}

/** The status a failed deploy reverts a card INTO — the human "Liberar" parada (ready-but-not-live), so the
 *  operator re-triggers Deploy (deployBoard re-runs backend + face). A deploy failure is NOT a code defect
 *  → it must NOT land in the build column (`desenvolver`), where harness-fix no-ops forever (P0/story-2p5zuy). */
export const DEPLOY_REVERT_DESTINATION = "release";

/** Stable finding id for a card's deploy failure — one per card, so a re-fired callback (in-process onDone
 *  + durable webhook for ONE deploy) UPSERTS the same finding instead of stacking duplicates.
 *  F8 — a DEFINIÇÃO migrou para o módulo PURO (demands.ts): quem escreve o finding é este arquivo (servidor),
 *  mas quem o LÊ para derivar a demanda é a camada client-safe. Duas cópias da mesma string seriam drift
 *  garantido — o dia em que uma mudasse, a falha voltaria a ser invisível. Re-exportado p/ os importadores. */
export { DEPLOY_FAILURE_FINDING_ID } from "@/lib/storymap/demands";

/**
 * Build the informative finding for a failed production publish (release OR deploy). severity `high` — an
 * OPERATOR ALERT, NOT a `blocker` (it must gate nothing; the release→deploy path carries no gate anyway,
 * so the human can re-deploy immediately). Idempotent by {@link DEPLOY_FAILURE_FINDING_ID}. Pure —
 * exported for tests.
 */
export function buildDeployFailureFinding(detail: DeployFailureDetail, today: string): Finding {
  const exit = detail.exitCode ?? -1;
  const log = detail.pkg ? logFileFor(detail.pkg) : null;
  const because = detail.reason ? ` Motivo: ${detail.reason}.` : "";
  const base = {
    id: DEPLOY_FAILURE_FINDING_ID,
    lens: "general" as const,
    severity: "high" as const,
    status: "open" as const,
  };
  if (detail.phase === "release") {
    // story-5vv8n1 — the promotion stage→main failed: the code is still on `stage`, NOT on main.
    return {
      ...base,
      title: "Release (promoção stage→main) falhou — reentrar no Deploy",
      detail:
        `RELEASE (promoção stage→main) FALHOU${detail.pkg ? ` para ${detail.pkg}` : ""} — o código NÃO foi ` +
        `publicado em main.${because} O card entrou em "No ar" otimista mas NÃO está no ar (revertido para ` +
        `Liberar em ${today}). Diagnostique por que a promoção não encontrou/aplicou o código staged; ` +
        `resolvido, reentre no Deploy.`,
    };
  }
  if (detail.phase === "deploy-noop") {
    // story-5vv8n1 (t5) — the deploy settled ok but instantly, with no drift: nothing was published.
    return {
      ...base,
      title: "Deploy no-op (nada publicado) — reentrar no Deploy",
      detail:
        `Deploy${detail.pkg ? ` de ${detail.pkg}` : ""} terminou exit-0 mas SEM trabalho real (~0s, sem ` +
        `drift) — o código esperado NÃO foi publicado.${because}` +
        (log ? ` (veja ${log})` : "") +
        ` O card entrou em "No ar" otimista mas o deploy não confirmou nada (revertido para Liberar em ` +
        `${today}). Confirme que o release promoveu o código para main e reentre no Deploy.`,
    };
  }
  if (detail.phase === "face-stale") {
    // P0/VERIFY seam — the publish REPORTED success but the fidelity canary confirmed a published surface
    // serving bytes we did not publish. "No ar" would be a lie, so we revert like any deploy failure.
    //
    // WHAT THIS TEXT USED TO SAY, AND WHY IT CHANGED (story-w3y6ml): it asserted "mosaico.app ainda serve um
    // x-build-sha antigo" — a claim the old ruler could not support (it compared the served sha against a
    // repo-wide `releasedSha`, so a correctly SKIPPED diff-aware build tripped it) — and prescribed
    // "Reentre no Deploy", which REPRODUCES the failure: the build is diff-aware, so re-running publishes
    // nothing new and the canary fails identically. That loop cost story-qb8z2c three reverts and a backoff.
    // The finding now states the MEASUREMENT (`reason` carries "<url> serve X, mas publicamos Y") and the
    // recovery that can actually change the outcome.
    return {
      ...base,
      title: "Superfície publicada serve bytes diferentes dos publicados — republicar a face",
      detail:
        `O deploy reportou sucesso, mas o canário de fidelidade encontrou uma superfície servindo um ` +
        `artefato DIFERENTE do que foi publicado para ela.${because} O card entrou em "No ar" otimista mas ` +
        `a UI publicada não é a que subiu (revertido para Liberar em ${today}). ` +
        `RECUPERAÇÃO: republique a FACE (o build é diff-aware — só o que mudou é reconstruído) e confirme a ` +
        `propagação do CDN/edge para a superfície citada. Se servido e publicado seguem divergentes após a ` +
        `republicação, o problema está na publicação/CDN, não no código — NÃO adianta reentrar no Deploy em ` +
        `loop, é o mesmo artefato sendo republicado.`,
    };
  }
  if (detail.phase === "self-deploy") {
    // WS1.1 — the storymap tool's OWN rebuild+restart failed (self-deploy). Because the build runs BEFORE
    // the restart, the service most likely stayed on the prior version (didn't fall over) — but the operator
    // must confirm and re-deploy. The base64 build/restart logTail rides in the finding for forensics.
    const tail = detail.logTail ? `\n\n— build/restart log (tail) —\n${detail.logTail.slice(-2000)}` : "";
    return {
      ...base,
      title: "Self-deploy do AgileHarness falhou — build/restart não completou",
      detail:
        `O rebuild+restart do AgileHarness FALHOU${because}. Como o build roda ANTES do restart, o serviço ` +
        `provavelmente segue na versão anterior (não caiu) — confirme com \`systemctl status storymap\`. O card ` +
        `entrou em "No ar" otimista e foi revertido para Liberar em ${today}; corrija a causa e reentre no Deploy.${tail}`,
    };
  }
  return {
    ...base,
    title: "Deploy de produção falhou — reentrar no Deploy (pode ser causa externa)",
    detail:
      `Deploy de produção FALHOU (exit ${exit})${detail.pkg ? ` para ${detail.pkg}` : ""} — o código pode ` +
      `NÃO ter sido publicado.${because}` +
      (log ? ` (veja ${log})` : "") +
      ` A causa pode ser EXTERNA (um pacote não-relacionado quebrou o deploy em lote), não necessariamente ` +
      `do seu código. O card entrou em "No ar" otimista mas não está no ar (revertido para Liberar em ` +
      `${today}). Diagnostique; resolvida a causa, reentre no Deploy.`,
  };
}

/** Stable finding id for a deploy that SETTLED (failed) AFTER the card had already advanced out of a
 *  revertable status — informative/forensic, distinct from {@link DEPLOY_FAILURE_FINDING_ID}. */
export const DEPLOY_OUT_OF_STATUS_FINDING_ID = "deploy-settled-out-of-status";

/**
 * 1.4 — the informative finding for a FAILED deploy settle that arrived when the card was already OUT of a
 * revertable status (a human moved it on, or the cascade advanced it). We do NOT revert the status — only
 * clear the deploy-unsettled watchdog stamp — but we record WHY the phantom demand cleared, for forensics.
 * severity `medium`: visible, never a blocker. Idempotent by id. Pure — exported for tests.
 */
export function buildDeploySettledOutOfStatusFinding(
  status: string | null | undefined,
  detail: DeployFailureDetail,
  today: string,
): Finding {
  const because = detail.reason ? ` Motivo: ${detail.reason}.` : "";
  return {
    id: DEPLOY_OUT_OF_STATUS_FINDING_ID,
    lens: "general" as const,
    severity: "medium" as const,
    status: "open" as const,
    title: "Deploy falhou, mas o card já havia saído do status publicável",
    detail:
      `Um settle de deploy FALHOU (exit ${detail.exitCode ?? -1}) em ${today}, mas o card já estava fora de um ` +
      `status revertível${status ? ` (estava em "${status}")` : ""} — o status NÃO foi alterado, apenas o ` +
      `marcador deploy-unsettled foi limpo (a demanda fantasma sumiu).${because} Se o deploy era esperado, ` +
      `confirme o estado de produção e reentre no Deploy pelo card correto.`,
  };
}

/**
 * Stamp the deploy-failure REVERT onto a card: move it to `destination` (the redeploy parada) and UPSERT the
 * informative finding. Does NOT stamp mode:'fix'/bugReport/reopenPending — a deploy failure is not a code
 * fix (P0/story-2p5zuy), so harness-fix must not run. Pure — only STORIES carry the revert; a non-story is
 * returned untouched. Exported for tests.
 */
export function applyDeployFailureRevert(card: Card, finding: Finding, destination: string): Card {
  if (card.type !== "story") return card;
  return {
    ...card,
    status: destination,
    // WS1.1 — the deploy SETTLED (albeit failed): clear the deploy-unsettled watchdog stamp so the reverted
    // card resting in `release` doesn't also raise a phantom deploy-unsettled demand.
    deployFiredAt: undefined,
    findings: upsertFinding(card.findings ?? [], finding),
  };
}

export interface DeploySettleFailureResult {
  /** the card to WRITE, or null to SKIP the write (a genuine no-op — card absent/non-story with no stamp). */
  next: Card | null;
  /** the card's status was reverted to `destination` (it still rested in a revertable status). */
  reverted: boolean;
  /** only the deploy-unsettled stamp was cleared (card had advanced out of a revertable status). */
  clearedStamp: boolean;
}

/**
 * 1.4 — pure decision for a FAILED deploy settle. SEPARATES two concerns that used to be conflated (a single
 * `return null` skipped BOTH): (a) revert status only when the card still rests in a revertable status;
 * (b) ALWAYS clear the deploy-unsettled watchdog stamp (deployFiredAt) for that fire — otherwise, when the
 * card already advanced past a revertable status, the stamp leaked and the `deploy-unsettled` demand went
 * phantom forever. When only the stamp is cleared, an informative (non-blocker) finding records why. A card
 * with neither a revertable status nor a stamp is a true no-op (skip the write). Pure — exported for tests.
 */
export function applyDeploySettleFailure(
  card: Card,
  opts: {
    revertableIds: ReadonlySet<string>;
    finding: Finding;
    destination: string;
    detail: DeployFailureDetail;
    today: string;
  },
): DeploySettleFailureResult {
  if (isRevertableDeployTarget(card, opts.revertableIds)) {
    return { next: applyDeployFailureRevert(card, opts.finding, opts.destination), reverted: true, clearedStamp: false };
  }
  if (card.deployFiredAt != null) {
    return {
      next: {
        ...card,
        deployFiredAt: undefined,
        findings: upsertFinding(
          card.findings ?? [],
          buildDeploySettledOutOfStatusFinding(card.status, opts.detail, opts.today),
        ),
      },
      reverted: false,
      clearedStamp: true,
    };
  }
  return { next: null, reverted: false, clearedStamp: false };
}

/**
 * Incidente 2026-07-09 (gap do story-g9kxo9) — PURE: um settle de deploy BEM-SUCEDIDO resolve o finding
 * {@link DEPLOY_FAILURE_FINDING_ID} aberto (open → fixed). Sem isto, o card recuperado (revert → humano
 * reentra no Deploy → sucesso) voltava a "No ar" carregando um alerta "deploy falhou" OBSOLETO para sempre
 * (a classe "resíduo" limpa à mão em omazmj/ny4v26). Retorna null quando não há o que resolver — o null
 * PULA o write no updateCardOnDisk, então o caminho de sucesso (a maioria) nunca gira o fs-watcher.
 * Só o finding do deploy é tocado; findings alheios (gate/review/humanos) ficam intactos.
 */
export function applyDeployFailureResolved(card: Card): Card | null {
  const open = card.findings?.some((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open");
  // WS1.1 — a SUCCESSFUL settle also clears the deploy-unsettled watchdog stamp (deployFiredAt), even when
  // there is no stale finding to resolve. Skip the write only when BOTH are already clean (keeps the fs-watcher
  // quiet on the happy path, as before). SUPERSET of main's incident-fix version (which cleared only the
  // finding) — the finding-resolution branch below is identical; this adds the deployFiredAt clearing.
  const fired = card.deployFiredAt != null;
  if (!open && !fired) return null;
  let next: Card = fired ? { ...card, deployFiredAt: undefined } : card;
  if (open) {
    next = {
      ...next,
      findings: next.findings!.map((f) =>
        f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open" ? { ...f, status: "fixed" as const } : f,
      ),
    };
  }
  return next;
}

/**
 * Resolve o finding deploy-failure de um card após um deploy SETTLE ok (o par do revert acima). Best-effort:
 * loga e nunca lança (um callback de deploy não pode quebrar numa resolução que não landa).
 *
 * deploy-truth WS-3 — SUPERSEDIDO nos callers de settle: o webhook e o onDone do registry agora chamam
 * `settleDeploySuccess` (deploy-reconcile), que compõe esta MESMA resolução com a medição de prova, o
 * carimbo `deployProof` e o avanço gatado numa única transformação sob o lock. Mantido exportado como
 * primitiva (a transformação pura {@link applyDeployFailureResolved} continua testada e reutilizável).
 */
export async function resolveDeployFailureFindingOnSuccess(board: string, cardId: string): Promise<void> {
  try {
    await updateCardOnDisk(board, cardId, (card) => applyDeployFailureResolved(card));
  } catch (err) {
    console.error(
      `[deploy-revert ${board}/${cardId}] resolução do finding deploy-failure falhou:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The statuses a failed deploy may revert FROM:
 *   - the steps that CARRY the deploy (onEnter promote-and-deploy/deploy-board — the `deploy`/Publicar
 *     step). Since deploy-truth (WS-3) this is the PRIMARY case: the card WAITS there ("Publicando")
 *     until the settle proves the publish, so a failed settle reverts it deploy → release;
 *   - the TERMINAL ones — kept for the era-otimista cards IN TRANSIT (advanced to "No ar" by the old
 *     optimistic forward before this shipped) and for a settle that lands after a human moved the card on;
 *   - any `autoEnterTerminal` step — the old optimistic wiring's flag, kept so a board.yaml that still
 *     declares it (or a config snapshot mid-rollout) keeps its revert coverage.
 * A terminal-ONLY set would no-op on the waiting card and strand it mid-publish. Pure — exported for tests.
 */
export function deployRevertableStatusIds(config: BoardConfig): Set<string> {
  const ids = terminalStatusIds(config);
  for (const s of config.statuses) if (s.autoEnterTerminal || isDeployStep(s)) ids.add(s.id);
  return ids;
}

/**
 * The IDEMPOTENCY guard: true only when a card is STILL sitting in a status a failed deploy must reverse —
 * a terminal status OR the optimistic `autoEnterTerminal` step (see {@link deployRevertableStatusIds}).
 * Both revert callers can fire for ONE deploy — the in-process onDone (G3) AND the durable webhook (G1) —
 * and a webhook can land LATE, after a prior revert already moved the card to `release` (or the human
 * re-deployed). Without this, the second/late fire yanks a card out of its redeploy parada back again.
 * Only stories carry the revert. Pure — exported for tests.
 */
export function isRevertableDeployTarget(card: Card, revertableIds: ReadonlySet<string>): boolean {
  return card.type === "story" && !!card.status && revertableIds.has(card.status);
}

/**
 * REVERT a card whose production deploy FAILED: move it to `release` (the redeploy human parada) and stamp an
 * informative finding — NOT a code-fix reopen (P0/story-2p5zuy: a deploy failure is not a code defect, so
 * harness-fix would no-op forever). Best-effort: logs and never throws. IDEMPOTENT by a terminal-status guard
 * (isRevertableDeployTarget) applied INSIDE the write lock: only a card still in the optimistic terminal
 * status is reverted, so a re-fired callback (in-process onDone + durable webhook for one deploy) or a LATE
 * webhook (the human already re-deployed) is a safe no-op instead of yanking the card back.
 */
export async function revertCardOnDeployFailure(
  board: string,
  cardId: string,
  detail: DeployFailureDetail = {},
): Promise<void> {
  try {
    const config = await readBoardConfig(board).catch(() => null);
    const destination = config?.statuses.some((s) => s.id === DEPLOY_REVERT_DESTINATION)
      ? DEPLOY_REVERT_DESTINATION
      : null;
    if (!config || !destination) {
      console.error(
        `[deploy-revert ${board}/${cardId}] board sem config/coluna "${DEPLOY_REVERT_DESTINATION}" — revert pulado (card segue No ar)`,
      );
      return;
    }
    const revertableIds = deployRevertableStatusIds(config);
    const today = new Date().toISOString().slice(0, 10);
    const finding = buildDeployFailureFinding(detail, today);
    // 1.4 — SEPARATE the two decisions (both atomic under the per-card write lock, no read→write TOCTOU): a
    // terminal FAILED settle ALWAYS clears the deploy-unsettled watchdog stamp (deployFiredAt) for that fire,
    // and status is reverted ONLY when the card still rests in a revertable status. Before, a single
    // `return null` (card advanced past a revertable status) skipped BOTH → deployFiredAt leaked and the
    // `deploy-unsettled` demand went phantom forever. The pure applyDeploySettleFailure encodes both; the
    // closure captures which happened for the re-eval + log. The revertable set includes the optimistic
    // `deploy` step, so a fast failure that beats the deploy→concluida forward still reverts.
    let reverted = false;
    let clearedStamp = false;
    let outOfStatus: string | null | undefined;
    let revertFrom: string | null = null;
    await updateCardOnDisk(board, cardId, (card) => {
      const r = applyDeploySettleFailure(card, { revertableIds, finding, destination, detail, today });
      reverted = r.reverted;
      clearedStamp = r.clearedStamp;
      if (r.clearedStamp) outOfStatus = card.status;
      if (r.reverted) revertFrom = card.status ?? null; // 6.1 — the terminal status we're reverting OUT of
      return r.next;
    });
    if (!reverted && !clearedStamp) {
      console.warn(
        `[deploy-revert ${board}/${cardId}] sem revert nem limpeza — card ausente, não-story sem stamp, ou já tratado`,
      );
      return;
    }
    // A revert is a REAL status change; a stamp-clear updates the demand inbox — either way re-eval the cascade
    // in-process (notifies the board + re-derives the demand inbox, dropping the phantom deploy-unsettled).
    // `release` is autorun:false, so NO skill auto-runs on a revert.
    await evaluateAutorunOnEntry(board, cardId).catch((err) =>
      console.error(`[deploy-revert autorun ${board}/${cardId}]`, err instanceof Error ? err.message : err),
    );
    if (reverted) {
      // 6.1 — the most forensic hop (No ar → Liberar por deploy falho) was invisible in the ledger.
      // actor="system" (automatic revert, no human in the loop); append is itself fail-open.
      void appendTransition({ board, cardId, from: revertFrom, to: destination, actor: "system", note: "deploy:reverted" });
      console.warn(
        `[deploy-revert ${board}/${cardId}] deploy falhou (exit ${detail.exitCode ?? -1}) → revertido para ${destination} (redeploy, não é fix de código)`,
      );
    } else {
      console.warn(
        `[deploy-revert ${board}/${cardId}] deploy falhou (exit ${detail.exitCode ?? -1}) com o card fora de status revertível (${outOfStatus ?? "?"}) → deployFiredAt limpo, status intacto (demanda deploy-unsettled resolvida)`,
      );
    }
  } catch (err) {
    console.error(`[deploy-revert ${board}/${cardId}] revert falhou:`, err instanceof Error ? err.message : err);
  }
}
