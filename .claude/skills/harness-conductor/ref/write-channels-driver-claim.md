# harness-conductor · write channels, the driver, the claim and safe landings

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read before your first board write, and whenever a gate refuses a move or a landing column is unclear. It is the rule, not a suggestion. A section named in quotes ("Safe landings", "Estacionar e retomar"…) lives in the core or in a sibling `ref/` file — the core's ref index says which. When prose and code disagree, the code wins and this file is the bug.

## The two write channels (and why gates see only one)

Contract G8 (`dev-tools.ts`, worktree section): urgent board state goes through **MCP** and
lands on main at once; the **product of the work** goes in **your worktree** and lands through
the merge train (code → `stage`, board data → main, card merged 3-way per element —
`card-merge.ts`). One writer path per field, never both:

| Through MCP (lands on main now) | Through your worktree (lands on submit) |
|---|---|
| `update_card`: title, `storyType`, narrative, acceptance, personas, systems, body | code + tests |
| `move_card`: status, `parent`/`serves` (placement) | card PIPELINE fields with no MCP writer: `techPlanReady`, `hasUiSurface`, `criteriaSpecs`, `reviewedAt`/`reviewCommit`/`commitRange`, clearing `mode` |
| `set_tasks` (the task list the `hasTasks`/`hasBuildEvidence` gates read — needs YOUR claim) | — |
| `add_finding` (budget / verification findings, mid-build) | — |
| `record_decision` — a dilemma decided in ultra (business-only) mode | — |
| `ask_question` — plain `texts` OR structured `questions` (options, one recommended, context) | — |
| `write_sidecar` kind `wireframes` (validated: an error names the artifact) and kind `plans` | — |
| `choose_wireframe`, `set_card_driver`, `release_claim` | the QA stamp: `qaPassed`, `qaRanAt`, `qaCommit`, `qaEvidence` (see PUBLICAR) |

`approve_qa` (and `approve_review`) are NOT on your side of this table: since the honest gate (v0.7.0)
`approve_qa` is the OPERATOR's exit — a human asserting what THEY proved — and a scoped call to it stops
in the Inbox as an approval for the owner. QA is not one of the owner's decision points; you record what
YOU proved, in your worktree, by the same path `harness-qa` does (PUBLICAR step 2).

`update_card` REJECTS pipeline fields and `status`. Never hand-edit `status:` in any file, never
run `advance-card.ts` (it writes the file in cwd; your moves go through `move_card`). One writer
path per field: once you set tasks with `set_tasks`, keep the worktree card's `tasks` equal to what
you wrote (or leave them untouched there) so the train's 3-way merge has nothing to arbitrate.

**Gates are evaluated against MAIN's card** (`checkGate` in `moveCardAction`; predicates in
`packages/storymap-ui/src/lib/storymap/gates.ts` → `gate-core.js`). Evidence still sitting in
your worktree does not exist for a gate UNTIL the train lands it — which is why the evidence you need
MID-build goes through MCP (`set_tasks`, `add_finding`), and the QA stamp rides your final submit (the train's
3-way card merge takes the run side for pipeline fields — `MERGE_BACK_PIPELINE_FIELDS` in `card-merge.ts` —
so it lands on main next to the code it proves). A **data-only checkpoint submit** (a diff touching only
`storymap/boards/**` skips the code gate and merges straight to main — `verificationDemand` in
`merge-queue.ts`) is still available for the pipeline fields that have no MCP writer
(`techPlanReady`, `hasUiSurface`, `criteriaSpecs`), legal ONLY while the branch carries no code.
`worktree_submit` runs `git add -A` — keep scratch files, screenshots and your state journal in
gitignored paths (check with `git check-ignore -q <path>`).

After every checkpoint that lands — and right before you edit your copy of the card file —
`worktree_refresh({sessionId})`: the branch rebases onto the fresh base (main's board data
included), so your copy is current and an already-landed commit drops out.

## The driver and the claim — what they stop and what they do not (verified in code)

**The driver.** `routing.driver: conductor` on your card makes the column machinery SILENT for it:
the cascade (`decideCascade` in `cascade-decision.ts`) never RUNs a column skill for it nor
skip-forwards it (stop reason `conductor`, a debug line only — no card console line, no loop-guard
finding), and the engine (`runSkill` in `engine.ts`) settles ANY dispatch for it — a human "Rodar
agora", a recovery resume, a re-drive — as a clean `cancelled` before it reaches the claim: no
process, no `$0 no-op`, nothing on Inbox. It is sticky: your session dying does not clear it (so the
card never gets a stale column run); only you (at the end) or the operator clear it
(`set_card_driver({board, cardId, driver: null})`). A scoped move of a conducted card into an armed
column is `write-board`, not `run` (`moveRiskClass`). What still flows: column ENTRY EFFECTS
(`onEnter`, e.g. promote-and-deploy), the train's trigger-less passages (`merge` → `stage` →
`release`) and the deploy settle.

**The claim.** Your session reserves the card as `session:<agentId>` with kind `implement`, scope
`both` (`claimForRole` in `runner/session-spawn.ts`), TTL 60 min (`CLAIM_TTL_SESSION_MS`), renewed
every ~60 s by the service's fleet reconcile while your tmux lives (`reconcileFleetNow` in
`runner/fleet-deps.ts`). A session opened by `worktree_open`/`adopt_session` has none: take it with
`claim_card({board, cardId, sessionId})`. Give it back with `release_claim({board, cardId,
sessionId})` — it only ever releases YOUR claim. The claim is the second lock (the driver is the
first): it is what makes `set_tasks` yours alone, and what keeps a second implementer off the card.

The engine reserves the card on EVERY dispatch (`runner/engine.ts`, the WS-4.2 block that
calls `this.claims.acquire` with `actor: run:<sessionId>`, kind `claimKindFor(trigger)`, scope
`code` for code skills / `board` for the light lane). Against your `implement/both` claim
(`claimConflicts` in `runner/claims.ts`): code runs conflict (both touch code), light runs
conflict (same kind `implement`), `harness-review`/`harness-qa` conflict (code). Without the driver (a
card whose driver was cleared while you still hold the claim), the claim alone still refuses every
column run — but noisily: each refusal settles as a `$0 no-op` (`claim-refused: …`) that shows on
Inbox, and after `autorun.noProgressMax` refusals the loop guard writes a finding. With the driver,
none of that happens. So: never clear the driver before you release the claim and leave.

What the claim does NOT stop: a human's moves and UI buttons (claims are advisory for humans);
column **entry effects** (`onEnter`, e.g. promote-and-deploy on Publicar); the merge train; a
`triage`/`steward` actor on the same card (different kind, board scope — they coexist). The
Sentinel never touches story cards. The claim ends when you `release_claim`, when your tmux dies
(released as `session-died` within ~1 min) or 60 min after the last renewal (`worktree_discard`
deregisters you, which stops the renewal — release first).

A move into a column with `onEnter` is risk class `deploy` — never yours.

## Safe landings (the projection rule)

Resolve the board's pipeline: `list_statuses({board})` gives `id/name/gate/trigger/autorun/
terminal`; `onEnter` is not in it — read `storymap/boards/_base/board.yaml` and
`storymap/boards/<board>/board.yaml` in your worktree (the board's per-id deltas win;
`inheritPipeline: false` means the board owns its statuses outright). With the driver set, an armed
or skipped column spawns nothing and forwards nothing, so a column is a **safe landing for THIS
card** when ALL hold:

1. no `onEnter`, not terminal, not `release`/`deploy`, and not a train passage (`merge`/`stage`
   belong to the train — the one exception is the human's (or ULTRA's) hand-off into `merge`);
2. its gate passes on MAIN's card;
3. the card still carries `routing.driver: conductor` (`get_card` → `routing.driver`). Without it
   the OLD rule is back: an armed column (`autorun: true` + `trigger`) or a skipped one is NOT safe.

`move_card` validates only the DESTINATION's gate, so jump over unneeded columns. (`approve_qa` /
`approve_review` — the OPERATOR's tools, never yours — accept the card in the board's QA / review columns,
resolved from its pipeline: the step that runs `harness-qa`, the step gated by `hasQaPassed`, the step that
runs `harness-review` — not from fixed ids.) A reopen (`refine`/`fix`) clears the route and the driver:
the reopen triage owns the card from there.
