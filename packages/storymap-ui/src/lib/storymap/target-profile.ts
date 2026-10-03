// O PERFIL DO ALVO — como ESTE repositório roda os próprios checks e onde ficam as regras dele. PURO.
//
// POR QUE EXISTE: as skills e a tool `run_check` diziam ao agente COMO o repositório de origem trabalha —
// qual executor chamar para os testes e em que arquivo ler as regras de teste. Num repositório que usa outro executor, ou
// guarda as regras noutro lugar, a instrução manda rodar um comando que não existe e ler um arquivo que não há. A
// ferramenta não pode supor o ferramental de quem a adota.
//
// O QUE O ALVO DECLARA, em `storymap/settings.yaml` → `target:` (o canal do OPERADOR: versionado e sob o gate de código,
// diferente de `board.yaml`, que agentes editam — por isso um comando daqui pode ser executado):
//   • `checks` — o comando de cada verificação pelo NOME que as skills pedem (`test`, `testUnit`, `e2e`, `typecheck`,
//     `validate`, `smoke`…);
//   • `dev`    — subir e derrubar o ambiente de desenvolvimento (`up`, `down`);
//   • `docs`   — onde ficam as regras que o agente lê antes de agir (`conventions`, `testing`, `security`,
//     `devEnvironment`, `ops`…).
// Nos três, `{pkg}` é o nome do pacote do board (o último segmento de `board.yaml package`), `{package}` o caminho
// inteiro e `{board}` o id do board — o mesmo perfil serve a todos os boards do repositório.
//
// SEM PERFIL nada quebra: as skills dizem «descubra o comando nas instruções do repositório» em vez de inventar um.
//
// ── O ESQUEMA COMPLETO DO CANAL DO OPERADOR (lote D) ────────────────────────────────────────────────────────────
// Além de checks/dev/docs, o `target:` declara o resto do que a ferramenta NÃO pode supor do repositório:
//   • `currency`     — a moeda dos tetos/projeções de custo (ISO 4217 + locale opcional);
//   • `reviewLenses` — o vocabulário das lentes de revisão além das embutidas (CORE_REVIEW_LENSES);
//   • `layout`       — onde ficam os workspaces e os pacotes (globs relativos à raiz);
//   • `qa`           — portas, sondas de saúde e classes de falha do ambiente de teste deste alvo.
// E, FORA do `target:` (porque já têm casa própria no settings.yaml): `deploy:` (lançadores, receitas, comandos do
// caminho diff-aware, prova — ver deploy-policy.ts), `vps:` (limite semanal e medidor — ver vps-settings.ts) e
// `autorun.maxBudgetUSD` (já existia). O que é POLÍTICA POR BOARD (a moeda do teto, as classes do dono) segue no board.yaml.
//
// REGRAS DE TODA PEÇA DAQUI (a mesma filosofia de `coerceTargetProfile`):
//   1. TOLERANTE: descarta peça a peça o que não tem forma, NUNCA lança — o settings.yaml é o arquivo que segura o
//      serviço de pé; um typo num campo não derruba autorun, gate e tokens junto;
//   2. NÃO SILENCIOSA: cada descarte vira UMA linha de aviso (`coerceTargetProfileDetailed` devolve a lista; o
//      `coerceTargetProfile` a escreve no log). Descarte calado é como uma capacidade parece ligada e não está;
//   3. ENTRADA HOSTIL: texto livre daqui vira prompt, argv ou nome de arquivo — então só entra o que tem FORMA
//      (slug, caminho relativo, URL de loopback, argv sem shell), com limite de tamanho e sem caractere de controle;
//   4. «NÃO DECLARADO» É EXPLÍCITO: as funções `*Of` devolvem vazio/undefined, NUNCA um default do repositório de origem.
//
// Os valores QUENTES (relidos a cada `loadRunnerConfig()`, memoizado por mtime do arquivo): todos os blocos `target:`.
// Os BOOT-FIXED continuam sendo só `autorun.staging.*` (a fila do train lê uma vez ao construir).

/** A frase canônica de «sem declaração»: a instrução que as skills e as tools dão quando o alvo não declarou o comando. */
export const DISCOVER_COMMAND_HINT = "descubra o comando nas instruções do repositório";

/** O perfil como o alvo o declarou (moldes, ainda com `{pkg}`/`{package}`/`{board}`). */
export interface TargetProfile {
  checks: Record<string, string>;
  dev: Record<string, string>;
  docs: Record<string, string>;
  /** a moeda dos tetos e projeções de custo. Ausente ⇒ nenhuma moeda suposta (ver currency.ts). */
  currency?: TargetCurrency;
  /** lentes de revisão declaradas além das embutidas (ou sobrescrevendo o rótulo/revisor das embutidas). */
  reviewLenses?: Record<string, DeclaredReviewLens>;
  /** onde ficam workspaces e pacotes. Ausente ⇒ a ferramenta lê o `package.json` do próprio alvo. */
  layout?: TargetLayout;
  /** o ambiente de QA deste alvo. Ausente ⇒ nenhuma porta, sonda ou classe de falha própria. */
  qa?: TargetQa;
}

/**
 * `target.currency`. O SÍMBOLO nunca vem do operador (texto livre que entra em mensagem persistida e em prompt é
 * superfície de injeção, e o ICU já sabe «R$», «$», «€»): vem de `Intl`. `neutralWrites` só importa na transição de
 * grafia dos campos de custo (quem lê chave legada continua escrevendo a legada até o operador virar isto).
 */
export interface TargetCurrency {
  /** ISO 4217, 3 letras maiúsculas, validado contra `Intl.supportedValuesOf("currency")`. */
  code: string;
  /** BCP 47 canonizado por `Intl.getCanonicalLocales`; ausente ⇒ quem formata usa o idioma da UI. */
  locale?: string;
  neutralWrites?: boolean;
}

/** A forma DECLARADA de uma lente. Para um id embutido todos os campos são opcionais (só sobrescrevem). */
export interface DeclaredReviewLens {
  name?: string;
  description?: string;
  /** slug de `.claude/agents/<slug>.md` — SAFE_SLUG; a existência do arquivo é sondada por quem usa. */
  agent?: string;
  /** quando engajar o revisor. */
  when?: string;
  /** a condição em que a lente é obrigatória (prosa cooperativa para a skill; não é um gate). */
  mandatoryWhen?: string;
}

/** Uma lente EFETIVA (embutida ou declarada, já mesclada). */
export interface ReviewLensEntry {
  id: string;
  name: string;
  description: string;
  agent?: string;
  when?: string;
  mandatoryWhen?: string;
  /** true quando o alvo a declarou (ou sobrescreveu); false para uma embutida intocada. */
  declared: boolean;
}

/** `target.layout` — globs RELATIVOS à raiz; segmentos literais e `*` (nunca `**`). */
export interface TargetLayout {
  /** os diretórios com `node_modules` próprio que precisam ser ligados a um worktree. */
  workspaces?: string[];
  /** os diretórios que são um PACOTE (a unidade de `board.yaml package`, de deploy sem board, de regen de snapshot). */
  packages?: string[];
}

/** Uma classe de falha do ambiente DO ALVO. A primeira que casar vence (antes do baseline universal). */
export interface TargetFailureRule {
  /** fonte da expressão regular, ≤ 200 caracteres, sem quantificador aninhado. */
  pattern: string;
  class: "infra" | "test" | "app";
  /** subconjunto de `i`, `m`, `s` (sem repetição); ausente ⇒ `i`. */
  flags?: string;
}

/** `target.qa`. Os limites existem para o custo (regex roda sobre texto de agente) e para a superfície de SSRF. */
export interface TargetQa {
  /** portas que a stack do alvo ocupa: texto de falha com `:<porta>` ⇒ ambiente; também reservadas ao dev server efêmero. */
  ports?: number[];
  /** sondas GET que a stack já de pé responde 2xx. Só loopback com porta, sem credencial. */
  health?: { name: string; url: string }[];
  /** sonda «seedado»: 2xx só quando o seed existe. */
  seeded?: { url: string };
  failureClasses?: TargetFailureRule[];
}

/** Quantos bytes FINAIS do texto de falha uma regra declarada pode ler (custo / ReDoS). */
export const QA_FAILURE_TEXT_TAIL_BYTES = 16 * 1024;

/** O perfil de UM board: os moldes já preenchidos. Um molde que não pôde ser preenchido não entra. */
export interface ResolvedTargetProfile {
  checks: Record<string, string>;
  dev: Record<string, string>;
  docs: Record<string, string>;
}

/** Os nomes que as skills pedem — a lista é DOCUMENTAÇÃO (um alvo pode declarar outros), não uma trava. */
export const KNOWN_CHECKS = ["test", "testUnit", "e2e", "typecheck", "lint", "validate", "build", "smoke"] as const;
export const KNOWN_DEV = ["up", "down"] as const;
export const KNOWN_DOCS = ["conventions", "testing", "security", "devEnvironment", "ops"] as const;

const KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const COMMAND_MAX = 300;
/** Um caminho relativo que pode ir VERBATIM para dentro de um prompt entre aspas: sem espaço, aspas, `$`, crase. */
const SAFE_PATH = /^[A-Za-z0-9._/{}-]+$/;
const SAFE_SLUG = /^[A-Za-z0-9._-]+$/;
const SAFE_REL = /^[A-Za-z0-9._/-]+$/;

/** Caractere de controle (C0, DEL e C1): quebraria uma linha de log/auditoria e não existe em declaração honesta. */
export const hasControlChar = (s: string): boolean =>
  [...s].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f);
  });
const hasControl = hasControlChar;

/** Um descarte: ONDE (o caminho no settings) e POR QUÊ. Vai para o log; nunca carrega o VALOR hostil. */
export interface TargetDiscard {
  path: string;
  why: string;
}

/** O texto que entra numa linha de log a partir de uma chave do YAML: uma linha só, curto, sem controle. */
const printable = (v: unknown): string => JSON.stringify(String(v).slice(0, 48));

type Discarder = (path: string, why: string) => void;

function coerceMap(raw: unknown, accept: (value: string) => boolean, path: string, discard: Discarder): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    discard(path, "deveria ser um mapa nome → texto");
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `${path}.${printable(key)}`;
    if (!KEY.test(key)) {
      discard(at, `nome fora da forma ${KEY}`);
      continue;
    }
    if (typeof value !== "string") {
      discard(at, "o valor não é texto");
      continue;
    }
    const v = value.trim();
    if (!v || v.length > COMMAND_MAX || hasControl(v) || !accept(v)) {
      discard(at, v ? "valor vazio, longo demais (> 300), com caractere de controle ou fora da forma aceita" : "valor vazio");
      continue;
    }
    out[key] = v;
  }
  return out;
}

/** Um caminho de documento aceitável: relativo, sem `..`, só caracteres que atravessam um prompt entre aspas. */
function isDocPath(v: string): boolean {
  return SAFE_PATH.test(v) && !v.startsWith("/") && !v.split("/").includes("..");
}

// ── currency ──────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ `new Intl.NumberFormat(l, { currency: "XXQ" })` NÃO lança em Node/Bun: um typo viraria uma moeda inventada que
// passa por válida. Por isso a validação é EXPLÍCITA, contra a lista que o ICU do runtime conhece.
let currencySet: Set<string> | null | undefined;
function supportedCurrencies(): Set<string> | null {
  if (currencySet !== undefined) return currencySet;
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    currencySet = typeof f === "function" ? new Set(f("currency")) : null;
  } catch {
    currencySet = null;
  }
  return currencySet;
}

/** Um código ISO 4217 válido: 3 letras MAIÚSCULAS e conhecido pelo runtime (sem lista disponível, só a forma). */
export function isCurrencyCode(v: unknown): v is string {
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) return false;
  const known = supportedCurrencies();
  return known ? known.has(v) : true;
}

/** Um locale BCP 47 canonizado, ou null. */
export function canonicalLocale(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 35 || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v)) return null;
  try {
    return Intl.getCanonicalLocales(v)[0] ?? null;
  } catch {
    return null;
  }
}

function coerceCurrency(raw: unknown, discard: Discarder): TargetCurrency | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    discard("target.currency", "deveria ser um mapa { code, locale? }");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (!isCurrencyCode(r.code)) {
    discard("target.currency.code", "exige o código ISO 4217 em MAIÚSCULAS e conhecido (ex.: USD, EUR, BRL) — a moeda inteira foi descartada");
    return undefined;
  }
  const out: TargetCurrency = { code: r.code };
  if (r.locale !== undefined) {
    const locale = canonicalLocale(r.locale);
    if (locale) out.locale = locale;
    else discard("target.currency.locale", "não é um locale BCP 47 (ex.: en-US, pt-BR)");
  }
  if (r.neutralWrites !== undefined) {
    if (typeof r.neutralWrites === "boolean") out.neutralWrites = r.neutralWrites;
    else discard("target.currency.neutralWrites", "deveria ser true ou false");
  }
  return out;
}

// ── reviewLenses ──────────────────────────────────────────────────────────────────────────────────────────────
/**
 * As lentes EMBUTIDAS — o vocabulário da PRÓPRIA ferramenta (o `harness-qa` grava `design`; o mecanismo minera
 * findings de `general`/`testing`/`security`), sempre válidas e nunca removíveis: o alvo só sobrescreve nome/revisor.
 * Nenhuma delas supõe um framework ou um banco: as lentes de domínio (acesso a dados, frontend…) são do ALVO.
 */
export const CORE_REVIEW_LENSES: readonly { id: string; name: string; description: string }[] = [
  { id: "security", name: "Segurança", description: "falhas de autenticação, autorização, exposição de dado, injeção e segredos" },
  { id: "testing", name: "Testes", description: "o critério de aceite está provado por um teste que falharia sem a mudança" },
  { id: "perf", name: "Performance", description: "custo de execução: consultas, laços, renderizações e payloads desnecessários" },
  { id: "general", name: "Revisão geral", description: "correção, código morto, duplicação e simplificação" },
  { id: "design", name: "Design", description: "aderência ao guia de estilo e ao desenho acordado do board" },
];
const CORE_LENS_IDS: ReadonlySet<string> = new Set(CORE_REVIEW_LENSES.map((l) => l.id));
const LENS_ID = /^[a-z][a-z0-9-]{0,31}$/;
const LENS_MAX = 24;

function lensText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max && !hasControl(t) ? t : null;
}

function coerceReviewLenses(raw: unknown, discard: Discarder): Record<string, DeclaredReviewLens> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    discard("target.reviewLenses", "deveria ser um mapa id → definição");
    return undefined;
  }
  const out: Record<string, DeclaredReviewLens> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `target.reviewLenses.${printable(id)}`;
    if (!LENS_ID.test(id)) {
      discard(at, `id fora da forma ${LENS_ID}`);
      continue;
    }
    if (Object.keys(out).length >= LENS_MAX) {
      discard(at, `mais de ${LENS_MAX} lentes — o excedente foi descartado`);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      discard(at, "deveria ser um mapa { name, description, agent?, when?, mandatoryWhen? }");
      continue;
    }
    const v = value as Record<string, unknown>;
    const def: DeclaredReviewLens = {};
    const name = lensText(v.name, 60);
    const description = lensText(v.description, 300);
    if (name) def.name = name;
    else if (v.name !== undefined) discard(`${at}.name`, "vazio, longo demais (> 60) ou com caractere de controle");
    if (description) def.description = description;
    else if (v.description !== undefined) discard(`${at}.description`, "vazio, longo demais (> 300) ou com caractere de controle");
    if (typeof v.agent === "string" && SAFE_SLUG.test(v.agent.trim()) && v.agent.trim().length <= 64) def.agent = v.agent.trim();
    else if (v.agent !== undefined) discard(`${at}.agent`, "deveria ser um slug (o nome de .claude/agents/<slug>.md)");
    for (const k of ["when", "mandatoryWhen"] as const) {
      const t = lensText(v[k], 300);
      if (t) def[k] = t;
      else if (v[k] !== undefined) discard(`${at}.${k}`, "vazio, longo demais (> 300) ou com caractere de controle");
    }
    // Uma lente NOVA precisa se explicar (a UI e o Inbox a mostram); uma embutida só sobrescreve.
    if (!CORE_LENS_IDS.has(id) && (!def.name || !def.description)) {
      discard(at, "uma lente que não é embutida exige name e description");
      continue;
    }
    if (Object.keys(def).length) out[id] = def;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── layout ────────────────────────────────────────────────────────────────────────────────────────────────────
const GLOB_MAX = 32;

/** Um glob de layout normalizado (sem `/` final), ou null: relativo, segmentos literais e `*`, nunca `**` nem `..`. */
function layoutGlob(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const g = v.trim().replace(/\/+$/, "");
  if (!g || g.length > 120 || hasControl(g) || g.startsWith("/") || g.includes("\\") || g.includes("**")) return null;
  const segs = g.split("/");
  return segs.every((seg) => seg !== ".." && seg !== "." && /^[A-Za-z0-9._*-]+$/.test(seg)) ? g : null;
}

function coerceGlobList(raw: unknown, path: string, discard: Discarder): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    discard(path, "deveria ser uma lista de globs relativos à raiz");
    return undefined;
  }
  const out: string[] = [];
  raw.forEach((item, i) => {
    const g = layoutGlob(item);
    if (!g) discard(`${path}[${i}]`, "glob fora da forma (relativo, segmentos literais ou `*`, sem `**`, sem `..`, ≤ 120)");
    else if (out.length >= GLOB_MAX) discard(`${path}[${i}]`, `mais de ${GLOB_MAX} globs — o excedente foi descartado`);
    else if (!out.includes(g)) out.push(g);
  });
  // `[]` literal é uma declaração («nenhum»); uma lista da qual NADA sobrou é «não declarado» (nunca vira `[]`).
  return raw.length === 0 || out.length ? out : undefined;
}

function coerceLayout(raw: unknown, discard: Discarder): TargetLayout | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    discard("target.layout", "deveria ser um mapa { workspaces?, packages? }");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: TargetLayout = {};
  const workspaces = coerceGlobList(r.workspaces, "target.layout.workspaces", discard);
  const packages = coerceGlobList(r.packages, "target.layout.packages", discard);
  if (workspaces) out.workspaces = workspaces;
  if (packages) out.packages = packages;
  for (const k of Object.keys(r)) if (k !== "workspaces" && k !== "packages") discard(`target.layout.${printable(k)}`, "chave desconhecida (as conhecidas: workspaces, packages)");
  return Object.keys(out).length ? out : undefined;
}

// ── qa ────────────────────────────────────────────────────────────────────────────────────────────────────────
const QA_PORTS_MAX = 32;
const QA_HEALTH_MAX = 8;
const QA_RULES_MAX = 40;
const QA_PATTERN_MAX = 200;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Uma URL que o SERVIÇO pode buscar sem virar SSRF: http(s) em LOOPBACK, com porta explícita e sem credencial.
 * A sonda só enxerga a rede do host; uma stack que o agente sobe dentro da jaula não é visível dali.
 */
export function isLoopbackUrlWithPort(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 200 || /[\s\u0000-\u001f\u007f]/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname) && u.port !== "" && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Detecta o padrão de explosão exponencial mais comum: um grupo que CONTÉM um quantificador e é ele mesmo
 * quantificado — `(a+)+`, `(\w*)*`, `(a{1,5})+`. É uma heurística (não prova ausência de ReDoS: `(a|a)*` passa), e por
 * isso o texto avaliado também é truncado (QA_FAILURE_TEXT_TAIL_BYTES) por quem executa as regras.
 */
export function hasNestedQuantifier(src: string): boolean {
  const stack: boolean[] = [];
  let inClass = false;
  const brace = (at: number) => /^\{\d+,\d*\}/.test(src.slice(at));
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") stack.push(false);
    else if (c === ")") {
      const had = stack.pop() ?? false;
      const next = src[i + 1];
      if (had && (next === "+" || next === "*" || (next === "{" && brace(i + 1)))) return true;
      if (had && stack.length) stack[stack.length - 1] = true;
    } else if ((c === "+" || c === "*" || (c === "{" && brace(i))) && stack.length) stack[stack.length - 1] = true;
  }
  return false;
}

function coerceQa(raw: unknown, discard: Discarder): TargetQa | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    discard("target.qa", "deveria ser um mapa { ports?, health?, seeded?, failureClasses? }");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: TargetQa = {};

  if (r.ports !== undefined) {
    if (!Array.isArray(r.ports)) discard("target.qa.ports", "deveria ser uma lista de portas inteiras (1–65535)");
    else {
      const ports: number[] = [];
      r.ports.forEach((p, i) => {
        if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) discard(`target.qa.ports[${i}]`, "não é uma porta inteira entre 1 e 65535");
        else if (ports.length >= QA_PORTS_MAX) discard(`target.qa.ports[${i}]`, `mais de ${QA_PORTS_MAX} portas — o excedente foi descartado`);
        else if (!ports.includes(p)) ports.push(p);
      });
      if (ports.length) out.ports = ports;
    }
  }

  if (r.health !== undefined) {
    if (!Array.isArray(r.health)) discard("target.qa.health", "deveria ser uma lista de { name, url }");
    else {
      const health: { name: string; url: string }[] = [];
      r.health.forEach((h, i) => {
        const at = `target.qa.health[${i}]`;
        const o = h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : null;
        if (!o || typeof o.name !== "string" || !KEY.test(o.name)) discard(at, `exige name na forma ${KEY}`);
        else if (!isLoopbackUrlWithPort(typeof o.url === "string" ? o.url.trim() : o.url)) discard(at, "a url deve ser http(s) em loopback (127.0.0.1, localhost, [::1]) com porta e sem credencial");
        else if (health.length >= QA_HEALTH_MAX) discard(at, `mais de ${QA_HEALTH_MAX} sondas — o excedente foi descartado`);
        else if (health.some((x) => x.name === o.name)) discard(at, "name repetido");
        else health.push({ name: o.name, url: (o.url as string).trim() });
      });
      if (health.length) out.health = health;
    }
  }

  if (r.seeded !== undefined) {
    const o = r.seeded && typeof r.seeded === "object" && !Array.isArray(r.seeded) ? (r.seeded as Record<string, unknown>) : null;
    const url = typeof o?.url === "string" ? o.url.trim() : o?.url;
    if (isLoopbackUrlWithPort(url)) out.seeded = { url };
    else discard("target.qa.seeded", "exige { url } http(s) em loopback com porta e sem credencial");
  }

  if (r.failureClasses !== undefined) {
    if (!Array.isArray(r.failureClasses)) discard("target.qa.failureClasses", "deveria ser uma lista de { pattern, class, flags? }");
    else {
      const rules: TargetFailureRule[] = [];
      r.failureClasses.forEach((item, i) => {
        const at = `target.qa.failureClasses[${i}]`;
        const o = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
        const pattern = typeof o?.pattern === "string" ? o.pattern : "";
        const cls = o?.class;
        if (!o || !pattern || pattern.length > QA_PATTERN_MAX || hasControl(pattern)) discard(at, `pattern vazio, longo demais (> ${QA_PATTERN_MAX}) ou com caractere de controle`);
        else if (cls !== "infra" && cls !== "test" && cls !== "app") discard(at, "class deve ser infra, test ou app");
        else if (rules.length >= QA_RULES_MAX) discard(at, `mais de ${QA_RULES_MAX} regras — o excedente foi descartado`);
        else {
          const flags = o.flags === undefined ? undefined : typeof o.flags === "string" && /^[ims]{1,3}$/.test(o.flags) && new Set(o.flags).size === o.flags.length ? o.flags : null;
          if (flags === null) discard(at, "flags deve ser um subconjunto de i, m, s sem repetição");
          else if (hasNestedQuantifier(pattern)) discard(at, "quantificador aninhado (risco de explosão exponencial) — reescreva sem `(…+)+`");
          else {
            try {
              new RegExp(pattern, flags ?? "i");
              rules.push({ pattern, class: cls, ...(flags ? { flags } : {}) });
            } catch {
              discard(at, "pattern não é uma expressão regular válida");
            }
          }
        }
      });
      if (rules.length) out.failureClasses = rules;
    }
  }

  for (const k of Object.keys(r)) if (!["ports", "health", "seeded", "failureClasses"].includes(k)) discard(`target.qa.${printable(k)}`, "chave desconhecida (as conhecidas: ports, health, seeded, failureClasses)");
  return Object.keys(out).length ? out : undefined;
}

/** As chaves que o `target:` conhece. Uma outra (um typo, ou `deploy`, que mora FORA do `target:`) é avisada. */
const TARGET_KEYS = ["checks", "dev", "docs", "currency", "reviewLenses", "layout", "qa"] as const;

/**
 * O bloco `target:` do settings, tolerante, COM a lista do que foi descartado: chave fora da forma, valor que não é
 * texto, comando com caractere de controle, documento com caminho absoluto / `..` / caractere que não atravessa um
 * prompt, moeda desconhecida, glob com `**`, regex com quantificador aninhado… são DESCARTADOS (os outros seguem).
 * Sem nada aproveitável devolve `profile: undefined` — o alvo simplesmente não declarou perfil. PURA.
 */
export function coerceTargetProfileDetailed(raw: unknown): { profile: TargetProfile | undefined; discarded: TargetDiscard[] } {
  const discarded: TargetDiscard[] = [];
  const discard: Discarder = (path, why) => discarded.push({ path, why });
  if (raw === undefined || raw === null) return { profile: undefined, discarded };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    discard("target", "deveria ser um mapa — o bloco inteiro foi descartado");
    return { profile: undefined, discarded };
  }
  const r = raw as Record<string, unknown>;
  const profile: TargetProfile = {
    checks: coerceMap(r.checks, () => true, "target.checks", discard),
    dev: coerceMap(r.dev, () => true, "target.dev", discard),
    docs: coerceMap(r.docs, isDocPath, "target.docs", discard),
  };
  const currency = coerceCurrency(r.currency, discard);
  const reviewLenses = coerceReviewLenses(r.reviewLenses, discard);
  const layout = coerceLayout(r.layout, discard);
  const qa = coerceQa(r.qa, discard);
  if (currency) profile.currency = currency;
  if (reviewLenses) profile.reviewLenses = reviewLenses;
  if (layout) profile.layout = layout;
  if (qa) profile.qa = qa;
  for (const k of Object.keys(r)) {
    if ((TARGET_KEYS as readonly string[]).includes(k)) continue;
    discard(
      `target.${printable(k)}`,
      k === "deploy" ? "o deploy NÃO mora aqui: declare no bloco `deploy:` de topo do settings.yaml" : `chave desconhecida (as conhecidas: ${TARGET_KEYS.join(", ")})`,
    );
  }
  const empty =
    !Object.keys(profile.checks).length && !Object.keys(profile.dev).length && !Object.keys(profile.docs).length && !currency && !reviewLenses && !layout && !qa;
  return { profile: empty ? undefined : profile, discarded };
}

/** Escreve os descartes no log do serviço: UMA linha, sem o valor hostil. O fail-open fica como está (nada lança). */
export function warnTargetDiscards(discarded: readonly TargetDiscard[], log: (line: string) => void = (l) => console.warn(l)): void {
  if (!discarded.length) return;
  const shown = discarded.slice(0, 12).map((d) => `${d.path} (${d.why})`);
  const more = discarded.length > shown.length ? ` … e mais ${discarded.length - shown.length}` : "";
  log(`[storymap] settings target: ${discarded.length} entrada(s) DESCARTADA(s) por forma inválida — ${shown.join("; ")}${more}. O resto do bloco segue valendo.`);
}

/** O bloco `target:` tolerante, avisando no log o que foi descartado. Ver {@link coerceTargetProfileDetailed}. PURA salvo o log. */
export function coerceTargetProfile(raw: unknown, log?: (line: string) => void): TargetProfile | undefined {
  const { profile, discarded } = coerceTargetProfileDetailed(raw);
  warnTargetDiscards(discarded, log);
  return profile;
}

// ── as funções de resolução (o que os consumidores usam) ─────────────────────────────────────────────────────────
// Todas PURAS e todas devolvem «não declarado» explícito (undefined / vazio) — nunca o default do repositório de origem.

/** A moeda declarada pelo alvo, ou undefined. (Para a moeda de UM board, ver `resolveCurrency` em currency.ts.) */
export function currencyOf(target: TargetProfile | null | undefined): TargetCurrency | undefined {
  return target?.currency;
}

/** As lentes EFETIVAS: as embutidas (com a sobrescrita do alvo) e depois as declaradas. Sem `target`, só as embutidas. */
export function reviewLensesOf(target: TargetProfile | null | undefined): ReviewLensEntry[] {
  const declared = target?.reviewLenses ?? {};
  const out: ReviewLensEntry[] = CORE_REVIEW_LENSES.map((core) => {
    const d = declared[core.id];
    return {
      id: core.id,
      name: d?.name ?? core.name,
      description: d?.description ?? core.description,
      ...(d?.agent ? { agent: d.agent } : {}),
      ...(d?.when ? { when: d.when } : {}),
      ...(d?.mandatoryWhen ? { mandatoryWhen: d.mandatoryWhen } : {}),
      declared: !!d,
    };
  });
  for (const [id, d] of Object.entries(declared)) {
    if (CORE_LENS_IDS.has(id)) continue;
    out.push({ id, name: d.name ?? id, description: d.description ?? "", ...(d.agent ? { agent: d.agent } : {}), ...(d.when ? { when: d.when } : {}), ...(d.mandatoryWhen ? { mandatoryWhen: d.mandatoryWhen } : {}), declared: true });
  }
  return out;
}

/** Os ids de lente válidos para ESCRITA de um finding (leitura de um id antigo não é recusada por quem lê). */
export function reviewLensIdsOf(target: TargetProfile | null | undefined): string[] {
  return reviewLensesOf(target).map((l) => l.id);
}

/** A forma de um id de lente (para quem LÊ um id gravado antes da declaração e só precisa saber se é bem-formado). */
export const isReviewLensId = (v: unknown): v is string => typeof v === "string" && LENS_ID.test(v);

/** O que a resolução de layout lê do RunnerSettings (estrutural, para esta função continuar PURA e sem import de types). */
export interface LayoutSource {
  target?: TargetProfile;
  autorun?: { staging?: { branch?: string; codePrefixes?: readonly string[]; declared?: { branch?: boolean; codePrefixes?: boolean } } };
}

/** O layout resolvido. CADA campo ausente é «não declarado» (quem usa aplica a regra conservadora dele). */
export interface ResolvedLayout {
  /** `target.layout.workspaces`; undefined ⇒ ler o `workspaces` do package.json do alvo. */
  workspaces?: string[];
  /** `target.layout.packages`; undefined ⇒ o workspace mais raso que contém o arquivo. */
  packages?: string[];
  /** `autorun.staging.branch` quando o arquivo o declarou; undefined ⇒ `DEFAULT_STAGING_BRANCH` (a convenção da ferramenta). */
  stagingBranch?: string;
  /** `autorun.staging.codePrefixes` quando o arquivo o declarou (inclusive `[]` = «nada é código»); undefined ⇒ tudo fora de storymap/boards/ é código. */
  codePrefixes?: string[];
}

export function layoutOf(settings: LayoutSource | null | undefined): ResolvedLayout {
  const st = settings?.autorun?.staging;
  const l = settings?.target?.layout;
  return {
    ...(l?.workspaces ? { workspaces: [...l.workspaces] } : {}),
    ...(l?.packages ? { packages: [...l.packages] } : {}),
    ...(st?.declared?.branch && st.branch ? { stagingBranch: st.branch } : {}),
    ...(st?.declared?.codePrefixes && st.codePrefixes ? { codePrefixes: [...st.codePrefixes] } : {}),
  };
}

/** O QA resolvido: listas vazias e sem `seeded` quando o alvo não declarou nada (`declared` diz qual é o caso). */
export interface ResolvedQa {
  declared: boolean;
  ports: number[];
  health: { name: string; url: string }[];
  seeded?: { url: string };
  failureClasses: TargetFailureRule[];
}

export function qaOf(target: TargetProfile | null | undefined): ResolvedQa {
  const q = target?.qa;
  return {
    declared: !!q,
    ports: [...(q?.ports ?? [])],
    health: (q?.health ?? []).map((h) => ({ ...h })),
    ...(q?.seeded ? { seeded: { ...q.seeded } } : {}),
    failureClasses: (q?.failureClasses ?? []).map((f) => ({ ...f })),
  };
}

/**
 * A primeira classe de falha DECLARADA que casa com o texto (ou undefined). O texto é truncado nos últimos
 * {@link QA_FAILURE_TEXT_TAIL_BYTES} caracteres — o custo de uma regex sobre texto de agente tem teto. Regra que não
 * compila é pulada (a coerção já a teria descartado; isto cobre um `RunnerSettings` montado à mão). PURA.
 */
export function matchDeclaredFailureClass(text: string, rules: readonly TargetFailureRule[] | undefined): TargetFailureRule["class"] | undefined {
  if (!rules?.length || !text) return undefined;
  const tail = text.length > QA_FAILURE_TEXT_TAIL_BYTES ? text.slice(-QA_FAILURE_TEXT_TAIL_BYTES) : text;
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern, rule.flags ?? "i").test(tail)) return rule.class;
    } catch {
      /* regra inválida: pulada */
    }
  }
  return undefined;
}

/** O que um board empresta aos moldes. */
export interface TargetScope {
  /** o id do board. */
  board: string;
  /** `board.yaml package` (o caminho do pacote), quando o board mapeia código. */
  package?: string | null;
}

/**
 * Preenche um molde. Devolve null quando ele pede um valor que o board não tem (`{pkg}` num board sem `package`) ou
 * que não é seguro para virar argumento / caminho — nunca um comando pela metade. PURA.
 */
export function expandTargetTemplate(template: string, scope: TargetScope): string | null {
  const pkgPath = scope.package && SAFE_REL.test(scope.package) && !scope.package.split("/").includes("..") ? scope.package.replace(/\/+$/, "") : null;
  const values: Record<string, string | null> = {
    board: SAFE_SLUG.test(scope.board) ? scope.board : null,
    package: pkgPath,
    pkg: pkgPath ? (pkgPath.split("/").pop() ?? null) : null,
  };
  let missing = false;
  const out = template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    if (!(name in values)) return whole; // chave que não é molde fica como está (um `{}` de quem escreveu o comando)
    const v = values[name];
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

/** O perfil de um board: cada molde preenchido; o que não pôde ser preenchido fica de fora. PURA. */
export function resolveTargetProfile(profile: TargetProfile | null | undefined, scope: TargetScope): ResolvedTargetProfile {
  const fill = (map: Record<string, string> | undefined, accept: (v: string) => boolean = () => true): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, template] of Object.entries(map ?? {})) {
      const v = expandTargetTemplate(template, scope);
      if (v && accept(v)) out[key] = v;
    }
    return out;
  };
  return { checks: fill(profile?.checks), dev: fill(profile?.dev), docs: fill(profile?.docs, (v) => SAFE_REL.test(v)) };
}

/**
 * O comando de um check, pronto para executar SEM shell: a lista de palavras. Null quando o check não foi declarado,
 * quando o molde não pôde ser preenchido para este board, ou quando o comando só faria sentido com um shell (pipe,
 * redireção, `&&`, `$(…)`): o operador que precisa disso declara um script do repositório. PURA.
 */
export function checkArgv(profile: TargetProfile | null | undefined, scope: TargetScope, check: string, parse: (cmd: string) => string[] | null): { argv: string[] } | { refusal: string } {
  const template = profile?.checks[check];
  if (!template) {
    const known = Object.keys(profile?.checks ?? {});
    return {
      refusal: known.length
        ? `o alvo não declara o check "${check}" — os declarados são: ${known.join(", ")} (storymap/settings.yaml → target.checks).`
        : `o alvo não declara nenhum check (storymap/settings.yaml → target.checks). Declare o comando lá — ou ${DISCOVER_COMMAND_HINT}.`,
    };
  }
  const cmd = expandTargetTemplate(template, scope);
  if (!cmd) return { refusal: `o check "${check}" usa {pkg}/{package}, e o board "${scope.board}" não mapeia um pacote (board.yaml → package).` };
  const argv = parse(cmd);
  if (!argv?.length) return { refusal: `o check "${check}" não é uma lista de palavras (tem sintaxe de shell: pipe, redireção, &&, $(…)). Declare um script do repositório e chame-o.` };
  return { argv };
}

const DOC_WORDS: Record<string, string> = {
  conventions: "convenções",
  testing: "testes",
  security: "segurança",
  devEnvironment: "ambiente de desenvolvimento",
  ops: "operação",
};

/**
 * A nota do perfil para o prompt de um agente — SEGURA para ir entre aspas num comando: só caminhos de documento (já
 * peneirados) e NOMES de check; o texto de um comando nunca é interpolado (ele tem aspas e `$`). Null sem perfil. PURA.
 *
 * SÓ AS CONVENÇÕES SÃO LEITURA OBRIGATÓRIA. Mandar ler TODO documento declarado antes de agir cobra a soma de todos
 * eles em TODO run headless — contexto que cresce com cada documento declarado e que a maioria dos runs nunca usa. Os
 * demais documentos vão por CAMINHO, «consulte quando o trabalho pedir»: o agente abre o de testes quando for testar e o
 * de segurança quando o diff tocar em segurança, e paga só por isso.
 */
export function targetProfileNote(resolved: ResolvedTargetProfile): string | null {
  const docEntries = Object.entries(resolved.docs);
  const must = docEntries.filter(([k]) => k === "conventions").map(([k, p]) => `${DOC_WORDS[k] ?? k}: ${p}`);
  const consult = docEntries.filter(([k]) => k !== "conventions").map(([k, p]) => `${DOC_WORDS[k] ?? k}: ${p}`);
  const checks = Object.keys(resolved.checks);
  const dev = Object.keys(resolved.dev);
  if (!docEntries.length && !checks.length && !dev.length) return null;
  const parts: string[] = [];
  if (must.length) parts.push(`leia antes de agir os documentos do alvo — ${must.join("; ")}`);
  if (consult.length) parts.push(`consulte quando o trabalho pedir (não precisa ler tudo antes) — ${consult.join("; ")}`);
  if (checks.length || dev.length) {
    parts.push(
      `os comandos deste repositório estão em storymap/settings.yaml, bloco target` +
        `${checks.length ? ` (checks: ${checks.join(", ")})` : ""}${dev.length ? ` (dev: ${dev.join(", ")})` : ""} — use-os em vez de supor um executor`,
    );
  }
  return `Perfil do alvo: ${parts.join(". ")}.`;
}
