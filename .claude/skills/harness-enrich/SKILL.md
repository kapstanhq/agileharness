---
name: harness-enrich
description: >-
  AgileHarness automation that turns a captured demand into a SPECIFIED story
  (first hypothesis). Reads a card's title + body from
  storymap/boards/<board>/cards/<id>.md, classifies the storyType, writes the
  Agile narrative (role/want/soThat) and coherent acceptance[] criteria (Gherkin
  recommended) as the FIRST hypothesis (the Entrevista validates it next), adds
  context to the body, and sets coherent personas/systems from the board's
  vocabulary, then advances the card status `enriquecer` -> `interview` (Entrevista).
  With no id it processes the whole `enriquecer` queue of every board. Use when the
  user says "/harness enrich", "/harness-enrich", "enriquecer story", "refinar card",
  "preencher acceptance", or wants to advance AgileHarness cards sitting in
  Especificar. Edits ONLY storymap data files — never the storymap-ui package.
triggers:
  - /harness enrich
  - /harness-enrich
  - enriquecer story
  - enriquecer card
  - refinar story
  - refinar card
  - preencher acceptance
  - critérios de aceite
  - usm enrich
---

# /harness-enrich — AgileHarness: enrich a story (enriquecer → next board step)

The `harness-enrich` trigger automation for the AgileHarness pipeline. It turns a thin
draft into a **specified** story by (re)classifying the `storyType` and writing the
Agile `narrative` (role/want/soThat) + concrete acceptance criteria (Gherkin
recommended) as the **first hypothesis** — drawn from the captured demand and the
personas' pains/gains — then advances the card to `interview` (Entrevista). In the
canonical pipeline Especificar comes BEFORE the Entrevista: enrich writes the aceite
as a hypothesis and the Entrevista that runs next STRESS-TESTS it (USM: a conversa
confirma/ajusta o aceite). The `hasRefinement` gate is checked one step later, at Estimar.

> Read `storymap/README.md` first — it is the canonical schema/pipeline source.
> This skill edits ONLY the data files under `storymap/boards/<board>/cards/`.
> NEVER touch `packages/storymap-ui/` (UI or data layer).

## When to Use

- A card sits in status `enriquecer` (status #2, the `harness-enrich` trigger).
- The user runs `/harness enrich [<board>/<id>]` or `/harness-enrich [<board>/<id>]`.
- The user asks to "enriquecer", "refinar", or "preencher os critérios de aceite"
  of an AgileHarness story.

## Input

```
/harness-enrich <board>/<id>     # process one card (e.g. demo/story-busca-por-titulo)
/harness-enrich                  # no id = process the ENTIRE `enriquecer` queue
```

- `<board>` = a folder under `storymap/boards/` (e.g. `demo`, `demo-legado`).
- `<id>` = the card id == the markdown filename without `.md`.
- With **no argument**, scan `storymap/boards/*/cards/*.md` and process every
  card whose `status` is `enriquecer`, board-by-board, in file order.

If an explicit id is given but the card is NOT in `enriquecer`, do not force it:
report the current status and stop (the trigger only owns the `enriquecer` slot).

## Capture vs. enrich (what the human gives you)

On the UI, a human captures an item with only the **bare minimum**: the
`storyType` and the three-part `narrative`. The `title` is optional (it may be a
placeholder like `Novo item`), and everything else (`acceptance`, `tasks`,
`rice`, `kano`, `funnelStage`, `personas`, `systems`, body) is typically empty.

You have **full freedom to author AND improve every field** — including fields the
human already filled. If the `title` is a placeholder or weak, rewrite it into a title
that names the **INTENT/OUTCOME** (per the storyType's `titleGuide`, step 2 — never the
mechanism). If the narrative is rough, sharpen it (keep the human's intent). You are not
limited to filling blanks; refine for INVEST quality. Preserve the brand voice
(urbano-sofisticado; never `rolê`/`zap`/"o que rola").

## Workflow

1. **Locate the board + card.** Read `storymap/boards/<board>/board.yaml` to learn
   the valid ids for `statuses`, `personas`, `systems`, `releases`, `linkTypes`,
   and which statuses carry a gate. Read the target card file.

2. **Confirm the slot.** The card must be `status: enriquecer`. (Queue mode: pick
   every card with that status.)

   **Title — names the INTENT/OUTCOME, never the mechanism.** Set or improve `title`
   following the `storyType`'s `titleGuide` (single source: `STORY_TYPE_DEFS` in
   `packages/storymap-ui/src/lib/storymap/frameworks.ts`; mirrored in
   `storymap/frameworks.md` §0): the title names what the user GAINS / the outcome, not
   what the dev DOES. For `storyType: user` NEVER start with a dev verb — Criar, Adicionar,
   Implementar, Refatorar, Redesenhar, Remover, Configurar, Ajustar, Simplificar, Mover —
   those describe the solution and belong to the plan. By type:
   - `user` → "Ler o estado de um run sem entrar em edição" (✗ "Redesenhar modal…");
   - `technical` → "Runs não-UI sobem sem Chrome ocioso" (✗ "Escopar o MCP no .mcp.json");
   - `spike` → "Decidir se graphify vale" (✗ "Spike de graphify");
   - `bug` → "Card arquivado continua aparecendo" (✗ "Adicionar filtro no readCards");
   - `chore` → "Suíte roda em < 1 min" (✗ "Paralelizar o vitest").

   If it's a placeholder (`Novo item`/`Nova story`/empty), write a real one derived from
   the narrative. A quick-captured card has a RANDOM id (e.g. `story-a1b2c3`) that is
   PERMANENT — never rename it (see step 7).

3. **Re-classify the `storyType` (HIGH-STAKES) + write the `narrative`.** Treat the
   captured/triaged `storyType` as a HYPOTHESIS, not a given — this is the pipeline's
   confident classification checkpoint. Re-decide the nature
   (`user` | `technical` | `spike` | `bug` | `chore`) from the title + narrative +
   body using the `storymap/frameworks.md` §0 decision tree, and CORRECT it when the
   capture got it wrong (you have full authority — see "Capture vs. enrich").

   **Why it's high-stakes:** this classification ROUTES the rest of the pipeline —
   the **Entrevista** right after (`skipForTypes` non-user), the **design block**
   (`design-ux`/`design-ui`) and the **visual QA** all skip non-`user` types
   (board.yaml). Enrich is the confident checkpoint that SETS the type the Entrevista
   + design + QA then trust. A wrong call is expensive BOTH ways:
   - a `user` story mis-typed as `technical`/`chore`/`spike`/`bug` SKIPS the entire
     design block + the visual QA → a UI capability ships with no design and no
     E2E/visual proof (a SILENT quality loss);
   - a non-`user` story mis-typed as `user` burns ~3 needless runs (ux, ui,
     com-design) wireframing infra that has no screen (the SM-1 cost pain).

   **Decision tree (§0), in order:** tem persona + benefício de usuário observável?
   → `user` (a maioria). Só infra/plumbing que destrava outras stories
   (job/índice/scraper/webhook)? → `technical`. Pergunta a responder antes de
   construir? → `spike`. Conserto de comportamento quebrado? → `bug`. Faxina/upgrade
   sem valor direto? → `chore`. **On a genuine fence between `user` and a non-`user`
   type, prefer `user`** (the canonical default): silently dropping design/QA is
   worse than a visible run cost, and only a clearly screenless story should skip.

   **Eixo da SUPERFÍCIE de UI (`hasUiSurface`) — decide o QA visual, ORTOGONAL ao `storyType`.**
   Depois de decidir o type, decida se o card TOCA uma superfície visível ao usuário (tela/feed/
   componente) e grave `hasUiSurface: true|false` DIRETO no frontmatter (campo pipeline-owned, como
   `priorityCall` — o `update_card` o rejeita; edite o `.md`). Regra: QUALQUER card com superfície
   visível — INCLUSIVE um `bug` que conserta um glitch de UI — recebe `hasUiSurface: true` (força o
   sweep visual no gate `hasQaPassed`); um card sem tela (job/índice/migração, ou uma `user` story de
   API/push/voz) recebe `hasUiSurface: false` (isenta do QA visual, sem deadlock). Omita só quando
   genuinamente indeciso (cai no fallback `storyType === "user"`). **Este campo fecha o vazamento-raiz:
   uma regressão visual rotulada `bug` deixava de rodar o sweep visual — agora não.**

   **Eixo da ROTA (`routing`) — quanto do pipeline este card percorre (WS4). OPCIONAL, use a
   classificação que você JÁ fez (`storyType` + `hasUiSurface`).** O board declara `routeProfiles`
   nomeados em `_base` (`full`/`standard`/`express`). Escolha um e grave um bloco `routing` DIRETO no
   frontmatter (campo pipeline-owned; o `update_card` o rejeita — edite o `.md`), copiando `skips` +
   `modelCap`/`effortCap` do perfil e registrando `profile`, `decidedBy: agent`, `decidedAt` (YYYY-MM-DD)
   e um `rationale` curto. Guia: um `technical`/`chore` TRIVIAL sem superfície de UI → `express`
   (pula entrevista/design/priorizar, paga em sonnet/medium); uma `user` story com telas novas → `full`
   (pipeline completo); na dúvida → `standard` (comportamento atual, só os skips por tipo). **NUNCA**
   liste em `routing.skips` um passo LOAD-BEARING (`plano-tecnico`/`desenvolver`/`revisar-codigo`/`qa-*`)
   nem um passo já coberto pelo `skipForTypes` do tipo (ruído). **REGRA DE COERÊNCIA (dura):** se o
   perfil escolhido pula `priorizar`, você DEVE gravar um `priorityCall` mínimo (rank + rationale) no
   MESMO run — senão o card TRAVA no gate de prioridade (fail-closed). Omita `routing` por completo se
   não tem certeza (a cascata decide a rota pelas regras determinísticas — comportamento byte-idêntico).

   **Regressão (corretivo) vs régua-nova (perfectivo) — você tem o CÓDIGO à vista; seja o árbitro.**
   Para uma dor que incide sobre comportamento EXISTENTE, diagnostique read-only e decida pelo
   BASELINE (a spec original), não pelo sintoma: (a) já funcionava conforme a spec e DEGRADOU? →
   CORRETIVO → `storyType: bug` + `mode: fix` + um `bugReport.brief` (esperado×atual) → trilha de
   conserto, sem discovery; (b) funciona como construído mas queremos uma régua nova / nunca existiu? →
   PERFECTIVO → capacidade nova (`user`/`technical`). No caso híbrido (a melhoria também conserta o
   sintoma), o baseline TEM precedência → trate como perfectivo (a melhoria absorve a correção).

   **PORTA da superfície inexistente (NÃO converta tipo aqui):** se o diagnóstico read-only mostra que
   a feature/rota AINDA NÃO existe no código, não é regressão e não há dono — NÃO estampe `mode:fix` e
   NÃO ancore (`serves`/`addresses` para o vazio cria fio-de-ouro falso). Mantenha como capacidade nova
   (`user`/`technical`) e, se for só a DOR sem solução decidida, sinalize `needsHumanReview` e registre
   na premissa que talvez devesse ser uma `idea` — a conversão de tipo é destrutiva e fica a
   cargo do humano (Inbox), nunca do enrich.

   **Ancoragem ao dono — 3 eixos ORTOGONAIS, não confunda:** `serves` (escalar, story→user-story) = a
   ENTREGA que implementa aquela user story (a prateleira; só para entrega technical/bug/chore/spike);
   `mode:fix`+`bugReport` = este card CONSERTA algo quebrado (roteia o harness-fix, gate `hasBugReport`);
   `links[] rel:addresses` (story→idea) = esta story FECHA aquela dor (fio-de-ouro dual-track).
   Um `bug` PODE ter `serves` E `mode:fix` ao mesmo tempo; NUNCA use `serves` apontando uma `idea`.

   **Premissa de classificação (FLIPÁVEL) — não decida em silêncio.** Registre no body, em
   `## Premissa de classificação`, a aposta que você fez ("assumo regressão de X → corretivo" vs
   "assumo régua-nova → perfectivo", e por quê), para a Entrevista (ou o toggle no card) poder VIRAR a
   aposta. A premissa é a aposta mais arriscada da classificação — exponha-a, não a enterre.

   Then fill `narrative.role` / `narrative.want` / `narrative.soThat` using THAT
   type's connectors (§0 table). Store only the CORE in each field —
   `role: explorador urbano`, NOT `role: Como explorador urbano` (the connector
   comes from the `storyType`). PT-BR brand voice (urbano-sofisticado; never
   `rolê`/`zap`/"o que rola").

4. **Author acceptance criteria (Gherkin recommended) — as a HYPOTHESIS.** The
   Entrevista has NOT run yet; YOU write the first cut of the aceite, and the
   interview that runs next validates/adjusts it. Ground the criteria in the `title`
   + narrative + the selected personas' `pains[]`/`gains[]` (step 5) — each pain
   becomes a concrete, testable criterion. Write `acceptance: string[]` — 2-4
   user-visible, testable criteria in PT-BR, preferring **Dado / Quando / Então**;
   outcome phrases ("Após X, o usuário vê Y") stay valid for simple rules. Keep it a
   confident hypothesis, not a guess — the Entrevista is the *Confirmation* step that
   challenges it. The narrative + `acceptance` together form the `hasRefinement` gate
   (checked at Estimar).

5. **Set coherent personas/systems — then ground the story in their pains/gains.**
   Use ONLY ids that exist in `board.yaml` (e.g. the `demo` board's systems
   `catalogo|busca|checkout`). Never invent an id — if none fits, leave the
   array empty rather than guess. A `user` story should name at least one persona
   (it grounds the `role` clause).

   Personas are NOT just ids to validate. After fixing the persona ids, read the
   `pains[]` and `gains[]` (and `jobs[]`) of each selected persona in `board.yaml`,
   and use those lists as the lens for the narrative and acceptance you wrote in
   steps 3–4 — revisit them if needed so they reflect real dores/ganhos, not
   abstraction:
   - each **pain** justifies a problem-oriented acceptance criterion (the criterion
     proves the dor is gone);
   - each **gain** anchors the `soThat` clause or a value-oriented criterion;
   - the `jobs[]` keep the `want` grounded in what the persona is actually trying
     to do.

   You need not quote the persona text verbatim — use it to make the criteria
   concrete. **Conditional:** if a selected persona has no `pains`/`gains` defined
   in `board.yaml` (e.g. a system persona like `autorun`), skip the grounding for
   that persona and follow the normal flow — never invent dores/ganhos.

6. **Enrich the body — PROBLEM SPACE ONLY (negócio/domínio, nunca implementação).**
   Below the frontmatter, expand the markdown with the business/domain context that
   explains the story — NOT how to build it. The body is the card's "Contexto & valor";
   the *como* (solution) is owned by `/harness-plan` in `plans/<id>.md`, which is FREE to
   contradict the card (INVEST "Negotiable"). Cover, as relevant to the type:
   - **Contexto & problema** — what's going on and why it matters now. Se o card tem uma aresta
     `addresses` para uma `idea`, ANCORE este parágrafo na DOR daquela ideia (o
     `idea.statement` + a `evidence`): a story existe para FECHAR aquela dor — deixe o porquê
     explícito, para o agente de build (que lê o corpo) entregar com contexto de valor, não só a task.
   - **Quem & valor (JTBD)** — the persona and the job/outcome they're after.
   - **Escopo in/out** — a business decision on what's included/excluded (not a task list).
   - **Regras de negócio & restrições** — as FACTS/constraints, not as design.
   - **Conhecimento de domínio** (optional) — domain vocabulary / edge cases.
   - **Premissas & riscos DE NEGÓCIO** — implementation risks belong to the plan.
   The voice shifts by `storyType` (user = JTBD/dor; technical = which capability it
   unlocks + why now; spike = question + decision + timebox; bug = repro/impact/expected;
   chore = what rots if undone). **Keep OUT of the body:** a `## Proposta`, file paths,
   function/type names, libraries, implementation order, technical risks — those migrate
   to `plans/<id>.md`. Do NOT put acceptance back as `- [ ]` checklists — acceptance is
   the structured `acceptance` field.

7. **Advance — NEVER rename the id.** The card id is **permanent and immutable**: it
   was minted once at capture (`story-<hash>`, e.g. `story-a1b2c3`) and stays exactly
   that for the card's whole life. Do **NOT** rewrite it to a title slug, do **NOT**
   create a `<slug>.md` + delete the old file — that is the bug the card-id-immutability
   fix removed (a mid-pipeline rename breaks `parent`/`links[].to` references and
   run-branch tracking, and the code now pins the id on every write anyway, so a rename
   attempt is silently undone or orphans a file). Edit the card **in place** at its
   existing path `storymap/boards/<board>/cards/<id>.md`, keeping `id` untouched.

   Write the refinement FIRST — `narrative` complete (role + want + soThat) AND
   `acceptance` with >= 1 item — directly into the card file (the `hasRefinement`
   gate will be checked on advance). Bump `updated` to today (`YYYY-MM-DD`); keep
   one field per line. Leave `tasks` / `rice` at their safe defaults — those belong
   to `harness-tasks` and priorização. Do NOT hardcode the next status. THEN advance
   the card board-aware by running:

   ```
   bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts" <board> <id>
   ```

   (same `<board>` and `<id>` you received as the `<board>/<id>` argument). The
   helper moves the card to the NEXT step of THAT board's pipeline — `enriquecer`
   lands in `interview` (Entrevista) for a `user` story; a non-`user` type skips the
   Entrevista and forwards toward Estimar — reusing the pipeline's `nextBuildStatus`
   + `checkGate`, so the skill never names a status.
   If it exits non-zero, the `hasRefinement` gate blocked the move: that means the
   narrative/acceptance weren't fully written before the advance — fix the card and
   re-run (do NOT edit `status:` by hand).

8. **Report.** State the card moved `enriquecer → <next step of the board>` (via
   `advance-card`), the `id` (unchanged — it is immutable), the `storyType`, the
   narrative, and the acceptance criteria. In queue mode, summarize each card
   processed.

### Gate guardrail

NEVER run `bun "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/scripts/advance-card.ts"` while the `narrative` is incomplete OR `acceptance`
is empty — the `hasRefinement` gate (enforced by `advance-card`'s `checkGate` and
by the `validate-storymap-gate` pre-write/pre-edit hook) will reject the move and
the helper exits non-zero. Always write the complete `narrative` (role/want/soThat)
and `acceptance` INTO the card FIRST, then advance — otherwise the card stalls at
the `hasRefinement` gate one step ahead.
