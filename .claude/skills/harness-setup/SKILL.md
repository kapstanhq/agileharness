---
name: harness-setup
description: >-
  Guided, hands-on installation and first run of AgileHarness — the skill a person runs
  after cloning the repository, when nothing works yet. It MEASURES the host (Bun, Node,
  the Claude Code CLI as the SERVICE would resolve it, bubblewrap + socat and whether the
  sandbox actually comes up, git identity, the inheritable pipeline, whether runtime
  secrets are outside git), FIXES what it can without asking (install, build, write
  config, seed the pipeline, issue the MCP credential, register the MCP server), and
  interrupts ONLY for real decisions: run it locally or on a VPS (it explains what a VPS
  is and why it matters here), a repository or an idea, whether to arm the autorun (that
  spends your tokens), and whether to open the MCP surface for phone and remote control.
  It re-measures the whole checklist on every run, so a second run reports what is already
  true instead of redoing it, and it PROVES the install end to end instead of assuming it.
  Two entry paths: an EXISTING repository (register the board, inherit the pipeline, map
  what already ships) or a NEW IDEA (an interview that fills the Lean Canvas in Ash
  Maurya's order, then a backbone and the first stories). Use when the user says "set up
  AgileHarness", "help me install this", "get started", "onboard me", "it is not running",
  or has just cloned the repository and does not know what to do next. Human-in-the-loop:
  it never arms an agent or opens a network surface without an explicit answer.
triggers:
  - /harness setup
  - /harness-setup
  - set up agileharness
  - install agileharness
  - get started
  - onboard me
  - first run
  - it is not running
  - nothing happens
---

# /harness-setup — from a fresh clone to a board that works

Your job is to get AgileHarness **running and proven running** on this machine, with a board
that has something in it, while asking the person as little as possible.

**Fix silently, decide loudly.** Anything mechanical — installing a package, building,
writing a config line, issuing a credential — you just do, and report afterwards. You stop
only for the four decisions in §3, because each one costs money, spends the person's tokens,
or opens a network surface.

---

## 1. The two regimes, and the bridge between them

You will operate in two different tool regimes, and confusing them is the main way this goes
wrong.

| | Cold | Warm |
|---|---|---|
| When | before the service runs, or before a credential exists | after the service answers and a credential exists |
| You have | Bash, Read, Write, AskUserQuestion, TodoWrite | the above, plus the AgileHarness MCP tools |

**The MCP surface does not exist at first contact.** Nothing generates a credential at boot —
that is deliberate, and it means `register_board`, `usm_capture` and `write_doc` are simply
not available when you start. You have to earn them.

**Do not tell the person to restart and run you again.** Registering an MCP server does not
take effect in the session that registers it, but the endpoint is plain JSON-RPC over HTTP.
Once you have issued a credential, call the board over `curl` in this same conversation:

```bash
curl -s "http://127.0.0.1:${AGILEHARNESS_PORT:-3008}/api/mcp/$AH/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}' \
  | sed -n 's/^data: //p'
```

Both headers are load-bearing: without `content-type` the answer is 415, without `accept` it
is 406. Every refusal the tools normally give you still applies — you lose nothing by taking
this route. Register the server with `claude mcp add` at the END, as the durable convenience
for the person's next session.

---

## 2. The checklist is MEASURED, never remembered

The person wants to see what still has to be true. Show them — but derive it by **probing on
every run**, never by trusting a file that says an item was done.

The engine ships the probe. Use it:

```bash
node dist/ah-server.mjs --preflight --json
```

It works before the service is up, exits 0 even when it fails items (so it survives `set -e`
in your own shell), and every failing item carries a `remedy` that names the fix. Read
`remedy` and act on it — do not invent your own remedy for an item the engine already
explained.

**On a fresh clone that file does not exist yet, and this is the one bootstrap you cannot
measure your way out of.** `dist/` is build output and is not versioned, so the probe is
something you have to *produce* before you can *run* — and producing it needs the very
toolchain the probe exists to check. Do this by hand, in this order, before anything else:

```bash
command -v bun  || echo "sem bun";  command -v node || echo "sem node"
cd packages/storymap-ui && bun install && bun run build   # ~4 min: ~28 páginas do App Router
```

If either binary is missing, stop and say so plainly — [bun.sh](https://bun.sh) and Node 20+
are the floor, and there is no way to report anything useful without them. If the build fails,
that failure IS the first finding: report it with the error, do not proceed to §3 pretending
the checklist is merely incomplete. Once `dist/ah-server.mjs` exists, everything below runs,
and every later item is measured rather than assumed.

**One property of that report matters more than the others.** Its first item, `env.source`,
says whether it measured the live service's environment or merely this shell's. A shell's
`PATH` almost always reaches the Claude Code CLI; the `PATH` a service unit pins very often
does not. A report that says `o ambiente DESTE processo` has NOT yet answered the question
that matters. Get the service up, then measure again for the verdict that counts.

Mirror the report into `TodoWrite` so the person watches items flip — one entry per check,
marked complete only after you have **re-run the probe** and seen it pass. Never mark an item
done because the fix command exited 0.

Write only the **decisions** to `storymap/.runner/setup-receipt.json` (local or VPS, board id,
armed or not, MCP opened or not). That directory is already fenced out of git. It exists so a
second run does not re-ask §3, not so it can skip re-measuring. If the receipt and a probe
disagree, the probe wins.

---

## 3. The four decisions

Ask nothing else. Everything else you do and report.

**D1 · A repository, or an idea?** Two different programs downstream. If it is a repository, this
is also where you learn **which** one — see §5A, because discovery cannot answer that question and
guessing it wrong is silent. Offer a third option — "just show me the demo board" — for someone
who wants to look before committing.

**D2 · Local or VPS?** Read them §4 first, then ask. Local is a fine answer; do not push.

**D3 · Arm the autorun?** This is the one that spends their tokens and runs agents on their
machine. Default to no. The tool that arms a board already demands the board id as an
explicit confirmation — surface that honestly rather than smoothing it over.

**D4 · Open the MCP surface?** It issues a secret that operates the board, and the board
spawns agents with execution power. Explain that before asking, not after.

Anything the probe reports that you cannot fix mechanically — a kernel policy change, a
password, a purchase — is an escalation, not a fifth question. Give them: what is broken, what
it costs them, the exact command, and how to tell you it worked. Then **carry on with the
remaining items**; a blocked sandbox must not stop the board from being registered.

---

## 4. What to tell someone who has never heard of a VPS

Deliver this as prose, before the question.

> **Where should AgileHarness run?**
>
> This is worth thirty seconds, because it is the only choice here that is about your life
> rather than your machine.
>
> AgileHarness is not an app you open. It is a **service** — a program that sits running,
> watching the board, and starting work when a card lands in a column that has an agent
> attached. The board is the interface; the service is the thing that does the work.
>
> So the real question is: **what happens when you close the laptop?**
>
> **Locally** costs nothing extra and you can start in two minutes. But the service is only
> alive while this computer is. Close the lid and every agent mid-run stops where it stands.
> For trying it out, for a weekend project, that is completely fine.
>
> **A VPS** — Virtual Private Server — is a small computer someone else runs in a data
> centre, rented by the month. It is not special hardware and not a cloud platform with a
> hundred services; it is one plain Linux machine. You get an address and a password, and
> from then on it behaves like a computer that never sleeps and is never on hotel wifi.
>
> Cost is roughly **five to twelve US dollars a month**. Two cores, 4 GB of memory and 40 GB
> of disk running Ubuntu or Debian is enough. Below 4 GB the agent runs start competing for
> memory and end up queueing.
>
> **Why it matters here more than for most software:** the whole premise is that work
> continues while you are not watching. A card enters a column, an agent picks it up, and ten
> minutes later there is a spec or a plan or a diff. On a laptop you are the thing that has to
> stay awake for that. On a VPS you file a card from your phone on the train and it is done by
> the time you sit down.
>
> **And the phone is the second reason.** Driving the board from the Claude app needs an
> address reachable from outside your home network. A laptop behind a router does not have
> one.
>
> **What you give up by staying local:** nothing about the product — every feature works. You
> give up continuity and reachability.
>
> **What a VPS costs you:** a monthly bill, and about twenty minutes of first-time setup — a
> service definition so it restarts on boot, a reverse proxy with a certificate, and one log
> rule so your access token does not end up written into a log file. I will write all three,
> but they run over there, so you will run me again on the VPS.
>
> **My recommendation:** start local today. Move to a VPS the first time you catch yourself
> leaving the laptop open so a run can finish — that moment is the signal, and moving later
> costs nothing, because the board is just files in your repository and it travels with you.

If they choose the VPS and you are **not** on it, stop and hand off: give them the three lines
that get the repository onto the VPS and end with running you again there. Do not try to
configure a machine you are not on.

---

## 5. The two entry paths

### A · An existing repository

**First settle WHICH repository, and do not let discovery answer it.** Root resolution walks up
for `turbo.json`, `.git` or `storymap/boards` — and a standalone AgileHarness clone satisfies all
three *on itself*. Left alone it registers a board **for AgileHarness**, not for their project,
and it does so silently: every later step succeeds against the wrong tree.

There are only two shapes, and you can tell them apart by where you were started:

- **Their repository is this tree.** They cloned AgileHarness and are building it, or they are
  starting from an idea with no code. Discovery is correct; declare nothing.
- **Their repository is elsewhere.** The common case. Ask for the absolute path of its **root**,
  confirm it carries one of the three markers, and declare it:

  ```bash
  echo 'AGILEHARNESS_TARGET=/absolute/path/to/their/repo' >> packages/storymap-ui/.env.local
  ```

  A subdirectory is refused on purpose — git operations resolve upward and would reach the
  repository outside. Never write `$PWD` there: it is only correct from one directory, and wrong
  from every other, including the one a service unit starts in.

1. **Read the identity from the target, not from here.** The package name, the directory name and
   the git remote all come from the tree you just settled on.
2. **Seed the inheritable pipeline first — in the TARGET.** Copy `storymap/boards/_base/board.yaml`
   into the target tree, because under `AGILEHARNESS_TARGET` that path resolves over there, where it
   does not exist yet. Board registration refuses without it — correctly, because the alternative
   is a board with no columns that lists as if it were ready. Say why you are copying it.
3. **Propose the board identity, with a preview.** Show the id, the human name and the package
   path as the frontmatter they will become. The id is permanent and becomes the directory
   name; registration refuses a bad slug rather than quietly cleaning it up, so get it right
   here.
4. **Register, then read back.** Do not report success from what you sent — list the board and
   its columns and confirm the inherited pipeline is actually there. Zero columns means step 2
   did not take, and you loop rather than declaring victory.
5. **Offer to map what already ships.** Their board is empty and their app is not. `/harness-sync`
   already owns that job and confirms before writing anything. Hand off; do not reimplement.

### B · An idea, no code yet

**Draft first, ask only what you should not guess.** A twelve-question interrogation is the
opposite of what this skill is for.

Open with one prompt: *"Tell me about the idea in your own words — who it is for, what is
broken for them today, and what you would build. A paragraph is plenty; I will draft the rest
and only ask about the parts I should not invent."*

**Write the PRD first.** It is the board's highest document — `storymap/boards/<board>/docs/prd.md`
— and everything else descends from it: the Lean Canvas is its one-page distillation, the story
backbone comes out of its journeys, the personas out of its audience. Drafting the canvas first
would mean compressing a page out of nothing.

Draft the six required sections from what the person just told you — executive summary, problem,
audience, positioning, objectives and metrics, scope — and leave the other ten as the skeleton they
are. Write through the document's own surface (`write_doc`, docType `prd`, one section at a time,
by the section KEY rather than its label; run `read_doc` first to get the keys). Three sections
deserve a sentence of explanation when you show the draft, because they are the ones written for
the agents rather than for the reader: **decisions already made** (an agent that does not know a
decision was taken will take its own), **journeys** (this is what the capture turns into a backbone
instead of a flat list) and **done when** (verification criteria — "it works" is not one).

Then draft the whole Lean Canvas in the canonical fill order — customer segments, problem,
unique value proposition, solution, channels, revenue, costs, key metrics, unfair advantage —
deriving it FROM the PRD you just wrote, and ask exactly **three** questions, each with drafted
options rather than a blank box:

- **Who feels this most acutely today?** It is first in the fill order for a reason: every
  block downstream is conditioned on it, and a wrong segment quietly poisons all of them.
- **Of these three pains, which is number one?** The ranking decides what the backbone builds
  first, and a ranking is a judgment, not an inference.
- **How does this make money, or not yet?** The one block where a plausible invention is
  actively harmful. "Free for now, deciding later" is a legitimate answer.

Show the complete canvas and get one approval before writing anything. Where there is no
unfair advantage, write that there is none yet — that is the honest entry.

Then derive a plain-language narrative from the PRD's journeys and scope — not from the canvas,
which is the compression rather than the source — and run it through the capture tool in propose
mode, show the resulting tree, and apply it only after approval. Do **not**
loop card creation one at a time: that leaves parentless stubs with no hierarchy, and
resolving the hierarchy in one batch is the entire point of the capture path.

On the existing-repository path the PRD has a different origin and the same place: propose it from
what the code already ships (the sync skill reads the repo), or import one the person already has
by pasting it in — section by section, into the keys that match. Either way it is written before
the backbone, for the same reason.

Both paths end with cards resting in `triage`, and nothing has spent an agent.

---

## 6. When something is broken

Diagnose, fix, then **measure again**. Two attempts per item, then escalate — a third try at
the same fix is a loop, not persistence.

Four failure modes deserve naming because their symptom points away from their cause:

**The CLI resolves for you but not for the service.** The single most expensive one. The
binary sits somewhere your shell reaches and the service's pinned `PATH` does not, and every
agent spawn fails with a message that dies inside a card's console and never reaches the
system journal. The fix is to declare the absolute address in the service's environment. Prove
it by re-running the probe and reading `env.source`.

**The sandbox binaries are installed and it still does not come up.** On Ubuntu 23.10 and
later the kernel restricts unprivileged user namespaces, which is what the sandbox depends on.
Here the usual advice is **wrong** — the packages are already there. The probe distinguishes
this case; read its remedy, which names the ways out. Running as root masks the restriction,
so a green measured as root does not predict a service running as a normal user. This is an
escalation: it is a security posture decision, not a package install.

**Runtime secrets are already committed.** Do not auto-fix this. The remedy has two halves —
untrack them **and rotate them** — and running only the first leaves a repository that looks
clean with credentials that still work, which is worse than where you started. Present both
halves and let the person run them.

**The board endpoint answers 404.** Two causes with an identical symptom: no credential is
declared (the door does not exist, which is the safe default), or one is declared and was
refused as too weak (the surface stays shut and the person hunts a 404 believing they
configured it). Tell them apart before acting.

**And the build is not hung.** It takes around four minutes. Say so before you start it —
people kill healthy builds.

---

## 7. What must be true before you say you are done

Each of these needs a proof. A claim without one is the exact defect this skill exists to
prevent.

| Must be true | Proved by | Not proof |
|---|---|---|
| the service answers | a request that returns a parseable board list | the process being in `ps` |
| the engine can spawn an agent | the probe reporting the CLI resolved **in the service's environment** | the binary existing on disk |
| the containment posture is known | the sandbox probe's exit code | the packages being installed |
| the pipeline is inherited, not empty | listing the board's columns and getting the full set | having copied the file |
| the board exists | the board appearing in a listing | the registration call returning ok |
| the arm state is what they chose | reading it back from the board's own config | having called the tool |
| secrets are outside git | nothing tracked under the runtime state directory | an ignore rule existing |
| the MCP surface works, if opened | a real tool call over the endpoint returning a non-empty list | a 200 from the endpoint |

### "I measured it" is not "I saw it mentioned"

The right-hand column above is not pedantry — it names a specific way this goes wrong, and it is
the way that survives a careful agent. You read a value somewhere authoritative-looking (a config
file, a log line, this document) and report it as if you had observed it. It is not a lie and it
does not feel like one; the number is simply the wrong number.

It happened during the first run of this skill. The columns of a freshly registered board were
counted by grepping the pipeline file for `id:` keys — 45. The real answer was 28, and it came
from the reader: the tool's own listing call. The file has many `id:` keys that are not statuses.
The grep was a measurement of the *file*; the question was about the *board*.

So, when you write your close: for every claim, be able to name the command whose output you are
quoting. If the honest answer is "the settings file declares it", write that instead — a declared
value and an observed one are different facts, and only one of them survives contact with the
machine. Say which one you have.

Close with: what you did, what you skipped and why, the two addresses (board and endpoint),
what it costs them from here — a monthly bill if they took the VPS, and that runs spend their
Claude tokens — how to turn the autorun off again, and **one** concrete next action.

If an item is unproven, say it is unproven. A checklist that marks unverified items done is
the thing this whole skill exists to remove.
