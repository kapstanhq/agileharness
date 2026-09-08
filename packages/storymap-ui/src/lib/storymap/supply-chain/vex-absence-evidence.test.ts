// ATAQUE: a prova de AUSÊNCIA que não examinou nada.
//
// A maior parte das disposições de framework se sustenta numa ausência — "não configuramos
// `remotePatterns`", "não existe rota no runtime Edge", "não há Pages Router". É a forma honesta de
// dizer que o produto é imune: o que o protege não é uma linha escrita, é uma que ninguém escreveu.
//
// Só que "não encontrei" e "não procurei" produzem o MESMO silêncio, e é aí que a evidência de ausência
// vira a ferramenta perfeita para lavar advisory: um `scanDir` com typo, um arquivo que sumiu, uma regex
// que nunca casa, um laço que não itera — todos terminam sem achado e saem como PROVA. Esta casa já pagou
// por essa classe três vezes (o resolvedor que media 30 de 684 pacotes, o `check-licenses` aprovando fecho
// vazio, o `scanDir` literal que não resolvia sob layout isolado).
//
// Os três verificadores novos (`code_absent`, `tree_absent`, `path_absent`) nasceram com as travas que
// fecham cada porta, e é ESTE arquivo que as segura:
//   · arquivo/diretório que não resolve REPROVA (fail-closed, nunca "não achei o padrão");
//   · regex inválida REPROVA na ENTRADA, em vez de virar busca que aprova tudo para sempre;
//   · varredura que leu ZERO arquivos REPROVA — é a assinatura literal do vácuo-verde;
//   · `path_absent` exige ÂNCORA, porque a partir da raiz errada TODO caminho é ausente.
//
// O último bloco é o produtor sobre o arquivo REAL: o censo dos 21 advisories do next@14.2.35 e a prova de
// que matar a evidência de uma disposição de verdade reprova o gate de verdade.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const GATE = path.join(REPO_ROOT, "scripts/security/vex-gate.mjs");
const DISPOSICOES = path.join(REPO_ROOT, "scripts/security/vex-dispositions.json");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function bancada(arquivos: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-vexaus-"));
  dirs.push(dir);
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo, "utf8");
  }
  return dir;
}

type Veredito = {
  ok: boolean;
  staleStatements: { vulnerability: string; reason: string }[];
  invalidStatements: { vulnerability: string; reason: string }[];
  notAffected: string[];
};

/** Roda o gate DE VERDADE em modo offline (`--verify-only`), que é o modo que só re-verifica evidência. */
function verificar(raiz: string, statements: unknown[], vexFile?: string) {
  const arquivo = vexFile ?? path.join(raiz, "vex.json");
  if (!vexFile) writeFileSync(arquivo, JSON.stringify({ statements }), "utf8");
  try {
    const out = execFileSync(process.execPath, [GATE, "--verify-only", "--vex", arquivo, "--root", raiz, "--json"], {
      encoding: "utf8",
    });
    return { code: 0, v: JSON.parse(out) as Veredito };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, v: err.stdout ? (JSON.parse(err.stdout) as Veredito) : null };
  }
}

/** Disposição `not_affected` mínima e VÁLIDA — cada caso troca só o bloco de evidência. */
function comEvidencia(evidence: unknown[]) {
  return [
    {
      vulnerability: "GHSA-teste-0000-0000",
      products: ["pkg:npm/exemplo@1.0.0"],
      status: "not_affected",
      justification: "vulnerable_code_not_in_execute_path",
      impact_statement: "a feature vulnerável não está ligada neste produto",
      reviewedAt: "2026-08-19",
      evidence,
    },
  ];
}

describe("code_absent — provar que uma linha NÃO está lá", () => {
  it("padrão ausente do arquivo APROVA (a régua não é um `exit 2` fixo)", () => {
    const raiz = bancada({ "next.config.js": "module.exports = { poweredByHeader: false };\n" });
    const r = verificar(raiz, comEvidencia([{ kind: "code_absent", file: "next.config.js", mustNotMatch: "remotePatterns" }]));
    expect(r.code).toBe(0);
    expect(r.v?.notAffected).toContain("GHSA-teste-0000-0000");
  });

  it("ATAQUE: o padrão APARECEU — a disposição morre no mesmo commit", () => {
    // É o cenário inteiro: alguém liga `remotePatterns` e o `not_affected` que dizia "esse ramo nunca
    // executa" continuaria calando o advisory para sempre se não houvesse re-verificação.
    const raiz = bancada({ "next.config.js": "module.exports = { images: { remotePatterns: [{}] } };\n" });
    const r = verificar(raiz, comEvidencia([{ kind: "code_absent", file: "next.config.js", mustNotMatch: "remotePatterns" }]));
    expect(r.code, "padrão presente tem de REPROVAR").toBe(2);
    expect(r.v?.staleStatements[0].reason).toContain("next.config.js");
  });

  it("ATAQUE: arquivo da evidência SUMIU é REPROVA, não aprovação por não ter procurado", () => {
    // A porta mais barata da classe: renomeie o arquivo e a busca deixa de achar o padrão. Sem esta
    // trava, apagar o arquivo seria uma forma de aprovar a disposição.
    const raiz = bancada({ "outro.js": "nada aqui\n" });
    const r = verificar(raiz, comEvidencia([{ kind: "code_absent", file: "next.config.js", mustNotMatch: "remotePatterns" }]));
    expect(r.code).toBe(2);
    expect(r.v?.staleStatements[0].reason).toContain("ausente");
  });

  it("ATAQUE: regex inválida é REPROVA — senão seria uma busca que nunca casa e aprova tudo", () => {
    const raiz = bancada({ "next.config.js": "remotePatterns\n" });
    const r = verificar(raiz, comEvidencia([{ kind: "code_absent", file: "next.config.js", mustNotMatch: "([" }]));
    expect(r.code).toBe(2);
    expect(r.v?.staleStatements[0].reason).toMatch(/regex/i);
  });
});

describe("tree_absent — provar que uma linha não está em NENHUM arquivo da árvore", () => {
  const LIMPA = {
    "src/app/page.tsx": "export default function P() { return null; }\n",
    "src/app/rota/route.ts": "export async function GET() { return new Response('ok'); }\n",
  };

  it("árvore sem a ocorrência APROVA", () => {
    const raiz = bancada(LIMPA);
    const r = verificar(
      raiz,
      comEvidencia([{ kind: "tree_absent", scanDir: "src/app", mustNotMatch: "runtime\\s*=\\s*[\"']edge[\"']" }]),
    );
    expect(r.code).toBe(0);
  });

  it("ATAQUE: UM arquivo com a ocorrência derruba a disposição, e o achado o NOMEIA", () => {
    const raiz = bancada({ ...LIMPA, "src/app/edge/route.ts": 'export const runtime = "edge";\n' });
    const r = verificar(
      raiz,
      comEvidencia([{ kind: "tree_absent", scanDir: "src/app", mustNotMatch: "runtime\\s*=\\s*[\"']edge[\"']" }]),
    );
    expect(r.code).toBe(2);
    expect(r.v?.staleStatements[0].reason).toContain("edge/route.ts");
  });

  it("ATAQUE (VÁCUO-VERDE): diretório existe mas sem arquivo de código NENHUM é REPROVA", () => {
    // O caso que este arquivo existe para fechar. Um laço que não itera termina sem achado e sai como
    // "limpo" — a varredura afirma ausência sem ter lido uma linha. `README.md` não é código, então o
    // diretório resolve e mesmo assim ZERO arquivos são examinados.
    const raiz = bancada({ "src/app/README.md": "só documentação\n" });
    const r = verificar(
      raiz,
      comEvidencia([{ kind: "tree_absent", scanDir: "src/app", mustNotMatch: "qualquer-coisa" }]),
    );
    expect(r.code, "varredura vazia NÃO pode aprovar").toBe(2);
    expect(r.v?.staleStatements[0].reason).toMatch(/VAZIA|zero arquivos/i);
  });

  it("ATAQUE: `scanDir` que não resolve é REPROVA (typo não vira prova)", () => {
    const raiz = bancada(LIMPA);
    const r = verificar(raiz, comEvidencia([{ kind: "tree_absent", scanDir: "src/aap", mustNotMatch: "x" }]));
    expect(r.code).toBe(2);
    expect(r.v?.staleStatements[0].reason).toContain("scanDir ausente");
  });

  it("CONTRAPROVA: `allow[]` isenta um prefixo sem abrir a árvore inteira", () => {
    // O dist de um SDK traz `examples/` que importa o mundo. Sem a isenção por prefixo a evidência seria
    // inútil aqui — e uma evidência inútil é uma evidência que ninguém escreve.
    const raiz = bancada({
      ...LIMPA,
      "src/app/examples/demo.ts": 'export const runtime = "edge";\n',
    });
    const r = verificar(
      raiz,
      comEvidencia([
        {
          kind: "tree_absent",
          scanDir: "src/app",
          mustNotMatch: "runtime\\s*=\\s*[\"']edge[\"']",
          allow: ["examples/"],
        },
      ]),
    );
    expect(r.code).toBe(0);
  });
});

describe("path_absent — provar que um diretório inteiro não existe", () => {
  it("caminho ausente com âncora presente APROVA", () => {
    const raiz = bancada({ "src/app/page.tsx": "export default function P() { return null; }\n" });
    const r = verificar(raiz, comEvidencia([{ kind: "path_absent", path: "src/pages", anchor: "src/app" }]));
    expect(r.code).toBe(0);
  });

  it("ATAQUE: o caminho NASCEU — Pages Router de volta derruba a disposição", () => {
    const raiz = bancada({
      "src/app/page.tsx": "export default function P() { return null; }\n",
      "src/pages/index.tsx": "export default function I() { return null; }\n",
    });
    const r = verificar(raiz, comEvidencia([{ kind: "path_absent", path: "src/pages", anchor: "src/app" }]));
    expect(r.code).toBe(2);
    expect(r.v?.staleStatements[0].reason).toContain("src/pages");
  });

  it("ATAQUE (VÁCUO-VERDE): raiz ERRADA é REPROVA — sem âncora, tudo seria ausente", () => {
    // Rodado de um diretório qualquer, `src/pages` não existe e a disposição passaria por acidente. A
    // âncora é o irmão que PRECISA existir: se ela sumiu, quem está errado é a raiz, não a árvore.
    const raiz = bancada({ "outra-coisa.txt": "raiz que não é a do produto\n" });
    const r = verificar(raiz, comEvidencia([{ kind: "path_absent", path: "src/pages", anchor: "src/app" }]));
    expect(r.code, "âncora ausente tem de REPROVAR").toBe(2);
    expect(r.v?.staleStatements[0].reason).toContain("âncora");
  });

  it("`path_absent` sem `anchor` é rejeitada na ENTRADA (evidência incompleta não é evidência)", () => {
    const raiz = bancada({ "src/app/page.tsx": "x\n" });
    const r = verificar(raiz, comEvidencia([{ kind: "path_absent", path: "src/pages" }]));
    expect(r.code).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PRODUTOR: o arquivo REAL. Sem este bloco, os verificadores acima seriam capacidade construída e não
// usada — e as 21 disposições do next seriam prosa que ninguém confere.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * O ARQUIVO REAL. Aqui não há fixture: são as disposições versionadas.
 *
 * Este bloco JÁ FOI um censo literal dos 21 advisories de `next@14.2.35` — uma lista de GHSAs escrita à
 * mão, que existia para transformar "escrevi disposições para o next" em "escrevi para TODAS". Ela morreu
 * em 2026-08-25 com o que media: a subida para o `next@15.5.21` tirou os 21 do fecho, as disposições
 * viraram MUDAS (não casam com advisory nenhum, não calam nada, e o `vex-gate` passou a listá-las sob
 * "disposições OBSOLETAS") e foram removidas.
 *
 * A lição está no formato do que ficou. Um guarda pinado no estado em que foi escrito protege enquanto o
 * estado durar e depois vira ou ruído ou mentira — e a EXAUSTIVIDADE que aquele censo prometia é, de
 * qualquer forma, do gate com relatório na mão (`undisposed`/`escalated`), não de um teste offline. O que
 * um teste offline pode cobrar, e cobra aqui, é a QUALIDADE de cada disposição que existir, seja de que
 * pacote for.
 */
type Statement = {
  vulnerability: string;
  products: string[];
  status: string;
  justification?: string;
  impact_statement?: string;
  mitigation?: string;
  caveat?: string;
  reviewedAt?: string;
  expiresAt?: string;
  evidence?: { kind: string }[];
};

const disposicoes = (): Statement[] =>
  (JSON.parse(readFileSync(DISPOSICOES, "utf8")) as { statements: Statement[] }).statements;

describe("PRODUTOR: as disposições REAIS do arquivo versionado", () => {
  it("o arquivo TEM disposições — vazio passaria todos os casos abaixo de graça", () => {
    const todas = disposicoes();
    expect(todas.length, "o arquivo de disposições esvaziou — nada abaixo mediu coisa alguma").toBeGreaterThan(0);
    // Toda disposição vale para o par (advisory, purl COM VERSÃO). Um produto sem versão suprimiria o
    // pacote INTEIRO, para sempre — inclusive advisory que ainda nem existe.
    for (const st of todas) {
      expect(st.products.length, `${st.vulnerability} sem produto`).toBeGreaterThan(0);
      for (const purl of st.products) {
        // Pacote com ESCOPO tem `@` no NOME (`pkg:npm/@hono/node-server@1.19.14`): a versão é o que vem
        // depois do ÚLTIMO `@`, e uma régua que assume um `@` só reprova metade do ecossistema npm.
        expect(purl, `${st.vulnerability}: ${purl} não fixa versão`).toMatch(
          /^pkg:npm\/(@[^/@]+\/)?[^/@]+@[^@]+$/,
        );
      }
    }
  });

  it("toda `affected` traz mitigação e um PRAZO posterior à revisão que a escreveu", () => {
    // `caveat` NÃO entra na régua, e a ausência dele aqui é deliberada: o gate exige `mitigation` e
    // `expiresAt` para uma `affected`, nunca `caveat`. Todas as 21 do next traziam um, e generalizar o
    // censo daquele bloco cobraria de 12 disposições uma convenção de autoria de outro autor — 11
    // ficariam vermelhas, e o conserto seria inventar caveat ou baixar a régua. O que a `affected`
    // precisa dizer (até quando isto vale) já está no `expiresAt`.
    const afetadas = disposicoes().filter((st) => st.status === "affected");
    expect(afetadas.length, "nenhuma `affected` — o arquivo teria virado otimismo").toBeGreaterThan(0);
    for (const st of afetadas) {
      expect(st.mitigation?.trim().length ?? 0, `${st.vulnerability} sem mitigação`).toBeGreaterThan(8);
      expect(st.expiresAt, `${st.vulnerability} sem prazo`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A régua é o par (revisão, prazo), não uma data fixa: prazo ANTERIOR à revisão é sem sentido, e
      // comparar com "hoje" faria a suíte ficar vermelha por passagem do tempo em vez de por defeito —
      // vencimento é do gate, que reprova com o relatório na mão.
      expect(st.reviewedAt, `${st.vulnerability} sem data de revisão`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        Date.parse(`${st.expiresAt}T23:59:59Z`),
        `${st.vulnerability}: o prazo (${st.expiresAt}) não é posterior à revisão (${st.reviewedAt})`,
      ).toBeGreaterThan(Date.parse(`${st.reviewedAt}T00:00:00Z`));
    }
  });

  it("toda `not_affected` traz justificativa do vocabulário OpenVEX E evidência re-executável", () => {
    const VOCAB = new Set([
      "component_not_present",
      "vulnerable_code_not_present",
      "vulnerable_code_not_in_execute_path",
      "vulnerable_code_cannot_be_controlled_by_adversary",
      "inline_mitigations_already_exist",
    ]);
    const imunes = disposicoes().filter((st) => st.status === "not_affected");
    expect(imunes.length, "nenhuma `not_affected` — nada foi julgado por alcance").toBeGreaterThan(0);
    for (const st of imunes) {
      expect(VOCAB.has(st.justification ?? ""), `${st.vulnerability}: justificativa fora do vocabulário`).toBe(true);
      expect(st.evidence?.length ?? 0, `${st.vulnerability}: afirmar não é provar`).toBeGreaterThan(0);
    }
  });

  it("todo verificador IMPLEMENTADO é exercitado — pelo arquivo real ou por um caso desta suíte", () => {
    // A forma nº 1 de defeito desta casa é capacidade declarada com zero produtores. A régua tem DOIS
    // sentidos aceitáveis porque a ferramenta é PUBLICADA: um `kind` que este repositório não usa hoje
    // continua sendo contrato para quem adota (ele escreve as disposições DELE), e o que prova que ele
    // funciona são os casos acima. O que não pode existir é verificador que ninguém exercita em lugar
    // nenhum — foi o que quase aconteceu com `code_absent`/`tree_absent`/`path_absent` quando o bloco do
    // next saiu levando os únicos usos reais deles.
    const fonteDoGate = readFileSync(GATE, "utf8");
    const corpo = /const VERIFICADORES = \{([\s\S]*?)\n\};/.exec(fonteDoGate);
    expect(corpo, "não achei `const VERIFICADORES = {…}` no gate — a régua ficaria sem sujeito").toBeTruthy();
    const implementados = [...(corpo as RegExpExecArray)[1].matchAll(/^  ([a-z_]+)\(ev, ctx\)/gm)].map((m) => m[1]);
    expect(implementados.length, "nenhum verificador lido — o extrator quebrou").toBeGreaterThan(2);

    const noArquivoReal = new Set(disposicoes().flatMap((st) => (st.evidence ?? []).map((e) => e.kind)));
    const estaSuite = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const semExercicio = implementados
      .filter((kind) => !noArquivoReal.has(kind) && !estaSuite.includes(`kind: "${kind}"`))
      .sort();
    expect(
      semExercicio,
      "verificador que nem o arquivo real usa nem esta suíte exercita: ou ganha um caso, ou sai do gate",
    ).toEqual([]);
  });

  it("MATAR a evidência de uma disposição REAL reprova o gate REAL", () => {
    // Não é fixture: são as disposições versionadas, medidas contra uma árvore em que alguém passou a
    // importar `express` dentro de `packages/storymap-ui/src`. A entrada do GHSA-v422-hmwv-36x6 afirma
    // exatamente que ninguém ali importa — então ela tem de morrer, nomeando o motivo.
    const raiz = bancada({
      "packages/storymap-ui/src/rota-nova.ts": 'import express from "express";\nexport const app = express();\n',
    });
    const r = verificar(raiz, [], DISPOSICOES);
    expect(r.code, "evidência morta tem de REPROVAR").toBe(2);
    const morta = r.v?.staleStatements.find((st) => st.vulnerability === "GHSA-v422-hmwv-36x6");
    expect(morta, "a disposição do express tinha de aparecer como DESATUALIZADA").toBeTruthy();
    expect(morta?.reason).toContain("express");
  });
});
