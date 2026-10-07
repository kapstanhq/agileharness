# harness-conductor · 4 · PUBLICAR, in full

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read at the start of PUBLICAR, and on a resume after a merge-train handoff (PRE-VOO step 9). It is the rule, not a suggestion. A section named in quotes ("Safe landings", "Estacionar e retomar"…) lives in the core or in a sibling `ref/` file — the core's ref index says which. When prose and code disagree, the code wins and this file is the bug.

## 4 · PUBLICAR (publish)

First: `report_progress({board, cardId, phase: "publicar", note})`.

1. **Preconditions**: verification green (no open `blocker`, every criterion `pass`), locked tests
   untouched, full suite + typecheck green at `V`.
2. **Evidence**: every task `done: true` on main (`set_tasks`); the verified findings — on main with
   `add_finding` (ids `<lens>-<seq>-<sha8 of V>`, the `reviewFindingId` rule in
   `runner/findings.ts`), or in the worktree card (`fixed` for the repaired ones, `open` for the
   rest); in the worktree card: `reviewedAt`, `reviewCommit: V`, `commitRange: {base, head: V}`,
   `criteriaSpecs` complete, and for `mode: fix|refine` clear `mode` + the reopen block (you are the
   station that verified it).
   **The QA stamp — the SAME honest path `harness-qa` uses** (its "Verdict + write"): also in the worktree
   card, `qaPassed: true`, `qaRanAt: <today>`, `qaCommit: V` and
   `qaEvidence: { suite: <bool>, visual: <bool>, at: <ISO now>, by: harness-conductor }`, where each flag is a
   CLAIM you can back:
   - `suite: true` ONLY if YOU ran the package suite (the target's declared `test` check, the command the
     merge gate runs for it — `autorun.mergeGate.scope.packages` — or the package's own test script) IN YOUR WORKTREE at `V`, it was
     green, and the journal records the exact command and the count of tests executed (> 0). A suite you
     did not run, one that ran zero tests, or one with a failure you "know is flaky" is `suite: false`.
   - `visual: true` ONLY if the clean-context verifier swept the running app at 390px, the manifest said
     `readyAll: true`, and the PNGs were judged against the contract. Anything less is `visual: false`.
   A card that carries code (`commitRange`/`stagedAt`) only enters `revisao` with `qaPassed: true` AND one of
   the two flags true (`hasQaPassed`, `qaHasEvidence` in `gate-core.js`); a card whose diff touched a
   measured UI surface needs `visual: true`. If you cannot honestly set what the gate needs, do NOT stamp
   around it: stop at P3 and say which proof is missing — the operator decides (and `approve_qa` is theirs).
   Commit `chore(board): evidências · <board>/<cardId>`.
3. **`## Prova da entrega`** — append to the body with one `update_card` (read `verbose: true`
   first), BEFORE you submit (the conductor that resumes after `done` completes it — PRE-VOO step 9):
   ```
   ## Prova da entrega
   - **O que mudou:** <3–6 bullets, o visível ao usuário primeiro; áreas/arquivos>
   - **Contrato:** <critério → pass + evidência (teste / screenshot)>
   - **Telas (390px):** antes <paths> · depois <paths> (válidos enquanto o worktree existir)
   - Antes: <o que o usuário via/lia, em uma linha — só numa entrega que muda tela ou texto>
   - Depois: <o que ele vê/lê agora, em uma linha>
   - Link: <a URL, ou o caminho (/loja/…) onde ver no ar>
   - **Testes:** <N novos (paths)>; suíte do pacote verde (<comando>); typecheck/lint <status>
   - **Verificação independente:** <lentes>; findings <abertos/fixed>; loops <k>/2
   - **Integração:** submit <pinnedSha8> → train <entregue ao train | done>; código em `stage`
   - **Custo até aqui:** <x> nos runs mais ~<y> nesta sessão (estimativa), contra o teto <b|—> (em US$)
   - **Riscos / o que não foi provado:** <…>
   ```
4. **Submit and END — the handoff.** `worktree_submit({sessionId, message})` → `{entryId, pinnedSha}`.
   Accepted means QUEUED, not integrated — and you do NOT wait for the verdict: a session idling on
   `wait_for_submit` re-reads its whole context on every call and holds a board slot through the
   whole gate. In THIS order:
   1. Write (or rewrite) `## Estado do condutor` with `update_card` (read `verbose: true` first) — for a
      reader who did not watch you work: «Entregue ao train»; the submitter `sessionId` (yours — the
      key `wait_for_submit` takes), `entryId`, `pinnedSha8`; the branch that holds the work
      (`failed/agent/<sessionId>` after the discard); loops used; the suites that prove `V`; cost so
      far; and WHAT REMAINS: on `done`, the projection + P5 (or the ULTRA hand-off); on a return, the
      fix. Put the `pinnedSha8` in the `## Prova da entrega` **Integração** line in the same write.
      Confirm it LANDED before going on: an answer of `{pendingApproval}` (a board without
      `write-board: auto`) means the note is NOT on the card yet — `wait_for_approval`, and on `granted`
      repeat the SAME `update_card`. Never discard with the note still pending.
   2. `release_claim({board, cardId, sessionId})`.
   3. `worktree_discard({sessionId, handoff: true})` — `handoff: true` is what DECLARES the handoff:
      without it the service records nothing and nobody comes back for the card. Your commits are not
      integrated yet, so the branch is PRESERVED as `failed/agent/<sessionId>`; the train integrates the
      PINNED sha and repairs the renamed ref. This also books your session's spend into the card's ledger.
   4. KEEP `routing.driver: conductor` (the cascade stays silent while the train decides) and end the
      turn with one line — the service closes this terminal.
   The SERVICE closes the loop (`runner/conductor-handoff.ts`): when the train decides — `done`, or a
   conflict / red gate / failed merge — the card goes back to the FRONT of the conductor queue and a NEW
   conductor resumes; its task names your `sessionId` and the verdict (PRE-VOO step 9). It is never
   reopened when the story is already over, when someone is live on the card, while a question of it is
   open (the answer wakes it), or when a NEWER submission of the card replaced yours. After
   2 consecutive returns (no `done` between them) the service stops reopening and leaves a
   `conductor-handoff` finding on the card for the operator. A `done` resume is not held by the card's
   spend cap (only the projection is left). The train stamps `stagedAt`: your code then waits in
   `stage`; publishing it is the board's release policy, never yours. `handoff: true` is ONLY for this
   step: a data-only checkpoint submit mid-build (MOLDAR/CONSTRUIR) is NOT a handoff (there you wait for
   it and keep working), and parking (`estacionar`) discards WITHOUT it.
   **A batch** (`ref/batch.md`): one submit carries every item; the range must hold no code of a dropped item. The
   note on the lead lists each item, its `## Prova da entrega` and its state; the service reopens ONE conductor for
   the lead with the items (`batchCardIds`), and on `done` it stamps each item's `commitRange` from the `Card: <id>`
   trailers. Project EVERY item card on resume, not only the lead.
5. **Projection** — done by the conductor that resumes after `done` (gates now pass honestly on main —
   the train landed your QA stamp with the code; with the driver set no column skill fires): `get_card`
   and confirm main's card carries `qaPassed: true` and the `qaEvidence`; then `desenvolver` ->
   `revisar-codigo` (`hasBuildEvidence`: every task done) -> `qa-automatizado` (`hasNoBlockers`) ->
   `revisao` (`hasQaPassed`), or jump straight to `revisao` (only the destination's gate is checked).
   **Never call `approve_qa`** — it is the operator's exit, and a scoped call only parks an approval in
   the owner's Inbox. If `hasQaPassed` refuses, the refusal names what is missing: a stamp that did not
   land (fix it in your worktree and submit again — a data-only submit, which you wait for), or a proof
   you do not have (P3). Use the board's own ids (`list_statuses`) — the canonical ones are shown.
6. **Human in control** (the profile's `delivery` box OFF — the default; read it with `board_autonomy`) → **P5**. The delivery is integrated and proven; what is left is
   the human's approval, which may take days — do NOT hold a conductor slot for it. Finish your part
   now, in THIS order: rewrite `## Estado do condutor` («entregue; aguardando a aprovação»),
   `set_card_driver({board, cardId, driver: null})` (the card rests in `revisao`, where nothing runs;
   when the human approves by moving it to `merge` the cascade and the release policy carry it),
   `release_claim({board, cardId, sessionId})`, `worktree_discard({sessionId})` (this also books your
   session's spend into the card's ledger), then end the turn — the service closes this terminal. If
   the human asks for changes instead, the card is reopened and a new conductor takes it with the
   `## Prova da entrega` and findings as its starting point.
   `delivery` ON (or the card's `autonomyMode: ultra`) → see "ULTRA mode" below. With `delivery` OFF you
   CANNOT cross: `move_card` out of «Aprovar entrega» is refused in code for every agent.
