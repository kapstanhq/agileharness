// POR QUE este arquivo existe.
//
// Um gate de segurança que o repositório NÃO CARREGA é um gate que não existe — e essa não é uma
// hipótese: `scripts/security/lib/dep-closure.mjs` foi escrito, importado por dois gates
// (`check-licenses.mjs` e `generate-sbom.mjs`), passou em todos os testes locais e **nunca entrou no
// commit**, porque a regra genérica `lib/` do `.gitignore` (feita para artefato de build) o apanhou
// como se fosse saída de compilação. O sintoma foi indireto e caro de ler: na árvore do merge gate o
// `import` falhava, o script morria por exceção e saía com código 1 — enquanto o teste esperava o
// código 2 de "reprovou por achado". Dezenove testes vermelhos, todos apontando para uma asserção que
// estava certa.
//
// O que este teste IMPEDE: que um gate de segurança volte a depender de um arquivo que existe só na
// árvore de quem o escreveu. Ele não confia em lista mantida à mão — descobre os imports relativos
// lendo os próprios scripts, e pergunta ao git (a autoridade real) se cada alvo viaja no repositório.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../../../../../..");
const DIR_SCRIPTS = path.join(RAIZ, "scripts", "security");

/** Todo import/require RELATIVO de um módulo — é o que pode apontar para fora do que foi commitado. */
function importsRelativos(fonte: string): string[] {
  const alvos = new Set<string>();
  for (const m of fonte.matchAll(/(?:from|import|require\()\s*["'](\.[^"']+)["']/g)) alvos.add(m[1]);
  return [...alvos];
}

/** O git é a autoridade: `ls-files --error-unmatch` só sai 0 para caminho RASTREADO. */
function rastreadoPeloGit(abs: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", abs], { cwd: RAIZ, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const scripts = readdirSync(DIR_SCRIPTS).filter((f) => f.endsWith(".mjs"));

describe("gates de segurança viajam inteiros no repositório", () => {
  it("existe pelo menos um gate para verificar (o teste não pode passar por vacuidade)", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  // COLETA-ENTÃO-ASSERTA. Antes o `expect` morava DENTRO do laço, e MEDIDO (2026-08-12, com
  // `expect.requireAssertions`): dois gates — `lint-workflows.mjs` e `vex-gate.mjs` — não têm import
  // relativo nenhum, então o laço era vazio e o caso passava sem conferir coisa alguma. Não era
  // errado: era mudo. Um teste mudo e um teste aprovador são indistinguíveis no relatório, e é
  // exatamente esse par que este arquivo existe para separar em outro lugar.
  it.each(scripts)("%s — todo import relativo dele está rastreado pelo git", (nome) => {
    const abs = path.join(DIR_SCRIPTS, nome);
    const naoRastreados = importsRelativos(readFileSync(abs, "utf8"))
      .map((alvo) => ({ alvo, resolvido: path.resolve(path.dirname(abs), alvo) }))
      .filter(({ resolvido }) => !rastreadoPeloGit(resolvido))
      .map(
        ({ alvo, resolvido }) =>
          `${nome} importa "${alvo}" → ${path.relative(RAIZ, resolvido)} (NÃO rastreado pelo git)`,
      );
    expect(
      naoRastreados,
      "Na árvore do merge gate esse import falha e o script morre por exceção — o gate vira inerte.\n" +
        'Provável causa: uma regra ampla do .gitignore (ex.: "lib/") apanhando código-fonte. ' +
        "Corrija com uma exceção explícita, como as que já existem para scripts/lib/ e scripts/deploy/lib/.",
    ).toEqual([]);
  });

  it("[ATAQUE] o próprio guarda não passa se o git deixar de responder o que se pergunta a ele", () => {
    // Se `rastreadoPeloGit` passasse a devolver true por engano (repo ausente, cwd errado, exceção
    // engolida), os casos acima ficariam VERDES sem medir nada. Um caminho que sabidamente não existe
    // tem de dar false — é o que prova que a resposta vem do git, e não do catch.
    expect(rastreadoPeloGit(path.join(DIR_SCRIPTS, "arquivo-que-nunca-existiu.mjs"))).toBe(false);
  });
});

/**
 * A PROPRIEDADE INVERSA, e ela mora aqui pelo mesmo motivo do bloco acima: o conjunto RASTREADO
 * é intenção, não acidente. Lá o defeito é código-fonte que ficou de fora; aqui é saída de
 * FERRAMENTA que entrou.
 *
 * `next-env.d.ts` é gerado pelo Next a cada `build`/`dev`, e a documentação oficial manda
 * gitignorá-lo e removê-lo do git se já estiver rastreado
 * (nextjs.org/docs/app/api-reference/config/typescript). Ele precisa continuar no `include` do
 * tsconfig — ignorar no git não é remover do TypeScript —, e isso segue verdade.
 *
 * POR QUE ISTO VIROU GUARDA, e não só uma linha de .gitignore: rastreado, ele oscilava a cada
 * build. `packages/storymap-ui` builda em DOIS distDir (`.next` no normal, `.next-staging` no
 * self-deploy, `next.config.js`), e o Next reescreve o arquivo com uma referência que aponta para
 * o distDir daquele build. Resultado medido em 2026-08-27: a árvore ficava suja sozinha, o arquivo
 * VIAJAVA para o artefato publicado carregando uma referência a um diretório que lá não existe, e
 * foi preciso restaurá-lo à mão três vezes numa única sessão para publicar limpo.
 *
 * MEDIDO antes de destrackear, nos TRÊS pacotes: `bunx tsc --noEmit` sai 0 sem o arquivo. A
 * segunda passada de tipos do `ci.yml` continua valendo — quem a alimenta é o `build`, que recria
 * o arquivo de qualquer forma.
 */
describe("saída de ferramenta não entra no conjunto rastreado", () => {
  const GERADOS = ["next-env.d.ts"] as const;

  it("nenhum arquivo gerado pelo Next está rastreado", () => {
    const rastreados = execFileSync("git", ["ls-files"], { cwd: RAIZ, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    // NÃO-VACUIDADE: um `ls-files` que devolvesse vazio (cwd errado, git ausente) deixaria a
    // asserção abaixo verde sem medir nada — a mesma falha que o [ATAQUE] acima separa.
    expect(rastreados.length, "`git ls-files` devolveu vazio — a varredura não mediu nada").toBeGreaterThan(500);

    const culpados = rastreados.filter((f) => GERADOS.some((g) => f === g || f.endsWith(`/${g}`)));
    expect(
      culpados,
      "arquivo GERADO pelo Next dentro do conjunto rastreado. Ele é reescrito a cada build (e, onde " +
        "há mais de um `distDir`, com conteúdo DIFERENTE por build), então rastreá-lo suja a árvore " +
        "sozinho e publica no artefato uma referência a um diretório que lá não existe. A recomendação " +
        "oficial do Next é gitignorá-lo e removê-lo do índice; ele continua no `include` do tsconfig.",
    ).toEqual([]);
  });
  it("o .gitignore que VIAJA ignora os mesmos gerados", () => {
    // DUAS CÓPIAS, e é fácil editar só uma. A extração TRANSPLANTA `packages/storymap-ui/.gitignore`
    // para a RAIZ do artefato (`oss/extract.sh`, etapa 3) — o `.gitignore` da raiz do monorepo NÃO
    // viaja. MEDIDO em 2026-08-27: com a regra só na raiz, o `bun run build` do destino criava o
    // arquivo, o `git add -A` o rastreava e a suíte reprovava LÁ. O caso acima é cego a isso: ele
    // mede a árvore DAQUI, onde a regra da raiz já basta.
    //
    // Este caso fecha a volta em milissegundos, em vez de esperar os ~8min de uma extração.
    const regras = readFileSync(path.join(RAIZ, "packages", "storymap-ui", ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(regras.length, "o .gitignore do pacote veio vazio — a leitura não mediu nada").toBeGreaterThan(10);

    const ausentes = GERADOS.filter((g) => !regras.includes(g));
    expect(
      ausentes,
      "arquivo gerado que o .gitignore TRANSPLANTADO não ignora. Ele vira a raiz do repositório " +
        "publicado: sem a regra, o primeiro build de lá cria o arquivo e o primeiro `git add -A` o " +
        "rastreia — o mesmo defeito, do outro lado do corte.",
    ).toEqual([]);
  });
});
