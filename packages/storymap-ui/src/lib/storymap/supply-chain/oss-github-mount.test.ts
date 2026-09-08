// O PRODUTOR da montagem do `.github/` — e a razão de este arquivo existir é uma medição, não um receio.
//
// O repositório extraído nascia com `git ls-tree -r --name-only HEAD | grep -c '^\.github/'` = **0**. O
// `oss/ci/` viajava inteiro, e viajar não liga nada: o GitHub só executa o que está em `.github/workflows/`.
// Resultado: o primeiro PR de um estranho entrava sem gate de licença, sem lint dos próprios workflows, sem
// typecheck, sem suíte e sem scan de segredo — enquanto o README que viaja junto descreve cada portão em
// detalhe. Pior que não ter portão, porque o adotante confia na prosa.
//
// POR QUE UM TESTE QUE EXECUTA O EXTRATOR, e não um que lê o texto dele. "Os workflows existem em `oss/ci/`"
// já era verdade quando o artefato não tinha CI nenhum — uma asserção assim teria passado durante todo o
// período do defeito. A pergunta que discrimina é sobre o ARTEFATO, e a forma barata de fazê-la é rodar o
// extrator no modo que não instala nada (`--no-verify --no-commit`, MEDIDO em ~1s) e olhar o que ele montou.
//
// A outra metade dos casos é TEXTUAL de propósito, e o limite está declarado: as etapas 6c (o golden gerado
// no destino) e 6d (a suíte sob CI=true) só existem depois de um `bun install` de minutos, que nenhuma suíte
// de merge gate pode pagar. Elas se cobram sozinhas EM EXECUÇÃO — cada uma aborta a extração quando falha, e
// abortar a extração é o portão que de fato impede a publicação. O que estes casos guardam é a REMOÇÃO
// silenciosa desses passos, que é a forma como uma proteção morre nesta casa.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { arvore } from "../oss-tree";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const EXTRATOR = path.join(REPO_ROOT, "oss/extract.sh");
const WORKFLOWS_FONTE = path.join(REPO_ROOT, "oss/ci/workflows");

const NO_UMBRELLA = arvore() === "umbrella";
if (!NO_UMBRELLA) {
  // GRITA, como `oss-tree.ts` faz com todo guarda umbrella-only: quem roda a suíte no artefato tem de saber
  // o que deixou de ser medido — silêncio aqui é o mesmo que portão verde por vacuidade.
  console.warn(
    "⚠ [oss-github-mount] repo EXTRAÍDO: `oss/extract.sh` não viaja (é maquinário do lado de cá), então o " +
      "produtor da montagem não pode ser executado aqui. A propriedade continua cobrada pelo RESULTADO, em " +
      "supply-chain/oss-ci-workflows.test.ts: `.github/workflows` existe, com os mesmos arquivos de " +
      "`oss/ci/workflows` e byte a byte iguais a eles.",
  );
}

const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

/** Uma extração REAL, no modo que não instala nem commita. ~1s medido. */
function extrair(): string {
  const destino = mkdtempSync(path.join(tmpdir(), "ah-montagem-"));
  temporarios.push(destino);
  execFileSync("bash", [EXTRATOR, "--to", destino, "--no-verify", "--no-commit"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  return destino;
}

describe.skipIf(!NO_UMBRELLA)("a extração MONTA o .github/ do artefato (produtor executado)", () => {
  const destino = NO_UMBRELLA ? extrair() : "";

  it("os workflows chegam a .github/workflows — os MESMOS de oss/ci/workflows, byte a byte", () => {
    const fonte = readdirSync(WORKFLOWS_FONTE)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
    // Anti-vácuo: sem workflow na fonte, comparar [] com [] seria verde sem medir nada.
    expect(fonte.length, "oss/ci/workflows sem workflow — não há o que montar").toBeGreaterThan(0);

    const dirMontado = path.join(destino, ".github/workflows");
    expect(existsSync(dirMontado), "a extração não criou .github/workflows no destino").toBe(true);
    expect(readdirSync(dirMontado).sort()).toEqual(fonte);
    for (const f of fonte) {
      expect(
        readFileSync(path.join(dirMontado, f), "utf8"),
        `.github/workflows/${f} não é cópia literal de oss/ci/workflows/${f}`,
      ).toBe(readFileSync(path.join(WORKFLOWS_FONTE, f), "utf8"));
    }
  });

  it("CODEOWNERS e dependabot também são montados no endereço em que o GitHub olha", () => {
    // Os dois governam a ENTRADA no branch (quem revisa, quem bumpa a action pinada). Em `oss/ci/` eles são
    // texto; em `.github/` eles são regra.
    for (const [fonte, montado] of [
      ["oss/ci/CODEOWNERS", ".github/CODEOWNERS"],
      ["oss/ci/dependabot.yml", ".github/dependabot.yml"],
    ]) {
      expect(existsSync(path.join(destino, montado)), `${montado} não foi montado`).toBe(true);
      expect(readFileSync(path.join(destino, montado), "utf8"), `${montado} ≠ ${fonte}`).toBe(
        readFileSync(path.join(destino, fonte), "utf8"),
      );
    }
  });

  it("os documentos da raiz de oss/ chegam à RAIZ do artefato, por CLASSE e não por lista", () => {
    // A regra é "todo `.md` na raiz de `oss/` que a régua deixou viajar é documento da raiz do artefato".
    // O piso nominal são os dois que o critério de aceitação exige; o que vier além (SECURITY.md,
    // CONTRIBUTING.md) sobe pela mesma classe, sem editar o extrator de novo.
    for (const base of ["AGENTS.md", "README.md"]) {
      expect(statSync(path.join(destino, base)).size, `${base} não chegou à raiz do artefato`).toBeGreaterThan(0);
    }
    const sobrouEmOss = existsSync(path.join(destino, "oss"))
      ? readdirSync(path.join(destino, "oss")).filter((f) => f.endsWith(".md"))
      : [];
    expect(sobrouEmOss, "documento parado em oss/ dentro do artefato — ninguém o acha lá").toEqual([]);
  });

  it("nenhum golden viaja: o artefato não recebe .snap desta árvore", () => {
    // A classe está no piso NEGATIVO do extrator porque um golden é a fotografia da árvore que o gerou — e a
    // que gera os desta casa é a do dono. MEDIDO: o `.snap` do pipeline viajava com 133K e SEIS retratos,
    // quatro deles dos boards privados. Os do artefato são tirados NO DESTINO (etapa 6c).
    const encontrados: string[] = [];
    const varrer = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p);
        else if (e.name.endsWith(".snap")) encontrados.push(path.relative(destino, p));
      }
    };
    varrer(destino);
    expect(encontrados, "golden herdado do umbrella dentro do artefato").toEqual([]);
  });

  it("o package.json publicado carrega os overrides MEDIDOS no fecho do destino", () => {
    // Eles não existem no umbrella de propósito: lá mudariam o fecho do serviço vivo. O artefato tem
    // distribuição própria (o lockfile dele é GERADO no destino), e é aqui que a resolução dele se decide.
    const raiz = JSON.parse(readFileSync(path.join(destino, "package.json"), "utf8")) as {
      overrides?: Record<string, string>;
    };
    expect(raiz.overrides?.postcss, "override do postcss ausente — o Next pina 8.4.31 exato").toBe("8.5.26");
    expect(raiz.overrides?.glob).toBe("10.5.0");
  });
});

describe.skipIf(!NO_UMBRELLA)("as verificações que o extrator faz NO DESTINO continuam ligadas", () => {
  const fonte = NO_UMBRELLA ? readFileSync(EXTRATOR, "utf8") : "";

  it("o golden do artefato é GERADO lá, com o `CI` fora do ambiente", () => {
    // `env -u CI` não é superstição: MEDIDO, sob `CI=true` o vitest RECUSA escrever o snapshot que falta e o
    // passo reprova com "Snapshot ... mismatched" em vez de tirar a fotografia. A extração roda em runner e
    // em máquina de dono — a variável tem de SAIR do ambiente, não ser torcida para não estar lá.
    expect(fonte, "o passo que gera o golden perdeu o `env -u CI`").toMatch(
      /env -u CI\b[^\n]*bunx vitest run [^\n]*board-base-pipeline\.test\.ts -u/,
    );
  });

  it("o golden gerado é conferido: 2 retratos, zero citação de produto do dono, e VALE sob CI=true", () => {
    // As três asserções da etapa 6c. Sem a primeira, uma régua que voltasse a deixar os boards privados
    // passarem republicaria o conteúdo deles por dentro do golden. Sem a terceira, um passo que não fez
    // efeito (o caso PULADO por `skipIf`) seria indistinguível de um que fez — as outras duas leem o
    // ARQUIVO, e o arquivo estaria lá de qualquer jeito.
    expect(fonte, "sumiu a asserção de EXATAMENTE 2 retratos no golden do destino").toMatch(
      /N_RETRATOS[^\n]*!=[^\n]*"2"/,
    );
    expect(fonte, "sumiu a varredura de produto do dono dentro do golden gerado").toMatch(
      /citygo\|nookify\|tribify\|tickify/,
    );
    expect(fonte, "sumiu a checagem de que o caso do golden não foi PULADO sob CI=true").toMatch(/skipped/);
  });

  // ESTAS RÉGUAS COBRAM A VARIÁVEL, NÃO A ADJACÊNCIA. Elas exigiam `CI=true`/`env -u CI` COLADO em
  // `bunx`, e em 2026-08-25 reprovaram porque um `NO_COLOR=1` legítimo entrou no meio — uma correção
  // sem relação nenhuma com o que elas guardam. Guarda que casa a FORMA da linha em vez do FATO que lhe
  // importa transforma toda edição vizinha em falso positivo; e é assim que um guarda real vira ruído
  // que alguém relaxa até ele não guardar mais nada.
  it("a SUÍTE roda no destino sob CI=true e REPROVA a extração quando falha", () => {
    // Este script imprimia, com honestidade, que NÃO tinha rodado a suíte — e foi por isso que um CI vermelho
    // chegou ao artefato sem ninguém ver (`1 failed | 411 passed`, por um golden obsoleto que só é ERRO sob
    // `CI=true`). Honestidade sobre o que não se mediu não substitui medir.
    expect(fonte, "a suíte deixou de rodar no destino").toMatch(/CI=true\b[^\n]*bunx vitest run --reporter=dot/);
    expect(fonte, "a suíte roda mas não REPROVA a extração").toMatch(/morrer "a SUÍTE reprovou no destino/);
  });

  it("o override não é só TEXTO: o extrator confere que ele resolveu no fecho gerado", () => {
    // Override que chega ao package.json e não muda resolução nenhuma é INERTE — a forma nº1 de defeito
    // desta casa (capacidade declarada sem produtor), agora com cara de proteção de supply-chain. A
    // pergunta só tem resposta no `bun.lock` GERADO no destino, e é lá que o extrator a faz.
    expect(fonte, "sumiu a conferência de que o override RESOLVEU no fecho do destino").toMatch(
      /ZERO resoluções no fecho do destino/,
    );
    expect(fonte, "a conferência existe mas não reprova a extração").toMatch(
      /morrer "override declarado que NÃO resolveu no fecho do destino/,
    );
  });

  it("a escotilha `--sem-suite` existe e diz em voz alta o que deixou de ser medido", () => {
    expect(fonte, "a escotilha sumiu — quem itera na extração fica sem saída e desliga o passo inteiro").toContain(
      "--sem-suite",
    );
    expect(fonte, "a escotilha ficou silenciosa: pular sem avisar é o mesmo que não ter medido e afirmar").toMatch(
      /A GARANTIA DO CI DO REPO NOVO NÃO FOI MEDIDA/,
    );
  });

  it("o relatório final não volta a AFIRMAR número que não mediu nesta execução", () => {
    // O cabeçalho do extrator registra o caso: a seção final já carregou "6943 passam, 71 falham" como texto
    // FIXO, e a frase saiu idêntica numa rodada em que os boards do dono VAZARAM. Agora a suíte roda de
    // verdade, e o que se imprime é a VARIÁVEL medida — ou a incerteza nomeada, quando `--sem-suite`.
    // O sujeito é o que o script IMPRIME, não o que ele comenta: o próprio cabeçalho do bloco final cita,
    // como registro histórico, a frase fixa que um dia saiu de lá ("6943 passam, 71 falham"). Varrer o
    // comentário junto tornaria este caso impossível de satisfazer sem apagar a memória do erro.
    const inicio = fonte.lastIndexOf("✓ EXTRAÇÃO APROVADA");
    expect(inicio, "não achei o bloco do relatório final").toBeGreaterThan(0);
    const impressas = fonte
      .slice(inicio)
      .split("\n")
      .filter((l) => l.trimStart().startsWith("printf"))
      .join("\n");
    expect(impressas.length, "o relatório final não imprime nada").toBeGreaterThan(200);
    expect(impressas, "o relatório deixou de imprimir o resumo MEDIDO da suíte").toContain("$SUITE_RESUMO");
    expect(impressas, "voltou número fixo de teste ao relatório final").not.toMatch(
      /\d+\s+(passam|falham|passed|failed)/,
    );
  });

  it("a classe `__snapshots__` está no piso NEGATIVO — nenhum golden pode ter VINDO daqui", () => {
    const bloco = fonte.slice(fonte.indexOf("PISO_NEGATIVO=("));
    const piso = bloco.slice(0, bloco.indexOf("\n)"));
    expect(piso.length, "não achei o bloco PISO_NEGATIVO do extrator").toBeGreaterThan(100);
    expect(piso, "a classe de golden saiu do piso negativo do extrator").toContain("__snapshots__");
  });

  it("o censo de caminhos dos workflows é EXAUSTIVO e anti-vácuo", () => {
    // O piso derivado antigo casava só o prefixo `scripts/`, e por isso `--dir .github/workflows` era
    // invisível: a extração saía "✓ APROVADA" com o CI quebrado. O censo novo lê todo `run:` e reprova
    // nomeando; e ele próprio precisa reprovar quando não teve o que ler.
    expect(fonte, "sumiu o censo de caminhos dos workflows").toContain("caminhos-dos-workflows.mjs");
    expect(fonte, "o censo perdeu a trava de não-vacuidade (censo vazio sairia 0 afirmando que está tudo lá)").toMatch(
      /entradas\.size < 4/,
    );
    expect(fonte, "o censo perdeu a conferência de que todo `run:` do texto virou bloco").toMatch(
      /blocos\.length !== nRun/,
    );
  });
});
