# How AgileHarness works

The [README](../README.md) says what it does and how to run it. This page is the long version:
why it was built, how much of the driving it takes from you, and the techniques behind the
board.

---

## Why this exists

This was built by one developer who was already shipping with Claude Code, and kept hitting
the same wall: **the work stopped when the laptop closed.**

Everything below started as something that was missing from that setup. It is written down here
because the list *is* the argument — more than any feature table.

> **"I wanted something that kept working with my laptop shut."** It runs as a service on a VPS
> and keeps going: the columns fire, the runs finish, the merges land. It runs locally too, on
> the same code path — but a laptop is where it *can* run, not what it was designed around.

> **"I wanted several terminals working on the same repository, merging by themselves."** Every
> session gets its own git worktree, and integration is serialized through a merge train that runs
> each affected test unit as a gate, sealed, and records how many tests it actually ran. A conflict doesn't wake anyone up: a headless run reads the
> divergence and judges it **hunk by hunk, cosmetic against substantive**, in a fresh worktree it
> physically cannot escape. What it can't settle comes back to the session that caused it — not to
> your lap.

> **"I wanted an agent that knows the whole application, not just the file I opened."** That's
> **Jido**, the board's own agent. It is Claude Code underneath, but it starts with the map, the
> personas, the canvas, the pipeline state, the risk matrix and your rules already loaded — and it
> can read the code, run the checks, spawn a working session and, if you let it, deploy. Same
> engine, different starting context.

> **"I wanted to steer development from my phone."** The board is an MCP server, so the Claude app
> is a front end for it. Talk an idea through by voice on the way somewhere, let it become a
> captured plan, pick what to work on, spawn a session on the VPS to do it — from the app, without
> a terminal. That isn't a companion app someone had to write; it's what having a real MCP surface
> gets you for free.

> **"I wanted the domain attached to the work, not living in someone's head."** Every card carries
> the personas it serves, the systems it touches, its place on the journey map, and the link to the
> pain it addresses. Above all of them sits the **PRD** — the board's highest document, with the
> positioning, the business metric and the outcome being chased now as sections of it — and every
> agent reads a digest of it before it writes anything.

> **"I wanted the boring guarantees to happen without me asking."** Acceptance criteria bound to
> the tests that prove them; a code review pass with a security lens; a QA step that has to record
> what it validated and against which commit. Not because someone remembered — because the next
> column refuses the card otherwise.

> **"I wanted the doubts raised at the start, not discovered at the end."** Before a story is
> specified, a step interrogates it: what's ambiguous, does this actually serve the personas we
> declared, what would make this the wrong thing to build. The questions land on the card with
> suggested answers, and the column waits.

> **"I wanted to see the screen before agreeing to it."** The design step proposes UI as a canvas
> of artifacts you react to one by one — approve this, change that — and the one you pick becomes
> the card's screen. Steering happens at the wireframe, which is where it's cheap.

> **"I wanted every task to respect the style guide I wrote."** The guide is a document on the
> board, and the build step is pointed at it. Not a convention someone might follow.

> **"I wanted to fix what I see, where I see it."** An overlay sits on the running interface: click
> an element or drag a region, say what's wrong, and it lands as a card, as a refinement on an
> existing card, or pasted straight into a live agent session. It works over your own app too.

### It is opinionated, and the dial is the point

This is not a neutral platform. It has a pipeline, it has gates, it has opinions about what a story
needs before it becomes code. If you want a place to park tasks, this will annoy you.

What it does not have an opinion about is **how much you drive**. The same board runs at either end:

| | you drive | it drives |
|---|---|---|
| **Terminals** | open sessions, work in your own worktrees, submit when ready — the train integrates | sessions are spawned for you, work claimed automatically |
| **The pipeline** | move each card by hand; run a column's skill when you want it | armed columns fire on entry and cascade to the next gate |
| **Jido** | `off` — it answers, and does nothing you didn't ask | `autonomous` — it picks up work, resolves what it can, escalates what it can't |
| **Shipping** | you press Publish | the board's release policy pulls it through to production |

Between those, a risk matrix decides *per class of action* whether Jido acts, asks, or never does —
and a few classes can never be automatic, whatever the config says. You can start fully manual and
move the dial one notch at a time, per board.

### The thing that actually changed the work

Both altitudes, in one place. The map tells you what the product is and where this story sits in
someone's journey; the same card carries the diff that implemented it, the findings the review
raised and the commit QA validated. **You get the high-level view and the low-level view of the
same object**, and moving between them is scrolling, not context-switching between four tools that
disagree.

The four properties that make that possible:

**1 · The board is data in your repository.** Cards are markdown with frontmatter under
`storymap/boards/<board>/`. Not a hosted database, not SQLite in an app directory. The
`git log` of your product and the `git log` of your code become the same log — a card
change shows up in a diff, gets reviewed in a PR, and reverts like anything else. When an
agent reads your board, it reads files it already has checked out.

**2 · Columns are executable.** A column can declare a `trigger` — a skill that runs
headless when a card enters. Fourteen skills come wired to columns: capture, grill, interview,
enrich, prioritize, UX, UI, plan, develop, review, QA, refine, fix and retire. A card dropped in
an armed column is enriched, broken into tasks, prioritized, designed, planned, built,
reviewed and published without a human touching it — stopping at the first gate it fails,
with the reason written on the card.

**3 · Gates make autonomy safe to leave running.** The interesting failure mode of an
autonomous agent isn't that it does nothing. It's that it declares victory. A gate is the
answer: the card cannot enter *Delivery* without build evidence, cannot enter *Live*
without deploy proof, and no amount of confident prose from an agent substitutes for the
field. This is why the pipeline is worth more than the parallelism.

**4 · The spec outlives the delivery.** Shipping is not the end of the card. A live story
can be reopened for refinement, for a bug, or for **retirement** — and each reentry lands
in a column with its own skill and its own gate. The spec that described the feature is the
same file that records why it was changed and, eventually, how it was removed. Most
spec-driven tooling stops at "the code was generated"; here that is the middle of the file.

## The techniques

### The PRD is the highest document, and three of its sections are written for the agent

Every board has one, at `storymap/boards/<board>/docs/prd.md`. Sixteen sections, six of them
required, and it is where positioning, the business metric and the outcome being chased now live
— not as three loose strings in a config file, but as sections of the document that explains them.

A PRD written for people can stop at *what we're building and why*. A PRD that feeds agents has to
carry three more things, and they are the ones that change the output:

| section | what happens without it |
|---|---|
| **Decisions already made** | an agent that doesn't know a decision was taken takes its own — plausibly, and in the wrong direction. This is the section that stops the fourth reinvention of something settled in week one. |
| **Journeys** | the capture has nothing to build a backbone from, so free text becomes a flat list of cards with no map underneath. |
| **Done when** | "it works" is not a verification criterion. The gates measure the card; this measures the product. |

**What reaches a prompt is a digest, not the document.** Five sections — summary, positioning,
target outcome, business metric, scope — capped per section. The whole PRD in every prompt would
drown the actual question, and an agent that needs the rest calls `read_doc`. The prioritization
step argues against that digest instead of inventing reach numbers; the capture step uses it to
know what the product is before it proposes a backbone; the build step inherits it through the
card.

**Everything else descends from it, in one declared direction.** The Lean Canvas is its one-page
compression, the story backbone comes out of its journeys, the personas out of its audience.
*Generate map* on the PRD seeds the capture with journeys, scope and solution — not with all
sixteen sections, because *Business model* and *Glossary* describe the product rather than the
work, and a capture fed with them mints cards for both.

**The file is human-owned.** A `Write` or `Edit` against `docs/prd.md` is refused by the ownership
guard, and the refusal names `propose_change` — which opens a draft, with a diff, for someone to
approve. The chat *on the screen* writes the document immediately, because there a human is already
in the loop reading every word. Same document, two doors, and the asymmetry is the point.

### The card is the spec, and it is one file

Not a folder of generated documents. One markdown file, with the frontmatter a machine reads
and the prose a human writes. This is a card from the demo board, **translated here for
readability** — the board itself ships in Portuguese, as does the interface
([Project status](../README.md#project-status)):

```yaml
---
id: story-audio-sample
type: story                     # activity → step → story: the map's three levels
title: Hear a sample of the audiobook
storyType: user                 # user | technical | bug | chore | spike
status: stage                   # where it is in the pipeline, right now
parent: step-sample             # its place on the map — a story with no place is refused
release: r2
personas: [collector]           # from the board's declared vocabulary, not free text
systems: [accounts]
links: []                       # typed edges to other cards (below)
narrative:
  role: collector of special editions
  want: to hear a sample of the audiobook
  soThat: I can try the text before buying it
acceptance:                     # the business rules, in Given/When/Then
  - Given I am in the store, when I play a sample, then the store confirms it on the page.
  - Given the operation fails, when I play a sample, then I see why and what to do next.
tasks: []
---
```

### The same file carries the whole lifecycle

As the card crosses the pipeline, each step **stamps its own evidence onto the card**. Nothing
is a checkbox someone ticks:

| stamp | written by | what it proves |
|---|---|---|
| `questions[]` | the interview skill | what the agent didn't know, and what a human answered |
| `rice` · `kano` · `funnelStage` · `priorityCall` | prioritization | how much it's worth, and the call that was made |
| `wireframeChosen` | design | which artifact of the canvas is the screen |
| `techPlanReady` | planning | the technical plan sidecar exists |
| `tasks[]` | decomposition | the work, item by item |
| `criteriaSpecs[]` | test authoring | each acceptance criterion → the spec that proves it |
| `buildEvidence` | the engine | the delta actually landed, proven by content |
| `findings[]` | code review | what's wrong, by lens and severity, with a status each |
| `qaPassed` · `qaRanAt` · `qaCommit` · `qaEvidence` | QA | including whether a human *looked at the screen* |
| `commitRange` | review/QA | `{base, head}` — so the validated delta stays reconstructable after `main` moves |
| `stagedAt` · `releasedAt` | the train | when it was integrated, when it went out |
| `retirement` | retirement | why it was removed, and how far the removal went |

`git log` on that one file is the complete history of the feature: the question someone asked in
week one, the criterion that was added, the finding that blocked it, the commit that proved it.

### Acceptance criteria are bound to the tests that prove them

An acceptance criterion nobody can point a test at is a wish. `criteriaSpecs[]` maps each
criterion, **verbatim**, to the repo-relative path of the spec that covers it:

```yaml
criteriaSpecs:
  - criterion: "Given the operation fails, when I play a sample, then I see why…"
    specPath: packages/store/tests/audio-sample.test.ts
```

An entry with no `specPath` isn't a warning — the `hasCriteriaSpecs` gate **routes the card back**
rather than letting QA improvise a test after the fact. Writing the test is part of specifying,
not part of checking.

### Cards form a typed graph, not a tree

The parent link places a story on the map. Nine **typed edges** carry everything the map can't:

| edge | reads as |
|---|---|
| `addresses` | this story addresses that **idea** — a pain in the opportunity space |
| `serves` | this technical/bug/chore work **serves** that map node — infrastructure never floats free of the user value it enables |
| `depends-on` · `blocks` | ordering, in both directions |
| `duplicates` · `relates-to` · `references` | the rest |

Every edge is validated on write: unknown relation, missing target, or an endpoint the relation
doesn't allow is **refused**, and nothing is saved. A dangling link is a lie the graph would
repeat forever.

### Questions: the agent asks, the human decides, the next skill reads

The interesting part of an autonomous pipeline is what it does when it *doesn't know*. It does not
guess, and it does not stop dead. It writes the question onto the card:

```yaml
questions:
  - id: q1
    text: Is the audiobook sample free for everyone, or only for people who bought the e-book?
    askedBy: harness-grill
    status: open
    options:                    # the agent proposes; it never picks
      - Free for everyone
      - Only for buyers
```

Three things follow from that shape. **The column that raises questions does not auto-advance** —
it is the one deliberately manual step in the cascade, so nothing downstream gets built on a guess;
the card waits there until a human moves it on. The answer then becomes **context for the next
skill**, which reads it instead of re-deriving the same thing. And the questions collect in one
queue across all cards, so a human answers a batch of decisions rather than babysitting a run. The
board's own agent can answer the ones that are *facts* — something it can look up in the code or
the data — and hands you the ones that are *product*, which are the only ones that needed you.

<sub>To be precise about the mechanism, because it's the kind of thing that's easy to overstate: no
gate inspects <code>questions</code>. What holds the card is the column's own <code>autorun: false</code>,
which is a weaker and more honest guarantee — an operator who moves the card on with questions open
is allowed to.</sub>

### Wireframes: the LLM authors a tree, the CODE draws the picture

Ask a language model for an ASCII wireframe and you get columns that don't line up, because it is
guessing character widths. So it doesn't draw. It authors a bounded tree of primitives —
`screen`, `stack`, `row`, `card`, `list`, `appbar`, `text`, `button`, `input`, `image`, `chip`… —
and a **pure function counts code points** to render it:

```json
{ "type": "screen", "props": { "viewport": "mobile" }, "children": [
  { "type": "appbar", "props": { "title": "Order #4821", "leading": "back" } },
  { "type": "card", "props": { "pad": 2 }, "children": [
    { "type": "text", "props": { "value": "Out for delivery", "variant": "h2" } },
    { "type": "text", "props": { "value": "Arrives today, 6-8pm", "variant": "body", "muted": true } } ] },
  { "type": "list", "props": {}, "children": [
    { "type": "row", "props": {}, "children": [ { "type": "text", "props": { "value": "Shipped - Mon" } } ] },
    { "type": "row", "props": {}, "children": [ { "type": "text", "props": { "value": "In transit - Tue" } } ] } ] },
  { "type": "button", "props": { "label": "Track on map", "variant": "primary", "full": true } } ] }
```

```
┌─ MOBILE ─────────────────────────────┐
│ [<]  Order #4821                     │
│ ┌─ card ───────────────────────────┐ │
│ │ ## Out for delivery              │ │
│ │ Arrives today, 6-8pm             │ │
│ └──────────────────────────────────┘ │
│ ┌─ list ───────────────────────────┐ │
│ │ ┌─ row ────────────────────────┐ │ │
│ │ │ Shipped - Mon                │ │ │
│ │ └──────────────────────────────┘ │ │
│ │ ┌─ row ────────────────────────┐ │ │
│ │ │ In transit - Tue             │ │ │
│ │ └──────────────────────────────┘ │ │
│ └──────────────────────────────────┘ │
│ [ Track on map ]                     │
└──────────────────────────────────────┘
```

That output is real — generated by the renderer that ships in this repository, from the tree
above it. The same tree renders as a rich React screen in the interface and as this outline in
the terminal, in the markdown projection, and in any agent reading the sidecar. It is the
project's general principle applied to design: **the model does the reasoning, the code does the
plumbing.** Adding a primitive is one entry in the spec registry, one renderer case and one
text case — a contract test keeps the three in lockstep.

### The handoff is a sidecar, not a re-investigation

Heavy content lives beside the card: `plans/<id>.md` (files to touch, contracts, task order),
`wireframes/<id>.json` (the journey and the design canvas). The next skill is told to **read the
sidecar and trust it** rather than re-scanning the codebase. Re-discovery is the largest
uncached cost of an agent run, and the step before already paid it.

### The merge gate says what it ran — and runs it sealed

Every code entry on the merge train is integrated into a throwaway tree and tested there before it
lands. The gate's scope is **declared per unit**, and a unit says how it is measured:

```yaml
# storymap/settings.yaml — a monorepo target
autorun:
  mergeGate:
    enabled: true
    affected: { enabled: true, fullSuitePaths: ["bun.lock", "vitest.shared.ts"] }
    scope:
      maxUnits: 5                                             # more than this collapses into the fallback
      packages:
        apps/portal: bunx vitest run                          # a string = a vitest unit
        libs/pricing:
          cwd: libs/pricing                                   # runs from inside the package
          command: bunx vitest run --config vitest.node.config.ts
          triggers: ["libs/shared-types/**"]                  # also runs when the shared types change
        services/ledger:
          command: go test ./...
          reporter: exit-code                                 # status only: no test count
          network: allow
      units:
        tests/contract:                                       # a prefix outside the packages
          command: bunx vitest run --config tests/contract/vitest.config.ts --reporter=junit --outputFile=.gate/contract.xml
          reporter: junit-xml
          junitPath: .gate/contract.xml                       # relative to the unit
          cwd: .
          triggers: ["libs/*/schema/**", "services/*/proto/**"]
      fallback: { cwd: libs/core, command: bunx vitest run }  # what covers a file no unit owns
    isolation: systemd                                        # the default
```

- **Reporters.** `vitest-json` (the default — the gate appends `--reporter=json`), `junit-xml`
  (the gate reads the file at `junitPath`, deleting it before every run so a stale report can
  never be read as this one's) and `exit-code` (status only). Only **new** failures reprove an
  entry: when the merged tree is red, the red units are re-run on the base, and whatever was
  already failing there is not blamed on the entry. A new failure gets one full re-run before it
  counts (flaky tests don't freeze the train). An `exit-code` unit can't name its failures, so a
  red base makes its verdict **inconclusive** — never a pass.
- **Affected-only selection is per unit.** With `affected.enabled`, a `vitest-json` unit runs
  `<its own command> --changed <base> --passWithNoTests`; every other reporter always runs in
  full. (An earlier version replaced every unit's command with one global template, so a non-vitest
  unit ran vitest and a `--config` disappeared.)
- **The count is the proof.** For each unit the gate records the **exact argv** it executed, the
  reporter, the mode (affected or full) and **how many tests ran**. That report is stored on the
  train entry (`gateReport`), returned by `wait_for_submit`, shown in `/processes` and printed in
  the gate log. "Green" with zero tests is visible as zero.
- **The seal.** The suite under test is agent-written code. With `isolation: systemd`, each gate
  command (the suite, the typecheck, snapshot regeneration) runs in a transient systemd unit
  (`systemd-run --wait --pipe --collect`): root **without capabilities**, the filesystem
  read-only except for the gate's tree, `/run` and `/tmp` private, known credential locations
  (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.claude`, the checkout's `.env*`, the runner's
  own state, and whatever `mergeGate.sealed.inaccessiblePaths` adds) inaccessible, and no
  network for units declared `network: deny` (the default). Each of those properties is there
  because a probe on a real host broke without it. For example, root with capabilities simply
  unmounted the hidden credential, and the systemd socket under `/run` let the unit start an
  unsealed one. What the seal does **not** do is isolate process IDs (`PrivatePIDs` is not
  available on systemd 255). The unit can see the host's process list and signal processes
  running as the same user, although their environments stay unreadable.
- **No systemd, no silence.** The seal is used only when a probe proves it on the host. On a
  host without systemd, or with a non-root service, the gate falls back to the old behaviour
  (sanitized environment, no seal). It says so in every gate log and in the preflight report
  (`gate.isolation`). `isolation: none` (or `AGILEHARNESS_AUTORUN_GATE_ISOLATION=none`) records
  that you accept the risk. Under the seal the checkout's `node_modules` is read-only, so every
  vitest the gate runs gets `--configLoader runner --no-cache`: the config loads in memory and
  nothing is written under `node_modules`.
- **What lands on `main` is gated too.** With staging on, the split sends everything outside
  `staging.codePrefixes` straight to `main`, and that is not only cards: deploy scripts,
  operational scripts, the `justfile`. `mergeGate.dataUnits` (same unit shape as `scope.packages`)
  names the prefixes whose own suites must pass first. When an entry's data half touches one, its
  units run, sealed and counted like the code units, in a throwaway tree built from the current
  `main` plus that data half. The half lands only if they pass, and nothing from the split lands
  before the verdict. A prefix you don't declare lands as before.

  ```yaml
      dataUnits:
        docs/site: { command: bunx vitest run, cwd: docs/site }
        ci/pipelines: { command: sh ci/selftest.sh, reporter: exit-code, cwd: . }
  ```

A related rule sits on the board side. A card that carries code (it has been staged, or a review
recorded its commit range) can only enter the human review column with a QA stamp that says
**what was proven**: `qaEvidence.suite` or `qaEvidence.visual`. The "no screen, no QA" exemption
still applies to board-only cards, and no longer to code.

### The target declares what is its own — the tool never assumes it

AgileHarness manages a repository it did not write, so it cannot assume that repository's
toolchain: which command runs the tests, where the rules live, what currency the cost ceilings are
in, which review lenses exist, how packages are laid out, which ports the QA stack uses, how a
publish is launched, how many tokens the subscription allows. The operator declares each of those
in `storymap/settings.yaml` — the channel that is versioned and goes through the code gate, unlike
`board.yaml`, which agents edit and which therefore never carries a command.

```yaml
# storymap/settings.yaml — an invented bicycle workshop
target:
  checks: { testUnit: "make test-unit PKG={pkg}", validate: "make validate" }   # {pkg} {package} {board}
  docs: { conventions: "{package}/CONTRIBUTING.md" }
  currency: { code: EUR, locale: pt-PT }
  reviewLenses:
    brakes: { name: "Brakes", description: "pad wear, cable slack", agent: brake-reviewer }
  layout: { workspaces: ["shops/*", "shops/*/web"], packages: ["shops/*"] }
  qa:
    ports: [7101, 7102]
    health: [{ name: broker, url: "http://127.0.0.1:7101/" }]
    failureClasses: [{ pattern: "fakebus[\\s\\S]{0,60}stalled", class: infra }]
vps: { weeklyTokenLimit: 400000000, headroomUrl: "http://127.0.0.1:9100" }
deploy:
  launchers: [taskrun]
  recipes: [ship-app]
  legacy: { command: [taskrun, ship-app, "{target}"], state: "ops/state/{target}.json" }
  proof: { record: { securityReview: [recorder, verdict, "{file}"] } }
```

- **Undeclared means undeclared.** Every resolver returns an explicit "nothing" (`undefined`, `{}`,
  an empty list) — never a default from the repository the tool was written in. A skill told to
  run a check the target did not declare is told to *discover the command in the repository's own
  instructions*; a tool that needs a value (a currency to judge a cost, a command to publish)
  refuses and names the exact key to declare. The only built-in vocabularies are the tool's own:
  the five core review lenses (`security`, `testing`, `perf`, `general`, `design`) and the `stage`
  branch name.
- **Commands are argv, never shell.** A declared command is a list of words (or a string the loader
  can split into words without a shell); a pipe, `&&` or `$(…)` is refused, and the only
  placeholders are the closed set for that key (`{pkg}`, `{package}`, `{board}` in `target`;
  `{target}` and `{file}` in `deploy`). Commands in `board.yaml` still pass the launcher/recipe
  allow-list; commands in `settings.yaml` are the operator's own and do not.
- **Tolerant, and loud.** Free text from this file ends up in prompts, argv and file names, so only
  values with a *shape* get in (slugs, relative paths without `..`, loopback URLs with a port, ISO
  currency codes the runtime knows, regexes with no nested quantifier), with a length cap and no
  control characters. A piece with no shape is **discarded on its own** — the rest of the block
  keeps working — and the service log gets one line naming the path that was dropped (never the
  hostile value). An unreadable YAML file still falls back to the built-in defaults as a whole, but
  it now says so in the log, once per version of the file.
- **Hot unless it is staging.** All of the above is re-read when the file's mtime changes.
  `autorun.staging.*` is read once when the merge train is built, so changing it needs a safe
  restart. `autorun.staging` also records which keys the file actually declared, so "no
  `codePrefixes`" and "`codePrefixes: []` (nothing is code)" are different answers.
- **The environment still wins.** `AGILEHARNESS_WEEKLY_TOKEN_LIMIT`, `AGILEHARNESS_HEADROOM_URL` and
  the `AGILEHARNESS_DEPLOY_*` lists override or extend the file (the deploy lists are a union: the
  environment never removes what the file declared). `vps.headroomUrl` only says where the meter is
  *read* from; routing agent traffic through the proxy is a separate switch.
- **Skills name checks, never commands.** The shipped skills do not say "run `just test-x`": they tell the
  agent which check to run by name (`test`, `testUnit`, `e2e`, `typecheck`, `lint`, `validate`) and to run the
  declared command itself, in its own worktree (`run_check` runs in the runtime checkout, so it is for the
  operator, not for a run). **Where the agent reads it depends on the session.** A column run
  (`harness-do`, `-qa`, `-tests`, `-review`) is headless and starts with *no* AgileHarness MCP mounted, so it
  reads the `target` block of `storymap/settings.yaml` straight from its worktree — the run's context note
  names the declared checks, and for the review lenses the skill points at `target.reviewLenses`. A conductor
  session has the MCP, where `target_profile({board})` returns the same profile already resolved. The review
  lenses, the dev command and the convention documents come from that one profile. Only the conventions
  document is "read before acting"; the rest are paths to open when the work calls for them, so a target that
  declares five documents does not pay for five in every run. A target that declared nothing gets the same
  instruction every time: *discover the command in the repository's own instructions*.
- **The owner's classes drive the proxy's prompt.** What counts as the owner's decision (money, speaking for
  the brand, the PRD, people's data) is `autonomy.ownerClasses`. The question classifier, the triage judge
  and the owner's proxy all read that one list; the proxy's "these are never yours" sentence is built from
  each class's label and description, not written into the code. With no declaration the tool's neutral four
  apply, and the money class keeps one generic clause: switching the model or vendor of the AI that serves
  the product's users changes cost and quality, so it is the owner's call.
- **Hooks find the tool's libraries by an ordered list.** The pre-write guards need the tool's
  `gate-core` and `ownership` modules, and a target repository does not carry the tool's source. They
  look, in order, for a copy vendored beside the hook (`.claude/hooks/lib/`), then the tool's own
  checkout (`AGILEHARNESS_TOOL_ROOT`, which the engine sets for every run), then the legacy path of
  the tool's tree. If none loads the hook still allows the write (the app's own gate stays the authority),
  and writes one `[HARNESS WARNING]` line to stderr. **Do not read that as an alarm:** it exits 0, and Claude Code
  does not show the stderr of an exit-0 hook to the model or to the operator outside verbose / transcript mode,
  so the line is a breadcrumb and the guard is, in practice, off. The ownership guard is the one that fails
  open for real (a run could edit the human-owned fields); checking that the libraries are reachable is a job
  for the service preflight, not for the hook.

### A deploy can't roll production back

The service publishes from its own checkout of your repository. If you also deploy by hand from
another machine, that checkout can fall behind what is live, and an autonomous deploy from it would
quietly ship older code. So before **every** product deploy the engine launches — a declared
`command`, a deploy agent, the legacy per-package route, the chained face, the publish queue, the MCP
`deploy` tool — a freshness preflight runs in that checkout, and it **refuses** when:

- `git fetch` of the current branch's upstream fails, or the branch has no upstream;
- `HEAD` is behind its upstream;
- a tracked file inside the deploy's scope (the board's `package`, `sharedPackages` and
  `deploy.surfaces` — the same scope the promotion uses) has uncommitted changes. Dirt outside
  the scope, like local tool settings, is ignored;
- the board declares `deploy.liveShaCommand` and `HEAD` does not descend from every commit sha it
  prints (one per line). A failing command or output that isn't a sha also refuses. Without the
  field, this check is skipped, and a log line says so.

A refusal runs nothing: the card goes back to *Release* with a finding that says what to do (pull,
commit), through the same path as any failed deploy, so there is no automatic retry loop. The
authorization the preflight issues is an object that only it can create. It is bound to one target
and usable once, and the deploy registry won't launch without one. That makes skipping the preflight
impossible rather than merely discouraged. `liveShaCommand` goes through the same allow-list as the
other declared commands. The escape hatch is for humans only: `AGILEHARNESS_DEPLOY_FRESHNESS=off` in
the service's environment. It is read on every deploy and logs a warning each time it's used.

### A board has a pace, and — separately — a scope

Two independent brakes sit in front of everything the board starts by itself, and the owner can
reach both from the board header (an agent reaches them through `pause_board`, see
[AGENTS.md](../AGENTS.md)).

- **The pace** says *how much* the board moves: `normal`, `slow` (one card at a time, no
  background agents) or `paused` (nothing automatic starts).
- **The scope** says *what kind of work* it may begin. The first version has two settings:
  *everything*, and **only fixes and maintenance** — every story type except the one real new
  feature, `user`. Bugs, technical work, chores and spikes keep going; a new feature waits. The
  file stores the list of admitted types, so a finer choice later needs no migration, but the
  screen offers only those two presets today.

The axes do not combine into a fourth speed. `paused` wins over any scope; `slow` plus a scope is
one card at a time *inside* the scope; `normal` plus a scope is full speed, with nothing outside it
starting.

**What the scope stops is the *start* of construction, and nothing else.** It stops a conductor from
being dispatched or adopted, the conductor queue, and the columns from technical plan through
development (`plano-tecnico`, `quebrar-tasks`, `desenvolver`; the list is named and tested against
the base board). Capture, triage, questions, the interview, specification and prioritisation keep
running on purpose: a bug captured an hour ago is born with the default type, and it can only be
recognised as a bug if those columns still run. On a board with a conductor the exception is the
conductor's own entry points: the interview and the refine door of a *new feature* wait together
with the conductor (there is no column skill to run there), while `enriquecer` keeps running to
decide the type.

**What already started finishes.** Code review and automated QA are *not* gated, even though the base
board files them under "Construction": a card only reaches them after development wrote the code, and
stopping there would leave the feature parked with code written and no review or QA. The scope bars
the start; reviewing and proving what exists is finishing, and it carries on to delivery.

Publishing is not gated either — the publish queue, the merge train, and every operator action
finish and ship work that is already built. The gate is by *who started it*, not by which tool: the
owner's session and the operator's "run now" are never held, but an agent that calls `run_skill`,
`enqueue` or `enqueue_batch` is automation and is held like the cascade is (the per-card
`harness-sync-card`, which only diagnoses, is the one exception). A feature already in review or on
the stage leaves with the next publication; the pace panel counts how many will go along. The
copilot follows the same line: it neither queues nor moves a card of an excluded type *while that
card still waits to be built*, but a feature that is already in delivery stays actionable, so a
merge block, a failed deploy or a pending proof on built work is still handled.

**Narrowing lets what is running finish.** Work already executing is not interrupted and live
conductors are not parked; only the engine and conductor queues are cleared of the types that no
longer fit, and each removed card is noted so it can come back on its own. **Widening** re-scans
the non-terminal cards and sends each one through the same column-entry path a move would use
(idempotent), so what was waiting restarts without anyone moving a card. This is separate from a
pause's own "held" notes, and the two never clear each other.

**Two layers, like the pace.** An agent can only *narrow* — including through `pause_board`, which is
never held for approval — and can only undo the scope an agent set. Only the owner widens, and
writing the owner's scope erases the agent's. The effective scope is the **intersection** of the
types each live layer admits. Each layer can carry a deadline (one hour, until tomorrow morning, or
none) that the existing sweep expires.

**The type is the ratchet.** While any restrictive scope is active, every change of a card's story
type is written to the audit trail with before, after and author, and an agent cannot move a card
already classified as `user` to another type — the owner does that. Classifying a card that is
still new (before specification) stays open to agents, which is what lets a freshly captured bug
become a bug. "Report a bug" re-types a story as `bug` too, so it goes through the same ratchet: an
agent cannot use it on a feature that is not delivered yet (a delivered feature that broke is a
legitimate fix, and so is the owner's report). `mode` and `type` are not otherwise writable by
`update_card` (`mode` is rejected as a pipeline field and `type` is not in its schema).

*Known limits of the ratchet.* A card an agent *creates* already carrying another type is not stopped
(classifying something new is free by design; the creation is in the agent-action trail), and a
session that edits the card's `.md` inside its own worktree reaches `main` through the merge train,
not through these functions.

Support agents follow the same rule. With a scope active, the technical auditor and the copilot
still run when the pace is `normal`, but the copilot neither queues nor moves a card of an excluded
type, while the triage judge keeps accepting new features into the backlog, where they wait ready
and cost nothing. The stalled-card watch treats an out-of-scope card as stalled on purpose, the
same way it treats a deferred one, and opens no repair card for it (except in the classification
columns, where the specification skill runs and the watch stays on).

**The state file fails closed.** The scope lives in the pace state, not in the board or the cards (it
is operation, not data). The pace file stays at `version: 1` while no scope exists and becomes
`version: 2` only when at least one does. An older binary that reads version 2 sees the file as
unreadable and holds *everything*, which is the safe direction; the new reader accepts both. The
scope *history* is the one scope field allowed in version 1 (an older binary ignores a field it does
not know), so lifting the last limit — or its deadline expiring — keeps the record of who widened
and when; the layers themselves and the held notes stay version-2 only.


## Built on Claude Code

Most tools in this space list the agents they support. This one supports exactly one, and it is
better to say so on the front page than to have you find out after a four-minute build.

**The engine spawns `claude` for every step that works.** Not a library, not an API client — the
CLI, as a child process, once per run. The binary's *path* is configurable
(`AGILEHARNESS_AUTORUN_CLAUDE_BIN`); its *protocol* is not. There is no provider interface to implement,
because there is no second provider.

### What the coupling actually is

| what | how it's used |
|---|---|
| **The skills** | Twenty-three skills ship as `.claude/skills/<name>/SKILL.md` — Claude Code's own skill format, its own frontmatter, its own Task-tool delegation to subagents |
| **Model and effort per column** | a column declares `model` and `effort`; the engine passes `--model` and `--effort`, and a card's route can cap both |
| **The turn ceiling** | `--max-turns` per column, and a stop at the ceiling is a *distinct outcome* the pipeline handles — it resumes with `--session-id` / `--resume` rather than starting over |
| **The board's own MCP** | `--mcp-config` mounts the capability graph a step declares, and `--strict-mcp-config` stops the spawn from inheriting the host's servers |
| **The step's instructions** | `--append-system-prompt-file` carries the per-board invariants into the run |
| **Cost and identity** | `--output-format json` is where the ledger comes from: `total_cost_usd`, the session id, the result and its subtype. The per-card cost you see in the interface is Claude Code's own accounting, not an estimate |
| **The containment** | this is the subtle one — see below |

### The containment is Claude Code's, not a wrapper around it

A full-autonomy run needs a non-interactive shell. The obvious way to get one is
`--dangerously-skip-permissions`, which buys the shell by removing every other brake at the same
time. Instead, the engine writes a `--settings` file that turns on Claude Code's **own sandbox**
with `autoAllowBashIfSandboxed` — which grants exactly the non-interactive Bash that flag was
wanted for, and nothing else. The OS-level jail (bubblewrap, Seatbelt) is what that sandbox runs
on, which is why `bubblewrap` is a prerequisite and not a suggestion: without it the posture
**downgrades**, the run loses its shell, and the column that writes code stops working.

So the permission model isn't ours with Claude Code underneath. It *is* Claude Code's permission
model, driven from a settings file the engine composes per run.

### What works without it

Quite a lot, and this is worth knowing before you decide:

- **the board** — reading, writing, moving cards, the map, the canvas, the whole interface;
- **git and the merge train** — worktrees, the suite gate, the code/data split, the publish queue;
- **the gates** — they are pure functions over card data and never call an agent;
- **the MCP server** — 107 tools over HTTP, which *any* MCP client can drive. Your agent doesn't
  have to be Claude Code to read and write this board; it has to be Claude Code to be *spawned by
  a column*.

Without the CLI on `PATH` the service still comes up and serves. What stops is the autorun: the
column that works, doesn't.

### If you wanted to port it

Honestly: nothing here is written to be swapped. The surface another CLI would have to match is
about a dozen flags, a skill format, a JSON result contract and a sandbox-plus-settings permission
model. Each of those has an analogue in other agent CLIs, and none of them is behind an interface
today. It is a real project, not a configuration change — and a pull request that introduces the
seam is more welcome than an issue asking for it.
