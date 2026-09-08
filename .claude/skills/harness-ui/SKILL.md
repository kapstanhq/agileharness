---
name: harness-ui
description: >-
  AgileHarness automation that BUILDS the design CANVAS for a story FROM its usage
  journey. Reads a card in status `design-ui` from storymap/boards/<board>/cards/<id>.md
  — AFTER harness-ux wrote the `journey` block in the sidecar
  storymap/boards/<board>/wireframes/<id>.json, and (because the Design column threads the
  session) with that journey already in context — and freely composes the artifacts that
  transmit the design idea: the SCREENS that realize the flow (key UI states), reusable
  COMPONENTS worth calling out, sub-FLOWS and NOTES, in `dsl` (default) or simplified
  sandboxed `html` (when fidelity pays), grounded in the app's UI conventions (package
  components + any `*-ui-aesthetics` skill). It writes them to `artifacts[]`, incorporates
  any unresolved human `feedback[]` (preserving approved artifacts VERBATIM, stable ids),
  sets the PRIMARY screen (`chosenOptionId` + `wireframeChosen` on the card, satisfying the
  hasWireframe gate), and advances `design-ui` -> `com-design`. Only `user` stories have a
  UI surface — technical/chore/spike/bug short-circuit forward. With no id it processes the
  whole `design-ui` queue. Use when the user says "/harness ui", "/harness-ui", "telas da story",
  "wireframes", "desenhar as telas", or wants to advance AgileHarness cards sitting in Telas.
  Edits ONLY storymap data files — never product code, never storymap-ui.
triggers:
  - /harness ui
  - /harness-ui
  - telas da story
  - wireframes
  - desenhar as telas
  - usm ui
---

# /harness-ui — AgileHarness: the design canvas from the journey (design-ui → com-design)

The `harness-ui` trigger automation. It turns the **journey** harness-ux wrote (the user flow) into
a **design canvas** — the artifacts that best TRANSMIT the design idea: screens with their
key states, components worth naming, sub-flows, notes. You are NOT limited to N antagonistic
variants with a single winner: compose freely; the human reacts PER ARTIFACT (approve ·
request change · switch primary) at the next stop (`com-design`). It runs IN THE SAME
SESSION as harness-ux (the Design column threads it), so it already knows the flow + the
reasoning behind it; it also reads the `journey` block as the durable record.

> Read `storymap/README.md` first. This skill runs AFTER harness-ux wrote the `journey` block.
> It edits ONLY storymap data: the card .md and the sidecar
> `storymap/boards/<board>/wireframes/<id>.json` (it writes `artifacts[]` + sets
> `chosenOptionId`; it keeps the `journey` block intact). NEVER touch product code or
> `packages/storymap-ui/`. Permission mode: acceptEdits.

## Input

```
/harness-ui <board>/<id>         # canvas for one card
/harness-ui                      # no id = process the ENTIRE `design-ui` queue
```

The card must be `status: design-ui`. With no id, process every `design-ui` card,
board-by-board, in file order. If an explicit id is given but the card is NOT in `design-ui`,
report its status and stop.

## Short-circuit: non-`user` stories have no UI

Read `storyType` first. For `technical`/`chore`/`spike`/`bug` there is no UI to draw: append a
short `## UI (pulado)` note (storyType has no UI surface), advance with `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts"
<board> <id>` (it forwards toward Plano técnico), and STOP. Only a `storyType: user` card runs
the full workflow.

## Workflow

1. **Locate the board + card + journey + feedback.** Read `board.yaml` (package + the
   `design-ui` entry + the board's `personas`). Read the card (`narrative`, `acceptance`, the
   `## Entrevistas` synthesis, `personas`). Read the sidecar's **`journey` block** — the flow
   graph + narrative harness-ux wrote — that is your brief. If `journey` is missing, harness-ux didn't
   run: report and STOP (there is no flow to realize). Read **`feedback[]`** too: entries with
   `kind: "change"` and `resolvedAt: null` are the human's pending requests for THIS pass.

2. **Gather the UI grounding.** Pull the inputs that make the artifacts concrete:
   - **The journey** — every step/branch/state in the flow graph becomes a screen (or a state
     of one). Cover the path end to end (entry, steps, empty/error, exit). Link each screen to
     the flow node it realizes via `journeyRef: "<nodeId>"`.
   - **Interview synthesis + personas** — the must-haves/dores drive what each screen must show
     and prioritize.
   - **Grounding de estilo — cascata única de precedência**: ① o guia de estilo do board
     (`storymap/boards/<board>/design/style-guide.md`, quando `board.yaml` tiver `styleGuide:`)
     → ② a skill `*-ui-aesthetics` do app (60/30/10, depth, anti-patterns) → ③ derive dos
     componentes existentes (`src/components/**` — cards, chips, modais…) — nunca invente uma
     linguagem visual nova. A `note` do artefato primário cita `guia v{N}` (+ os papéis de
     cor/tipografia relevantes) quando o board tiver guia — é o que torna o consumo verificável
     (D14).

3. **Compose the canvas** into `artifacts[]` of `wireframes/<id>.json` (via Write/Edit — never
   shell echo; KEEP the `journey` block intact). Each artifact (source of truth:
   `DesignArtifact` in `packages/storymap-ui/src/lib/storymap/types.ts`):
   ```json
   {
     "cardId": "<id>",
     "status": "chosen",
     "chosenOptionId": "tela-agenda",
     "generatedBy": "harness-ui",
     "updated": "YYYY-MM-DD",
     "journey": { "…": "o bloco do harness-ux, INTACTO" },
     "options": [],
     "artifacts": [
       {
         "id": "tela-agenda",
         "kind": "screen",
         "title": "Agenda agrupada por dia",
         "note": "1-2 linhas: como esta tela realiza a jornada + os componentes REAIS que reusa (guia v2)",
         "format": "dsl",
         "viewport": "mobile",
         "state": "populated",
         "journeyRef": "lista",
         "dsl": { "type": "screen", "children": [ { "type": "appbar", "props": { "leading": "back", "title": "Perfil" } } ] }
       },
       {
         "id": "tela-agenda-vazia",
         "kind": "screen",
         "title": "Agenda vazia — convite a descobrir",
         "note": "reusa o empty state existente",
         "format": "dsl",
         "viewport": "mobile",
         "state": "empty",
         "journeyRef": "vazio",
         "dsl": { "type": "screen", "children": [] }
       },
       {
         "id": "comp-card-evento",
         "kind": "component",
         "title": "Card de evento (compartilhar sempre visível)",
         "note": "espelha o EventRow do feed — sem extrair componente cross-package",
         "format": "dsl",
         "viewport": "mobile",
         "dsl": { "type": "card", "children": [] }
       },
       {
         "id": "nota-decisoes",
         "kind": "note",
         "title": "Decisões de design",
         "format": "text",
         "content": "• hierarquia por peso, não por cor (guia v2 p3)\n• filmes em seção própria"
       }
     ],
     "feedback": [ { "…": "as entradas existentes, com resolvedAt carimbado no fim do passe" } ]
   }
   ```
   **Kinds** — `screen` (telas do fluxo, com `state` populated/empty/loading/error e
   `journeyRef`), `component` (uma peça reusável que merece destaque próprio), `flow` (um
   SUB-fluxo em `format: "graph"` — a jornada principal vive no bloco `journey`, nunca aqui),
   `note` (racional/decisões em texto). Telas e notas carregam o peso; componentes/fluxos só
   quando agregam de verdade.

   **Formats & custo de token**:
   - **`dsl` é o DEFAULT** (barato, low-fi consistente): a árvore semântica de
     `PRIMITIVE_SPECS` (`packages/storymap-ui/src/lib/storymap/wireframe-dsl/types.ts`) —
     containers `screen`/`stack`/`row`/`section`/`card`/`grid`/`list`; conteúdo `appbar`/
     `tabbar`/`listItem`/`text`/`button`/`input`/`image`/`avatar`/`chip`/`icon`/`divider`/
     `spacer`/`placeholder`. O renderer garante o alinhamento; a projeção de texto é DERIVADA
     (nunca escreva `content` para dsl).
   - **`html`** (só quando a fidelidade paga — layout que a DSL não expressa): um FRAGMENTO de
     body simplificado, estilos inline/`<style>` permitidos. Sem scripts, sem URLs externas,
     sem `src`/`href` — tudo isso é REMOVIDO no render (sandbox + CSP + sanitizador); imagem =
     div estilizada. Custo ~2-4× o dsl; mire ≤ ~10KB por artefato (cap DURO de 32KB — acima
     disso o html é descartado e sobra só a projeção de texto). `format: "html"` EXPLÍCITO,
     nunca inferido.
   - **`graph`** (kind flow): mesmo shape do `journey.graph`. **`text`**: `content` livre.
   - **Orçamento TOTAL do canvas: ~8-10 artefatos / ~50KB.** Estados são artefatos só quando
     KEY (populated + os alternates que o acceptance toca) — não 4 estados × cada tela.
   - Variantes ANTAGÔNICAS não são mais obrigatórias. Quando uma alternativa genuinamente
     ajudar a decisão, adicione-a como tela irmã com a comparação na `note` — sem campos
     legados `label`/`direction` (são das `options[]` antigas; num artifact seriam dropados).

4. **Incorporate feedback (re-runs / refine / fix) — the preservation invariant.**
   - Artifact WITHOUT unresolved change-feedback → **copy VERBATIM, SAME id** (never re-mint
     ids: the human's threads anchor on them). Prefer surgical Edit of the JSON over rewriting
     the file — preserved artifacts should cost ~0 output tokens.
   - Artifact WITH unresolved change-feedback (`kind: "change"`, `resolvedAt: null`) → rework
     THAT artifact honoring the note; canvas-wide entries guide the whole pass.
   - At the END of the pass, stamp `resolvedAt: "YYYY-MM-DD"` on every change entry you
     incorporated (you are the ONE owner of the stamp — harness-ux never stamps). Entries you
     could NOT honor: leave unresolved and say why in a `note` artifact.

5. **Pick the primary + advance.** Set `chosenOptionId` to the strongest SCREEN artifact
   (justify in its `note` by JTBD + how faithfully it realizes the journey) and set
   `wireframeChosen: <artifactId>` on the card — this satisfies the `hasWireframe` gate of
   `com-design`. Bump `updated`. Then run:

   ```
   bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts" <board> <id>
   ```

   (same `<board>`/`<id>`) → `design-ui → com-design`, where the human approves the journey +
   canvas together. If `advance-card` exits non-zero, `wireframeChosen` wasn't written — fix and
   re-run. NEVER hand-edit `status:`.

6. **Report.** List the artifacts (kind + title + states covered), the primary, the sidecar
   path, and the advance result. In queue mode, summarize each card.

## Modo refino (mode: refine) / correção (mode: fix)

If the card carries `mode: refine`/`fix`, the screen ALREADY EXISTS — the canvas is a DELTA
over what's live (read the journey delta harness-ux wrote + the `## Refino`/`## Bug` diagnosis +
the unresolved `feedback[]`): `fix` RESTORES the visual language; `refine` may evolve it
(note which tokens + cross-app impact; a conservative brief = polish the existing artifacts,
an aggressive brief = redesigned screens alongside, compared in `note`). The rest
(preservation invariant, set wireframeChosen, advance) is identical.

### Guardrails

- The journey is the BRIEF — every screen must realize a step/state of harness-ux's flow
  (`journeyRef` names the node; a ref that doesn't resolve shows a visible warning).
- Reuse over invention — every screen cites a real existing component/token of the app.
- KEEP the `journey` block intact; you write `artifacts[]` (+ stamp feedback) — never drop
  the flow, never drop `options[]` that already exist (legacy docs stay readable).
- NEVER re-mint the id of a preserved artifact; NEVER delete a feedback entry.
- Set `wireframeChosen` (the hasWireframe gate is yours now); advance ONLY via
  `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts"`; never hand-edit `status:`; never rename the card id.
