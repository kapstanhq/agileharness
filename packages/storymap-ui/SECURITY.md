# Segurança do AgileHarness

Este documento é a **postura declarada**: como reportar uma falha, qual é o modelo de confiança, e o
que ele deliberadamente **não** é. O inventário completo — o que o sistema protege, o que não
protege, e sob qual suposição — está em **[docs/threat-model.md](docs/threat-model.md)**, com os
riscos aceitos e o número medido de cada um.

Leia a primeira tela do [README](README.md) antes disto: a ferramenta spawna
`claude --dangerously-skip-permissions`, os processos herdam o usuário do serviço (`root` na
instalação de referência) e há um shell servido por WebSocket. Não é bug; é o produto. O que se
protege aqui é o **perímetro**.

## Como reportar uma vulnerabilidade

Use o **GitHub Security Advisories** deste repositório — aba **Security → Advisories → Report a
vulnerability** (*private vulnerability reporting*). O canal é privado por construção, não exige que
você confie num endereço divulgado numa página, e é o único que **já existe** no dia do primeiro push
público.

- **Não abra issue pública** para uma falha explorável. Um board comprometido é execução arbitrária
  na máquina de quem o roda — a janela entre o relato público e o patch é o ataque.
- **Não há e-mail de contato publicado, e a ausência é a decisão** — não um campo por preencher. O
  reporte privado entrega o relato a quem responde pelo repositório sem intermediário; um endereço
  publicado que ninguém lê é pior que a ausência dele: o pesquisador acha que avisou, e o relato vai
  para o nada.
- **Escopo, expectativa de resposta e versões suportadas** estão na **política**, no `SECURITY.md` da
  RAIZ do repositório — o caminho onde o GitHub a lê e onde ela vira a aba *Security*. Este documento
  é a postura TÉCNICA; ele não repete a política, porque duas cópias do mesmo prazo divergem e a que
  apodrece é sempre a de baixo.
- **O que ajuda no relato** (versão, proxy, envs de bind, e se o caminho passa por conteúdo que o
  board **ingere** — a classe onde um dado de fora vira comando) está listado lá, junto do formulário
  de reporte. Uma segunda cópia desta lista aqui embaixo é a que ninguém atualiza.

## Versões suportadas

Apenas o **HEAD do branch principal**. Não há linhas de manutenção nem *backports*: sob o modelo
single-operator abaixo, um patch de segurança é um `git pull` + rebuild + restart. Uma instalação
que não pode fazer isso não está no modelo de ameaça suportado.

## O modelo: SINGLE-OPERATOR (e por que **não** existe RBAC)

**Esta ferramenta é single-operator por desenho.** Uma pessoa, um board, uma credencial. Não há
multi-tenancy, não há papéis, **não há RBAC** — e isso é uma decisão de arquitetura registrada, não
uma lacuna de roadmap.

A régua da categoria faz o mesmo: o OpenClaw declara no threat model dele que *"não é uma fronteira
multi-tenant hostil"*; o claude-hermes nem tem painel web (a identidade é allowlist de remetentes de
plataforma). Nenhum dos dois construiu RBAC, porque papéis sobre um agente que executa comando
arbitrário criam a ilusão de contenção sem a contenção.

**O que isso implica, concretamente, se você adotar isto em equipe:**

- **quem tem a credencial tem a máquina.** Não existe "usuário só de leitura" no painel: qualquer
  pessoa autenticada spawna agentes, aprova ações, dispara deploy e abre um shell. Compartilhar o
  token do operador é compartilhar acesso `root` à máquina, com o registro no ledger de auditoria
  atribuído a "o operador" — não a quem de fato agiu;
- **os tiers `ro`/`write`/`orch`/`full` NÃO são papéis de usuário.** Eles limitam **agentes** — quais
  tools uma credencial MCP monta e com que permissão um spawn nasce. Ler `ro` como "conta somente
  leitura" é o erro de interpretação que este documento existe para prevenir;
- **auditoria ≠ autorização.** Toda decisão do guard vai para o ledger `agent-actions`. Isso responde
  *o que aconteceu*, nunca *quem tinha direito*.

Se você precisa de fronteira entre pessoas, a fronteira é a **instância**: um serviço por operador,
em máquinas separadas. Não tente obtê-la com papéis dentro de uma instância — eles não existem.

## Revogação — o botão de pânico que já existe

Não há sessão no servidor para invalidar, e ainda assim a revogação é real e imediata:

- **Cookie de sessão do painel.** O material de chave do HMAC é
  `sessionSecret + "\n" + operatorToken` (`src/lib/auth/session.ts`). Consequência:
  **rotacionar qualquer um dos dois derruba toda sessão em circulação**, de uma vez, sem estado no
  servidor. Troque `AGILEHARNESS_AUTH_TOKEN` (ou o arquivo `storymap/.runner/auth-token`) ou
  `AGILEHARNESS_SESSION_SECRET` (ou `storymap/.runner/session-secret`) e reinicie: todos os cookies
  emitidos antes param de verificar. É o que se espera de *"meu token vazou, troquei o token"*.
- **Credencial do MCP.** Um **handle** revogável (`storymap/.runner/mcp-handles.json`) existe para não
  obrigar restart nem rotação do segredo primário: `--list-mcp-handles` mostra, e
  `--revoke-mcp-handle <id>` invalida **no request seguinte**. Um handle vazado (e ele vaza — veja o
  capítulo de logs no threat model) se apaga sem derrubar o serviço nem os agentes.
- **Rotação do token MCP primário** (`STORYMAP_MCP_TOKEN` e tiers) exige restart e reconfiguração de
  todo conector. Gere com `node dist/ah-server.mjs --generate-mcp-token`; nada gera um por conta
  própria (um bootstrap automático rotacionava a credencial de produção em silêncio a cada restart —
  removido).

## Antes de expor isto além do `localhost`

Checklist mínimo. Nenhum item é opcional em deploy alcançável de fora:

1. **TLS por fora** (proxy reverso). O cookie de sessão só nasce `Secure` quando a configuração diz
   que o painel é HTTPS.
2. **`AGILEHARNESS_PUBLIC_URL=https://seu.dominio`** — **obrigatória**. Sem ela o portão redireciona
   para `http://localhost:3008/login` e ninguém consegue logar pelo domínio; além disso é ela que
   decide o `Secure` do cookie sem depender de header do pedido.
3. **Credenciais com entropia real** (≥32 chars, aleatórias). A auto-checagem de boot mede e, com o
   bind fora do loopback, **recusa subir**; em loopback ela avisa alto — porque a topologia real é
   loopback **+ túnel**, e "loopback" nunca significou "inalcançável".
4. **Rede:** prefira manter o bind em `127.0.0.1` e publicar por proxy/túnel.
   `AGILEHARNESS_ALLOW_PUBLIC_BIND=1` é a válvula explícita para assumir o risco de um bind aberto —
   e o aviso sai em todo start.
5. **`AGILEHARNESS_DEV=1` jamais em produção.** O modo dev devolve o listener de `upgrade` ao Next
   (o HMR precisa dele), e com isso a checagem de `Origin` do WebSocket deixa de cobrir tudo — a
   defesa contra a classe ClawJacked. Ausente = produção, que é o lado seguro.
6. **Redija a credencial nos logs do proxy.** O token MCP vai no **path** da URL; o logger de erro
   padrão de um proxy registra a URI completa. Isso já foi medido neste projeto (174 ocorrências em
   claro — veja o threat model) e a redação é responsabilidade do operador.
7. **Saiba que existem DOIS mecanismos com o nome "sandbox", e que os defaults deles são opostos.**
   Confundi-los é puxar a alavanca errada achando que ligou proteção:

   | | **Contenção do SO** (ADR-067) |
   |---|---|
   | O que faz | fronteira de processo por bubblewrap/Seatbelt: escrita liberada só para a árvore do run, egresso por allowlist |
   | Quem cobre | o **autorun** (tier `full`), a tool MCP `run_task`, o **juiz de conflito** e o **revisor par** |
   | Default | **LIGADO** (`AGILEHARNESS_SANDBOX_MODE=preferred`) |
   | Sem ele | o run é **recusado ou rebaixado**, com aviso alto — nunca roda sem fronteira em silêncio |

   Havia uma segunda camada (o *sandbox estrutural*, ADR-063), removida em 2026-08-05. Ela era **fail-open
   por design declarado** — "must never, by itself, fail a run" — enquanto esta **recusa** quando não
   consegue conter. Duas camadas que discordam sobre o que fazer no momento em que falham não somam
   proteção: garantem que um dia alguém confie na que deixa passar.

   **A CONTENÇÃO É DE ESCRITA. A LEITURA É NEGADA POR ENUMERAÇÃO, E O EGRESSO NÃO É A CERCA QUE
   DECLARAMOS.** Esta linha vem antes de qualquer detalhe porque cada metade dela corrige uma suposição
   que o leitor faz sozinho.

   *Leitura* (mudou em 2026-08-05): `buildSandboxSettings` passou a emitir `filesystem.denyRead` — a chave
   estava declarada no tipo e nunca era preenchida, e os caminhos iam todos para `credentials.files`, que
   já tinha sido medido vazando. Hoje as duas descem juntas. Mas **negar por enumeração não é envelope**:
   o que não está NOMEADO na lista, o run lê. Um run contido continua lendo o repositório inteiro, `/etc`,
   e o diretório dos outros boards.

   *Egresso*: `network.allowedDomains` **É a fronteira, e é aplicada com precisão** — casamento por host
   EXATO, no CONNECT, pelo proxy do runtime. Medido de dentro da jaula com a contenção provada no MESMO
   script que fez as requisições (`/root` read-only ✓, allowWrite grava ✓, netns próprio, PID 22),
   declarando apenas `api.anthropic.com`:

   ```
   https://api.anthropic.com/v1/messages    http=405  rc=0     ← DECLARADO: resposta real da API
   https://example.com/                     http=000  rc=56    ← CONNECT tunnel failed, response 403
   https://api.github.com/                  http=000  rc=56
   https://webhook.site/                    http=000  rc=56
   POST payload → postman-echo.com          nada voltou        ← a exfiltração não sai
   ```

   O discriminador que fecha a leitura: com `allowedDomains: ["nonexistent.invalid"]`, **tudo** dá 000 —
   *inclusive* `api.anthropic.com`. O campo não é ignorado; ele decide. E `www.example.com` é recusado
   quando o declarado é `example.com`: o casamento é por host exato, não por sufixo — declarar um domínio
   NÃO concede seus subdomínios.

   ⚠ **ESTE PARÁGRAFO JÁ ESTEVE ERRADO, e o erro vale mais que a correção.** Entre 2026-08-05 e 2026-08-06
   este documento afirmou que o egresso "não é a fronteira", que `api.github.com` respondia 200 sem estar
   declarado e que `statsig` estava fechado apesar de declarado. As três coisas vieram de requisições
   feitas **FORA da jaula** por um agente cuja própria sessão não era contida — ele mediu o host e rotulou
   como jaula. (O `statsig` dá 000 no host TAMBÉM: é 502 no upstream / sem DNS público, nunca foi política.)
   Dois agentes independentes cometeram o mesmo erro na mesma semana, o que diz o quanto ele é fácil:
   **uma medição de rede só vale com a prova de contenção no mesmo script** — `/root` recusando escrita e
   o allowWrite aceitando, lado a lado com os curls. Sem esse par, você está medindo a máquina.

   O texto abaixo é a medição HISTÓRICA que motivou o conserto da leitura, preservada porque é a evidência
   de que o buraco existia — não a descrição do estado de hoje. Medido gerando o settings pela função de
   PRODUÇÃO e rodando o CLI real
   (`claude --permission-mode acceptEdits --settings <settings> -p '…'`), com `allowWrite` apontando para
   um envelope em `/tmp`:

   ```
   $ cat /tmp/ah-canario-fora.txt ; echo RC=$?      # arquivo FORA do envelope, modo 600
   CANARIO-FORA-DO-ENVELOPE
   RC=0
   ```

   O controle negativo, no mesmo run, prova que a cerca **estava de pé** — não é o caso de o sandbox não
   ter subido:

   ```
   /bin/bash: line 5: /tmp/ah-escrita-fora.txt: Read-only file system
   RC_ESCRITA_FORA=1
   RC_ESCRITA_DENTRO=0
   ```

   `cat /etc/shadow` de dentro do sandbox devolve o arquivo inteiro, hash do `root` incluído.

   **A exceção real, e é só ela:** os caminhos declarados em `sandbox.credentials.files` com `mode: "deny"`
   — `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude/.credentials.json`, mais os três arquivos de credencial do
   próprio harness (`auth-token`, `session-secret`, `mcp-handles.json`, resolvidos a partir do state dir
   real). Essa negação **é** aplicada, medida no mesmo CLI: um caminho da lista sai
   `Permission denied (os error 13)` e um vizinho fora dela é lido normalmente; `~/.ssh` chega a aparecer
   como `No such file or directory` (mascarado). Ou seja, a leitura é **negada por enumeração**, não por
   envelope — o que não está nomeado na lista, o run lê.

   ⚠ **CORRIGIDO em 2026-08-05.** Esta nota dizia que `denyRead` "não vira `filesystem.denyRead`: ela
   alimenta `credentials.files`" — era verdade e era o defeito. Hoje a opção alimenta AS DUAS chaves, e a
   lista ganhou `~/.config/gcloud` e `~/.config/configstore` (as credenciais que publicam em produção,
   medidas legíveis por qualquer run de código). Negadas por DIRETÓRIO, não por arquivo, porque um caminho
   de deny-read inexistente no momento do wrap é descartado em silêncio pelo runtime do sandbox — negar um
   arquivo que ainda não foi criado seria uma cerca que se apaga sozinha.

   A negação tem prova de enforcement própria (Sonda R do `probe-autonomy-sandbox.sh`), com discriminador:
   um irmão FORA da negação tem de continuar legível na mesma chamada. Sem esse irmão, `No such file` não
   distingue "negado" de "a árvore não foi montada" — e foi assim que uma versão anterior desta sonda
   passou verde medindo zero.

   ⚠ **NÃO MEDIDO:** a negação foi verificada ponta a ponta para `~/.claude/.credentials.json`, para
   `~/.ssh` e para um caminho de teste injetado na mesma lista. As três credenciais **do harness**
   (`auth-token`, `session-secret`, `mcp-handles.json`) foram verificadas apenas na **emissão** — elas
   saem no `credentials.files` do settings de produção, pelo mesmo código e com caminho absoluto correto
   — mas não houve execução que as lesse, porque o agente se recusou a rodar a sonda sobre arquivos com
   esses nomes. Herdam a garantia do mecanismo, não uma medição própria.

   O que a contenção do SO cobre na ESCRITA, com o recorte que a medição impõe: **os comandos de shell** do
   run são barrados pelo kernel (`Read-only file system`); a escrita pelas **ferramentas nativas**
   `Write`/`Edit` é barrada pela camada de permissão (`acceptEdits` recusa caminho fora do diretório de
   trabalho, e um run headless não tem quem aprove). As duas negam; só a primeira é garantia do SO.

   **`enableWeakerNestedSandbox` está LIGADO nesta instalação de referência, e ele enfraquece o
   isolamento.** Ele bind-monta o `/proc` **existente** em vez de montar um novo, expondo informação de
   processo do host que um `/proc` fresco esconderia — a documentação do próprio CLI diz que enfraquece
   consideravelmente. Ele **não é configurado: é DERIVADO de uma sonda** (`AGILEHARNESS_SANDBOX_WEAKER_NESTED`
   só existe como override `1`/`0`), porque em hosts como este o passo de seccomp do CLI não sobe com um
   `/proc` novo — sem ele, **nada** roda. Confira no seu host:

   ```
   $ bwrap --unshare-user --unshare-pid --proc /proc --dev-bind / / sh -c 'echo deny > /proc/self/setgroups'
   sh: 1: echo: echo: I/O error      # ← falhou aqui ⇒ o modo weaker será ligado sozinho
   ```

   **O envelope de escrita é MAIOR que "a árvore do run"** — e a diferença precisa estar aqui, não só no
   ADR da fase. O conjunto efetivo inclui também o `$TMPDIR` da sessão e o **gitdir resolvido** de um
   worktree linkado (`<checkout>/.git/worktrees/<n>/`), que fica *dentro do checkout principal*, fora da
   árvore do run. O gitdir escrevível é o que faz `git add`/`git commit` funcionarem dentro do sandbox —
   foi medido, e é necessário. O que **não** foi analisado é o gitdir como *caminho de influência*: a
   config de worktree que vive ali é lida por invocações de `git` que o harness roda **fora** do sandbox.
   Não há exploração demonstrada; há uma superfície declarada e ainda não estudada, e você merece
   decidir sabendo disso.

   **Um serviço vivo entre chamadas não funciona sob contenção.** Medido: cada chamada Bash recebe PID e
   *network namespace* próprios, então um servidor iniciado numa chamada não é alcançável por
   `127.0.0.1` na seguinte — nem com `nohup &`, nem com o modo background do próprio CLI. Fluxos que
   dependem disso (subir um dev server e consultá-lo depois) não são possíveis com a contenção ligada.
   **A saída medida não é uma isenção — é uma chamada só.** Foi medido (2026-08-05) que a varredura
   visual inteira cabe numa ÚNICA chamada Bash contida (subir o servidor, esperar, abrir Chromium
   headless, navegar, capturar o PNG), e que o `webServer` do `playwright.config` sobe o dev server como
   FILHO da mesma chamada — logo no mesmo namespace. O que se perde não é enxergar a tela: é só a rota
   INTERATIVA do MCP `chrome-devtools`, que roda no processo do host e por isso jamais alcançaria um
   servidor contido.

   A isenção por skill (`AGILEHARNESS_UNCONTAINED_TRIGGERS`) foi **removida**. E `sandbox.excludedCommands`,
   que parecia a versão granular dela, **não entrou**: medimos que o casamento é por subcomando após o
   split da AST do bash, então se qualquer subcomando casa, a linha INTEIRA roda fora da jaula — sem
   rede isolada, sem confinamento de filesystem, como root. `bun run qa-dev; cat /etc/shadow` rodaria o
   `cat` sem cerca. Não existe teto managed para essa chave, e um `.claude/settings.json` de projeto que
   a declare é honrado. É porta larga com nome estreito.

   O que resta como saída do operador é `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL`: global, ruidosa, e
   honesta sobre o que concede.

   **Quem ela cobre — e a lista mudou.** Uma redação anterior deste documento dizia que a contenção valia
   "apenas para o autorun" e listava seis superfícies fora dela. Estava errada em duas rodadas: primeiro
   quando a tool MCP `run_task` migrou (então descrita como a única alcançável pelo endpoint MCP externo —
   ver a correção abaixo), e de novo agora que o **juiz de conflito** (`runner/resolution-judge-spawn.ts`) e o
   **revisor par** (`runner/peer-review-spawn.ts`) migraram também — os dois resolvem a postura pelo
   mesmo `resolveAutonomyPosture`/`buildSpawnFlags` do autorun. Eles saíram desta fase, e não da
   seguinte, por um motivo nomeado: a *merge train* os spawna sobre o diff que um run **já contido**
   acabou de produzir, **sem humano no meio** — enquanto ficassem para trás, a fronteira embarcava um
   caminho de escalação de dentro dela para fora.

   Restam **quatro** superfícies não contidas — deploy autônomo, captura, chat do copiloto e a sessão de
   card em `/terminal` — que seguem com `--dangerously-skip-permissions` e sem sandbox nenhum. A lista é
   amarrada por lint ao código (`runner/autonomy-sandbox.test.ts`, bloco *LINT DE DÍVIDA*), para prosa e
   código não divergirem de novo.

   ⚠ **CORREÇÃO (avaliação independente): NÃO são "todas atrás de sessão de painel", e a exceção é a pior
   possível.** Uma redação anterior deste parágrafo — e o README, e um comentário em `mcp/dev-tools.ts` —
   afirmavam que `run_task` era a **única** superfície alcançável de fora e que as quatro restantes
   **exigiam sessão autenticada no painel**. É **falso**. São **duas** as alcançáveis sem cookie de painel:
   `run_task`, que migrou, e a **CAPTURA**, que **não** migrou. A cadeia foi seguida e confirmada:

   ```
   src/app/api/usm/[secret]/[transport]/route.ts   → runWithMcpActor(actor, …)      (credencial no PATH)
   src/lib/storymap/mcp/tools.ts:775               → await reportIssueAction({ boardId: board, text })
   src/app/actions.ts:1347                         → await requireSession("reportIssueAction")
   src/lib/auth/action-guard.ts:308                → if (currentMcpActor() != null) return "mcp-token"
   src/app/actions.ts:1360                         → runClaudeJson(buildTriagePrompt({ config, cards, text }))
   src/lib/storymap/smart-capture/claude.ts:60     → spawn(`${bin} -p --output-format json …`)
   ```

   O elo que desfaz a afirmação é o quarto: `requireSession` **não** exige cookie de um chamador MCP — ele
   devolve `"mcp-token"` assim que há um ator no ALS, e o ator foi posto lá pela credencial do path. Vale
   para `report_issue` **e** para `usm_capture` (`mode:'propose'` → `proposeCardsAction` → o mesmo
   `runClaudeJson`); as duas são classe de risco `write-board`, ou seja, montam a partir do nível `write`
   — não é preciso nem o token `full` do operador. E é justamente a superfície que ingere **texto livre não
   confiável**, que `runner/spawn-chokepoint.test.ts` chama de "a de MAIOR risco de prompt-injection".

   Duas precisões que a correção **não** pode omitir, porque foram medidas:

   - **pelo caminho MCP a captura não emite a flag no argv** — `reportIssueAction` chama `runClaudeJson`
     sem `dangerouslySkipPermissions`, e `usm_capture` não tem parâmetro de imagem (a única condição que a
     liga). O filho sai como `claude -p --output-format json --model sonnet --effort medium`. Isso **não** o
     torna contido: ele sai **sem `--permission-mode`**, e nesta instalação de referência
     `~/.claude/settings.json` traz `"permissions": {"defaultMode": "bypassPermissions"}` — herdado porque
     `sanitizeSpawnEnv` é *denylist* e preserva `HOME`. `claude.ts` ainda injeta `IS_SANDBOX=1` quando root,
     que é exatamente o que faz o CLI **aceitar** essa postura. Ou seja: a autonomia plena chega por
     **herança de settings**, não pelo argv — que é uma forma pior, porque não aparece na linha de comando;
   - **das outras três, duas foram medidas como realmente atrás do painel**: o chat do copiloto
     (`/api/copilot/turn` cai no 401 do `middleware.ts` sem sessão) e a sessão de card em `/terminal`
     (`resumeRunInTerminalAction` não tem chamador MCP — só `app/processes/ProcessActions.tsx`). A
     terceira, o **deploy autônomo**, é **mais fraca que "exige painel"** e menos que "alcançável de fora":
     `launchDeployAgent` é disparado pelo pipeline, e mover um card por MCP para uma coluna com `onEnter`
     escala a classe para `deploy` (`entry-effect.ts:37`), que os níveis `orch`/`full` montam. É alcance
     **em banda**, por encadeamento, e fica registrado como tal — não foi executado ponta a ponta.

   **UBUNTU 23.10+ TIRA A CONTENÇÃO DE QUEM RODA COMO NÃO-ROOT — e é o adotante mais cuidadoso que
   perde.** O kernel dessas versões restringe a criação de *user namespace* por processo não privilegiado
   (AppArmor), e o bubblewrap depende exatamente disso. **Medido nesta instalação de referência**
   (Ubuntu 24.04.4 LTS, kernel 6.8.0-124-generic, bubblewrap 0.9.0, `claude` 2.1.222):

   ```
   $ cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
   1

   $ bwrap --unshare-user --dev-bind / / true          # como root
   $ echo $?
   0

   $ setpriv --reuid=65534 --regid=65534 --clear-groups bwrap --unshare-user --dev-bind / / true
   bwrap: setting up uid map: Permission denied
   $ echo $?
   1
   ```

   Quem instala `bubblewrap` e `socat` como o README manda e roda o serviço sob um usuário dedicado — a
   escolha **mais** segura — fica **sem contenção**, e o aviso de degradação vai mandá-lo "instalar as
   dependências", que nesse host é o conselho errado: elas já estão instaladas. As saídas reais, todas do
   operador do host e nenhuma do produto:

   - **rodar o serviço como `root`** (o que a instalação de referência faz; o custo está declarado acima —
     um comprometimento é a máquina inteira);
   - **`sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`** — devolve o userns não privilegiado
     para a máquina **toda**, não só para este serviço, e é preciso decidir isso sabendo;
   - **um perfil AppArmor para o `bwrap`** (`usr.bin.bwrap` com `userns` permitido) — o mais estreito dos
     três, e o único que não troca a postura do host inteiro pela do harness.

   Não há quarta saída dentro do produto: `AGILEHARNESS_SANDBOX_MODE=required` faz o run **recusar** em vez
   de rodar descontido, que é o comportamento correto e não é uma solução.

   **Existe um teto mais forte, e ele não está instalado aqui.** A camada de **managed settings** do CLI
   (`/etc/claude-code/managed-settings.json`) é a única que o repositório-alvo não alcança — foi medido
   que um `sandbox.filesystem.denyWrite` ali **vence** a mescla do `.claude/settings.json` de projeto que
   a Sonda W demonstrou. Ela exige **root**, e por isso é decisão do operador do host, não default do
   produto. O template comentado, as citações literais do binário e o que ficou **não medido** estão em
   **[docs/endurecimento-managed-settings.md](docs/endurecimento-managed-settings.md)**. Sem ela, a defesa
   contra a Sonda W é a recusa fail-closed que o harness já faz a cada spawn — mais fraca, sempre ligada,
   e o que há para quem não tem root.

## F0 — CONGELADO em 2026-08-05: o que ele entrega, o que ele não entrega, e quando parar

Esta seção existe porque a fase anterior não tinha critério de parada que TERMINASSE. O critério era
"zero achados sérios", e ele nunca dispara: toda rodada de revisão encontra alguma coisa, porque sempre
há alguma coisa. Uma fase sem condição de término não é rigor — é uma parada indefinida com nome de
rigor, e ela custou treze rodadas.

### O que F0 entrega, em uma frase por perna

- **Escrita:** fronteira real. Só a árvore do run é gravável; o resto é `--ro-bind`. Medido nos dois
  sentidos, com controle negativo no mesmo instante.
- **Leitura:** negação por ENUMERAÇÃO dos caminhos nomeados (`~/.ssh`, `~/.aws`, `~/.gnupg`, credenciais
  do CLI, `~/.config/gcloud`, `~/.config/configstore`, e os três arquivos de credencial do harness), com
  enforcement provado por sonda com discriminador. **Não é envelope**: o que não está na lista, o run lê.
- **Egresso:** fronteira real, aplicada no CONNECT por host EXATO. Um host não declarado nem chega a
  responder: o túnel é recusado com 403. Testado inclusive com POST de payload — não sai.
- **Processo:** cada chamada Bash tem PID e network namespace próprios. Consequência que vale mais que a
  proteção: **nada sobrevive entre chamadas**, e um protocolo escrito para o mundo anterior falha VERDE.

### Riscos ACEITOS, com número e dono

Nenhum destes reabre a fase. Todos são conhecidos, medidos até onde deu, e assinados.

| # | risco | estado medido | dono |
|---|---|---|---|
| #24 | uma invocação rodou fora da jaula com `failIfUnavailable: true` | n=1, nunca reproduzido; 4 hipóteses eliminadas por experimento; 24+ corridas contidas seguidas; a sonda S mede a cada execução do probe | mantenedor |
| ~~#25~~ | ~~o egresso efetivo não é `allowedDomains`~~ | **RETIRADO** — a premissa era erro de instrumento (medição feita fora da jaula). O allowlist é aplicado, por host exato, e o POST de exfiltração não sai. Ver o ⚠ acima. | — |
| #12 | a credencial MCP viaja no PATH da URL | 174 gravações em claro já medidas em logs de intermediário | operador do host |
| #13 | os tokens saem em `systemctl show` para usuário sem privilégio | medido com `setpriv --reuid=nobody`; `EnvironmentFile=` esconde e exige restart | operador do host |
| #20 | não há `managed-settings.json` instalado | é o único teto que o repositório-alvo não alcança; exige root | operador do host |

### O critério de parada que substitui "zero achados sérios"

Quatro peças, e as quatro juntas:

1. **Modelo de ameaça congelado e versionado.** Um achado fora do modelo congelado não reabre a fase —
   vira entrada da próxima. Sem essa fronteira, qualquer pergunta nova é um bloqueador.
2. **Severidade só com caminho de exploração DEMONSTRADO.** "Isto parece perigoso" é uma hipótese, não
   um achado. Sem repro, entra como risco nomeado, não como bloqueador.
3. **Parada em DUAS rodadas seguidas sem achado em escopo, OU teto de TRÊS rodadas.** O teto é o que
   torna a condição terminante: sem ele, "duas rodadas limpas" pode nunca acontecer.
4. **Uma lente de FUNCIONAMENTO obrigatória junto das de segurança.** Endurecer sem medir se o produto
   ainda funciona foi como o caminho de QA ficou quebrado por semanas sem ninguém notar — a contenção
   estava certa e o protocolo que ela quebrou não tinha quem o testasse.

E uma regra de higiene que vale mais que as quatro: **uma prova só conta com o par que a torna
discriminante.** Delta zero, "No such file", exit 0 — nenhum desses significa nada sozinho. Se o mesmo
experimento, no mundo oposto, produziria a mesma saída, ele mediu zero. Esta casa já perdeu contas de
quantas rodadas para essa exata classe de defeito, e ela tem nome aqui: vácuo-verde.

## Fora de escopo (e por que)

- **Isolamento entre pessoas.** Ver single-operator acima.
- **Impedir que o agente faça o que o operador pode fazer.** `--dangerously-skip-permissions`,
  deploy, delete e spawn são capacidades **declaradas**. Elas são governadas por *risk matrix*,
  aprovação e ledger — nunca removidas. Um patch que tire capacidade do agente para "melhorar a
  segurança" está resolvendo o problema errado: a fronteira é a **porta**, não o operário.
- **Um agente hostil-por-projeto.** Se o conteúdo que você ingere no board é adversarial, o modelo
  de confiança deste produto não cobre você — comece pelo capítulo de execução por conteúdo do
  threat model.
