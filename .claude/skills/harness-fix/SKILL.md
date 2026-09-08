---
name: harness-fix
description: >-
  AgileHarness automation that TRIAGES a bug reported against an already-shipped story.
  Reads a card in status `corrigir` (mode: fix) from
  storymap/boards/<board>/cards/<id>.md, DIAGNOSES + REPRODUCES the regression in the
  live implementation that the story shipped (which files/components/routes are
  broken TODAY) grounded in the human `bugReport` (brief + severity + expected×actual
  + steps), rewrites `acceptance` as the EXPECTED behaviour vs the broken actual, then
  ROUTES the card to the right entry column — a VISUAL regression generates corrected
  low-fi options and lands in `design-ux`; a BEHAVIOUR/copy defect lands in
  `desenvolver` with a failing repro test as the first task. It keeps `mode: fix` on
  the card so every downstream harness-* skill corrects IN-PLACE (with a regression guard)
  instead of recreating from scratch. With no id it processes the whole `corrigir`
  queue. Use when the user says "/harness fix", "/harness-fix", "corrigir story", "triagem de
  bug", "reportar bug", "diagnosticar regressão", or wants to advance AgileHarness cards
  sitting in Corrigir. Edits storymap data (the card .md + the wireframes/ sidecar);
  reads product code READ-ONLY to diagnose — never writes it.
triggers:
  - /harness fix
  - /harness-fix
  - corrigir story
  - triagem de bug
  - reportar bug
  - diagnosticar regressão
  - usm fix
---

# /harness-fix — AgileHarness: bug triage (corrigir → design-ux | desenvolver)

The `harness-fix` trigger automation. When a story in `revisao` (human QA) or `concluida`
(shipped) breaks and is reopened via the **Reportar bug** button, the card lands in
`corrigir` carrying `mode: fix` + a `bugReport`. This skill grounds the defect in the
REAL current implementation, REPRODUCES it (so the fix has a failing test to turn
green), respecs the change as expected-vs-actual, and routes the card into the pipeline
so the existing mode-aware skills (`harness-ux`, `harness-do`, `harness-review`) finish the job —
correcting what exists, never rebuilding it.

> Read `storymap/README.md` first (schema + the reopen flows). This skill is the FIX
> sibling of `harness-refine`: same machinery (reopen the SAME card, diagnose live code,
> respec a delta, route), different INTENT — refine improves something that works, fix
> restores something that broke. It edits ONLY storymap data — the card `.md` and the
> wireframe sidecar `storymap/boards/<board>/wireframes/<id>.json`. It reads PRODUCT
> code READ-ONLY to diagnose (grep/read/git log/git blame) and NEVER writes product
> code (`harness-do` does that later, in fix mode). Permission mode:
> dangerously-skip-permissions (it runs read-only Bash for diagnosis).

## Reabertura R1 — você roda na coluna de DESTINO escolhida pelo operador

A reabertura por **Reportar bug** NÃO estaciona mais o card numa coluna `corrigir`: o
operador escolhe o DESTINO (`enriquecer` / `design-ux` / `desenvolver`) e o card pousa lá
direto carregando `mode: fix` + `bugReport` + a flag **one-shot `reopenPending: true`**. A
cascata então roda VOCÊ (harness-fix) nessa coluna, sobrepondo a skill normal dela — só nesta
PRIMEIRA passada. Seu contrato muda só no fim:

1. Faça o diagnóstico / reprodução / respec de `acceptance` como sempre (passos abaixo),
   ancorado no destino que o operador escolheu (ele já decidiu onde a correção entra).
2. No fim, **LIMPE `reopenPending`** (remova o campo) e **MANTENHA `mode: fix`** — NÃO
   avance o card de coluna manualmente. Ao limpar a flag, a próxima avaliação da cascata
   roda a skill PRÓPRIA da coluna (ex.: `harness-do` em `desenvolver`, `harness-ux` em `design-ux`)
   já ciente do `mode: fix`. **Se você esquecer de limpar `reopenPending`, o override
   re-dispara harness-fix em loop** — limpá-la é obrigatório.
3. `mode: fix` segue até o `harness-qa` (a ÚNICA estação que o limpa), igual ao fluxo canônico.

> Caminho legado: um card que JÁ esteja em `status: corrigir` (sem `reopenPending`, ex.: em
> voo na migração) você processa como antes — diagnostica e ROTEIA para `design-ux` |
> `desenvolver`. A coluna `corrigir` continua existindo (trigger harness-fix); só não recebe
> cards novos pela ação de reabrir.

## Input

```
/harness-fix <board>/<id>     # triage one bug
/harness-fix                  # no id = process the ENTIRE `corrigir` queue
```

The card must be `status: corrigir` with `mode: fix` and a non-empty `bugReport.brief`
(the Reportar bug action guarantees this).

## What you are given (on the card)

- `bugReport.brief` — the human's free-text report: WHAT is broken and the context.
- `bugReport.severity` — `blocker` (crítico) | `high` | `medium` | `low`. Triage signal:
  it informs how aggressively to widen the regression net (a `blocker` warrants checking
  adjacent flows for the same root cause), NOT queue-jumping (v1 has none).
- `bugReport.expected` / `bugReport.actual` — the behaviour that SHOULD vs DOES happen.
  These are the spine of the respec'd `acceptance`. Either may be null — infer from the
  brief + the live code.
- `bugReport.steps` — ordered reproduction steps (may be empty — reconstruct from code).
- `bugReport.target` — an optional route/screen/env hint.
- `bugReport.screenshot` — an optional broken-state image under `bugs/<id>/`.
- The story's EXISTING `narrative`, `acceptance`, `personas`, `systems` — the shipped
  contract the bug VIOLATES; the baseline of correct behaviour, not a blank slate.
- The story's EXISTING `tasks` (and the plan sidecar `plans/<id>.md`, if any) describe
  the work ALREADY BUILT (typically all `done: true`) — they do NOT describe the fix.
  Step 4 reconciles them so a downstream build never re-runs stale build tasks.

## Workflow

1. **Locate + read.** Read `board.yaml` (the `package:` whose code shipped this story)
   and the card. Read the broken-state screenshot sidecar if present.

2. **Diagnose + REPRODUCE the regression (read-only).** Run the canonical diagnosis —
   **`@.claude/skills/harness-triage-shared/DIAGNOSIS.md`** (Grep/Read/`git log` over
   `packages/<pkg>/`; "presença de código ≠ shipped"; ANTÍDOTO a recriar do zero) to pin
   the DEFECT to real files: what exactly is broken vs `expected`, and — where you can —
   the likely root cause + the offending change (`git blame`/`git log` on the suspect
   lines). **Oriente via graphify ANTES de grep/read.** Este step roda com o **MCP graphify**
   (knowledge graph do código do pacote-alvo, carregado pela `mcpConfig` da coluna). Para
   LOCALIZAR a regressão — qual módulo/componente/handler implementa o comportamento
   quebrado, quem o chama/importa (os call-sites por onde o bug se propaga), o raio de
   impacto da causa raiz suspeita — **consulte o grafo PRIMEIRO** (`mcp__graphify__query_graph`/
   `get_neighbors`/`shortest_path`/`get_pr_impact`): ~120 tok/query vs milhares num grep+read
   amplo, e mais preciso (sem o ruído de comentários do grep). SÓ ENTÃO abra os arquivos
   exatos que o grafo apontou, para ler as linhas que vai diagnosticar/reproduzir. Mantenha
   o diagnóstico READ-ONLY — graphify é orientação, não escrita. **Overlay de fix — REPRODUZA:**
   reconstruct the reproduction (the `steps` if
   given, else derive them) so the build has a concrete failing case. Reproduction is the
   ANTÍDOTO específico do fix a corrigir a coisa errada.
   **Grounding do diagnóstico visual — cascata única de precedência (D13 canal 3)**: ①
   guia de estilo do board (`storymap/boards/<board>/design/style-guide.md`, quando
   existir) → ② skill `*-ui-aesthetics` do app → ③ componentes existentes. Numa
   regressão VISUAL, use o guia como o "esperado" e cite o TOKEN violado no diagnóstico
   (ex.: "CTA usa azul legado #4B76E8; guia define `primary` #FF4F00") — não platitude
   genérica.
   - Write a concise **`## Bug`** section into the card body capturing: the report, the
     reproduction (steps + minimal case), the diagnosis (key files + suspected root
     cause + the blame/commit if found), the severity, and the routing decision.
     Downstream skills read this as their starting point.

3. **Respec the `acceptance` as expected×actual + settle the PRIORITY.** Rewrite
   `acceptance` to express the CORRECT behaviour the fix must restore — phrased as the
   observable outcome, with the broken actual noted. Gherkin recommended, e.g. `Dado
   <contexto>, quando <ação>, então <expected> (hoje: <actual>)`. Keep them verifiable. Keep
   `narrative` (the story's intent didn't change — it regressed). Keep `mode: fix`.

   **Priority (type-aware WSJF — see `storymap/frameworks.md` §4):**
   - **NEW bug** (came from the Triagem, no prior feature prioritization): set/confirm the
     bug axes — `severity` (how bad) + `frequency` (always|often|sometimes|rare, how often)
     + `hasWorkaround` (true/false). These yield the bug's `priorityScore` that ranks it in
     the unified backlog. The triage seeds them; correct them from your diagnosis. Do NOT add
     `rice`/`kano`/`funnelStage` — a bug isn't a feature.
   - **REOPENED bug** (the card already has the shipped feature's `rice`/`kano`/`funnelStage`):
     **PRESERVE** them untouched — the card keeps its original feature `priorityScore` (a bug
     doesn't re-prioritize a shipped feature). See the guardrail.

   This new `acceptance` is the source of truth the task reconciliation in step 4 derives from.

4. **Reconcile the artefacts, then route** (set `status`, same edit; STOP there — the
   target is a human-decision column, so the card waits, exactly as in build/refine).
   Decide VISUAL vs BEHAVIOUR from the diagnosis (not a fixed taxonomy — a bug carries no
   `kinds`): a visual/layout regression that needs the look reworked is visual; a wrong
   value, broken rule, crash, dead handler, bad copy, or state bug is behaviour. When a
   visual regression is a one-line CSS/value fix, treat it as BEHAVIOUR (no redesign
   needed) — only route to design when the correct UI genuinely has to be re-decided.
   - **visual regression needing a redesign** → `status: design-ux`. Generate fix-biased
     canvas artifacts now (wrap the repo's **UX skill** DISCOVER→DESIGN, like `harness-ux`/`harness-ui`)
     into `artifacts[]` of `wireframes/<id>.json` (keep existing `feedback[]` intact),
     each screen framed as the CORRECT state vs the broken one — a fix RESTORES the
     existing design language, it doesn't reinvent it (say so in each artifact's `note`;
     preserve ids of artifacts the fix doesn't touch). **Tasks:** the implementation
     scope depends on the design the human will approve — do NOT guess it now; CLEAR the
     stale build tasks (`tasks: []`) and note in `## Bug` that the build re-derives them
     after the design is approved (`harness-do` fix mode does this), with the failing repro
     test as task #1.
   - **otherwise (behaviour / copy / value / crash)** → `status: desenvolver`. The scope
     is known here, so **regenerate `tasks` now**: replace the old build tasks with new
     `{ id, title, done: false }` items where **task #1 is always "escrever um teste que
     reproduz o bug (red)"**, followed by the fix task(s) covering ONLY the defect
     (`harness-do` then implements them; copy grounded in the brandbook). Note the repro +
     target behaviour in `## Bug`.
   - **Plan sidecar:** if the root cause is architectural (a contract/data-shape defect),
     flag in `## Bug` that `plans/<id>.md` is stale and the build must revisit it; a
     surgical fix needs no replan.
   **Why not route through `quebrar-tasks`/`priorizar`?** See the canonical rationale in
   **`@.claude/skills/harness-triage-shared/GUARDRAILS.md`** ("Por que não rotear por
   quebrar-tasks/priorizar") — those columns auto-run `harness-prioritize`, which would
   overwrite the already-decided `rice`/`kano`/`funnelStage`. Fix keeps the original
   prioritization and reconciles tasks IN-PLACE here instead.

5. **Report.** State: the diagnosis (current files + root cause + blame/commit if found),
   the reproduction, the respec (`acceptance` expected×actual + how you reconciled
   `tasks`: regenerated with a repro test first vs cleared for redesign), the severity,
   any stale-plan flag, and where you routed (`corrigir → design-ux | desenvolver`). In
   queue mode, summarize each card.

### Guardrails

Os guardrails comuns de reabertura e o ciclo de vida do `mode` são canônicos em
**`@.claude/skills/harness-triage-shared/GUARDRAILS.md`** — leia-os: nunca recriar do zero ·
reconciliar as build tasks (nunca deixar vazar) · uma reabertura não re-prioriza a story
entregue (um bug NOVO carrega `severity`+`frequency`+`hasWorkaround`, não RICE) ·
read-only no código de produto · **manter `mode: fix`** (quem o limpa é o `harness-qa` em
`qa-automatizado → revisao`, NÃO o `harness-review`) · não auto-executar escritas de código ·
nunca tocar `packages/storymap-ui/`.

Específico da correção (overlay sobre os comuns):

- **Reproduza antes de corrigir.** Sempre ancore num caso de falha concreto achado no
  passo 2; o fix é o teste ficando verde. Se genuinamente não conseguir reproduzir, diga-o
  em `## Bug` (com o que tentou), roteie conservadoramente para `desenvolver`, e faça a
  task #1 "isolar e reproduzir o bug" — nunca invente um fix para um defeito que não observou.
- **Rede de regressão escala com a severidade.** Para `blocker`/`high`, verifique se a
  mesma causa raiz quebra fluxos adjacentes e dobre-os em `## Bug` + `acceptance`; para
  `low`, fique cirúrgico.
- **Se o "bug" é uma capacidade nunca construída**, é uma feature NOVA, não um fix —
  diga-o e pare.
- **Anti-clobber & verify-then-claim (ADR-058).** `origin/main` é a única fonte da verdade:
  pull/reconcile antes de editar, sincronize só por git (NUNCA scp entre checkouts), NUNCA
  force-push nem rebase de branch que o train já pushou (reescreve SHAs). PROVE, não afirme —
  o fix só está pronto quando o teste de regressão fica verde E a mudança está mesmo no diff
  (a flag falsa foi o que fez o lost-impl persistir). Você roda num worktree isolado; o engine
  integra o branch — sem push manual.
