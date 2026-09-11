# AgileHarness

Board de **User Story Mapping** (Jeff Patton) que não apenas organiza o trabalho — ele **executa**.
Um card entra numa coluna, um agente Claude headless assume, faz o trabalho e avança o card; *gates*
entre as colunas impedem que um card avance sem cumprir o pré-requisito. O board é a fonte da
verdade de produto (Markdown no disco), o agente é o operário, e um *merge train* integra o que cada
run produziu.

> ## ⚠ Leia antes de instalar: o que esta ferramenta faz na sua máquina
>
> O AgileHarness **não é um quadro Kanban com um plugin de IA**. É um orquestrador de processos com
> poder de execução, e é exatamente isso que o torna útil:
>
> - **spawna agentes que editam arquivo, rodam comando e commitam sem nenhum prompt de confirmação.**
>   No **autorun** isso acontece dentro de um **sandbox imposto pelo sistema operacional** (bubblewrap
>   no Linux, Seatbelt no macOS): os comandos de shell do run recebem `Read-only file system` fora da
>   árvore de trabalho, pelo kernel, não pelo julgamento do modelo (as nativas `Write`/`Edit` também são
>   negadas fora dela, por mecanismo mais fraco — a camada de permissão; SECURITY.md, item 7);
> - **essa fronteira é de ESCRITA e EGRESSO — a LEITURA do host é IRRESTRITA.** O run contido lê qualquer
>   arquivo que o usuário do serviço lê. Medido com o settings de produção e o CLI real: `cat /etc/shadow`
>   devolve o conteúdo com `RC=0` de dentro do sandbox. As únicas exceções são os caminhos de credencial
>   negados um a um (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude/.credentials.json` e os três do harness);
> - **as outras QUATRO superfícies ainda usam `claude --dangerously-skip-permissions`**, sem sandbox
>   nenhum: deploy autônomo, captura, chat do copiloto e a sessão de card em `/terminal`. **DUAS delas são
>   alcançáveis SEM sessão de painel**, não uma: `run_task`, que por isso migrou primeiro, e a **captura**,
>   que NÃO migrou — as tools MCP `report_issue` e `usm_capture` chegam ao spawn dela pelo endpoint público,
>   e é a superfície que ingere TEXTO LIVRE não confiável. Um lint casa a flag, e a lista só encolhe;
> - **onde o sandbox não sobe, a autonomia é NEGADA, não concedida em silêncio** — o run é recusado ou
>   rebaixado com aviso alto; voltar ao antigo exige `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1`, feio de
>   propósito. Alvo que declare `sandbox` no próprio `.claude/settings.json` também faz o run ser recusado,
>   mas **só quando AMPLIA** — o que apenas ESTREITA passa, e chave desconhecida conta como ampliação;
> - **o run contido não alcança a rede aberta** — só `api.anthropic.com` e `statsig.anthropic.com` (medido:
>   `git ls-remote github.com` sai 128); `AGILEHARNESS_SANDBOX_ALLOWED_DOMAINS` **estende**, nunca substitui;
> - **a limpeza destrutiva tem freio**: `AGILEHARNESS_REAPER_MODE=report` faz o coletor de branches de
>   boot **relatar** o que apagaria em vez de apagar — ligue ao apontar o motor para um repositório novo;
> - **os processos herdam o usuário do serviço, que na instalação de referência é `root`** — um
>   comprometimento não é "a conta de um app", é a máquina inteira; e o sandbox **não** reduz o das quatro;
> - **serve um shell interativo por WebSocket** (`/terminal` → `/ttyd/*`), autenticado pela mesma
>   sessão do painel;
> - **publica um endpoint MCP alcançável pela internet** (`/api/mcp/<token>/mcp`) — é assim que um
>   conector Claude chega às tools, e as tools são as de cima.
>
> Nada disso é efeito colateral a consertar: é **o produto**. O que existe para ser bem feito é o
> **perímetro** — quem entra, com qual credencial, e o que executa conteúdo vindo de fora. A postura
> completa, incluindo o que ela **não** cobre, está em **[SECURITY.md](SECURITY.md)** e em
> **[docs/threat-model.md](docs/threat-model.md)**. Se você pretende expor isto além do `localhost`,
> esses dois documentos são pré-requisito, não leitura opcional.

## Como ele roda

Um serviço HTTP de **longa duração**, não um `next dev` que você abre e fecha:

- **entrypoint próprio**: `src/server/main.ts`, empacotado por `bun build` em `dist/ah-server.mjs` e
  executado por `node`. **Não** é `next start` — o servidor precisa ser dono do evento `upgrade` do
  `http.Server` para autenticar o WebSocket do terminal com a mesma sessão do painel (`next start`
  não trata `upgrade`, e por isso aquela superfície ficava fora do portão);
- **em produção, uma unit systemd** (`storymap.service` na instalação de referência), com rebuild +
  restart como caminho de deploy. Não há build estático, não há Firebase Hosting: Server Actions e
  Route Handlers leem e escrevem arquivos do board no disco local;
- **bind em `127.0.0.1` por default**, com TLS/proxy reverso por fora. Abrir o bind
  (`AGILEHARNESS_HOST=0.0.0.0`) é uma escolha explícita: uma auto-checagem no boot audita a entropia
  de cada credencial alcançável e **recusa subir** se algo reprovar.

## Quickstart (local, loopback)

```bash
# PRÉ-REQUISITO DE KERNEL (Ubuntu 23.10+): não-root não cria user namespace.
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns   # 1 = contenção NÃO sobe
# 1 ⇒ rode como root, OU zere o sysctl, OU dê perfil AppArmor ao bwrap (SECURITY.md)

# PRÉ-REQUISITO DE PACOTES — sem isto o autorun não escreve código (veja abaixo)
sudo apt install bubblewrap socat     # Debian/Ubuntu · Fedora: sudo dnf install bubblewrap socat
                                      # macOS: nada a instalar (Seatbelt é nativo)

bun install            # no repositório standalone. Dentro de um monorepo, instale na RAIZ dele
bun run build          # next build + bun build do entrypoint (dist/ah-server.mjs)
bun run start          # node dist/ah-server.mjs → http://127.0.0.1:3008
```

**Por que o `apt install` é pré-requisito e não sugestão.** Debian/Ubuntu de fábrica não trazem
`bubblewrap` nem `socat`. Sem eles a contenção do SO não sobe, e o default (`preferred`) **rebaixa todo
run de autonomia plena** — o agente perde o Bash e o recurso de manchete (autorun que escreve código)
para de funcionar. A degradação é ruidosa no log, mas o sintoma que você vê primeiro é um passo falhando
por falta de shell, não "instale bubblewrap". Prefere rodar sem contenção? A decisão existe e é
explícita: `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1`, com tudo o que o bloco acima descreve.

**E por que instalar os pacotes pode não bastar.** Ubuntu 23.10+ restringe a criação de *user namespace*
por processo não privilegiado, e é disso que o bubblewrap depende. **Medido nesta instalação de
referência** (Ubuntu 24.04.4, kernel 6.8.0-124, bubblewrap 0.9.0):

```
$ cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
1
$ bwrap --unshare-user --dev-bind / / true                      # como root
$ echo $?
0
$ setpriv --reuid=65534 --regid=65534 --clear-groups bwrap --unshare-user --dev-bind / / true
bwrap: setting up uid map: Permission denied
$ echo $?
1
```

Ou seja: **o adotante que faz a coisa mais segura — rodar o serviço como não-root — instala os dois
pacotes e mesmo assim fica sem contenção.** O aviso de degradação vai dizer "instale as dependências",
e nesse host esse é o conselho errado: elas já estão instaladas. As saídas reais estão no
[SECURITY.md](SECURITY.md), item 7 (rodar como root, zerar o sysctl, ou um perfil AppArmor para o `bwrap`).

E onde o sandbox **sobe**, ele pode subir em modo enfraquecido: `enableWeakerNestedSandbox` é ligado
**automaticamente** (derivado de sonda, não configurado) em hosts — como este — cujo kernel não deixa o
CLI montar um `/proc` novo. Nesse modo ele bind-monta o `/proc` **existente**, expondo informação de
processo do host. É a troca declarada: alguma contenção em vez de nenhuma. Detalhe e comando de
verificação no [SECURITY.md](SECURITY.md), item 7.

**O isolamento por worktree passou a nascer LIGADO** (`autorun.worktreeIsolation`, default `true` em
`src/lib/storymap/runner/config.ts`; era `false`). O motivo é que sem worktree o `writeRoot` de um run de
código é o `cwd` — a **raiz do repositório inteiro** —, então a promessa de perímetro que o bloco acima faz
seria falsa: a cerca existiria e conteria tudo o que você tem. Quem já roda e dependia do comportamento
antigo declara `AGILEHARNESS_AUTORUN_WORKTREE=0` e volta ao anterior, **abrindo mão do perímetro de escrita**; o
efeito visível de ligado é um checkout por run e a integração passando pelo merge train.

O primeiro boot cria o token do operador em `storymap/.runner/auth-token` (ou use
`AGILEHARNESS_AUTH_TOKEN`) — é ele que a tela `/login` pede. Para desenvolvimento com hot-reload,
`bun run dev` (`AGILEHARNESS_DEV=1`); leia no `SECURITY.md` o que esse modo desliga.

`.env.example` documenta todos os knobs de operador (`AGILEHARNESS_*`; as grafias antigas `STORYMAP_*`/`USM_*` seguem aceitas com aviso até a próxima minor)
com o porquê de cada default.

## O perímetro em uma tela

| Superfície | Quem autentica | Observação |
|---|---|---|
| Painel, Server Actions e `/api/*` | middleware + cookie de sessão (`SameSite=Lax`), **nega por default** | as exceções vivem numa lista única (`src/lib/auth/public-routes.ts`), cobrada por teste de exaustividade |
| `/login`, `/api/auth`, `/api/health`, assets do PWA | nada (alcançável antes de existir sessão) | o login se autentica pelo token do operador |
| `/api/mcp/<token>/mcp` | token no path, comparado *timing-safe*, com piso de entropia | canal dos agentes headless, que não têm navegador nem cookie |
| `/api/runner/*` | *shared secret* próprio | webhooks e SSE do runner, chamados em `127.0.0.1` |
| `/terminal` e `/ttyd/*` (HTTP e WS) | mesma sessão do painel **+** checagem de `Origin` | o ttyd fica preso em loopback, alcançável só por este processo |

Sem token declarado na env, a superfície MCP **não existe** (404 nu) — nada a arma por conta própria.

## Documentação

- **[SECURITY.md](SECURITY.md)** — política de divulgação, o modelo *single-operator*, e como revogar.
- **[docs/threat-model.md](docs/threat-model.md)** — o que o sistema protege, o que **não** protege,
  e sob qual suposição. Inclui os riscos aceitos com número medido.
- **`.env.example`** — todo knob de operador, com o porquê de cada default (é o mais próximo de um
  manual de configuração que existe).
- **A própria suíte** é documentação executável: cada teste `oss-*`, `*-audit` e `public-routes`
  descreve o ATAQUE que ele impede no comentário de topo.
