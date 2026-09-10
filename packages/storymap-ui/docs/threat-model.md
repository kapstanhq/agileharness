# Threat model do AgileHarness

Este documento é uma **lista**, não prosa: o que o sistema protege, o que ele **não** protege, e sob
qual **suposição**. Um threat model que só enumera defesas é material de marketing; o valor está nas
duas outras colunas.

Cada risco aceito abaixo traz o **número medido** na sessão que o registrou. Onde a medição é de
ambiente (logs, versões, contagens), ela é de uma instalação real — a de referência — e a mesma
medição na sua vale mais que este texto.

## Em uma tela

Três fatos que mudam a leitura de todo o resto. Estão aqui, na primeira página, em vez de num anexo:

1. **A superfície MCP está na internet pública POR DESENHO, e as tools dela spawnam
   `claude --dangerously-skip-permissions` na máquina.** `/api/usm/<token>/mcp` precisa ser alcançável
   por um conector Claude hospedado fora; ele se autentica por um token no path, comparado
   *timing-safe*, com piso de entropia. **Isto não é bug — é o produto.** A consequência: essa
   credencial vale execução arbitrária como o usuário do serviço (`root`, na instalação de
   referência). Um "hardening" que remova a capacidade resolve o problema errado; o que se endurece é
   a porta.
2. **O modelo é single-operator: quem tem a credencial tem a máquina.** Sem multi-tenancy, sem
   papéis, sem RBAC — decisão registrada em [SECURITY.md](../SECURITY.md). Os tiers
   `ro`/`write`/`orch`/`full` limitam **agentes**, nunca pessoas.
3. **O perímetro é o que se defende; a autonomia do agente não é reduzida.** `skip-permissions`,
   deploy, delete e spawn continuam existindo, com o comportamento de hoje como default. O que os
   governa é *risk matrix* + aprovação + ledger de auditoria (`agent-actions`).

## Ativos, atores e fronteiras

**Ativos**, em ordem de dano: (a) a **máquina** e o usuário que roda o serviço; (b) as **credenciais
alcançáveis por ela** (git, deploy, chaves do ecossistema no ambiente do processo); (c) o **board** —
roadmap, entrevistas, decisões de negócio; (d) o **orçamento de LLM**.

**Atores hostis considerados:** a internet não autenticada; **outra aba** do navegador do operador
(classe CSRF/ClawJacked); **conteúdo ingerido** (card, sidecar, diff, nome de arquivo, saída de
agente) que tente virar comando; a **cadeia de suprimentos** (dependência, binário não verificado);
um **operador legítimo em erro** (bind aberto, credencial de tutorial).

**Fronteiras de confiança**, todas *fail-closed*: o portão (middleware + cookie de sessão, nega por
default); o token MCP; o *shared secret* do runner; sessão **+** `Origin` no upgrade de WebSocket; o
chokepoint de parse de frontmatter; e a régua única de proveniência no merge train e no self-deploy.

## O que o sistema PROTEGE

| Ameaça | Controle | Onde | Suposição que o sustenta |
|---|---|---|---|
| Painel/API alcançados sem sessão | portão que **nega por default**; exceções numa lista única com motivo, cobrada por teste de exaustividade | `src/middleware.ts`, `src/lib/auth/public-routes.ts` | o *matcher* do middleware cobre a rota (estáticos ficam fora **por performance**, e não carregam segredo) |
| Cookie de sessão forjado | HMAC-SHA256 com piso de 32 bytes; segredo fraco/ausente ⇒ `false`, nunca "válido por acidente" | `src/lib/auth/session.ts` | o segredo tem entropia real (a auto-checagem de boot mede) |
| Credencial que vazou continua valendo | material de chave = `sessionSecret + "\n" + operatorToken` ⇒ rotacionar derruba **toda** sessão viva, sem estado no servidor; handle MCP revogável sem restart | `session.ts`, `src/lib/auth/mcp-handle.ts` | o operador sabe que isso existe — é o que [SECURITY.md](../SECURITY.md) documenta |
| WebSocket do terminal comandado por outro site | o servidor próprio é dono do `upgrade`, valida a **mesma** sessão **+** `Origin`; upgrade fora de `/ttyd/*` morre em `socket.destroy()` | `src/server/main.ts`, `src/server/terminal-gateway.ts` | produção (`AGILEHARNESS_DEV` ausente) — ver R3 e R7 |
| Serviço aberto na rede com credencial adivinhável | auto-checagem de bind no boot: mede entropia de toda credencial alcançável e **recusa subir** com bind fora do loopback | `src/server/main.ts` (`auditBind`) | válvula `AGILEHARNESS_ALLOW_PUBLIC_BIND` usada consciente |
| Conteúdo de fora vira comando/DoS no parse | chokepoint único de frontmatter com tetos de bytes/profundidade/nós e recusa de chaves de poluição de protótipo | `src/lib/storymap/frontmatter.ts` | todo leitor de board passa pelo chokepoint (lint garante) |
| Nome de arquivo/SHA vira shell | `execFile` com argumentos, validação de forma, allow-list de lançadores no comando de deploy | runner (`merge-queue`, `deploy`) | nenhum caminho novo monta string de shell |
| Env do processo vaza para o filho | `sanitizeSpawnEnv` como chokepoint das superfícies de spawn, com lint | `runner/*-spawn.ts` | toda superfície nova usa o chokepoint |
| Ação destrutiva de agente sem rastro | guard *fail-closed* + risk matrix + ledger `agent-actions` | `src/lib/storymap/mcp/guard.ts` | o ledger é auditoria, **não** autorização |
| Redirect aberto no portão | `Location` sai da origem **declarada** (`AGILEHARNESS_PUBLIC_URL`), nunca de header do pedido | `middleware.ts` | a env está declarada em deploy (ver R8) |
| Segredo do dono no primeiro commit público | renascimento sem histórico (um commit) + varredura de segredos, ambos cobrados por teste contra a árvore real | `oss-*.test.ts` | a extração consome a lista pelo git |

## O que o sistema NÃO protege

| Não protege | Por que | O que fazer no lugar |
|---|---|---|
| **Uma pessoa contra outra** | single-operator: não há papéis. Qualquer pessoa autenticada spawna agente, deploya e abre shell | uma instância por operador, em máquinas separadas |
| **O operador contra o próprio agente** | autonomia é a função; `skip-permissions` é declarado | risk matrix + aprovação nas classes destrutivas; leia o ledger |
| **Conteúdo adversarial por projeto** | o board ingere card, diff e saída de agente; o chokepoint limita **forma e volume**, não intenção | não ingira conteúdo de fonte hostil |
| **XSS no painel, em profundidade** | a CSP está em **report-only** (R6) | trate `dangerouslySetInnerHTML` como mudança de segurança |
| **A máquina depois de um comprometimento do agente** | sandbox nasce desligado (R7) | ligue-o, e prefira uma máquina descartável |
| **Credencial que vaza pelo path da URL** | ela **vai** para o log de qualquer camada (R5) | redação no proxy + handle revogável |
| **Vulnerabilidade de framework sem patch no ramo** | Next 14 pinado por decisão do dono (R3) | subir para 15.x, ou reavaliar a aceitação |
| **Tráfego em texto claro** | TLS é do proxy, não do app | proxy reverso + `AGILEHARNESS_PUBLIC_URL=https://…` |

## Riscos ACEITOS, com o número medido

### R1 — MCP público + tools que spawnam agente sem prompt

**Aceito: é o produto.** Ver "Em uma tela", item 1. Mitigações reais: token com 4 critérios de
entropia (≥32 chars, ≥10 caracteres distintos, ≥64 bits de Shannon, não repetição de motivo curto);
comparação *timing-safe*; **tiers** que decidem quais tools são sequer **montadas** (o cliente não vê
o que o tier não monta); risk matrix por board; ledger. Sem token declarado na env a superfície
**não existe** (404 nu) e nada a arma sozinho.

### R2 — single-operator, sem RBAC

**Aceito por desenho** ([SECURITY.md](../SECURITY.md)). A régua da categoria faz o mesmo (o OpenClaw
declara não ser fronteira multi-tenant hostil; o claude-hermes não tem painel web). O dano de
interpretar errado é concreto: alguém lê `ro` como "conta somente leitura" e entrega o painel a mais
gente.

### R3 — `next@14.2.35`: 21 advisories e nenhuma correção possível em 14.x

**Medido (SCA real, OSV, fecho de 744 pacotes):** `next@14.2.35` carrega **21 advisories**
(8 HIGH / 11 MODERATE / 2 LOW, CVSS máx 8.6). A linha 14.x está encerrada — a dist-tag está congelada
em 14.2.35, e **nada em 14.x os fecha**. A menor versão que fecha **tudo** é **15.5.21**. Ficar em 14
é **decisão do dono** (registrada no plano OSS): o major atinge exatamente o entrypoint próprio e o
`instrumentation.ts`, e o detalhe interno do Next em que a refutação (a) se apoia foi verificado em
14.2.35.

**Pré-auth de verdade neste alvo:** classe DoS sobre o pipeline RSC (3× CVSS 7.5), alcançável por
`/login`, que é rota `pre-session` por necessidade; e `GHSA-955p` (recon: ids de Server Action vazam
pelos chunks de `/_next/static`, fora do matcher do middleware).

**Duas refutações — sem elas, alguém "conserta" o que já está fechado:**

- **(a) `GHSA-c4j6-fc7j-m34r`** (CVSS 8.6; **maior EPSS de todo o lote** — 0.389, percentil 0.984;
  SSRF por **upgrade** de WebSocket): **não alcançável**. O ataque exige o servidor Node embutido do
  Next tratando o evento `upgrade`. Aqui o entrypoint próprio entrega ao Next um `EventEmitter`
  **morto** como `wsOwner` e destrói todo upgrade fora de `/ttyd/*` — **ser dono do evento `upgrade`
  REMOVE a superfície, não a cria** (duas frentes de auditoria leram isso ao contrário).
  > ⚠️ **Esta proteção CAI com `AGILEHARNESS_DEV=1`.** Em dev o listener volta ao servidor do Next
  > (o HMR depende dele), o handshake passa a ser aceito sem `Origin`, e o bundler serve fonte a quem
  > chegar. `AGILEHARNESS_DEV` **nunca** em produção: ausente = produção, o lado seguro.
- **(b) `GHSA-89xv-2m56-2m9x`** (SSRF em Server Actions com servidor custom): exige **alcançar** uma
  Server Action, e o portão nega por default **antes** do dispatch. A defesa é o middleware — ela cai
  no dia em que a rota entrar na lista de rotas públicas (é o que o teste `oss-docs-truth` pina).

`postcss@8.4.31` (3 advisories) está pinado **exato** dentro do `next@14.2.35`: não sai por bump de
topo, só com o major.

### R4 — o `js-yaml` interno do `gray-matter` (`GHSA-52cp`), fechado pela resolução

**Medido (2026-07-30):** o parser de frontmatter é o `gray-matter@4.0.3`, que declara `js-yaml@^3.13.1`
e resolvia então para **3.14.2**, alcançada pelo advisory **`GHSA-52cp`** (A:H — DoS por CPU
**quadrática** em cadeia de *merge-keys*): todo card e todo `board.yaml` passa por ali. Não saía por
bump da **nossa** dependência declarada — quem prendia a versão era o intervalo transitivo do
`gray-matter` — e foi aceito COM mitigação e prazo (2026-10-31), com disposição VEX `affected`.

**Re-medido (2026-09-10, v0.2.2):** o mesmo intervalo resolve hoje para **`js-yaml@3.15.2`**, que
carrega a correção (3.15.0). O advisory saiu do relatório de SCA e as duas disposições `affected`
saíram do `vex-dispositions.json` com as outras dez que o gate listava como obsoletas — a lista está
vazia, e quem prova que o gate continua funcionando é a fixture da suíte de supply-chain (seis
disposições sintéticas, uma por verificador). O que **permanece**, e é regra deste documento, é o
chokepoint: o teto de bytes/profundidade/nós antes do parser **limita** o custo de um documento
hostil e **não elimina** a classe de CPU desproporcional em YAML — um documento dentro dos tetos ainda
pode custar mais do que parece. O teto é ajustável pelo operador (`AGILEHARNESS_FRONTMATTER_MAX_*`);
apertá-lo reduz a janela e aumenta o risco de recusar dado legítimo.

### R5 — o token MCP **já vazou** em claro nos logs do sistema

**Medido, não teórico: 174 ocorrências** do token em claro — **168** no journal do proxy reverso e
**6** no syslog (arquivo corrente + rotação). Nenhuma misconfiguração participou disso: quem escreveu
foi o **logger de erro padrão** do Caddy (`logger":"http.log.error"`), que registra a URI completa do
pedido quando o upstream falha — e o token viaja **no path** (`/api/usm/<token>/mcp`).

A lição é transferível e vale para qualquer instalação: **credencial no path vaza em toda camada** —
log de acesso e de erro do proxy, journal do systemd, syslog, histórico de shell, `Referer`, APM.
Não há como o app impedir isso: a URI já está no proxy antes de chegar aqui.

**Mitigação que o produto tem:** o **handle** revogável — um id público com segredo próprio
(`--list-mcp-handles` / `--revoke-mcp-handle <id>`), que invalida no request seguinte, **sem
restart** e sem rotacionar o segredo primário nem reconfigurar conector. Um handle que apareceu num
log é descartável.
**Redação no proxy: FEITA nesta instalação em 2026-08-06** (continua sendo recomendação para quem
instala — o app não controla o proxy de ninguém). O filtro vive no bloco **global** do Caddyfile, e
o lugar importa: um `log` de *site* configura o log de **acesso** e não toca no de erro, que é
justamente quem vazava. O bloco:

```
{
	log {
		format filter {
			wrap console
			fields {
				request>uri regexp "/api/usm/[^/]+/" "/api/usm/REDIGIDO/"
			}
		}
	}
}
```

Par discriminante, upstream derrubado de propósito nas duas passadas: sem o bloco a agulha aparece
1×; com o bloco, 0×, e a linha vira `/api/usm/REDIGIDO/`.

⚠️ **A contagem cresceu entre duas medições — 168 → 169 —** e é isso que prova que o canal estava
**armado**, não histórico: cada restart com o conector ativo re-gravava. Como o harness se
auto-deploya, endurecer *aumentava* a taxa do vazamento.

**O que a redação NÃO resolve, e segue pendente:** as ocorrências que já estão no disco. O journal é
persistente (`/var/log/journal`) e legível por root — o que numa casa operada por agentes inclui as
sessões de agente, que é exatamente como um token vira transcrição. Trate qualquer token que já
apareceu num log como comprometido: **rotacione**. Rotacionar é mais barato que purgar journal.

### R6 — a CSP está em **report-only**: XSS no painel tem UMA camada

**Aceito conscientemente.** O App Router do Next 14 injeta scripts de bootstrap/hidratação inline sem
nonce: `script-src 'self'` mata a hidratação (o painel abre e congela) e `'unsafe-inline'` não impede
XSS nenhum. O único desenho que serviria é nonce-por-request, que é outra frente.

**O que sobra hoje:** a única camada que fecha XSS no painel é o **escape por default do React**.
Consequências práticas: todo `dangerouslySetInnerHTML` novo é mudança de segurança, não de estilo; e
o valor real do report-only é **visibilidade** — um egress novo (script de CDN, beacon, `fetch` para
fora) aparece no console do operador antes de virar exfiltração silenciosa. Não há endpoint de
coleta: a violação só existe no navegador de quem está olhando.

### R7 — dois mecanismos chamados "sandbox", com defaults OPOSTOS

Este capítulo dizia "o sandbox nasce desligado" e valia para o único que existia. Depois de F0
(ADR-067) existem dois, e tratá-los como um só é como o operador acaba puxando a alavanca errada.

**(a) Contenção do SO — nasce LIGADA, e é fail-closed.** O autorun de tier `full` emitia
`--dangerously-skip-permissions` e, como o serviço roda como root, o motor ainda injetava `IS_SANDBOX=1`
para furar a trava do próprio CLI. Isso morreu. Hoje o run nasce dentro de uma fronteira de processo
(bubblewrap no Linux, Seatbelt no macOS): escrita liberada para a árvore de trabalho, egresso por
allowlist. **Onde a fronteira não sobe, a autonomia é NEGADA ou rebaixada com aviso alto** — a
degradação inverteu de sinal (era *fail-open*, e ninguém percebia). O comportamento antigo só volta com
`AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1`, que é feio de propósito.

**A FRONTEIRA É DE ESCRITA E EGRESSO — A LEITURA DO HOST É IRRESTRITA.** Está aqui, no corpo do capítulo
e não numa nota de rodapé, porque é a suposição que o leitor faz sozinho e que o produto não cumpre. O
settings emitido por `buildSandboxSettings` tem `filesystem.allowWrite` (e às vezes `filesystem.denyWrite`)
e **nenhum `allowRead`/`denyRead`**. Medido gerando o settings pela função de PRODUÇÃO e rodando o CLI real
com `allowWrite` apontando para um envelope em `/tmp`:

```
$ cat /tmp/ah-canario-fora.txt ; echo RC=$?        # FORA do envelope, modo 600
CANARIO-FORA-DO-ENVELOPE
RC=0
```

E o controle negativo no MESMO run, provando que a cerca estava de pé: `/tmp/ah-escrita-fora.txt:
Read-only file system`, `RC_ESCRITA_FORA=1`, `RC_ESCRITA_DENTRO=0`. `cat /etc/shadow` devolve o arquivo
inteiro. Consequência para o modelo de ameaça: um run comprometido por injeção de prompt **não** consegue
estragar o host fora do envelope nem exfiltrar pela rede (allowlist de dois domínios), mas **consegue ler**
todo o resto do disco — outros boards, `/etc`, o histórico, qualquer credencial que não esteja enumerada.
A exceção real é `sandbox.credentials.files` (`~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.claude/.credentials.json` + os três do harness), que **é** aplicada — medido: caminho da lista sai
`Permission denied (os error 13)`, vizinho fora dela é lido. A leitura é negada **por enumeração**, não por
envelope. Ver a tabela de pendências do ADR-067 para a opção de emitir `filesystem.denyRead`/`allowRead`.

O recorte da ESCRITA, medido e não inferido: **os comandos de shell** do run são barrados pelo kernel
(`Read-only file system`); a escrita pelas **ferramentas nativas** `Write`/`Edit` é barrada pela camada
de permissão (`acceptEdits`), não pelo kernel. As duas negam, por mecanismos de força diferente.

**`enableWeakerNestedSandbox` está LIGADO nesta instalação, e é DERIVADO de sonda — ninguém o configurou.**
Onde o passo de seccomp do CLI não sobe com um `/proc` novo (o caso deste host), o sandbox só sobe nesse
modo, que **bind-monta o `/proc` existente** em vez de criar um novo e por isso expõe informação de
processo do host — a documentação do CLI diz que enfraquece consideravelmente. A troca é explícita:
*alguma* contenção com `/proc` compartilhado, em vez de nenhuma. `AGILEHARNESS_SANDBOX_WEAKER_NESTED` é só
override (`1`/`0`); o valor efetivo vem de `runSetgroupsProbe`. Confira no seu host com
`bwrap --unshare-user --unshare-pid --proc /proc --dev-bind / / sh -c 'echo deny > /proc/self/setgroups'` —
falhou (aqui: `I/O error`) ⇒ o modo weaker será ligado sozinho.

**Ubuntu 23.10+ retira a contenção de quem roda como não-root.** Medido aqui (Ubuntu 24.04.4, kernel
6.8.0-124): `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` = `1`; como root
`bwrap --unshare-user --dev-bind / / true` sai `0`; como uid 65534 sai `1` com
`setting up uid map: Permission denied`. Ou seja, o adotante que roda sob usuário dedicado — a escolha mais
segura — instala as dependências e **mesmo assim** fica sem contenção, com o aviso mandando instalar o que
já está instalado. As saídas (root, `sysctl`, perfil AppArmor) estão no [SECURITY.md](../SECURITY.md), item 7.

**O envelope efetivo é maior que "a árvore do run"**, e a diferença é declarada aqui em vez de ficar só
no ADR: inclui o `$TMPDIR` da sessão e o **gitdir** de um worktree linkado
(`<checkout>/.git/worktrees/<n>/` — dentro do checkout principal). O gitdir escrevível é *necessário*
(é o que faz `git add`/`git commit` funcionarem contidos) e não foi analisado como caminho de
influência: a config de worktree que mora ali é lida por invocações de `git` que o harness roda fora do
sandbox. Superfície declarada, não estudada — sem exploração demonstrada.

**Limite funcional medido:** cada chamada Bash recebe PID e *network namespace* próprios. Um serviço
iniciado numa chamada não é alcançável de outra (nem com `nohup &`, nem com o background do CLI), e
`/tmp` é read-only. Fluxos que sobem um servidor e o consultam num passo posterior **não funcionam** com
a contenção ligada — ver a tabela de pendências do ADR-067.

**(b) Sandbox estrutural (ADR-063) — REMOVIDO em 2026-08-05.** Ele remontava read-only o `node_modules`
compartilhado e o store do bun num namespace por run, e era *fail-open* por design declarado ("must never,
by itself, fail a run"). Saiu junto com o pouso de (a), e não por redundância: **os dois contratos eram
opostos**. Manter uma camada que promete nunca reprovar ao lado de uma que recusa quando não consegue
conter é garantir que um dia alguém confie na errada — e a errada é sempre a que deixa passar. Risco da
remoção, medido antes: o flag nascia desligado, nenhum board o ligava, e a env que o ativaria estava
ausente do ambiente do serviço. A propriedade que ele comprava ("o run não conserta infra") passa a ser
coberta por (a), que recorta a escrita à árvore do run.

**Risco ACEITO e declarado:** (a) cobre o **autorun**, a tool MCP **`run_task`**, o **revisor par**
(`runner/peer-review-spawn.ts`) e o **juiz de conflito** (`runner/resolution-judge-spawn.ts`) — os quatro
resolvem a postura pelo mesmo `resolveAutonomyPosture`/`buildSpawnFlags` e passam pelo mesmo portão
(`assertContainmentReachedArgv`). ⚠ Uma redação anterior desta linha dizia "apenas o autorun" e listava
**seis** superfícies fora da cerca, incluindo o revisor par e o juiz de conflito — que **migraram nesta
fase** — e sem mencionar `run_task`, que também migrou e foi então descrita como a **única alcançável de
fora**. O número era falso no momento em que foi escrito, e a descrição de `run_task` também era.

Restam **quatro** superfícies não contidas — **deploy autônomo, captura, chat do copiloto e a sessão de
card em `/terminal`** — que seguem com `--dangerously-skip-permissions` sem contenção. Estão travadas por
um lint que casa a própria flag, e a lista só encolhe.

⚠ **CORREÇÃO MEDIDA — "todas as quatro exigem sessão autenticada no painel" é FALSO.** São **duas** as
superfícies alcançáveis **sem cookie de painel**: `run_task`, que migrou, e a **CAPTURA**, que não. O
endpoint MCP público (`/api/usm/<credencial>/mcp`) monta `report_issue` e `usm_capture` (classe de risco
`write-board` ⇒ nível `write` já basta, não é preciso o token `full`), e as duas descem por
`reportIssueAction`/`proposeCardsAction` até `runClaudeJson`, que spawna o `claude`. O elo que a prosa
antiga não viu: `requireSession` (`lib/auth/action-guard.ts:308`) devolve `"mcp-token"` assim que existe um
ator MCP no ALS — **um chamador MCP nunca precisou de cookie**. Isso põe a superfície que ingere **texto
livre não confiável** — a que `runner/spawn-chokepoint.test.ts` chama de "a de MAIOR risco de
prompt-injection" — do lado de fora do perímetro de credencial de painel. Detalhe da postura desse filho
(medido): pelo caminho MCP ele **não** leva a flag no argv, mas também **não** leva `--permission-mode`, e
herda `HOME`, logo lê o `~/.claude/settings.json` do host — que nesta instalação declara
`permissions.defaultMode: bypassPermissions`, aceito porque `claude.ts` injeta `IS_SANDBOX=1` como root.
Autonomia plena por **herança de settings**, invisível na linha de comando. Das outras três: chat do
copiloto e sessão de card em `/terminal` foram medidos como realmente atrás do painel; o **deploy
autônomo** é alcançável **em banda** (mover card por MCP para coluna com `onEnter` ⇒ classe `deploy`,
montável em `orch`/`full`), o que não é o mesmo que "exige painel". A fila de F1 está no ADR-067.

**Limitação conhecida, medida:** o CLI **mescla** o `sandbox.*` do `.claude/settings.json` do projeto no
envelope efetivo, e nenhuma variante de `--setting-sources` impede. Como o agente pode escrever dentro
da árvore de trabalho, ele pode plantar esse arquivo e o run SEGUINTE nasceria com a cerca ampliada —
escalação entre runs pelo próprio mecanismo de contenção. A resposta do harness é **detectar e recusar**
por spawn, lendo o estado atual da árvore. Não é garantia do kernel: é o sistema se recusando a operar
quando não pode cumprir o que anuncia.

### R8 — `AGILEHARNESS_PUBLIC_URL` é obrigatória em deploy não-loopback

Sem ela, o portão emite `Location: http://localhost:3008/login` e **quem chega pelo domínio não
loga** — e a decisão do `Secure` do cookie perde a única fonte que não é header do pedido. Não é
recomendação de estilo: é configuração sem a qual o perímetro se comporta como se estivesse em
loopback.

### R9 — as lanes de feedback estão ABERTAS, com o portão DENTRO da rota

**Medido (2026-09-09, issue #2):** de 2026-07-27 até essa data a lane de **INGEST** (header
`x-ah-ingest`) e a lane **EMBED** ficaram inertes — `/api/feedback/intake` estava atrás do portão de
sessão, que devolvia 401 ao relay **antes** de qualquer token ser lido; o relay da instalação de
referência registrou zero execuções em 30 dias. As duas rotas (`/api/feedback/intake` e
`/api/feedback/shot`) saíram do portão pela via declarada: classificadas como `self-auth` na lista
única de rotas públicas, com o motivo escrito.

O que substitui o portão, **na própria rota**: (1) `classifyIntake` só concede a lane same-origin
com sinal POSITIVO — sem `Origin`, recusa; (2) a lane same-origin exige a **sessão do operador**,
verificada por `lib/feedback/session-gate.ts` com a MESMA `verifySession` do middleware e do gateway
do terminal — porque `Origin` é um header que um cliente não-navegador escreve à vontade; (3) INGEST
prova-se pelo token timing-safe e EMBED por origem allowlistada + nonce, ambas colapsadas a
triage-only e limitadas por taxa. Sem token nem allowlist declarados na env, as duas lanes **não
existem** (fail-closed permanece). O catálogo (`/destinations`) e o nonce seguem atrás do portão.

## Suposições — se uma cair, o modelo cai

1. **Há um operador**, e a credencial dele não é compartilhada.
2. **A máquina é confiável e descartável**: o serviço roda como `root` na instalação de referência, e
   qualquer comprometimento é comprometimento da máquina inteira, não de um app.
3. **`AGILEHARNESS_DEV` está ausente em produção** (é o que mantém a refutação (a) de R3 válida).
4. **TLS é terminado por fora**, e `AGILEHARNESS_PUBLIC_URL` está declarada.
5. **O conteúdo ingerido não é adversarial** — o chokepoint limita forma e volume, não intenção.
6. **Toda superfície nova passa pelos chokepoints** (portão, spawn, frontmatter, proveniência). Os
   testes de exaustividade existem para que uma superfície nova falhe em vez de nascer isenta.

## Referências

- [SECURITY.md](../SECURITY.md) — política de divulgação, single-operator, revogação.
- `src/lib/storymap/oss-docs-truth.test.ts` — pina as afirmações deste documento ao código; mudar o
  código sem mudar o texto reprova.
- OpenClaw (segurança do gateway e sandboxing), claude-hermes (tiers nomeados), Anthropic (sandboxing
  e *auto mode* do Claude Code) — a régua comparativa usada nas decisões acima.
