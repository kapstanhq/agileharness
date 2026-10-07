// FASE 3 — O MOTOR CONTRA UM REPOSITÓRIO QUE NÃO É ESTE.
//
// Toda a suíte roda sobre um monorepo, e a extração valida um artefato com a MESMA forma
// (`packages/storymap-ui/`). Ou seja: nenhuma régua desta casa jamais foi exercida contra um
// repositório de layout diferente — e é exatamente isso que um adotante tem. Defeitos assim são achados
// LENDO, e ler não escala: uma porta fixa sobrevive ao lado de um guarda que a mede, e uma régua de
// extração cega arquivos do gate de segredo, sem nenhum teste que olhe de fora.
//
// Este arquivo é o instrumento que faltava. Ele constrói um repositório git DE VERDADE com layout
// PLANO — `src/` na raiz, nenhum `packages/` — que declara a própria forma no seu `storymap/
// settings.yaml` (`codePrefixes: [src/]`, branch de integração `integracao`, não `stage`), e cobra das
// réguas de ciclo de vida de branch que elas leiam o DECLARADO.
//
// POR QUE ISTO NÃO É HIPOTÉTICO: um repositório pode declarar MAIS DE UM prefixo de código (digamos
// `codePrefixes: ["packages/", "site/"]`) enquanto `branchWorkLandedBySplit` caía na constante
// `STAGING_CODE_PREFIXES = ["packages/"]`, porque nenhum dos chamadores passava o valor declarado. Um
// branch que tocasse só `site/` era particionado errado, e o veredito "o trabalho deste branch
// aterrissou?" é o que decide se um branch é preservado como `failed/*` ou deletado, e o que o fleet
// view chama de trabalho encalhado.
//
// A direção do erro é preservar DEMAIS (a metade mal classificada é procurada na ref errada, não é
// encontrada, e o veredito mais fraco sobrevive) — não é perda de trabalho. Mas um sinal de "encalhado"
// que mente é o sinal pelo qual o operador age.
import { execFileSync, exec as nodeExec } from "node:child_process";
import { existsSync, promises as fsp, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetRepoRootCache } from "@/lib/storymap/paths";
import { branchWorkLandedBySplit } from "./convergence";
import { cardCumulativeDiff, grepStagedCodeRangeDiff, type GitRunner } from "./diff";
import { defaultPreservedBranchesDeps, classifyPreservedBranch } from "./preserved-branches";
import { declaredCodePrefixes, stagingBranchOf } from "./staging";
import { loadRunnerConfig } from "./config";
import { isolatedGitExec } from "./git-test-env";
import { describePosix } from "./test-platform";
import type { ExecFn } from "./worktree";

let exec = promisify(nodeExec) as unknown as ExecFn;

/** A forma DECLARADA por este repositório de mentira — deliberadamente diferente da deste monorepo. */
const PREFIXO_DE_CODIGO = "src/";
const BRANCH_DE_CODIGO = "integracao"; // e NÃO "stage"
const BRANCH_DE_DADOS = "main";

const SESSAO_OK = "11111111-2222-3333-4444-555555555555";
const SESSAO_PENDENTE = "66666666-7777-8888-9999-000000000000";

describePosix("repositório de layout PLANO — o motor lê a forma DECLARADA (fase 3)", () => {
  let tmpRoot: string;
  let repo: string;
  let alvoAnterior: string | undefined;

  const escreve = (rel: string, txt: string) => fsp.writeFile(path.join(repo, rel), txt, "utf8");
  const git = async (cmd: string) => (await exec(`git ${cmd}`, { cwd: repo })).stdout.trim();

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ah-plano-"));
    exec = isolatedGitExec(exec, tmpRoot);
    repo = path.join(tmpRoot, "produto-de-alguem");
    await fsp.mkdir(path.join(repo, "src"), { recursive: true });
    await fsp.mkdir(path.join(repo, "storymap", "boards", "demo", "cards"), { recursive: true });

    // A DECLARAÇÃO — é ela que o motor tem de obedecer. `storymap/boards` também é um ROOT_MARKER, então
    // este diretório se resolve como raiz sem depender de `turbo.json` (que não existe aqui, de propósito:
    // um adotante não tem turborepo).
    await escreve(
      "storymap/settings.yaml",
      ["autorun:", "  staging:", "    enabled: true", `    branch: ${BRANCH_DE_CODIGO}`, "    codePrefixes:", `      - ${PREFIXO_DE_CODIGO}`, ""].join("\n"),
    );
    await escreve("src/a.ts", "export const a = 1;\n");
    await escreve("storymap/boards/demo/cards/c.md", "# card\nstatus: triage\n");

    await git("init -q");
    await git("config user.email t@example.test");
    await git("config user.name tester");
    await git("add -A");
    await git("commit -q --no-verify -m base");
    await git(`branch -M ${BRANCH_DE_DADOS}`);
    const base = await git("rev-parse HEAD");
    await git(`branch ${BRANCH_DE_CODIGO}`);

    // O branch da sessão: toca as DUAS metades (código em src/, dado de board em storymap/boards/).
    const branchOk = `agent/${SESSAO_OK}`;
    await git(`checkout -q -b ${branchOk}`);
    await escreve("src/a.ts", "export const a = 2; // trabalho da sessão\n");
    await escreve("storymap/boards/demo/cards/c.md", "# card\nstatus: desenvolver\n");
    await git("add -A");
    await git('commit -q --no-verify -m "trabalho"');
    // Base EXATA: `resolveRunBase` só autoriza com reflog OU base-ref, e é o base-ref que a ferramenta
    // escreve para um branch de sessão (o rebase do worktree_refresh invalida o reflog).
    await git(`update-ref refs/agent-base/${SESSAO_OK} ${base}`);

    // O train aterrissou cada metade na SUA ref: código em `integracao`, dado em `main`.
    await git(`checkout -q ${BRANCH_DE_CODIGO}`);
    await escreve("src/a.ts", "export const a = 2; // trabalho da sessão\n");
    await git("add -A");
    await git('commit -q --no-verify -m "integra código"');
    // O commit do split no formato que a ferramenta grava (`usm(<card>): código staged`) — o diff acumulado do card o procura
    // no branch de integração DECLARADO.
    await escreve("src/c.ts", "export const c = 3;\n");
    await git("add -A");
    await git('commit -q --no-verify -m "usm(story-ex9967): código staged (run r1)"');
    await git(`checkout -q ${BRANCH_DE_DADOS}`);
    await escreve("storymap/boards/demo/cards/c.md", "# card\nstatus: desenvolver\n");
    await git("add -A");
    await git('commit -q --no-verify -m "board: sessão"');

    // A CONTRAPROVA: uma sessão cujo código NINGUÉM integrou.
    const branchPendente = `agent/${SESSAO_PENDENTE}`;
    const base2 = await git("rev-parse HEAD");
    await git(`checkout -q -b ${branchPendente}`);
    await escreve("src/b.ts", "export const b = 1; // nunca integrado\n");
    await git("add -A");
    await git('commit -q --no-verify -m "trabalho pendente"');
    await git(`update-ref refs/agent-base/${SESSAO_PENDENTE} ${base2}`);
    await git(`checkout -q ${BRANCH_DE_DADOS}`);

    alvoAnterior = process.env.AGILEHARNESS_TARGET;
    process.env.AGILEHARNESS_TARGET = repo;
    resetRepoRootCache();
  });

  afterAll(async () => {
    if (alvoAnterior === undefined) delete process.env.AGILEHARNESS_TARGET;
    else process.env.AGILEHARNESS_TARGET = alvoAnterior;
    resetRepoRootCache();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("[CLASSE] o veredito de ciclo de vida lê os codePrefixes e o branch DECLARADOS, não a constante deste monorepo", async () => {
    // Sem `opts`: é exatamente como os três chamadores de produção invocam (instrumentation.ts,
    // engine.ts, worktree.ts). Se a régua cair na constante `["packages/"]` + `"stage"`, ela põe
    // `src/a.ts` na metade de DADOS, procura em `main` (onde só o card entrou) e responde que o
    // trabalho não aterrissou — sobre um branch que aterrissou inteiro.
    const v = await branchWorkLandedBySplit(exec, repo, `agent/${SESSAO_OK}`);
    expect(
      v.code,
      `a metade de CÓDIGO (${PREFIXO_DE_CODIGO}) aterrissou em ${BRANCH_DE_CODIGO} e o veredito não viu: ${v.detail ?? ""}`,
    ).toBe("landed");
    expect(
      v.data,
      `a metade de DADOS aterrissou em ${BRANCH_DE_DADOS} e o veredito não viu: ${v.detail ?? ""}`,
    ).toBe("landed");
  });

  it("CONTRAPROVA: código que ninguém integrou NÃO sai como `landed` (senão o caso acima passa por dizer sim a tudo)", async () => {
    const v = await branchWorkLandedBySplit(exec, repo, `agent/${SESSAO_PENDENTE}`);
    expect(v.code, "um branch com código não-integrado foi dado como aterrissado — a régua diz sim a tudo").not.toBe(
      "landed",
    );
  });

  // ── Lote D: diff do card e régua de branches preservados leem o DECLARADO (mesmo repositório, mesmo alvo) ──
  const runGitEm = (repoDir: string): GitRunner => async (args) => (await exec(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, { cwd: repoDir })).stdout;
  const alvo = () => process.env.AGILEHARNESS_TARGET as string;

  it("o settings do repo de mentira chega às réguas: branch `integracao` e codePrefixes `[src/]` (não stage / packages/)", () => {
    const staging = loadRunnerConfig().autorun.staging;
    expect(stagingBranchOf(staging)).toBe(BRANCH_DE_CODIGO);
    expect(declaredCodePrefixes(staging)).toEqual([PREFIXO_DE_CODIGO]);
    const deps = defaultPreservedBranchesDeps();
    expect(deps.stageBranch).toBe(BRANCH_DE_CODIGO);
    expect(deps.codePrefixes).toEqual([PREFIXO_DE_CODIGO]);
  });

  it("cardCumulativeDiff: com o escopo declarado acha o código staged em `integracao`; sem escopo procura `stage` e não acha", async () => {
    const staging = loadRunnerConfig().autorun.staging;
    const scope = { stageBranch: stagingBranchOf(staging), codePrefixes: declaredCodePrefixes(staging) };
    const comEscopo = await cardCumulativeDiff(runGitEm(alvo()), "demo", "story-ex9967", scope);
    expect(comEscopo.code, "o diff de código do card não foi achado no branch declarado").not.toBeNull();
    expect(comEscopo.code?.diff).toContain("src/c.ts");
    // a CONTRAPROVA: o escopo ausente cai no default da ferramenta (`stage`), que este repo não tem
    const semEscopo = await grepStagedCodeRangeDiff(runGitEm(alvo()), "story-ex9967");
    expect(semEscopo.ok).toBe(false);
  });

  it("branch preservado que toca só `src/`: é CÓDIGO não integrado (touchesCode) — e NÃO um branch «sem código» descartável", async () => {
    const deps = { ...defaultPreservedBranchesDeps(), liveRunIds: async () => [], liveSessionIds: async () => ({ ok: true as const, ids: [] }) };
    const b = await classifyPreservedBranch(deps as never, `agent/${SESSAO_PENDENTE}`, new Set());
    expect(b, "o branch pendente devia ser classificado").not.toBeNull();
    expect(b!.touchesCode).toBe(true);
    expect(b!.verdict).toBe("unintegrated-code");
  });
});

describe("[CLASSE] a forma do repositório é DECLARADA, nunca fixada na fonte", () => {
  // O caso acima mede o COMPORTAMENTO com um repositório de outra forma; este mede a FONTE, e os dois
  // precisam existir. Motivo concreto: consertar o default de `branchWorkLandedBySplit` não bastava —
  // `engine.ts` e `instrumentation.ts` passavam `stageBranch: "stage"` explicitamente, o que SOBRESCREVE
  // o default e derrotava a correção em produção, enquanto o teste de comportamento (que chama sem opts)
  // ficava verde. Um guarda de fonte é o que fecha essa fresta.
  // O censo é a ÁRVORE DE TRABALHO, não só o índice: um arquivo apagado e ainda não commitado sai (lê-lo daria
  // ENOENT), e um arquivo novo ainda não adicionado entra (senão escaparia do guarda até o commit).
  const pastaDoPacote = new URL("../../../../", import.meta.url).pathname;
  const fontes = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], {
    cwd: pastaDoPacote,
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && existsSync(`${pastaDoPacote}${p}`));

  const semComentario = (t: string) =>
    t
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  it("nenhuma fonte fixa o branch de integração — ele vem de `autorun.staging.branch`", () => {
    const raiz = new URL("../../../../", import.meta.url).pathname;
    // Anti-vácuo: um censo vazio faria a proibição passar por não ter lido nada.
    expect(fontes.length, "o censo de fontes veio vazio — o instrumento quebrou, não o mundo").toBeGreaterThan(100);
    const infratores = fontes.filter((p) =>
      /stageBranch:\s*"stage"/.test(semComentario(readFileSync(`${raiz}${p}`, "utf8"))),
    );
    expect(
      infratores,
      "branch de integração fixado na fonte: sobrescreve a declaração do repositório que adota a ferramenta",
    ).toEqual([]);
  });

  // Lote D (layout): o ferramental do repositório de ORIGEM não pode voltar como default escondido. `stage` é o ÚNICO
  // default de branch que a ferramenta mantém (convenção documentada, `STAGING_BRANCH_DEFAULT` em staging.ts); pasta
  // de código NÃO tem default — é declarada, e indeclarada vira «tudo fora de storymap/boards/».
  it("nenhuma régua de layout fixa `packages/` nem o branch `stage` na fonte — vêm do alvo, ou do default único e documentado", () => {
    const raiz = new URL("../../../../", import.meta.url).pathname;
    const dasReguas = [
      "src/lib/storymap/runner/worktree.ts",
      "src/lib/storymap/runner/diff.ts",
      "src/lib/storymap/runner/preserved-branches.ts",
      "src/lib/storymap/runner/merge-queue.ts",
      "src/lib/storymap/runner/release.ts",
      "src/lib/storymap/runner/staging.ts",
      "src/lib/storymap/runner/convergence.ts",
      "src/lib/storymap/runner/delivery-deps.ts",
      "src/instrumentation.ts",
    ];
    const infratores: string[] = [];
    for (const rel of dasReguas) {
      expect(fontes, `${rel} sumiu do censo — o instrumento quebrou`).toContain(rel);
      const texto = semComentario(readFileSync(`${raiz}${rel}`, "utf8"));
      if (/STAGING_CODE_PREFIXES/.test(texto)) infratores.push(`${rel}: STAGING_CODE_PREFIXES`);
      if (/["'`]packages\/["'`]/.test(texto)) infratores.push(`${rel}: literal "packages/"`);
      if (/\?\?\s*["']stage["']/.test(texto)) infratores.push(`${rel}: ?? "stage"`);
      if (rel !== "src/lib/storymap/runner/staging.ts" && /["']stage["']/.test(texto)) infratores.push(`${rel}: literal "stage"`);
    }
    expect(infratores).toEqual([]);
  });

  it("e o idioma DECLARADO está de fato em uso (senão a proibição acima bane uma string que ninguém usa)", () => {
    const raiz = new URL("../../../../", import.meta.url).pathname;
    const comLeitura = fontes.filter((p) =>
      /staging\?\.branch|stagingBranchOf\(/.test(readFileSync(`${raiz}${p}`, "utf8")),
    );
    expect(comLeitura.length, "ninguém lê `autorun.staging.branch` — a proibição seria decorativa").toBeGreaterThan(4);
  });
});
