---
name: harness-retire
description: >-
  AgileHarness automation that REMOVES a feature from the app and archives its card.
  Reads a card in status `descontinuar` (mode: retire) from
  storymap/boards/<board>/cards/<id>.md, DIAGNOSES read-only what the feature owns
  TODAY (files/routes/flags/functions/data) grounded in the human `retirement.brief`
  + `level` + `scope`, writes a removal plan to retire/<id>/plan.md, then EXECUTES the
  removal at the chosen level — desativar (feature flag off), despublicar (drop from
  navigation, code dormant), remover-codigo (delete components/routes/functions, data
  kept, git-reversible) — pausing BEFORE the irreversible production-data wipe of
  excluir-tudo, which only runs after the human clicks "Aprovar exclusão de dados"
  (retirement.dataDeletionApproved). On completion it moves the card to the terminal
  `arquivados` graveyard, keeping mode: retire as the tombstone. With no id it
  processes the whole `descontinuar` queue. Use when the user says "/harness retire",
  "/harness-retire", "descontinuar story", "remover feature", "executar remoção", or
  clicks "Rodar agora" on a card in Descontinuar. Edits storymap data (the card .md +
  the retire/ sidecar) AND product code (it deletes the feature); never touches
  packages/storymap-ui unless that IS the feature being removed.
triggers:
  - /harness retire
  - /harness-retire
  - descontinuar story
  - remover feature
  - executar remoção
  - usm retire
---

# /harness-retire — AgileHarness: feature retirement (descontinuar → arquivados)

The `harness-retire` trigger automation. When a card is reopened via the **Descontinuar**
button with a removal `level`, it lands in `descontinuar` carrying `mode: retire` + a
`retirement` block. This skill is the inverse of `harness-do`: where build WRITES a feature,
retire REMOVES it — grounded in the real current implementation, at exactly the level the
human asked for, with the one irreversible step (a production-data wipe) human-gated.

> Read `storymap/README.md` first (schema + the retire flow). This skill edits storymap
> data (the card `.md` + the sidecar `storymap/boards/<board>/retire/<id>/`) AND product
> code — it DELETES the feature in `packages/<pkg>/`. Permission mode:
> dangerously-skip-permissions (it runs Bash, writes code, commits). Whereas `harness-refine`
> improves and `harness-fix` restores, `harness-retire` DESTROYS — so it diagnoses + plans BEFORE
> cutting, and never wipes data without the explicit approval flag.

## Input

```
/harness-retire <board>/<id>     # remove one feature
/harness-retire                  # no id = process the ENTIRE `descontinuar` queue
```

The card must be `status: descontinuar` with `mode: retire`, a non-empty
`retirement.brief`, and a non-null `retirement.level` (the Descontinuar action
guarantees this — postergado/abandoned cards with no level skip straight to
`arquivados` and never reach this skill).

## What you are given (on the card, `retirement` block)

- `brief` — the human's free-text reason: WHY it's leaving + nuances (e.g. "tira do ar
  mas guarda os dados 30 dias"). Honour the nuances literally.
- `disposition` — `abandonado` (was in-flow, partial WIP to clean) | `descontinuado`
  (was live, full removal). (`postergado` never reaches here.)
- `level` — HOW HARD to cut: `desativar` | `despublicar` | `remover-codigo` |
  `excluir-tudo` (ordered soft → hard). This BOUNDS the removal — never exceed it.
- `scope` — WHICH surfaces to touch: `codigo` | `rota` | `dados` | `flag` | `functions`.
  Empty = infer from the diagnosis. `dados` + `excluir-tudo` arms the data-wipe gate.
- `target` — an optional route/feature hint.
- `screenshot` — an optional current-state image under `retire/<id>/`.
- `dataDeletionApproved` — the human go-ahead for the irreversible data cut. `false` on
  the first run; flipped to `true` by the "Aprovar exclusão de dados" button, which
  RE-RUNS this skill.
- The story's `narrative`, `acceptance`, `tasks`, plan sidecar — describe what shipped;
  your removal map, not a rebuild.

## Workflow

1. **Locate + read.** Read `board.yaml` (the `package:` whose code owns this feature)
   and the card. Read the screenshot sidecar if present. If `dataDeletionApproved` is
   already `true`, jump to step 4's data step (this is the post-approval re-run).

2. **Diagnose the LIVE feature (read-only).** Run the canonical diagnosis —
   **`@.claude/skills/harness-triage-shared/DIAGNOSIS.md`** (Grep/Read/`git log` over
   `packages/<pkg>/`; "presença de código ≠ shipped"; pins the work to real files).
   **Oriente via graphify ANTES de grep/read.** Este step roda com o **MCP graphify**
   (knowledge graph do código do pacote-alvo, carregado pela `mcpConfig` da coluna). Para
   MAPEAR o que a feature POSSUI — rotas/páginas, componentes, server actions, Cloud
   Functions, flags, entradas de navegação — e, crítico, as **referências de ENTRADA de
   OUTRAS features** (quem importa/chama/linka para os símbolos da feature, para a remoção
   não deixar ponta solta), **consulte o grafo PRIMEIRO** (`mcp__graphify__query_graph`/
   `get_neighbors`/`shortest_path`/`get_pr_impact`): ~120 tok/query vs milhares num grep+read
   amplo, e mais preciso (sem o ruído de comentários do grep) — `get_pr_impact`/`get_neighbors`
   dão o raio de impacto exato que limita o corte. SÓ ENTÃO abra os arquivos exatos que o
   grafo apontou. Mantenha ESTE diagnóstico READ-ONLY — graphify é orientação; a remoção em
   si vem no passo 4. **Overlay de remoção:** map everything the feature OWNS — routes/pages, components,
   server actions, Cloud Functions, feature flags, Firestore collections/fields, nav
   entries — AND, critically, the **inbound references from OTHER features** (grep for
   imports/links: a removal must not leave dangling references). For retire the diagnosis
   is the ANTIDOTE to over- AND under-cutting: it bounds exactly what comes out and
   surfaces what depends on the feature.

3. **Write the removal plan** to `storymap/boards/<board>/retire/<id>/plan.md` AND a
   concise `## Descontinuação` section in the card body. The plan lists, in safe order:
   the files/routes/functions/flags to remove, the inbound references to clean, the data
   the feature owns (collections + rough volume), and — for `excluir-tudo` — the exact
   production-data deletion (queries + scope) as a SEPARATE, clearly-marked step.

4. **Execute the removal at `level`** (reversible-first; commit after each coherent step
   with a `chore(<scope>): descontinua <feature> (<level>)` message). NEVER exceed the level:
   - **`desativar`** — flip the feature's flag OFF (or introduce one and default it off).
     Do NOT delete code. The feature is dark but intact (fully reversible).
   - **`despublicar`** — remove the navigation entry / route registration / entry points so
     the feature is UNREACHABLE; leave the implementation dormant. Clean inbound links.
   - **`remover-codigo`** — DELETE the components/routes/server-actions/functions that
     implement the feature, and clean every inbound reference so the package still builds.
     KEEP the data. Reversible via git.
   - **`excluir-tudo`** — do everything in `remover-codigo` first (code cut, committed),
     THEN the data wipe — but GATED:
     - If `dataDeletionApproved` is `false`: **STOP here.** Do NOT delete data, do NOT move
       the card. Finalize the data-deletion plan in `plan.md`, note in `## Descontinuação`
       that the code is removed and the data cut awaits approval, and report that the card
       waits in `descontinuar` for "Aprovar exclusão de dados". The card stays put (no new
       column-entry event → no re-trigger loop).
     - If `dataDeletionApproved` is `true`: execute the production-data deletion exactly as
       planned (scoped queries against the correct named DB — see Firebase convention; never
       a bare `getFirestore()`), LOG the counts deleted, then continue to step 5.

5. **Archive.** Once nothing is pending (level ≤ `remover-codigo`, or `excluir-tudo` with the
   data cut done), set `status: arquivados` (terminal) in the card `.md`, KEEPING
   `mode: retire` + the `retirement` block as the tombstone. Update `## Descontinuação`
   with what was actually removed + the commit sha(s). Do NOT clear the prioritization or
   narrative — the card is a historical record of something that existed.

6. **Report.** State: the diagnosis (what the feature owned + inbound refs), the level
   executed, exactly what was removed (files/routes/flags/functions/data + counts), the
   commit(s), and the outcome (`descontinuar → arquivados`, or "awaiting data approval" when
   paused). In queue mode, summarize each card.

### Guardrails

- **Never exceed `level`.** `desativar` must not delete code; `remover-codigo` must not
  touch data. The level is the contract — under-cutting is safe, over-cutting is a bug.
- **Never wipe data without `dataDeletionApproved: true`.** The production-data cut is the
  one irreversible act; it runs ONLY on the post-approval re-run. When in doubt, pause.
- **Leave the package building.** A removal that orphans imports/links is incomplete —
  clean every inbound reference found in step 2 (the package must still typecheck/build).
- **Honour the brief's nuances.** "Guarde os dados 30 dias" means do NOT pick
  `excluir-tudo` data now even if the level allows it — respect the human's stated intent;
  reflect any such deferral in `## Descontinuação`.
- **Keep the tombstone.** Keep `mode: retire` + the `retirement` block on the archived card
  (it is the record of what existed and why it left). `arquivados` is terminal — the cascade
  stops there; do not forward it.
- **Respect the named DB.** Data deletion uses `getFirestore(app, '<dbname>')` per the
  Firebase convention, scoped to the feature's collections — never a broad or cross-app wipe.
- Never touch `packages/storymap-ui/` unless the AgileHarness UI itself IS the feature being removed.
