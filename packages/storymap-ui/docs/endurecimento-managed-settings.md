# Endurecimento por MANAGED SETTINGS — o teto que o alvo não alcança

**Status:** documento de operação · **Medido contra:** `claude 2.1.222` (commit `fbf49312c284`, linux-x64),
binário em `/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` · **Data da medição:** 2026-08-05

Este documento existe por causa de um buraco nomeado na **Sonda W** do
[ADR-067](../../../docs/adr/ADR-067-sondas-f0-multitarget.md): o CLI **mescla** o `sandbox.*` do
`.claude/settings.json` do repositório-alvo no envelope efetivo, e o agente contido pode escrever esse
arquivo — logo o run SEGUINTE nasce com a cerca ampliada. A defesa que F0 embarcou é **detectar e
recusar** (`resolveAutonomyPosture`): correta, mas é o próprio sistema se policiando.

A camada que a indústria usa para esta classe — *o alvo reconfigura a ferramenta* — é uma configuração
que o alvo **não pode escrever**: git chama de *protected configuration*, VS Code de *Workspace Trust*, e
o Claude Code chama de **managed settings**. Este documento mede o que ela compra neste binário, entrega
um template pronto, e diz o preço.

> **A regra deste repositório vale aqui também:** o que não foi medido está escrito como **não medido**.
> Toda citação abaixo foi extraída do binário instalado, com o comando ao lado.

---

## 0. Como reproduzir as citações

```bash
BIN=/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
strings -a "$BIN" > /tmp/cli-strings.txt

# os caminhos e o drop-in
grep -o "managed-settings[^\"']*" /tmp/cli-strings.txt | sort -u
grep -o "/etc/claude-code[^\"' ]*"  /tmp/cli-strings.txt | sort -u

# uma chave qualquer do schema zod (as descrições vivem em .describe(...))
grep -n "allowManagedPermissionRulesOnly" /tmp/cli-strings.txt
```

As descrições longas estão concatenadas com `+` no bundle (`"…" + "…"`), então um `grep` simples corta
a frase no meio. As citações deste documento foram remontadas juntando os pedaços do literal.

---

## 1. Onde o arquivo mora

Extraído do próprio resolvedor de caminho (uma linha do bundle, `grep -o '.\{200\}managed-settings\.d.\{0,400\}'`):

```js
switch ($t()) {
  case "macos":   return "/Library/Application Support/ClaudeCode";
  case "windows": return "C:\\Program Files\\ClaudeCode";
  default:        return "/etc/claude-code";
}
// … e o drop-in:
join(fU(), "managed-settings.d")
```

| Plataforma | Arquivo | Drop-in |
|---|---|---|
| Linux / WSL | `/etc/claude-code/managed-settings.json` | `/etc/claude-code/managed-settings.d/*.json` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` | `…/ClaudeCode/managed-settings.d/*.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` | `…\ClaudeCode\managed-settings.d\*.json` |

O drop-in é lido depois do arquivo principal: só `*.json`, arquivos ou symlinks, ignorando os que começam
com `.`, **em ordem alfabética**, e cada um é mesclado por cima do acumulado. Diretório ausente
(`ENOENT`/`ENOTDIR`) é silêncio; qualquer outro erro vira log de nível `error`.

**Medido neste host:** `/etc/claude-code` **não existe** — nenhuma política administrativa está em vigor
hoje. Toda a medição abaixo usou um `/etc/claude-code` **falso**, montado só dentro do namespace da
sonda (§4), sem tocar o `/etc` real.

---

## 2. O que a camada compra — citações literais do schema

Todas as frases abaixo são o texto do `.describe(...)` da chave no schema zod embutido no binário.

### 2.1 As chaves "só o admin manda"

| Chave | Citação literal |
|---|---|
| `allowManagedPermissionRulesOnly` | *"When true (and set in managed settings), only permission rules (allow/deny/ask) from managed settings are respected. User, project, local, and CLI argument permission rules are ignored."* |
| `allowManagedDomainsOnly` (sob `sandbox.network`) | *"When true (and set in managed settings), only allowedDomains and WebFetch(domain:...) allow rules from managed settings are respected. User, project, local, and flag settings domains are ignored. Denied domains are still respected from all sources."* |
| `allowManagedHooksOnly` | *"When true (and set in managed settings), only hooks from managed settings run. User, project, and local hooks are ignored."* |
| `allowManagedMcpServersOnly` | *"When true (and set in managed settings), allowedMcpServers is only read from managed settings. deniedMcpServers still merges from all sources, so users can deny servers for themselves. Users can still add their own MCP servers, but only the admin-defined allowlist applies."* |
| `allowManagedReadPathsOnly` (sob `sandbox.filesystem`) | *"When true (set in managed settings), only allowRead paths from policySettings are used."* |

### 2.2 ⚠ `strictCustomizationSources` NÃO EXISTE neste binário

A chave que a pesquisa de arte prévia nomeou como `strictCustomizationSources` **não aparece no binário
2.1.222** (`grep -c strictCustomizationSources` ⇒ **0**). A chave real, que faz o que aquele nome sugere,
chama-se **`strictPluginOnlyCustomization`**:

> *"When set in managed settings, blocks non-plugin customization sources for the listed surfaces. Array
> form locks specific surfaces (e.g. `["skills", "hooks"]`); `true` locks all four; `false` is an explicit
> no-op. Blocked: `~/.claude/{surface}/`, `.claude/{surface}/` (project), `settings.json` hooks,
> `.mcp.json`. NOT blocked: managed (policySettings) sources, plugin-provided customizations. Composes
> with strictKnownMarketplaces for end-to-end admin control — plugins gated by marketplace allowlist,
> everything else blocked here."*

Registrado com o nome errado ao lado do certo de propósito: quem procurar pelo nome da pesquisa não vai
achar, e um template com uma chave inexistente é uma proteção que mede zero.

### 2.3 As chaves de sandbox que **só** o admin pode setar

| Chave | Citação literal |
|---|---|
| `sandbox.bwrapPath` | *"Linux/WSL only: Absolute path to the bwrap (bubblewrap) binary. Overrides auto-detection via PATH. **Only honored from admin-controlled managed settings.**"* |
| `sandbox.socatPath` | *"Linux/WSL only: Absolute path to the socat binary used for the sandbox network proxy. Overrides auto-detection via PATH. **Only honored from admin-controlled managed settings.**"* |

Elas importam para este harness porque `bwrap` e `socat` são **pré-requisito de host declarado** do tier
`full` (ADR-067, Sonda D): fixá-los por caminho absoluto tira a contenção da dependência do `PATH` de
quem iniciou o serviço.

### 2.4 O portão duro: `sandbox.failIfUnavailable`

> *"Exit with an error at startup if `sandbox.enabled` is true but the sandbox cannot start (missing
> dependencies or unsupported platform). When false (default), a warning is shown and commands run
> unsandboxed. **Intended for managed-settings deployments that require sandboxing as a hard gate.**"*

O harness **já emite** `failIfUnavailable: true` no settings que passa por `--settings`
(`buildSandboxSettings`, `autonomy-sandbox.ts`). Repeti-lo no managed muda **quem** garante: hoje é o
próprio harness que escolhe ser fail-closed; com o managed, é o admin — e nada que rode nesta máquina
consegue voltar atrás.

### 2.5 A chave que fecha a Sonda W: `sandbox.filesystem.disabled` (e o *pinning*)

Citação completa, e é a mais importante deste documento:

> *"macOS and Linux/WSL only: skip filesystem isolation entirely while keeping network and seccomp
> isolation. […] Only honored from user, managed/policy, or CLI (`--settings`) settings — project settings
> (`.claude/settings.json` and `.claude/settings.local.json`) are ignored. **If managed settings configure
> `sandbox.filesystem` at all, or list any `sandbox.credentials.files` deny entry, only managed settings
> can set this: an admin who deployed filesystem restrictions must not have them switched off by a
> user-writable file.** (`sandbox.credentials.envVars` and `credentials.files` mask entries do not pin it —
> env scrubbing and sentinel binds are independent of the filesystem layer and survive this setting.) When
> unset, filesystem isolation stays on."*

Duas leituras, e vale separar:

1. **`filesystem.disabled` já é imune a projeto** — um `.claude/settings.json` hostil não consegue desligar
   o isolamento de filesystem por essa chave, com ou sem managed settings.
2. **O *pinning*** — a partir do momento em que o managed configura `sandbox.filesystem` (qualquer coisa
   dentro dele) ou uma entrada `deny` em `sandbox.credentials.files`, **só o managed** pode setar
   `disabled`. É a frase que dá nome ao documento: um teto que o alvo não alcança.

⚠ **O que essa citação NÃO diz, e o que a medição do §4 esclarece:** ela fala de `disabled`, não de
`allowWrite`. O `allowWrite` de um `.claude/settings.json` de projeto **continua mesclando** (é a Sonda W,
reproduzida de novo abaixo). O que o managed compra contra ela é o **`denyWrite`**, que foi medido e
vence a mescla.

### 2.6 ⚠ `disableSideloadFlags` — a chave que QUEBRARIA este harness

> *"When true (and set in managed settings), rejects the `--plugin-dir`, `--plugin-url`, `--agents`, and
> non-sdk `--mcp-config` CLI flags at startup. […] Also blocks surfaces that spawn the CLI with these flags
> internally (see settings documentation). Only honored from managed settings; ignored in user/project/local
> settings."*

**NÃO ligue esta chave num host que roda o AgileHarness.** A Sonda A do ADR-067 decidiu que as 22 skills
`harness-*` viajam como **plugin do `toolRoot`**, entregues justamente por `--plugin-dir`. `disableSideloadFlags`
rejeita esse flag *no startup* — todo run de autorun morreria antes de começar. Ela está aqui listada
como **anti-recomendação**, não como parte do template.

---

## 3. Template pronto para copiar

Salve como `/etc/claude-code/managed-settings.json` (root:root, `0644`). **JSON não aceita comentários** —
os comentários abaixo são para leitura; o arquivo `template-limpo` no fim da seção é o que se copia.

```jsonc
{
  // ── 1. O SANDBOX VIRA PORTÃO DURO, e o admin é quem decide ────────────────────────────────────
  "sandbox": {
    // Sem sandbox o CLI SAI COM ERRO em vez de rodar sem contenção mostrando um aviso.
    // O harness já pede isto via --settings; aqui quem garante é o admin, e nada na máquina desfaz.
    "failIfUnavailable": true,

    // Caminhos ABSOLUTOS dos binários da contenção. "Only honored from admin-controlled managed
    // settings" — logo nem o operador nem o repositório-alvo conseguem apontá-los para outro lugar.
    // Confira os seus com `command -v bwrap` / `command -v socat` antes de copiar.
    "bwrapPath": "/usr/bin/bwrap",
    "socatPath": "/usr/bin/socat",

    "filesystem": {
      // ⚠ ESTA É A CHAVE QUE FECHA A SONDA W (medido em §4, par W1/W2).
      // O `.claude/settings.json` do repositório-alvo consegue AMPLIAR o allowWrite (mescla), mas um
      // denyWrite aqui VENCE a mescla e a escrita volta a bater em "Read-only file system".
      // Liste o que NENHUM run pode escrever, nunca. Ajuste à sua topologia.
      "denyWrite": [
        "/etc",
        "/usr",
        "/var/tmp",
        "/root/.ssh",
        "/root/.config/systemd"
      ]
      // ⚠ NÃO ponha "allowWrite" aqui: o envelope de escrita de cada run é POR RUN e vem do
      // --settings que o harness gera (a árvore do run). Um allowWrite fixo no managed seria uma
      // concessão global, exatamente o contrário do que se quer.
      // ⚠ NÃO ponha "disabled": true — é o botão de desligar o isolamento de filesystem.
      //    A mera PRESENÇA deste bloco "filesystem" já PINA o `disabled`: a partir daqui, só o
      //    managed pode setá-lo (citação em §2.5).

      // ── LEITURA (acrescentado em 2026-08-05, junto com a emissão da chave no harness) ──────────
      // Até então esta seção só falava de ESCRITA, porque a política per-run não emitia denyRead —
      // a chave estava declarada no tipo e nunca preenchida, e os caminhos de leitura iam todos para
      // `credentials.files`, que já tinha sido medido vazando. Hoje o harness emite as duas.
      //
      // Por que repetir aqui o que o harness já emite: pela MESMA razão do denyWrite. O que vem do
      // --settings é per-run e o repositório-alvo participa da mescla; o que está no managed não é
      // desfeito por nada na máquina. Se você só tem uma linha de defesa para escolher, é esta.
      //
      // NEGUE DIRETÓRIOS, NÃO ARQUIVOS. Medido no runtime do sandbox: um caminho de deny-read que
      // NÃO EXISTE no instante do wrap é DESCARTADO EM SILÊNCIO. Negar `~/.config/gcloud/access_tokens.db`
      // protege enquanto o arquivo existir e evapora quando ele for recriado; negar o DIRETÓRIO não.
      "denyRead": [
        "/root/.ssh",
        "/root/.aws",
        "/root/.gnupg",
        "/root/.claude/.credentials.json",
        // As credenciais que PUBLICAM EM PRODUÇÃO — medidas legíveis por qualquer run de código
        // antes de 2026-08-05. Um agente que as lê consegue deployar, não só ler.
        "/root/.config/gcloud",
        "/root/.config/configstore"
      ]
      // ⚠ E saiba o que isto NÃO é: negação por ENUMERAÇÃO, não envelope. O que não está nomeado, o
      // run lê — o repositório inteiro, /etc, os outros boards. Não existe `allowRead` que inverta a
      // lógica. Trate esta lista como o que ela é: os alvos de maior valor, nomeados um a um.
    },

    // Credenciais que nenhum run lê, JAMAIS — em qualquer alvo, em qualquer tier.
    // Uma entrada `deny` aqui também PINA o filesystem.disabled (mesma citação).
    // Redundante com o denyRead acima DE PROPÓSITO: são dois mecanismos distintos do runtime, e o
    // histórico deste projeto é de um deles vazar enquanto o outro segurava. Cinto e suspensório.
    "credentials": {
      "files": [
        { "path": "~/.ssh",                    "mode": "deny" },
        { "path": "~/.aws",                    "mode": "deny" },
        { "path": "~/.gnupg",                  "mode": "deny" },
        { "path": "~/.claude/.credentials.json", "mode": "deny" },
        { "path": "~/.config/gcloud",          "mode": "deny" },
        { "path": "~/.config/configstore",     "mode": "deny" }
      ]
    },

    "network": {
      // Egresso mínimo imposto pelo admin. O harness ESTENDE esta lista por run
      // (AGILEHARNESS_SANDBOX_ALLOWED_DOMAINS) — por isso NÃO ligamos allowManagedDomainsOnly abaixo.
      "allowedDomains": ["api.anthropic.com", "statsig.anthropic.com"],
      // Hosts que nunca saem, mesmo que alguém os coloque numa allowlist:
      // "Merged from all settings sources regardless of allowManagedDomainsOnly."
      "deniedDomains": []
      // ⚠ "allowManagedDomainsOnly": true — NÃO ligue enquanto o harness precisar estender a
      //    allowlist por run. Ela faria "User, project, local, and flag settings domains are ignored",
      //    e AGILEHARNESS_SANDBOX_ALLOWED_DOMAINS (que passa por --settings, uma fonte "flag")
      //    deixaria de ter efeito EM SILÊNCIO. Efeito NÃO MEDIDO — ver §6.
    }
  },

  // ── 2. HOOKS: só os do admin ───────────────────────────────────────────────────────────────────
  // "only hooks from managed settings run. User, project, and local hooks are ignored."
  // ⚠ ISTO DESLIGA OS HOOKS DO PRÓPRIO REPOSITÓRIO, inclusive
  //    .claude/hooks/checks/pre-{write,edit}/block-runtime-board-writes.js (a proteção do service.lock,
  //    Sonda B do ADR-067). Ligue SÓ se você replicar esses hooks aqui. Deixado FALSO de propósito.
  "allowManagedHooksOnly": false,

  // ── 3. Regras de permissão: só as do admin ─────────────────────────────────────────────────────
  // MEDIDO (§4, par M4a/M4b): não quebra o `--permission-mode acceptEdits` que o harness passa por
  // CLI — modo e regra são coisas diferentes. O que ele MATA são as regras allow/deny/ask vindas de
  // user/project/local/CLI. Se o seu fluxo depende de uma allow-rule vinda de --settings ou do
  // ~/.claude/settings.json, ela some sem aviso.
  "allowManagedPermissionRulesOnly": true,
  "permissions": {
    // Sob a chave acima, ESTA lista passa a ser a ÚNICA. Comece pelo que o harness realmente precisa
    // e amplie medindo — uma lista curta demais aparece como run travado, não como erro claro.
    "deny": [],
    "ask": [],
    "allow": [],
    // Tira do operador a possibilidade de escolher o modo bypass.
    // ⚠ Confira o seu ~/.claude/settings.json antes: se ele tiver
    //    {"permissions":{"defaultMode":"bypassPermissions"}}, este knob muda o comportamento de TODA
    //    sessão interativa da máquina, não só a do harness.
    "disableBypassPermissionsMode": "disable"
  }

  // ── 4. NÃO INCLUÍDO DE PROPÓSITO ───────────────────────────────────────────────────────────────
  // "disableSideloadFlags": true      → rejeita --plugin-dir no startup ⇒ QUEBRA as 22 skills harness-*
  //                                     (Sonda A do ADR-067). Ver §2.6.
  // "strictPluginOnlyCustomization"   → bloqueia ~/.claude/{skills,hooks}/ e .claude/{skills,hooks}/
  //                                     do projeto. Efeito sobre a entrega por plugin do harness:
  //                                     NÃO MEDIDO. Ver §6.
  // "allowManagedMcpServersOnly"      → o harness registra o próprio servidor MCP; efeito NÃO MEDIDO.
}
```

**Template limpo (JSON válido, é este que se copia):**

```json
{
  "sandbox": {
    "failIfUnavailable": true,
    "bwrapPath": "/usr/bin/bwrap",
    "socatPath": "/usr/bin/socat",
    "filesystem": {
      "denyWrite": ["/etc", "/usr", "/var/tmp", "/root/.ssh", "/root/.config/systemd"],
      "denyRead": [
        "/root/.ssh",
        "/root/.aws",
        "/root/.gnupg",
        "/root/.claude/.credentials.json",
        "/root/.config/gcloud",
        "/root/.config/configstore"
      ]
    },
    "credentials": {
      "files": [
        { "path": "~/.ssh", "mode": "deny" },
        { "path": "~/.aws", "mode": "deny" },
        { "path": "~/.gnupg", "mode": "deny" },
        { "path": "~/.claude/.credentials.json", "mode": "deny" },
        { "path": "~/.config/gcloud", "mode": "deny" },
        { "path": "~/.config/configstore", "mode": "deny" }
      ]
    },
    "network": {
      "allowedDomains": ["api.anthropic.com", "statsig.anthropic.com"],
      "deniedDomains": []
    }
  },
  "allowManagedHooksOnly": false,
  "allowManagedPermissionRulesOnly": true,
  "permissions": {
    "deny": [],
    "ask": [],
    "allow": [],
    "disableBypassPermissionsMode": "disable"
  }
}
```

**Instale e confira em dois passos** (o segundo não é opcional: um managed-settings malformado é
`Unable to read managed policy settings` em *todo* run desta máquina):

```bash
sudo install -o root -g root -m 0644 managed-settings.json /etc/claude-code/managed-settings.json
claude doctor        # a seção "Invalid settings" nomeia o arquivo se o JSON estiver quebrado
```

---

## 4. O que foi MEDIDO (e como)

### 4.1 O método — um `/etc/claude-code` falso, sem tocar o `/etc` real

Este host roda o serviço de produção como root; escrever um managed-settings mal formado em
`/etc/claude-code` derrubaria **todos** os runs. A medição usou um `/etc` descartável:

```bash
# /etc vira tmpfs; cada entrada REAL de /etc é re-bindada por cima; claude-code vem do dir falso.
# O mkdir do mountpoint acontece no tmpfs — o /etc do host nunca é escrito.
args=(--dev-bind / / --tmpfs /etc)
for e in /etc/*; do n=$(basename "$e"); [ "$n" = claude-code ] && continue
  args+=(--bind-try "$e" "/etc/$n"); done
bwrap "${args[@]}" --bind "$FAKE" /etc/claude-code -- <comando>
```

Antes e depois de cada rodada: `ls /etc/claude-code` ⇒ *No such file or directory*. O `/etc` do host
saiu intacto.

### 4.2 Prova de NÃO-VACUIDADE (o managed falso está mesmo sendo lido)

Sem esta prova o resto seria um lint que mede zero. Com um JSON deliberadamente quebrado no arquivo falso:

| comando | saída |
|---|---|
| `claude doctor` | `Invalid settings` → `/etc/claude-code/managed-settings.json: Invalid or malformed JSON` |
| `claude -p …` | `Unable to read managed policy settings. … Detail: /etc/claude-code/managed-settings.json: Invalid or malformed JSON` |

### 4.3 `allowManagedPermissionRulesOnly` × `--permission-mode acceptEdits`

Esta é a interação que o template precisava justificar antes de recomendar. Todos os runs em caminho
**confiado** (o checkout do serviço, herdando `hasTrustDialogAccepted`), `--model haiku`,
`--output-format stream-json` — o veredito veio do `tool_result`, não do relato do agente.

| # | managed settings | flags do spawn | resultado |
|---|---|---|---|
| **M1** | `allowManagedPermissionRulesOnly:true` | `--permission-mode acceptEdits --disallowedTools Bash` | `Write` **SUCEDEU** — o modo sobrevive à política |
| **M4b** | *(sem a chave)* | `--settings {allow:["Bash(touch:*)"]} --permission-mode default` | `touch` **OK** |
| **M4a** | `allowManagedPermissionRulesOnly:true` | *idem M4b, único delta é a chave* | `touch` **BLOQUEADO**; `Write` pediu aprovação ⇒ em headless, **falha** |
| **M6b** | *(sem a chave)* | *sem* `--permission-mode` (vale o `defaultMode` do usuário) | `touch` **OK** |
| **M6a** | `allowManagedPermissionRulesOnly:true` | *idem M6b* | `touch` **OK** — o `defaultMode` do usuário **sobrevive** |

**Veredito, e ele é preciso porque o par M4a/M4b difere em UMA variável:**

- a chave **NÃO** quebra `--permission-mode acceptEdits`. Modo ≠ regra: a citação diz *"permission rules
  (allow/deny/ask)"*, e o modo não é uma delas;
- a chave **MATA** as *regras* allow/deny/ask vindas de `--settings` / user / project / local — foi
  exatamente o `Bash(touch:*)` do `--settings` que sumiu entre M4b e M4a;
- a chave **não** mexe em `permissions.defaultMode` (M6a/M6b). ⚠ Registrado porque este host tem
  `~/.claude/settings.json` = `{"permissions":{"defaultMode":"bypassPermissions"}}` — e quem lesse só a
  citação suporia que a política o neutraliza. Não neutraliza; quem faz isso é
  `permissions.disableBypassPermissionsMode`.

### 4.4 A forma REAL do spawn do harness, sob a política

Replicando o que `buildSpawnFlags` emite (`--settings <sandbox.json> --permission-mode acceptEdits`), com
`allowManagedPermissionRulesOnly:true` ativo:

| # | asserção | resultado |
|---|---|---|
| **H1** | `Bash` (`touch` dentro do `cwd`) + `Write` nativo dentro do `allowWrite` | **ambos OK** — `autoAllowBashIfSandboxed` e `acceptEdits` continuam entregando |
| **H2** | `Bash` escrevendo FORA do `allowWrite` (`/root/…`) | `Read-only file system`, arquivo **não** existe — a contenção estava LIGADA durante H1 |

H2 existe para H1 não ser vácuo: um `Bash` que passa porque *não há sandbox* não prova nada.

### 4.5 ⭐ A Sonda W, reproduzida e depois FECHADA pelo managed

O par que justifica o documento inteiro. Mesmo `.claude/settings.json` hostil no diretório de trabalho
(`{"sandbox":{"filesystem":{"allowWrite":["/var/tmp"]}}}`), mesma forma de spawn do harness, variando
**só** o managed settings:

| # | managed settings | `echo hi > /var/tmp/…` |
|---|---|---|
| **W1** | *(nenhum — `/etc/claude-code` ausente)* | **ESCAPOU** — arquivo criado em `/var/tmp` (é a Sonda W do ADR-067, reproduzida) |
| **W2** | `{"sandbox":{"filesystem":{"denyWrite":["/var/tmp"]}}}` | **`Read-only file system`**, arquivo não existe |

**Consequência:** existe, sim, uma alavanca que impede a ampliação da cerca por um `settings.json` de
projeto — ela **não** é `--setting-sources` (essa foi medida e não impede nada; ADR-067 §Sonda W), é
`sandbox.filesystem.denyWrite` **na camada managed**. A recusa fail-closed do harness continua sendo a
defesa de quem não pode instalar o managed (§5), mas deixa de ser a única que existe.

---

## 5. O CUSTO honesto: isto exige root

`/etc/claude-code` é do sistema. Escrever ali exige **root** (ou o equivalente da plataforma: um
`/Library/Application Support/` no macOS, uma GPO/HKLM no Windows).

**Consequência direta, e ela elimina uma parte dos adotantes:** quem roda o AgileHarness como usuário
comum — sem `sudo`, num container gerenciado por terceiros, num PaaS, numa máquina corporativa cujo
`/etc` é imutável — **não consegue instalar este teto**. E não adianta improvisar: `bwrapPath`/`socatPath`
dizem *"Only honored from admin-controlled managed settings"*, e um managed-settings escrito num caminho
que o usuário controla seria, por definição, um teto que o alvo alcança — ou seja, nenhum teto.

**A degradação, dita sem eufemismo:** sem a camada managed, a defesa contra a Sonda W volta a ser
**exclusivamente** a que o harness já faz — `resolveAutonomyPosture` lê `.claude/settings.json` e
`.claude/settings.local.json` da árvore a **cada spawn**, e **RECUSA** o run nomeando o arquivo e a chave;
JSON ilegível conta como override. Isso não é garantia do kernel: é o sistema se recusando a operar
quando não pode cumprir o que anuncia. É estritamente mais fraco que o managed (um caminho de leitura que
o próprio processo executa, contra uma política que o processo não alcança), e é o que há.

Ordem de preferência, da mais forte para a mais fraca:

1. **managed settings** (§3) — o alvo não alcança. Exige root.
2. **unit systemd transiente** com `ProtectSystem=strict` + `ReadOnlyPaths=/root` + `ReadWritePaths=<worktree>`
   — imposto pelo **PID 1**, indiferente a qualquer `settings.json`. Medido no ADR-067 §Sonda W;
   **integração adiada para F1** (mexe na supervisão de processo). Exige root também.
3. **recusa fail-closed do harness** — sempre ligada, não exige nada, e é a única que sobra para o
   adotante sem root.

As três se somam. Nenhuma substitui a outra.

---

## 6. O que NÃO foi medido

Escrito porque um documento que só lista o que passou é propaganda.

- **`allowManagedDomainsOnly: true` × `AGILEHARNESS_SANDBOX_ALLOWED_DOMAINS`.** A citação diz que
  domínios de *"flag settings"* são ignorados, e o harness estende a allowlist por `--settings` — que é
  fonte de flag. A expectativa é que a extensão pare de funcionar **em silêncio**. **NÃO MEDIDO.** Por
  isso a chave está `false`/ausente no template.
- **`strictPluginOnlyCustomization` × entrega das skills por `--plugin-dir`.** A citação diz que
  customizações *providas por plugin* **não** são bloqueadas, o que sugere que as `harness-*` sobrevivem.
  Sugerir não é medir. **NÃO MEDIDO.**
- **`allowManagedMcpServersOnly` × o servidor MCP do próprio harness.** **NÃO MEDIDO.**
- **`allowManagedHooksOnly: true` × o hook `block-runtime-board-writes.js`.** A citação é explícita
  ("User, project, and local hooks are ignored"), então o hook do repositório morreria — mas o efeito
  prático no pipeline **não foi medido**. Template deixa `false`.
- **O managed settings sob o sandbox aninhado real do serviço** (systemd, PID 1, `--scope`). A medição
  rodou sob `bwrap` a partir de um shell, não sob a unit do serviço.
- **macOS e Windows.** Só os caminhos foram extraídos do binário; nada foi executado nessas plataformas.

---

## 7. Ponteiros

- [ADR-067](../../../docs/adr/ADR-067-sondas-f0-multitarget.md) — as sondas de F0, incluindo a Sonda W
  (a mescla), a Sonda D (a contenção) e a Sonda Q (o que a contenção torna impossível).
- [SECURITY.md](../SECURITY.md) — a postura declarada e o item 7 do checklist de exposição.
- [threat-model.md](./threat-model.md) — o inventário completo, com os riscos aceitos.
