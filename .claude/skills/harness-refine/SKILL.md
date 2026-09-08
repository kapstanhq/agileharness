---
name: harness-refine
description: >-
  AgileHarness automation that TRIAGES a refinement of an already-shipped story. Reads
  a card in status `refinar` (mode: refine) from
  storymap/boards/<board>/cards/<id>.md, DIAGNOSES the live implementation that the
  story shipped (which files/components/routes exist TODAY) grounded in the human
  `refinement.brief` + `kinds`, rewrites `acceptance` as a DELTA over current
  behaviour, infers the intensity (conservative polish ↔ aggressive redesign) from
  the brief, then ROUTES the card to the right entry column — UI/UX generates new
  low-fi options and lands in `design-ux`; copy/functionality lands in
  `desenvolver`. It keeps `mode: refine` on the card so every downstream harness-* skill
  improves IN-PLACE instead of recreating from scratch. With no id it processes the
  whole `refinar` queue. Use when the user says "/harness refine", "/harness-refine",
  "refinar story", "triagem de refino", "diagnosticar melhoria", or wants to advance
  AgileHarness cards sitting in Refinar. Edits storymap data (the card .md + the
  wireframes/ sidecar); reads product code READ-ONLY to diagnose — never writes it.
triggers:
  - /harness refine
  - /harness-refine
  - refinar story
  - triagem de refino
  - diagnosticar melhoria
  - usm refine
---

# /harness-refine — AgileHarness: refine triage (refinar → design-ux | desenvolver)

The `harness-refine` trigger automation. When a story in `revisao` (human QA) or
`concluida` (shipped) is reopened for improvement via the **Refinar** button, the card lands in `refinar` carrying
`mode: refine` + a `refinement` brief. This skill grounds the refinement in the REAL
current implementation, respecs the change as a delta, and routes the card into the
pipeline so the existing mode-aware skills (`harness-ux`, `harness-do`, `harness-review`) finish
the job — improving what exists, never rebuilding it.

> Read `storymap/README.md` first (schema + the refine flow). This skill edits ONLY
> storymap data — the card `.md` and the wireframe sidecar
> `storymap/boards/<board>/wireframes/<id>.json`. It reads PRODUCT code READ-ONLY to
> diagnose (grep/read/git log) and NEVER writes product code (`harness-do` does that
> later, in refine mode). Permission mode: dangerously-skip-permissions (it runs
> read-only Bash for diagnosis).

## Reabertura R1 — você roda na coluna de DESTINO escolhida pelo operador

A reabertura por **Refinar** NÃO estaciona mais o card numa coluna `refinar`: o operador
escolhe o DESTINO (`enriquecer` / `design-ux` / `desenvolver`) e o card pousa lá direto
carregando `mode: refine` + `refinement` + a flag **one-shot `reopenPending: true`**. A
cascata roda VOCÊ (harness-refine) nessa coluna, sobrepondo a skill normal dela — só nesta
PRIMEIRA passada. Seu contrato muda só no fim:

1. Faça o diagnóstico / respec do delta como sempre (passos abaixo), ancorado no destino
   que o operador escolheu (ele já decidiu por onde o refino entra).
2. No fim, **LIMPE `reopenPending`** (remova o campo) e **MANTENHA `mode: refine`** — NÃO
   avance o card de coluna manualmente. Ao limpar a flag, a próxima avaliação da cascata
   roda a skill PRÓPRIA da coluna (`harness-ux` em `design-ux`, `harness-do` em `desenvolver`,
   `harness-enrich` em `enriquecer`) já ciente do `mode: refine`. **Se você esquecer de limpar
   `reopenPending`, o override re-dispara harness-refine em loop** — limpá-la é obrigatório.
3. `mode: refine` segue até o `harness-qa` (a ÚNICA estação que o limpa), igual ao canônico.

> Caminho legado: um card que JÁ esteja em `status: refinar` (sem `reopenPending`) você
> processa como antes — diagnostica e ROTEIA para `design-ux` | `desenvolver`. A coluna
> `refinar` continua existindo (trigger harness-refine); só não recebe cards novos pela ação.

## Input

```
/harness-refine <board>/<id>     # triage one refinement
/harness-refine                  # no id = process the ENTIRE `refinar` queue
```

The card must be `status: refinar` with `mode: refine` and a non-empty
`refinement.brief` (the Refinar action guarantees this).

## What you are given (on the card)

- `refinement.brief` — the human's free-text feedback: WHAT to improve and WHY. The
  **intensity** lives here too — words like "ajustar/polir" → conservative; "repensar
  / do zero / redesenhar" → aggressive. Infer it; do not ask.
- `refinement.kinds` — one OR MORE of `ui` | `ux` | `copy` | `functionality`. Drives routing
  (precedence below) and the deep-skill roster (load it for EVERY selected kind).
- `refinement.target` — an optional route/screen hint.
- `refinement.screenshot` — an optional current-state image under `refine/<id>/`.
- The story's EXISTING `narrative`, `acceptance`, `personas`, `systems` — shipped
  work; the baseline you improve, not a blank slate.
- The story's EXISTING `tasks` (and the plan sidecar `plans/<id>.md`, if any) describe
  the work ALREADY BUILT (typically all `done: true`) — they do NOT describe the delta.
  Step 4 reconciles them so a downstream build never re-runs stale build tasks.

## Workflow

1. **Locate + read.** Read `board.yaml` (the `package:` whose code shipped this
   story) and the card. Read the screenshot sidecar if present.

2. **Diagnose the LIVE implementation (read-only).** Run the canonical diagnosis —
   **`@.claude/skills/harness-triage-shared/DIAGNOSIS.md`** (Grep/Read/`git log` over
   `packages/<pkg>/` to pin the routes/pages/components/server actions/flow to real
   files; "presença de código ≠ shipped"; ANTÍDOTO a recriar do zero).
   **Oriente via graphify ANTES de grep/read.** Este step roda com o **MCP graphify**
   (knowledge graph do código do pacote-alvo, carregado pela `mcpConfig` da coluna).
   Para MAPEAR o que a story shipou — quais rotas/páginas/componentes/server actions
   compõem a feature, o que cada símbolo importa/chama, o raio de impacto de mexer nele —
   **consulte o grafo PRIMEIRO** (`mcp__graphify__query_graph`/`get_neighbors`/
   `shortest_path`/`get_pr_impact`): ~120 tok/query vs milhares num grep+read amplo, e
   mais preciso (sem o ruído de comentários do grep). SÓ ENTÃO abra os arquivos exatos que
   o grafo apontou, para ler o conteúdo que vai diagnosticar. Mantenha o diagnóstico
   READ-ONLY — graphify é orientação, não escrita. **Overlay de
   refino:** avalie o que foi achado contra o brief — o que exatamente é FRACO
   (layout/hierarquia, copy/voz, interação/estados, comportamento)?
   **Grounding do diagnóstico visual — cascata única de precedência (D13 canal 3)**: ①
   guia de estilo do board (`storymap/boards/<board>/design/style-guide.md`, quando
   existir) → ② skill `*-ui-aesthetics` do app → ③ componentes existentes. Quando o
   board tiver guia, use-o como o "esperado" e cite o TOKEN violado no diagnóstico (ex.:
   "CTA usa azul legado #4B76E8; guia define `primary` #FF4F00") — não platitude
   genérica.
   - Write a concise **`## Refino`** section into the card body capturing: the brief,
     the current-state diagnosis (key files + what's wrong), the inferred intensity,
     and the routing decision. Downstream skills read this as their starting point.

3. **Respec the `acceptance` DELTA + settle the PRIORITY.** Rewrite `acceptance` to express
   the IMPROVEMENT goals — the observable change you want over today's behaviour — not a
   re-derivation of the whole feature. Keep them verifiable (Gherkin recommended). Keep
   `narrative` unless the brief changes the intent. Keep `mode: refine`.

   **Priority (type-aware WSJF — see `storymap/frameworks.md` §4):**
   - **NEW melhoria** (came from the Triagem, no prior feature prioritization): set the leve
     melhoria axes — `rice.impact` (escala {0.25,0.5,1,2,3}) + `rice.effort` (> 0). These
     yield the melhoria's `priorityScore` in the unified backlog. Leave reach/confidence/
     kano/funnel unset (a melhoria isn't a feature).
   - **REOPENED refine** (the card already has the shipped feature's `rice`/`kano`/
     `funnelStage`): **PRESERVE** them untouched — the card keeps its original feature
     `priorityScore`. See the guardrail.

   This new `acceptance` is the source of truth the task reconciliation in step 4 derives from.

4. **Reconcile the artefacts, then route** (set `status`, same edit; STOP there — the
   target is a human-decision column, so the card waits, exactly as in build). The column
   you pick PLUS this reconciliation are what guarantee `acceptance` AND `tasks` describe
   the delta, not the old build. Load the deep-skill roster for EVERY kind in `kinds`
   (UI/UX → aesthetics + ux; copy → brandbook; functionality → dev/refactor) and
   pick the entry column by precedence (`IMPROVEMENT_KINDS[*].routeHint` in frameworks.ts is
   the per-kind default; a MIXED selection resolves visual-first, because design must
   precede build):
   - **any kind is `ui` or `ux`** → `status: design-ux`. The visual step comes first:
     generate refine-biased canvas artifacts now (wrap the repo's **UX skill** DISCOVER→DESIGN, like
     `harness-ux`/`harness-ui`) into `artifacts[]` of `wireframes/<id>.json` (keep existing
     `feedback[]` intact), **biased by intensity**: a conservative brief = polish the
     existing artifacts (small deltas, preserved ids, the delta named in each `note`); an
     aggressive brief = redesigned screens ALONGSIDE the current direction, compared in
     `note`, so the human judges the leap. **Tasks:** the implementation scope depends on
     the design the human will approve — do NOT guess it now; CLEAR the stale build tasks
     (`tasks: []`) and note in `## Refino` that the build re-derives them after the design
     is approved (`harness-do` refine mode does this). Fold any copy/functionality goals into
     `## Refino` + `acceptance` so the later build covers them too.
   - **otherwise (only `copy` / `functionality`)** → `status: desenvolver`. The scope is
     already known here, so **regenerate `tasks` now**: replace the old build tasks with new
     `{ id, title, done: false }` items covering ONLY the delta (`harness-do` then implements
     them; copy grounded in the brandbook). Note the target copy/behaviour in `## Refino`.
   - **Plan sidecar:** if the delta changes architecture/data/contracts (aggressive
     functionality or a `fresh-slate` redesign), flag in `## Refino` that `plans/<id>.md` is
     stale and the build must revisit it; a surgical refine needs no replan.
   **Why not route through `quebrar-tasks`/`priorizar`?** See the canonical rationale in
   **`@.claude/skills/harness-triage-shared/GUARDRAILS.md`** ("Por que não rotear por
   quebrar-tasks/priorizar") — those columns auto-run `harness-prioritize`, which would
   overwrite the already-decided `rice`/`kano`/`funnelStage`. Refine keeps the original
   prioritization and reconciles tasks IN-PLACE here instead.

   **Per-instance skip routing (`card.routing.skips`) — only for an AMBIGUOUS mixed-kind refine.**
   The cascade decides which steps a refine BYPASSES deterministically: a refine/fix always skips
   the discovery interview, and a refine whose `kinds` are purely text/behaviour (`copy`/
   `functionality`, NO `ui`/`ux`) also skips the whole design block — the rules live in
   `skip-routing.ts` and `pipeline-routing.ts` (`routeSkip`/`VISUAL_IMPROVEMENT_KINDS`), zero tokens,
   so you normally write NOTHING here. The ONE case the rules can't settle is a MIXED `kinds` (e.g.
   both `ui` AND `functionality`): there the design block may or may not be worth it for THIS
   instance. When you judge it (and only then), persist your verdict on the card as
   `routing: { skips: [<status ids>], decidedBy: agent, decidedAt: <YYYY-MM-DD> }` — the cascade reads
   it as AUTHORITATIVE (the pure kernel never calls a model; it reads your precomputed boolean). Skip
   the design steps when this mixed refine needs no new wireframe; leave `routing` unset to let the
   visual-first default keep the design block. NEVER set it on a clean single-kind refine — the rules
   already cover those.

5. **Report.** State: the diagnosis (current files + what's weak), the respec delta
   (`acceptance` + how you reconciled `tasks`: regenerated for build vs cleared for
   redesign), the inferred intensity, any stale-plan flag, and where you routed
   (`refinar → design-ux | desenvolver`). In queue mode, summarize each card.

### Guardrails

Os guardrails comuns de reabertura e o ciclo de vida do `mode` são canônicos em
**`@.claude/skills/harness-triage-shared/GUARDRAILS.md`** — leia-os: nunca recriar do zero ·
reconciliar as build tasks (nunca deixar vazar) · uma reabertura não re-prioriza a story
entregue · read-only no código de produto · **manter `mode: refine`** (quem o limpa é o
`harness-qa` em `qa-automatizado → revisao`, NÃO o `harness-review`) · não auto-executar escritas
de código · nunca tocar `packages/storymap-ui/`.

Específico do refino (overlay sobre os comuns):

- **Intensidade vem do brief.** "ajustar/polir" → cirúrgico (delta pequeno sobre os
  artefatos existentes, ids preservados); "repensar/do zero" → inclua telas redesenhadas ao
  lado das atuais, comparadas na `note`. A intensidade não é um campo — infira-a do texto,
  não pergunte.
- **Delta, não a feature inteira.** O `acceptance` reescrito expressa a MELHORIA sobre o
  comportamento de hoje (passo 3). Se a melhoria precisa de design, gere os wireframes aqui
  e CLEAR as build tasks; se é só copy/funcionalidade, regenere as tasks do delta.
