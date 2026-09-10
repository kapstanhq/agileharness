// O CHOKEPOINT ÚNICO de leitura de dado de board não-confiável — frontmatter de card (.md), board.yaml
// e o frontmatter do design/style-guide.md. Existe porque este pacote vai ser publicado como OSS: no
// dia da extração nasce uma FRONTEIRA (um contribuidor externo manda bytes num PR, o mantenedor dá
// `git pull`, o board relê por mtime), e o processo que relê roda como root.
//
// O invariante é: TODO parse de bytes que vivem em `storymap/boards/**` passa por aqui. Ele vale para
// as DUAS bibliotecas de parse, e os dois lints no fim de frontmatter.test.ts o provam
// mecanicamente: nenhum módulo de `src/` chama `matter(...)` (gray-matter) NEM `yaml.load(...)`
// (js-yaml) sobre bytes de board fora deste arquivo. O lint de `matter(` sozinho era insuficiente —
// dois sítios vivos (`style-guide.ts` e `config-cockpit.ts`) parseavam board com `yaml.load` SEM teto
// e a suíte ficava verde, porque o lint não conhecia a outra biblioteca.
//
// O QUE ESTES CONTROLES IMPEDEM
//
// 1. EXECUÇÃO DE CÓDIGO (story-c5uhes). O gray-matter registra um engine `javascript` que faz
//    `eval(str)` no bloco de frontmatter (node_modules/gray-matter/lib/engines.js:36-43), escolhido
//    quando a linguagem declarada depois do delimitador é `js`/`javascript` (lib/engine.js:14-18 casa
//    o alias). Um card que abre com `---js` executava código no processo do servidor ao ser LIDO —
//    sem clique, sem deploy. Provado com PoC (`EVAL EXECUTOU? SIM`).
//
//    ⚠️ ARMADILHA: passar `{language:'yaml'}` NÃO protege. O gray-matter SOBRESCREVE a language com o
//    token que vem depois do delimitador (index.js:85-90) — `---js` vence a opção. O PoC confirma:
//    com `{language:'yaml'}` o eval AINDA executa. O que funciona é INJETAR engines que LANÇAM, porque
//    `lib/defaults.js:16` faz `Object.assign({}, engines, opts.parsers, opts.engines)` — o engine do
//    CHAMADOR ganha do embutido. Aqui há DOIS controles independentes: a recusa de qualquer token de
//    linguagem ANTES de o gray-matter ver os bytes (modelo positivo: só YAML sem token é aceito) e os
//    engines venenosos como cinto-e-suspensório (se algum dia um delimitador exótico furar a 1ª porta).
//
//    ⚠️ ARMADILHA 2 — BOM: um `<U+FEFF>---js` FURAVA a 1ª porta. O gray-matter remove o BOM (`to-file.js` →
//    `strip-bom-string`) ANTES de procurar o delimitador, então ele casava `---js` enquanto a porta,
//    olhando a string original, via um 1º caractere que não é `-` e liberava. O RCE ficava seguro só
//    pela 2ª camada. Normalizado em `LEADING_INVISIBLE` — e há teste de BOM nas DUAS camadas, para a
//    redundância ser INTENCIONAL e documentada, não acidental.
//
// 2. DoS POR PARSE (story-t9k1jf). Duas classes, ambas medidas:
//    - VOLUME: um card de 500MB era lido inteiro para a memória e parseado. Teto de bytes ANTES do
//      parse — e, onde o chamador tem `stat` (repo.ts), `assertStatWithinByteCap` recusa ANTES do READ:
//      o teto sobre a string só protege o parser, porque a string já está na memória.
//    - ALIAS BOMB (billion laughs): 443 bytes de YAML com âncoras aninhadas parseiam em 4ms (o js-yaml
//      compartilha referências, não copia) e explodem para >10^9 nós na primeira travessia a jusante —
//      `JSON.stringify`, o safeParse do Zod, o coerce, o SSE. O teto de BYTES não pega isso; o que pega
//      é uma travessia PRÓPRIA e ORÇADA (nós + profundidade) feita aqui, antes de o objeto tocar
//      qualquer código. Medido: cap de 5M nós leva 231ms, então o orçamento real (20k) aborta em ~0ms.
//
// 3. SEQUESTRO DE PROTÓTIPO. O js-yaml devolve `__proto__` como chave PRÓPRIA e enumerável; um
//    `Object.assign({}, data)` a jusante usa [[Set]] e o setter de `Object.prototype.__proto__` troca o
//    protótipo do alvo. Chave proibida = recusa, não remoção silenciosa (o objeto nunca chega ao código).
//
// 4. FALHA SILENCIOSA. Erro de parse virava `{}`/`null` sem nome: um board.yaml corrompido resolvia
//    como pipeline vazia, um frontmatter escalar virava card-lixo. Aqui TODA recusa é uma
//    {@link FrontmatterError} com `reason` — dá para logar, contar e distinguir ataque de arquivo torto.
//
// NÃO-OBJETIVO (deliberado): unificar os dois parsers de YAML. O frontmatter de card continua sendo
// parseado pelo engine do PRÓPRIO gray-matter (js-yaml 3.14.2 `safeLoad`, YAML 1.1: `yes`/`no` são
// booleanos, ISO sem quotes vira Date) e o board.yaml pelo js-yaml 4.1.1 do app (YAML 1.2). Trocar um
// pelo outro "para limpar" mudaria em silêncio como 394 cards parseiam. Ambos os loaders JÁ recusam as
// tags que instanciam código (`!!js/function`, `!!js/eval`, `!!js/regexp` → "unknown tag") — o schema
// seguro é o default nos dois, e frontmatter.test.ts trava isso contra um bump futuro de dependência.

import matter from "gray-matter";
import yaml from "js-yaml";

/** Por que o parse foi RECUSADO. Nomeado para o log distinguir ataque (`engine-forbidden`,
 *  `too-many-nodes`) de arquivo simplesmente torto (`invalid-yaml`). */
export type FrontmatterRejection =
  | "engine-forbidden" // frontmatter pediu um engine que executa código (---js / ---javascript / ---toml…)
  | "too-large" // bytes acima do teto — nunca chegou ao parser
  | "invalid-yaml" // YAML malformado (o loader lançou)
  | "not-a-map" // documento válido mas não é um mapa (escalar/lista) — não é card nem board
  | "too-deep" // aninhamento acima do teto
  | "too-many-nodes" // orçamento de nós estourado (alias bomb)
  | "forbidden-key"; // chave que sequestra protótipo (__proto__/constructor/prototype)

/** A recusa de um parse de dado de board. SEMPRE lançada — nunca devolvemos `{}` por erro. */
export class FrontmatterError extends Error {
  readonly reason: FrontmatterRejection;
  readonly label: string;
  constructor(reason: FrontmatterRejection, detail: string, label = "frontmatter") {
    super(`[frontmatter:${reason}] ${label}: ${detail}`);
    this.name = "FrontmatterError";
    this.reason = reason;
    this.label = label;
  }
}

/** Descreve a recusa para log/finding quando o erro pode ser qualquer coisa (catch genérico). */
export function describeFrontmatterError(err: unknown): string {
  if (err instanceof FrontmatterError) return `${err.reason}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// Tetos: folga larga sobre o dado REAL medido em 2026-07-29 (394 cards + 5 board.yaml) para que
// nenhum controle vire atrito — o maior card tem 55KB / 375 nós / profundidade 6; o maior board.yaml,
// 557 nós / profundidade 6. Todos overrideáveis por env: um board gigante é problema do operador
// resolver com um knob, não motivo para o servidor recusar trabalho legítimo.
export const FRONTMATTER_MAX_BYTES_DEFAULT = 2 * 1024 * 1024; // ~37× o maior card real
export const FRONTMATTER_MAX_DEPTH_DEFAULT = 32; // ~5× a profundidade real
export const FRONTMATTER_MAX_NODES_DEFAULT = 20_000; // ~36× o maior documento real

/** Lê os tetos do ambiente A CADA chamada (não no import) — um knob de operador precisa valer sem
 *  restart do módulo, e o teste precisa poder apertá-lo sem recarregar o arquivo. */
export function frontmatterLimits(): { maxBytes: number; maxDepth: number; maxNodes: number } {
  return {
    maxBytes: positiveEnv("AGILEHARNESS_FRONTMATTER_MAX_BYTES", FRONTMATTER_MAX_BYTES_DEFAULT),
    maxDepth: positiveEnv("AGILEHARNESS_FRONTMATTER_MAX_DEPTH", FRONTMATTER_MAX_DEPTH_DEFAULT),
    maxNodes: positiveEnv("AGILEHARNESS_FRONTMATTER_MAX_NODES", FRONTMATTER_MAX_NODES_DEFAULT),
  };
}

function positiveEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Chaves que, vindas de fora, transformam um `Object.assign`/deep-merge a jusante em troca de
 *  protótipo. Nenhum card ou board.yaml legítimo declara qualquer uma delas. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Engines que EXECUTAM (ou executariam) conteúdo do arquivo. Registrados como parsers que lançam:
 *  `defaults.js:16` deixa o engine do chamador vencer o embutido, então isto DESARMA o `eval` do
 *  gray-matter em vez de apenas evitá-lo. `coffee`/`cson`/`toml` hoje só dariam "engine not
 *  registered" (erro genérico); nomeá-los aqui garante recusa NOMEADA e imuniza contra uma versão
 *  futura do gray-matter que passe a registrá-los. */
const FORBIDDEN_ENGINE_LANGUAGES = ["javascript", "js", "coffee", "coffeescript", "cson", "toml"] as const;

const FORBIDDEN_ENGINES: Record<string, () => never> = Object.fromEntries(
  FORBIDDEN_ENGINE_LANGUAGES.map((lang) => [
    lang,
    () => {
      throw new FrontmatterError(
        "engine-forbidden",
        `o frontmatter pediu o engine "${lang}", que interpreta o arquivo como código`,
      );
    },
  ]),
);

/** As opções que TODA chamada a `matter()` deste repo usa. Passar um objeto de options também
 *  DESLIGA o cache global do gray-matter (`index.js:37-48` só cacheia quando `options` é falsy) —
 *  esse cache é keyed pelo CONTEÚDO INTEIRO do arquivo e nunca é podado, então o serviço de longa
 *  duração retinha uma cópia de cada versão de cada card já lido. Medido: 0 chaves com options.
 *
 *  EXPORTADO para o teste poder exercitar a 2ª camada SOZINHA (sem a 1ª porta). Uma camada de defesa
 *  em profundidade que só é testada ATRAVÉS da outra é uma camada que ninguém sabe se ainda funciona:
 *  foi assim que o furo do BOM (abaixo) chegou a existir sem nenhum teste vermelho. */
export const SAFE_MATTER_OPTIONS = Object.freeze({
  language: "yaml",
  engines: FORBIDDEN_ENGINES,
});

export interface ParsedFrontmatter {
  /** O mapa de frontmatter — auditado (mapa, dentro dos tetos, sem chave proibida). */
  data: Record<string, unknown>;
  /** O corpo depois do frontmatter, verbatim (nunca parseado). */
  content: string;
}

/**
 * Parseia o frontmatter de um arquivo de board (card .md) — O ÚNICO caminho permitido.
 * LANÇA {@link FrontmatterError} em qualquer recusa; nunca devolve mapa vazio por erro.
 *
 * @param raw   conteúdo do arquivo
 * @param label identificação para o log (`<board>/<card>.md`, `<ref>:<path>`…)
 */
export function parseFrontmatter(raw: string, label = "card"): ParsedFrontmatter {
  const limits = frontmatterLimits();
  assertWithinByteCap(raw, label, limits.maxBytes);
  assertNoLanguageToken(raw, label);

  let file: { data?: unknown; content?: unknown };
  try {
    file = matter(raw, SAFE_MATTER_OPTIONS) as { data?: unknown; content?: unknown };
  } catch (err) {
    // Uma FrontmatterError já é nomeada (veio dos engines venenosos) — repassa. Qualquer outra coisa
    // é o loader YAML reclamando: converte para recusa NOMEADA, para nenhum chamador ver um erro cru.
    if (err instanceof FrontmatterError) throw err;
    throw new FrontmatterError("invalid-yaml", describeFrontmatterError(err), label);
  }

  const data = assertPlainMap(file.data ?? {}, label);
  auditParsedTree(data, label, limits);
  return { data, content: typeof file.content === "string" ? file.content : "" };
}

/**
 * Parseia um documento YAML de board (`board.yaml`, `_base/board.yaml`) sob os MESMOS tetos.
 * Documento vazio → `{}` (mapa vazio é legítimo). Não-mapa → recusa `not-a-map`, em vez do
 * `as Record<string, unknown>` silencioso de antes, que resolvia como pipeline vazia.
 */
export function parseYamlMap(raw: string, label = "board.yaml"): Record<string, unknown> {
  const limits = frontmatterLimits();
  assertWithinByteCap(raw, label, limits.maxBytes);

  let parsed: unknown;
  try {
    // `schema` explícito: o default do js-yaml 4 JÁ é o seguro (não há `load` inseguro), mas cravar o
    // schema documenta a exigência e sobrevive a uma mudança de default num bump de dependência.
    parsed = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA });
  } catch (err) {
    throw new FrontmatterError("invalid-yaml", describeFrontmatterError(err), label);
  }
  if (parsed == null) return {}; // arquivo vazio / só comentários — mapa vazio legítimo
  const data = assertPlainMap(parsed, label);
  auditParsedTree(data, label, limits);
  return data;
}

function assertWithinByteCap(raw: string, label: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > maxBytes) {
    throw new FrontmatterError("too-large", `${bytes} bytes acima do teto de ${maxBytes}`, label);
  }
}

/**
 * O MESMO teto, aplicado ao TAMANHO DO ARQUIVO (`stat.size`) — para o chamador recusar ANTES de ler.
 *
 * O que este controle impede: o teto do parse recebe uma string que o chamador JÁ materializou
 * (`fs.readFile`), então ele protege o PARSER, não o READ — um card de 500MB era carregado inteiro
 * para a memória e só então recusado, ou seja, o DoS de VOLUME acontecia antes da recusa. Com o stat
 * antes do read, o conteúdo hostil nunca entra no processo.
 *
 * `size` ausente (o `stat` falhou) NÃO recusa: a falta do sinal não pode virar recusa de trabalho
 * legítimo, e o teto do parse continua sendo o backstop para esse caso.
 *
 * O QUE FICA DE FORA (honestidade sobre o alcance): `repo.ts` (cards, board.yaml, `_base`) já recusa
 * antes de ler. Faltam DOIS chamadores, ambos com o mesmo remédio pendente:
 *  - `runner/engine.ts` (`readFileSync` do card no spawn) — dá para fechar igual, com `statSync` antes;
 *  - `runner/merge-queue.ts` (o frontmatter vem do STDOUT de um `git show`) — aqui o stat não existe;
 *    o teto ali só pode vir de um limite de buffer no spawn (`maxBuffer`), senão o volume entra na
 *    memória antes de qualquer checagem. Enquanto isso, o teto do parse é a única barreira nesse ponto.
 */
export function assertStatWithinByteCap(size: number | undefined | null, label: string): void {
  if (typeof size !== "number" || !Number.isFinite(size)) return;
  const { maxBytes } = frontmatterLimits();
  if (size > maxBytes) {
    throw new FrontmatterError(
      "too-large",
      `arquivo de ${size} bytes acima do teto de ${maxBytes} — recusado ANTES de ser lido`,
      label,
    );
  }
}

/**
 * Invisíveis que um editor/exportador cola ANTES do primeiro byte útil. O gray-matter REMOVE o BOM
 * (`lib/to-file.js` → `lib/utils.js:toString` → `strip-bom-string`) **antes** de procurar o
 * delimitador, então para ele `<U+FEFF>---js` é `---js` — e o alias `js` escolhe o engine que faz
 * `eval`. Sem normalizar aqui, a 1ª porta olhava uma string que começa com o BOM (não com `---`),
 * concluía "não abre frontmatter" e liberava o payload: o RCE ficava seguro APENAS pelos engines
 * venenosos da 2ª camada. Provado com PoC.
 *
 * Só invisíveis de largura zero entram na lista — `\n`, espaço e tab NÃO, porque o gray-matter também
 * não os remove: um arquivo que começa com eles não abre frontmatter para ele, e recusá-lo aqui seria
 * ser mais agressivo que a biblioteca, rejeitando markdown legítimo (o mesmo cuidado da régua `----`).
 * Os demais zero-width entram por precaução contra um `strip-bom-string` futuro mais abrangente: um
 * card cujo primeiro caractere é um zero-width seguido de `---js` não é conteúdo legítimo de board.
 */
// Por CODEPOINT, nunca pelo caractere literal: um invisível literal no fonte é invisível também para
// quem revisa o diff (e sobrevive a um copy-paste que o remove sem ninguém ver) — a lista tem de ser
// LEGÍVEL. BOM · BOM trocado (UTF-16 ao contrário) · ZWSP/ZWNJ/ZWJ · LRM/RLM · word-joiner.
const LEADING_INVISIBLE_CODEPOINTS = [0xfeff, 0xfffe, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060];
const LEADING_INVISIBLE = new RegExp(`^[${LEADING_INVISIBLE_CODEPOINTS.map((c) => String.fromCodePoint(c)).join("")}]+`);

/**
 * Recusa QUALQUER token de linguagem depois do delimitador de abertura — o modelo positivo: só
 * `---` puro (YAML) entra. Roda ANTES de o gray-matter tocar os bytes, então o `eval` do engine
 * `javascript` nunca é sequer alcançado. Espelha a regra do gray-matter para `----` (index.js:77:
 * um quarto traço não é delimitador, é régua de markdown) para não recusar um .md legítimo.
 *
 * EXPORTADO para o teste poder provar esta camada SOZINHA: end-to-end o `---js` com BOM já era
 * recusado pelos engines venenosos, então um teste só de `parseFrontmatter` ficaria VERDE com a 1ª
 * porta furada — e a defesa em profundidade viraria defesa única sem ninguém notar.
 */
export function assertNoLanguageToken(raw: string, label: string): void {
  // Normaliza para a MESMA string que o gray-matter vai ver (ele tira o BOM), senão a checagem
  // examina bytes diferentes dos que escolhem o engine.
  const text = raw.replace(LEADING_INVISIBLE, "");
  const brk = text.search(/\r?\n/);
  const firstLine = brk === -1 ? text : text.slice(0, brk);
  if (!firstLine.startsWith("---")) return; // não abre frontmatter na 1ª linha
  if (firstLine.charAt(3) === "-") return; // `----…` não é delimitador (regra do próprio gray-matter)
  const token = firstLine.slice(3).trim();
  if (token) {
    throw new FrontmatterError(
      "engine-forbidden",
      `delimitador declara a linguagem "${token}"; só frontmatter YAML (\`---\`) é aceito`,
      label,
    );
  }
}

function assertPlainMap(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw new FrontmatterError("not-a-map", `documento é ${describeShape(value)}, não um mapa`, label);
  }
  return value as Record<string, unknown>;
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "uma lista";
  if (value instanceof Date) return "uma data";
  return typeof value;
}

/**
 * UMA travessia orçada do objeto já parseado, antes de ele tocar qualquer código: profundidade,
 * número de nós e chaves proibidas. Iterativa (pilha explícita) para não depender do tamanho da
 * pilha do V8, e o orçamento de nós é o que impede a alias bomb — um grafo de 443 bytes cuja
 * expansão tem 10^9 nós aborta aqui em ~0ms em vez de derrubar o processo no primeiro
 * `JSON.stringify`/`safeParse` a jusante.
 */
function auditParsedTree(root: Record<string, unknown>, label: string, limits: { maxDepth: number; maxNodes: number }): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== "object" || value instanceof Date) continue;
    if (depth >= limits.maxDepth) {
      throw new FrontmatterError("too-deep", `aninhamento acima do teto de ${limits.maxDepth} níveis`, label);
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new FrontmatterError("forbidden-key", `chave "${key}" sequestra o protótipo do objeto`, label);
      }
      if (++nodes > limits.maxNodes) {
        throw new FrontmatterError(
          "too-many-nodes",
          `mais de ${limits.maxNodes} nós (âncoras/aliases YAML expandem além do teto)`,
          label,
        );
      }
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
}
