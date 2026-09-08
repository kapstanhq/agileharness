---
name: harness-plan
description: >-
  AgileHarness automation that writes the TECHNICAL PLAN for a ready story and — on the
  canonical pipeline — decomposes the TASKS in the SAME run. Reads a card in status
  `plano-tecnico` from storymap/boards/<board>/cards/<id>.md, writes a concrete
  implementation plan to the sidecar storymap/boards/<board>/plans/<id>.md (files to
  touch, approach, contracts, risks, test outline), sets techPlanReady: true, and — when
  the board has NO separate Tarefas step (canonical pipeline) — also decomposes the
  acceptance criteria into tasks[] ({id,title,done:false}) so the build inherits both
  from one context. Then advances board-aware via advance-card: `plano-tecnico` ->
  `desenvolver` (canonical) or `plano-tecnico` -> `quebrar-tasks` (product boards, where
  harness-tasks still decomposes). With no id it processes the whole `plano-tecnico` queue.
  Use when the user says "/harness plan", "/harness-plan", "plano técnico", "planejar story",
  "quebrar em tasks", "gerar tasks", or wants to advance AgileHarness cards sitting in Plano
  & Tarefas. Edits ONLY storymap data files (the card .md + the plans/ sidecar) — never
  product code, never the storymap-ui package.
triggers:
  - /harness plan
  - /harness-plan
  - plano técnico
  - planejar story
  - planejar card
  - quebrar em tasks
  - gerar tasks
  - usm plan
---

# /harness-plan — AgileHarness: technical plan (+ tasks on the canonical pipeline)

The `harness-plan` trigger automation. It turns a prioritized, designed story into a concrete
**technical plan**, and — on the canonical pipeline (the `storymap` board) — also the
**tasks[]** in the SAME run, so the same mind that investigates the code and decides the
approach decomposes the work too (no second context reload, no plan→tasks handoff drift).
It then advances the card board-aware.

> **Board-aware — decide by the PIPELINE, NEVER by the board name.** Whether you decompose tasks in
> this run hinges on ONE fact: does THIS board's *resolved* pipeline have a separate `quebrar-tasks`
> step? Read `board.yaml` (respecting `inheritPipeline`) and CHECK — do not assume from the board's name.
> - **NO `quebrar-tasks` step (canonical — `boards/_base`, inherited by default; e.g. `demo`)** →
>   `harness-plan` produces plan **and** tasks in this SAME run, then advances `plano-tecnico -> desenvolver`
>   (gate **hasTasks**). Flipping to `desenvolver` with `tasks` empty is REJECTED by that gate, so the
>   card stalls in `plano-tecnico` until ≥1 task exists. This is the common case.
> - **HAS a `quebrar-tasks` step (`inheritPipeline: false` — the opt-out; e.g. `demo-legado`)** → `harness-plan`
>   writes ONLY the plan and advances `plano-tecnico -> quebrar-tasks` (gate hasTechPlan); the separate
>   `harness-tasks` step decomposes there. Fase 5 migrates these to canonical.
>
> ⚠️ **A board that LOOKS like a "product board" may be CANONICAL** (it inherits `_base` and has NO
> `quebrar-tasks` step) → you MUST decompose its `tasks[]` in this run, like any canonical board.
> Treating such a board as a 2-step "product board" leaves `tasks: []`, so `advance-card` correctly
> BLOCKS at the hasTasks gate (exit 1) and the card gets stuck in Plano & Tarefas. Only a board that
> declares `inheritPipeline: false` is 2-step. When in doubt, `grep quebrar-tasks board.yaml`.

> Read `storymap/README.md` first — canonical schema/pipeline. This skill edits ONLY
> storymap data: the card under `storymap/boards/<board>/cards/<id>.md` and the plan
> sidecar `storymap/boards/<board>/plans/<id>.md`. NEVER touch product code or
> `packages/storymap-ui/`. Permission mode: acceptEdits.

> **Espaço da solução — o plano TEM autoridade.** O corpo do card ("Contexto & valor") +
> `narrative` + `acceptance` são o **espaço do problema** (negócio/domínio; dono: PO/`harness-enrich`).
> O plano que você escreve é o **espaço da solução** e é LIVRE para contrariar o card (INVEST
> "Negotiable"): se a melhor implementação diverge do que o corpo sugere, decida pela técnica e
> registre o porquê no plano. Todo detalhe de implementação — arquivos, funções, tipos, libs,
> ordem das tasks, riscos técnicos — vive AQUI (no `plans/<id>.md`), NUNCA de volta no corpo do
> card. Leia o corpo como contexto de negócio, não como especificação técnica.

## Input

```
/harness-plan <board>/<id>       # plan (+ tasks) for one card (e.g. demo/story-busca-por-titulo)
/harness-plan                    # no id = process the ENTIRE `plano-tecnico` queue
```

With **no argument**, scan `storymap/boards/*/cards/*.md` and process every card whose
`status` is `plano-tecnico`, board-by-board, in file order. If an explicit id is given
but the card is NOT in `plano-tecnico`, report its status and stop.

## Workflow

1. **Locate the board + card + detect the pipeline shape.** Read
   `storymap/boards/<board>/board.yaml` to map `package:` → the codebase this story
   targets, AND to see whether the board has a separate `quebrar-tasks` step. Read the
   card; note its `title`, `narrative`, `acceptance`, `personas`, `systems`.
   - **No `quebrar-tasks` step (canonical)** → you will write plan **and** tasks (steps 4+5).
   - **Has a `quebrar-tasks` step (product boards)** → you write ONLY the plan (step 4);
     `harness-tasks` decomposes next. Skip step 5.

2. **Confirm the slot.** The card must be `status: plano-tecnico`.

3. **Investigate the real code — oriente via graphify ANTES, depois leia.** Ground the
   plan in reality. Este step roda com o **MCP graphify** (knowledge graph do código do
   pacote-alvo, carregado pela `mcpConfig` da coluna). Para ORIENTAÇÃO — quais módulos/
   rotas/componentes/funções a story toca, o que chama/importa um símbolo, o impacto de
   mudar um arquivo — **consulte o grafo PRIMEIRO** (`mcp__graphify__query_graph`/
   `get_neighbors`/`shortest_path`/`get_pr_impact`): ~120 tok/query vs milhares num
   grep+read amplo, e mais preciso. SÓ ENTÃO abra os arquivos que o grafo apontou, para
   ler o conteúdo exato que vai planejar (assinaturas, padrões a reusar). Read-only — do
   NOT modify any product code here.
   - **Contrato compartilhado (guard de paralelismo, custo ~zero).** Se a story toca um schema/contrato
     COMPARTILHADO (um `*Schema.ts`, um tipo/record exportado que outras fatias consomem), liste no plano
     AS OUTRAS fatias/stories que tocam o MESMO arquivo e CRAVE o contrato canônico — os nomes e o CASING
     EXATOS dos campos (camelCase, ADR-011). Runs paralelos que escrevem o mesmo dado com casing divergente
     (`generos` vs `Generos`) passam cada teste isolado mas QUEBRAM em produção (regressão real já
     observada). O grafo (`get_pr_impact`/`get_neighbors`) mostra quem mais importa o símbolo — use-o para achar
     as fatias concorrentes; não construa gate de merge, só ancore o contrato no plano.

4. **Write the plan sidecar** `storymap/boards/<board>/plans/<id>.md` (Markdown):
   - **Objetivo** — one paragraph tying the plan to the acceptance criteria.
   - **Arquivos a tocar** — concrete repo-relative paths + what changes in each.
   - **Abordagem** — the implementation strategy, key decisions, patterns reused.
   - **Contratos/interfaces** — new/changed types, API shapes, Firestore fields
     (camelCase, ADR-011), function signatures.
   - **Riscos & mitigações** — gotchas, perf/security/compat concerns.
   - **Ordem das tasks** — the sequence the tasks follow, for TDD (red→green).
   - **Plano de teste (resumo)** — which layers (unit/integration/journey/e2e) cover
     which acceptance criterion (defer the full plan to `/harness-tests`).

5. **(Canonical pipeline only) Decompose the tasks[] in this run.** Derive an ordered set
   of technical `tasks`, each `{ id, title, done: false }`, COVERING every acceptance
   criterion, sequenced per the plan's "Ordem das tasks":
   - `id` is a short stable token unique within the card (`t1`, `t2`, …).
   - `title` is an imperative, technical step in PT-BR (e.g. "Autenticar via Firebase Auth
     nativo (signInWithCustomToken) single-origin"). ALWAYS write it as a DOUBLE-QUOTED YAML scalar —
     `title: "…"` — escaping any internal `"` as `\"`. Task titles routinely contain `:`,
     parentheses and symbols, and an UNQUOTED title with a `: ` (colon + space) is parsed
     by YAML as a nested mapping → it CORRUPTS THE ENTIRE FRONTMATTER (the card then fails
     to parse, `status` reads null, the card drops out of its column). Quoting is mandatory.
   - Start every task `done: false` — the field the `hasTasks` gate checks (`tasks.length
     >= 1`). Keep one task per line for clean diffs.
   - **On a product board (has `quebrar-tasks`): SKIP this step** — leave `tasks` empty;
     `harness-tasks` decomposes there.

6. **Mark + advance (board-aware, never hardcode the next status).** Add `techPlanReady:
   true` to the frontmatter (and, on the canonical pipeline, the `tasks` array with ≥1
   item — written BEFORE the status flip so the `hasTasks` gate of `desenvolver` is met).
   Bump `updated` to today. Then run:

   ```
   bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts" <board> <id>
   ```

   (same `<board>`/`<id>`). The helper moves the card to the NEXT step of THAT board's
   pipeline — `plano-tecnico -> desenvolver` (canonical, gate hasTasks) or `plano-tecnico
   -> quebrar-tasks` (product boards, gate hasTechPlan) — reusing `nextBuildStatus` +
   `checkGate`, so the skill never names a status.

   **Read advance-card's message + exit code — it tells you EXACTLY what to do; never guess.** The
   message prints to stdout and the exit code is honest (it reflects whether the write actually landed):
   - **exit 0** — advanced (or `sem avanço` at a terminal). Done.
   - **exit 1 — BLOQUEADO**: the gate one step ahead is unmet. On a CANONICAL board that means
     `tasks` is empty → **decompose the tasks in THIS run** (step 5) and re-run advance-card; do NOT
     run a separate skill (there is no `harness-tasks` step here). The gate message names the missing field.
   - **exit 3 — decidiu avançar mas NÃO persistiu**: a concurrent write changed the card between the
     read and the write. Re-read the card and re-run advance-card.
   - This tool is NEVER swallowed by the sandbox — the read-only sandbox freezes only `node_modules` +
     the bun store, NOT `storymap/boards/**`. If a status change "didn't take", it's the gate or a race
     (read the message), never a discarded write. Do NOT hand-edit `status:` and do NOT burn turns
     hypothesizing about the sandbox.

7. **Report.** State the plan path, the files it targets, the tasks created (canonical) or
   "deferred to harness-tasks" (product), and the advance result. In queue mode, summarize each.

### Guardrails

- Read-only on product code — the plan is a document, the tasks are data; no implementation.
- Canonical pipeline: NEVER flip to `desenvolver` while `tasks` is empty — the `hasTasks`
  gate (and the `validate-storymap-gate` hook) rejects it. Write plan + tasks (≥1) FIRST.
- Always double-quote task titles (a `: ` in an unquoted title corrupts the frontmatter).
- Keep the plan concrete and short; `harness-do` reads it (+ the tasks) as its build brief.
- **Rota subdimensionada (WS4 furo #1):** se ao planejar você perceber que a ROTA do card ficou
  pequena demais — ex.: um card em perfil `express` que na verdade tem superfície de UI real que
  precisaria do bloco de design — levante um finding `{ lens: "general", severity: "medium",
  title: "route-undersized: …" }` com a recomendação (reabrir com rota mais completa ou ajustar via
  `set_card_route`). Aviso, não bloqueia — o humano decide o reopen.
