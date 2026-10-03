---
name: harness-review
description: >-
  AgileHarness automation that REVIEWS and SELF-REPAIRS a freshly implemented story.
  Reads a card in status `revisar-codigo` from storymap/boards/<board>/cards/<id>.md,
  runs the review lenses the target declares (security, testing, performance and general are built in;
  the target adds the domain ones — see `target.reviewLenses` in `storymap/settings.yaml`) over the real diff, AUTO-FIXES the safe/mechanical findings
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
the diff through the target's review lenses, **fixes what's safe to fix**, and escalates
only what needs a human decision — so the card reaches the automated QA column
(`qa-automatizado`), and then human Revisão, already clean.

> Read `storymap/README.md` first. Testing rules: the project's own testing guidance, if it has one
> (FIX THE APP, never weaken assertions, autonomous loop). Security: the project's security
> guidance, if it has one. This skill edits the card `findings[]`
> under `storymap/boards/<board>/cards/` AND product code in the board package (`package:` in
> `board.yaml`) to apply safe fixes. Permission mode: dangerously-skip-permissions (it writes
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
  (e.g. `git diff <earliest>^..HEAD -- <the board package>`). Record the HEAD sha in `reviewCommit`
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
   **Which lenses exist is the TARGET's declaration, not this skill's.** Read the `reviewLenses` map in the
   `target` block of `storymap/settings.yaml` (the run's context note does NOT list them; a headless run has
   no storymap MCP — in a conductor session `target_profile({board})` returns the same, already resolved):
   the built-in ones (`security`, `testing`, `perf`, `general`, `design`)
   plus any domain lens the target added (a data-store access lens, a frontend-framework lens…),
   each with its `name`, `description` (what it looks for), an optional `agent` (who runs it) and
   an optional `when` / `mandatoryWhen`. A lens whose `mandatoryWhen` matches the diff is NOT
   optional. The built-ins look for:

   | Lens        | Looks for                                           | Maps to |
   |-------------|-----------------------------------------------------|---------|
   | `security`  | secrets, authz/claims, injection, data exposure     | the lens' declared `agent`, else the project's security skill (if any), `/security-review` |
   | `perf`      | slow queries, re-renders, bundle, layout thrash     | the lens' declared `agent`, else the app's perf-audit skill (if present) |
   | `testing`   | missing/weak coverage of the acceptance criteria    | the project's testing skill/rules (if any) |
   | `general`   | correctness bugs, dead code, simplification         | `/code-review` |
   | `design`    | adherence to the style guide and the agreed design  | the board's style guide |

   A lens the target declared that is not in this table maps to its declared `agent` (or, with none,
   to a general reviewer briefed with the lens `name` and `description`).

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

   — an ARRAY of objects with EXACTLY these keys: `lens` (one of the built-in ids or one of the keys of
   `target.reviewLenses`), `severity` (one of blocker|high|medium|low), `title` (non-empty), and the optional
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
     the board package, then re-run the relevant tests + typecheck to confirm
     green (the target's `test` / `typecheck` checks, `target.checks.<name>` in `storymap/settings.yaml` — `target_profile({board})` when the MCP is mounted — run yourself
     with Bash in your worktree; with none declared, discover the command in the repository's own
     instructions — never assume an executor). Fix the app, NEVER weaken assertions. Mark the finding `status: fixed`
     and keep it on the card (an audit trail of what was repaired).
   - **Defeito objetivo que precisa de mão humana** (a data-access security-rule
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

   **O `id` DEVE carregar proveniência: `<lens>-<seq>-<sha8>`** (ex.: `security-1-ec0e1771`),
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
entra em limbo (parado, sem ninguém ser avisado). Já uma `question` é
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
> passo-a-passo, contagens de commits ("N commits atrás"), ou qualquer log de terminal. Comece o `text` pela
> decisão em forma de pergunta aberta. As stakes / o PORQUÊ vão no `context:` (1–2 linhas);
> a prova detalhada (IDs, hashes, diffs) vai num finding `detail` — **nunca** no `text`.

```yaml
questions:
  - id: q1
    text: <a decisão como pergunta aberta — CURTO: 1–3 frases, sem IDs/hashes/log de terminal>
    askedBy: harness-review
    askedAt: <YYYY-MM-DD de hoje>
    status: open
    category: interview         # SEMPRE — interview (produto/UX) | money (sempre do dono) — ver abaixo
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
- **SEMPRE preencha `category:`** — é o que a chave de autonomia do board lê. Numa story
  **ultra**, uma pergunta `interview` vai a um PROXY (contexto limpo, PRD + personas + decisões
  passadas do dono, premissas registradas); sem `category` ela nunca vai — e trava a story no dono.
  `interview` = decisão de produto/UX/comportamento (uma regra de comportamento com duas leituras);
  `money` = gasto, fornecedor, preço, API paga, publicação externa, PRD/metas, e decisões que tocam
  auth/rules/pagamentos/dados pessoais — SEMPRE do dono (comece o `context:` com `[humano]`);
  `ui-choice` = escolher entre variantes de tela já desenhadas. Na dúvida, `money`.
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

Um caso ILUSTRATIVO de `text` poluído (uma pergunta de capacidade, com a pergunta no meio)
e como enxugá-lo:

- ❌ **NÃO** (a pergunta existe, mas cercada de saída de comando):
  *"Aviso de colheita por SMS: 14 de 120 envios voltaram 429 entre 02:10 e 02:14 (fila
  avisos-v3, tentativa 3/5, backoff 8s). Reduzo o lote de 50 para 20 ou mantenho 50 e aceito
  reenvio? O commit b72e0c já troca o valor e o run 5f1a… passou; log: WARN sender.ts:88
  rate limited."* — o operador lê números de fila, um hash e uma linha de log antes e depois
  da única coisa que precisa decidir.
- ✅ **SIM** — separe por destino:
  - **`text`:** *"Para os avisos de colheita não estourarem o limite do provedor, prefere lotes
    menores (mais lentos) ou lotes grandes com reenvio das falhas?"*
  - **`context`:** *"Hoje cerca de 1 em cada 9 envios é recusado por excesso de ritmo. Lote
    menor atrasa o aviso em alguns minutos; reenvio mantém o ritmo, mas uma pessoa pode receber
    duas mensagens."*
  - Onde vai o resto: hash e run id → `detail` do finding; contagem de falhas, nome da fila e
    linha de log → `## Investigação` ou o `detail`. Nenhum deles entra no `text`.

### Exemplo concreto — um caso ilustrativo (excluir a conta de quem alugou quadras)

A revisão encontrou uma **tensão entre duas partes corretas**: ao excluir a conta, o código
apaga o perfil, mas a agenda das quadras guarda o nome da pessoa nas reservas passadas, e o
relatório mensal do administrador agrupa receita por esse nome. Nenhuma das duas partes
falha sozinha; o que falta é uma decisão sobre dado pessoal, e ela não tem resposta
técnica. Um finding `medium` não segura o gate nem chega ao Inbox, então a dúvida morreria
no card. O certo é emitir uma **question** — aqui com `category: money`, porque mexe em dado
pessoal, e sem `recommended`, porque o agente não tem base (jurídica) para escolher:

```yaml
questions:
  - id: q1
    text: >-
      Depois que alguém exclui a conta, o nome dessa pessoa deve continuar aparecendo nas
      reservas que ela já fez?
    askedBy: harness-review
    askedAt: 2026-05-04
    status: open
    category: money
    context: >-
      [humano] Hoje o perfil some, mas o nome fica nas reservas passadas e alimenta o relatório
      mensal. A resposta define se a exclusão é total ou se a contabilidade do administrador
      continua fechando.
    mode: single
    options:
      - id: o1
        label: Troca o nome por "ex-cliente" em todas as reservas, na hora
        pros: ["Atende o pedido por inteiro"]
        cons: ["O relatório perde quem usou cada quadra", "Não dá para desfazer"]
      - id: o2
        label: Mantém o nome por 12 meses e anonimiza depois
        pros: ["O ano contábil fecha com os nomes", "Prazo conhecido"]
        cons: ["Guarda dado pessoal depois do pedido", "Pede uma rotina agendada"]
      - id: o3
        label: Mantém só as iniciais nas reservas passadas
        pros: ["Meio-termo simples de explicar"]
        cons: ["Iniciais ainda podem identificar em um grupo pequeno"]
      - id: o4
        label: Pergunta à pessoa, no momento de excluir
        pros: ["Quem decide é o dono do dado"]
        cons: ["Um passo a mais no fluxo", "Dois caminhos para testar"]
```

Repare no que NÃO está lá: nenhum `recommended`, nenhuma `recommendation`. Sem base para
recomendar, apresentar os quatro caminhos com prós/contras já é o serviço — e a decisão fica
com quem pode tomá-la.

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
- Never auto-rewrite data-access security rules or do an architectural refactor
  silently — those are always human-judgement blockers with a proposed fix.
- Don't flip a finding to `fixed` unless the code actually changed and tests pass.
- **Anti-clobber & verify-then-claim.** Don't trust `reviewedAt`/`commitRange`
  blindly: compute them against the run's real base and confirm both base and head are
  reachable git objects before stamping (a lone sha rots once `main` advances). `origin/main`
  is the only source of truth — sync by git, never scp; never force-push. Prove a fix landed
  (it is in the diff, the suite is green), never infer it from "the edit succeeded".
