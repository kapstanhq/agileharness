# harness-conductor · 3 · VERIFICAR, in full

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read at the start of VERIFICAR (it is also what you brief the clean-context verifier and reviewers from). It is the rule, not a suggestion. A section named in quotes ("Safe landings", "Estacionar e retomar"…) lives in the core or in a sibling `ref/` file — the core's ref index says which. When prose and code disagree, the code wins and this file is the bug.

## 3 · VERIFICAR (verify) — clean context

First: `report_progress({board, cardId, phase: "verificar", note})`.

You wrote the code, so you do not judge it. Build a **contract packet**: acceptance verbatim
(from `get_card`, i.e. main), the diff range `<baseCommit>..HEAD` (the journal's base after the
last refresh), the plan, the locked test list, how to run the product. Pass NOTHING of your own
reasoning or opinion of the code.

1. **Fan out in ONE message** (fresh Task subagents; they cannot spawn subagents themselves):
   - one READ-ONLY reviewer per lens the diff warrants (the lenses the target declares — call
     `target_profile({board})` and read `reviewLenses`: the built-in `security`, `testing`, `perf`,
     `general`, `design` plus any the target added, each with an optional `agent`, `when` and
     `mandatoryWhen`; `harness-review`'s table describes what each one looks for; the board's review
     specialists = `toolkit.specialists` of `revisar-codigo`). Each ends with a ```json finding-batch```
     array — keys `lens`, `severity`, `title`, optional `detail`/`file`/`line`/`suggestion`/
     `failureClass`, nothing else (`FindingBatchItemSchema` in `contracts.ts`, strict);
   - one **acceptance verifier** that runs the product and checks every criterion, returning
     ```json acceptance-verdict``` — `{criteria: [{criterion, verdict: "pass"|"fail"|
     "unverifiable", evidence}], visual: {swept, readyAll, breakpoints, screenshots: []}}`.

   **Which agent runs each lens — and on which model.** The model of a reviewer lives in the
   AGENT'S frontmatter, not in your choice (owner decision: only Sonnet and Opus, the security lens
   on Opus). Each declared lens names its `agent` in `reviewLenses`; use that agent by name when this
   session lists it, otherwise a general-purpose subagent briefed with the lens and its
   `description`. A lens with no declared agent goes to a general reviewer briefed with the lens. The
   acceptance verifier is `acceptance-verifier` (falls back to a general-purpose subagent given the
   role, `model: "sonnet"`).
   **Never pass a `model` when you launch the agent a lens names for security** (a per-call model
   beats the frontmatter and would silently demote the lens), and never launch it on a lower model
   "to save cost". A lens whose `mandatoryWhen` matches the diff is **mandatory, not optional** — and
   the `security` lens is mandatory, by default, for any diff that touches authentication or
   authorization, secrets, payments or personal-data fields (plus whatever the target's
   `mandatoryWhen` adds): if you skip it the change is NOT VERIFIED, and its finding-batch must be on
   record before PUBLICAR.
2. **Running-app recipe** (give it to the verifier; `harness-qa` has the long version): learn
   how to start the product from the target's declared `dev.up` (`target_profile`) or, with none, the
   package's docs and its existing E2E setup — use what
   exists, scaffold nothing. Boot, readiness (an HTTP status, never a log line), sweep and
   teardown in ONE Bash call (`trap 'kill 0' EXIT`) — a process does not survive the call in a
   contained shell. Sweep: `node "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/../../scripts/visual-sweep.mjs" --url <url> --label
   conductor-<cardId>-<step> --breakpoints 390x844,1440x900 --wait-selector "<only present after
   data>" --require-ready` (the board's `browser-script` capability) → PNGs in
   `.artifacts/screenshots/` (do not commit them) + a manifest; READ every PNG. `readyAll: false` is not visual proof.
   Webfonts are blocked, so never judge the typeface. Never bind or kill the AgileHarness
   service port (`AGILEHARNESS_PORT`, default 3008), never `pkill`.
3. **Validate** every block strictly; an invalid one is re-asked at most twice, then treated as
   NOT VERIFIED (fail closed).
4. **Triage** (`harness-review`'s DEFEITO × DECISÃO rule). You never downgrade a severity or drop
   a finding a reviewer returned: mechanical defect → back to CONSTRUIR and fix; objective
   defect a human must own (security rule, risky refactor) → `blocker` finding + pause; a real
   human decision → a question (P1 fallback path). Any `fail` criterion → back to CONSTRUIR.
5. **Loop bound.** At most **2** returns to CONSTRUIR; every re-verification uses NEW subagents.
   After the second failed re-verification → **P3**, and the owner's rule bounds what comes
   next: **one extra cycle at most (3 in total), decided by someone who is not you; after it, split.**
   - P3 after loop 2: if every acceptance criterion passes and only findings are left, you may instead
     integrate now and open the fix card for the leftover. Otherwise call
     `request_extra_cycle({board, cardId, loopsUsed: 2, failing: [the criteria that still fail, in plain
     words], reason: what the cycle fixes, estimateUSD})` — **never** `ask_question` for this. The cost
     goes in `estimateUSD` (stored as the question's `costUsd`), never in prose. The RULE decides, in any
     mode, and the answer tells you which case you are in:
     - `approved: true` — the first extra cycle, within the card's ceiling: do it now (the owner sees the
       record and may undo it).
     - `verdict: "budget"` — the cycle does not fit the ceiling, so a ceiling request was opened with it
       (`budget.questionId`). This is **P4**: park; when the ceiling is raised the service reopens a
       conductor, and you call `request_extra_cycle` again.
     - `verdict: "owner"` / `"pending"` — the card already used its extra cycle (or the owner undid the
       rule's approval): the question is the OWNER's, written in plain words. Do not answer it; park.
     - Repeating the SAME call (e.g. after an MCP transport error) is safe: it returns what was already
       decided, with the same `questionId`. `approved: true` always means do the cycle; `approved: false`
       on a question the owner already answered carries his decision in `detail` — follow it.
   - After the extra cycle there is NO fourth by you: acceptance passing ⇒ integrate and open the fix card
     for what is left (`create_card` with `continuesFrom: <this card>`, with the open findings — that link is
     what counts the review rounds; any story you create in this session inherits the chain anyway, and a
     `continuesFrom` outside it is refused; if it returns `ownerAsked: true`, the board's rounds cap was reached: no
     card was created, the owner was asked on this card, and you do NOT open another one); a criterion still
     failing ⇒ call `request_extra_cycle` again with `loopsUsed: 3` — it becomes the owner's question
     (accept the risk and integrate / authorize one more cycle / stop) — then park (see "Estacionar e
     retomar"). Never leave a card conducted with no session AND no open question: nobody would know what
     it is waiting for.
   - Every card you create passes the **intake check**: pass `files` (the paths the card touches) so it lands
     on the right board; write the title in plain words (no card id, no file path, no code in backticks);
     a bug says what happens and what was expected. A refusal names what to fix — and, for a wrong board,
     the right one: create it there (never retry the same request unchanged).
6. **Low-risk shortcut.** A change with no UI surface, no auth/rules/payments/personal data/
   schema/public-contract impact, a small diff (≈ ≤3 source files, ≈ ≤50 changed lines) and a
   red→green test may rely on the deterministic gates alone (full suite + typecheck + lint).
   Say so, with the reason, in the Prova.
7. Record the verified code sha `V` (HEAD at verification) in the journal.
