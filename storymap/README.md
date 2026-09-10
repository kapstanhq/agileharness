# StoryMap — dados (User Story Mapping)

Conteúdo versionado dos boards de **User Story Mapping** (modelo Jeff Patton). A UI
que lê/escreve estes arquivos vive em `packages/storymap-ui/`. Suba com **`bun run
build && bun run start`** de dentro do pacote → http://127.0.0.1:3008.

Humanos editam pela UI (arrastar/criar/editar); **agentes LLM editam estes arquivos
diretamente** — a UI reflete ao focar a janela (ou clicando em recarregar ⟳).

## Disciplina de contexto (eficiência de tokens) — TODA skill `harness-*`

Cada skill roda num processo headless novo e PAGA o contexto que carrega. O ganho de
eficiência NÃO está em reler menos o README/CLAUDE.md (o prefix-cache do proxy já cobre
isso) — está em **não re-investigar o que o step anterior já descobriu**:

- **Confie nos sidecars como handoff.** O step anterior já gravou o que importa:
  `plans/<id>.md` (arquivos a tocar, snippets, contratos, ordem das tasks),
  `wireframes/<id>.json` (jornada + canvas de design aprovado), e as seções `## Entrevistas`/`## Refino`/`## Bug`
  do card. Leia-os PRIMEIRO e CONFIE — não refaça a varredura de código que eles já
  fizeram. Abra um arquivo de produto só para aplicar a mudança planejada ou resolver
  uma lacuna REAL que o handoff deixou aberta.
- **Investigue o mínimo.** Nada de `grep`/leitura ampla "para entender o todo" quando o
  handoff já aponta os arquivos exatos. Re-descoberta é o maior custo NÃO-cacheado dos runs.
- **Skills de PLANEJAMENTO não leem código de produto.** `harness-grill`, `harness-enrich`,
  `harness-interview`, `harness-prioritize`, `harness-tasks` escrevem só dados do board
  (narrativa/aceite/RICE/KANO/funil/tasks) — elas NÃO escrevem código, então NÃO abram
  arquivos `.ts`/`.tsx` de produto para "entender" a feature. Trabalhe sobre o card
  (escopo + respostas do grill) + o `board.yaml` + os sidecars. Investigar o código aqui
  estoura os turns sem necessidade (já cortou um `harness-enrich` no `--max-turns`, deixando
  o card avançar sem narrativa). A investigação de código pertence a `harness-plan`/`harness-do`/
  `harness-review`/`harness-ux`/`harness-ui`.
- **Teste afetado no loop; suíte completa só no gate final.** Skills que rodam testes
  (`harness-do`, `harness-qa`) usam `bunx vitest run <arquivos>` durante o ciclo e a suíte
  COMPLETA do pacote UMA vez, no fim — nunca a suíte inteira a cada passo.

## Layout

```
storymap/
├─ settings.yaml              # config global do runner autopilot (kill switch, paralelismo, watchdogs, modelo/effort fallback)
└─ boards/
   └─ <board>/                 # um board por app (ex.: demo)
      ├─ board.yaml            # vocabulários do board (statuses, releases, personas, systems, linkTypes)
      ├─ docs/                 # DOCUMENTOS do board — vivem FORA do pipeline (sem status, sem coluna)
      │  ├─ prd.md             # o documento MAIS ALTO: tudo abaixo desce dele (ver "Documentos")
      │  └─ lean-canvas.md     # a compressão de uma página, DERIVADA do PRD
      ├─ cards/
      │  └─ <id>.md            # 1 card por arquivo (id == nome do arquivo)
      ├─ plans/                # sidecar: plano técnico por card (harness-plan) — plans/<id>.md
      ├─ wireframes/           # sidecar: design por card (harness-ux/harness-ui): jornada em grafo + canvas de artefatos + feedback[] — wireframes/<id>.json
      ├─ refine/               # sidecar: anexos do refino por card (screenshot do estado atual) — refine/<id>/
      └─ bugs/                 # sidecar: anexos do bug por card (screenshot do estado quebrado) — bugs/<id>/
```

Criar um board novo = criar `storymap/boards/<app>/board.yaml` + pasta `cards/`. O `docs/` nasce
vazio: cada documento é materializado no primeiro save (até lá, `loadDoc` projeta o esqueleto do
schema — ler um documento que ainda não existe devolve o esqueleto, nunca erro).

## Documentos (`docs/`)

Um **documento de board** é markdown com esqueleto travado: quais seções existem, com que rótulo e
que tipo de conteúdo cada uma aceita (prosa, itens, checklist, tabela, grupos) vêm de um `DocSchema`
declarado no código. As três portas de escrita — editor rico, fonte markdown e agente (`write_doc`)
— passam pela MESMA validação, e um rótulo renomeado é recusado nas três.

| documento | `docType` | o que é |
|---|---|---|
| **PRD** | `prd` | O documento mais alto do board. Dezesseis seções, seis obrigatórias (`resumo`, `problema`, `publico`, `posicionamento`, `objetivos`, `escopo`). Absorveu a escada estratégica que era três strings soltas no `board.yaml` (`positioning`/`businessMetric`/`desiredOutcome`, hoje as seções `posicionamento`/`metricaNegocio`/`resultadoAlvo`). |
| **Lean Canvas** | `lean-canvas` | A compressão de uma página, **derivada** do PRD. Doze blocos na ordem canônica de preenchimento. |

**O que desce do PRD:** o Lean Canvas (compressão), o backbone do USM (da seção `jornadas`), as
personas (de `publico`) e o **digest** que todo run herda como norte — `resumo`, `posicionamento`,
`resultadoAlvo`, `metricaNegocio` e `escopo`, com teto por seção. O documento inteiro em todo prompt
afogaria a pergunta; quem precisa do resto chama `read_doc`.

**Três seções existem para o AGENTE, não para o leitor** — e são elas que separam este PRD de um PRD
humano: `decisoes` (o que JÁ foi decidido; um agente que não sabe que a decisão foi tomada toma a
dele, e a toma plausivelmente), `jornadas` (o que a captura transforma em backbone em vez de lista
plana) e `prontoQuando` (critérios verificáveis — "funciona" não é um).

**O PRD é `owner:human`.** Um `Write`/`Edit` direto em `docs/prd.md` é BLOQUEADO pelo guard de
propriedade; o caminho de um agente é `propose_change({artifact:'prd', field:'<chave da seção>'})`,
que abre rascunho para aprovação. A conversa da TELA escreve direto, porque ali já existe humano
lendo cada palavra.

## Contexto por app

Antes de qualquer ação de **código ou copy** num card, leia o `CLAUDE.md` do pacote
correspondente ao board — ele define as convenções técnicas (Firebase, rotas, ADRs,
brandbook) que as skills `harness-*` devem respeitar. O `package:` de cada `board.yaml` aponta
a pasta; carregue o contexto do app-alvo **antes** de tocar arquivos, mesmo rodando uma
skill na mão (fora do autorun).

| Board | Package | CLAUDE.md a ler | Brandbook |
|-------|---------|-----------------|-----------|
| board de produto | o `package:` do `board.yaml` | `<package>/.claude/CLAUDE.md` | `docs/business/brandbooks/` (quando existir) |
| `storymap` | `packages/storymap-ui/` | `.claude/CLAUDE.md` (raiz) | — |

> Os boards existentes são as pastas de `storymap/boards/` — leia o `board.yaml` de cada um
> para saber o `package:`. Um board sem `package:` (ex.: `demo`) não tem pacote de código
> para carregar. Para apps sem board dedicado: leia `packages/<pkg>/.claude/CLAUDE.md` e o
> respectivo brandbook em `docs/business/brandbooks/` quando existir. Mapa marca→pacote em
> `.claude/CLAUDE.md` (raiz).

## Modelo (3 níveis, canônico Patton)

- **activity** — backbone (grandes objetivos), sequência esquerda→direita (topo). `parent: null`.
- **step** — tarefas de uma atividade (`parent` = id da activity).
- **story** — card detalhado (`parent` = id do step), posicionado numa **release** (linha).
  Toda story tem um **`storyType`** (`user`\|`technical`\|`spike`\|`bug`\|`chore`) e uma
  **`narrative`** de 3 partes (a user story Agile / variante enabler) — ver
  [Tipos de story e template de escrita](#tipos-de-story-e-template-de-escrita).

A interseção (step × release) é a célula onde as stories ficam, empilhadas por `order`.

> **Captura rápida (UI).** O botão **+ Item** (na navbar do Mapa e do Kanban) cria uma
> story só com o essencial: o humano informa **tipo + narrativa**; o título é opcional
> (a IA sugere) e o resto fica atrás de "mostrar todos os campos". O item nasce na
> **Triagem** (`triage`, staging, SEM autorun) e descansa ali até um humano/triador o rotear
> para `enriquecer`, onde o `/harness-enrich` aprofunda — com **liberdade para melhorar qualquer
> campo, mesmo os já preenchidos** (inclusive o título).

## Pipeline de status

Cada story percorre um **pipeline** de 11 status de build (de `enriquecer` a `revisao`)
+ a raia de staging `triage` (intake de texto livre) + as colunas de reabertura
`refinar` (modo melhoria) e `corrigir` (modo correção), pós-entrega. Três conceitos governam o avanço:

- **Gate** (validado ao **ENTRAR** no status): o card só pode mover-se para o status
  se já satisfizer o critério. Falha = a UI/ação recusa o movimento, sem escrever.
  Depois da reforma, os gates ficam na **entrada das colunas produtoras** (as colunas
  de pouso pass-through `refinada`/`com-tasks`/`com-plano` foram removidas).
- **Trigger** (enquanto o card **SENTA** no status): uma skill `harness-*` processa o card
  automaticamente — enriquece, prioriza, desenha, planeja, quebra, desenvolve, revisa, QA —
  e ao concluir avança o status (**produzir-e-avançar**).
- **Parada** (`autorun: false`): o card PARA no status e só avança quando um humano o move.
  As três paradas do fluxo são `pronta` (go/no-go), `com-design` e `revisao`.

| # | id | nome | gate (ao entrar) | trigger (automação) |
|---|----|------|------------------|---------------------|
| 1 | `enriquecer` | Enriquecer | — | `harness-enrich` |
| 2 | `priorizar` | Priorizar | `hasRefinement` | `harness-prioritize` |
| 3 | `pronta` | Pronta p/ build | `hasPrioritization` | — *(PARADA go/no-go)* |
| 4 | `design-ux` | Design UI/UX | — | `harness-ux` |
| 5 | `com-design` | Com design | `hasWireframe` | — *(PARADA)* |
| 6 | `plano-tecnico` | Plano técnico | — | `harness-plan` |
| 7 | `quebrar-tasks` | Quebrar em tasks | `hasTechPlan` | `harness-tasks` |
| 8 | `desenvolver` | Em desenvolvimento | `hasTasks` | `harness-do` |
| 9 | `revisar-codigo` | Revisar código | — | `harness-review` |
| 10 | `qa-automatizado` | QA automatizado | `hasNoBlockers` | `harness-qa` |
| 11 | `revisao` | Revisão | `hasQaPassed` | — *(PARADA)* |
| — | `refinar` | Refinar | `hasRefineBrief` | `harness-refine` |
| — | `corrigir` | Corrigir | `hasBugReport` | `harness-fix` |
| — | `concluida` | Concluída | — | — |

> A raia de staging `triage` (intake de bug/ideia em texto livre via `report_issue`) fica à
> esquerda e **não** dispara o build sozinha (ADR-056). Cards novos (botão "Novo item",
> `create_card`, `/harness story`, captura inteligente) entram na **Triagem** (`triage`) e
> descansam ali, fora do autorun, até serem roteados para `enriquecer`.
>
> **`refinar` não é um passo do build** — é a porta de entrada do **modo melhoria**
> (ver ["Modo refino"](#modo-refino-melhoria-de-stories-prontas)), posicionada logo antes de
> `concluida` (que permanece a coluna terminal). Uma story em **Revisão** ou **Concluída**
> reaberta pelo botão **Refinar** entra aqui e o `harness-refine` a roteia de volta para
> `design-ux` ou `desenvolver`.
>
> **`corrigir` é o irmão de `refinar` para BUGS** (ver ["Modo correção"](#modo-correção-bug-em-stories-prontas)):
> uma story que QUEBROU, reaberta pelo botão **Reportar bug**, entra aqui e o `harness-fix` a
> diagnostica/reproduz e roteia de volta (regressão visual → `design-ux`; comportamento →
> `desenvolver`). Refino melhora o que funciona; correção restaura o que quebrou.

> As **paradas** do auto-run são `pronta` (go/no-go: decida construir), `com-design` (revise o
> design antes de gastar tokens caros de build) e `revisao` (revisão humana final). Cada board
> decide o resto: num board solto todas as demais colunas produtoras rodam sozinhas; num board
> conservador as colunas de design/plano e as que escrevem código (`design-ux`, `plano-tecnico`,
> `desenvolver`, `revisar-codigo`, `qa-automatizado`) nascem **manuais** (`autorun: false`), por
> conservadorismo de produção — dispare-as com "Rodar agora" ou ligando o toggle da coluna.

### Ramificação por storyType

O pipeline é **ciente do `storyType`**: ele foi desenhado para stories `user` (com tela),
mas uma story `technical`/`chore`/`spike`/`bug` **não tem superfície de UI**. Para que cards
de infra (ex.: a SM-1, isolamento por worktree) não precisem ser arrastados na mão por colunas
que não têm o que desenhar, o caminho ramifica:

- **`user`** → percorre o pipeline INTEIRO: `pronta` → `design-ux` → `com-design` → `plano-tecnico`
  → … → `qa-automatizado` (E2E de aceite + sweep visual) → `revisao`.
- **`technical`/`chore`/`spike`/`bug`** → **pula o bloco de design** (`design-ux` + `com-design`):
  a cascata avança direto de `pronta`/`design-ux` para `plano-tecnico` (kernel
  `lib/storymap/pipeline-routing.ts` → `nextBuildStatus`/`skipsStatusForType`, consumido por
  `cascade-decision.ts`). E no `qa-automatizado` o gate concreto é a **suíte** (`just test-<pkg>`)
  verde + as lentes do `harness-review`, NÃO seed+E2E+visual. O gate `hasQaPassed` já é type-aware
  (`storyType !== "user"` destrava sem `qaPassed`), então design-skip e QA-skip andam em par.

O skip do bloco de design vale **independente do toggle `autorun`** da coluna: o
`decideCascade` avalia o branch de skip **antes** do guard de parada manual, então uma story
não-`user` é encaminhada para fora de `design-ux`/`com-design` mesmo quando essas colunas são
`autorun: false` — o auto-skip funciona em **todos os boards** (não só onde `design-ux` é
`autorun: true`). Efeito colateral **aceito**: um card não-`user` "estacionado" de propósito
numa coluna de design **será empurrado** — um tipo sem superfície de UI nunca descansa numa
coluna de design. A parada manual continua governando todo status **não-skip** (ex.: o go/no-go
`pronta`) e toda story `user`.

O caminho `user` é **idêntico ao anterior** (guarda de não-regressão). O `harness-ux` também faz
short-circuit se acionado na mão sobre um card não-`user` (encaminha sem gerar jornada).

### Gates (regras)

| gate | passa quando |
|------|--------------|
| `hasNarrative` | `narrative.role`, `narrative.want` e `narrative.soThat` todos preenchidos |
| `hasRefinement` | `hasNarrative` **e** `acceptance.length >= 1` — gate de entrada em `priorizar` |
| `hasTasks` | `tasks.length >= 1` — gate de entrada em `desenvolver` |
| `hasRice` | `rice` tem `reach`, `impact`, `confidence` e `effort` preenchidos, com `effort > 0` |
| `hasPrioritization` | **type-aware** (Fase 2): feature → `hasRice`+`kano`+`funnelStage`; bug → `severity`+`frequency`; melhoria → `impact`+`effort` — gate de entrada em `pronta`. Ver `frameworks.md` §4 (WSJF `priorityScore`). |
| `hasTechPlan` | `techPlanReady: true` (o `harness-plan` escreveu `plans/<id>.md`) — gate de entrada em `quebrar-tasks` |
| `hasWireframe` | `wireframeChosen` preenchido (o artefato de tela PRIMÁRIO do canvas — ou uma opção legada — de `wireframes/<id>.json`) — gate de entrada em `com-design` |
| `hasNoBlockers` | nenhum `findings[]` com `severity: blocker` **e** `status: open` — gate de entrada em `qa-automatizado` |
| `hasQaPassed` | `qaPassed: true` (QA de aceite E2E + visual verde; só user stories) — gate de entrada em `revisao` |
| `hasRefineBrief` | `refinement.brief` preenchido — gate de `refinar` (modo melhoria) |
| `hasBugReport` | `bugReport.brief` preenchido — gate de `corrigir` (modo correção) |

> O `hasNarrative`/`hasRefinement` é o **gate brando** do template: o card pode
> nascer sem narrativa (captura rápida), mas para entrar em `priorizar` a story precisa
> da narrativa completa **+** ≥1 critério de aceite. A UI avisa (sem bloquear) enquanto
> a narrativa estiver incompleta.

Implementação: `packages/storymap-ui/src/lib/storymap/gates.ts` (`checkGate(card, statusId, config)`
retorna `null` quando permitido ou a mensagem PT-BR de bloqueio).

## `cards/<id>.md` — frontmatter

| campo | tipo | descrição |
|-------|------|-----------|
| `id` | string | **igual ao nome do arquivo** (charset `a-z0-9-`). Usado em `parent`/`links`/branches de run. **Gerado UMA vez e IMUTÁVEL** pelo resto do ciclo de vida do card — story nasce com id **aleatório** (`story-a1b2c3`) e nenhuma skill/transformação o reescreve (contrato travado no código por `pinCardId` → `updateCardOnDisk`). Ids slug legados (cards antigos já renomeados) permanecem válidos e congelados, sem rebatismo retroativo. |
| `type` | `activity` \| `step` \| `story` | nível do card |
| `title` | string | título curto |
| `status` | id de `board.yaml.statuses` \| `null` | estágio no pipeline |
| `parent` | id do card pai \| `null` | activity p/ step, step p/ story; `null` p/ activity |
| `release` | id de `board.yaml.releases` \| `null` | só stories; `null` = sem release |
| `storyType` | `user`\|`technical`\|`spike`\|`bug`\|`chore` | só stories. Natureza da story → escolhe o template da narrativa. Default `user`. Ver `frameworks.md`. |
| `mode` | `build` \| `refine` \| `fix` (omitido = build) | modo de execução. `refine` = reaberta para melhoria (botão **Refinar**); `fix` = reaberta porque quebrou (botão **Reportar bug**); as `harness-*` trabalham in-place em vez de recriar. |
| `refinement` | `{ brief, kinds, target, screenshot, openedAt }` \| omitido | brief do refino: `brief`=feedback livre (carrega a intensidade polir↔redesenhar); `kinds`=lista de `ui`\|`ux`\|`copy`\|`functionality` (uma ou mais — pode combinar); `target`=rota/tela; `screenshot`=arquivo em `refine/<id>/`. Setado pelo botão Refinar; limpo pelo `harness-review` ao entregar. |
| `bugReport` | `{ brief, severity, expected, actual, steps, target, screenshot, openedAt }` \| omitido | relato do bug (modo `fix`): `brief`=relato livre; `severity`=`blocker`\|`high`\|`medium`\|`low`; `expected`×`actual`=comportamento correto vs quebrado; `steps`=passos de reprodução; `target`=rota/tela; `screenshot`=arquivo em `bugs/<id>/`. Setado pelo botão Reportar bug; limpo pelo `harness-review` ao entregar. |
| `personas` | lista de ids de `board.yaml.personas` | |
| `systems` | lista de ids de `board.yaml.systems` | sistemas genéricos do board (sem marca) |
| `links` | lista de `{ rel, to }` | `rel` = id de `linkTypes`, `to` = id de outro card |
| `narrative` | `{ role, want, soThat }` | só stories. A user story Agile (3 partes). Parte do gate `hasRefinement` (entrada em `priorizar`). Preenchida por `harness-enrich`. |
| `acceptance` | lista de strings | critérios de aceite (Gherkin recomendado). Parte do gate `hasRefinement` (entrada em `priorizar`). Preenchido por `harness-enrich`. |
| `tasks` | lista de `{ id, title, done }` | quebra em tarefas. Gate `hasTasks` (entrada em `desenvolver`). Preenchido por `harness-tasks`. |
| `rice` | `{ reach, impact, confidence, effort }` | inputs RICE (número ou `null`). Parte do gate de `pronta`. |
| `kano` | `must-be`\|`performance`\|`attractive`\|`indifferent`\|`reverse`\|`null` | categoria KANO (forma da satisfação). Parte do gate de `pronta`. Ver `frameworks.md`. |
| `funnelStage` | `awareness`\|`acquisition`\|`activation`\|`retention`\|`referral`\|`revenue`\|`null` | estágio do funil AAARRR (objetivo). Parte do gate de `pronta`. Ver `frameworks.md`. |
| `techPlanReady` | `true` (omitido se não) | ponteiro leve: o `harness-plan` escreveu `plans/<id>.md`. Gate `hasTechPlan` (entrada em `quebrar-tasks`). |
| `wireframeChosen` | id do artefato/opção \| omitido | ponteiro leve: o artefato de tela PRIMÁRIO do canvas (ou a opção legada escolhida) em `wireframes/<id>.json`. Gate de `com-design`. |
| `findings` | lista de `{ id, lens, severity, title, status, detail?, file?, line?, suggestion? }` | achados do `harness-review`. `lens`=firestore\|nextjs\|perf\|security\|testing\|general; `severity`=blocker\|high\|medium\|low; `status`=open\|acknowledged\|fixed\|wontfix. Um `blocker` `open` trava o gate `hasNoBlockers` (entrada em `qa-automatizado`). Só emitido quando ≥1. |
| `reviewedAt` / `reviewCommit` | string \| omitido | quando o `harness-review` rodou + o commit/HEAD revisado. |
| `questions` | lista de `{ id, text, status, askedBy?, askedAt?, answer?, answeredAt?, context?, mode?, options?, selectedOptionIds?, recommendation? }` \| omitido | perguntas HITL na **Pilotagem** — o canal agente↔orquestrador humano. Qualquer `harness-*` que bata numa decisão que **só o humano resolve** grava uma pergunta rica aqui e PAUSA o run (protocolo **ASK_HUMAN**, abaixo). `text`=a pergunta; `context`=o PORQUÊ/stakes (1-2 linhas); `options[]`=caminhos discretos, cada um com `pros[]`/`cons[]` e no máx. UMA com `recommended: true`; `mode`=`single`\|`multi`; `recommendation`=recomendação em prosa quando NÃO há opções discretas. `status: open` até o humano responder na Pilotagem; o free-text answer está sempre disponível. Setado por `harness-grill` e por qualquer skill via ASK_HUMAN; resolvido na UI `/perguntas`. |
| `order` | número | ordenação entre irmãos. Esparso (10, 20, 30…); arrastar insere o ponto médio |
| `created` / `updated` | string `YYYY-MM-DD` | a UI atualiza `updated` ao salvar |

O corpo (abaixo do `---`) é a **descrição técnica**: markdown livre com contexto e
notas (o editor rotula esse campo como "Descrição técnica"). Os critérios de aceite
viraram o campo estruturado `acceptance`; as tarefas viraram `tasks` (não use mais
checklists `- [ ]` no corpo para isso) — **não duplique os critérios no corpo**.

### Tipos de story e template de escrita

Toda **story** declara um `storyType` que escolhe o **template da narrativa** — a user
story Agile preenchida nos 3 campos de `narrative` (`role` / `want` / `soThat`). O título
continua um rótulo curto no **imperativo** (estilo Patton: "Ver eventos no feed"); a
narrativa é o contrato Agile, separada do título.

| `storyType` | quando usar | template (`role` · `want` · `soThat`) |
|-------------|-------------|----------------------------------------|
| `user` | capacidade voltada ao usuário final (o padrão) | **Como** \<persona\>, **quero** \<ação\>, **para** \<benefício\>. |
| `technical` | infra/enabler que viabiliza valor (sem face de usuário) | **Para viabilizar** \<sistema\>, **precisamos** \<trabalho\>, **de modo que** \<resultado\>. |
| `spike` | investigação time-boxed para reduzir incerteza | **Para decidir** \<questão\>, **precisamos investigar** \<hipótese\>, **de modo que** \<decisão\>. |
| `bug` | corrigir comportamento quebrado vs. o esperado | **Como** \<persona\>, **quero** \<que X volte a funcionar\>, **para** \<benefício restaurado\>. |
| `chore` | manutenção sem valor direto (upgrade, limpeza) | **Para manter** \<área\>, **precisamos** \<tarefa\>, **de modo que** \<resultado\>. |

> Fonte da verdade dos tipos/conectores/cores: `packages/storymap-ui/src/lib/storymap/frameworks.ts`
> (`STORY_TYPE_DEFS`). Os conectores (`Como`/`quero`/`para` vs `Para`/`precisamos`/`de modo que`)
> mudam conforme o `storyType` — guarde só o **miolo** em cada campo, sem repetir o conector
> (ex.: `role: explorador urbano`, não `role: Como explorador urbano`).

**Critérios de aceite (Gherkin recomendado).** Prefira o formato **Dado / Quando / Então**
em cada item de `acceptance` (testável, mapeia direto p/ `harness-tasks`/`harness-tests`); frases de
resultado ("Após X, o usuário vê Y") seguem válidas para regras simples.

**Qualidade (INVEST + Definition of Ready).** Antes de avançar para `priorizar`, a story deve ser
**I**ndependente, **N**egociável, **V**aliosa, **E**stimável, **S**mall e **T**estável; e
estar *pronta* = narrativa completa + ≥1 critério de aceite + persona/sistemas coerentes.

### `riceScore` é derivado

O **score RICE não é armazenado**. Ele é calculado a partir de `rice`:

```
riceScore = (reach * impact * confidence) / effort
```

Retorna `null` enquanto algum dos quatro inputs faltar ou `effort <= 0`.
Implementação: `packages/storymap-ui/src/lib/storymap/rice.ts` (`riceScore(rice)`).
A view de priorização ordena pelas stories que já têm `riceScore`.

### Exemplo de story com os campos novos

```yaml
---
id: story-sso
type: story
title: Manter sessão entre apps (SSO)
storyType: user
status: pronta
parent: step-autenticar
release: r1
personas: [explorador]
systems: [auth, sdk]
links:
  - { rel: depends-on, to: story-otp }
narrative:
  role: explorador urbano
  want: continuar logado ao circular entre os apps do ecossistema
  soThat: não precisar refazer login a cada app
acceptance:
  - Dado que fiz login em um app, quando abro outro app do ecossistema, então sigo autenticado sem novo login.
  - O cookie de sessão é emitido no domínio `.example.com`.
tasks:
  - { id: t1, title: Emitir session cookie no domínio .example.com, done: false }
  - { id: t2, title: Hidratar sessão nos sub-apps via checkSession(), done: false }
rice:
  reach: 600
  impact: 2
  confidence: 0.7
  effort: 8
kano: must-be
funnelStage: retention
order: 20
created: "2026-06-02"
updated: "2026-06-02"
---

Após o login, a sessão (`__session`) vale em todos os apps do ecossistema.
```

> Lê-se: *"Como **explorador urbano**, quero **continuar logado ao circular entre os apps**,
> para **não precisar refazer login a cada app**."* — os conectores vêm do `storyType: user`.

### `type: opportunity` — Opportunity Solution Tree (OST)

Além de `activity`/`step`/`story`, cards podem ter `type: opportunity` para representar
**dores rastreadas** na camada intermediária da OST (North Star → Input Metrics →
**Opportunities** → Stories).

| campo | tipo | descrição |
|-------|------|-----------|
| `type` | `"opportunity"` | Card de dor (não é uma story) |
| `personas` | `string[]` | Ids de personas que sentem esta dor — usa o `personas` do próprio card (fonte única), não um campo no bloco `opportunity` |
| `opportunity.statement` | string | A dor em uma frase curta (obrigatório; `null` se ausente) |
| `opportunity.evidence` | string \| `null` | Evidência empírica (entrevistas, dados) |
| `opportunity.status` | `open`\|`exploring`\|`addressed` | Estado da investigação |
| `owner` | `human`\|`proposable`\|`agent` \| omitido | Classe de autoria. Opportunities criadas por agente nascem com `owner: proposable` (proposta, não canônica até confirmação humana). |

#### Bloco `bet` nas stories

Stories podem carregar uma aposta Lean de hipótese:

| campo | tipo | descrição |
|-------|------|-----------|
| `bet.assumptions` | `string[]` | Hipóteses que sustentam esta story (≥1 para o bloco existir) |
| `bet.riskiestAssumption` | string \| `null` | A hipótese mais arriscada (a testar primeiro) |
| `bet.experimentStatus` | `untested`\|`testing`\|`validated`\|`invalidated` | Estado do experimento |

#### Aresta `addresses` (story → opportunity)

O `linkType` `addresses` (declarado em `_base/board.yaml`) liga uma story à dor que ela
resolve. Use em `links[]`:

```yaml
links:
  - { rel: addresses, to: opp-<id> }
```

Helpers: `isAddressesLink(link)` / `resolvesToOpportunity(links)` em
`packages/storymap-ui/src/lib/storymap/opportunity.ts`.

Vocabulários completos (Def/IDS/guard): `frameworks.ts` (`OPPORTUNITY_STATUSES`,
`EXPERIMENT_STATUSES`, `OWNER_IDS`). Coerção tolerante: `coerceCard` em `repo.ts`.
Contrato Zod: `OpportunityFieldsSchema`/`BetSchema` em `contracts.ts`.

## `board.yaml`

```yaml
id: demo                     # = nome da pasta
name: Demo
package: packages/<app>      # opcional: pasta de código relacionada
statuses:                    # pipeline; cada status pode ter gate, trigger e/ou autorun
  - { id, name, color }
  - { id, name, color, gate: <hasRefinement|hasTasks|hasPrioritization|hasTechPlan|hasWireframe|hasNoBlockers|hasRefineBrief|hasBugReport> }
  - { id, name, color, trigger: <harness-enrich|harness-tasks|harness-prioritize|harness-plan|harness-ux|harness-do|harness-review|harness-refine|harness-fix> }
  - { id, name, color, autorun: true }   # toggle do Kanban: roda a skill / encaminha (ver "Auto-run e cascata")
  - { id, name, color, trigger: harness-do, model: opus, effort: max, maxTurns: 30, costGuard: true }  # policy por coluna (Fase A): model haiku|sonnet|opus; effort low|medium|high|xhigh|max
releases:   [{ id, name, order }]   # linhas (slices); order define a sequência
personas:   [{ id, name, color }]
systems:    [{ id, name, color }]   # sistemas genéricos do board (sem marca)
linkTypes:  [{ id, name, from?: NodeKind[], to?: NodeKind[] }]
             # from/to opcional: ausente = sem restrição (legados). NodeKind = activity | step |
             # story | persona | release | desiredOutcome | inputMetric | opportunity | canvas.
             # Validação de pontas: validateBoardLinks (link-graph.ts). 4 legados herdados via
             # _base sem from/to + 5 tipados (serves/references/moves/addresses/targets).
```

`gate` e `trigger` são opcionais por status. Use **só** os ids das tabelas acima
(o parser ignora valores desconhecidos).

## Contrato de automação (`harness-*`)

As skills de automação operam sobre os status que declaram `trigger`:

1. **`harness-enrich`** (status `enriquecer`): lê título + corpo, classifica o `storyType`,
   escreve a `narrative` (no template do tipo) + `acceptance[]` (Gherkin recomendado) e
   move o card para `priorizar` (o gate `hasRefinement` então passa na entrada).
2. **`harness-prioritize`** (status `priorizar`): classifica a story preenchendo `rice`,
   `kano` e `funnelStage` (rubrica em **`frameworks.md`**) e move para `pronta` (o gate
   `hasPrioritization` então passa). `pronta` é **PARADA go/no-go** — o humano aprova o build.
3. **`harness-ux` + `harness-ui`** (status `design-ux` → `design-ui`): **só rodam para stories
   `user`**. O `harness-ux` desenha a JORNADA como grafo estruturado (nós/arestas, renderizado
   como diagrama SVG real) + narrativa no bloco `journey`; o `harness-ui` (mesma sessão,
   threadSession) compõe o CANVAS de artefatos (telas com estados-chave, componentes,
   sub-fluxos, notas — formatos dsl/html-sandboxed/graph/text) em `artifacts[]`, define o
   artefato primário (grava `wireframeChosen`) e move para `com-design` (gate
   `hasWireframe`). `com-design` é **PARADA** — o humano avalia o canvas POR ARTEFATO
   (aprovar · pedir mudança · trocar o primário; a thread vive em `feedback[]` do sidecar) e
   "Pedir ajuste" devolve para `design-ui` (só telas) ou `design-ux` (fluxo questionado). Um
   card `technical`/`chore`/`spike`/`bug` **não tem superfície de UI**: a cascata o pula
   direto de `design-ux` para `plano-tecnico` (ver "Ramificação por storyType"), e o
   `harness-ux`, se acionado na mão, faz short-circuit (não gera jornada, só encaminha com uma
   nota).
4. **`harness-plan`** (status `plano-tecnico`): escreve o plano técnico no sidecar
   `plans/<id>.md`, marca `techPlanReady: true` e move para `quebrar-tasks` (gate `hasTechPlan`).
   (O plano é escrito ANTES da quebra em tasks — o `harness-tasks` decompõe informado por ele.)
5. **`harness-tasks`** (status `quebrar-tasks`): gera `tasks[]` a partir dos critérios de
   aceite + o plano técnico e move para `desenvolver` (o gate `hasTasks` então passa na entrada).
6. **`harness-do`** (status `desenvolver`): implementa as tasks (TDD), marca `done` e move
   para `revisar-codigo`.
7. **`harness-review`** (status `revisar-codigo`): roda lentes de review no diff, auto-corrige o
   seguro (guardado por testes) e escala segurança/arquitetura como `findings` `blocker:open`;
   move para `qa-automatizado` quando não há blocker aberto (gate `hasNoBlockers`).
8. **`harness-qa`** (status `qa-automatizado`): **ramifica por storyType**. `user` → sobe o stack
   dev seedado, roda os critérios de aceite de ponta a ponta (E2E) + sweep visual headless, marca
   `qaPassed` e move para `revisao` (gate `hasQaPassed`). `technical`/`chore`/`spike`/`bug` → o
   gate concreto é a **suíte do pacote** (`just test-<pkg>`) verde + as lentes do `harness-review` —
   sem seed/E2E/visual; suíte vermelha vira um finding `testing: blocker` e NÃO destrava o gate.
   `revisao` é a **PARADA** final — revisão humana do que foi entregue.
9. **`harness-refine`** (status `refinar`, **modo melhoria**): triagem de uma story já entregue,
   reaberta pelo botão **Refinar**. Diagnostica a implementação que JÁ existe (read-only),
   reescreve `acceptance` como um DELTA e **reconcilia as `tasks`** (as do build estão
   `done`/obsoletas: regenera-as do delta na rota `desenvolver`; limpa-as p/ re-derivar no
   build na rota `design-ux`) antes de ROTEAR o card — UI/UX gera novas opções e cai em
   `design-ux`; copy/funcionalidade cai em `desenvolver`. NÃO repassa por
   `quebrar-tasks`/`priorizar` (evita re-priorizar). Mantém `mode: refine`; as `harness-*` a
   jusante melhoram in-place. Ver **["Modo refino"](#modo-refino-melhoria-de-stories-prontas)**.
10. **`harness-fix`** (status `corrigir`, **modo correção**): triagem de uma story já entregue que
   QUEBROU, reaberta pelo botão **Reportar bug**. Diagnostica e **REPRODUZ** a regressão no
   código que já existe (read-only), reescreve `acceptance` como esperado×atual e **reconcilia
   as `tasks`** (regenera-as com um teste de reprodução como #1 na rota `desenvolver`; limpa-as
   p/ re-derivar no build na rota `design-ux`) antes de ROTEAR — regressão visual → `design-ux`;
   comportamento/copy → `desenvolver`. NÃO repassa por `quebrar-tasks`/`priorizar` (evita
   re-priorizar). Mantém `mode: fix`; as `harness-*` a jusante corrigem in-place com guard de
   regressão. Ver **["Modo correção"](#modo-correção-bug-em-stories-prontas)**.

Regra de ouro: **gates bloqueiam o avanço sem os critérios**. Uma automação que tente
mover um card para um status com gate sem preencher o campo correspondente é recusada
(`checkGate` retorna a mensagem). Por isso a sequência é sempre enriquecer → priorizar →
pronta → design UI/UX → com design → plano técnico → quebrar tasks → desenvolver →
revisar código → QA automatizado → revisão.

> Priorização (RICE · KANO · funil AAARRR): a rubrica de classificação está em
> **`storymap/frameworks.md`** — leia antes de preencher `kano`/`funnelStage`.

### Auto-run e cascata (toggle `autorun` por coluna)

Cada status tem um campo **`autorun`** (toggle no Kanban — pílula "⚡ auto" / "manual"). Com o
serviço do AgileHarness rodando, quando um card **entra** num status `autorun: true`, o channel
**`trigger-runner`** (`lib/notifications/server/channels/`) faz uma de duas coisas:

- status **com `trigger`** (enriquecer/priorizar/design-ux/plano-tecnico/quebrar-tasks/
  desenvolver/revisar-codigo/qa-automatizado) → **roda a skill**
  (spawna `claude -p "/<trigger> <board>/<id>"` via shell, headless);
- status **de pouso** (gate, sem trigger) → **encaminha** o card pra próxima coluna (a ponte da
  cascata). Após a reforma, as colunas de pouso pass-through foram removidas e todo produtor
  carrega um trigger — esse ramo só dispara se você ligar `autorun` numa parada.

`autorun` ≠ true = **manual**: o card para ali — **exceto** o bloco de design para stories
não-`user`, que a cascata pula mesmo sob `autorun: false` (ver "Ramificação por storyType").
Compondo os toggles você monta a cascata. O
**default** (`board.yaml`) roda **enriquecer → priorizar** sozinho e **PARA em `pronta`** (go/no-go);
depois das paradas que o humano libera (`pronta`, `com-design`) a cascata segue pelos produtores
até a parada final `revisao`. Num board conservador as colunas de design/código nascem manuais.

A skill também roda em modo **pull** quando você a chama (`/harness-enrich …`, `/harness run`).

- **Master switch:** o channel se registra a menos que `AGILEHARNESS_AUTORUN=0` — ponha em
  `packages/storymap-ui/.env.local` (o Next carrega no runtime; env de shell nem sempre sobrevive
  ao hop turbo → next dev no Windows). Requer **SSE ativo** (aba do board aberta) + `claude` no PATH.
- **Permissões:** `harness-do`/`harness-review` (código+testes) e `harness-enrich` (edita o card in place) rodam com
  `--dangerously-skip-permissions`; `harness-tasks`/`harness-prioritize`/`harness-plan`/`harness-ux` com `acceptEdits`.
- **Sem loop:** a skill move o card pra fora do trigger e o forward só avança (monotônico); lock
  por card + cap de concorrência. Atua em `card.moved` E `card.created` (cobre o card renomeado).
- **Pegou o código novo?** O dispatcher é singleton (cache `globalThis`) → **reinicie** o
  `dev-storymap` após mudar o channel.
- **Config (Fase A+):** o painel **Configuração** (`/board/<id>/config`) edita `storymap/settings.yaml`
  (kill switch, paralelismo, watchdogs, modelo/effort fallback); a policy por coluna
  (`model`/`effort`/`maxTurns`/`costGuard`) fica no `board.yaml`. Precedência: defaults <
  `settings.yaml` < env (`AGILEHARNESS_AUTORUN_*` sempre vence). Vars: `AGILEHARNESS_AUTORUN` (=0 desliga), `AGILEHARNESS_AUTORUN_MAX`,
  `AGILEHARNESS_AUTORUN_TIMEOUT_MS`, `AGILEHARNESS_AUTORUN_TIMEOUT_DO_MS`, `AGILEHARNESS_AUTORUN_CLAUDE_BIN`,
  `AGILEHARNESS_AUTORUN_EXTRA_ARGS`, `AGILEHARNESS_AUTORUN_NO_STREAM` (=1 dropa o stream-json do console, mantém resume),
  `AGILEHARNESS_AUTORUN_OPEN_TERMINAL` (=1 habilita "abrir terminal" do card).
- **Terminal ao vivo (Fase B):** o spawn usa `--output-format stream-json --verbose --session-id <uuidv5>`;
  o card ganha um console read-only (ícone 🖥) e um botão para copiar `claude --resume <id>` (assumir a run).

### Protocolo ASK_HUMAN (qualquer `harness-*` pode pedir ajuda ao humano e PAUSAR o run)

A **Pilotagem** (o cockpit por board) é o canal de comunicação **agente↔orquestrador humano**.
Qualquer skill `harness-*` — `harness-plan`, `harness-do`, `harness-review`, `harness-ux`, `harness-enrich`, … — ao bater
numa decisão que **SÓ o humano resolve** (uma escolha de produto/escopo/arquitetura que ela não tem
base para decidir sozinha, ou um dado/credencial que falta), pode **fazer uma pergunta rica e pausar
o run** em vez de chutar ou de inventar um fato. O mecanismo:

1. **Escreve uma `question` no card** (campo `questions[]` do frontmatter — mesmo schema do `harness-grill`):
   `text` (a pergunta), `status: open`, `askedBy: <trigger>`, `askedAt`, e **SEMPRE** `context:`
   (o PORQUÊ — as stakes, o que muda conforme a resposta). Quando há caminhos discretos, dá `options[]`
   com `pros[]`/`cons[]` por opção e no máximo UMA `recommended: true`; quando é pergunta aberta,
   pode dar `recommendation:` em prosa. Tudo é **análise honesta de caminhos plausíveis, nunca fato
   inventado** — o free-text answer do humano sempre sobrepõe.
2. **PAUSA o run** sinalizando "aguardando humano": a skill encerra sem avançar o status — o card
   FICA na coluna atual com a pergunta aberta. (O engine reconhece o marcador de saída ASK_HUMAN,
   grava em `card.questions`, marca o run "aguardando humano" e encerra — ver a story
   `storymap/cards/story-kddsb9.md`, que descreve esse mecanismo de captura/retomada.)
3. **Retoma quando respondida**: o humano responde na Pilotagem / `/perguntas` (escolhe uma opção
   e/ou escreve livre); a skill da coluna é **re-disparada stateless** e lê as respostas no card
   (`status: answered` + `answer`/`selectedOptionIds`) como contexto, seguindo o trabalho.

Princípios: **nunca fabricar fatos** (prós/contras e recomendação são caminhos plausíveis, não
respostas inventadas); **só pergunte o que é genuinamente do humano** (não delegue de volta o que a
skill consegue diagnosticar/decidir); e **prefira pausar a chutar** numa decisão de produto irreversível.
O `harness-grill` é o caso especializado deste protocolo na coluna `grill` (levanta as incógnitas ANTES
da spec); o ASK_HUMAN genérico é o mesmo schema disponível em **qualquer** coluna, no meio do run.

## Modo refino (melhoria de stories prontas)

Uma story em `revisao` ou `concluida` pode ser **reaberta para melhoria** (UI, UX,
copywriting ou funcionalidade) sem virar um card novo e sem manter histórico do original —
é a MESMA story, agora marcada com `mode: refine`. O objetivo é deixar **claro ao agente que
aquilo JÁ EXISTE** (para ele melhorar in-place, não recriar do zero).

1. **Disparo (UI).** O botão **Refinar** (no editor de um card em **Revisão** ou **Concluída**) abre um modal:
   feedback em **texto livre** (obrigatório — carrega o QUE melhorar e a INTENSIDADE:
   polir ↔ redesenhar), um ou mais **tipos** (`ui`\|`ux`\|`copy`\|`functionality` — pode
   combinar), um **alvo** opcional (rota/tela) e um **screenshot** opcional do estado atual. A ação grava
   `mode: refine` + `refinement` no card e o move para `refinar`.
2. **Triagem (`harness-refine`).** Ao entrar em `refinar` (autorun), o `harness-refine` diagnostica
   o código/UX que já existe (read-only), escreve um bloco `## Refino` no corpo, reescreve
   `acceptance` como um DELTA, **reconcilia as `tasks`** (as do build estão `done`/obsoletas:
   regenera-as do delta na rota `desenvolver`, ou as limpa p/ re-derivar no build na rota
   `design-ux`) e ROTEIA o card — UI/UX → `design-ux` (com novas opções de wireframe
   enviesadas pela intensidade); copy/funcionalidade → `desenvolver`.
3. **Execução mode-aware.** `harness-ux`/`harness-do`/`harness-review` leem `mode: refine` e MELHORAM
   in-place: partem do `## Refino` e do código existente, com guard de regressão reforçado.
   As paradas humanas continuam as mesmas do build (aprovar o design, rodar o dev).
4. **Entrega.** Ao avançar `revisar-codigo → revisao`, o `harness-review` LIMPA o marcador
   (`mode`/`refinement`) — a story volta a ser uma `concluida` comum.

> O marcador é um **campo tipado** (`mode`), não uma tag freeform — renderiza como o chip
> **REFINO** no card. A coluna `refinar` fica logo ANTES de `concluida` (a terminal) no
> board; o `harness-refine` roteia de volta para a coluna certa. A intensidade NÃO é um campo:
> sai do texto do brief (o agente infere).

## Modo correção (bug em stories prontas)

Uma story em `revisao` ou `concluida` que **quebrou** pode ser reaberta para correção sem virar
um card novo — é a MESMA story, agora com `mode: fix`. É o irmão do modo refino: lá você MELHORA
o que funciona, aqui você RESTAURA o que regrediu.

1. **Disparo (UI).** O botão **Reportar bug** (no editor de um card em **Revisão** ou
   **Concluída**) abre um modal: relato em **texto livre** (obrigatório), **severidade**
   (`blocker`\|`high`\|`medium`\|`low`), **esperado × atual**, **passos de reprodução**, um **alvo**
   opcional (rota/tela) e um **screenshot** opcional do estado quebrado. A ação grava `mode: fix`
   + `bugReport` no card e o move para `corrigir`.
2. **Triagem (`harness-fix`).** Ao entrar em `corrigir` (autorun), o `harness-fix` diagnostica e
   **REPRODUZ** a regressão no código que já existe (read-only), escreve um bloco `## Bug` no
   corpo, reescreve `acceptance` como esperado×atual, **reconcilia as `tasks`** (regenera-as com
   um teste de reprodução como #1 na rota `desenvolver`; ou as limpa p/ re-derivar no build na
   rota `design-ux`) e ROTEIA — regressão visual → `design-ux` (novas opções com o estado
   correto); comportamento/copy → `desenvolver`.
3. **Execução mode-aware.** `harness-do`/`harness-ux`/`harness-review` leem `mode: fix` e CORRIGEM in-place:
   o `harness-do` escreve PRIMEIRO o teste que reproduz o bug (red) e só então corrige (TDD ao
   contrário), com guard de regressão reforçado.
4. **Entrega.** Ao avançar `revisar-codigo → revisao`, o `harness-review` LIMPA o marcador
   (`mode`/`bugReport`) — a story volta a ser uma `concluida` comum.

> O marcador é um **campo tipado** (`mode: fix`) — renderiza como o chip **BUG** (com a
> severidade) no card. A coluna `corrigir` fica ao lado de `refinar`, logo antes de `concluida`.
> Um card carrega **um** bloco de reabertura por vez: reportar um bug limpa um refino pendente e
> vice-versa (não dá pra ter refino e bug abertos juntos na mesma story).

## Para agentes — criar/editar um card

1. Leia o `board.yaml` do board para conhecer ids válidos de status/release/persona/system/linkType,
   e **quais status têm gate** (você precisa preencher o campo antes de mover para lá).
2. **Criar:** escreva `storymap/boards/<board>/cards/<novo-id>.md` com o frontmatter acima.
   - Escolha um `id` único no charset `a-z0-9-`; ele é o nome do arquivo.
   - Defina `parent` correto (story→step, step→activity) e, para story, `release`.
   - Inicie em `triage` (a Triagem, staging — porta única de entrada); arrays vazios (`acceptance: []`, `tasks: []`),
     `narrative: { role: null, want: null, soThat: null }` e
     `rice: { reach: null, impact: null, confidence: null, effort: null }` são o default seguro.
     Para story, defina `storyType` (default `user`) e, sempre que possível, já escreva a narrativa.
   - Para inserir no fim de um grupo, use um `order` maior que o dos irmãos (ex.: último + 10).
3. **Editar:** altere o frontmatter/corpo do arquivo do card.
4. **Avançar de status:** preencha o gate antes (narrativa + aceite → tasks → priorização) e então mude `status`.
5. **Mover/reordenar:** mude `parent`, `release` e/ou `order`.
6. **Excluir:** apague o arquivo e remova referências (`parent`/`links`) em outros cards.

Mantenha um campo por linha quando possível para diffs limpos. Não invente ids de
status/persona/sistema fora do `board.yaml` — adicione-os ao `board.yaml` antes.
```
