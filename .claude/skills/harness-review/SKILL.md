---
name: harness-review
description: >-
  AgileHarness automation that REVIEWS and SELF-REPAIRS a freshly implemented story.
  Reads a card in status `revisar-codigo` from storymap/boards/<board>/cards/<id>.md,
  runs tech-specific review lenses (Firestore rules, Next.js, mobile performance,
  security, testing) over the real diff, AUTO-FIXES the safe/mechanical findings
  (guarded by typecheck + tests — never weakening assertions), and escalates the
  rest by KIND: an objective defect that needs a human (security-rule or risky
  architectural change) stays a `blocker` finding; a genuine human DECISION (a
  UX/product/architecture choice with no single right answer) becomes a rich
  `question` (options + pros/cons + recommendation) so it shows up in Inbox and
  pauses the cascade instead of going invisible as a mute medium finding.
  Writes findings[] + questions[] + reviewedAt + reviewCommit + commitRange,
  then advances `revisar-codigo` -> `qa-automatizado` when no open blocker remains
  (hasNoBlockers gate) — the automated QA column runs the acceptance E2E + visual
  sweep before human Revisão. With no id it processes the whole `revisar-codigo` queue.
  Use when the user says "/harness review", "/harness-review", "revisar código", "code
  review da story", "rodar as lentes", or wants to advance AgileHarness cards sitting
  in Revisar código. Edits storymap data (the card .md) AND product code (to apply
  the safe fixes) — never the storymap-ui package unless that IS the target.
triggers:
  - /harness review
  - /harness-review
  - revisar código
  - code review da story
  - rodar as lentes
  - usm review
---

# /harness-review — AgileHarness: review + self-repair (revisar-codigo → qa-automatizado)

The `harness-review` trigger automation. After `harness-do` builds a story, this reviews
the diff through tech-specific lenses, **fixes what's safe to fix**, and escalates
only what needs a human decision — so the card reaches the automated QA column
(`qa-automatizado`), and then human Revisão, already clean.

> Read `storymap/README.md` first. Testing rules: `.claude/rules/testing-philosophy.md`
> (FIX THE APP, never weaken assertions, autonomous loop). Security:
> `.claude/rules/firebase-security.md`. This skill edits the card `findings[]`
> under `storymap/boards/<board>/cards/` AND product code under `packages/<pkg>/`
> to apply safe fixes. Permission mode: dangerously-skip-permissions (it writes
> code + runs tests).

## Input

```
/harness-review <board>/<id>     # review one card
/harness-review                  # no id = process the ENTIRE `revisar-codigo` queue
```

The card must be `status: revisar-codigo` (it got here from `harness-do`).

## What is reviewed (the diff, not the whole repo)

Review the story's CHANGE, scoped to the package from `board.yaml` `package:`:
- **Primary target = the card's commits, found via the card-id convention.** `harness-do`/`harness-qa`
  now commit INCREMENTALLY, every subject carrying `· <board>/<cardId>` (see harness-do's "Commits
  incrementais"). So the story's change = the cumulative diff of those commits:
  `git log --grep="<board>/<cardId>" --oneline` lists them; review the union of their diffs
  (e.g. `git diff <earliest>^..HEAD -- packages/<pkg>/`). Record the HEAD sha in `reviewCommit`
  AND the DURABLE range `commitRange: { base: <git rev-parse <earliest>^>, head: <HEAD sha> }` —
  a lone sha rots once `main` advances (SM-05); base+head stays diff-able forever.
- **Fallback (no card-id commits found — legacy/uncommitted run):** the working-tree diff since
  the last commit (`git diff` + new untracked files under the package); if the tree is clean,
  the last commit (`git show`). Record `reviewCommit` = HEAD sha or `working-tree`; for
  `commitRange` use the HEAD at the run's start (the sha you stamp in `reviewedAt`) as `base`
  and the current HEAD as `head` (skip `commitRange` entirely if neither is resolvable).
- When YOU auto-fix a finding, commit it with the same convention
  (`fix(<scope>): … · <board>/<cardId> [review]`) so the repair is discoverable + revertible.

## Workflow

1. **Locate + confirm.** Read `board.yaml` (package) and the card (`acceptance`,
   `tasks`, the plan sidecar `plans/<id>.md` for intent). Compute the diff to review.
   Este step monta o **MCP graphify** (facet `toolkit` da coluna → toolConfig `codegraph`,
   WS3): para entender o RAIO DE IMPACTO do diff (quem chama/importa as funções/arquivos
   mudados) rode `mcp__graphify__query_graph`/`get_neighbors` SOBRE OS SÍMBOLOS/ARQUIVOS DO
   DIFF ANTES de abrir arquivos — ~120 tok/query vs milhares no grep+read, e mais preciso.
   NÃO use `get_pr_impact` aqui: ele exige um `pr_number` de PR do GitHub e os runs rodam em
   branches locais (`run/<id>`), sem PR — `query_graph`/`get_neighbors` sobre os arquivos do
   diff dão o mesmo raio de impacto sem depender de um PR. Abra arquivo só para ler o
   conteúdo exato que a lente precisa avaliar.

2. **Run the lenses (parallel).** Dimension to the diff — skip a lens with nothing
   to review. Spawn them as parallel subagents for isolation, mapping each to the
   project's domain skill/agent:
   | Lens        | Looks for                                           | Maps to |
   |-------------|-----------------------------------------------------|---------|
   | `firestore` | rules holes, unsafe queries, named-DB usage         | dev-security, `.claude/rules/firebase-security.md` |
   | `security`  | secrets, authz/claims, injection, SSR data exposure | dev-security, `/security-review` |
   | `nextjs`    | server/client boundary, server-action safety, caching | dev-nextjs |
   | `perf`      | mobile jank, re-renders, bundle, layout thrash      | `*-web-perf-audit` (the app's perf skill, if present) |
   | `testing`   | missing/weak coverage of the acceptance criteria    | dev-testing, `.claude/rules/testing-philosophy.md` |
   | `general`   | correctness bugs, dead code, simplification         | `/code-review` |

   **Cooperative structured output (harness #2) — each lens MUST return its findings as a single
   fenced block, and YOU (the orchestrator) MUST validate it before writing anything.** The lens
   sub-agent ends its turn with:

   ````
   ```json finding-batch
   [
     { "lens": "security", "severity": "blocker", "title": "…", "detail": "…", "file": "…", "line": 42, "suggestion": "…" }
   ]
   ```
   ````

   — an ARRAY of objects with EXACTLY these keys: `lens` (one of firestore|security|nextjs|perf|
   testing|general), `severity` (one of blocker|high|medium|low), `title` (non-empty), and the optional
   `detail`/`file`/`line`/`suggestion`. The sub-agent does NOT author `id` or `status` — you assign those
   on write (`status: open`, a stable id). An empty lens returns `[]`.

   **Keep findings LEAN (the card-document read surface renders each open finding as ONE line —
   its `title` — with `detail`/`file`/`line`/`suggestion` hidden behind an expand):** make `title`
   a complete, self-contained one-liner a human grasps at a glance (the problem, not a fix essay);
   put the supporting context in a SINGLE concise `detail` line; reserve `suggestion` for the actual
   proposed fix. Do NOT pad the title with file/line — those have their own fields.

   Before persisting (step 5), **validate every block strictly**: reject any block where a `lens`/`severity`
   is outside the enum, a `title` is empty, or there is an EXTRA/unknown key (it's a `.strict()` shape — a
   typo'd or hallucinated field is a rejection, not a silent drop). `parseFindingBatch` in
   `packages/storymap-ui/src/lib/storymap/runner/findings.ts` (schema `FindingBatchItemSchema` in
   `contracts.ts`) is the CANONICAL reference for this shape — mirror it. If a block is invalid, **re-ask
   that sub-agent for the corrected block (at most TWICE)**. If it is still invalid after the retries,
   **FAIL CLOSED**: keep the card in `revisar-codigo`, do NOT open the `hasNoBlockers` gate, and do NOT
   write partial/malformed findings — report the unparseable lens for the human. This is cooperative (the
   sub-agents run inside this headless run, below what the engine can see), so the discipline lives HERE in
   the skill, not in the engine.

3. **Triage each result — DEFEITO vs DECISÃO (read "## Triagem" below first).**
   Decide which of THREE buckets it lands in:
   - **Auto-fixable** (mechanical / low-risk: a missing test, a perf re-render, a
     type, a lint/pattern issue, a small correctness bug) → FIX it in
     `packages/<pkg>/`, then re-run the relevant tests + typecheck to confirm
     green. Fix the app, NEVER weaken assertions. Mark the finding `status: fixed`
     and keep it on the card (an audit trail of what was repaired).
   - **Defeito objetivo que precisa de mão humana** (a Firestore security-rule
     change, a risky architectural refactor you should not do silently, anything
     unsafe to auto-fix) → keep it as a **finding** `status: open`, `severity:
     blocker` (high/medium/low só ANOTAM), with a concrete `suggestion`.
     Security-rule and schema changes ALWAYS escalate como finding blocker.
   - **Decisão humana** (uma escolha de UX/produto/arquitetura SEM resposta única —
     o código não está "errado", há caminhos plausíveis e o operador precisa
     julgar) → **NÃO é finding: emita uma `question`** (ver "## Triagem"). Ela
     aparece RICA no Inbox (opções + prós/contras + recomendação) e PAUSA a
     cascata até o humano responder.

4. **Self-repair loop.** Re-run the lenses over the new diff. Repeat fix→re-review
   until a round surfaces nothing new auto-fixable OR only human-judgement findings
   remain. Bound it (≤3 rounds) so it always terminates.

5. **Write findings + questions + metadata.** Persist `findings[]` on the card
   (each with a stable `id`, `lens`, `severity`, `title`, `status`, optional
   `detail`/`file`/`line`/`suggestion`) for the DEFEITOS, and `questions[]` (per
   "## Triagem") for the DECISÕES humanas. Set `reviewedAt: <today>`, `reviewCommit`
   and the durable `commitRange: { base, head }` (per "What is reviewed" above). Keep
   high/medium/low findings even when not fixed — they annotate, they don't block.

   **O `id` DEVE carregar proveniência: `<lens>-<seq>-<sha8>`** (ex.: `security-1-8b47e6a7`),
   onde `<sha8>` são os 8 primeiros caracteres do `reviewCommit` deste run e `<seq>` distingue
   vários findings da MESMA lente neste run. **NUNCA** cunhe id posicional genérico (`f1`, `f2`):
   o merge-back integra `findings[]` **por id** (`ELEMENT_MERGED_FIELDS` em
   `packages/storymap-ui/src/lib/storymap/card-merge.ts`), então dois runs que cunham `f1` para
   defeitos DIFERENTES fazem o merge tratá-los como o MESMO fato e **descartar** silenciosamente o
   do main. A referência canônica é `reviewFindingId(lens, seq, provenance)` em
   `packages/storymap-ui/src/lib/storymap/runner/findings.ts` — espelhe-a (cooperativo, como o
   `parseFindingBatch`: as lentes rodam abaixo do que o engine enxerga, então a disciplina vive
   AQUI). Re-review do MESMO commit reusa o mesmo id de propósito (refresca em vez de empilhar);
   um id de mecanismo já pronto (`gate-<runId>`, `code-not-landed-<runId>`) **não** se reescreve.
   Um finding com id duplicado no mesmo card **reprova** o lint de integridade do board.

6. **Advance — only if clean.** Advance `revisar-codigo → qa-automatizado` ONLY when
   BOTH hold: NO finding is `severity: blocker` AND `status: open` (the hasNoBlockers
   gate), AND NO `question` is `status: open`. The automated QA column (`harness-qa`) then
   proves the acceptance criteria end-to-end (E2E + visual) before human Revisão. If
   an open blocker OR an open question remains, KEEP the card in `revisar-codigo` —
   the cascade stays paused — and report it for the human (they clear blockers via
   fixed/wontfix in the UI; they answer questions on the `/perguntas` queue / cockpit,
   then a human re-runs `/harness-review` or moves the card).

7. **Report.** Per lens: what was found, what you auto-fixed (with the test that
   guards it), which blockers await a human, AND which `question`s you raised. State
   whether the card advanced (it does NOT advance while ANY open question remains).

## Triagem — finding (DEFEITO) vs question (DECISÃO HUMANA)

Esta é a distinção mais importante da skill. Um resultado da revisão é UMA das duas
coisas — e elas têm SUPERFÍCIES diferentes no Inbox:

| Tipo | O que é | Como registrar | Onde aparece |
|------|---------|----------------|--------------|
| **DEFEITO OBJETIVO** | um fato verificável: bug, código morto, risco de segurança/perf, teste faltando, regressão. O código está **errado** — há uma resposta certa. | **finding** (`findings[]`) | só `severity: blocker` trava o gate `hasNoBlockers` E vira item 🔴 no Inbox; `high`/`low` só anotam (informam, não travam, não pilotam) |
| **DECISÃO HUMANA** | uma escolha de UX/produto/arquitetura **sem resposta única**: o código não está errado, há caminhos plausíveis e o operador precisa julgar o trade-off. | **question** (`questions[]`) | SEMPRE aparece RICA no Inbox (lane 🟡 "Perguntas", com opções + prós/contras + recomendação) E pausa a cascata |

**Por que a distinção EXISTE (o bug #35 que ela conserta):** o Inbox (cockpit
`demands.ts`) só projeta finding como item acionável quando `severity === "blocker"`
(`openBlockers`). Um finding `high`/`medium`/`low` que na verdade pede uma DECISÃO
humana fica **invisível** — não trava o gate e não aparece em lugar nenhum → o card
entra em limbo (foi exatamente o que travou o story-597cp7). Já uma `question` é
projetada SEMPRE (qualquer status não-terminal), com toda a riqueza. Então:
**decisão humana NUNCA deve virar um finding mudo de severity < blocker — vira uma
question.** Findings continuam donos dos DEFEITOS objetivos (não os remova: blocker
trava, high/low informam).

**Teste mental — "isto tem resposta certa?":**
- SIM, e é mecânico → auto-fix (finding `fixed`).
- SIM, mas é arriscado de eu mexer sozinho (regra de segurança, refactor grande) →
  finding `blocker` com `suggestion`.
- NÃO — depende de gosto/produto/estratégia/UX → **question** com opções.

### Como emitir uma question (estrutura)

A estrutura já existe (`CardQuestion`/`QuestionOption` em
`packages/storymap-ui/src/lib/storymap/types.ts`; helper `addQuestions()` em
`lib/storymap/questions.ts`). Escreva-a como entrada na lista `questions:` da
frontmatter do card (mesma convenção da harness-grill), UM campo por linha, com `askedBy:
harness-review`. Use ids `q<N>` que não colidam com perguntas já existentes:

> **O `text` é a PERGUNTA, não o laudo — mantenha-o CURTO (1–3 frases).** O `text`
> renderiza como o CORPO PRINCIPAL no Inbox; o operador precisa entender num relance
> O QUE está sendo decidido e POR QUE importa. **NUNCA** despeje nele a investigação:
> branch/run IDs, hashes de commit, caminhos de arquivo como evidência, o diagnóstico
> passo-a-passo, "119 commits atrás", ou qualquer log de terminal. Comece o `text` pela
> decisão em forma de pergunta aberta. As stakes / o PORQUÊ vão no `context:` (1–2 linhas);
> a prova detalhada (IDs, hashes, diffs) vai num finding `detail` — **nunca** no `text`.

```yaml
questions:
  - id: q1
    text: <a decisão como pergunta aberta — CURTO: 1–3 frases, sem IDs/hashes/log de terminal>
    askedBy: harness-review
    askedAt: <YYYY-MM-DD de hoje>
    status: open
    context: <o PORQUÊ — o trade-off em jogo, o que muda conforme a escolha (1-2 linhas)>
    mode: single                # single (uma) | multi (várias)
    options:                    # 2–5 caminhos PLAUSÍVEIS (não fatos inventados)
      - id: o1
        label: <caminho A>
        pros: [<por que é bom — curto>]
        cons: [<o custo — curto>]
        recommended: true       # NO MÁXIMO uma opção recomendada em toda a pergunta
      - id: o2
        label: <caminho B>
        pros: [<…>]
        cons: [<…>]
    recommendation: <só para pergunta SEM opções discretas: sua leitura em prosa>
```

- **SEMPRE preencha `context:`** — as stakes, o que muda conforme a resposta. É o que
  deixa o Inbox decidir num toque sem reabrir o card.
- **Com opções discretas** → dê `options:` (2–5, ids `o1`,`o2`,…) com `mode:
  single|multi`, `pros`/`cons` curtos por opção, e marque a melhor com `recommended:
  true` (**no máximo UMA** em toda a pergunta). O texto livre do humano está sempre
  disponível ao lado — as opções são atalho, não jaula.
- **Sem opções** (puramente aberta) → pode dar `recommendation:` em prosa.
- **Nunca fabrique fatos.** `context`/`pros`/`cons`/`recommended`/`recommendation`
  são análise honesta de caminhos plausíveis, não respostas inventadas — você ajuda o
  humano a decidir mais rápido, não decide por ele. Sem base para recomendar? Deixe
  `recommended`/`recommendation` de fora; apresentar os caminhos já é o serviço.

### `text` — mau × bom (o "vazamento de terminal" que esta disciplina conserta)

Um caso REAL de `text` poluído (uma pergunta de publicação) e como enxugá-lo:

- ❌ **NÃO** (~150 palavras de terminal soterrando a pergunta): *"Publicação de produção
  (o app do board) — QA verde, tasks 5/5, 0 blockers. O blocker code-not-landed-2db1513b era STALE
  (o fix 6ed85c66a já é ancestral do HEAD; a integração falha do run 2db1513b foi superada
  pelo land posterior). deploy_plan escopado: o pacote do board = 2 commits (c6f6be4da/story-xfleex +
  6ed85c66a/story-eqpdtz); o delta monorepo desde 687338af é 147 mas a unidade carrega só os
  2… Autoriza publicar agora, ou revisar antes?"* — a decisão real ("posso publicar?") está
  enterrada sob branch/run IDs, hashes e diagnóstico. O operador tem que MINERAR o texto.
- ✅ **SIM** — a mesma pergunta, enxuta:
  - **`text`:** *"Posso publicar o app em produção agora (backend via orquestrador + web
    via um pipeline separado), ou você prefere revisar o deploy_plan antes?"*
  - **`context`:** *"Card publish-ready (QA verde, 5/5 tasks, 0 blockers). Ressalva: a web do
    app sobe por um pipeline próprio, fora do deploy per-app — coverage-gap a confirmar."*
  - Os IDs de run/commit e o diagnóstico do blocker STALE moram no finding `detail`, **não** no `text`.

### Exemplo concreto — o caso real do story-597cp7 (modal leitura/edição)

A revisão encontrou um comportamento **dual-concluído**: o botão do header e o toggle
interno do card davam dois caminhos de salvar com a mesma intenção, sem um dono claro.
Isso NÃO é um defeito objetivo (nada está quebrado, todos os caminhos "funcionam") —
é uma DECISÃO de UX sem resposta única. Na época virou um finding `medium` mudo e o
card ficou em limbo (não travou o gate, não apareceu no Inbox). O certo é emitir
uma **question**:

```yaml
questions:
  - id: q1
    text: >-
      No modal do card, qual deve ser o papel do botão do header durante a EDIÇÃO —
      ele esconde o toggle interno, também salva, ou vira "Cancelar"?
    askedBy: harness-review
    askedAt: 2026-06-14
    status: open
    context: >-
      Hoje header e toggle interno são dois caminhos de salvar com a mesma intenção,
      sem dono claro (dual-concluído). A escolha define a hierarquia de ação do modal
      e evita o usuário salvar duas vezes / ficar em dúvida de qual botão usa.
    mode: single
    options:
      - id: o1
        label: O header ESCONDE o toggle interno durante a edição (um único dono da ação)
        pros: ["Um caminho de salvar — sem ambiguidade", "Hierarquia limpa: header = ação primária"]
        cons: ["Some um affordance que o usuário talvez já conheça"]
        recommended: true
      - id: o2
        label: O header TAMBÉM salva (dois caminhos equivalentes)
        pros: ["Mantém os dois affordances"]
        cons: ["Redundância confusa — qual é o certo?", "Risco de salvar em duplicidade"]
      - id: o3
        label: O header vira "Cancelar" na edição (descartar)
        pros: ["Par claro salvar(interno)/cancelar(header)"]
        cons: ["Header muda de significado entre ler e editar — pode surpreender"]
    recommendation: >-
      Recomendo o1: um único dono da ação remove o dual-concluído e dá a hierarquia
      mais previsível; o toggle interno reaparece fora da edição.
```

Repare: a pergunta dá ao operador uma decisão num toque (3 caminhos com prós/contras +
uma recomendação honesta) em vez de um finding silencioso que ninguém vê.

### Questions PAUSAM a cascata

Enquanto o card tiver **qualquer** `question` com `status: open`, a skill **NÃO
avança** o card — ele FICA em `revisar-codigo`. A cascata fica parada porque a skill
escolhe não promover (o autorun só avança quando o skill decide avançar). A question
aparece no Inbox na lane 🟡 "Perguntas"; o humano responde lá (`/perguntas` ou o
cockpit). Diferente do step `grill`, responder uma question levantada AQUI **não**
auto-avança o card — depois de responder, o humano re-roda `/harness-review` (que relê as
respostas como contexto e segue) ou move o card. Resumo do gate de avanço (step 6): só
avance `revisar-codigo → qa-automatizado` quando **NÃO** houver finding `blocker`
aberto **E** **NÃO** houver question aberta.

## Modo refino (mode: refine)

Se o card tem `mode: refine`, a story já estava em produção — pese a revisão para
REGRESSÃO:

- Verifique acima de tudo que a melhoria NÃO quebrou comportamento/fluxos existentes
  (lente `testing` + a lente do `kind` da melhoria). Trate regressão como `blocker`.
- Confirme que a mudança foi **in-place** (sem duplicar componentes/rotas que já
  existiam — o anti-padrão clássico do refino).
- **NÃO** limpe `mode`/`refinement` ao avançar `revisar-codigo → qa-automatizado` — o
  review apenas MANTÉM o marcador; quem o LIMPA é o `harness-qa`. Protocolo canônico em
  **`@.claude/skills/harness-triage-shared/GUARDRAILS.md#mode-lifecycle`**.

## Modo correção (mode: fix)

Se o card tem `mode: fix`, a story QUEBROU em produção e foi corrigida — pese a revisão
para REGRESSÃO e exija a PROVA da correção:

- **Exija o teste de regressão.** O `harness-do` (modo fix) escreve, como task #1, um teste que
  REPRODUZ o bug (red→green). Confirme que esse teste EXISTE no diff, falhava antes e passa
  agora, e ficou como guarda permanente. Um fix sem teste que trave o bug NÃO está pronto →
  registre como `blocker`.
- Verifique acima de tudo que o fix mirou a CAUSA RAIZ (`## Bug`), não só o sintoma, e que
  NÃO quebrou comportamento/fluxos vizinhos (lente `testing` + a lente da área afetada).
  Trate regressão nova como `blocker`.
- Confirme que a correção foi **in-place** (sem duplicar componentes/rotas que já existiam).
- **NÃO** limpe `mode`/`bugReport` ao avançar `revisar-codigo → qa-automatizado` — o
  review apenas MANTÉM o marcador; quem o LIMPA é o `harness-qa`. Protocolo canônico em
  **`@.claude/skills/harness-triage-shared/GUARDRAILS.md#mode-lifecycle`**.

### Guardrails

- Tests are the gate for a fix — a green run, not a hope. If you can't make a fix
  pass without weakening a test, it's NOT auto-fixable → escalate it as a finding.
- Never auto-rewrite Firestore security rules or do an architectural refactor
  silently — those are always human-judgement blockers with a proposed fix.
- Don't flip a finding to `fixed` unless the code actually changed and tests pass.
- **Anti-clobber & verify-then-claim (ADR-058).** Don't trust `reviewedAt`/`commitRange`
  blindly: compute them against the run's real base and confirm both base and head are
  reachable git objects before stamping (a lone sha rots once `main` advances). `origin/main`
  is the only source of truth — sync by git, never scp; never force-push. Prove a fix landed
  (it is in the diff, the suite is green), never infer it from "the edit succeeded".
