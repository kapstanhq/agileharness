---
name: harness-ux
description: >-
  AgileHarness automation that designs the USER-FLOW JOURNEY for a story (NO screens).
  Reads a card in status `design-ux` from storymap/boards/<board>/cards/<id>.md,
  wraps the app's UX DISCOVER phase, and writes a usage JOURNEY — a structured
  flow GRAPH (nodes/edges, rendered by the app as a real SVG diagram) + free-text
  PT-BR explaining how the user reaches/navigates/uses the feature and how it fits
  the rest of the app, grounded in the card's JTBD / interviews / personas — into
  the `journey` block of the sidecar storymap/boards/<board>/wireframes/<id>.json.
  It generates NO wireframes/screens (that is harness-ui's job, which builds them FROM
  this journey in the SAME threaded session), then advances `design-ux` -> `design-ui`
  (board-aware via advance-card). Only `user` stories have a UI surface —
  technical/chore/spike/bug short-circuit forward. With no id it processes the whole
  `design-ux` queue. Use when the user says "/harness ux", "/harness-ux", "jornada de uso",
  "fluxo do usuário", "user flow", "como o usuário usa", or wants to advance AgileHarness
  cards sitting in Jornada. Edits ONLY storymap data files — never product code, never
  storymap-ui.
triggers:
  - /harness ux
  - /harness-ux
  - jornada de uso
  - fluxo do usuário
  - user flow
  - desenhar a jornada
  - usm ux
---

# /harness-ux — AgileHarness: the usage journey (design-ux → design-ui)

The `harness-ux` trigger automation. It decides the **user-flow journey** of a story — how
the user reaches, moves through and leaves the feature, and how that flow fits the REST
of the app — BEFORE any pixel is drawn. It writes NO screens: the journey is the brief
the next step (`harness-ui`, Telas) realizes into the design canvas IN THE SAME SESSION (the
Design column threads the session, so harness-ui inherits everything you reasoned here). The
human approves the journey + the canvas TOGETHER one step later (`com-design`).

> Read `storymap/README.md` first. This skill wraps **the app's UX skill** but runs ONLY its
> DISCOVER + flow-design thinking (no dev server, no Playwright, NO screens). It edits
> ONLY storymap data: the card .md and the `journey` block of the sidecar
> `storymap/boards/<board>/wireframes/<id>.json`. NEVER touch product code or
> `packages/storymap-ui/`. Permission mode: acceptEdits.

## Input

```
/harness-ux <board>/<id>         # journey for one card
/harness-ux                      # no id = process the ENTIRE `design-ux` queue
```

The card must be `status: design-ux`. Only `user` stories have a UI surface — see the
short-circuit below for everything else.

## Short-circuit: non-`user` stories have no UI to design

**Before anything else, read the card's `storyType`.** A `technical`/`chore`/`spike`/
`bug` story has no UI surface, so there is no journey to draw. Do NOT write a journey or
a sidecar. Instead:

1. Append a short `## Design (pulado)` note to the card body explaining WHY —
   `storyType: <type>` has no UI surface, so the design columns don't apply (the work is
   proven later by the test suite + code-review lenses, not an E2E/visual sweep).
2. Move the card forward with `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts" <board> <id>` (board-aware: the resolver
   skips the remaining design columns toward Plano técnico). Bump `updated`.
3. Report that the card was forwarded (no journey, storyType has no UI surface) and STOP.

Only a `storyType: user` card runs the full workflow below.

## Workflow

1. **Locate the board + card.** Read `board.yaml` (package + the `design-ux` status entry
   — note its `autorun` flag) and the card: `narrative`, `acceptance`, the `## Entrevistas
   (3 usuários)` synthesis (the validated discovery), `personas`, `systems`, plus the plan
   sidecar `plans/<id>.md` if present. **If the sidecar `wireframes/<id>.json` already
   exists, ALSO read its `feedback[]`**: every entry with `kind: "change"` and
   `resolvedAt: null` is the human's brief for THIS re-run — a canvas-wide entry
   (`artifactId: null`) usually questions the FLOW itself; honor it in the journey below.
   Do NOT stamp `resolvedAt` — harness-ui stamps it once, at the end of the threaded design
   pass that incorporated everything (a crash before the stamp just re-applies the
   feedback next run; benign, don't "fix" it).

2. **Think the JOURNEY (UX DISCOVER).** Frame the JTBD from the persona's
   jobs/pains/gains and the interview synthesis. Then design the **flow of use** — the
   sequence of steps/states the user passes through to get the job done; the entry points
   (where in the app they arrive from); the decision/branch points; the error/empty paths;
   and the exit (where they go next). Crucially, situate it in the REST of the app: which
   existing screens/nav it plugs into, what it reuses, where it hands off. Validate the flow
   against the card's `acceptance` (every criterion must be reachable in the flow) and the
   interview must-haves. **Reason about the PATH, not the pixels — do NOT draw screens.**

3. **Write the `journey` block** into `wireframes/<id>.json` (via Write/Edit — never shell
   echo). Keep any existing `options[]`/`artifacts[]`/`feedback[]`/`chosenOptionId` intact
   (in refine/fix the sidecar may already exist). Shape (source of truth: `WireframeJourney`
   in `packages/storymap-ui/src/lib/storymap/types.ts`):
   ```json
   {
     "cardId": "<id>",
     "status": "draft",
     "chosenOptionId": null,
     "generatedBy": "harness-ux",
     "updated": "YYYY-MM-DD",
     "journey": {
       "format": "graph",
       "graph": {
         "nodes": [
           { "id": "entra", "label": "Entra pelo feed", "kind": "start" },
           { "id": "tem", "label": "Tem eventos salvos?", "kind": "decision" },
           { "id": "lista", "label": "Vê a lista agrupada por dia", "kind": "step", "note": "reusa o padrão do feed" },
           { "id": "vazio", "label": "Estado vazio + CTA de descoberta", "kind": "error" },
           { "id": "detalhe", "label": "Abre o detalhe do evento", "kind": "end" }
         ],
         "edges": [
           { "from": "entra", "to": "tem" },
           { "from": "tem", "to": "lista", "label": "sim" },
           { "from": "tem", "to": "vazio", "label": "não" },
           { "from": "lista", "to": "detalhe" }
         ]
       },
       "narrative": "Texto livre PT-BR: como o usuário CHEGA (de onde no app), NAVEGA (passo a passo) e USA a feature; como ela se encaixa no resto do app (nav, telas vizinhas, reuso); e os caminhos de erro/vazio. Ancore em JTBD + entrevistas.",
       "generatedBy": "harness-ux",
       "updated": "YYYY-MM-DD"
     },
     "options": [],
     "artifacts": [],
     "feedback": []
   }
   ```
   - **`graph` is the CURRENT format** — the app renders it as a real SVG diagram and derives
     the text projection by CODE (do NOT author a `flow` string). Node `kind` ∈ `start` |
     `step` | `decision` | `error` | `end`; short labels (they are box text), `note` for a
     one-line annotation; edge `label` for branch answers ("sim"/"não"). Keep it 5-20 nodes —
     the journey's spine, not a screenmap. `mermaid`/`ascii` remain ACCEPTED as legacy
     (rendered as raw text source), but never author them for a new journey.
   - **SELF-CHECK (obrigatório): after the Write, re-read the JSON and verify every edge
     `from`/`to` matches an existing node `id`, no duplicate node ids, no self-loops.** The
     app never repairs silently — a dangling edge surfaces as a visible ⚠ warning at the human
     approval stop, in the diagram AND in every text projection. Fix until clean, THEN advance.
   - **`narrative`** = the free-text explanation the human reads to judge the flow: entry
     points, step-by-step usage, fit with the rest of the app, edge paths.
   - **Voz — cascata única de precedência**: ① `voice.lexicon`/`principles` do guia de estilo
     do board (`storymap/boards/<board>/design/style-guide.md`, quando `board.yaml` tiver
     `styleGuide:`) → ② o brandbook do app → ③ convenção genérica urbano-sofisticada; nunca
     `rolê`/`zap`/"o que rola". Precedência anti-duas-fontes: microcopy de interface
     (labels/CTAs/empty-states da narrativa) segue o `voice` do guia quando existir; copy
     longa/mensageria/marketing segue o brandbook.

4. **Advance to Telas (harness-ui inherits this session).** Do NOT set `wireframeChosen` —
   there is no screen yet; harness-ui sets it. Bump `updated`. Then run:

   ```
   bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts" <board> <id>
   ```

   (same `<board>`/`<id>`). On `storymap` this moves `design-ux → design-ui`. Because the
   Design column threads the session, the harness-ui run that fires next RESUMES this one — so it
   already has the journey + your reasoning in context (it also re-reads the `journey` block
   as the durable record). NEVER hand-edit `status:`.

5. **Report.** State the journey written (a 1-line summary of the flow), the sidecar path,
   and that the card moved `design-ux → design-ui`. In queue mode, summarize each card.

## Modo refino (mode: refine) / correção (mode: fix)

If the card carries `mode: refine` or `mode: fix`, the feature ALREADY EXISTS — the journey
is a DELTA over today's flow, not greenfield:

- Read the `## Refino` / `## Bug` diagnosis (the upstream harness-refine/harness-fix), the sidecar's
  unresolved `feedback[]` (step 1), and, if present, the live state in `refine/<id>/` or
  `bugs/<id>/`.
- Write the journey as the CHANGE to the current flow — what path is added/removed/fixed — and
  justify it against the existing behaviour. The rest (advance to Telas) is identical.

### Guardrails

- NO screens here — only the flow graph + narrative. Screens are harness-ui's job.
- Never set `wireframeChosen` / never advance past `design-ui` — harness-ui owns the canvas + the
  `hasWireframe` gate.
- Always write a non-empty `journey` (graph OR narrative) before advancing — harness-ui needs it.
- KEEP `options[]`/`artifacts[]`/`feedback[]` intact — you own ONLY the `journey` block; never
  stamp `resolvedAt` (harness-ui does, once, at the end of the design pass).
- Advance ONLY via `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts"`; never hand-edit `status:`; never rename the card id.
