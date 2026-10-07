# StoryMap — tipo de story (`storyType`) e narrativa

Rubrica canônica para **classificar e escrever** uma story. Usada pelo `harness-enrich` (e pela
captura e pela triagem) e por qualquer humano/agente que escreva um card.

> **Não há priorização.** RICE, KANO, funil e WSJF saíram da ferramenta: a ORDEM do trabalho é a
> **posição do card na coluna** do Kanban (o card de cima vai antes; no menu do card, «Fazer antes»
> leva ao topo e «Pode esperar» ao fim). O condutor e o `suggest_work` leem a mesma posição — só um
> bug grave (`bugReport.severity` alta, um fato do card) passa na frente. Cards antigos que ainda
> tragam `rice:`/`kano:`/`funnelStage:`/`priorityCall:` no frontmatter continuam abrindo; nada lê
> esses campos.

> Fonte da verdade dos valores/labels: `packages/storymap-ui/src/lib/storymap/frameworks.ts`.
> Não invente categorias fora das listas abaixo.

---

## 0. Tipo de story (`storyType`) e narrativa

Toda **story** é classificada por **natureza** (`storyType`), que
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
| `user` | o objetivo/resultado do usuário (≈ want condensado) | "Ver quando o livro reservado chega, sem ligar para a biblioteca" | "Adicionar tela de acompanhamento de reservas" |
| `technical` | o resultado de produto habilitado | "A leitura do QR da bicicleta funciona mesmo sem sinal de rede" | "Migrar o cache de estações para IndexedDB" |
| `spike` | a decisão/pergunta a responder | "Decidir se o aluguel de ferramentas cabe no cadastro atual do jardim comunitário" | "Spike de cadastro de ferramentas" |
| `bug` | o comportamento quebrado (visão do usuário) | "Cesto devolvido continua marcado como pendente na lavanderia" | "Corrigir o filtro de status em listarCestos" |
| `chore` | o estado-alvo de saúde sustentada | "Os relatórios mensais de empréstimos abrem em poucos segundos" | "Adicionar índice na tabela de empréstimos" |

> Para `storyType: user`, NUNCA comece o título com verbo de dev (Criar, Adicionar, Implementar,
> Refatorar, Redesenhar, Remover, Configurar, Ajustar, Simplificar, Mover) — descrevem o que o DEV
> faz, não o que o usuário ganha.

**Como classificar:**
1. Tem persona e benefício de usuário observável? → `user` (a maioria).
2. É só infra/plumbing que destrava outras stories (job, índice, scraper, webhook)? → `technical`.
3. É pergunta a responder antes de construir? → `spike`. É conserto? → `bug`. É faxina/upgrade? → `chore`.

Guarde só o **miolo** em cada campo (`role: leitor frequente`, não `role: Como leitor frequente`);
o conector vem do `storyType`. **Critérios de aceite**: Gherkin **Dado/Quando/Então** recomendado.

> A narrativa completa (`role`+`want`+`soThat`) + ≥1 critério de aceite formam o gate
> `hasRefinement` de **A fazer** (`pronta`). O `harness-enrich` preenche ambos.

> **Corpo do card = espaço do problema.** O corpo ("Contexto & valor") + `narrative` +
> `acceptance` descrevem o PROBLEMA (negócio/domínio): contexto, quem & valor (JTBD), escopo
> in/out, regras de negócio, premissas/riscos de negócio. O *como* (arquivos, funções, libs,
> ordem, riscos técnicos) é o **espaço da solução** e vive em `plans/<id>.md` (dono: `harness-plan`,
> livre para contrariar o card — INVEST "Negotiable"). Não vaze implementação para o corpo.


---

## 1. Roteamento da Triagem

O agente de triagem classifica `intent` (feature/bug/melhoria); ao **aceitar** o card da
Triagem (`accept_triage` / `acceptRoute`), ele entra pela lane certa:

| intent | lane (status) | gate pré-preenchido na triagem |
|--------|---------------|--------------------------------|
| `bug` | `corrigir` (harness-fix) | `bugReport` canônico (hasBugReport) + severidade |
| `melhoria` | `refinar` (harness-refine) | `refinement.brief` (hasRefineBrief) |
| `feature` | `enriquecer` (harness-enrich) | — |
