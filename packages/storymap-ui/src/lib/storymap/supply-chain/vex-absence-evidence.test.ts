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
import { ADVISORIES_DA_FIXTURE, ARQUIVOS_DA_FIXTURE, EVIDENCIA_MORTA, STATEMENTS_DA_FIXTURE } from "./vex-fixture";

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
 * O PRODUTOR: a fixture, e o arquivo real medido pelas mesmas regras.
 *
 * Este bloco JÁ FOI um censo literal dos 21 advisories de `next@14.2.35`, depois um conjunto de guardas
 * sobre o arquivo real — que pressupunha o arquivo nunca vazio. Em 2026-09-10 o estado honesto virou a
 * lista vazia (as 12 disposições saíram com o próprio fecho), e um guarda que recusa o estado honesto
 * ensina a mentir. O sujeito passou a ser a FIXTURE (`vex-fixture.ts`): seis disposições sintéticas,
 * uma por verificador implementado, re-verificadas pelo gate real. Os invariantes de qualidade rodam
 * sobre `real ∪ fixture` — a fixture garante que eles nunca ficam verdes por vacuidade, e uma
 * disposição real, quando existir, é cobrada exatamente como elas.
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

const reais = (): Statement[] =>
  (JSON.parse(readFileSync(DISPOSICOES, "utf8")) as { statements: Statement[] }).statements;
const todas = (): Statement[] => [...reais(), ...(STATEMENTS_DA_FIXTURE as unknown as Statement[])];

/** O gate COMPLETO (com relatório) sobre a fixture, numa árvore de mentira — opcionalmente mutada. */
function gateDaFixture(overrides: Record<string, string> = {}, advisorySummaryDe?: { id: string; summary: string }) {
  const raiz = bancada({ ...ARQUIVOS_DA_FIXTURE, ...overrides });
  const advisories = ADVISORIES_DA_FIXTURE.map((a) =>
    advisorySummaryDe && a.id === advisorySummaryDe.id ? { ...a, summary: advisorySummaryDe.summary } : a,
  );
  const relatorio = {
    target: "fixture@1.0.0",
    closure: { total: 10, runtime: 5, devOnly: 5 },
    vulnerableComponents: [...new Set(advisories.flatMap((a) => a.components))].sort(),
    advisories: advisories.map((a) => ({ kev: false, epss: 0.001, ...a })),
    failedBatches: [],
    kevCatalogAvailable: true,
    lockfileDrift: [],
    installDrift: [],
  };
  const relFile = path.join(raiz, "osv.json");
  const vexFile = path.join(raiz, "vex.json");
  writeFileSync(relFile, JSON.stringify(relatorio), "utf8");
  writeFileSync(vexFile, JSON.stringify({ statements: STATEMENTS_DA_FIXTURE }), "utf8");
  try {
    const out = execFileSync(process.execPath, [GATE, "--report", relFile, "--vex", vexFile, "--root", raiz, "--json"], {
      encoding: "utf8",
    });
    return { code: 0, v: JSON.parse(out) as Veredito & { expiredStatements?: unknown[]; undisposed?: unknown[] } };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, v: err.stdout ? (JSON.parse(err.stdout) as Veredito) : null };
  }
}

describe("PRODUTOR: a fixture cobre o gate inteiro, e o arquivo real é medido pelas mesmas regras", () => {
  it("a fixture não é vácuo: tem os dois status, e toda disposição fixa a versão no purl", () => {
    const fx = STATEMENTS_DA_FIXTURE;
    expect(fx.some((st) => st.status === "affected"), "fixture sem `affected`").toBe(true);
    expect(fx.some((st) => st.status === "not_affected"), "fixture sem `not_affected`").toBe(true);
    // Toda disposição vale para o par (advisory, purl COM VERSÃO). Um produto sem versão suprimiria o
    // pacote INTEIRO, para sempre — inclusive advisory que ainda nem existe. Vale para real e fixture.
    for (const st of todas()) {
      expect(st.products.length, `${st.vulnerability} sem produto`).toBeGreaterThan(0);
      for (const purl of st.products) {
        // Pacote com ESCOPO tem `@` no NOME (`pkg:npm/@org/pkg@1.0.0`): a versão é o que vem depois do
        // ÚLTIMO `@`, e uma régua que assume um `@` só reprova metade do ecossistema npm.
        expect(purl, `${st.vulnerability}: ${purl} não fixa versão`).toMatch(/^pkg:npm\/(@[^/@]+\/)?[^/@]+@[^@]+$/);
      }
    }
  });

  it("toda `affected` (real ∪ fixture) traz mitigação e um PRAZO posterior à revisão que a escreveu", () => {
    // `caveat` NÃO entra na régua, de propósito: o gate exige `mitigation` e `expiresAt` para uma
    // `affected`, nunca `caveat`. O que a `affected` precisa dizer (até quando isto vale) já está no
    // `expiresAt`.
    const afetadas = todas().filter((st) => st.status === "affected");
    expect(afetadas.length, "nenhuma `affected` — nem na fixture").toBeGreaterThan(0);
    for (const st of afetadas) {
      expect(st.mitigation?.trim().length ?? 0, `${st.vulnerability} sem mitigação`).toBeGreaterThan(8);
      expect(st.expiresAt, `${st.vulnerability} sem prazo`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A régua é o par (revisão, prazo), não uma data fixa: comparar com "hoje" faria a suíte ficar
      // vermelha por passagem do tempo em vez de por defeito — vencimento é do gate, com relatório.
      expect(st.reviewedAt, `${st.vulnerability} sem data de revisão`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        Date.parse(`${st.expiresAt}T23:59:59Z`),
        `${st.vulnerability}: o prazo (${st.expiresAt}) não é posterior à revisão (${st.reviewedAt})`,
      ).toBeGreaterThan(Date.parse(`${st.reviewedAt}T00:00:00Z`));
    }
  });

  it("toda `not_affected` (real ∪ fixture) traz justificativa do vocabulário OpenVEX E evidência re-executável", () => {
    const VOCAB = new Set([
      "component_not_present",
      "vulnerable_code_not_present",
      "vulnerable_code_not_in_execute_path",
      "vulnerable_code_cannot_be_controlled_by_adversary",
      "inline_mitigations_already_exist",
    ]);
    const imunes = todas().filter((st) => st.status === "not_affected");
    expect(imunes.length, "nenhuma `not_affected` — nem na fixture").toBeGreaterThan(0);
    for (const st of imunes) {
      expect(VOCAB.has(st.justification ?? ""), `${st.vulnerability}: justificativa fora do vocabulário`).toBe(true);
      expect(st.evidence?.length ?? 0, `${st.vulnerability}: afirmar não é provar`).toBeGreaterThan(0);
    }
  });

  it("todo verificador IMPLEMENTADO no gate tem UMA disposição na fixture — e nenhum a mais", () => {
    // A forma nº 1 de defeito desta casa é capacidade declarada com zero produtores. Um `kind` novo no
    // gate sem disposição na fixture reprova aqui; um `kind` na fixture que o gate não implementa
    // reprova na entrada do próprio gate (o caso abaixo).
    const fonteDoGate = readFileSync(GATE, "utf8");
    const corpo = /const VERIFICADORES = \{([\s\S]*?)\n\};/.exec(fonteDoGate);
    expect(corpo, "não achei `const VERIFICADORES = {…}` no gate — a régua ficaria sem sujeito").toBeTruthy();
    const implementados = [...(corpo as RegExpExecArray)[1].matchAll(/^  ([a-z_]+)\(ev, ctx\)/gm)].map((m) => m[1]).sort();
    expect(implementados.length, "nenhum verificador lido — o extrator quebrou").toBeGreaterThan(2);
    const naFixture = [...new Set(STATEMENTS_DA_FIXTURE.flatMap((st) => st.evidence.map((e) => String(e.kind))))].sort();
    expect(naFixture, "verificador sem disposição na fixture (ou fixture com kind que o gate não tem)").toEqual(implementados);
    expect(Object.keys(EVIDENCIA_MORTA).sort(), "verificador sem receita de evidência morta").toEqual(implementados);
  });

  it("a fixture RE-VERIFICA limpa pelo gate REAL, com relatório — a fixture não mente", () => {
    const r = gateDaFixture();
    expect(r.code, JSON.stringify(r.v)).toBe(0);
    expect(r.v?.staleStatements).toEqual([]);
    expect(r.v?.invalidStatements).toEqual([]);
    expect(r.v?.notAffected?.length ?? 0).toBe(5);
  });

  it("MATAR a evidência de CADA verificador, um por vez, reprova o gate REAL nomeando o que morreu", () => {
    for (const [kind, morte] of Object.entries(EVIDENCIA_MORTA)) {
      const st = STATEMENTS_DA_FIXTURE.find((x) => x.evidence.some((e) => e.kind === kind));
      expect(st, `sem disposição para ${kind}`).toBeTruthy();
      const r = gateDaFixture(
        morte.arquivos ?? {},
        morte.advisorySummary ? { id: st!.vulnerability, summary: morte.advisorySummary } : undefined,
      );
      expect(r.code, `${kind}: evidência morta tem de REPROVAR`).toBe(2);
      const morta = r.v?.staleStatements.find((x) => x.vulnerability === st!.vulnerability);
      expect(morta, `${kind}: a disposição tinha de aparecer como DESATUALIZADA`).toBeTruthy();
      expect(morta?.reason, `${kind}: o motivo não nomeia o que morreu`).toMatch(morte.nomeia);
      // e SÓ ela morreu — a mutação é cirúrgica, senão o teste não distingue verificadores.
      expect(r.v?.staleStatements.length, `${kind}: mais de uma disposição morreu`).toBe(1);
    }
  });

  it("o arquivo REAL re-verifica pelo gate — vazio é o estado honesto quando nenhum advisory pede disposição", () => {
    const r = verificar(REPO_ROOT, [], DISPOSICOES);
    expect(r.code, JSON.stringify(r.v)).toBe(0);
    expect(r.v?.staleStatements).toEqual([]);
    expect(r.v?.invalidStatements).toEqual([]);
  });
});
