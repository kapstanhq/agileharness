---
name: harness-sync-card
description: >-
  AgileHarness automation that reconciles ONE card with the app's CURRENT code state,
  autonomously (no confirmation). Triggered by the per-card "Sincronizar" button
  (or `/harness-sync-card <board>/<id>`), it reads a card from
  storymap/boards/<board>/cards/<id>.md, DIAGNOSES the live implementation that the
  card describes (which routes/components/actions/functions exist TODAY) READ-ONLY,
  updates ALL of the card's fields to match reality (title, narrative, acceptance,
  tasks done-state, RICE/KANO/funnel when derivable, personas/systems, a `## Estado
  atual` diagnosis in the body) and REPOSITIONS the card into the status the FACTS
  justify — respecting the pipeline gates and a conservative "done" ceiling. Unlike
  the board-level `/harness-sync`, this is single-card and never asks. Use when the user
  says "/harness-sync-card", "sincronizar card", "sincronizar este card", "reconciliar
  card com o código", or clicks the per-card Sincronizar button. Reads product code
  READ-ONLY to diagnose; edits ONLY the card .md — never product code, never the
  storymap-ui package.
triggers:
  - /harness-sync-card
  - sincronizar card
  - sincronizar este card
  - reconciliar card com o código
  - usm sync card
---

# /harness-sync-card — AgileHarness: reconcile ONE card with the live code (autonomous)

The `harness-sync-card` trigger automation. It is the engine behind the per-card
**Sincronizar** button: an agent reviews a SINGLE card against the **real code**,
updates all of its information to match reality, and repositions it into the right
column **based on facts** — autonomously, with NO human confirmation (it is a
headless, button-triggered run).

> Read `storymap/README.md` first (schema + pipeline + gates). This skill edits ONLY
> the card `.md` (`storymap/boards/<board>/cards/<id>.md`). It reads PRODUCT code
> READ-ONLY to diagnose (`Grep`/`Read`/`git log`) and NEVER writes product code, and
> NEVER touches `packages/storymap-ui/`. Permission mode:
> dangerously-skip-permissions (it runs read-only Bash for diagnosis).

> Difference from `/harness-sync`: that one reconciles a WHOLE board and CONFIRMS every
> change with the user (AskUserQuestion). THIS one is a single card and is
> **autonomous** — no questions, because it runs headless from a button click.

## Input

```
/harness-sync-card <board>/<id>     # reconcile exactly one card (the button's contract)
```

`<board>` is the folder under `storymap/boards/`; `<id>` is the card filename stem.
For a whole-board reconciliation with confirmation, use `/harness-sync <board>` instead.

## Workflow

1. **Locate + read.** Read the board's `board.yaml` (its `package:`, the valid
   `statuses`/`releases`/`personas`/`systems` ids, and **which statuses carry a
   gate**) and the card `.md` (every field + body). Note its `type`
   (activity/step/story) and current `status`.

2. **Diagnose the LIVE implementation (read-only).** Run the canonical diagnosis —
   **`@.claude/skills/harness-triage-shared/DIAGNOSIS.md`** (Grep/Read/`git log` over
   `packages/<pkg>/` — routes/pages, components, server actions, Cloud Functions, flow;
   never run builds/tests just to scan; the load-bearing rule **"presença de código ≠
   shipped"** — does this exist today, fully/partially/not at all, and is there evidence
   it's live, not just present in code?). Capture the key files you found — it pins the
   card to real files instead of guessing. The reconciliation overlay (`## Estado atual`
   + the conservative "done" ceiling) is in steps 3–4 below.

3. **Reconcile ALL fields with the facts.** Update every field so the card reflects
   reality (keep ids valid against `board.yaml`; PT-BR brand voice — see
   `[[feedback_brand_vocab_blacklist]]`):
   - **title** — sharpen if it drifted from what the code actually does (imperative,
     Patton style). Keep stable ids; don't rename the file.
   - **narrative** (stories) — make `role`/`want`/`soThat` describe the real
     capability; fill it if the code makes the intent clear.
   - **acceptance** — rewrite to mirror what is TRULY implemented vs. still missing
     (Gherkin recommended). Don't list criteria the code doesn't meet as if met.
   - **tasks** — mark `done: true` for work the code already ships; keep/append
     `done: false` for what's still missing. Keep stable task ids.
   - **rice / kano / funnelStage** — fill ONLY when derivable from the card +
     evidence; never invent numbers to satisfy a gate. Leave as-is/null otherwise.
   - **personas / systems** — set from the board vocabulary to match the surface.
   - **storyType** — correct it if the nature (user/technical/spike/bug/chore) drifted.
   - **body** — write a concise **`## Estado atual`** section: the diagnosis (key
     files + what exists vs. what's missing), the evidence level (in-code only vs.
     shipped/live), and the repositioning decision + why. Don't duplicate `acceptance`.
   - **Preserve pipeline-owned fields you can't verify** (`wireframeChosen`,
     `findings`, `techPlanReady`, `reviewedAt`, `reviewCommit`) — don't wipe them; a
     sync is reconciliation, not a review. If the card is `mode: refine` OR `mode: fix`,
     KEEP `mode` + the reopen block (`refinement`/`bugReport`) and be conservative about
     status (don't yank it out of an in-flight refine/fix — the broken/old code still
     looks "shipped", so don't let the FACTS repositioning drag it back to revisao/concluida).

4. **Reposition by FACTS (respect gates + the conservative ceiling).** Choose the
   HIGHEST status the evidence justifies AND whose gate you can satisfy TRUTHFULLY,
   and set `status` in the SAME edit that fills that gate's field (mirrors the
   write-boundary gate hook — a gated status with a missing field is rejected). Map
   reality → status (ids from an example pipeline; adapt to the board):
   - **Not implemented + thin card** → `triage` (the staging intake) — or `enriquecer` if
     there's already enough narrative to enrich next.
   - **Specced but not built** → the matching pre-build stage by what's filled (each gate
     now guards the producer's entry): `priorizar` (narrative+acceptance) · `pronta`
     (RICE+KANO+funnel) · `com-design` (wireframe chosen) · `quebrar-tasks` (tech plan) ·
     `desenvolver` (tasks).
   - **Partially implemented** → the pipeline stage that matches what's really there.
   - **Fully implemented but NO evidence of human validation** → ceiling is
     **`revisao`** (awaiting QA). Code presence ≠ validated.
   - **`concluida` (terminal) ONLY with strong evidence** it's shipped/live/validated
     (e.g. clearly in production, referenced as done). Default away from terminal.
   - **Never fabricate a gate field to inflate status.** If you can't fill the gate
     truthfully, stop at the last status you CAN sustain, and say so in `## Estado atual`.
   - **Don't reposition just to move it.** If the current status already matches the
     facts, keep it — only update the fields.

5. **Report.** State: the diagnosis (files found + fully/partially/not implemented +
   evidence level), what you changed on the card, and where you repositioned it
   (`<from> → <to>`) and why (or that you kept the status).

## Card types

- **story** — full reconciliation above + reposition in the pipeline.
- **activity / step** (backbone) — reconcile title/description and the structural
  `## Estado atual`; set a coherent `status` if the board uses one for backbone, but
  do NOT force story-only fields (narrative/acceptance/tasks/rice). These are
  structure, not pipeline stories.

## Guardrails

- **Autonomous — never ask.** No AskUserQuestion; this runs headless from a button.
- **Read-only on product code.** Diagnose only; never edit `packages/<pkg>/`. The only
  file you write is the card `.md`. Never touch `packages/storymap-ui/`.
- **Ground every field in evidence.** Position by FACTS, not optimism. When unsure,
  under-claim (lower status, narrower acceptance) and record the uncertainty in
  `## Estado atual`.
- **Respect gates + the conservative ceiling.** Fill the gate field in the SAME edit
  that changes the status; cap implemented-but-unvalidated work at `revisao`.
- **Don't recreate from scratch.** Anchor to the existing implementation found in
  step 2; you are reconciling a card, not rewriting the product.
- Keep one field per line in the frontmatter for clean diffs; reuse only ids that
  exist in `board.yaml`.
