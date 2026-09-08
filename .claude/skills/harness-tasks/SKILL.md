---
name: harness-tasks
description: >-
  AgileHarness automation that breaks a refined story into technical tasks. Reads a
  card in status `quebrar-tasks` from storymap/boards/<board>/cards/<id>.md,
  decomposes its acceptance criteria into tasks[] ({id,title,done:false}), then
  advances the card `quebrar-tasks` -> `desenvolver` (passing the hasTasks gate).
  With no id it processes the whole `quebrar-tasks` queue of every board. Use
  when the user says "/harness tasks", "/harness-tasks", "quebrar em tasks", "decompor
  story", "gerar tasks", or wants to advance AgileHarness cards sitting in Quebrar em
  tasks. Edits ONLY storymap data files — never the storymap-ui package.
triggers:
  - /harness tasks
  - /harness-tasks
  - quebrar em tasks
  - quebrar story
  - decompor story
  - decompor card
  - gerar tasks
  - usm tasks
---

# /harness-tasks — AgileHarness: break a story into tasks (quebrar-tasks → desenvolver)

The `harness-tasks` trigger automation for the AgileHarness pipeline. It decomposes a
refined story into concrete technical tasks, then advances the card past the
`hasTasks` gate into `desenvolver`.

> Read `storymap/README.md` first — it is the canonical schema/pipeline source.
> This skill edits ONLY the data files under `storymap/boards/<board>/cards/`.
> NEVER touch `packages/storymap-ui/` (UI or data layer).

## When to Use

- A card sits in status `quebrar-tasks` (the `harness-tasks` trigger column).
- The user runs `/harness tasks [<board>/<id>]` or `/harness-tasks [<board>/<id>]`.
- The user asks to "quebrar em tasks", "decompor a story", or "gerar as tasks".

## Input

```
/harness-tasks <board>/<id>      # process one card (e.g. demo/story-frete-opcoes)
/harness-tasks                   # no id = process the ENTIRE `quebrar-tasks` queue
```

- `<board>` = a folder under `storymap/boards/`.
- `<id>` = card id == filename without `.md`.
- With **no argument**, scan `storymap/boards/*/cards/*.md` and process every
  card whose `status` is `quebrar-tasks`, board-by-board, in file order.

If an explicit id is given but the card is NOT in `quebrar-tasks`, do not force
it: report the current status and stop. By the time a card reaches `quebrar-tasks`
it already carries `acceptance` (written upstream by `/harness-enrich`) and a tech plan
(`techPlanReady`, gate hasTechPlan) — if it has no `acceptance`, run `/harness-enrich` first.

## Workflow

1. **Locate the board + card.** Read `storymap/boards/<board>/board.yaml`
   (valid ids, gated statuses) and the target card file.

2. **Confirm the slot.** The card must be `status: quebrar-tasks`. (Queue mode:
   pick every card with that status.)

3. **Decompose into tasks.** From `acceptance[]` + body, derive an ordered set of
   technical `tasks`, each `{ id, title, done: false }`:
   - `id` is a short stable token unique within the card (`t1`, `t2`, …).
   - `title` is an imperative, technical step in PT-BR (e.g. "Persistir a sessão
     nativa do Firebase Auth via signInWithCustomToken"). Cover every acceptance criterion. ALWAYS write it as a
     DOUBLE-QUOTED YAML scalar — `title: "…"` — escaping any internal `"` as `\"`. Task titles
     routinely contain `:`, parentheses and symbols, and an UNQUOTED title with a `: ` (colon +
     space) is parsed by YAML as a nested mapping → it CORRUPTS THE ENTIRE FRONTMATTER (the card
     then fails to parse, `status` reads null, and the card drops out of its column). Quoting is
     mandatory, not optional.
   - Start every task `done: false`. This is the field the `hasTasks` gate checks
     (`tasks.length >= 1`).

4. **Respect the gate, then advance.** Once `tasks` has >= 1 item the `hasTasks`
   gate is satisfied, so change the EXISTING `status:` line IN-PLACE from `quebrar-tasks` to `desenvolver` —
   replace the value on the current `status:` line, NEVER append a second `status:` line (a
   duplicate `status:` key corrupts the card). Bump the existing `updated:` field in-place to
   today. Keep one task per line for clean diffs. Leave `rice`
   at its safe default (four nulls) — RICE is filled at the priorização step.

5. **Report.** State the card moved `quebrar-tasks → desenvolver` and list the
   tasks created. In queue mode, summarize each card processed.

### Gate guardrail

NEVER set `status: desenvolver` while `tasks` is empty — the `hasTasks` gate (and
the `validate-storymap-gate` pre-write/pre-edit hook) will reject the write.
`tasks` only needs to be present when the `status: desenvolver` write is validated — an earlier edit works, so separate edits are fine.
