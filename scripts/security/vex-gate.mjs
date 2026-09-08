#!/usr/bin/env node
// O GATE de SCA: aplica o VEX versionado sobre o relatório de advisories e decide aprovar/reprovar.
//
// Por que VEX é requisito e não enfeite: 10 dos 44 advisories desta árvore são de pacote INSTALADO e NÃO
// EXECUTADO (`hono` e vizinhos entram como dependência declarada do SDK do MCP, mas só os `examples/` os
// importam). Sem disposição, quem clonar o repo roda `npm audit`, vê a lista inteira e conclui que o
// projeto é abandonado — e os advisories que importam de verdade ficam enterrados no meio.
//
// E por que o VEX precisa de um gate que o CONTESTE: uma linha de JSON dizendo `not_affected` cala qualquer
// scanner, para sempre, sem revisão. É a ferramenta perfeita para lavar vulnerabilidade. Os quatro furos que
// este arquivo fecha, cada um com teste de ataque em
// `packages/storymap-ui/src/lib/storymap/supply-chain/vex-gate.test.ts`:
//
//   1. STALENESS — a justificativa era verdadeira quando escrita. Toda disposição `not_affected` carrega
//      EVIDÊNCIA que este gate RE-EXECUTA; evidência que não confere invalida a disposição e REPROVA.
//   2. ESCOPO — a disposição vale para o par (advisory, purl com versão) e nada além: advisory novo do
//      mesmo pacote, ou versão nova, não nascem suprimidos.
//   3. DÍVIDA ETERNA — `affected` exige mitigação E prazo; prazo vencido reprova.
//   4. AFIRMAÇÃO SEM PROVA — `not_affected` sem evidência, com justificativa fora do vocabulário OpenVEX,
//      ou com tipo de evidência não implementado, é rejeitada na entrada.
//   5. PROVA DE AUSÊNCIA QUE NÃO EXAMINOU NADA — `code_absent`, `tree_absent` e `path_absent` afirmam que
//      uma feature NÃO está ligada (sem `remotePatterns`, sem rota no Edge runtime, sem Pages Router), e é
//      assim que a maioria das disposições de framework se sustenta: o que torna o produto imune não é uma
//      linha escrita, é uma que ninguém escreveu. Só que "não encontrei" e "não procurei" produzem o MESMO
//      silêncio, então cada um carrega a sua trava: arquivo/diretório que não resolve REPROVA, regex
//      inválida REPROVA na entrada, varredura que leu ZERO arquivos REPROVA, e `path_absent` exige uma
//      ÂNCORA — um irmão que precisa existir — porque a partir da raiz errada tudo é ausente.
//
// KEV e pacote `MAL-` são INSUPRIMÍVEIS: exploração ativa registrada e pacote malicioso não são caso de
// análise de alcançabilidade, são caso de tirar da árvore. Deixar o VEX cobri-los seria a válvula que anula
// o gate inteiro. E porque o insuprimível é o controle mais forte daqui, ele exige MEDIÇÃO PROVADA do KEV:
// relatório que diz `kevCatalogAvailable: false`, que OMITE o campo, ou que jura tê-lo medido carregando
// advisory com `kev` não-booleano, todos REPROVAM. Sem isso a oscilação de rede (ou um relatório de outra
// versão do produtor) apagaria o insuprimível sem ninguém ver — fail-open no único dia que importa.
//
// Uso:
//   node scripts/security/vex-gate.mjs --report <osv.json> [--vex <disp.json>] [--emit-vex <openvex.json>]
//   node scripts/security/vex-gate.mjs --verify-only     # só re-verifica as disposições (offline, sem rede)
// Saída: 0 aprovado · 2 REPROVADO · 1 erro de uso.
import { readFileSync, readdirSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ_PADRAO = fileURLToPath(new URL("../../", import.meta.url));
const VEX_PADRAO = "scripts/security/vex-dispositions.json";

/** O vocabulário de justificativa do OpenVEX é FECHADO. Inventar um valor faz a ferramenta do adotante
 *  ignorar o documento EM SILÊNCIO — e aí o ruído que o VEX existia para calar volta inteiro. */
const JUSTIFICATIVAS = new Set([
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
]);

const STATUS = new Set(["not_affected", "affected", "fixed", "under_investigation"]);

/** Acima deste EPSS um advisory não disposto reprova mesmo sem ser CRÍTICO: é probabilidade de exploração
 *  medida, não opinião. Nesta árvore só um advisory passa do teto (o SSRF de upgrade do Next, 0.39) — e ele
 *  é exatamente o que tem disposição. Ou seja: o gate nasce verde POR CAUSA do VEX, não apesar dele. */
const EPSS_TETO_PADRAO = 0.1;

function args(argv) {
  const o = {
    root: RAIZ_PADRAO,
    report: null,
    vex: null,
    emitVex: null,
    json: false,
    failOn: "critical",
    epss: EPSS_TETO_PADRAO,
    now: null,
    verifyOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") o.root = argv[++i];
    else if (a === "--report") o.report = argv[++i];
    else if (a === "--vex") o.vex = argv[++i];
    else if (a === "--emit-vex") o.emitVex = argv[++i];
    else if (a === "--fail-on") o.failOn = String(argv[++i]).toLowerCase();
    else if (a === "--epss") o.epss = Number(argv[++i]);
    else if (a === "--now") o.now = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--verify-only") o.verifyOnly = true;
  }
  return o;
}

/** `pkg:npm/%40escopo/a@1.0.0` → `@escopo/a@1.0.0` (a chave que o relatório usa em `components`). */
function chaveDePurl(purl) {
  const m = /^pkg:npm\/(.+)@([^@]+)$/.exec(purl);
  if (!m) return null;
  return `${decodeURIComponent(m[1])}@${m[2]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação de forma. Uma disposição malformada NUNCA é ignorada com aviso: ela invalida e reprova. Aviso é
// o que transforma gate em relatório, e relatório ninguém lê no dia do push.
// ─────────────────────────────────────────────────────────────────────────────
function validar(st) {
  if (typeof st?.vulnerability !== "string" || !st.vulnerability.trim()) return "campo `vulnerability` ausente";
  if (!Array.isArray(st.products) || !st.products.length) return "campo `products` vazio — disposição sem alvo";
  for (const p of st.products) {
    if (typeof p !== "string" || !chaveDePurl(p)) return `produto não é purl npm com versão: ${JSON.stringify(p)}`;
  }
  if (!STATUS.has(st.status)) return `status fora do vocabulário OpenVEX: ${JSON.stringify(st.status)}`;
  if (st.justification !== undefined && !JUSTIFICATIVAS.has(st.justification)) {
    return `justification fora do vocabulário OpenVEX: ${JSON.stringify(st.justification)}`;
  }
  if (typeof st.impact_statement !== "string" || st.impact_statement.trim().length < 8) {
    return "campo `impact_statement` ausente — a disposição precisa dizer POR QUE, em prosa";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(st.reviewedAt ?? "")) return "campo `reviewedAt` ausente ou não é AAAA-MM-DD";

  if (st.status === "not_affected") {
    if (!JUSTIFICATIVAS.has(st.justification)) return "`not_affected` exige `justification` do vocabulário OpenVEX";
    if (!Array.isArray(st.evidence) || !st.evidence.length) {
      return "`not_affected` sem evidência verificável — afirmar não é provar";
    }
    for (const e of st.evidence) {
      if (!VERIFICADORES[e?.kind]) return `tipo (kind) de evidência não implementado: ${JSON.stringify(e?.kind)}`;
    }
  }
  if (st.status === "affected") {
    if (typeof st.mitigation !== "string" || st.mitigation.trim().length < 8) {
      return "`affected` exige `mitigation` descrita";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(st.expiresAt ?? "")) {
      return "`affected` exige `expiresAt` (AAAA-MM-DD) — mitigação sem prazo é dívida eterna";
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verificadores de evidência. Cada um devolve `null` (confere) ou o motivo pelo qual a prova caiu.
// ─────────────────────────────────────────────────────────────────────────────
const EXT_CODIGO = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"]);

/** Sítios de import de um especificador EXATO. Casa `require("x")`, `from "x"`, `import("x")` — e não casa
 *  `"x/sub"` nem `"xy"`, senão a evidência acusaria importador onde não há. */
function importaEspecificador(texto, spec) {
  const s = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:require\\(|import\\(|from\\s*)\\s*["'](${s})["']`).test(texto);
}

/** Um `.d.ts` é declaração de tipo: apagado na compilação, nunca executa. Um `*.test.*` não viaja no
 *  artefato. A afirmação de alcançabilidade é sobre CÓDIGO QUE RODA em produção, então incluir os dois só
 *  produziria falso-positivo — e, no caso dos testes, o próprio teste desta cadeia (que carrega
 *  `require("hono")` dentro de uma string de fixture) invalidaria a evidência que ele existe para provar. */
function ignorado(nome) {
  return nome.endsWith(".d.ts") || /\.(test|spec)\.[cm]?[jt]sx?$/.test(nome);
}

/**
 * Resolve um `scanDir` da forma `node_modules/<pkg>/<sub>` para um diretório REAL, sob qualquer
 * layout de gerenciador. Devolve `null` quando o pacote não está na árvore — que é o caso em que a
 * disposição de fato não pode ser medida, e aí o fail-closed é o veredito certo.
 *
 * Três tentativas, da mais literal para a mais robusta:
 *   1. o caminho como escrito (layout HOISTED — o do umbrella hoje);
 *   2. o mesmo caminho pelo REALPATH (layout isolado: o lógico é symlink para `.bun/<pkg>@<hash>/`);
 *   3. resolução por NOME do pacote a partir da raiz, e daí o subcaminho.
 * A (3) é a que sobrevive a `.bun/`, a `.pnpm/` e a workspaces — nenhuma delas garante que
 * `node_modules/<pkg>` exista como diretório de verdade.
 */
function resolverScanDir(repoRoot, scanDir) {
  const literal = path.join(repoRoot, scanDir);
  try {
    if (statSync(literal).isDirectory()) return literal;
  } catch {
    /* segue para as próximas tentativas */
  }
  try {
    const real = realpathSync(literal);
    if (statSync(real).isDirectory()) return real;
  } catch {
    /* segue */
  }
  // `node_modules/@escopo/pkg/sub…` ou `node_modules/pkg/sub…`
  const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/?(.*)$/.exec(scanDir.split(path.sep).join("/"));
  if (!m) return null;
  const [, pacote, sub] = m;

  // Resolução por `require` NÃO serve, e as duas razões foram medidas no repo extraído:
  //   · da RAIZ dá MODULE_NOT_FOUND — o pacote é dependência do workspace, não da raiz;
  //   · do PACOTE dá ERR_PACKAGE_PATH_NOT_EXPORTED — o `exports` do módulo não expõe
  //     `./package.json`, e resolver pelo `main` falharia em todo pacote que não tem um.
  // Então procuramos o DIRETÓRIO, nos lugares onde os gerenciadores de fato o põem.
  const candidatos = [];
  const push = (...p) => candidatos.push(path.join(...p));
  push(repoRoot, "node_modules", pacote);
  // workspaces: a dependência costuma pousar no node_modules do pacote que a declara
  try {
    for (const w of readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })) {
      if (w.isDirectory()) push(repoRoot, "packages", w.name, "node_modules", pacote);
    }
  } catch {
    /* sem packages/ — repo de pacote único */
  }
  // layouts ISOLADOS: bun (`.bun/<pkg>@<ver>+<hash>/node_modules/<pkg>`) e pnpm (`.pnpm/<pkg>@<ver>/…`).
  // O nome do diretório carrega versão e hash, então casamos por PREFIXO do nome do pacote.
  for (const store of [".bun", ".pnpm"]) {
    const dir = path.join(repoRoot, "node_modules", store);
    let entradas;
    try {
      entradas = readdirSync(dir);
    } catch {
      continue;
    }
    const prefixo = `${pacote.replace("/", "+")}@`;
    const prefixoAlt = `${pacote}@`;
    for (const e of entradas) {
      if (e.startsWith(prefixo) || e.startsWith(prefixoAlt)) push(dir, e, "node_modules", pacote);
    }
  }

  for (const c of candidatos) {
    const alvo = sub ? path.join(c, sub) : c;
    try {
      const real = realpathSync(alvo);
      if (statSync(real).isDirectory()) return real;
    } catch {
      /* próximo candidato */
    }
  }
  return null;
}

function arquivosDe(dir, base = dir, acc = []) {
  let entradas;
  try {
    entradas = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entradas) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) arquivosDe(abs, base, acc);
    else if (EXT_CODIGO.has(path.extname(e.name)) && !ignorado(e.name)) acc.push(path.relative(base, abs));
  }
  return acc;
}

const VERIFICADORES = {
  /** A prova é uma LINHA de código que precisa continuar existindo. É a forma mais forte de justificativa:
   *  mudar o código derruba a disposição no mesmo commit. */
  code_invariant(ev, ctx) {
    if (typeof ev.file !== "string" || typeof ev.mustContain !== "string") {
      return "code_invariant exige `file` e `mustContain`";
    }
    const abs = path.join(ctx.repoRoot, ev.file);
    let texto;
    try {
      texto = readFileSync(abs, "utf8");
    } catch {
      return `arquivo da evidência ausente: ${ev.file}`;
    }
    // Compara ignorando espaço em volta para não quebrar por reformatação do prettier — mas o TEXTO do
    // invariante tem de estar lá: é ele que carrega a semântica que a disposição afirma.
    return texto.includes(ev.mustContain) ? null : `invariante ausente em ${ev.file}: \`${ev.mustContain}\``;
  },

  /** A prova é "os únicos importadores deste pacote vivem em <globs>". Importador NOVO fora do escopo
   *  significa que o pacote entrou no caminho de execução — e a disposição morre com ele. */
  importers_confined_to(ev, ctx) {
    if (typeof ev.scanDir !== "string" || typeof ev.specifier !== "string" || !Array.isArray(ev.allow)) {
      return "importers_confined_to exige `scanDir`, `specifier` e `allow[]`";
    }
    // `scanDir` é escrito como `node_modules/<pkg>/<sub>` — um caminho que só existe se o gerenciador
    // HOISTOU o pacote para a raiz. No umbrella isso é verdade e a disposição parecia portátil; num
    // `bun install` limpo (layout ISOLADO, que põe o pacote em `node_modules/.bun/<pkg>@<hash>/` e
    // deixa um symlink no lugar lógico) o literal NÃO resolve, e as 10 disposições viravam
    // `staleStatements` — fail-closed correto, veredito errado. MEDIDO no repo extraído em 2026-08-06.
    //
    // Terceira aparição da mesma classe no mesmo dia: o resolvedor privado do `oss-license.test.ts`
    // parava nos symlinks e media 30 de 684 pacotes, e o `check-licenses.mjs` aprovava fecho vazio.
    // Caminho LÓGICO não é caminho REAL sob layout isolado — resolva pelo nome do pacote.
    const base = resolverScanDir(ctx.repoRoot, ev.scanDir);
    if (!base) {
      // Fail-CLOSED: sem a árvore para medir, a prova não foi feita. Tratar como "confere" seria assinar
      // um laudo sem exame — e é assim que a disposição sobrevive à remoção do pacote que ela descrevia.
      return `scanDir ausente (evidência não pôde ser medida): ${ev.scanDir}`;
    }
    const foraDoEscopo = [];
    for (const rel of arquivosDe(base)) {
      const norm = rel.split(path.sep).join("/");
      if (ev.allow.some((p) => norm.startsWith(p))) continue;
      let texto;
      try {
        texto = readFileSync(path.join(base, rel), "utf8");
      } catch {
        continue;
      }
      if (importaEspecificador(texto, ev.specifier)) foraDoEscopo.push(norm);
    }
    if (!foraDoEscopo.length) return null;
    return `importador de \`${ev.specifier}\` fora do escopo declarado: ${foraDoEscopo.slice(0, 5).join(", ")}`;
  },

  /**
   * A prova é uma AUSÊNCIA dentro de um arquivo: "este `next.config.js` NÃO configura `remotePatterns`",
   * "nenhum rewrite aponta para um host externo". É a forma que a maior parte das disposições de framework
   * exige, porque o que torna o produto imune não é uma linha escrita — é uma linha que ninguém escreveu.
   *
   * Ausência é o terreno natural do VÁCUO-VERDE, e por isso o fail-closed aqui é mais estrito que nos
   * outros verificadores: arquivo que não abre REPROVA (sem o texto não houve exame, e "não achei o padrão
   * porque não achei o arquivo" é o laudo sem paciente), e regex inválida REPROVA na entrada, em vez de
   * virar uma busca que nunca casa e aprova tudo para sempre.
   */
  code_absent(ev, ctx) {
    if (typeof ev.file !== "string" || typeof ev.mustNotMatch !== "string") {
      return "code_absent exige `file` e `mustNotMatch`";
    }
    let re;
    try {
      re = new RegExp(ev.mustNotMatch, "m");
    } catch (e) {
      return `mustNotMatch não é uma regex válida: ${String(e?.message ?? e)}`;
    }
    const abs = path.join(ctx.repoRoot, ev.file);
    let texto;
    try {
      texto = readFileSync(abs, "utf8");
    } catch {
      return `arquivo da evidência ausente: ${ev.file}`;
    }
    const m = re.exec(texto);
    return m
      ? `o que a disposição afirma AUSENTE apareceu em ${ev.file}: ${JSON.stringify(m[0].slice(0, 120))}`
      : null;
  },

  /**
   * A mesma prova de ausência, sobre uma ÁRVORE inteira: "nenhum arquivo sob `src/app` declara
   * `runtime = 'edge'`". Serve ao caso em que a feature vulnerável se liga em QUALQUER arquivo, e olhar só
   * um não provaria nada.
   *
   * Três travas, e a terceira é a que este repositório já pagou para aprender: (1) diretório que não
   * resolve REPROVA; (2) varredura que não visitou arquivo NENHUM reprova — um laço que não itera termina
   * sem achado e sai como "limpo", que é o vácuo-verde clássico; (3) o `allow[]` é prefixo de caminho, para
   * um diretório de exemplos poder ser excluído SEM abrir a árvore inteira.
   */
  tree_absent(ev, ctx) {
    if (typeof ev.scanDir !== "string" || typeof ev.mustNotMatch !== "string") {
      return "tree_absent exige `scanDir` e `mustNotMatch`";
    }
    const allow = ev.allow ?? [];
    if (!Array.isArray(allow)) return "tree_absent: `allow` precisa ser lista de prefixos";
    let re;
    try {
      re = new RegExp(ev.mustNotMatch, "m");
    } catch (e) {
      return `mustNotMatch não é uma regex válida: ${String(e?.message ?? e)}`;
    }
    const base = resolverScanDir(ctx.repoRoot, ev.scanDir);
    if (!base) return `scanDir ausente (evidência não pôde ser medida): ${ev.scanDir}`;
    const encontrados = [];
    let visitados = 0;
    for (const rel of arquivosDe(base)) {
      const norm = rel.split(path.sep).join("/");
      if (allow.some((p) => norm.startsWith(p))) continue;
      let texto;
      try {
        texto = readFileSync(path.join(base, rel), "utf8");
      } catch {
        continue;
      }
      visitados += 1;
      if (re.test(texto)) encontrados.push(norm);
    }
    if (!visitados) return `varredura VAZIA em ${ev.scanDir} — zero arquivos lidos, logo nada foi provado`;
    if (!encontrados.length) return null;
    return `o que a disposição afirma AUSENTE está em ${ev.scanDir}: ${encontrados.slice(0, 5).join(", ")}`;
  },

  /**
   * A prova é que um CAMINHO não existe — o jeito de afirmar "este app não tem Pages Router" ou "não há
   * diretório de rotas legadas". É a evidência mais frágil do arquivo e por isso a única que exige uma
   * ÂNCORA: um caminho irmão que TEM de existir.
   *
   * Sem a âncora, rodar o gate a partir da raiz errada faria TODO caminho "não existir" e a disposição
   * passaria por acidente — a mesma classe do `scanDir` que não resolvia e virava veredito errado.
   */
  path_absent(ev, ctx) {
    if (typeof ev.path !== "string" || typeof ev.anchor !== "string") {
      return "path_absent exige `path` e `anchor` (o irmão que prova que a raiz está certa)";
    }
    try {
      statSync(path.join(ctx.repoRoot, ev.anchor));
    } catch {
      return `âncora ausente (${ev.anchor}) — a raiz medida não é a árvore que a disposição descreve`;
    }
    try {
      statSync(path.join(ctx.repoRoot, ev.path));
    } catch {
      return null;
    }
    return `o caminho que a disposição afirma INEXISTENTE existe: ${ev.path}`;
  },

  /** A prova é "o advisory é de outra plataforma". Se o advisory for reescrito e a marca de plataforma
   *  sair, a premissa mudou e a disposição precisa de revisão HUMANA — não de renovação automática. */
  platform_not_applicable(ev, ctx) {
    if (typeof ev.advisoryMustMention !== "string" || typeof ev.deploymentPlatform !== "string") {
      return "platform_not_applicable exige `advisoryMustMention` e `deploymentPlatform`";
    }
    if (ev.deploymentPlatform.toLowerCase() === ev.advisoryMustMention.toLowerCase()) {
      return `plataforma de deploy É a plataforma vulnerável (${ev.deploymentPlatform})`;
    }
    const adv = ctx.advisories?.get(ctx.vulnerability);
    if (!adv) return { unverifiable: "depende do relatório de advisories (rode sem --verify-only)" };
    const texto = `${adv.summary ?? ""}\n${adv.detailsExcerpt ?? ""}`.toLowerCase();
    return texto.includes(ev.advisoryMustMention.toLowerCase())
      ? null
      : `o advisory não menciona mais \`${ev.advisoryMustMention}\` — a premissa de plataforma mudou`;
  },
};

function verificar(st, ctx) {
  const problemas = [];
  const naoVerificaveis = [];
  for (const ev of st.evidence ?? []) {
    const r = VERIFICADORES[ev.kind](ev, { ...ctx, vulnerability: st.vulnerability });
    if (r === null) continue;
    if (typeof r === "object" && r.unverifiable) naoVerificaveis.push(`${ev.kind}: ${r.unverifiable}`);
    else problemas.push(String(r));
  }
  return { problemas, naoVerificaveis };
}

// ─────────────────────────────────────────────────────────────────────────────
export function avaliar({ report, vex, repoRoot, now, failOn = "critical", epssTeto = EPSS_TETO_PADRAO }) {
  const hoje = now ? new Date(`${now}T00:00:00Z`) : new Date();
  const advisories = new Map((report?.advisories ?? []).map((a) => [a.id, a]));

  const invalidStatements = [];
  const staleStatements = [];
  const expiredStatements = [];
  const obsoleteStatements = [];
  const unverifiedWithoutReport = [];
  /** `advisoryId` → Set<chave de componente coberta> */
  const cobertura = new Map();
  const notAffected = new Set();
  const mitigated = new Set();

  for (const st of vex?.statements ?? []) {
    const erro = validar(st);
    if (erro) {
      invalidStatements.push({ vulnerability: st?.vulnerability ?? "(sem id)", reason: erro });
      continue;
    }
    const { problemas, naoVerificaveis } = verificar(st, { repoRoot, advisories });
    if (problemas.length) {
      staleStatements.push({ vulnerability: st.vulnerability, reason: problemas.join(" | ") });
      continue;
    }
    if (naoVerificaveis.length) {
      unverifiedWithoutReport.push({ vulnerability: st.vulnerability, reason: naoVerificaveis.join(" | ") });
    }
    if (st.status === "affected" && new Date(`${st.expiresAt}T23:59:59Z`) < hoje) {
      expiredStatements.push(st.vulnerability);
      continue;
    }
    // Disposição que não corresponde a nada do relatório é RUÍDO acumulado: reportada para poder ser
    // removida, e não silenciosamente carregada para sempre.
    if (report && !advisories.has(st.vulnerability)) {
      obsoleteStatements.push(st.vulnerability);
      continue;
    }
    const alvo = cobertura.get(st.vulnerability) ?? new Set();
    for (const p of st.products) alvo.add(chaveDePurl(p));
    cobertura.set(st.vulnerability, alvo);
    if (st.status === "not_affected") notAffected.add(st.vulnerability);
    if (st.status === "affected") mitigated.add(st.vulnerability);
    if (st.status === "fixed") notAffected.add(st.vulnerability);
  }

  // KEV e MAL- são insuprimíveis: nenhuma disposição os cobre, por desenho.
  const unsuppressable = (report?.advisories ?? [])
    .filter((a) => a.kev === true || a.id.startsWith("MAL-"))
    .map((a) => a.id)
    .sort();

  const undisposed = [];
  const undisposedProducts = new Set();
  for (const a of report?.advisories ?? []) {
    const cobertos = cobertura.get(a.id);
    const faltando = (a.components ?? []).filter((c) => !cobertos?.has(c));
    if (!cobertos || faltando.length) {
      undisposed.push(a.id);
      for (const c of faltando) undisposedProducts.add(c);
    }
  }

  const barra = (a) => {
    if (a.severity === "CRITICAL") return true;
    if (typeof a.epss === "number" && a.epss >= epssTeto) return true;
    if (failOn === "high") return a.severity === "HIGH" || a.severity === "CRITICAL";
    if (failOn === "moderate") return ["HIGH", "CRITICAL", "MODERATE"].includes(a.severity);
    return false;
  };
  const escalated = undisposed
    .map((id) => advisories.get(id))
    .filter((a) => a && barra(a))
    .map((a) => a.id)
    .sort();

  // Lote de consulta falhado é REPROVA: um relatório curto por falha de rede é indistinguível de uma
  // árvore limpa, e é a hora em que a confiança falsa custa mais.
  const failedBatches = report?.failedBatches ?? [];

  // MESMO argumento, aplicado à medição do KEV: sem o catálogo da CISA o `osv-query` marca `kev: null` em
  // todo advisory, `unsuppressable` sai VAZIO e uma disposição comum volta a cobrir exploração ativa
  // registrada. Isto IMPEDE que o controle mais forte do gate — o insuprimível — desapareça em silêncio no
  // dia em que a rede oscilar. Só vale com relatório: `--verify-only` não mede KEV e não finge que mediu.
  //
  // A régua é `!== true` (medição PROVADA) e não `=== false` (negativa explícita): um relatório que apenas
  // OMITE o campo — produtor de versão anterior, arquivo montado à mão, schema do produtor mudado — reabria o
  // furo inteiro, porque "não medi" era lido como "medi e estava tudo bem". Ausência de má notícia não é
  // notícia boa, e é a porta mais barata que existe para calar o insuprimível.
  const kevCatalogUnavailable = report ? report.kevCatalogAvailable !== true : false;

  // A garantia do insuprimível é por ADVISORY (o filtro é `kev === true`), então a afirmação global do
  // relatório não basta: um advisory com `kev` não-booleano NÃO foi medido, e um relatório que jura catálogo
  // disponível carregando `kev: null` afirma no mesmo arquivo que mediu e que não mediu. Isto IMPEDE que a
  // palavra do relatório sobre a própria completude substitua o dado — o advisory sem medição não volta a
  // poder ser calado por disposição comum. (Redundante com a trava acima quando o catálogo caiu inteiro; a
  // que importa é a falha PARCIAL, que a afirmação global não descreve.)
  const kevUnmeasuredAdvisories = kevCatalogUnavailable
    ? []
    : (report?.advisories ?? [])
        .filter((a) => typeof a.kev !== "boolean")
        .map((a) => a.id)
        .sort();

  const ok =
    !invalidStatements.length &&
    !staleStatements.length &&
    !expiredStatements.length &&
    !unsuppressable.length &&
    !escalated.length &&
    !failedBatches.length &&
    !kevCatalogUnavailable &&
    !kevUnmeasuredAdvisories.length;

  return {
    target: report?.target ?? null,
    ok,
    notAffected: [...notAffected].sort(),
    mitigated: [...mitigated].sort(),
    undisposed: undisposed.sort(),
    undisposedProducts: [...undisposedProducts].sort(),
    escalated,
    unsuppressable,
    staleStatements,
    invalidStatements,
    expiredStatements: expiredStatements.sort(),
    obsoleteStatements: obsoleteStatements.sort(),
    unverifiedWithoutReport,
    failedBatches,
    kevCatalogUnavailable,
    kevUnmeasuredAdvisories,
    counts: {
      advisories: report?.advisories?.length ?? 0,
      disposed: notAffected.size + mitigated.size,
    },
  };
}

/** O artefato que o adotante consome: OpenVEX 0.2.0. */
export function montarOpenVex(vex, veredito) {
  const vivos = new Set([...veredito.notAffected, ...veredito.mitigated]);
  return {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": "https://github.com/kapstanhq/agileharness/.well-known/openvex.json",
    author: vex.author ?? "AgileHarness maintainers",
    role: "document",
    version: 1,
    statements: (vex.statements ?? [])
      .filter((st) => vivos.has(st.vulnerability))
      .map((st) => ({
        vulnerability: { name: st.vulnerability },
        products: st.products.map((p) => ({ "@id": p })),
        status: st.status,
        ...(st.justification ? { justification: st.justification } : {}),
        impact_statement: st.impact_statement,
        ...(st.mitigation ? { action_statement: st.mitigation } : {}),
      })),
  };
}

function imprimir(v) {
  const l = [];
  l.push(v.ok ? "✓ SCA aprovado" : "✗ SCA REPROVADO");
  if (v.target) l.push(`  alvo: ${v.target} — ${v.counts.advisories} advisories, ${v.counts.disposed} dispostos`);
  const bloco = (t, xs, fmt = (x) => x) => {
    if (!xs?.length) return;
    l.push(`  ${t}:`);
    for (const x of xs) l.push(`    - ${fmt(x)}`);
  };
  bloco("disposições INVÁLIDAS", v.invalidStatements, (s) => `${s.vulnerability}: ${s.reason}`);
  bloco("disposições DESATUALIZADAS (evidência não confere)", v.staleStatements, (s) => `${s.vulnerability}: ${s.reason}`);
  bloco("mitigações VENCIDAS", v.expiredStatements);
  bloco("INSUPRIMÍVEIS (KEV / pacote malicioso)", v.unsuppressable);
  bloco("não dispostos acima da barra", v.escalated);
  bloco("lotes de consulta falhados", v.failedBatches, (b) => `${b.from}+${b.size}: ${b.error}`);
  if (v.kevCatalogUnavailable) {
    l.push("  catálogo CISA KEV INDISPONÍVEL ou não medido (campo ausente no relatório) — sem ele nenhum");
    l.push("  advisory é insuprimível; re-rode a consulta");
  }
  bloco("advisories SEM medição de KEV (relatório se contradiz)", v.kevUnmeasuredAdvisories);
  bloco("disposições OBSOLETAS (remover)", v.obsoleteStatements);
  bloco("não verificável sem relatório", v.unverifiedWithoutReport, (s) => `${s.vulnerability}: ${s.reason}`);
  process.stderr.write(`${l.join("\n")}\n`);
}

function main() {
  const o = args(process.argv.slice(2));
  const raiz = path.resolve(o.root);
  const vexFile = path.resolve(o.vex ?? path.join(raiz, VEX_PADRAO));
  let vex;
  try {
    vex = JSON.parse(readFileSync(vexFile, "utf8"));
  } catch (e) {
    process.stderr.write(`vex-gate: não consegui ler as disposições em ${vexFile}: ${e.message}\n`);
    return 1;
  }
  if (!o.report && !o.verifyOnly) {
    process.stderr.write("vex-gate: informe --report <osv.json> ou --verify-only\n");
    return 1;
  }
  let report = null;
  if (o.report) {
    try {
      report = JSON.parse(readFileSync(path.resolve(o.report), "utf8"));
    } catch (e) {
      process.stderr.write(`vex-gate: não consegui ler o relatório: ${e.message}\n`);
      return 1;
    }
  }

  const veredito = avaliar({ report, vex, repoRoot: raiz, now: o.now, failOn: o.failOn, epssTeto: o.epss });
  if (o.emitVex) {
    mkdirSync(path.dirname(path.resolve(o.emitVex)), { recursive: true });
    writeFileSync(o.emitVex, `${JSON.stringify(montarOpenVex(vex, veredito), null, 2)}\n`, "utf8");
  }
  if (o.json) process.stdout.write(`${JSON.stringify(veredito, null, 2)}\n`);
  else imprimir(veredito);
  return veredito.ok ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
