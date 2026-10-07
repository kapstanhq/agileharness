# harness-conductor · pauses, the Inbox question format, park & resume, budget

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read before your first `ask_question`, at every pause, before parking, and at every budget boundary. It is the rule, not a suggestion. A section named in quotes ("Safe landings", "Estacionar e retomar"…) lives in the core or in a sibling `ref/` file — the core's ref index says which. When prose and code disagree, the code wins and this file is the bug.

## Pauses — what the operator does

**Plain-language format of the Inbox (every question you ask).** The Inbox shows a question to a person in
three parts, one per field: `context` = **what happened** (1–2 plain sentences: who did what, what is at stake;
≤ 400 chars), `text` = **what you need from the person** (ONE question; ≤ 240 chars), `options` = **the possible
answers** (2–4; each `label` is a SHORT ACTION that becomes a one-click button, ≤ 60 chars — the why goes in
`pros`/`cons`), `recommendation` = your suggestion (it becomes the «Usar a sugestão» button). No jargon in those
parts: no file names, sha, branch, run, gate, merge, deploy, worktree, finding — say it in words («a busca», «a
publicação»). `ask_question` REFUSES an empty question or one outside these sizes, with what to fix. Example
(invented, the demo bookstore):
`{context: "A busca do catálogo já acha livros pelo título. Para achar pelo autor, ela pode ignorar acentos ou exigir a grafia exata.", text: "A busca por autor deve ignorar acentos?", options: [{label: "Ignorar acentos (Jose acha José)", pros: ["acha mais livros"], recommended: true}, {label: "Exigir a grafia exata", cons: ["quem digita sem acento não acha nada"]}], category: "interview"}`

Every pause is DECLARED on the board, not only said in the terminal: the decision you need is an
`ask_question` on the card (structured: `category`, options with pros/cons, your recommendation) and
`report_progress({..., waiting: "<o que você espera>"})`. A pause that lives only in the terminal is
invisible to the owner, to the Inbox and to the service — a conductor waiting like that can hold
a board slot indefinitely. Then end the turn with the pause id and what you asked.

You do not need anyone to type here: when a question of your card is answered (the owner in the
Inbox, the proxy, an agent) the service types `continuar — <quem> respondeu qN neste card. Releia o
card…` into this session. A human may still say `continuar` by hand. On resume, re-read the card
(answers, `chosenOptionId`, feedback) before acting.

| Pause | Card rests in | The operator… |
|---|---|---|
| P0 precondition | unchanged or `grill` | fixes what you named (claim, token, riskMatrix, reopen), or closes the session |
| P1 questions | `grill` | answers on `/perguntas` (or the Inbox "Perguntas" lane), then says `continuar` |
| P2 design choice | `com-design` | compares the variants on the card's canvas (phone is fine), switches the primary if needed, leaves per-artifact feedback or approvals, then says `continuar` or `ajustar: …`. "Pedir ajuste" also works now: it moves the card to `design-ux`/`design-ui`, where nothing runs (the driver), and you read the feedback there on resume |
| P3 verification exhausted, or a QA proof you cannot honestly stamp | `desenvolver` | nothing for the first extra cycle — `request_extra_cycle` and the owner's rule decide it (a raise of the ceiling may be needed: P4); after it, answers the owner question the rule wrote (accept and integrate / one more cycle / stop); a missing proof is still theirs to decide (`approve_qa` is THEIR tool) |
| P4 budget | last safe landing | `request_budget` already told you who decides: the system (approved at once, or as soon as the quota is back on pace) or the owner, who answers the money question in the Inbox (raise the ceiling, go on with what fits, or stop) |
| P5 delivery | `revisao` | reads `## Prova da entrega`; approves by moving the card to `merge` (Integrar) — it then rests in `release` (Liberar) under the release policy — or asks for changes here |
| approval pending | unchanged | approves/rejects the Inbox request your write opened |

## Estacionar e retomar (park & resume)

A conductor waiting for the OWNER holds a slot other cards need. Parking gives the slot back without
losing anything: your work stays on your branch, your state stays on the card, and when the decision
comes the service opens a new conductor for this card at the FRONT of the queue.

**When to park.** (a) The service typed `estacionar — …` into this session (it does so when you have
been quiet for the board's grace — 10 minutes by default — waiting on something only the owner can
decide), or when a wait you declared with `report_progress` has held a slot past the board's grace
while other cards wait for one — that line also tells you to turn the wait into an owner question
first. (b) You just asked a question that is the owner's (`category: "money"`/`"owner"`, the
`[humano]` marker) — including an edit to a control path you cannot make — and nothing else in the
story can advance without it. A `technical` / `interview` /
`ui-choice` / `delivery` question in ultra is NOT a reason: the proxy answers in minutes — wait.

**How to park, in THIS order:**

1. Write (or rewrite) `## Estado do condutor` in the card body with `update_card` — for a reader who
   did not watch you work: block and step reached; what is done (with sha8s); what is left; the open
   question ids and what each answer changes; loops used; the suites that prove the current state;
   the branch that holds the work (`failed/<your branch>` after the discard — say so) and its last
   sha8; cost so far.
2. Commit everything in the worktree (a WIP commit is fine — nothing uncommitted survives a discard).
3. `release_claim({board, cardId, sessionId})`.
4. `worktree_discard({sessionId})` — a branch with commits that are not integrated is PRESERVED as
   `failed/<branch>`; check the name it returns against what you wrote in step 1.
5. Keep `routing.driver: conductor` on the card. Clearing it would hand the card to the column
   cascade, which restarts from scratch and ignores your branch. The only exception is P5 with
   everything integrated AND no open question of yours — the owner's approval of the delivery is
   all that is left (PUBLICAR step 6): there you DO clear it. Parked in `revisao` because of an open
   QUESTION, keep the driver: when it is answered the service reopens a conductor, which re-reads
   the answer and moves the card on — with the driver cleared nobody would.
6. End the turn with one line. Do not ask for anything else; the service closes this terminal.

A control-path edit you cannot make (or anything only the operator or the owner can do) is an owner question:
the question is what puts the request in the owner's Inbox, and its answer reopens a conductor for this card. A wait
declared only with `report_progress` holds the slot; with cards waiting for one, the service asks you to park after
`autorun.park.declaredAfterMinutes` (30 by default).

**A batch parks as a unit** (`ref/batch.md`): write the note on the LEAD listing every item, commit, then
`release_claim` for the lead AND for every item, keeping the driver on all of them — the service keeps the items with
the lead, so the resumed conductor takes the same batch back.

**Resuming** is PRE-VOO step 8.

## Budget

- Ceiling: `autorun.cardBudgetUSD` in `storymap/settings.yaml` (the service env
  `AGILEHARNESS_AUTORUN_CARD_BUDGET_USD` overrides it and is invisible to you — ask when it
  matters). Absent ⇒ no ceiling, but still report cost.
- Spent = `runner_status({board, cardId}).spentIncludingLiveSessionsUSD`: the card's ledger (earlier
  headless runs + ended conductor sessions) plus YOUR live session, estimated from your worktree's
  transcripts (sub-agents included) with an embedded, dated price table — call it an estimate. When
  your session ends (discard or tmux death) its spend is booked into the ledger (role `session`), so
  `autorun.cardBudgetUSD` sees it from then on.
- At every block boundary: spent + the estimate of the remaining blocks > ceiling ⇒ stop AT the
  boundary and ask for the new ceiling with `request_budget({board, cardId, toUSD, reason})` — `toUSD`
  is the NEW total, `reason` says in one or two plain sentences what is left and what it costs. The
  SYSTEM decides by the owner's rule and tells you which case you are in:
  The ceiling in force is the SMALLER of `autorun.cardBudgetUSD` and the card's kind ceiling (US$ 30 a
  story, US$ 10 a bug/fix — the owner's rule).
  - `approved: true` — the profile's `spendRaise` box ON, within +30% of the ceiling, the first raise of
    this card, and the Claude quota on pace: the ceiling is raised now, recorded for the owner; go on. `runner_status` shows the
    spend, the answer shows the new `capUSD`.
  - `verdict: "wait-quota"` — it fits the envelope but the quota is off pace: your request is an open
    money question on the card and the system approves it by itself when the quota is back on pace.
  - `verdict: "owner"` — above the envelope, a second raise, or `spendRaise` OFF: the same question, for the owner.
  In the last two cases this is **P4**: do NOT answer the question, do not start another block, and park
  (see "Estacionar e retomar") instead of holding the slot — the service reopens a conductor for this
  card, at the front of the queue, when the request is approved (or answered otherwise: then follow
  the chosen option). Never cross a boundary hoping it fits. Never write a budget question by hand
  with `ask_question`: only `request_budget` creates one the system can act on.
- The ceiling is also enforced in code now: the dispatch does not open a conductor for a card whose
  ledger reached the ceiling in force, and a live conductor that crosses it is told so in its terminal
  (`teto — …`). Treat that line as the boundary rule above arriving late: stop at the next boundary
  and call `request_budget`.
- **A batch** has its own ceiling: US$ 10 per item, US$ 30 at most (and none when the board turned the per-card
  ceiling off). Spent = your session plus the ledger of every item. `request_budget` on the LEAD raises the batch's
  ceiling; the rules for judging it are the same.
- Scoped writes count against `orchestrator.maxActionsPerHour`: batch (one `update_card` per
  block, not per field).
