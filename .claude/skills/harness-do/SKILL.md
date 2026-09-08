---
name: harness-do
description: >-
  AgileHarness automation that implements a story with TDD by ORCHESTRATING specialist
  sub-agents. Reads a card in status `desenvolver` from
  storymap/boards/<board>/cards/<id>.md, classifies the work into concerns
  (DB / backend / frontend), delegates each present concern to a specialist
  sub-agent that works test-first in the SAME worktree (red → green → refactor),
  then integrates: runs the full suite itself, marks each task done:true, and
  advances the card `desenvolver` -> `revisar-codigo`. With no id it processes the
  whole `desenvolver` queue of every board. Use when the user says "/harness do",
  "/harness-do", "implementar story", "desenvolver card", "executar story", or wants to
  build an AgileHarness card sitting in Desenvolver. Edits storymap data files
  for status/tasks; touches product code only to implement.
triggers:
  - /harness do
  - /harness-do
  - implementar story
  - desenvolver story
  - desenvolver card
  - executar story
  - construir story
  - usm do
---

# /harness-do — AgileHarness: implement a story with TDD (desenvolver → revisar-codigo)

The `harness-do` trigger automation for the AgileHarness pipeline. It implements a
ready-to-build story from its tasks using TDD — as an **orchestrator** that
delegates each concern (DB · backend · frontend) to a specialist sub-agent,
then integrates their work, marks the tasks done, and advances the card into
`revisar-codigo` (where `harness-review` reviews + self-repairs).

> Read `storymap/README.md` first — it is the canonical schema/pipeline source.
> Testing: `.claude/rules/testing-philosophy.md` (fix-the-app, autonomous loop,
> never weaken assertions). This skill edits the card's status/tasks under
> `storymap/boards/<board>/cards/`; it touches PRODUCT code only to implement the
> story. NEVER touch `packages/storymap-ui/` unless that IS the story's target.

## When to Use

- A card sits in status `desenvolver` (the `harness-do` trigger column).
- The user runs `/harness do [<board>/<id>]` or `/harness-do [<board>/<id>]`.
- The user asks to "implementar", "desenvolver", or "executar" an AgileHarness story.

## Input

```
/harness-do <board>/<id>         # build one card (e.g. demo/story-recomendacao-email)
/harness-do                      # no id = process the ENTIRE `desenvolver` queue
```

- `<board>` = a folder under `storymap/boards/`.
- `<id>` = card id == filename without `.md`.
- With **no argument**, scan `storymap/boards/*/cards/*.md` and process every
  card whose `status` is `desenvolver`, board-by-board, in file order.

A card should reach `desenvolver` only AFTER passing every upstream gate
(`hasRefinement` → `hasPrioritization` → `hasWireframe` → `hasTechPlan` →
`hasTasks`), so it must already have a non-empty `acceptance`, complete `rice`
plus `kano`/`funnelStage`, a chosen wireframe, a tech plan, and non-empty `tasks`.
If those are missing, stop and route back (`/harness-enrich` → `/harness-prioritize` →
`/harness-ux` → `/harness-plan` → `/harness-tasks`) — the trigger only owns the `desenvolver`
slot and should not build an under-specified card.

## Workflow

1. **Locate the board + card.** Read `storymap/boards/<board>/board.yaml` (to map
   `package:` → which codebase to edit) and the target card. Note `acceptance`,
   `tasks`, `systems`, and the package the story belongs to.

2. **Confirm the slot.** The card must be `status: desenvolver`. (Queue mode:
   pick every card with that status.)

3. **(Optional) Plan tests.** If the card has no test tasks, consider running the
   `/harness-tests` plan first to derive the pyramid.

4. **Classify the work into concerns.** Read the card's `tasks[]` and the tech plan
   (`plans/<id>.md` if present) and sort the work into the concerns it actually
   touches — see **## Specialist sub-agents** below for the full method:
   - **DB** — Firestore schema/data shape, security rules, indexes (ADR-011 camelCase,
     named DBs, `firestore.rules`).
   - **backend** — server actions, Cloud Functions (`{app}_{domain}_{action}`), API
     routes, business logic.
   - **frontend** — React/Next.js components, pages, UI, client state.
   A card may involve 1, 2, or all 3. **Delegate only the concerns that are present.**

5. **Delegate to specialists (TDD inside each), DB → backend → frontend.** For each
   present concern, spawn a specialist sub-agent (per the table in **## Specialist
   sub-agents**) scoped to that concern's tasks + rules. Each works test-first
   (red → green → refactor) in the SAME worktree/branch and touches ONLY its concern's
   files. **Run them SEQUENTIALLY in that order — never in parallel** (the reasoning is
   in **## Specialist sub-agents**). After each specialist returns, mark its tasks
   `done: true` and **commit its slice** (test + impl + the `done: true`) before
   launching the next — small commits, card-id convention (see **## Commits
   incrementais**). For a trivial single-concern change, implement it directly instead
   of spawning a sub-agent.

6. **Integrate + verify (orchestrator).** After the specialists finish, YOU reconcile
   their work and run the FULL verification yourself — the package's tests
   (`just test-<pkg>` / `-unit`) and a typecheck (`bunx tsc` / the relevant gate,
   `just validate-all` when appropriate). Fix the app, never weaken assertions. "Done"
   means a real run went green — not a checked box. If a cross-concern seam broke
   (e.g. the frontend calls a contract the backend named differently), reconcile it
   here, re-running the affected specialist if the fix isn't a small seam patch.

7. **Advance.** When all build tasks are `done: true` and tests pass, set
   `status: revisar-codigo` and bump `updated` to today. `revisar-codigo` has no
   entry gate, so the move is always allowed once the work is real (the
   `hasNoBlockers` gate guards the NEXT hop, into `revisao`). Keep one field/one
   task per line.

8. **Report.** Summarize what was implemented per concern/specialist and per task,
   which tests now cover it, and that the card moved `desenvolver → revisar-codigo`.
   In queue mode, summarize each card.

## Eficiência de contexto (token discipline — handoff do plano)

O `harness-plan` já fez o trabalho pesado de investigação: `plans/<id>.md` mapeia os
**arquivos a tocar**, os **snippets** de código, os **contratos** e a **ordem das
tasks**. Esse plano é o seu **handoff de contexto** — TRATE-O COMO FONTE, não refaça
a descoberta que ele já fez:

- **CONFIE no plano; não re-descubra.** Não faça varredura exploratória do código
  (grep amplo, abrir arquivos "para entender o todo") sobre o que o plano já cobriu.
  Abra um arquivo só para (a) aplicar a mudança planejada ou (b) resolver uma lacuna
  REAL que o plano deixou em aberto. Re-investigar o que já está no plano é custo puro
  (não-cacheado) e foi o que inflou os runs antes desta disciplina.
- **Teste afetado no loop, suíte completa só na integração.** Durante o TDD
  (red→green→refactor) rode SÓ os arquivos de teste afetados
  (`bunx vitest run <arquivos>` / `just test-<pkg>-unit <pattern>`) — feedback rápido,
  contexto pequeno. A suíte COMPLETA do pacote roda **uma vez**, na integração
  (passo 6), como gate de regressão — nunca a cada task.
- **Leia o necessário, não o exaustivo.** README/board.yaml/regras dão schema e
  convenções uma vez; não os releia inteiros a cada passo.

## Specialist sub-agents (you are the ORCHESTRATOR)

`harness-do` does NOT implement every concern by hand. It reads the card's `tasks[]` +
the tech plan (`plans/<id>.md`), splits the work into concerns, and delegates each
present concern to a **specialist sub-agent** via the Task tool — mirroring how
`harness-review` fans its review lenses out to domain skills/agents, but **inverted**:
these sub-agents WRITE code. You stay the orchestrator + integrator (you own
classification, the integration run, the task done-marking, and the advance).

### Concern → specialist mapping

| Concern    | Scope                                                                 | Delegate to |
|------------|-----------------------------------------------------------------------|-------------|
| `db`       | Firestore schema/data shape, security rules, indexes (ADR-011 camelCase, named DBs, `firestore.rules`) | **`ddd-domain-expert`** — invokes the `dev-security` skill + cites `.claude/rules/firebase-security.md`; Firestore rules are the PRIMARY security layer |
| `backend`  | server actions, Cloud Functions (`{app}_{domain}_{action}`), API routes, business logic | **`backend-dev`** — invokes the `dev-nextjs` skill for server actions / route handlers |
| `frontend` | React/Next.js components, pages, UI, client state                     | **`frontend-designer`** — invokes `dev-nextjs` + the cascade: ① lê o guia de estilo do board (`storymap/boards/<board>/design/style-guide.md`, quando existir) ANTES de ② a skill `*-ui-aesthetics` do app do board (quando existir) → ③ deriva dos componentes existentes. Implementação referencia PAPÉIS (`bg-primary`/CSS var), nunca hex solto; conflito guia×skill → o guia vence. Inline styles only in the repo's shared UI package |

> The **bold** name in "Delegate to" is the Task `subagent_type` (a real agent type from the registry); the `dev-*` / `*-ui-aesthetics` entries are SKILLS the sub-agent invokes for domain knowledge — they are NOT agent types. If a named agent type isn't available at runtime, fall back to a general sub-agent given the same role + skills.

A card may touch 1, 2, or all 3 concerns. **Spawn a sub-agent only for a concern
that is actually present in the card's tasks/plan** — don't conjure work to fill the
table.

### Each sub-agent's contract

- Works in the **SAME worktree, SAME checkout, SAME branch** as this run. It does
  NOT create branches or git worktrees, and you never spawn separate runs.
- Follows **TDD** (red → green → refactor; the `/harness-tests` plan already covers the
  pyramid) and **fixes the app, never weakens an assertion**. During the loop it runs
  ONLY the affected test files (`bunx vitest run <files>`) for fast feedback — never the
  whole suite each cycle (the orchestrator runs the full suite once at integration, step 6).
- Segue **YAGNI**: implementa só o que o card/aceite pede, sem abstração especulativa nem
  generalização "para o futuro", e prefere a **solução mais enxuta** (one-liner quando couber)
  em vez de estrutura desnecessária.
- Touches **ONLY its concern's files** — the DB agent the rules/schema, the backend
  agent the server/functions/API, the frontend agent the components/pages. This file
  partitioning is what keeps the shared worktree from being clobbered.
- Returns a short contract summary (e.g. the data shape it landed, the server-action
  /function signature it exposed) so the next specialist in the chain can build on it.
  **Cooperative structured output (harness #2):** the specialist MUST return this summary as a
  single fenced block

  ````
  ```json contract-summary
  { "concern": "backend", "dataShape": "…", "serverSignature": "saveIdea(input: IdeaInput): Promise<{ id: string }>", "notes": "…" }
  ```
  ````

  — a JSON object with the stable keys `concern` (db|backend|frontend) and `notes`, plus `dataShape`
  (the DB agent's schema/shape) and/or `serverSignature` (the backend agent's action/function signature)
  when relevant. Before handing it to the NEXT specialist, YOU (the orchestrator) **validate that the
  block is parseable JSON**; if it is malformed, **re-ask that specialist for the corrected block (at
  most TWICE)** before proceeding on it. This is cooperative, not engine-enforced — the specialists run
  at the 2nd level inside this headless run, which the engine never sees, so the discipline lives HERE in
  the skill (honest scope: a determined sub-agent can still return prose; the retry + parse is best-effort
  hardening of the hand-off, not a hard gate).

### Sequential, in dependency order DB → backend → frontend (NOT parallel)

Run the specialists **one at a time, in the order DB → backend → frontend** — never
concurrently. Unlike `harness-review`'s lenses, which are READ-ONLY and therefore safe to
parallelise, these specialists WRITE code into ONE shared worktree; parallel writers
would race on the same files and clobber each other's edits. The order is also a real
data dependency: the **backend depends on the DB contract** (schema/rules it reads &
writes), and the **frontend depends on the backend contract** (the server action /
function / API shape it calls). So each specialist hands its contract to the next, in
sequence. Commit each concern's slice before launching the next (see **## Commits
incrementais**) so the diff lands live and stays revertible per concern.

### Pragmatism — don't over-spawn

A single-concern card does NOT need three sub-agents. A pure CSS/copy tweak is
frontend-only; a pure security-rule change is DB-only; a lone server-action fix is
backend-only. For a **trivial** single-concern change, just implement it directly
in-line (no sub-agent) — delegation is for real, multi-file concern work, not for
one-liners. When in doubt, delegate the concern(s) genuinely present and nothing more.

### Especialistas de QUALIDADE do board (WS4 — além do split db/backend/frontend)

Se o system-prompt deste run listar **"Especialistas disponíveis — delegue via Task tool"**
(injetado pelo board via a rota `toolkit.specialists`, ex.: `security-reviewer`,
`performance-auditor`, `conversion-copywriter`), delegue a ESSES agentes via Task
(`subagent_type: <slug>`) **quando a mudança tocar a área do especialista** — copy de UI/CTA →
`conversion-copywriter`; rules/auth/pagamentos/dados sensíveis → `security-reviewer`; render mobile/
bundle/latência → `performance-auditor`. São ORTOGONAIS ao split de implementação (um agente de
qualidade REVISA/aconselha uma fatia que o especialista de implementação escreveu). Cada um retorna um
bloco ```json``` de findings ({lens, severity, title, detail?, file?, line?, suggestion?}); consolide o
retorno na sua saída. Especialista não-listado = não existe para este board (nunca invente um slug).

### Rota subdimensionada (WS4 furo #1)

Se ao planejar/desenvolver você perceber que a ROTA do card está subdimensionada — ex.: um card em
perfil `express` que na verdade tem superfície de UI real (telas/jornada novas) que precisariam do bloco
de design — **levante um finding** `{ lens: "general", severity: "medium", title: "route-undersized: …" }`
com a recomendação (reabrir com rota mais completa, ou ajustar via `set_card_route`). É um AVISO (não
bloqueia); o humano decide. (O caso claro — `hasUiSurface` + `routing.skips` sobre o design — já é
carimbado deterministicamente pela auditoria de rota; o finding do agente cobre os casos mais sutis.)

## Commits incrementais (acompanhamento em tempo real)

Você roda num **worktree isolado** (`.worktrees/run-<id>`, branch `run/<id>`). **Faça commits
pequenos conforme avança** — idealmente um por task / passo de TDD — em vez de deixar tudo pro
fim. Isso faz o `+/−` (ícone de diff do card) e o histórico aparecerem **ao vivo** enquanto você
trabalha, e dá pontos de `undo` granulares. O engine integra a branch sozinho no fim — você
**não** roda `git push` nem mexe no merge; apenas `git add` + `git commit` no cwd do worktree (o
commit final de varredura do engine vira no-op se você já commitou tudo).

**Convenção — TODO commit carrega o id do card** (pra discovery + revert):

```
<tipo>(<scope>): <descrição curta> · <board>/<cardId> [t<N>]
```

- `<tipo>`: `test` (red) · `feat`/`fix`/`refactor` (green/refactor) · `chore`/`docs`.
- `<scope>`: o pacote/área (`storymap`, o pacote do board, …).
- `· <board>/<cardId>`: **obrigatório** — `git log --grep=<cardId>` lista tudo do card e
  facilita reverter o card inteiro (`git revert`). Mesmo id que o engine usa no commit de merge.
- `[t<N>]`: a task que o commit fecha (quando aplicável).

Exemplo (uma task em TDD = 1–2 commits):

```
test(storymap): red — diff visível durante running · storymap/story-redesenho [t3]
feat(storymap): incluir running em branchExists · storymap/story-redesenho [t3]
```

Commite o `done: true` da task **junto** com a fatia dela (board + código no mesmo commit, ou em
dois commits seguidos do mesmo `[tN]`). Pelo menos **um commit por coluna/run** — idealmente um
por task.

## Modo refino (mode: refine)

Se o card tem `mode: refine`, você está MELHORANDO código já em produção — não
construindo do zero. Antes de tocar em qualquer arquivo:

- Leia a seção `## Refino` do card (o diagnóstico do `harness-refine`: arquivos atuais +
  o que está fraco) e o `refinement.brief`. O `acceptance` aqui é um DELTA (a melhoria
  desejada), não a feature inteira.
- **Reconcilie as `tasks` antes de implementar.** No refino elas podem estar (a) vazias —
  a rota `design-ux` as limpou: derive-as agora a partir do `acceptance` delta + `## Refino`
  + o wireframe escolhido; ou (b) herdadas do build (todas `done: true`, desalinhadas do
  delta) — nesse caso IGNORE-as e gere as tasks do delta. Implemente SÓ o delta e marque
  cada task nova `done: true` conforme ela cai. Nunca re-execute uma task do build original.
- Localize a implementação existente e altere-a **in-place**. Não recrie componentes/
  rotas/handlers que já existem.
- Honre a INTENSIDADE do brief: "ajustar/polir" = mudança cirúrgica; "repensar/do
  zero" = refatoração ampla (mas ainda da feature que existe, não uma nova).
- Guard de REGRESSÃO: mantenha verdes os testes que já passavam e estenda-os para o
  novo comportamento — nunca enfraqueça asserção. A story estava viva; não a quebre.
- Ao avançar para `revisar-codigo`, MANTENHA `mode: refine` (o `harness-review` o limpa).

## Modo correção (mode: fix)

Se o card tem `mode: fix`, você está CORRIGINDO um bug numa story já entregue — não
construindo, nem só melhorando. Antes de tocar em qualquer arquivo:

- Leia a seção `## Bug` (o diagnóstico do `harness-fix`: reprodução + arquivos + causa raiz
  suspeita) e o `bugReport`. O `acceptance` aqui é o comportamento CORRETO a restaurar
  (esperado×atual), não a feature inteira.
- **TDD ao contrário (red primeiro).** A task #1 é escrever um teste que REPRODUZ o bug
  e, portanto, FALHA contra o código atual. Só então corrija até ele passar. Esse teste
  fica como teste de regressão — nunca o remova nem enfraqueça a asserção.
- **Reconcilie as `tasks`.** Elas podem estar (a) vazias — a rota `design-ux` as limpou:
  derive-as do `acceptance` + `## Bug` + o wireframe escolhido (com o teste de repro como
  #1); ou (b) herdadas do build (todas `done: true`) — IGNORE-as e gere as do fix. Marque
  cada task nova `done: true` conforme cai. Nunca re-execute uma task do build original.
- Localize a implementação quebrada e corrija-a **in-place**. Mire a CAUSA RAIZ apontada
  no `## Bug`, não o sintoma; não recrie componentes/rotas/handlers que já existem.
- Guard de REGRESSÃO: mantenha verdes os testes que já passavam — o fix não pode quebrar
  outro comportamento. Se a severidade é `blocker`/`high`, rode a suíte mais ampla da área.
- Ao avançar para `revisar-codigo`, MANTENHA `mode: fix` (o `harness-review` o limpa).

### Guardrails

- `revisar-codigo` has no entry gate — but do NOT advance on unfinished work. The
  bar is a green test run, not a status flip.
- Keep storymap-data edits (status/tasks) separate-minded from product edits;
  both are legitimate here, but never edit `packages/storymap-ui/` to satisfy a
  card that isn't about the AgileHarness UI itself.
- **Anti-clobber & verify-then-claim (ADR-058).** `origin/main` is the only source of
  truth: pull/reconcile before you edit, sync only by git (NEVER scp between checkouts),
  NEVER force-push or rebase a branch the merge train already pushed (it rewrites SHAs and
  invalidates the diff snapshots). PROVE, don't assert — a task is `done` only when the test
  run is green AND the change is really in the diff (the lost-impl persisted because a flag
  was trusted over the tree). You run in an isolated worktree; the engine integrates your
  branch — no manual push.
