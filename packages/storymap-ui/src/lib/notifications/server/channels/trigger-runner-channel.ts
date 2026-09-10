// Trigger runner channel — the auto-pilot for the AgileHarness pipeline.
//
// When a card ENTERS a status whose board.yaml entry has `autorun: true`, this
// channel does one of two things:
//   - the status has a `trigger` (enriquecer/priorizar/plano-tecnico/quebrar-tasks/
//     desenvolver/…) → ask the runner engine to spawn Claude Code headless; or
//   - the status has NO trigger but is autorun:true (a gated landing)
//     → FORWARD the card to the next status (the cascade bridge). After the pipeline
//     reform the pass-through landings (refinada/com-tasks/com-plano) were removed
//     and the gates moved onto the producer columns' entry, so every autorun column
//     now carries a trigger — this FORWARD branch only fires if a human toggles a
//     parada (pronta/com-design/revisao) to autorun.
// A status with `autorun` not true means manual: the card stops there (but a human
// can still launch it on demand via the "Rodar agora" button → runCardSkillAction,
// which calls the SAME engine, so manual + autorun share one concurrency cap).
//
// So the per-column `autorun` toggle (kanban) composes into a cascade. The default
// auto-runs the producer columns and STOPS at the autorun:false paradas
// (pronta = go/no-go, com-design, revisao); a human resumes each by moving the card
// forward. (Per board: acme auto-runs every producer; orbit keeps the post-pronta
// build columns manual.)
//
// CONFIG — the runner reads its settings from lib/storymap/runner/config.ts:
// hardcoded defaults < storymap/settings.yaml < process.env (ENV always wins).
// The master switch is `autorun.enabled` (settings.yaml) OR AGILEHARNESS_AUTORUN=0 (env);
// both are evaluated LIVE per event, so toggling in the Config panel takes effect
// without a restart. Per-column model/effort/maxTurns come from board.yaml. The
// spawn engine itself lives in lib/storymap/runner/engine.ts (shared singleton).
//
// No loops: skills move the card OUT of their trigger status when they finish, and
// forwards only ever advance to the NEXT status (monotonic → terminates). A
// per-card in-flight lock (in the engine) + a concurrency cap keep a burst of moves
// in check. We act on both card.moved AND card.created so a card that ARRIVES in an
// autorun status (incl. a card the agent renamed during refinement) still cascades.

import type { NotificationChannel, AgileHarnessEvent } from "../../event";
import type { TriggerId } from "@/lib/storymap/types";
import { getRunnerEngine } from "@/lib/storymap/runner/engine";
import { getMergeQueue } from "@/lib/storymap/runner/merge-queue";
import { getTestQueue } from "@/lib/storymap/runner/test-queue";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { evaluateAutorunOnEntry } from "./autorun-eval";
import { setupEventLog } from "@/lib/storymap/runner/event-log";
import { getProductDeploy, deploySettledWithoutWork, composedFaceTarget } from "@/lib/storymap/runner/product-deploy";
import { revertCardOnDeployFailure } from "@/lib/storymap/runner/deploy-revert";
import { settleDeploySuccess } from "@/lib/storymap/runner/deploy-reconcile";
import { verifyFaceAndRevert } from "@/lib/storymap/runner/face-verify";
import { readFaceGateReason } from "@/lib/storymap/runner/face-gate-detail";
import { registerRunDeathFindings } from "@/lib/storymap/runner/run-death";
import { registerCapabilityAudit } from "@/lib/storymap/runner/capability-audit";
import { resolveClaudeBinVerdict } from "@/lib/storymap/runner/claude-bin";

export function createTriggerRunnerChannel(): NotificationChannel {
  const engine = getRunnerEngine();

  // The cascade evaluation (master switch → decideCascade → runSkill | forward) lives in
  // the shared helper evaluateAutorunOnEntry (autorun-eval.ts) so the in-process server
  // action path (moveCardAction — drag + MCP move_card) triggers autorun through the SAME
  // codepath as this watcher channel, instead of depending on the fs.watch alone.

  // CONTINUE the cascade after a run settles. When a skill advances its card into the
  // next autorun column, the watcher's card.moved fires WHILE that run still holds the
  // per-card in-flight lock — so the spawn is rejected and the event is lost, stalling
  // the cascade (the card sits until a human runs the next skill by hand). Re-evaluating
  // on completion delivers the skill-advance path the watcher alone cannot. The engine is
  // a process-global singleton and the dispatcher (this channel's owner) is too, so this
  // subscribes exactly once per process — no leak across HMR.
  //
  // story-r0zr3s: for ISOLATED runs (worktreeIsolation ON) the engine suppresses emitComplete
  // at settle time; the cascade instead fires here via onMergeDone, AFTER the merge-back lands
  // on main. That way evaluateAutorunOnEntry reads the new column (post-integration) rather than
  // the stale pre-merge-back status, and the cascade actually advances.
  engine.onComplete(({ board, cardId, trigger }) => {
    void evaluateAutorunOnEntry(board, cardId, { suppressTrigger: trigger });
  });
  setupEventLog(engine);
  // story-dznvez: carimba um DIAGNÓSTICO DURÁVEL da causa da morte no card (+ hint de classe infra/test/app)
  // toda vez que um run morre, e o limpa quando o card recupera. Assina o engine (2ª subscription — o Set de
  // listeners permite) SEM tocar o engine.ts; conservador (não move o card, só diagnostica). Ver run-death.ts.
  registerRunDeathFindings(engine, getMergeQueue());
  // WS3 (F2): stamp a SOFT, gate-free `tooling-unused` advisory when a run succeeds on a step that
  // provisioned a capability (codegraph MCP) at `expected` level but never exercised it — and clear it
  // when a later run of that step does. 3rd onComplete subscription; server-only; best-effort. See
  // capability-audit.ts. The durable aggregate signal (toolGap) rides telemetry regardless.
  registerCapabilityAudit(engine);

  // audit #12: carry the merged run's `trigger` into the suppress guard — exactly like the onComplete
  // path above — so a board-data run that merged back WITHOUT advancing its card can't re-fire the
  // SAME column's skill in a loop (the dedupe window has long expired by merge-back time). A run that
  // DID advance lands in a different column whose trigger differs, so the legitimate cascade proceeds.
  getMergeQueue().onMergeDone(({ board, cardId, trigger }) => {
    // WS2 — the post-merge-back cascade forward is attributed to the merge train, not a plain cascade.
    void evaluateAutorunOnEntry(board, cardId, { suppressTrigger: trigger, transitionActor: "merge" });
  });

  // ADR-063 Fase 3b: RESUME the cascade when an ASYNC test lands — the exact twin of the onMergeDone
  // subscription above, for test execution. A QA run fires its slow acceptance suite into the test-queue
  // and SETTLES (the wait leaves the LLM loop entirely — no more `sleep;grep`/`until grep` burning turns);
  // when the test completes (in-process executor OR the /api/runner/test-webhook durable twin), this wakes
  // the cascade to re-evaluate the card with the result now available. `suppressTrigger` carries the
  // generating trigger so a non-advancing re-eval can't re-fire the SAME column in a loop (audit #12 shape).
  getTestQueue().onDone(({ board, cardId, trigger }) => {
    // The test-queue keeps `trigger` a plain string (decoupled from the storymap TriggerId union); it is
    // by construction the generating skill's trigger, so the cast to TriggerId is safe at this boundary.
    void evaluateAutorunOnEntry(board, cardId, { suppressTrigger: trigger as TriggerId });
  });

  // story-harness-adk G3 + deploy-truth WS-3: wake on the deploy the harness ITSELF launched. Since
  // deploy-truth the card WAITS in the deploy step ("Publicando") — the terminal is settle-gated, never
  // optimistic. A FAILED settle reverts it deploy → release (deploy-revert). A SUCCESSFUL settle runs
  // settleDeploySuccess: measure the ancestry proof over the card's deployTargets (state files), stamp
  // `deployProof` and advance deploy → terminal through the gated path — which naturally WAITS for the
  // WHOLE target set: a backend-ok settle with the chained face still pending fails the face target's
  // measurement and does NOT advance; the face's own ok settle completes the set. The deploy job threaded
  // {board, cardId} from the onEnter effect; absent ctx (a manual MCP deploy) is skipped. The
  // /api/runner/deploy-webhook route is the DURABLE twin for a deploy that outlives a restart or an
  // external CI run.
  getProductDeploy().onDone((ev) => {
    // Um deploy BEM-SUCEDIDO de um alvo torna vivo TODO card que dependia daquele alvo — não só o card que o
    // disparou. Antes, a cura era escopada ao {board, cardId} do disparo, então um card cujo deploy falhou e
    // que foi republicado por OUTRO card (ou pelo `deploy` do MCP, que roda sem cardId) ficava com o alarme
    // aberto para sempre. A reconciliação por evidência (deploy-reconcile) não precisa saber quem disparou:
    // ela compara o commit do deploy com o sha de main de cada card. Roda ANTES do early-return de cardId, de
    // propósito — é justamente o deploy SEM card que o caminho antigo ignorava.
    if (ev.ok) {
      void (async () => {
        const { reconcileBoardDeployFailures } = await import("@/lib/storymap/runner/deploy-reconcile");
        const { listBoards } = await import("@/lib/storymap/repo");
        for (const b of await listBoards()) await reconcileBoardDeployFailures(b.id);
      })().catch((err) => console.error("[deploy-reconcile settle]", err instanceof Error ? err.message : err));
    }
    if (!ev.board || !ev.cardId) return;
    // story-5vv8n1 (t5): revert on a genuine FAILURE (exit≠0) OR on a settle that did NO real work — a
    // diff-aware deploy that exits exit-0 in ~0s with no drift while the release promoted NEW code shipped
    // NOTHING, so "No ar" is a lie. A real success, or a legit idempotent no-drift re-deploy (expectWork
    // false → deploySettledWithoutWork false), is left terminal.
    const noWork = deploySettledWithoutWork(ev);
    if (!ev.ok || noWork) {
      // WS-11.2 — a FACE deploy that failed may carry the gate's own verdict in its log (the gate prints
      // FACE_GATE_FAIL as its last line). Lift it into `reason` so the finding names {pacote, etapa, 1ª
      // linha} — "<app>#typecheck: TS2307 …" — instead of the generic "deploy falhou (exit 1)" that made
      // a gate veto indistinguishable from the promotion defect on 2026-07-16 (story-pxj9gz). Best-effort:
      // no verdict (a non-face target, a firebase/build failure, an unreadable log) ⇒ reason omitted ⇒
      // exactly today's finding. Only the face target runs the gate, so only it is worth reading.
      const board = ev.board;
      const cardId = ev.cardId;
      void (async () => {
        const reason = !ev.ok && ev.pkg === composedFaceTarget() ? await readFaceGateReason(ev.pkg) : null;
        await revertCardOnDeployFailure(board, cardId, {
          pkg: ev.pkg,
          exitCode: ev.exitCode,
          phase: ev.ok ? "deploy-noop" : "deploy",
          reason: reason ?? undefined,
        });
      })();
      return;
    }
    // Settle OK — deploy-truth WS-3: canary FIRST, settle AFTER. Order matters both ways: (a) a canary
    // that confirms the face stale REVERTS the card (deploy → release) and stamps a face-stale finding —
    // settling first would advance a card whose UI is provably not live, and settling after a revert would
    // resolve the very finding the revert just stamped (so a reverted card SKIPS the settle entirely);
    // (b) a kept card then runs settleDeploySuccess, which measures the ancestry proof over ALL of the
    // card's deployTargets, stamps `deployProof`, resolves the stale deploy-failure finding (the old
    // pre-canary resolve, subsumed) and advances deploy → terminal through the gated path. A backend-ok
    // settle whose chained face hasn't published yet fails the face target's measurement → the card WAITS
    // in Publicando until the face's own settle (fail-closed, never half-live "No ar").
    //
    // P0/VERIFY seam: a SUCCESSFUL face deploy — the publish command exiting 0 does NOT prove the CDN
    // actually serves the new bundle. The canary asks the deployment whether each published surface
    // serves what was published for it; only the FACE target (a backend success is already truthful —
    // its own diff-aware deploy verified drift). fresh/unknown → kept (fail-open on unknown; never
    // false-revert — the ancestry measurement remains the settle authority).
    void (async () => {
      if (ev.pkg === composedFaceTarget()) {
        const reverted = await verifyFaceAndRevert(ev.board!, ev.cardId!, ev.pkg);
        if (reverted) return;
      }
      await settleDeploySuccess(ev.board!, ev.cardId!, { source: "registry-ondone" });
    })();
  });

  const cfg0 = loadRunnerConfig();
  // VEREDITO, não o lançante: um binário ausente não pode derrubar a montagem do canal.
  const vereditoBin = resolveClaudeBinVerdict({ name: cfg0.autorun.claudeBin });
  const binParaLog = vereditoBin.ok ? vereditoBin.path : `NAO RESOLVE (${vereditoBin.refusal})`;
  console.log(
    `[harness-autorun] channel ready (enabled=${cfg0.autorun.enabled}, bin=${binParaLog}, ` +
      `maxConcurrent=${cfg0.autorun.maxConcurrent}). Per-column policy from board.yaml + ` +
      `settings.yaml; ENV overrides win. Per-column 'autorun' drives run-skill / forward; ` +
      `runs continue the cascade on completion.`,
  );

  return {
    id: "trigger-runner",
    async notify(event: AgileHarnessEvent) {
      // A card ENTERING a status — by move or by creation/rename (the watcher path).
      if ((event.type !== "card.moved" && event.type !== "card.created") || !event.cardId) return;
      await evaluateAutorunOnEntry(event.boardId, event.cardId);
    },
  };
}
