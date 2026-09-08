---
name: harness-tests
description: >-
  AgileHarness automation that plans the test pyramid for a story AND authors the
  acceptance E2E specs test-first. Reads a card from
  storymap/boards/<board>/cards/<id>.md (ideally in `quebrar-tasks`/`desenvolver`,
  where the tasks exist), derives unit/integration/e2e coverage from its acceptance
  criteria, records it as extra tasks[] (test- prefixed) + a Test Plan section,
  and — for UI-observable user-story criteria — writes a FAILING Playwright spec
  per criterion (the criterion text IS the test title; no cucumber/BDD framework)
  under packages/<pkg>/tests/e2e/, so harness-do builds against them (red→green) and
  harness-qa executes them as the acceptance gate. Does NOT move the status — it
  sharpens an existing card. Use when the user says "/harness tests", "/harness-tests",
  "plano de testes", "pirâmide de testes", "test plan da story". Edits storymap
  data files AND product test code under packages/<pkg>/tests/e2e/ — never the
  storymap-ui package.
triggers:
  - /harness tests
  - /harness-tests
  - plano de testes
  - pirâmide de testes
  - test plan story
  - planejar testes
  - usm tests
---

# /harness-tests — AgileHarness: plan the test pyramid for a story

A AgileHarness helper that designs the **test pyramid** (unit → integration → e2e)
for a story and records it on the card, so `/harness-do` can implement it test-first.
Unlike the trigger skills, `harness-tests` does NOT own a status slot and does NOT
advance the pipeline — it enriches an existing card with a test plan.

> Read `storymap/README.md` first — it is the canonical schema/pipeline source.
> Test layers/philosophy: `.claude/rules/testing-philosophy.md` (pyramid:
> unit → integration → journey → e2e; fix-the-app, never weaken assertions).
> This skill edits the data files under `storymap/boards/<board>/cards/` AND, for
> UI-observable user-story criteria, authors FAILING Playwright specs under
> `packages/<pkg>/tests/e2e/` (test-first). NEVER touch `packages/storymap-ui/`.
> Permission mode: acceptEdits (it writes test files, not product/runtime code).

## When to Use

- A card already has `tasks` (status `desenvolver`, after `quebrar-tasks`)
  and you want a coverage plan before building.
- During `desenvolver` to flesh out the TDD plan for `/harness-do`.
- The user runs `/harness tests [<board>/<id>]` or asks for "plano de testes" /
  "pirâmide de testes" for a story.

## Input

```
/harness-tests <board>/<id>      # plan tests for one card (e.g. demo/story-recomendacao-email)
/harness-tests                   # no id = process cards in `desenvolver` (or ask)
```

- With **no argument**, prefer cards in `desenvolver` (where TDD planning is most
  useful); if none, ask which card to plan.

## Workflow

1. **Locate the board + card.** Read `storymap/boards/<board>/board.yaml` and the
   target card. Read the card's `acceptance` and existing `tasks`.

2. **Derive the pyramid.** Map each acceptance criterion to the cheapest test
   layer that proves it (favor the base of the pyramid):
   - **unit** — single function, mocked (`tests/unit/`, `.test.ts`).
   - **integration** — single operation, real emulators (`.integration.test.ts`).
   - **journey / e2e** — 3+ chained ops / browser, only for the user-visible goal.
   Be explicit and minimal — e2e is expensive; prefer integration for ROI.

3. **Record as tasks + notes.** Append test tasks to the card's `tasks` array,
   each `{ id, title, done: false }` with a clear layer prefix in the title
   (e.g. "test(unit): riceScore retorna null com effort<=0",
   "test(integration): moveCardAction recusa entrar em priorizar sem acceptance").
   Use ids like `test-u1`, `test-i1`, `test-e1` so they're distinct from build
   tasks. Then add a `## Plano de testes` section in the body summarizing the
   pyramid (which layer, what it proves, which acceptance criterion it covers).

4. **Author the acceptance E2E (test-first) — UI-observable user stories only.**
   For a `storyType: user` card whose criteria are UI-observable, turn each such
   `acceptance[]` criterion into a FAILING Playwright spec, so the build is driven
   by it and `harness-qa` runs it as the acceptance gate before human Revisão:
   - **Title = the criterion verbatim** —
     `test('Dado …, quando …, então …', async ({ page }) => { … })`. This IS the
     BDD payoff: no `.feature` files, no step registry; the `list`/`html` report
     reads as Gherkin and traces straight back to the card.
   - **Location = the package's EXISTING E2E layout** (read `board.yaml` `package:`;
     follow `.claude/rules/testing-philosophy.md` + the package's playwright.config).
     Cheapest layer that proves the criterion: the mocked/`browser` project for pure
     UI logic, `tests/e2e/emulator/<card-id>.level2.spec.ts` for criteria that need
     the real seeded stack. One file per card. REUSE the package's auth/storageState
     setup (e.g. an existing `.auth/user.json` + the `authenticated`/`level2` projects) —
     never invent a new harness.
   - **Test-first = it MUST fail now** (the feature isn't built yet, or is the delta).
     Assert the real expected behaviour; never weaken it to pass. `harness-do` turns it
     green during TDD; `harness-qa` re-runs it as the gate.
   - **Record it** as a `test-e*` task pointing at the spec file, and list the spec
     path next to the criterion it proves in `## Plano de testes`.
   - **Skip** when the story is non-UI (`technical`/`spike`/`chore`) or a criterion
     isn't UI-observable — keep those as unit/integration tasks (the QA gate passes
     such stories freely). For `mode: refine`/`fix`, author specs ONLY for the delta
     criteria (+ a regression guard), reading `mode` exactly like harness-do/harness-qa.

5. **Do NOT change `status`.** This skill only sharpens the card. Bump `updated`
   to today and keep one field/one task per line for clean diffs.

6. **Report.** Summarize the planned pyramid (counts per layer), the acceptance
   specs authored (file + the criterion each proves), and which criteria each
   test covers.

### Guardrail

Adding tasks never violates a gate (more tasks only strengthens `hasTasks`), so
no status moves here. If you find a card with no `acceptance`, stop and suggest
`/harness-enrich` first — there's nothing to derive tests from yet.

Authored specs are the acceptance CONTRACT `harness-qa` later runs: they must FAIL
first (red — never write a spec that already passes against unbuilt behaviour),
must match the package's E2E conventions (so `just test-<pkg>-e2e` picks them up),
and must never weaken an assertion to go green. Fix the app, not the test.
