// A FIXTURE DO VEX — o produtor que substitui o arquivo real como sujeito dos testes de qualidade.
//
// Até 2026-09-10 a suíte de supply-chain usava o `vex-dispositions.json` versionado como teste de
// produtor: "toda `affected` traz prazo", "toda `not_affected` traz evidência", "matar a evidência de
// uma disposição REAL reprova o gate REAL". Isso tinha um pressuposto escondido — que o arquivo nunca
// ficaria vazio — e o pressuposto morreu: as 12 disposições de 2026-07-30 saíram com o próprio fecho
// (`hono`, `body-parser` e o `js-yaml` do `gray-matter` mudaram) e o estado honesto do arquivo passou a
// ser a lista vazia. Um guarda que recusa o estado honesto é um guarda que ensina a mentir.
//
// O que fica é o que sempre foi a intenção: a QUALIDADE de cada disposição que existir, seja qual for,
// e a prova de que o gate e cada verificador funcionam. Esta fixture é o sujeito dessa prova — seis
// disposições sintéticas, UMA POR VERIFICADOR implementado, re-verificadas pelo gate real contra uma
// árvore de mentira a cada rodada. O arquivo real continua medido pelas mesmas regras: a suíte roda os
// invariantes sobre `real ∪ fixture`, então nada do que se cobra da fixture deixa de ser cobrado de uma
// disposição real quando ela existir.
//
// ⚠️ Ela precisa continuar VÁLIDA contra a árvore que `ARQUIVOS_DA_FIXTURE` monta — é um teste que
// afirma isso. Uma disposição da fixture que não re-verifica é a fixture mentindo, e a suíte reprova.

/** Um advisory como o `osv-query.mjs` o relata — o suficiente para o gate julgar. */
export type AdvisoryDaFixture = {
  id: string;
  components: string[];
  severity: string;
  summary: string;
};

export type StatementDaFixture = {
  vulnerability: string;
  products: string[];
  status: "affected" | "not_affected";
  justification: string;
  impact_statement: string;
  mitigation?: string;
  reviewedAt: string;
  expiresAt?: string;
  evidence: Record<string, unknown>[];
};

export const INVARIANTE_DA_FIXTURE = "export const MAX_BYTES = 2 * 1024 * 1024;";

/**
 * A árvore contra a qual as seis disposições são VERDADEIRAS. Cada arquivo existe por causa de uma
 * evidência específica (anotado ao lado); mudar um deles é matar a evidência correspondente — e é
 * exatamente o que o teste de "evidência morta" faz, de propósito, um verificador por vez.
 */
export const ARQUIVOS_DA_FIXTURE: Readonly<Record<string, string>> = {
  // code_invariant (A): a linha que a mitigação afirma existir.
  "src/limite.ts": `${INVARIANTE_DA_FIXTURE}\nexport const parse = (b: Buffer) => (b.byteLength > MAX_BYTES ? null : b.toString());\n`,
  // importers_confined_to (B): o único importador do pacote vulnerável vive em examples/.
  // (em forma `import`, não como chamada de CommonJS: o guarda de classe de preflight.test.ts lê toda
  // chamada CommonJS com string literal em src/** como sonda spawnada e exige módulo builtin ou
  // dependência declarada — e isto é texto de fixture, não uma sonda.)
  "node_modules/sdk-exemplo/dist/examples/demo.js": 'import { serve } from "servidor-web";\n',
  "node_modules/sdk-exemplo/dist/server/http.js": 'import http from "node:http";\n',
  // code_absent (C): a config NÃO liga o recurso vulnerável.
  "config.js": "module.exports = { images: { unoptimized: true } };\n",
  // tree_absent (D): nenhum arquivo de código exporta a diretiva do runtime vulnerável.
  "src/app/page.ts": 'export const dynamic = "force-dynamic";\n',
  "src/app/layout.ts": "export const metadata = { title: 'x' };\n",
  // path_absent (E): a âncora existe; o caminho afirmado ausente não.
  "src/app/route.ts": "export const GET = () => new Response('ok');\n",
  // platform_not_applicable (F): não precisa de arquivo — a prova está no advisory.
};

export const STATEMENTS_DA_FIXTURE: readonly StatementDaFixture[] = [
  {
    vulnerability: "GHSA-ffff-0001-affe",
    products: ["pkg:npm/parser-yaml@1.2.3"],
    status: "affected",
    justification: "inline_mitigations_already_exist",
    impact_statement: "CPU quadrática no parse de cadeias de merge-key; alcançável por todo documento que passa pelo chokepoint.",
    mitigation: "Teto de bytes ANTES do parse (`MAX_BYTES` em src/limite.ts) limita a magnitude — não elimina a classe.",
    reviewedAt: "2026-09-10",
    expiresAt: "2099-12-31",
    evidence: [{ kind: "code_invariant", file: "src/limite.ts", mustContain: INVARIANTE_DA_FIXTURE }],
  },
  {
    vulnerability: "GHSA-ffff-0002-impo",
    products: ["pkg:npm/servidor-web@4.0.0"],
    status: "not_affected",
    justification: "vulnerable_code_not_in_execute_path",
    impact_statement: "o pacote entra como dependência declarada do SDK, mas só os exemplos o importam.",
    reviewedAt: "2026-09-10",
    evidence: [
      { kind: "importers_confined_to", scanDir: "node_modules/sdk-exemplo/dist", specifier: "servidor-web", allow: ["examples/"] },
    ],
  },
  {
    vulnerability: "GHSA-ffff-0003-code",
    products: ["pkg:npm/framework-web@15.0.0"],
    status: "not_affected",
    justification: "vulnerable_code_not_present",
    impact_statement: "o otimizador de imagem remoto só existe quando `remotePatterns` está configurado — e não está.",
    reviewedAt: "2026-09-10",
    evidence: [{ kind: "code_absent", file: "config.js", mustNotMatch: "remotePatterns" }],
  },
  {
    vulnerability: "GHSA-ffff-0004-tree",
    products: ["pkg:npm/framework-web@15.0.0"],
    status: "not_affected",
    justification: "vulnerable_code_not_in_execute_path",
    impact_statement: "o defeito é do runtime Edge; nenhuma rota desta árvore o declara.",
    reviewedAt: "2026-09-10",
    evidence: [{ kind: "tree_absent", scanDir: "src/app", mustNotMatch: "runtime\\s*=\\s*[\"']edge[\"']" }],
  },
  {
    vulnerability: "GHSA-ffff-0005-path",
    products: ["pkg:npm/framework-web@15.0.0"],
    status: "not_affected",
    justification: "vulnerable_code_not_present",
    impact_statement: "o defeito é do Pages Router; esta árvore só tem App Router (a âncora prova que a raiz é a certa).",
    reviewedAt: "2026-09-10",
    evidence: [{ kind: "path_absent", path: "src/pages", anchor: "src/app" }],
  },
  {
    vulnerability: "GHSA-ffff-0006-plat",
    products: ["pkg:npm/servidor-estatico@2.0.0"],
    status: "not_affected",
    justification: "vulnerable_code_cannot_be_controlled_by_adversary",
    impact_statement: "explorável apenas em hosts Windows (separador de caminho); o alvo de deploy é Linux.",
    reviewedAt: "2026-09-10",
    evidence: [{ kind: "platform_not_applicable", advisoryMustMention: "Windows", deploymentPlatform: "linux" }],
  },
];

/** O relatório de advisories que casa com as seis disposições — para o gate rodar COMPLETO, não só `--verify-only`. */
export const ADVISORIES_DA_FIXTURE: readonly AdvisoryDaFixture[] = [
  { id: "GHSA-ffff-0001-affe", components: ["parser-yaml@1.2.3"], severity: "HIGH", summary: "Quadratic CPU in merge-key chains" },
  { id: "GHSA-ffff-0002-impo", components: ["servidor-web@4.0.0"], severity: "HIGH", summary: "Header injection in servidor-web" },
  { id: "GHSA-ffff-0003-code", components: ["framework-web@15.0.0"], severity: "CRITICAL", summary: "SSRF via image optimizer remotePatterns" },
  { id: "GHSA-ffff-0004-tree", components: ["framework-web@15.0.0"], severity: "HIGH", summary: "Edge runtime header smuggling" },
  { id: "GHSA-ffff-0005-path", components: ["framework-web@15.0.0"], severity: "HIGH", summary: "Pages Router data leak" },
  { id: "GHSA-ffff-0006-plat", components: ["servidor-estatico@2.0.0"], severity: "HIGH", summary: "Path traversal on Windows via encoded backslash" },
];

/**
 * Como MATAR a evidência de cada verificador — a mutação mínima da árvore (ou do relatório) que torna a
 * disposição falsa. O teste aplica UMA por vez e exige que o gate a nomeie.
 */
export const EVIDENCIA_MORTA: Readonly<
  Record<string, { arquivos?: Record<string, string>; advisorySummary?: string; nomeia: RegExp }>
> = {
  code_invariant: { arquivos: { "src/limite.ts": "export const parse = (b: Buffer) => b.toString();\n" }, nomeia: /limite\.ts/ },
  importers_confined_to: {
    arquivos: { "node_modules/sdk-exemplo/dist/server/http.js": 'import { serve } from "servidor-web";\n' },
    nomeia: /server\/http\.js/,
  },
  code_absent: { arquivos: { "config.js": "module.exports = { images: { remotePatterns: [{ hostname: '*' }] } };\n" }, nomeia: /config\.js/ },
  tree_absent: { arquivos: { "src/app/page.ts": 'export const runtime = "edge";\n' }, nomeia: /src\/app/ },
  path_absent: { arquivos: { "src/pages/index.ts": "export default () => null;\n" }, nomeia: /src\/pages/ },
  platform_not_applicable: { advisorySummary: "Path traversal via encoded backslash (all hosts)", nomeia: /Windows/ },
};
