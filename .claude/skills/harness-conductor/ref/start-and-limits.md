# harness-conductor · starting a conductor, and the known limits

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read when the operator asks how conductors start or what the tool does not do yet. It is the rule, not a suggestion. A section named in quotes ("Safe landings", "Estacionar e retomar"…) lives in the core or in a sibling `ref/` file — the core's ref index says which. When prose and code disagree, the code wins and this file is the bug.

# /harness-conductor — one conductor per story (MOLDAR → CONSTRUIR → VERIFICAR → PUBLICAR)

**Why this exists.** A column-per-run pipeline pays a hand-off at every stage: a fresh context
re-reads what the last one already knew, a stage that already ran gets re-run, work built between
fresh runs can be lost or collide, and a prioritize/go-no-go step that never says no adds latency
without information. So: ONE context writes each unit
of work, and the work is split only where it must be — at a **human decision**, at an
**independent verification** (clean context), or for **truly parallel** work.

> Read `storymap/README.md` (card schema, pipeline) once. You run as an interactive fleet
> session: the operator watches your terminal, and every pause below ENDS YOUR TURN with a
> message saying exactly what they must do. You are not a column trigger: the board's conductor
> DISPATCH opens you when a story ENTERS a status, and your card carries `routing.driver:
> conductor` — which is what silences the column cascade for it.

## Starting a conductor

**By the board (the normal path).** The operator declares it once in the board's `board.yaml`:

```yaml
conductor:
  enabled: true
  fromStatus: pronta     # the status whose ENTRY dispatches the conductor (NOT the «vai» to build: that comes after the plan — yours with the `spec` box ON, the owner's with it OFF)
  maxSessions: 2         # live conductors per board (default 2); the excess waits in a durable queue
  model: opus            # optional (default opus): one context carries the whole story
```

When a story enters `fromStatus` (and the autorun master switch is on and the board is armed), the
service stamps `routing.driver: conductor` on it and opens this session through the same door
`claude_new` uses (admission + resource probe, worktree, claim `implement/both`, scoped MCP token,
tmux `agent-conductor-<cardId>`, role `implement`), with `/harness-conductor <board>/<cardId>` as
the first line of the prompt. A card waiting for a slot is dispatched when one frees (the fleet tick
re-checks every minute). A conductor that DIES is not reopened automatically: the driver stays (no
stale column run) and the operator decides. A conductor that ENDED at the merge-train handoff
(PUBLICAR step 4) is different: the service reopens one, at the front of the queue, when the train
decides.

**By hand (the operator):**

```
claude_new({ role: "implement", board: "<board>", cardId: "<id>",
             task: "/harness-conductor <board>/<id> — conduzir a story de ponta a ponta",
             model: "opus" })
```

- `role` MUST be `implement` (or `free`): both reserve the card as `implement/both`, the claim that
  refuses every run on the card. `review` would let the light lane through.
- `model` is optional; without it a conductor opened by hand gets the dispatched conductor's model: the
  board's `conductor.model`, capped by the card's type (Sonnet for a bug or chore with no high risk). One
  context carries the whole story.
- `claude_new` is `run-free` — only the operator's `full` token can call it. When the task starts with
  `/harness-conductor` (or the card already carries the driver) the session is born with the conductor's
  scope: the native tool list, the conductor MCP toolset and the context pack.
- What a conductor session really holds: the SCOPED `orch` token (G12), narrowed to the conductor's
  tools by a header the session itself declares — context, not containment: the same token without the
  header reaches the whole `orch` surface. AND a shell: `Bash` and `Agent` subagents, in its worktree, as the
  service's user. The limits that actually hold are the host's hard lock on `Bash`, the token's level and the
  board's riskMatrix dispositions — never this toolset, never this file.
- A hand-opened session's CARD does not carry the driver yet: PRE-VOO sets it (`set_card_driver`).

## Known limits (core follow-ups — do not pretend otherwise)

Screenshots have no durable per-card home (the delivery audit shows the `## Prova da entrega` text, not the
PNGs). A conductor that
dies is never reopened automatically (the driver stays; the watchdog shows the card as stalled in the
Inbox and the operator reopens with `claude_new` or clears it) — a PARKED card is different: it is
reopened by the service, at the front of the queue, when its open questions are answered; and so is a
card whose conductor ENDED at the train handoff, when the train decides (PUBLICAR step 4). The session's cost is an ESTIMATE (embedded price table; a model it does not know is
priced by family or left unpriced), booked when the session ends — a tail spent after
`worktree_discard` is not counted. The dispatch queue is re-checked on the fleet tick (disabled
when `AGILEHARNESS_FLEET_RECONCILE_MS <= 0`), obeys the autorun master switch and the board's arm,
and a hand-opened conductor does not count against `maxSessions`. `techPlanReady`, `hasUiSurface`
and `criteriaSpecs` still have no MCP writer (worktree + submit); the QA stamp (`qaPassed`/`qaEvidence`) is
written there BY DESIGN — the same path `harness-qa` uses, carried to main by the train.
