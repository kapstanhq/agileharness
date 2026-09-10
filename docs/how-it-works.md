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
> the affected suite as a gate. A conflict doesn't wake anyone up: a headless run reads the
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
