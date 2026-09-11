# AgileHarness — the agent's guide

You probably got here through an MCP server. This file is the short route; the full guide is in the
`mcp_onboarding` tool.

> **Talking to the server by hand?** It's JSON-RPC 2.0 over HTTP POST, and the response comes back as
> `text/event-stream` (lines prefixed with `data: `), so send
> `Accept: application/json, text/event-stream`. It is *stateless*: it returns no `Mcp-Session-Id` and
> there is no session to keep. The address is `/api/mcp/<credential>/mcp`, and this line works
> (`$AH` is the credential — the next section covers how the operator issues one and why its LEVEL
> changes what you can do):
>
> ```bash
> curl -s "http://127.0.0.1:${AGILEHARNESS_PORT:-3008}/api/mcp/$AH/mcp" \
>   -H 'content-type: application/json' \
>   -H 'accept: application/json, text/event-stream' \
>   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
>   | sed -n 's/^data: //p'
> ```
>
> The `content-type` is not optional: without it the response is 415, and without the `accept` it's 406.

## The credential, and why its LEVEL decides your next hour

The MCP port is born **closed**. The operator arms it, with one of two commands — and the difference
between them is the difference between working and knocking on a gate:

```bash
node dist/ah-server.mjs --generate-mcp-token                      # level `full`
node dist/ah-server.mjs --generate-mcp-handle --level write       # SCOPED, revocable credential
```

**`--generate-mcp-token` issues level `full`**: total autonomy over the repository, no gate.
**Handles are scoped** (`ro` · `write` · `orch` · `full`), revocable without a restart
(`--list-mcp-handles`, `--revoke-mcp-handle <id>`), and they are the right choice when someone else
will hold the credential.

But know what you're choosing. With a **scoped** credential, `register_board` is refused (it is a
REPO-scope action, and `ask` at repo scope refuses instead of opening an approval — there would be no
Inbox for it to appear in), and **every** board write (`create_card`, `save_persona`, `save_system`)
hangs on a human approval request until the operator declares the risk matrix **of that board** in
`storymap/boards/<board>/board.yaml` → `orchestrator.riskMatrix.write-board: auto` (the matrix in
`settings.yaml` is the REPO-scope one and does **not** apply to board scope — they are two matrices,
with no fallback between them).

**If you are the operator and the agent at the same time** — the case for anyone adopting this on a
personal project — use the `full` token. Scoping your own credential only adds gates that only you can
open. (And don't go looking for the screen: `register_board` has no UI, it is MCP only.)

**What this is.** A User Story Mapping board (Jeff Patton) that is the product source of truth for ONE
repository — the repository it runs in. Each app has a *board*. Cards have three levels
(**activity** = big goal → **step** = task → **story** = detailed story) and travel through a
**pipeline** of columns. Certain columns have a **gate** (a precondition a card must satisfy to enter)
and a **trigger** (a skill that runs on its own when a card enters, if the board is armed).

**The idea that explains the rest:** the harness is not a form. A card that enters an armed column is
processed by a headless agent that enriches, breaks down, prioritizes, plans, builds, reviews and
publishes it — and stops it at every gate it fails.

---

## Read this before acting

The MCP server exposes four *resources*. They are not decorative documentation: each one answers a
question no tool answers.

| resource | answers |
|---|---|
| `agileharness://target` | **which repository this server operates on** — read it BEFORE your first write |
| `agileharness://pipeline/base` | the pipeline a new board inherits: columns, statuses, gates, what triggers |
| `agileharness://pipeline/gates` | what each gate requires **and how to satisfy it** (a `move_card` refusal doesn't carry that part) |
| `agileharness://autorun` | the switches: the installation master and which boards are armed |

After those, `mcp_onboarding` for the full guide, and `list_boards` to see what already exists here.

---

## Before your first write: confirm the house

**Read `agileharness://target` and check that the root is YOUR project.** This server's tools don't
say which installation they belong to, and the whole prose uses deixis — "THIS repository", "the
repository it runs in" — which you, at the other end of the wire, have no way to resolve.

This is not hypothetical. In an adoption test, an agent about to install the tool in its own project
already had `AgileHarness` tools in its environment, wired to a **different** installation. Had it
followed the example below to the letter, it would have created its board inside a third party's
production repository. If the root isn't yours: stop, and bring up your own instance with
`AGILEHARNESS_TARGET`.

## Register a new app

```
register_board({ id: "store", name: "Aurora Books" })
```

Requires a `full`-level credential (see above) and, under `AGILEHARNESS_TARGET`, requires
`storymap/boards/_base/board.yaml` to exist in the target's tree — copy it once from the tool's
repository. Without it the call is **refused**, and the refusal says exactly this.

`id` is a lowercase slug (`^[a-z][a-z0-9-]{0,39}$`) and becomes the directory name under
`storymap/boards/`. It is **refused**, never silently corrected — getting back an id different from
the one you asked for is worse than getting an error.

The board is **born disarmed**. No column fires an agent until someone arms it, and that is
deliberate: the inherited pipeline has steps that spend tokens and run processes on the machine
hosting the harness.

Optional: `package` (the directory this board maps, e.g. `packages/store` — omit it if the board maps
a journey that has no code yet) and `deploy` (how this app publishes; `kind:"command"` requires
`command`, `kind:"agent"` requires `description`).

Out of reach by design: the orchestrator policy and the pipeline. The first would let the board be
born granting itself permissions; the second would leave it deaf to future changes in the template.

## Arm it

```
set_board_autorun({ board: "store", enabled: true, confirm: "store" })
```

`confirm` is required only to **arm**. Disarming asks for nothing — it is the per-board kill switch,
and friction when stopping something is the one thing you cannot have.

## Before the backlog: the PRD

A board with cards and no PRD is a task list. The PRD is the board's highest document, at
`storymap/boards/<board>/docs/prd.md`, and everything below it descends from it — the Lean Canvas
is its compression, the story backbone comes out of its journeys, the personas out of its audience.
Every agent step inherits a digest of it. Write it **before** you capture a backlog; drafting the
map first means compressing a page out of nothing.

```
read_doc({ board: "store", docType: "prd" })          # get the section KEYS first
write_doc({ board: "store", docType: "prd",
            section: "resumo", prose: "..." })         # one section at a time, by KEY
```

`section` is the key (`resumo`, `problema`, `publico`, `posicionamento`, `objetivos`, `escopo`, …),
**not** the visible label — the labels are locked and a write that renames one is refused. Section
content is either `prose` or `items`, whichever the section declares; `read_doc` tells you which.
Six sections are required, ten more are optional and can stay skeletal.

Three of them are written for **you**, not for the human reader, and skipping them costs you later:

| section | why you want it |
|---|---|
| `decisoes` | decisions already taken. Without it you will re-decide them, plausibly and wrongly. |
| `jornadas` | what `usm_capture` turns into a backbone instead of a flat list of orphans. |
| `prontoQuando` | verification criteria for the product. "It works" is not one. |

**The PRD is human-owned, and editing the file directly is blocked.** A `Write` or `Edit` against
`storymap/boards/<board>/docs/prd.md` is refused by the ownership guard, and the refusal names the
way through: `propose_change({ board, artifact: "prd", field: "<sectionKey>", after: … })`, which
opens a draft with a diff for a human to approve. The same holds for the Lean Canvas
(`artifact: "canvas"`), personas and releases — what belongs to the human, you propose.

If you are running unattended, propose rather than write, even where a tool would let you through:
the approval is the point, not the obstacle.

## First card

A story needs a place in the hierarchy. On an empty board, build the skeleton first:

```
create_card({ board:"store", title:"Buy a book",     type:"activity" })
create_card({ board:"store", title:"Track my order", type:"step",  parent:"act-buy-a-book" })
create_card({ board:"store", title:"...",            type:"story", parent:"step-track-my-order" })
```

For a whole plan at once, prefer `usm_capture` — it reads free text and returns a parented backbone.
N `create_card` calls leave N orphan cards.

Every card is born in **`triage`** — the intake column, with no trigger, on purpose. The card only
starts moving when you move it to **`enriquecer`**, which is where the cascade picks it up. (The
pipeline has statuses before that one — `capturando`, `grill` — but those serve other intake paths;
for a card you just created, the destination is `enriquecer`.) With the board armed, from there it
goes on its own until it stops at a gate.

**Story ids belong to the server, not to you.** An `activity` and a `step` get an id derived from the
title (`act-buy-a-book`, `step-track-my-order`), but a `story` gets an opaque id (`story-cbpsoa`).
Don't assume a story's id in order to use it as `parent` in the next call — read what the creation
returned.

---

## The guards that come with the pipeline

This repository ships three hook checks under `.claude/hooks/checks/`, plus the `runner.js` that
discovers them. They are **not** style policy — they enforce the board-data contract, and each one
exists because something went wrong without it:

| check | what it refuses |
|---|---|
| `block-runtime-board-writes` | an agent writing `storymap/boards/**` through the filesystem in the checkout where the service is **live**. The lock that serialises a card is in-process; against another process it is last-writer-wins, and that is how two closed blockers reopened themselves. Use the MCP tools instead — they take the lock. |
| `validate-storymap-gate` | a card advancing past a gate it has not satisfied. |
| `guard-business-intent` | a change that drops the card's stated intent on the floor. |

**They do nothing until you wire them.** Hooks live in settings files, and this repository
deliberately does not ship a `settings.json` — yours carries your own `permissions` and `env`, and
overwriting it would be rude. Add this to your `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit",  "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/runner.js\" pre-edit" }] },
      { "matcher": "Write", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/runner.js\" pre-write" }] }
    ]
  }
}
```

The runner discovers every check in `checks/<phase>/`, so adding your own is a file, not a
registration. `.claude/hooks/tests/` holds their tests — run them the same way you run the rest.

## How things go wrong

- **A gate refused the move.** Don't force it. The refusal states the reason;
  `agileharness://pipeline/gates` states how to satisfy it.
- **Nothing happened.** There are four independent causes — the master switch, the board's own lock,
  economy mode, and a gate. `agileharness://autorun` shows the first three. There is no boolean that
  promises "it will run": it would be lying about at least one of them.
- **Nothing happened AND everything is green.** There is a fifth cause, and it's the treacherous one:
  if the service restarted while a card was entering a column, the trigger for that entry can be lost.
  The card sits still with the master on, the board armed, and no pending gate — and `runner_status`
  answers `running:[] failures:[] history:[]`, which is **identical** to "there is nothing to do".
  Don't conclude that it finished. The remedy is `run_skill`, which runs the CURRENT column's skill
  without moving the card; if it advances, that was it.
- **A tool doesn't show up.** This server publishes all of them in `tools/list`, on a single page — if
  you're talking to it directly, there is nothing to load. What *can* hide a tool is **your client's**
  harness: some defer the schema when there are many, and then you load it through the client's own
  mechanism (in Claude Code, `tool_search`). There is no `tool_search` tool **on this server**.
  Resources are never subject to deferral, on any client.
- **You got a "repo scope" refusal.** Your token lacks the authority for that action. The message
  names the lever the operator has to move.

## The `demo` board

This repository ships with a demo board (synthetic data, a fictional bookstore). It is the subject of
the test suite and is **born disarmed on purpose** — an example should never spend the tokens of
someone who just cloned the repository. Use it to understand the format; don't arm it by accident.

## Limits

This MCP's tools **do not edit code**. To read, use `search_code` / `read_file`. To write, spawn an
agent with its own context. Production (deploy, deletion, kill) requires explicit confirmation, and
some actions are human-only by construction — there is no agent path to them, and that is not a bug.
