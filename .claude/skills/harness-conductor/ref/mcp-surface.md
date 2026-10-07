# harness-conductor · the MCP surface and `report_progress`

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read when a tool's arguments or a scoped write's `pendingApproval` answer are unclear. It is the rule, not a suggestion. A section named in quotes ("Safe landings", "Estacionar e retomar"…) lives in the core or in a sibling `ref/` file — the core's ref index says which. When prose and code disagree, the code wins and this file is the bug.

## MCP surface you use (verified shapes)

The AgileHarness server is mounted as `storymap` in a fleet session (`mcp__storymap__<tool>`).

| Tool | Arguments |
|---|---|
| `get_card` | `{board, cardId, verbose?}` — `verbose: true` returns the body (needed before any body write) |
| `list_statuses` / `get_vocabulary` / `get_styleguide` | `{board}` |
| `target_profile` | `{board?}` — READ-ONLY: this repository's declared checks (`test`, `testUnit`, `e2e`, `typecheck`, `lint`, `validate`…), `dev` commands, `docs` and the valid `reviewLenses`; `declared: false` when the target declared nothing |
| `read_doc` | `{board, docType?}` — `docType: "prd"`; omit it to list the document types and their section keys |
| `list_cards` | `{board, status?, query?, limit?}` |
| `list_claims` | `{board?, released?}` |
| `update_card` | `{board, cardId, title?, storyType?, narrative?{role,want,soThat}, acceptance?[], personas?[], systems?[], feature?, body?}` — `body` REPLACES the whole body; `feature` is a funcionalidade id from `get_vocabulary` → `features` (an unknown id is refused, `null` clears it); `batch` is the service's, never yours |
| `move_card` | `{board, cardId, status?, parent?, serves?, release?, order?}` |
| `ask_question` | `{board, cardId, texts?[], questions?[], askedBy?}` — `questions[]`: `{text, context?, options?[{label, pros?[], cons?[], recommended?}], mode?: "single" \| "multi", recommendation?, category: "interview" \| "ui-choice" \| "technical" \| "delivery" \| "owner" \| "money", ownerClass?}` (2–4 options, at most ONE recommended; plain-language format below — the tool refuses an empty question or one outside the sizes; `recommendation` only without options). `category` is REQUIRED on every structured question (the tool refuses one without it): it is what the autonomy key reads (see "ULTRA mode"); `ownerClass` names the owner's class on an `owner`/`money` question. Plain `texts` carry no category: on an ultra board a cheap classifier judges them (technical ⇒ proxy, business ⇒ owner) |
| `write_sidecar` | `{board, cardId, kind: "plans" \| "wireframes" \| "proposals", content}` — full file, ≤512KB; `wireframes` is VALIDATED (bad JSON, `format: "html"` without html, html over 32KB or sanitized to nothing ⇒ error naming the artifact) and returns `avisos` for what the sanitizer strips / fixed widths over 390px |
| `add_finding` | `{board, cardId, severity, title, detail?, lens?, id?, file?, line?, suggestion?}` — on MAIN; a stable `id` is idempotent (refreshes content, never the status) |
| `record_decision` | `{board, cardId, what, options[2–6], choice, why, prdAnchor?, undo, by: "harness-conductor"}` — the durable record of a DILEMMA you decided (ultra only; refused in human mode or when the dilemma touches an owner class — then it is an `owner` question) |
| `set_tasks` | `{board, cardId, sessionId, tasks: [{id, title, done}]}` — REPLACES the list on MAIN; only the session holding the card's live claim |
| `set_card_driver` | `{board, cardId, driver: "conductor" \| null}` — null hands the card back to the column cascade (nothing is spawned by the clear itself) |
| `claim_card` / `release_claim` | `{board, cardId, sessionId}` — your session's OWN claim; release never touches another actor's |
| `get_card_wireframes` | `{board, cardId, view?: "full" \| "text"}` — never write the `text` view back |
| `choose_wireframe` | `{board, cardId, optionId}` — a `screen` artifact id; sets `wireframeChosen` |
| `design_feedback` | `{board, cardId, artifactId?, note?, kind?: "change" \| "approve"}` |
| `approve_qa` | the OPERATOR's exit (`{board, cardId, qaPassed?, qaRanAt?, qaCommit?, visual?, suite?, comment?}`) — **never call it**: a scoped call stops in the Inbox as an approval for the owner, and QA is not the owner's decision. Your QA stamp goes in your worktree card (PUBLICAR step 2) |
| `runner_status` | `{board?, cardId?, limit?}` — with both ids: `history[]` (the card's ledger: runs AND ended conductor sessions, role `session`) and, while a conductor lives, `conductorSessions[]` (`estimatedCostUSD` from its transcripts) + `spentIncludingLiveSessionsUSD` |
| `worktree_open` | `{board?, cardId?, task}` → `{sessionId, path, branch, baseCommit}` |
| `worktree_submit` | `{sessionId, message?}` → `{entryId, pinnedSha, committed}` |
| `wait_for_submit` | `{sessionId, timeoutMs?}` (≤600000) → `{state, status, detail?, next}` — keyed by the SUBMITTER's sessionId, so a resumed conductor reads the verdict of the previous session's submission with it (PRE-VOO step 9) |
| `worktree_refresh` / `worktree_discard` | `{sessionId}`; `worktree_discard` also takes `handoff: true` — ONLY at PUBLICAR step 4 (it declares the train handoff) |
| `request_budget` | `{board, cardId, toUSD, reason}` → `{approved, verdict, capUSD, spentUSD, questionId?}` |
| `request_extra_cycle` | `{board, cardId, loopsUsed, failing: [criteria in plain words], reason, estimateUSD}` → `{approved, verdict: approved \| budget \| owner \| pending, questionId?, budget?, detail}` — the P3 extra cycle, decided by the owner's RULE (see VERIFICAR step 5) |
| `wait_for_approval` | `{board, approvalId, timeoutMs?}` |
| `claim_batch` | `{sessionId, board, cardIds}` — takes items of YOUR lead's funcionalidade into your batch, all or nothing; refused after the plan was submitted (`ref/batch.md`) |
| `batch_drop` | `{sessionId, cardId, reason}` — an item leaves the batch (its code already reverted); the service puts it back in the queue alone |
| `report_progress` | `{board, cardId, phase: "moldar" \| "construir" \| "verificar" \| "publicar", note?, waiting?, until?}` — tells the board which block you are in (see "Tell the board where you are"); writes only your session row, never the card, and is never throttled |

A scoped write may come back as `{pendingApproval, riskClass}` instead of running (the board's
`orchestrator.riskMatrix`): call `wait_for_approval`, and on `granted` repeat the SAME call with
the SAME args. Never use `deploy`, `publish_when_idle`, `update_vps`, `write_doc` on the PRD, or
`answer_question` on your own questions.

## Tell the board where you are (`report_progress`)

The owner reads your card on the Kanban, often on the phone. Its status line is built from what you
report («Condutor construindo · há 12 min», «Esperando a janela de ações · volta às 20:00»); without a
report it can only say you are alive. So:

- **At the start of every block**, call `report_progress({board, cardId, phase, note})` with `phase`
  = `moldar` / `construir` / `verificar` / `publicar` and a one-line `note` in Portuguese of what you
  are doing (e.g. «tarefa 3 de 5: o endpoint de métricas»). Re-report inside a block when the note
  changes meaningfully; the block's start time is kept.
- **When you start waiting**, report it with the reason BEFORE you sleep: a tool answer with
  `throttled: true` ⇒ `report_progress({..., waiting: "a janela de ações", until: <its retryAfter>})`;
  the account window / capacity ⇒ `waiting: "a janela da conta"` (with `until` when you know it).
  `waiting` completes the sentence «Esperando …». When you resume, report again WITHOUT `waiting`.
- A data-only checkpoint's `wait_for_submit` needs no report: the board shows the integration itself.

`report_progress` is never throttled (it exists to say that you are), and it never touches the card.
