---
name: harness-capture
description: >-
  AgileHarness automation that turns a free-text BRAIN-DUMP into a card PROPOSAL,
  asynchronously, via the pipeline. Reads an EPHEMERAL capture container card
  (`capture: true`) in status `capturando` from storymap/boards/<board>/cards/<id>.md
  — the source free text rides in its `body` — plus the board's vocabulary
  (personas/systems/releases) and the existing backbone/stories (to reuse parents by
  id and detect duplicates), then GENERATES a proposal of which cards to create
  (applying the granularity discipline: story ≠ task; consolidate technical sub-steps
  into one story; 1 story = 1 cohesive PR; when in doubt FEWER cards). It does NOT
  create the real cards — it writes the proposal to the sidecar
  storymap/boards/<board>/proposals/<containerId>.json (a `ProposalDoc`) and STOPS — the
  container PARKS in `capturando` (a MANUAL stop — a hidden lane; the skill does NOT advance
  it), where a human reviews and accepts the proposal on Inbox. On a RE-RUN (refine) the
  sidecar already carries new `feedback[]` —
  regenerate the WHOLE proposal incorporating ALL of it (never a diff), preserving the
  feedback array. With no id it processes the whole `capturando` queue of every board.
  Use when the user says "/harness capture", "/harness-capture", "captura inteligente",
  "propor cards", "transformar texto em cards", "brain-dump para o board", or wants to
  advance AgileHarness capture containers sitting in Capturando. Edits ONLY storymap data
  files (the proposal sidecar + the container .md) — never the storymap-ui package,
  never product code.
triggers:
  - /harness capture
  - /harness-capture
  - captura inteligente
  - propor cards
  - transformar texto em cards
  - brain-dump para o board
  - gerar proposta de cards
  - usm capture
---

# /harness-capture — AgileHarness: smart capture (parks in Capturando)

The `harness-capture` trigger automation for the AgileHarness pipeline. It is the
**asynchronous** smart-capture: a human drops a free-text brain-dump and it becomes a
structured **proposal** of cards to create — without touching the board yet. A short-lived
**capture container** card (marked `capture: true`, its source text in the `body`) enters
the `capturando` step; this skill reads the board context + the text + any accumulated
refine feedback, generates a `ProposalDoc`, writes it to the proposal sidecar, and STOPS —
`capturando` is itself the **manual stop** (a hidden lane; the skill does NOT advance the
container). A human reviews and accepts the items on the **Inbox** queue (acceptance is
what mints the real cards in Triagem; this skill NEVER creates them).

> Read `storymap/README.md` first — it is the canonical schema/pipeline source, and
> `board.yaml` is the source of the `personas`/`systems`/`releases` and the existing
> backbone you reuse. This skill edits ONLY the data files under
> `storymap/boards/<board>/` (the proposal sidecar + the container `.md`). NEVER touch
> `packages/storymap-ui/` (UI or data layer) and NEVER product code — capture is
> planning, there is no code to read or write.

## When to Use

- A capture container card (`capture: true`) sits in status `capturando` (the `harness-capture`
  trigger column, `autorun: true`).
- The user runs `/harness capture [<board>/<id>]` or `/harness-capture [<board>/<id>]`.
- The user asks for "captura inteligente", "propor cards a partir deste texto", or to turn a
  brain-dump into a proposal before anything lands on the board.

## Input

```
/harness-capture <board>/<id>     # process one container (e.g. storymap/story-a1b2c3)
/harness-capture                  # no id = process the ENTIRE `capturando` queue
```

- `<board>` = a folder under `storymap/boards/` (e.g. `demo`, `demo-legado`).
- `<id>` = the capture container id == the markdown filename without `.md` (this is the
  `containerId` used everywhere below).
- With **no argument**, scan `storymap/boards/*/cards/*.md` and process every card whose
  `status` is `capturando` (they are all `capture: true` containers), board-by-board, in
  file order.

If an explicit id is given but the card is NOT in `capturando`, do not force it: report the
current status and stop (the trigger only owns the `capturando` slot).

## The container is ephemeral — you never create the real cards

The card in `capturando` is a **container**, not a story: it carries `capture: true` and its
ONLY payload is the free-text source in its `body`. Your output is a **proposal**, not cards.
So:

- **NEVER call `create_card` / never write new `cards/<id>.md` files.** A human accepts the
  proposal on Inbox; THAT is what mints the real cards (into Triagem). You only write the
  sidecar + advance the container.
- **The `containerId` is immutable.** It was minted once at capture (`story-<hash>`) and stays
  exactly that for the container's life. Do NOT rewrite it to a slug, do NOT create a new file
  and delete the old one — the sidecar is keyed by this id (`proposals/<containerId>.json`) and
  a rename orphans it. Edit the container in place at
  `storymap/boards/<board>/cards/<id>.md`.

## First run vs. re-run (refine)

The refine feedback history lives in the **sidecar** `proposals/<containerId>.json`, in the
`feedback: string[]` field, **oldest-first** (the last entry is the most recent).

- **First run:** the sidecar does NOT exist yet (no `proposals/<id>.json`). Treat `feedback`
  as `[]`, generate the first proposal, and create the sidecar.
- **Re-run (refine):** the sidecar already exists with NEW feedback appended at the end. Read
  ALL of it and **regenerate the ENTIRE proposal incorporating EVERY feedback entry — not a
  diff, not only the latest change.** A later feedback can reverse an earlier one; honor the
  net intent across the whole list. **Preserve the `feedback[]` array unchanged** in the
  sidecar you write back (never drop or rewrite past feedback — it is the conversation memory).

## Workflow

1. **Locate the board + container.** Read `storymap/boards/<board>/board.yaml` to learn the
   board's `personas` (with their `jobs`/`pains`/`gains`), `systems`, and `releases`, and the
   valid ids. Read the container card file: confirm `capture: true`, status `capturando`, and
   take the free-text **source from its `body`**. Read the existing **backbone + stories**
   (`storymap/boards/<board>/cards/*.md`) as a compact `id — "title"` tree (activities → steps
   → stories, plus orphan backlog stories) so you can reuse existing parents by id and detect
   duplicates. Read the existing sidecar `proposals/<containerId>.json` if present (its
   `feedback[]` is the refine history).

2. **Confirm the slot.** The container must be `status: capturando` and `capture: true`. (Queue
   mode: pick every such card.)

3. **Generate the proposal — apply the granularity discipline.** A **STORY** is the smallest
   increment of observable VALUE worth ONE full delivery cycle (concept → code → review → QA);
   it is NOT a technical step. Each proposed story becomes ONE pipeline run and ONE cohesive PR,
   so slicing thin makes N runs repeat the same context and, under autorun, CONFLICT editing the
   same files. **When in doubt, FEWER cards.** Concretely:
   - **Do NOT propose a card for a technical sub-task of one capability** (e.g. "criar a action X",
     "adicionar o campo/flag Y", "criar o helper Z", "ligar o botão", "modelar o tipo", "escrever
     o badge"). That is a TASK — the later `harness-tasks` step generates those INSIDE the story. Stop
     at the story level.
   - **GROUP into the SAME story** items that (a) deliver ONE cohesive capability, (b) touch the
     SAME surface/files, or (c) are sequential/coupled (one depends on the other). One story = 1
     cohesive PR.
   - **Only split into DISTINCT stories** capabilities that are genuinely INDEPENDENT (different
     surfaces/files, each shippable alone with its own value).
   - **Ignore the SHAPE of the input text:** even if the user lists technical steps ("fazer X,
     depois Y, depois Z"), CONSOLIDATE them into the story they serve — do not mirror the list
     1:1 into cards.
   - **Umbrella card with pre-seeded `tasks` (WS7 consolidation):** when you consolidate N similar
     adjustments on the SAME surface/file into ONE story, you MAY emit them on that story as
     `tasks: [{ title }, …]` (bare `{ title }` is fine — `id` optional). They map to `Card.tasks`
     (done:false) so the decomposition survives to `harness-plan`/`harness-do` instead of being lost. Use
     this ONLY for the same-surface consolidation case — a normal story still leaves its task
     breakdown to the later `harness-tasks` step.
   - **Sanity check:** most captures yield **1–4 stories**. Far more than that? You are probably
     slicing TASKS as cards — reconsolidate.
   - **Reuse the backbone:** prefer hanging stories under an EXISTING step/activity (use its id as
     `parent`). Propose a NEW step/activity only when the text clearly introduces an area that does
     not exist yet — then use that new item's `tempId` as the `parent` of its stories.
   - **NEVER mint an idea (WS-9 / D15).** Structured capture only proposes `story`/`step`/`activity` —
     it does NOT create `type: idea` (◆). Raw pain WITHOUT a decided deliverable belongs to the
     **Ideias bench** (a separate, lighter entry — `create_idea` / the Ideias view), where
     someone deliberately explores it. So: if the text has a discernible deliverable behind a pain, propose the
     closest story and note the low certainty in `rationale`; if it is *only* pain, do NOT invent a card — put a
     note in `summary` ("há uma dor crua aqui — registre na bancada de Ideias: «…»"). A story MAY point
     `addresses` at an EXISTING open idea, but never create one. (A stray ◆ that slips through is ignored
     at accept — the mint is barred; see ADR-064.)
   - **storyType:** `user` by default; `technical` for infra/enabler, `spike` for investigation,
     `bug` for a fix, `chore` for maintenance (source of truth: `frameworks.ts` `STORY_TYPE_DEFS`).
   - **Dual-track `serves`:** ONLY for a DELIVERY item (`storyType` technical/bug/chore/spike) —
     point it at the id (or `tempId`) of the USER STORY it implements, so the delivery ticket shows
     on that story's shelf (one story can carry several tickets: feature/bug/etc.). Omit `serves`
     for `user` stories and backbone; when empty it falls back to `parent`.
   - **duplicateOf:** if an item looks like it already exists on the board, set `duplicateOf` to the
     existing id (still propose it, but flag the duplicate so the human can decide).
   - **Ground in vocabulary:** set `personas`/`systems` to RELEVANT ids that EXIST in `board.yaml`
     (the personas' `pains`/`gains` are the lens for what's worth proposing); never invent an id —
     leave the array empty if none fits. Set `release` only to a real release id (or null).
   - **Title — names the INTENT/OUTCOME, never the mechanism.** Follow the `storyType`'s
     `titleGuide` (single source: `STORY_TYPE_DEFS` in `frameworks.ts`; mirrored in
     `storymap/frameworks.md` §0): the title names what the user GAINS, not what the dev does.
     For `storyType: user` NEVER start with a dev verb (Criar/Adicionar/Implementar/Refatorar/
     Redesenhar/Remover/Configurar/Ajustar/Simplificar/Mover). ✓ "Ver favoritos no perfil" /
     ✗ "Adicionar aba de favoritos". Even if the source text is phrased as tasks, retitle to the
     intent. Do NOT write narrative/acceptance/RICE here — that is `harness-enrich`/`harness-prioritize`,
     downstream.
   - **Voice:** PT-BR brand voice urbano-sofisticado. NEVER "rolê"/"rolês", "zap", or "o que rola"
     — use "evento", "WhatsApp", "o que tem".

4. **Write the proposal to the sidecar.** Persist `storymap/boards/<board>/proposals/<containerId>.json`
   as a `ProposalDoc` (TypeScript in `packages/storymap-ui/src/lib/storymap/smart-capture/types.ts`).
   Use sequential `tempId`s (`i1`, `i2`, …) unique within the batch; `parent`/`serves` may reference
   an existing card id OR another item's `tempId` OR null. Shape:

   ```json
   {
     "containerId": "<id>",
     "summary": "<1-2 frases PT-BR de como você interpretou o texto-fonte>",
     "items": [
       {
         "tempId": "i1",
         "type": "story",
         "title": "<rótulo curto no imperativo>",
         "storyType": "user",
         "parent": "<id de step/atividade existente | tempId de outro item | null>",
         "serves": null,
         "release": null,
         "personas": [],
         "systems": [],
         "rationale": "<1 linha: o que este card cobre / por que existe>",
         "duplicateOf": null
       }
     ],
     "feedback": [],
     "generatedBy": "harness-capture",
     "updated": "<YYYY-MM-DD de hoje>"
   }
   ```

   - `type` is `story` | `step` | `activity` (Patton model — almost always `story`; propose a
     `step`/`activity` only to introduce a new backbone area).
   - `storyType` is `user` | `technical` | `spike` | `bug` | `chore` (only on `type: story`; null/omit
     for step/activity).
   - **On a re-run, `feedback` MUST be the existing array from the sidecar, unchanged** (oldest-first).
     On a first run it is `[]`. NEVER drop past feedback.
   - `generatedBy` is always `"harness-capture"`; `updated` is today's date.
   - Regenerate `summary` + `items` IN FULL every run (first or refine) — the sidecar is replaced as a
     whole except for the preserved `feedback[]`.

5. **Do NOT advance — the container PARKS in `capturando`.** Write the sidecar FIRST. Then simply bump the
   container's `updated:` to today (`YYYY-MM-DD`) and STOP. `capturando` is itself the **MANUAL stop** (a
   hidden lane): the container rests there until a human reviews the proposal on Inbox and Accepts it
   (which mints the cards in Triagem and consumes the container) or Refines it (which re-fires this skill).

   - **Do NOT run `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts"`** (nor any move). Capture has no next pipeline step — advancing would
     push the container into Triagem, skipping the human review. This skill is human-in-the-loop, like
     `harness-grill`: it produces an artifact and PARKS (the runner expects no status change — `harness-capture` is
     declared `advancesOnSuccess: false`).
   - Keep one field per line; NEVER change the container's `id` and NEVER edit `status:` by hand (it stays
     `capturando`). Do NOT cascade.

6. **Report.** State that you captured the container, the number of items proposed (and the
   activities/steps/stories split), where the proposal was written
   (`proposals/<containerId>.json`), any `duplicateOf` flags, the `containerId` (unchanged — it is
   immutable), and that the container PARKS in `capturando` (manual stop, hidden lane) awaiting human
   acceptance on Inbox. In queue mode, summarize each container processed.

### Container id is immutable

The `containerId` is **permanent** — minted once at capture (`story-<hash>`) and frozen for the
container's whole life. Do NOT rewrite it to a title slug, do NOT create a `<slug>.md` + delete the
old file. Edit the container in place, keeping `id` untouched — the sidecar
`proposals/<containerId>.json` is keyed by it, and a rename orphans the proposal.

### Guardrail

This skill writes ONLY two data files: the proposal sidecar `proposals/<containerId>.json` and the
container `.md` (ONLY the `updated` date — `status:` stays `capturando`, never advanced). It
MUST NOT create real cards (`create_card`/new `cards/*.md`), MUST NOT advance the container (no
`advance-card`, no move — it PARKS in `capturando`), MUST NOT cascade, MUST NOT rename the `containerId`,
and MUST NOT touch `packages/storymap-ui/` or product code. On a re-run it MUST preserve the sidecar's
existing `feedback[]` (oldest-first) and regenerate
the proposal from ALL of it (not a diff). If you find yourself writing narrative/acceptance/RICE or
minting cards, you have left this skill's scope — enrichment is `harness-enrich`, and card creation is the
human's accept action on Inbox.
