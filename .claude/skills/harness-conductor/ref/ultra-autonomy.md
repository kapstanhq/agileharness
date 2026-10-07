# harness-conductor · the autonomy profile and ULTRA (business-only) mode

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read in PRE-VOO, when `board_autonomy` shows any box ON or the card's `autonomyMode` is set. It is the rule, not a suggestion. A section named in quotes ("Safe landings", "Estacionar e retomar"…) lives in the core or in a sibling `ref/` file — the core's ref index says which. When prose and code disagree, the code wins and this file is the bug.

## The autonomy PROFILE (what agents decide alone — read it, never deduce it)

Call `board_autonomy({board})` in PRE-VOO. It returns `profile` — one box per decision — the `preset`
(minima / maxima / personalizada) and `alwaysOwner`. The owner sets it in the «Autonomia» panel; no agent
changes it (there is no write tool, and the train restores it if a worktree touches it). Each box decides
ONE stop:

| Box | ON: who decides | OFF: the stop is the owner's |
|---|---|---|
| `spec` | the service-launched plan critic (clean context) approves the plan before you build — wait for its line; two rejections send the plan to the owner (`ref/critics-and-mailbox.md`); the proxy answers `interview`/`technical` questions | the owner approves the plan — the SERVICE opens the «Pode construir?» question; you park (P1) — and answers those questions |
| `design` | the proxy picks the variant (`ui-choice`) | the owner picks (P2) |
| `delivery` | you cross «Aprovar entrega» with `## Prova da entrega` | P5 — locked in code: `move_card` refuses |
| `publish` | the release policy publishes by itself | the owner presses «Publicar» |
| `deploy` | a deploy may be requested through the ritual | deploy waits for the owner |
| `spendRaise` | one raise per card within the envelope and the quota pace | every raise is the owner's (P4) |
| `copilot` | the service's $0 unsticking runs on this board by itself (steward, recovery, the repair card) when the Sentinel finds a cause | nothing moves cards by itself; the Sentinel only diagnoses here. The owner's chat acts when he asks, box on or off |
| `sentinel` | the Sentinel REPAIRS the machine: Bash under the host's hard lock, contained by the OS sandbox (writes only its scratch dir), machine fixes through its own MCP tools — never story cards, questions, triage or delivery | the Sentinel only diagnoses and opens an Inbox item with «Resolver no chat» |

The card's `autonomyMode` (owner-only, `set_card_autonomy`) overrides ONLY `spec`/`design`/`delivery` for that
card. `alwaysOwner` never moves with any box: money (including ANY change to billing/payment code), brand voice
outside the product, PRD and goals, people's data, the commands the server lock refuses, shell/irreversible
actions. A question that would change or delete an EXISTING test is `category: "guardrail"`: on a business-only
board the service's independent diff reviewer decides it by reading the diff (`ref/critics-and-mailbox.md`) — never
the proxy, never you (`answer_question` refuses); rejected, or in human mode, it is the OWNER's. The merge train
enforces both in code: a diff touching billing/payment paths marks the card as touching money (its publish waits for
the owner), and a diff that edits or deletes an existing test opens that `guardrail` question. With `spec` OFF the plan's «vai», triage, technical approvals and
dilemmas are the owner's too — the boxes never leak. «ultra» below means: a story box is ON for this card.

## ULTRA mode = BUSINESS-ONLY (the autonomy key)

The board declares `autonomy: {mode: human | ultra, proxyModel?, auditSampleRate?, ownerClasses?}` in
`board.yaml`; a story can carry its own exception (`autonomyMode`, set by the OWNER with `set_card_autonomy` —
never by you). `get_card` returns `_autonomy: {mode, source}` whenever a mode is declared; absent ⇒ **human**.

The owner is NOT technical: in **ultra** the system stops for the owner ONLY on the owner's BUSINESS classes
(`autonomy.ownerClasses`, default from `_base`): `money` (spend, vendor, paid plan, price, payment code, a cost
increase over the monthly ceilings, changing the AI model that serves end users), `brand-voice` (speaking for the
brand OUTSIDE the product — screen copy follows the style guide and is not theirs), `prd` (the PRD and its goals)
and `personal-data` (collecting data that identifies a person, sending data to a NEW vendor, deleting people's data,
changing what is public — anonymous measurement inside the current privacy policy is technical). Everything else you and the system decide by what best serves the PRD's main goal,
with proof and a record. A card that touches an owner class carries `businessClasses` — its stops are the
owner's.

In **ultra**:

- **P1 (questions) and P2 (design choice) are resolved by the PROXY — not by you — each within its box**
  (`spec` for `interview`/`technical`, `design` for `ui-choice`, `delivery` for `delivery`; a box OFF keeps
  that category with the owner). Ask exactly as in human mode (structured, with `category`). The service
  spawns a PROXY for every open question in scope (an uncategorized one is first judged by a cheap classifier, reason
  recorded on the question): a separate headless run with a CLEAN context (no MCP, a temp dir), guided only by the PRD,
  personas, style guide and the OWNER's past answers — it is BLIND to you: it never sees your `recommended`
  flags, your prose recommendation, your options' pros/cons, their order (shuffled) or your variants note.
  So put the FACTS in `context`, not the argument. It answers with recorded premissas + a confidence
  (`answeredBy: "proxy"`), and the service types `continuar — o PROXY … respondeu qN …` into THIS session.
  Then re-read the card (`get_card`) and go on. It may DECLINE (or fail twice): the question is then the
  owner's (`proxy.declined`), exactly as in human mode.
- **You never answer your own questions** — not with `answer_question`, not by editing the card.
- **Business never goes to the proxy** (category `money`/`owner`, the `[humano]` marker, or price/vendor/spend
  words in the question TEXT — with a declared category the context is not read for them, so describe the
  product freely there and never write a technical question's cost as prose: costs are data, like
  `estimateUSD`): it waits for the owner in the Inbox — for as long as it takes. It never expires and never defaults to
  your recommendation. Keep working on whatever does not depend on it; stop at the boundary that does (the rest of
  the board is never blocked by it). `answer_question` refuses an owner question from any agent, and `move_card`
  refuses to carry a card toward production (out of the delivery approval, up to Publicar) while an owner decision
  on it is open — its question, or the card touching an owner class. Moving it back, or working other cards, is
  free.
- **P5 (delivery) — only with the `delivery` box ON:** after the `## Prova da entrega`, try `revisao` -> `merge`
  (Integrar) instead of pausing: the first try launches the service's independent delivery verifier and is refused
  until it approves THIS change; on approval the SERVICE moves the card (`ref/critics-and-mailbox.md` §3) — unless the delivery touches an owner class (the card's `businessClasses`, payment code, a PRD
  change, people's data), then P5.
  Publishing stays with the board's release policy. **Notice after, sampled audit:** when a story you delivered this
  way reaches the board's `delivered` status ("No ar"), a deterministic sample (by card id) is audited. A delivery
  the USER SEES (a screen or a text — the same `hasUiSurface` rule as the visual QA gate), at `auditSampleRate`,
  lands on the owner's Inbox as "Entrega autônoma" with your `Antes:` / `Depois:` / `Link:` lines side by side — so
  write them in plain words. A TECHNICAL delivery never goes to the owner: at `technicalAuditSampleRate` (default
  0.2) an independent auditor (clean context, the target's `code-reviewer` role) reviews your commit range against
  your proof, and opens a fix card when it finds a problem. Either way, write the proof for a reader who did not
  watch you work. The owner confirms it, or REOPENS it: the story comes back in
  `mode: refine` with the owner's reason as the brief and an open `delivery-audit` finding (a reopen clears the
  driver — the refine triage owns it from there; a later conductor treats that finding as part of the contract).
  A delivery the owner moved out of the approval step themselves (a P5 you paused on) is never sampled.
- **Cost before publishing.** Before PUBLICAR, call `record_cost_projection({board, cardId, monthlyAmount, scope:
  "infra"|"cash", assumptions, baselineMonthlyAmount?, newVendor?, paidPlan?, paidApi?, by: "harness-conductor"})` — a
  simple, honest monthly projection with its assumptions (0 when the delivery costs nothing more), in the
  board's currency (you never choose the currency; the board or the target declares it — if neither does, the tool
  refuses and says what to declare). Inside the owner's
  ceilings (`autonomy.budget`) the system decides; over a ceiling, or any NEW vendor / paid plan / paid API, the card
  starts touching `money` and its P5 is the owner's.
- **Dilemmas are decided, not asked.** A technical trade-off that affects the product (cutting scope to meet a
  date, a cheaper acceptance criterion, deferring an error state) does NOT stop: decide by what best serves the
  PRD's MAIN GOAL and record it with `record_decision` — what, the real options, your choice, why (tied to the PRD,
  `prdAnchor` = the passage) and how to undo it. It lives on the card (`decisions`); the owner sees it and may undo
  it — their reason then lands as an open finding: treat it as part of the contract on resume. A dilemma that
  touches an owner class (a PRD goal, money, the brand outside the product, people's data) is an `owner` question
  instead, never a record.
- A sample of the proxy's answers (`auditSampleRate`, default 0.2, plus every answer below 0.5 confidence) goes
  to the owner's audit list; a REOPENED answer returns to the owner and is never proxied again — treat its new
  answer as authoritative on resume.
