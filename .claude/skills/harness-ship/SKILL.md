---
name: harness-ship
description: >-
  AgileHarness MANUAL ship runbook for the collapsed 2-touch delivery model (ADR-059 — NOT
  autorun). Drives a card the human APPROVED in status `revisao` (Aprovar entrega) through
  the single "Publicar" column with anti-clobber + verify-then-claim guards. Reads a card in
  status `revisao` from storymap/boards/<board>/cards/<id>.md, confirms it is QA-green with no
  open blocker and `runner_status` empty, syncs the checkout to origin, then makes ONE move
  that collects the card in the Publicar column — the cascade auto-integrates the run into the
  `stage` branch (merge train) and the card RESTS in `release` (Liberar), code on stage but NOT
  yet promoted to main. The DEPLOY click (`revisao` -> `deploy`) is touch #2: it fires the
  promote-and-deploy chain (promote stage → main, then rebuild+restart), and the card
  auto-advances `deploy` -> `concluida` (No ar) via autoEnterTerminal. The skill then PROVES
  the service is healthy post-fact. Use when the user says "/harness ship", "/harness-ship",
  "publicar o card", "liberar para producao", "shippar", "promover e deployar", or approved a
  card and wants it shipped to Live. Operates git/branches + a production deploy; never
  autoruns. Edits only the card .md (status, releasedAt) — never product code.
triggers:
  - /harness ship
  - /harness-ship
  - publicar o card
  - liberar para producao
  - shippar
  - promover e deployar
  - usm ship
---

# /harness-ship — AgileHarness: publicar um card aprovado (2 toques: Aprovar entrega → Deploy)

The MANUAL ship runbook for the collapsed delivery model (**ADR-059**). The delivery tail is
now **2 toques humanos** in **2 colunas**: **Aprovar** (`revisao`) and **Publicar** (a single
column grouping `merge`/`stage`/`release`/`deploy`). After a human approves a card in **Aprovar
entrega** (`revisao`), this drives the final publish — collect it in the Publicar column (the
cascade auto-integrates into the `stage` branch and the card RESTS ready-but-not-live), then the
single **Deploy** click promotes stage → main + publishes + finishes — turning the multi-step
ship into ONE auditable command with the anti-clobber + verify-then-claim guards baked in.

> **NOT autorun.** This skill is INVOKED BY A HUMAN (or the orchestrator on the human's
> behalf) — it is deliberately NOT a board trigger and NOT in the autorun registry. The
> `revisao` (Aprovar entrega) step is `autorun:false` (the human approval gate, touch #1) and
> `deploy` (Publicar) is `autorun:false` (the human Deploy gate, touch #2). Shipping is an
> explicit human decision. Never wire this into the cascade.

> Read `storymap/README.md` + `docs/adr/ADR-057` (split/release/deploy) + `docs/adr/ADR-059`
> (the collapsed 2-touch model + autoEnterTerminal) + `docs/adr/ADR-058` (this runbook + the
> anti-clobber/verify-then-claim invariants) first. Pipeline guardrails: the AgileHarness service
> runs on port **3008** — NEVER kill/restart it directly (the storymap deploy is DETACHED via
> `systemd-run`, which is safe). This skill edits ONLY the card .md (`status`, `releasedAt`)
> under `storymap/boards/<board>/cards/` — never product code. Deploys run in the BACKGROUND
> (minutes). Permission mode: the operator confirms each gate.

## Input

```
/harness-ship <board>/<id>   # ship one approved card
/harness-ship <board>        # ship the whole `revisao` (Aprovar entrega) queue (one at a time, in order)
```

The card MUST be `status: revisao` (it got here from `qa-automatizado` → human approval). If it
is anywhere else, STOP and report — do not ship a card that was not approved.

## Preconditions (verify BEFORE touching anything)

Prefer the MCP tools (operate from the chat, no terminal) — fall back to `git_*` reads.

1. **Converge the checkout with origin** — `sync_repo` (fetch + ff/reconcile; the autorun pushes
   directly, so the checkout drifts behind fast). If it returns `action: diverged`, STOP and
   resolve the conflict first (`resolve_merge` / terminal) — shipping from a divergent checkout is
   the clobber vector ADR-058 exists to kill.
2. **Read the card + board** — `get_card`. Confirm:
   - `status === "revisao"`.
   - `qaPassed === true` (the `hasQaPassed` gate that guards `revisao` — predicate in
     `gate-core.js`). If false, it was never approval-ready → STOP.
   - NO open blocker finding (`findings[]` with `severity: "blocker", status: "open"`). An open
     blocker means review/QA left a hard defect → STOP, route back, do not ship.
   - Read `board.yaml` `package` (storymap → detached self-deploy; product board → orch-deploy).
3. **Runner empty** — confirm `runner_status` (running + mergeQueue) is empty BEFORE collecting in
   Publicar (guardrail never-kill) — the Deploy step does a rebuild+restart that drops in-flight runs.

## Step 1 — Aprovar → collect in Publicar (`revisao` -> Publicar column)

Move the card into the **Publicar** column (`move_card`, destination status id `merge`). Entering
`merge` (Integrar) is an automatic cascade passage: the merge train integrates the run branch
(code → `stage` branch, board data → `main`), then the cascade auto-forwards `merge` → `stage`
(Homologar, automatic) → `release` (Liberar) and **RESTS** there. `release` is `autorun:false` and
has NO promote effect — the card sits "pronto-mas-ainda-não-no-ar": code is on the `stage` branch,
NOT yet promoted to `main`. This is the deliberate ready-but-not-live safety state.

**VERIFY-THEN-CLAIM (do not trust the move — prove the integration):**
- `card_diff <board>/<id>` — the `code` side is the card's real impact on the app.
- Confirm the card RESTS in `release` (Liberar) and `stagedAt` is stamped (the train integrated the
  run into the `stage` branch). The code must be present on the `stage` branch but ABSENT from
  `origin/main` (it is NOT promoted yet — `releasedAt` is still UNSET by design).
- If the integration was blocked (gate-failed/conflict), the card parks — STOP, surface the reason
  (`resolve_merge`), do not proceed to Deploy.

## Step 2 — Deploy (`revisao` -> `deploy`): promote + publish + finish, the single human click

The TOUCH #2. Move the card into **Publicar/Deploy** (`move_card`, destination status id `deploy`).
The card was resting in `release`; this is the deliberate Deploy click. Entering `deploy` fires the
`promote-and-deploy` chained entry effect (`firePromoteAndDeploy`), which runs IN ORDER:
1. **promote stage → main** (`fireReleaseStaged`): the staged code is promoted from `stage` to
   `main` (path-scoped to `packages/`), `releasedAt` is stamped on every staged card, and pushed. A
   GLOBAL publish — ALL code on `stage` ships together (the single-stage-branch model). This runs
   FIRST and is awaited, so the deploy never restarts onto code that isn't on main yet.
2. **deploy-board** (`fireDeployBoard`), board-aware off `board.yaml.package` (agnostic — the target is
   derived from the package, never a hardcoded app name):
   - **storymap** (the tool itself) → rebuild + restart DETACHED via `systemd-run` (resolves the
     self-restart paradox — the action runs inside the service it restarts). Equivalent to `update_vps`.
   - **product board** (any other `board.yaml.package`) → `just orch-deploy <pkg>` via the shared
     ProductDeployRegistry (the SAME path the MCP `deploy` tool uses), spawned as a tracked background
     child (no systemd-run — a product deploy doesn't restart storymap), idempotent per-pkg, observable
     via `deploy_status`. Takes minutes (build + upload + Cloud Run + Firebase hosting/functions).

The card then **auto-advances `deploy` -> `concluida`** (No ar) via the `autoEnterTerminal` flag —
optimistically, on the Deploy click (the effects are detached/best-effort). The promote being
awaited means a secret-scan block leaves cards un-stamped and the operator catches it in Step 3.

**WATCH the deploy to completion (background, never foreground):**
- storymap → `update_status` until the unit finishes (or `deploy_status` for a product board).

## Step 3 — Validate live (the auto-advance is OPTIMISTIC — prove health post-fact)

The forward to `concluida` is optimistic; it does NOT prove the service is up. PROVE it:
- storymap → `service_health` (systemctl is-active + a node-fetch GET, never curl → WAF). Require
  `healthy: true` (systemd active AND HTTP responding). Re-check the new build SHA if exposed.
- Confirm the promote actually reached `main`: fetch origin, prove the released commit range is an
  ancestor of `origin/main` (`git merge-base --is-ancestor` / `git_log` on `origin/main`). The
  card's `releasedAt` stamp is necessary but NOT sufficient — the SHA must be reachable in
  `origin/main`, not just locally.
- product board → the package smoke (e.g. `just smoke-test-<pkg>`) + `query_errors --last 1h` to
  confirm the deploy did not spike Error Reporting.

If the deploy FAILED or the service is unhealthy (or the promote was secret-scan blocked, leaving
the code off `main`), REVERT the card from `concluida` back to `deploy` (manual `move_card`),
surface the failure (logs + `update_status`/`deploy_status`), and let the operator retry or roll
back — never leave a card claimed concluída on an unverified deploy.

## Anti-clobber & verify-then-claim (the load-bearing invariants — ADR-058)

- **origin is the only source of truth.** `sync_repo` before, NEVER scp between checkouts, NEVER
  `git push --force`, NEVER rebase a branch the train/release already pushed (it rewrites SHAs and
  invalidates the persisted diff snapshots — #37 uses MERGE for exactly this reason).
- **Prove, don't assert.** Every step's success is VERIFIED against the real system (code reachable
  in `origin/main`; service `healthy`), never inferred from "the move succeeded" or the optimistic
  auto-advance. A false flag is what let the lost-impl persist (#38) — this runbook never repeats it.
- **Runner empty for a deploy.** Confirm `runner_status` (running + mergeQueue) is empty before the
  Deploy click (guardrail never-kill) — a rebuild+restart drops in-flight runs.
- **Best-effort effects are idempotent.** `promote-and-deploy` never throws and is safe to re-fire
  on a re-entry; a failed step leaves the card retriable (re-enter `deploy`).

## Report

Per step: what fired, the verify evidence (the integration into `stage`; then the released SHA
reachable in `origin/main`; the `service_health`/smoke verdict), and the card's final status. If
the ship stopped at any gate, say WHICH gate and WHY, with the concrete remediation (resolve_merge,
re-run QA, fix the deploy, revert from `concluida`).
