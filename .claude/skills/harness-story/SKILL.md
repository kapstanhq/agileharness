---
name: harness-story
description: >-
  AgileHarness story authoring from FREE TEXT with human-in-the-loop confirmation.
  The user types a free-text idea/feature/change; this skill analyzes it against
  the existing board, proposes the exact CRUD on AgileHarness cards (create / update /
  link / move activities, steps and stories under storymap/boards/<board>/cards/),
  CONFIRMS the plan with the user via AskUserQuestion (approve / adjust / cancel),
  and only then writes the .md files. Use when the user says "/harness story",
  "/harness-story", "criar story", "nova story", "criar card", "adicionar story",
  "anota essa ideia no storymap", "transforma isso em story", or describes a
  feature/idea they want captured as AgileHarness cards. Edits ONLY storymap data
  files — never the storymap-ui package. Always confirms before writing.
triggers:
  - /harness story
  - /harness-story
  - criar story
  - nova story
  - criar card
  - adicionar story
  - anotar no storymap
  - transformar em story
  - story no storymap
  - usm story
---

# /harness-story — author AgileHarness cards from free text (with confirmation)

Turn a free-text idea/feature/change into AgileHarness cards, but **never write blindly**:
analyze, propose the CRUD, **confirm with the user via AskUserQuestion**, then apply.

> Read `storymap/README.md` first — canonical schema/pipeline. This skill edits ONLY
> the data files under `storymap/boards/<board>/cards/` + `board.yaml`. NEVER touch
> `packages/storymap-ui/`. New cards start at `status: triage` (the staging intake, no
> gate) — they rest there, off the autorun cascade, until a human routes them to `enriquecer`.
> Never set a gated status (`priorizar`/`pronta`/`desenvolver`) without its field — that's
> for `harness-enrich`/priorização/`harness-tasks` and the `validate-storymap-gate` hook will block it.

## When to Use

- The user types free text describing something to capture: a feature, a fix, an idea,
  a user need ("como usuário quero…"), or a batch of them.
- The user runs `/harness story "<free text>"` or `/harness-story "<free text>"`.
- The user wants existing cards changed from a description ("move X para pronta",
  "linka A com B", "renomeia a story do login").

## Input

```
/harness-story <texto livre>            # default board inferred or asked
/harness-story demo: <texto livre>      # pin the board explicitly
```

Free text is the **input** — do NOT require the user to type the Agile format. You SHAPE
it into the structured story: pick the `storyType` and fill the `narrative`
(role/want/soThat). If the user already wrote a raw "Como/Quero/Para", map it straight
into `narrative`; if they wrote a one-liner, infer the three parts.

## Workflow

1. **Load context (read-only).** Determine the target board (from a `<board>:` prefix,
   the text, or ask). Read `storymap/boards/<board>/board.yaml` (valid ids for
   statuses/personas/systems/releases/linkTypes + which statuses gate) and ALL
   `cards/*.md` (titles, ids, hierarchy) so you can place cards under the right
   activity/step, reuse vocab, and detect likely duplicates.

2. **Analyze → draft a CRUD plan.** Map the free text to concrete operations:
   - **create**: one or more `story` cards (and, only if missing, the `activity`/`step`
     parents they need). Infer `parent`, `release`, `personas`, `systems` from the
     board vocab; pick the `storyType` (`user`|`technical`|`spike`|`bug`|`chore`) and
     draft the `narrative` in that type's template (rubric in `storymap/frameworks.md`
     §0); default `status: triage`; `order` = last sibling + 10. **Id (permanente e
     imutável):** uma **story** nasce com id aleatório `story-<hash>` (6 chars `a-z0-9`,
     ex.: `story-a1b2c3`) — gerado UMA vez e nunca renomeado (contrato travado no código;
     ver `[[storymap-card-id-immutability]]`). Backbone (`activity`/`step`) usa id slug do
     título (`act-<slug>`/`step-<slug>`). Garanta unicidade no charset `a-z0-9-`.
   - **update**: edit an existing card's title/body/personas/systems/release.
   - **link**: add a typed link (`depends-on`/`relates-to`/`blocks`).
   - **move**: change `parent`/`release`/`order` (respecting gates for `status`).
   - **delete**: only if the user clearly asked; warn about reference cleanup.
   Flag likely duplicates ("já existe `story-otp` parecida — atualizar ou criar nova?").

3. **CONFIRM via AskUserQuestion (mandatory, before any write).**
   - Present a concise summary of every proposed op (create/update/link/move/delete)
     with the target board, card type, title, parent and status.
   - Ask the user to **Aprovar / Ajustar / Cancelar** — make "Aprovar tudo
     (Recomendado)" the first option (see `[[feedback_ask_question_recommend]]`).
   - For genuine forks, ask dedicated questions with rich options: which **board**,
     **new story vs. update the duplicate**, which **parent step/activity** (or create
     one), which **release**. Use AskUserQuestion previews to show the card front-matter
     when helpful. "Other" is always available for free instructions.
   - If the user picks **Ajustar** or types other instructions, revise the plan and
     **re-confirm**. Loop until they approve. Never write before an explicit approval.

4. **Apply.** Write/modify the `.md` files exactly as approved:
   - New card frontmatter follows `storymap/README.md` (arrays default `[]`, `rice`
     four nulls, `created`/`updated` = today `YYYY-MM-DD`, one field per line). For a
     story, set `storyType` and the `narrative` (store only the core in role/want/
     soThat — the connector comes from the type). Backbone (activity/step) gets no
     `storyType`/`narrative`.
   - Reuse only ids that exist in `board.yaml`; never invent persona/system ids — if a
     new one is genuinely needed, confirm adding it to `board.yaml` first.
   - PT-BR brand voice (urbano-sofisticado; never `rolê`/`zap`/"o que rola") — see
     `[[feedback_brand_vocab_blacklist]]`.

5. **Report.** List each card created/updated with its `id` and file path, and suggest
   the next step (`/harness-enrich <board>/<id>` to refine, then tasks → RICE → build).

### Guardrails

- **Confirm before write — always.** This skill's whole point is the approval loop.
- Stay within the schema + gates; new work enters at `triage` (the staging intake).
- **`storyType: bug` → lane `corrigir`, NOT the build flow.** A bug is a fix ticket, not
  backbone. When you pick `storyType: bug`, write the card with `mode: fix`,
  `status: corrigir`, and a `bugReport` (`brief = title`, `severity: medium`,
  `openedAt = today`, the rest null/`[]` — `harness-fix` rewrites it on diagnosis). Do NOT
  land it in `triage`/`enriquecer`. Say so in the confirmation: "storyType bug → este
  card entra em Corrigir (mode:fix), não em Enriquecer/build". (Mirrors the
  `commitProposalAction` planning-path routing + `triage/parse.ts:acceptRoute`.)
- **`storyType: chore` is ambiguous** — it may be legit technical backlog. Leave it in
  `triage` (no special lane) so a human routes it; don't force it into `corrigir`.
- Only `storymap/` data files. Do not create PRDs or other docs.
