---
name: harness-sync
description: >-
  Sync an AgileHarness board with the CURRENT STATE of its app, with human-in-the-loop
  confirmation. Scans an app's real code (routes/pages, Cloud Functions, key
  components/flows) read-only, compares against the existing cards in
  storymap/boards/<app>/, and proposes a reconciliation: NEW stories for shipped-but-
  unmapped features, status/field updates for drift, and flags for stale/obsolete
  cards. CONFIRMS every change with the user via AskUserQuestion before writing the
  .md files. Use when the user says "/harness sync", "/harness-sync", "sincronizar storymap",
  "sync o board", "mapear o app", "gerar stories do app", "atualizar o
  board com o código", or wants the AgileHarness to reflect reality. Read-only on app
  code; edits ONLY storymap data files. Always confirms before writing.
triggers:
  - /harness sync
  - /harness-sync
  - sincronizar storymap
  - sincronizar board
  - sync storymap
  - mapear o app
  - mapear app
  - gerar stories do app
  - atualizar board com o código
  - usm sync
---

# /harness-sync — reconcile an AgileHarness board with the app's real state (with confirmation)

Make the board reflect what the app actually is: scan the code, diff against the cards,
**propose** new stories + updates, **confirm with the user**, then write.

> Read `storymap/README.md` first — canonical schema/pipeline. This skill is READ-ONLY
> on the app's source and edits ONLY `storymap/boards/<board>/cards/` + `board.yaml`.
> NEVER touch `packages/storymap-ui/`. Respect gates: brand-new (not-yet-built) cards enter
> at `triage` (the staging intake) — a human routes them into the build flow from there;
> map an already-shipped feature as `concluida` ONLY when it also satisfies that
> stage's nature (it's truly done) — but a gated status still needs its field, so prefer
> proposing `concluida` only for stories you also fill `acceptance`/`tasks`/`rice` for,
> otherwise stage a partially-built feature at the pipeline stage its evidence justifies
> (filling that stage's gate field). The
> `validate-storymap-gate` hook will reject a gated status missing its field.

## When to Use

- The user wants the board to catch up with the codebase (new features shipped, flows
  changed, stories obsolete).
- The user runs `/harness sync <app>` or `/harness-sync <app>` (e.g. `demo`).
- Bootstrapping: a board exists but is thin and the app already has many features.

## Input

```
/harness-sync <app>     # e.g. /harness-sync demo  (board id == folder under storymap/boards/)
/harness-sync           # ask which board, or sync all boards one at a time
```

## Workflow

1. **Map board → package.** Read the board's `board.yaml`: its `package:` field names the
   package the board maps to (`packages/<app>/`) — that's the code you scan. Discover the
   existing boards with `list_boards` (also see root `.claude/CLAUDE.md`).
   **`package:` is OPTIONAL, and a board without one is legitimate** (a discovery board that
   maps a product journey with no code yet — the shipped `demo` board is exactly that). When it
   is absent, do NOT guess a package: say so and ask the operator which tree to scan, or scan
   nothing. Guessing here is how a sync writes stories about the wrong codebase.

2. **Read the board (read-only).** `board.yaml` (vocab + gates) + all `cards/*.md`
   (titles, ids, statuses, hierarchy).

3. **Scan the app state (read-only).** Use `Glob`/`Grep`/`Read` (or an `Explore` agent
   for breadth — keep it read-only) to inventory the real surfaces: routes/pages under
   `web/src/app` (or `src/app`), Cloud Functions exports, key flows/components, and any
   ADRs that changed scope. Build a list of user-facing capabilities the app has TODAY.

4. **Diff → reconciliation plan.** Compare capabilities vs. cards:
   - **Add**: shipped/owned features with no matching story → propose new cards
     (placed under the right `activity`/`step`, creating parents only if missing).
   - **Update**: cards whose title/scope/status drifted from reality (e.g. a story whose
     feature is clearly live → propose moving toward `concluida`, filling fields).
   - **Flag**: cards for removed/obsolete features → propose delete or mark, with reasons.
   - Avoid duplicates: match on title/id/feature, don't re-create existing stories.
   Note coverage you intentionally skipped (don't silently truncate a big app — say
   "mapeei rotas + functions; deixei de fora X" so the user can ask for more).

5. **CONFIRM via AskUserQuestion (mandatory, before any write).**
   - Summarize the plan grouped as **Adicionar / Atualizar / Remover**, with counts and
     the concrete cards.
   - Ask **Aplicar tudo (Recomendado) / Escolher itens / Cancelar** (recommended first —
     `[[feedback_ask_question_recommend]]`). For large diffs, batch by activity/area and
     confirm per batch so the user can approve subsets. "Other" allows free instructions.
   - On **Escolher itens** or other instructions, narrow/revise and **re-confirm**.
     Never write before explicit approval.

6. **Apply.** Write the approved `.md` files per `storymap/README.md` (schema, gates,
   safe defaults, one field per line, PT-BR brand voice — see
   `[[feedback_brand_vocab_blacklist]]`). Reuse only ids in `board.yaml`; confirm before
   adding a new persona/system to `board.yaml`.

7. **Report.** Summarize created/updated/flagged cards with ids + paths, and what was
   left out of scope this pass.

### Guardrails

- **Read-only on the app; confirm before any AgileHarness write.**
- Respect the pipeline + gates; don't fabricate a `concluida`/`pronta` without its field.
- Edit ONLY `storymap/` data files. No PRDs/other docs. Don't run builds/tests just to
  scan — inspect code statically.
