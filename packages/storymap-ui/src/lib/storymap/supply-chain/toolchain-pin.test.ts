// ATAQUE (sem atacante): o CI fica VERMELHO POR DATA, e o time aprende a ignorar o vermelho.
//
// Os dois workflows do repo OSS pediam `oven-sh/setup-bun` com `bun-version: latest`. Não é uma porta de
// execução como a interpolação de contexto hostil — é pior de um jeito silencioso: o resolvedor e o formato
// do `bun.lock` mudam entre versões de bun, e o `bun install --frozen-lockfile` do passo seguinte passa a
// reprovar sem NENHUM commit ter acontecido. Um CI que quebra sozinho é um CI que alguém desliga; e quando
// ele é desligado, as quatro regras que `lint-workflows.mjs` já cobria (interpolação, action não pinada,
// `permissions:`, `pull_request_target`) param de proteger junto.
//
// A âncora escolhida é o `packageManager` do `package.json` da RAIZ — o mesmo campo que o Corepack e o
// Dependabot leem, e o mesmo que a extração propaga para o artefato. NÃO `engines.bun`, que aqui é
// `>=1.0.0`: uma faixa não pina nada.
//
// Este arquivo é o PRODUTOR da regra 5 do linter. Sem ele, "os workflows estão pinados" seria capacidade
// declarada com zero produtores — o defeito nº 1 desta casa. Cada caso abaixo introduz UM defeito sobre um
// workflow correto e exige o vermelho; os dois últimos amarram a régua ao ARTEFATO REAL.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const LINTER = path.join(REPO_ROOT, "scripts/security/lint-workflows.mjs");
const WORKFLOWS = path.join(REPO_ROOT, ".github/workflows");
const DEPENDABOT = path.join(REPO_ROOT, ".github/dependabot.yml");

const SHA = "a1b2c3d4e5f6071829304a5b6c7d8e9f00112233";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/**
 * Uma bancada com o `package.json` da raiz (a ÂNCORA) e um workflow. O linter recebe `--dir` e `--root`
 * separados de propósito: é isso que permite exercitar a divergência sem tocar no repositório de verdade.
 */
function bancada(packageJson: unknown, workflow: string): { dir: string; wf: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-pin-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson), "utf8");
  const wf = path.join(dir, "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(path.join(wf, "teste.yml"), workflow, "utf8");
  return { dir, wf };
}

function lint(dirWorkflows: string, root: string) {
  try {
    const out = execFileSync(process.execPath, [LINTER, "--dir", dirWorkflows, "--root", root, "--json"], {
      encoding: "utf8",
    });
    return { code: 0, v: JSON.parse(out) as { findings: { rule: string; detail: string }[] } };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return {
      code: err.status ?? -1,
      v: err.stdout ? (JSON.parse(err.stdout) as { findings: { rule: string; detail: string }[] }) : null,
    };
  }
}

/** Workflow correto em tudo MENOS no bloco `with:` do setup-bun, que cada caso escreve. */
function comSetupBun(bloco: string) {
  return `name: ok
on: { push: {} }
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - uses: oven-sh/setup-bun@${SHA}
${bloco}      - run: bun install --frozen-lockfile
`;
}

const ANCORA = { packageManager: "bun@1.3.14" };
const regras = (r: { v: { findings: { rule: string }[] } | null }) => (r.v?.findings ?? []).map((f) => f.rule);

describe("toolchain do CI pinada na MESMA versão que o repositório declara", () => {
  it("CONTRAPROVA: `bun-version` exatamente igual ao `packageManager` PASSA", () => {
    // Obrigatória e primeira: se o jeito certo também reprovasse, não haveria como escrever o workflow
    // legítimo — e a saída do time seria remover o linter, que é o pior desfecho possível.
    const { dir, wf } = bancada(ANCORA, comSetupBun("        with:\n          bun-version: 1.3.14\n"));
    expect(lint(wf, dir).code).toBe(0);
  });

  it("ATAQUE 5a: `bun-version: latest` é REPROVADO — é a referência móvel que quebra o CI por data", () => {
    const { dir, wf } = bancada(ANCORA, comSetupBun("        with:\n          bun-version: latest\n"));
    const r = lint(wf, dir);
    expect(r.code, "`latest` tem de REPROVAR").toBe(2);
    expect(regras(r)).toContain("unpinned-toolchain");
  });

  it("ATAQUE 5b: `setup-bun` SEM `bun-version` é REPROVADO — o default da action É `latest`", () => {
    // O caso mais fácil de escrever por descuido, e o mais difícil de ver num diff: não há nada errado
    // escrito, há uma linha que falta. Sem esta régua, apagar o pin seria uma forma de aprovar.
    const { dir, wf } = bancada(ANCORA, comSetupBun(""));
    const r = lint(wf, dir);
    expect(r.code).toBe(2);
    expect(regras(r)).toContain("unpinned-toolchain");
  });

  it("ATAQUE 5c: `bun-version: 1.3` é REPROVADO — faixa não é pino (e o YAML ainda o lê como NÚMERO)", () => {
    // Dois defeitos num: `1.3` cobre 1.3.0 até 1.3.999, e o js-yaml o entrega como `1.3` numérico. Um
    // verificador que comparasse strings sem normalizar aprovaria por não ter comparado nada.
    const { dir, wf } = bancada(ANCORA, comSetupBun("        with:\n          bun-version: 1.3\n"));
    const r = lint(wf, dir);
    expect(r.code).toBe(2);
    expect(regras(r)).toContain("unpinned-toolchain");
  });

  it("ATAQUE 5d: versão exata mas DIFERENTE da âncora é REPROVADA — pinar no valor errado não é pinar", () => {
    // A régua não é "é imóvel?", é "é a MESMA?". `1.2.0` é imóvel e ainda assim instala um resolvedor que
    // não escreveu este `bun.lock` — exatamente o que o `--frozen-lockfile` do passo seguinte vai acusar.
    const { dir, wf } = bancada(ANCORA, comSetupBun("        with:\n          bun-version: 1.2.0\n"));
    const r = lint(wf, dir);
    expect(r.code).toBe(2);
    expect(regras(r)).toContain("toolchain-mismatch");
    expect(r.v?.findings[0].detail).toContain("bun@1.3.14");
  });

  it("ATAQUE 5e: raiz SEM `packageManager` é REPROVA (fail-closed) — sem âncora não há como comparar", () => {
    // "Não consegui comparar" nunca pode sair como "confere". É a mesma postura de `unparseable` e
    // `no-workflows`: o gate não passa por não ter tido o que medir.
    const { dir, wf } = bancada({ name: "x" }, comSetupBun("        with:\n          bun-version: 1.3.14\n"));
    const r = lint(wf, dir);
    expect(r.code).toBe(2);
    expect(regras(r)).toContain("toolchain-mismatch");
  });

  it("ATAQUE 5f: `packageManager` de OUTRO gerenciador é REPROVA — a âncora tem de ser de bun", () => {
    const { dir, wf } = bancada(
      { packageManager: "npm@10.9.0" },
      comSetupBun("        with:\n          bun-version: 1.3.14\n"),
    );
    const r = lint(wf, dir);
    expect(r.code).toBe(2);
    expect(regras(r)).toContain("toolchain-mismatch");
  });

  it("CONTRAPROVA: `bun-version-file: package.json` PASSA — é a mesma âncora, lida pela action", () => {
    // Recusar o pino ESTRITAMENTE MELHOR seria uma régua que pune quem acertou. A action lê o
    // `packageManager` do próprio arquivo, então não há como divergir.
    const { dir, wf } = bancada(ANCORA, comSetupBun("        with:\n          bun-version-file: package.json\n"));
    expect(lint(wf, dir).code).toBe(0);
  });

  it("ATAQUE 5g: `bun-version-file: .bun-version` é REPROVADO — seria uma SEGUNDA fonte da verdade", () => {
    // Um arquivo à parte pode divergir do `packageManager` sem que nada acuse, e aí voltamos ao problema
    // original por outra porta: o CI instalando um bun que não é o do repositório.
    const { dir, wf } = bancada(ANCORA, comSetupBun("        with:\n          bun-version-file: .bun-version\n"));
    const r = lint(wf, dir);
    expect(r.code).toBe(2);
    expect(regras(r)).toContain("toolchain-mismatch");
  });

  it("workflow SEM setup-bun não é afetado pela regra 5 (a régua não inventa achado)", () => {
    const { dir, wf } = bancada(ANCORA, `name: ok
on: { push: {} }
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo oi
`);
    expect(lint(wf, dir).code).toBe(0);
  });
});

describe("PRODUTOR: o artefato REAL está pinado, e a pinagem aponta para a âncora REAL", () => {
  it("todo passo `setup-bun` dos workflows publicados usa a versão do `packageManager` da raiz", () => {
    // Não delega ao linter: lê os dois lados e compara aqui. Se o linter regredir (uma condição invertida,
    // um `return` cedo), este caso continua vermelho — duas réguas independentes sobre o mesmo fato.
    const raiz = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    const esperada = /^bun@(\d+\.\d+\.\d+)$/.exec(raiz.packageManager ?? "")?.[1];
    expect(esperada, "o package.json da raiz precisa declarar `packageManager: bun@<x.y.z>`").toBeTruthy();

    const arquivos = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    const passos: { arquivo: string; versao: unknown }[] = [];
    for (const arquivo of arquivos) {
      const doc = yaml.load(readFileSync(path.join(WORKFLOWS, arquivo), "utf8")) as {
        jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>;
      };
      for (const job of Object.values(doc?.jobs ?? {})) {
        for (const passo of job?.steps ?? []) {
          if (typeof passo?.uses === "string" && passo.uses.startsWith("oven-sh/setup-bun@")) {
            passos.push({ arquivo, versao: passo?.with?.["bun-version"] });
          }
        }
      }
    }
    // NÃO-VACUIDADE: um laço que não itera termina sem falha nenhuma e sai como aprovado. Os dois
    // workflows publicados instalam bun; se um dia só um instalar, é decisão para revisar, não para
    // este teste engolir em silêncio.
    expect(passos.length, "nenhum passo `setup-bun` encontrado — a varredura não mediu nada").toBe(2);
    for (const p of passos) {
      expect(String(p.versao), `${p.arquivo}: bun-version fora da âncora`).toBe(esperada);
    }
  });

  it("os workflows publicados passam o linter contra a raiz REAL deste repositório", () => {
    const r = lint(WORKFLOWS, REPO_ROOT);
    expect(r.code, `o artefato reprovou: ${JSON.stringify(r.v?.findings)}`).toBe(0);
  });

  it("o Dependabot declara o ecossistema `bun` — e NÃO `npm`, que não sabe reescrever `bun.lock`", () => {
    // A árvore publicada tem `bun.lock` e nenhum `package-lock.json`. Com `npm`, o robô bumpava o
    // manifesto e deixava o lock para trás; o `bun install --frozen-lockfile` do ci.yml reprova por
    // DEFINIÇÃO quando os dois discordam, e um robô que abre PR sempre vermelho é um robô desligado.
    const doc = yaml.load(readFileSync(DEPENDABOT, "utf8")) as {
      updates?: {
        "package-ecosystem"?: string;
        directories?: string[];
        directory?: string;
        "open-pull-requests-limit"?: number;
      }[];
    };
    const ecos = (doc?.updates ?? []).map((u) => u["package-ecosystem"]);
    expect(ecos.length, "dependabot.yml sem nenhum bloco `updates` — nada foi medido").toBeGreaterThan(0);
    expect(ecos).toContain("bun");
    expect(ecos, "`npm` não lê `bun.lock` — o PR nasceria com o lock defasado").not.toContain("npm");
    expect(ecos, "sem isto, a pinagem de action por SHA vira abandono").toContain("github-actions");

    // O membro do workspace precisa estar declarado: o suporte a workspace do ecossistema `bun` tem
    // defeito ABERTO (dependabot-core#14223) e sem ele o robô roda toda semana sem tocar em nada.
    const bun = (doc?.updates ?? []).find((u) => u["package-ecosystem"] === "bun");
    expect(bun?.directories ?? [], "declare a raiz E o pacote do workspace").toContain("/packages/storymap-ui");

    // DECLARADO NÃO BASTA: ele tem de ABRIR PR. MEDIDO em 2026-08-27 — um `open-pull-requests-limit: 0`
    // destinado ao ecossistema `bun` (onde o lockfile é regenerado na extração e o PR não muda nada)
    // foi aplicado por engano NESTE bloco. O `toContain("github-actions")` acima continuou verde: o
    // bloco existia, e estava mudo. Durante um dia o robô que reescreve SHA pinado não abriu um PR
    // sequer — que é EXATAMENTE o abandono que a asserção anterior diz estar prevenindo.
    //
    // Ausente é legítimo (o default do GitHub é 5); só o 0 explícito silencia.
    const ga = (doc?.updates ?? []).find((u) => u["package-ecosystem"] === "github-actions");
    expect(
      ga?.["open-pull-requests-limit"] ?? 5,
      "`github-actions` com teto 0 é a pinagem por SHA virando abandono — declarado e mudo é o mesmo " +
        "que ausente, e o guarda acima não distingue os dois",
    ).toBeGreaterThan(0);
  });
});

/**
 * As outras cercas de cadeia de suprimentos do artefato — as que dependem de UMA linha e somem sem barulho.
 *
 * Cada uma foi conferida no censo desta rodada e cada uma ganhou aqui o seu produtor: sem isso, "o CI está
 * endurecido" seria capacidade declarada, e o próximo diff que apagar a linha passaria verde.
 */
describe("PRODUTOR: cercas do CI que se perdem numa linha", () => {
  function docs() {
    return readdirSync(WORKFLOWS)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((arquivo) => ({
        arquivo,
        doc: yaml.load(readFileSync(path.join(WORKFLOWS, arquivo), "utf8")) as {
          on?: Record<string, unknown>;
          concurrency?: { group?: string };
          jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>;
        },
      }));
  }

  it("todo `actions/checkout` declara `persist-credentials: false`", () => {
    // O default do checkout GRAVA o `GITHUB_TOKEN` no `.git/config` do runner, onde qualquer passo
    // posterior o lê. Nenhum passo destes workflows fala com o remoto depois do clone, então manter a
    // credencial em disco é risco sem contrapartida.
    const checkouts: { arquivo: string; persist: unknown }[] = [];
    for (const { arquivo, doc } of docs()) {
      for (const job of Object.values(doc?.jobs ?? {})) {
        for (const passo of job?.steps ?? []) {
          if (typeof passo?.uses === "string" && passo.uses.startsWith("actions/checkout@")) {
            checkouts.push({ arquivo, persist: passo?.with?.["persist-credentials"] });
          }
        }
      }
    }
    expect(checkouts.length, "nenhum checkout encontrado — a varredura não mediu nada").toBe(2);
    for (const c of checkouts) {
      expect(c.persist, `${c.arquivo}: checkout sem \`persist-credentials: false\``).toBe(false);
    }
  });

  it("nenhum workflow usa `pull_request_target` — o gatilho que dá secrets a código de estranho", () => {
    const gatilhos = docs().flatMap(({ doc }) => Object.keys(doc?.on ?? {}));
    expect(gatilhos.length, "nenhum gatilho lido — a varredura não mediu nada").toBeGreaterThan(0);
    expect(gatilhos).not.toContain("pull_request_target");
  });

  it("o `concurrency` do security separa o `schedule` do `push` — senão o semanal morre por commit", () => {
    // O grupo era só `security-${{ github.ref }}`: um push em `main` na segunda de manhã cancelava a
    // varredura agendada, que é a ÚNICA que encontra advisory novo sem ninguém tocar no código.
    const security = docs().find((d) => d.arquivo === "security.yml");
    expect(security, "security.yml sumiu do artefato").toBeTruthy();
    expect(security?.doc?.concurrency?.group ?? "").toContain("github.event_name");
  });

  it("a árvore publicada não declara `trustedDependencies` — install de PR de fork não roda script", () => {
    // O bun só executa `postinstall` de pacote listado em `trustedDependencies`. Com a lista ausente, o
    // `bun install --frozen-lockfile` do CI não executa código de dependência nenhuma — inclusive num PR
    // de fork. Se um dia um módulo nativo exigir a entrada, este caso fica vermelho, e é o momento certo
    // de decidir CONSCIENTEMENTE (e provavelmente de passar `--ignore-scripts` no workflow de PR).
    for (const rel of ["package.json", "packages/storymap-ui/package.json"]) {
      const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")) as Record<string, unknown>;
      expect(pkg.trustedDependencies, `${rel} passou a executar script de instalação`).toBeUndefined();
    }
  });
});
