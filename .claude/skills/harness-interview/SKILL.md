---
name: harness-interview
description: >-
  AgileHarness automation that runs LIGHTWEIGHT USER DISCOVERY on a refined user
  story. Reads a card in status `interview` from
  storymap/boards/<board>/cards/<id>.md, simulates 3 user interviews using the
  board's `personas` (prefer the card's own personas; pick relevant ones if it
  has fewer than 3) — ONE of the three wears a CRITICAL/skeptic lens (devil's
  advocate) — surfacing needs, objections, jobs-to-be-done and each persona's
  reaction to the proposed story, VALIDATES/ADJUSTS the already-written narrative +
  acceptance where the conversation contradicts the hypothesis, then SYNTHESIZES the
  findings (pains, desires, risks, must-haves, short quotes) into a `## Entrevistas
  (3 usuários)` section that feeds estimation (KANO/RICE) and UX/UI, and advances to
  `priorizar` (Estimar). Only `user` stories pass here (the board's
  `interview` step has `skipForTypes` for the non-user ones, so the cascade
  already skips them). With no id it processes the whole `interview` queue of
  every board. Use when the user says "/harness interview", "/harness-interview",
  "entrevistar usuários", "entrevista de usuário", "discovery da story", "ouvir
  as personas", or wants to advance AgileHarness cards sitting in Entrevista. Edits
  ONLY storymap data files — never the storymap-ui package, never product code.
triggers:
  - /harness interview
  - /harness-interview
  - entrevistar usuários
  - entrevista de usuário
  - entrevistas com personas
  - discovery da story
  - ouvir as personas
  - usm interview
---

# /harness-interview — AgileHarness: simulate user interviews (interview → priorizar)

The `harness-interview` trigger automation for the AgileHarness pipeline. It runs **light
discovery** on an ALREADY-SPECIFIED `user` story — AFTER `harness-enrich` wrote the
narrative + acceptance as a hypothesis — three simulated user interviews grounded in
the board's `personas` (one of them with a critical, devil's-advocate lens), to
STRESS-TEST that hypothesis: it validates/adjusts the acceptance where the
conversation contradicts it and synthesizes the findings so estimation (KANO/RICE)
and UX/UI consume real needs, objections and jobs-to-be-done. At the end it advances
the card board-aware (in `storymap` that is `interview → priorizar`; the helper, not
this skill, names the target).

> Read `storymap/README.md` first — it is the canonical schema/pipeline source,
> and `board.yaml` is the source of the `personas` you interview. This skill edits
> ONLY the data files under `storymap/boards/<board>/cards/`. NEVER touch
> `packages/storymap-ui/` (UI or data layer) and NEVER product code — this is
> discovery, there is no code to write.

## When to Use

- A card sits in status `interview` (right after `enriquecer`/Especificar, the
  `harness-interview` trigger column) — i.e. it ALREADY has the `narrative` + `acceptance`
  hypothesis (written by `harness-enrich`); the interview stress-tests and adjusts it.
- The user runs `/harness interview [<board>/<id>]` or `/harness-interview [<board>/<id>]`.
- The user asks to "entrevistar usuários", "ouvir as personas", or "fazer discovery"
  of an AgileHarness story before it goes to design/estimation.

## Input

```
/harness-interview <board>/<id>     # process one card (e.g. storymap/story-abc)
/harness-interview                  # no id = process the ENTIRE `interview` queue
```

- `<board>` = a folder under `storymap/boards/` (e.g. `demo`, `demo-legado`).
- `<id>` = the card id == the markdown filename without `.md`.
- With **no argument**, scan `storymap/boards/*/cards/*.md` and process every card
  whose `status` is `interview`, board-by-board, in file order.

If an explicit id is given but the card is NOT in `interview`, do not force it:
report the current status and stop (the trigger only owns the `interview` slot).

## This is USER-STORY discovery only

The `interview` step exists ONLY for `user` stories. In `board.yaml` the step carries
`skipForTypes: [technical, chore, spike, bug]`, so the cascade already routes those
non-user types straight past it — **this skill does not need to handle them** and
won't normally receive one. If, exceptionally, you are pointed at a non-`user` card
sitting in `interview`, do not invent interviews (there is no end user to discover):
note in the body that `storyType: <type>` has no user to interview and simply advance
the card with `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts" <board> <id>` (it forwards via the pipeline routing).
Only a `storyType: user` card runs the full workflow below.

## Workflow

1. **Locate the board + card.** Read `storymap/boards/<board>/board.yaml` to learn
   the valid `personas` (each with `role`, `description`, `jobs[]`, `pains[]`,
   `gains[]`) and confirm valid ids. Read the target card file: `title`, `storyType`,
   `narrative` (role/want/soThat) and `acceptance` (the HYPOTHESIS that `harness-enrich`
   wrote — what you validate), and the card's `personas`.

2. **Confirm the slot + type.** The card must be `status: interview` and
   `storyType: user` (queue mode: pick every `user` card with that status). The card
   id (`story-<hash>`, e.g. `story-a1b2c3`) is **permanent and immutable** — never
   rename it; edit the card in place at `storymap/boards/<board>/cards/<id>.md`.

3. **Cast 3 interviewees from the board personas.** Prefer the personas already on
   the card; if it lists fewer than 3, fill the rest with the most relevant board
   personas for THIS story (those whose `jobs`/`pains` the story touches). Use ONLY
   persona ids that exist in `board.yaml` — never invent a persona. Skip any
   system-only persona without `pains`/`gains` (e.g. `autorun`): you can't interview
   a system. Assign the three a deliberate spread of stances:
   - **2 representative users** — engaged with the job the story serves, but with
     different contexts/intensities of the pain.
   - **1 CRITICAL / skeptic lens (advogado do diabo)** — a real board persona voiced
     to PUSH BACK: questions whether the story solves the actual job, raises the
     strongest objection, names the cheaper workaround they'd keep using, and the
     condition under which they'd reject it. This lens is the point of the exercise.

4. **Run each interview grounded in the persona — NOT invented market data.** For
   each of the three, anchor strictly on that persona's `role`/`description`/`jobs`/
   `pains`/`gains` from `board.yaml` and on the card's `narrative` + `acceptance`.
   This is **light, qualitative discovery**: no surveys, no fabricated percentages,
   no external research, no made-up company names. For each interviewee capture:
   - the **job-to-be-done** they're really trying to get done (from `jobs[]`),
   - the **needs/pains** the story would touch (from `pains[]`),
   - their **reaction to the proposed story** (the narrative + acceptance) — would it
     help, and would they adopt it,
   - their **objections / risks** (sharpest from the critical lens),
   - what would make it a **must-have** vs nice-to-have for them,
   - one or two **short, in-voice quotes** (a sentence each) — brand voice
     urbano-sofisticado, sem gíria; never `rolê`/`zap`/"o que rola".

5. **Synthesize across the three.** Roll the individual interviews up into a small,
   decision-useful synthesis the next steps can consume:
   - **Dores** confirmed (and any the story missed),
   - **Desejos/ganhos** that anchor the value,
   - **Must-haves** vs nice-to-haves (this directly informs KANO in `harness-prioritize`
     and the UX priorities in `harness-ux`),
   - **Riscos/objeções** surfaced by the critical lens (with the condition that would
     make the story fail for that persona),
   - **Implicações para UX/UI** — concrete hints the design step should honor.
   Keep it honest: if the critical interview exposes that the story may not solve the
   job, SAY SO here — a discovery that flags risk is more valuable than a rubber stamp.

6. **Write the findings into the card body.** Append a `## Entrevistas (3 usuários)`
   section below the frontmatter (do not overwrite existing context). Suggested shape
   — three short interview blocks then the synthesis:

   ```markdown
   ## Entrevistas (3 usuários)

   ### 1. <Persona> — usuário representativo
   - **JTBD:** …
   - **Dores/necessidades:** …
   - **Reação à story:** …
   - **Objeções/risco:** …
   - **Must-have?** …
   - 💬 "<citação curta na voz da persona>"

   ### 2. <Persona> — usuário representativo
   …

   ### 3. <Persona> — lente crítica (advogado do diabo)
   - **JTBD:** …
   - **Maior objeção:** …
   - **Workaround que mantém:** …
   - **Condição para rejeitar:** …
   - 💬 "<citação cética curta>"

   ### Síntese
   - **Dores confirmadas:** …
   - **Desejos/ganhos:** …
   - **Must-haves × nice-to-have:** …
   - **Riscos/objeções:** …
   - **Implicações para UX/UI:** …
   ```

   ADJUST the `acceptance` hypothesis where the interviews contradict or extend it —
   add a missing must-have, drop a criterion the conversation invalidated, sharpen a
   vague one — and note WHY in the synthesis (this validation is the point of running
   the Entrevista after Especificar). Always leave ≥1 acceptance criterion + a complete
   narrative (the `hasRefinement` gate at Estimar needs them). Keep the
   board personas on the card coherent with whom you interviewed (you may set
   `personas` to the three you cast, using only valid board ids). Bump `updated` to
   today (`YYYY-MM-DD`); keep one field per line; never touch `tasks`/`rice`/`kano`/
   `funnelStage` (those belong to `harness-tasks`/`harness-prioritize`).

7. **Advance — board-aware, never hardcode the next status.** Write the
   `## Entrevistas (3 usuários)` section FIRST, directly into the card file. Do NOT
   set `status:` by hand. THEN advance the card by running:

   ```
   bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts" <board> <id>
   ```

   (the same `<board>` and `<id>` you received as the `<board>/<id>` argument). The
   helper moves the card to the NEXT step of THAT board's pipeline — on `storymap`
   that is `interview → priorizar` (Estimar), now that Especificar runs before the
   Entrevista — reusing the pipeline's `nextBuildStatus`
   + `checkGate`, so this skill never names a target status. If it exits non-zero, a
   gate one step ahead blocked the move — re-read the helper's message, fix the card,
   and re-run (never edit `status:` by hand).

8. **Report.** State the card moved `interview → <next step of the board>` (via
   `advance-card`), the `id` (unchanged — immutable), the three personas interviewed
   (flagging which carried the critical lens), and the 1-line synthesis (top pains,
   must-haves, the sharpest risk). In queue mode, summarize each card processed.

### Guardrails

- **Personas only, no invented data.** Every interview must trace to a real
  `board.yaml` persona's `role`/`jobs`/`pains`/`gains` and to the card's narrative +
  acceptance. No fabricated statistics, no external market claims — this is
  qualitative, persona-anchored discovery.
- **Exactly one critical lens.** Two representative + one devil's-advocate; the
  critical interview must produce a real objection, not a softened one.
- **User stories only.** Don't run interviews for non-`user` cards (the cascade skips
  them via `skipForTypes`); just forward them with `advance-card`.
- **No code, no UI package.** Edit only the card `.md`. Never write product code or
  `packages/storymap-ui/`.
- **Never rename the id** and never hardcode `status:` — advance ONLY via
  `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts" <board> <id>`.
