# /harness — AgileHarness automation router

Routes a StoryMap subcommand to its `harness-*` skill. The StoryMap pipeline lives in
`storymap/boards/<board>/cards/*.md`; each gated/triggered status is documented in
`storymap/README.md`. These automations edit ONLY the storymap data files (and, for
`do`, the product code being built) — never `packages/storymap-ui/`.

## Usage

```
/harness <subcommand> [<board>/<id>]
```

- `<board>` = a folder under `storymap/boards/` (e.g. `demo`, `demo-legado`).
- `<id>` = the card id == its markdown filename without `.md`.
- Omitting `<board>/<id>` runs the subcommand over the whole queue for that status.

| Subcommand | Skill | What it does | Status move |
|------------|-------|--------------|-------------|
| `setup` | `harness-setup` | Guided install and first run — measures the host, fixes what it can, asks only the real decisions, and **proves** the install | (no card) |
| `story "<texto livre>"` | `harness-story` | Author/edit cards from free text — **confirms the CRUD via AskUserQuestion** before writing | new cards at `triage` |
| `sync <app>` | `harness-sync` | Reconcile a board with the app's real code; propose new/updated stories — **confirms before writing** | per-card |
| `enrich    [<board>/<id>]` | `harness-enrich` | Write narrative + `acceptance[]` + context, set coherent personas/systems | `enriquecer` → `priorizar` |
| `tasks     [<board>/<id>]` | `harness-tasks`  | Decompose acceptance into technical `tasks[]` | `quebrar-tasks` → `desenvolver` |
| `prioritize [<board>/<id>]` | `harness-prioritize` | Classify: fill `rice` + `kano` + `funnelStage` (rubric in `frameworks.md`) | `priorizar` → `pronta` |
| `tests     [<board>/<id>]` | `harness-tests`  | Plan the unit/integration/e2e pyramid as test `tasks[]` + notes | (no move) |
| `grill     [<board>/<id>]` | `harness-grill` | Raise the open questions a card cannot be built without | `grill` → `enriquecer` |
| `interview [<board>/<id>]` | `harness-interview` | Turn answered questions into spec context | `interview` → `priorizar` |
| `capture   [<board>/<id>]` | `harness-capture` | Free text → a proposal of cards, reviewed in the Inbox | stops in `capturando` |
| `plan      [<board>/<id>]` | `harness-plan`  | Write the technical plan sidecar | `plano-tecnico` → `desenvolver` |
| `ux        [<board>/<id>]` | `harness-ux`    | Journey + wireframe options for the card | `design-ux` → `design-ui` |
| `ui        [<board>/<id>]` | `harness-ui`    | Turn the chosen wireframe into a UI spec | `design-ui` → `com-design` |
| `review    [<board>/<id>]` | `harness-review`| Adversarial code review; findings land on the card | `revisar-codigo` → `qa-automatizado` |
| `qa        [<board>/<id>]` | `harness-qa`    | Exercise the acceptance criteria against the running app | `qa-automatizado` → `revisao` |
| `fix       [<board>/<id>]` | `harness-fix`   | Reopen a shipped card that BROKE: reproduce, then respec | reopen |
| `refine    [<board>/<id>]` | `harness-refine`| Reopen a shipped card to IMPROVE it against live code | reopen |
| `retire    [<board>/<id>]` | `harness-retire`| Plan the safe removal of a discontinued feature | `retire` |
| `ship      [<board>/<id>]` | `harness-ship`  | Drive a card through the release step | `release` |
| `sync-card [<board>/<id>]` | `harness-sync-card` | Reconcile ONE card with the real code — autonomous, no questions | (no move) |
| `do        [<board>/<id>]` | `harness-do`     | Implement the tasks with TDD, mark `done`, verify | `desenvolver` → `revisar-codigo` |
| `run    [<board>/<id>]` | (orchestrates the above) | Drive the full trigger loop across boards | per-card, by pipeline |

> `harness-resolve` is deliberately absent: the merge train spawns it to judge a conflict, it belongs to
> no column, and there is nothing useful a human can pass it from here.

### Routing

- `/harness setup` → invoke the **`harness-setup`** skill (measure host → fix → prove).
- `/harness story "<texto>"` → invoke the **`harness-story`** skill (free-text → confirm → write).
- `/harness sync <app>` → invoke the **`harness-sync`** skill (scan app → confirm → write).
- `/harness enrich …` → invoke the **`harness-enrich`** skill.
- `/harness tasks  …` → invoke the **`harness-tasks`** skill.
- `/harness tests  …` → invoke the **`harness-tests`** skill.
- `/harness do     …` → invoke the **`harness-do`** skill.
- `/harness run    …` → run the loop below (no dedicated skill of its own).

When a `<board>/<id>` is passed, forward it verbatim to the skill. When it is
omitted, the skill processes its whole status queue.

## `/harness run` — drive the full trigger loop

Scan `storymap/boards/*/cards/*.md` and process every card sitting in a **trigger
status**, advancing it through the pipeline. Process in **pipeline order** so a
card can flow forward within one pass:

1. **`enriquecer`** cards → run **`harness-enrich`** (→ `priorizar`).
2. **`priorizar`** cards → run **`harness-prioritize`** (→ `pronta`).
   — `pronta` is a **PARADA go/no-go** (`autorun:false`): a human approves the build and moves the card to `design-ux`.
3. **`design-ux`** cards → run **`harness-ux`** (→ `com-design`).
   — `com-design` is a **PARADA** (`autorun:false`): a human reviews the design and moves the card to `plano-tecnico`.
4. **`plano-tecnico`** cards → run **`harness-plan`** (→ `quebrar-tasks`).
5. **`quebrar-tasks`** cards → run **`harness-tasks`** (→ `desenvolver`).
6. **`desenvolver`** cards → run **`harness-do`** (→ `revisar-codigo`).
7. **`revisar-codigo`** cards → run **`harness-review`** (→ `qa-automatizado`).
8. **`qa-automatizado`** cards → run **`harness-qa`** (→ `revisao`).
   — `revisao` is the final **PARADA**: human review of the delivered work.

Notes:
- The pass-through landing columns were removed; each gate now guards a **producer
  column's entry**: `hasRefinement`→`priorizar`, `hasPrioritization`→`pronta`,
  `hasWireframe`→`com-design`, `hasTechPlan`→`quebrar-tasks`, `hasTasks`→`desenvolver`,
  `hasNoBlockers`→`qa-automatizado`, `hasQaPassed`→`revisao`. The only human MOVES are
  out of the paradas: `pronta` → `design-ux` and `com-design` → `plano-tecnico`.
  `/harness run` processes only cards already sitting in a trigger status; it does not
  invent those human moves.
- `harness-prioritize` ESTIMATES RICE/KANO/funil (the human refines RICE later in the
  priorização view) — it does not require human input to run.
- Respect every gate — never flip a status whose gate isn't satisfied; the
  `validate-storymap-gate` hook (and the app's `checkGate`) will reject the write.
- If a `<board>/<id>` is given to `/harness run`, restrict the loop to that one card.
- Report a per-card summary of what moved and what's blocked.
