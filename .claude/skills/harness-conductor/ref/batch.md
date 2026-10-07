# harness-conductor · the BATCH (fixes and maintenance of one funcionalidade)

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read when your lead is a bug/fix or
> a chore and your task lists batch candidates, and again at every drop, train verdict and stop of a batch. It is the
> rule, not a suggestion. When prose and code disagree, the code wins (`runner/conductor-batch.ts`,
> `runner/conductor.ts`, `mcp/dev-tools.ts`) and this file is the bug.

## What a batch is

A NEW thing (a user story, a technical story, a spike) always runs ALONE: one conductor, one card. Fixes and
maintenance of the SAME funcionalidade (the card's `feature`, the PRD group the Kanban shows) may share ONE session:
you, the conductor of the lead card, take more items into a batch. The service never opens two conductors on the
same funcionalidade at the same time; while you hold it, the other items of that funcionalidade wait in the queue.

## 1 · Choosing the items (PRE-VOO step 2b)

- Your task names the queued candidates (ids only). Read each one (`get_card`). YOU choose — there is no fixed number.
- Take an item only when it is the same funcionalidade, the change is coherent with the lead's (same area, one
  plan reads naturally), and it fits the money: US$ 10 per item, US$ 30 for the whole batch at most. More than three
  items share the US$ 30 — size the batch so it fits; when in doubt, fewer.
- `claim_batch({sessionId, board, cardIds})` with the items (not the lead). All or nothing: a refusal names the item
  and why (another funcionalidade, a story, an item already dropped from a batch, a foreign claim, the money). Fix the
  list and try again, or go alone.
- The batch CLOSES when you submit the plan for approval: no `claim_batch` after that.

## 2 · Plan, build, verify — per item

- ONE plan on the lead (`write_sidecar` kind `plans`) with a `## Item <id>` section per item (what changes, tests,
  risks). Each item card gets a one-line plan pointing to the lead's. The plan critic, or the owner's «Pode
  construir?» in Mínima, judges the WHOLE batch once (`ref/critics-and-mailbox.md`).
- Each item keeps its OWN acceptance and its own tasks (`set_tasks` per card).
- Commit per item, each commit with the trailer `Card: <id>` (the lead's commits too). Never mix two items in a commit.
- VERIFICAR fans out ONE verifier per item, in ONE message, each against its own frozen acceptance.

## 3 · An item that fails leaves (decision of the owner)

- An item that does not pass verification, or that the owner moved out of its column, leaves the batch; the others go on.
- First take its code out of your branch: `git revert` its `Card: <id>` commits, with the trailer
  `Card-Revert: <sha>`. If a revert conflicts with a later item's commit, rebuild your branch in YOUR worktree: start
  from the batch base and cherry-pick only the surviving items' `Card:` commits (destructive git is free in your own
  worktree). `worktree_submit` refuses a range that still carries a dropped item's code.
- Then `batch_drop({sessionId, cardId, reason})` — the reason in plain words. The service releases the item, writes
  the reason on it and puts it back in the queue ALONE.
- The lead cannot be dropped: if the lead fails, release the items with `batch_drop` and finish or park the lead alone.

## 4 · Publish, the train and the stops

- `## Prova da entrega` on EACH item card, written as for a single card (its own change, contract, tests).
- One `worktree_submit` for the batch; the handoff note (`## Estado do condutor` on the lead) lists every item and
  its state. The service reopens ONE conductor for the lead with the items (`ref/publicar.md`).
- A train rejection you can attribute to ONE item ⇒ drop that item (section 3) and submit again. One you cannot
  attribute, or a second rejection of the same batch ⇒ the service SPLITS it: the items go back to the queue alone,
  and the resumed lead rebuilds its branch with only the lead's commits.
- Mínima (the `spec`/`delivery` boxes OFF): ONE stop for the plan and ONE for the delivery, each listing every item.
  At P5, clear the driver on EVERY item card, not only the lead — the owner approves the batch with one click.
- A batch session that dies leaves every item with the driver, waiting for the operator, like the lead; the alert
  names them all.
