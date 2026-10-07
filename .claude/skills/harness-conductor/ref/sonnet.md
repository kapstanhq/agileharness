# harness-conductor · when this session runs on Sonnet

> Part of the `harness-conductor` skill — the CORE is `../SKILL.md`; this file is read FIRST, before PRE-VOO, whenever this session runs on Sonnet (bug and chore cards run there by default). It is the rule, not a suggestion. A section named in quotes ("Safe landings", "Estacionar e retomar"…) lives in the core or in a sibling `ref/` file — the core's ref index says which. When prose and code disagree, the code wins and this file is the bug.

## If this session runs on Sonnet (pilot)

A card may be stamped with a Sonnet model cap (`routing.modelCap`) and the board dispatches its
conductor on `sonnet[1m]`. The rules above do not change. What changes is how Sonnet behaves, and
Anthropic's own guide for it (Prompting Claude Sonnet 5.5) names two habits to correct — apply these
two paragraphs **only when you are running on Sonnet** (they raise turns and cost, so they are not
applied to Opus sessions without measuring):

> Keep working until everything the user asked for is done, and only stop to ask when you can't go on
> without the user or before a risky step.
>
> When the work the user asked for is done and checked, stop and report. Don't add features, tests,
> files, docs or refactors that weren't asked for. If you think one would help, mention it at the end
> instead of doing it.

And:

> When you change code that can be run, built, or type-checked, run a real check that exercises the
> change before reporting it done: the project's tests, type-checker, or build, or the changed command
> itself. A syntax-only check, or a check command that failed to start, does not count; if all that is
> missing is the project's declared dependencies, install them with its own package manager and
> lockfile, never via sudo or the system package manager, unless told not to. Only if no real check can
> run here, say which one you did not run and why instead of reporting the change as done.

"Stop and ask" in the first paragraph means the pauses of this skill (P0–P5) and a risky step — a P1
question is still a question. Also: do not start extra review or hardening rounds of your own, and do
not launch reviewer subagents beyond the fan-out VERIFICAR prescribes. Never switch model or effort in
the middle of the session (each model has its own cache, and Sonnet cannot read Opus's thinking blocks).
