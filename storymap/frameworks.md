# StoryMap — frameworks de priorização (RICE · KANO · Funil AAARRR)

Rubrica canônica para classificar uma **story**. Usada pela automação `harness-prioritize`
e por qualquer humano/agente que preencha a priorização. As três dimensões são
**ortogonais** e juntas respondem perguntas diferentes:

| dimensão | pergunta que responde | campo no card |
|----------|-----------------------|---------------|
| **RICE** | Quanto vale o esforço? (score relativo) | `rice: { reach, impact, confidence, effort }` |
| **KANO** | Que *tipo* de aposta é? (forma da satisfação) | `kano` |
| **Funil AAARRR** | Que objetivo de negócio move? | `funnelStage` |

> Fonte da verdade dos valores/labels/cores: `packages/storymap-ui/src/lib/storymap/frameworks.ts`.
> Não invente categorias fora das listas abaixo.

---

## 0. Tipo de story (`storyType`) e narrativa

Antes de priorizar, toda **story** é classificada por **natureza** (`storyType`), que
escolhe o **template de escrita** da `narrative` (3 partes: `role` / `want` / `soThat`).
O **título nomeia a INTENÇÃO/RESULTADO, nunca o mecanismo/solução** (o *como* é o
`/harness-plan`); a narrativa é o contrato Agile. A forma do título muda por tipo (tabela abaixo).

| `storyType` | quando usar | conectores (`role` · `want` · `soThat`) |
|-------------|-------------|------------------------------------------|
| `user` | capacidade voltada ao usuário final (o padrão) | **Como** · **quero** · **para** |
| `technical` | infra/enabler sem face de usuário direta | **Para viabilizar** · **precisamos** · **de modo que** |
| `spike` | investigação time-boxed p/ reduzir incerteza | **Para decidir** · **precisamos investigar** · **de modo que** |
| `bug` | corrigir comportamento quebrado vs. esperado | **Como** · **quero** (que X volte a funcionar) · **para** |
| `chore` | manutenção sem valor direto (upgrade, limpeza) | **Para manter** · **precisamos** · **de modo que** |

**Título por tipo** (fonte única: `titleGuide` em `STORY_TYPE_DEFS`, `frameworks.ts`) — o título
nomeia a INTENÇÃO/RESULTADO, nunca o mecanismo:

| `storyType` | o título nomeia | ✓ bom | ✗ ruim |
|-------------|-----------------|-------|--------|
| `user` | o objetivo/resultado do usuário (≈ want condensado) | "Ler o estado de um run sem entrar em edição" | "Redesenhar modal com view leitura/edição" |
| `technical` | o resultado de produto habilitado | "Runs não-UI sobem sem Chrome ocioso" | "Escopar o MCP no .mcp.json" |
| `spike` | a decisão/pergunta a responder | "Decidir se graphify vale no harness-review" | "Spike de graphify" |
| `bug` | o comportamento quebrado (visão do usuário) | "Card arquivado continua aparecendo na coluna" | "Adicionar filtro no readCards" |
| `chore` | o estado-alvo de saúde sustentada | "Suíte do storymap roda em < 1 min" | "Paralelizar o vitest" |

> Para `storyType: user`, NUNCA comece o título com verbo de dev (Criar, Adicionar, Implementar,
> Refatorar, Redesenhar, Remover, Configurar, Ajustar, Simplificar, Mover) — descrevem o que o DEV
> faz, não o que o usuário ganha.

**Como classificar:**
1. Tem persona e benefício de usuário observável? → `user` (a maioria).
2. É só infra/plumbing que destrava outras stories (job, índice, scraper, webhook)? → `technical`.
3. É pergunta a responder antes de construir? → `spike`. É conserto? → `bug`. É faxina/upgrade? → `chore`.

Guarde só o **miolo** em cada campo (`role: explorador urbano`, não `role: Como explorador urbano`);
o conector vem do `storyType`. **Critérios de aceite**: Gherkin **Dado/Quando/Então** recomendado.

> A narrativa completa (`role`+`want`+`soThat`) + ≥1 critério de aceite formam o gate
> `hasRefinement` da `refinada`. O `harness-enrich` preenche ambos.

> **Corpo do card = espaço do problema.** O corpo ("Contexto & valor") + `narrative` +
> `acceptance` descrevem o PROBLEMA (negócio/domínio): contexto, quem & valor (JTBD), escopo
> in/out, regras de negócio, premissas/riscos de negócio. O *como* (arquivos, funções, libs,
> ordem, riscos técnicos) é o **espaço da solução** e vive em `plans/<id>.md` (dono: `harness-plan`,
> livre para contrariar o card — INVEST "Negotiable"). Não vaze implementação para o corpo.

---

## 1. RICE — custo-benefício

```
riceScore = (reach × impact × confidence) / effort
```

- **reach** — quantos usuários/eventos são afetados num período (nº absoluto, ex.: 600/mês).
- **impact** — força do efeito por usuário. Escala canônica: `3` massivo · `2` alto · `1` médio · `0.5` baixo · `0.25` mínimo.
- **confidence** — confiança nas estimativas (0–1): `1` = dados sólidos, `0.8` = alguma evidência, `0.5` = chute fundamentado.
- **effort** — pessoa-mês (ou pontos) de time. **> 0** (senão o score é indefinido).

Ao estimar (automação): seja conservador no `confidence` quando não houver dado real;
prefira números redondos. O humano refina depois na view de priorização.

---

## 2. KANO — forma da satisfação

Classifique como o usuário reage à **presença vs ausência** do que a story entrega.
Use as duas perguntas (funcional / disfuncional) para decidir:

| categoria (`kano`) | sinal | o que fazer |
|--------------------|-------|-------------|
| `must-be` | Se faltar, irrita; se tiver, ninguém elogia (é esperado). | **Garanta todos** — é o piso. |
| `performance` | Quanto melhor, mais satisfação (proporcional, linear). | **Invista para competir**; priorize por RICE. |
| `attractive` | Surpreende e encanta; a ausência **não** frustra. | **Diferencie com alguns** — fidelidade/viral. |
| `indifferent` | Tanto faz ter ou não. | **Evite investir.** |
| `reverse` | A presença (ou exagero) **atrapalha/irrita**. | **Remova ou repense.** |

**Como decidir (rubrica):**
1. "Se a story NÃO existisse, o usuário ficaria frustrado?" → sim forte = `must-be`.
2. "Quanto melhor entregue, mais o usuário gosta, de forma proporcional?" → sim = `performance`.
3. "É um plus inesperado que encanta, mas que ninguém sente falta?" → sim = `attractive`.
4. "Dá no mesmo ter ou não?" → `indifferent`. "Alguns usuários odeiam ter isso?" → `reverse`.

Ancore na **persona**: leia `pains`/`gains` em `board.yaml`. Resolver uma **dor explícita**
tende a `must-be`/`performance`; entregar um **ganho aspiracional** tende a `attractive`.

---

## 3. Funil AAARRR — objetivo de negócio

O estágio do funil pirata (Dave McClure + Awareness) que a story move. Escolha **um**
— o objetivo primário:

| estágio (`funnelStage`) | move… | exemplos |
|-------------------------|-------|----------|
| `awareness` | Descobrir que o produto existe. | landing, SEO, conteúdo, compartilhável público. |
| `acquisition` | Virar usuário (signup/1º acesso). | onboarding de entrada, cadastro, convite que converte. |
| `activation` | Primeiro valor (aha moment). | primeira recomendação útil, primeiro evento salvo. |
| `retention` | Voltar e manter o hábito (**anti-churn**). | recorrência, notificações úteis, feed que evolui. |
| `referral` | Convidar e trazer outros (viral / **k-factor**). | perfil público, card compartilhável, convite. |
| `revenue` | Pagar / monetizar. | paywall, Plus, checkout. |

**Mapa de intenção comum:** churn → `retention`; viralidade/indicação → `referral`;
topo de funil/descoberta → `awareness`; monetização → `revenue`.

Ancore na **north star** do projeto (crescimento de WAU / k-factor): stories de
`retention` e `referral` costumam ser as alavancas primárias na fase atual.

---

## 4. Priorização — **WSJF ancorado** (`priorityCall.wsjf`)

A pergunta que este bloco responde é uma só: **o que fazer primeiro?** A ordem do backlog cai de
uma conta, e a conta é o WSJF (Weighted Shortest Job First):

```
CoD  = valor + urgência + destravamento        cada eixo ∈ {1,2,3,5,8,13}   →  CoD ∈ [3,39]
WSJF = CoD / tamanho                           tamanho ∈ {1,2,3,5,8,13}     →  WSJF ∈ [0,23 , 39]
```

> Fonte da verdade da fórmula, da escala e dos cortes: `packages/storymap-ui/src/lib/storymap/wsjf.ts`.
> A razão é **DERIVADA** (nunca persistida); o que se grava são os quatro ordinais + o `rank`, e a
> lint `board-integrity` reprova qualquer `rank` que não seja o tier derivado dos ordinais.

### 4.1 Por que ANCORADO (e não re-ranqueamento do conjunto)

Cada card é pontuado **isolado**, mas numa escala ABSOLUTA e FECHADA, estimado por comparação com um
punhado de cards já pontuados — as **âncoras** (as *reference stories* do SAFe). Consequências, que
são o motivo do desenho:

- **Um card novo acha seu lugar sem mexer no score de ninguém.** Re-ranquear o conjunto a cada
  chegada embaralha cards que o operador já julgou e torna o número irreprodutível fora daquele
  instante.
- **A ordem é estável e auditável** — a mesma entrada dá a mesma saída.
- **O passo `priorizar` do pipeline não precisa mudar**: continua sendo um card por vez, autônomo.

O preço: sem âncoras a escala DERIVA (um "8" de janeiro deixa de significar o mesmo que um "8" de
junho). Por isso as âncoras não são opcionais — são a régua, e viajam em todo julgamento.

### 4.2 Os quatro eixos

| eixo | o que mede | armadilha que ele evita |
|------|-----------|--------------------------|
| `value` | quanto move o **resultado-alvo** do board | — |
| `urgency` | quanto o custo **CRESCE com a espera** (≠ importância) | sem ele, um **bug bloqueante** morre: não entrega valor novo nem destrava nada |
| `unlock` | quantas **outras coisas** passam a ser possíveis | sem ele, o **card de alicerce** (que soa entediante) afunda — o que quebra o cenário "PRD gerou 40 cards" |
| `size` | o esforço — é o **denominador** | — |

A escala é Fibonacci porque a incerteza cresce com o tamanho: distinguir 1 de 2 é honesto,
distinguir 12 de 13 é teatro.

### 4.3 Cortes de tier

```
WSJF ≥ 8 → 3 Crítica     ≥ 4 → 2 Alta     ≥ 2 → 1 Média     senão → 0 Baixa
```

Escala por **dobra**, calibrada enumerando os 6⁴ pontos do domínio ponderados por plausibilidade: cai
nos quartis (p25≈2 · p50≈3,5 · p75≈6 · p90≈9) e produz ≈ Baixa 23% / Média 32% / Alta 30% /
Crítica 15%. Cortes mais frouxos marcavam **26% do backlog como Crítica** — inflação que faz o tier
deixar de discriminar, o modo de falha clássico de qualquer rubrica. Os cortes moram na spec
(`settings.yaml → prioritization.tiers`), nunca como constante de produto.

**Teto estrutural, e é intencional:** como CoD ≤ 39, um card de tamanho 13 nunca passa de WSJF 3,0
(teto Média) e um de tamanho 8 não passa de 4,9 (teto Alta). É o *SHORTEST* do nome operando — um
item grande e crítico não sobe de tier argumentando: ele é **QUEBRADO** em fatias, e aí cada fatia
disputa em pé de igualdade.

### 4.4 O que alimenta o julgamento

Tudo entra como **evidência lida**, nunca como número calculado a partir de campo semi-preenchido:

- narrativa (`soThat`) e os 2 primeiros critérios de `acceptance` + a contagem;
- as **personas** que o card nomeia (nome + papel + 1ª dor — nunca o prompt integral);
- `severity` / `frequency` / `hasWorkaround` de bug — o insumo de `urgency`;
- a **síntese das entrevistas** (`## Entrevistas` no corpo), quando existe;
- sinais de tamanho: nº de tarefas, existência de plano técnico, sistemas tocados;
- **o que o produto JÁ FAZ** — as stories em status `delivered` agrupadas por nó do mapa. Um card que
  repete capacidade existente vale pouco; um que completa algo entregue pela metade destrava muito.

O campo `basis[]` registra QUAIS desses sinais existiam de fato no momento do julgamento, e vira a
**confiança** exibida na tela. Card nu produz um julgamento honesto de baixa confiança — não um
palpite disfarçado de certeza.

### 4.5 O que é LEGADO

`rice` (reach/impact/confidence/effort), `kano` e `funnelStage` **não são mais escritos nem lidos**
pela priorização. Continuam no schema e satisfazem o gate `hasPrioritization` para cards antigos, mas
não produzem ordem: um card só com eles aparece como **"sem avaliação"** na tela e ordena por último
no `suggest_work`. As seções §1–§3 acima descrevem esses frameworks para quem precisar interpretar um
card antigo.

`severity`/`frequency` de bug **NÃO** são legado: alimentam a ordenação da Triagem no Inbox e entram
como evidência de `urgency`.

### 4.6 Roteamento da Triagem (Opção B)

O agente de triagem classifica `intent` (feature/bug/melhoria); ao **aceitar** o card da
Triagem (`accept_triage` / `acceptRoute`), ele entra pela lane certa:

| intent | lane (status) | gate pré-preenchido na triagem |
|--------|---------------|--------------------------------|
| `bug` | `corrigir` (harness-fix) | `bugReport` canônico (hasBugReport) + severidade/frequência |
| `melhoria` | `refinar` (harness-refine) | `refinement.brief` (hasRefineBrief) |
| `feature` | `enriquecer` (harness-enrich) | — |

---

## Contrato `harness-prioritize`

A automação do status `priorizar` escreve **um** bloco e então move `priorizar → pronta`:

```yaml
priorityCall:
  rank: 2                    # DERIVADO dos ordinais — a lint board-integrity confere
  rationale: "por que agora / por que antes de X"
  riskiestAssumption: "a premissa que, se falsa, derruba a aposta"
  source: agent              # "human" = veto do Operador, NUNCA sobrescrito por agente
  assessedAt: '2026-07-29T12:00:00.000Z'   # ISO entre ASPAS (sem elas o YAML devolve um Date)
  wsjf:
    value: 5
    urgency: 3
    unlock: 8
    size: 3
    basis: [soThat, aceite, personas, entregues]
    cohortSize: 12
    cohortAt: '2026-07-29T12:00:00.000Z'
```

O gate `hasPrioritization` (em `gate-core.js` e no hook isomórfico `validate-storymap-gate.js`)
aceita **qualquer** `priorityCall`, inclusive um legado sem o sub-bloco `wsjf` — mas um card assim
**não entra na ordem**: aparece como "sem avaliação" na tela e ordena por último no `suggest_work`.

Há duas superfícies que escrevem esse bloco, e ambas usam o MESMO construtor de contexto
(`priority-context.ts`) de propósito — duas descrições da mesma tarefa apodrecem em ritmos
diferentes, e essa divergência já foi um defeito real desta base:

| superfície | quando | escopo |
|---|---|---|
| skill `harness-prioritize` (autorun) | o card entra em `priorizar` | 1 card, contra as âncoras |
| botão da tela de Priorização (`scoreStoriesAction`) | o operador pede | os cards **sem nota** (semeio), ou os que ele escolher |

**Ideias** (`type: idea`) seguem no tier ARGUMENTADO, sem ordinais: uma ideia é uma *dor*, não um
job, e WSJF sem job size não significa nada.
