#!/usr/bin/env node
// derivation-check — a árvore PÚBLICA carrega texto COPIADO das fontes privadas do operador?
//
// POR QUE EXISTE: o gate de publicação procura TERMOS que o operador listou. Ele não vê o que ninguém listou
// — e leituras independentes seguidas acharam, na árvore já publicada, exemplos de teste e fixtures que eram
// trechos de cards, de documentos e de configuração de um produto real (uma persona, um Lean Canvas, uma saída de deploy,
// perguntas de cards). A lista de termos crescia a cada leitura; a classe do problema continuava aberta.
//
// O QUE ELE MEDE: frases em comum. Cada arquivo de texto das fontes privadas vira janelas de N palavras seguidas
// (padrão 6); cada linha da árvore versionada é procurada nessas janelas. Uma janela em comum é uma frase copiada.
//
// A DIREÇÃO IMPORTA: as fontes privadas CITAM a ferramenta (um card guarda a mensagem de erro que ela escreveu). Então
// uma frase que também está no código de execução da ferramenta é texto DELA, não cópia — só conta como achado a frase
// que aparece em teste, fixture, skill ou documento e NÃO aparece no código de execução.
//
// O QUE ELE NÃO VÊ, dito aqui para ninguém confiar demais: a cópia com os substantivos trocados (a frase muda a cada 3–4
// palavras e nenhuma janela sobrevive). Para isso existem o vocabulário das fontes (`--names`, abaixo) e a leitura.
//
// VOCABULÁRIO (`--names`): os NOMES declarados nos `board.yaml` das fontes — personas, sistemas, etiquetas do canvas e
// as frases de posicionamento/métrica/resultado — procurados inteiros na árvore. Um nome de persona de um produto real
// num teste é derivação mesmo sem frase em comum.
//
// ACEITOS: a direção nem sempre se decide sozinha — a ferramenta MONTA frases em tempo de execução (um título de aviso
// feito de três pedaços) que só aparecem inteiras num teste e num card que as guardou. O operador confere e registra essas
// linhas em ~/.config/agileharness/oss-derivation-accepted (`arquivo<TAB>frase`, uma por linha, `#` comenta): elas saem
// dos achados. O arquivo fica FORA do repositório, como os termos privados — as frases dele vêm das fontes privadas.
//
// Uso:  node scripts/oss/derivation-check.mjs [--sources DIR[:DIR…]] [--window 6] [--names] [--all] [--json]
//   --sources  as fontes privadas; padrão: uma por linha em ~/.config/agileharness/oss-private-sources (ou $AH_OSS_PRIVATE_SOURCES)
//   --names    cruza também o vocabulário dos board.yaml das fontes
//   --require-sources  sem fonte declarada, reprova (2) em vez de sair 0 «sem medir» — é o que o ah-verify e o ah-publish usam
//   --all      lista também as frases que estão no código de execução (texto da própria ferramenta)
// Sem fontes declaradas: sai 0 dizendo que não mediu (quem não tem fontes privadas não tem o que cruzar).
// Saídas: 0 nada copiado (ou não mediu) · 3 há frase copiada · 2 uso.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXT = /\.(md|mdx|txt|ya?ml|json|jsonl|ts|tsx|js|mjs|cjs|sh)$/i;
const PRIVATE_EXT = /\.(md|mdx|txt|ya?ml|json)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", ".next", "dist", "build", ".worktrees", ".turbo", "coverage"]);
/** Onde uma frase em comum é ACHADO: o que a ferramenta escreve como exemplo, e não como mensagem dela. */
const EXAMPLE_PATH = /(\.test\.[cm]?[jt]sx?$|\.fixture\.[cm]?[jt]sx?$|(^|\/)__fixtures__\/|(^|\/)fixtures\/|\.md$|\.mdx$|\.snap$|(^|\/)\.claude\/skills\/)/;

/** As palavras de uma linha: minúsculas, sem pontuação nem marcação; números contam (um valor copiado é sinal). PURA. */
export function wordsOf(line) {
  return line
    .toLowerCase()
    .normalize("NFC")
    .replace(/[`*_~#>|()[\]{}"'“”«»‘’,;:!?…=<>\\/]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && /[\p{L}\p{N}]/u.test(w));
}

/** As janelas de `n` palavras seguidas de um texto, linha a linha (uma frase não atravessa a quebra de linha). PURA. */
export function shinglesOf(text, n) {
  const out = [];
  for (const line of text.split("\n")) {
    const w = wordsOf(line);
    for (let i = 0; i + n <= w.length; i += 1) out.push(w.slice(i, i + n).join(" "));
  }
  return out;
}

/** Uma janela só de palavras comuns ou de números não prova cópia: exige pelo menos 3 palavras de 5+ letras. PURA. */
export function isDistinctive(shingle) {
  return shingle.split(" ").filter((w) => w.length >= 5 && /\p{L}/u.test(w)).length >= 3;
}

function walk(dir, accept, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(full, accept, out);
    } else if (accept(full)) out.push(full);
  }
  return out;
}

const read = (file) => {
  try {
    const buf = fs.readFileSync(file);
    return buf.length > 2_000_000 || buf.includes(0) ? "" : buf.toString("utf8");
  } catch {
    return "";
  }
};

/**
 * O índice das fontes privadas: janela → onde ela aparece (a primeira ocorrência). `exclude` tira do índice o que a
 * própria árvore pública já distribui dentro das fontes (o molde e as skills que o alvo recebe da ferramenta).
 * @param {string[]} roots
 * @param {number} n
 * @param {(file: string) => boolean} [exclude]
 */
export function indexPrivate(roots, n, exclude = (_file) => false) {
  const index = new Map();
  for (const root of roots) {
    for (const file of walk(root, (f) => PRIVATE_EXT.test(f) && !exclude(f))) {
      const text = read(file);
      text.split("\n").forEach((line, at) => {
        const w = wordsOf(line);
        for (let i = 0; i + n <= w.length; i += 1) {
          const s = w.slice(i, i + n).join(" ");
          if (!index.has(s) && isDistinctive(s)) index.set(s, `${path.relative(root, file)}:${at + 1}`);
        }
      });
    }
  }
  return index;
}

/**
 * Cruza a árvore com o índice. Devolve os achados (frase copiada num arquivo de exemplo, ausente do código de execução)
 * e, à parte, as frases que são texto da própria ferramenta. `files` = [caminho relativo, conteúdo]. PURA.
 */
export function crossCheck(files, index, n) {
  const runtime = new Set();
  for (const [rel, text] of files) if (!EXAMPLE_PATH.test(rel)) for (const s of shinglesOf(text, n)) if (index.has(s)) runtime.add(s);
  const findings = [];
  const own = [];
  for (const [rel, text] of files) {
    const example = EXAMPLE_PATH.test(rel);
    text.split("\n").forEach((line, at) => {
      const w = wordsOf(line);
      for (let i = 0; i + n <= w.length; i += 1) {
        const s = w.slice(i, i + n).join(" ");
        const src = index.get(s);
        if (!src) continue;
        (example && !runtime.has(s) ? findings : own).push({ file: rel, line: at + 1, shingle: s, source: src });
        break; // uma por linha basta: a linha inteira é o que se reescreve
      }
    });
  }
  return { findings, own };
}

/** Os NOMES que um board.yaml declara (personas, sistemas, etiquetas, frases de estratégia), sem interpretar YAML. PURA. */
export function declaredNames(yamlText) {
  const out = new Set();
  const take = (v) => {
    const t = v.trim().replace(/^['"]|['"]$/g, "").trim();
    if (t.length >= 6 && /\p{L}/u.test(t) && !/^[a-z0-9_-]+$/.test(t)) out.add(t);
  };
  for (const line of yamlText.split("\n")) {
    const m = /^\s*-?\s*(name|label|positioning|businessMetric|desiredOutcome|tagline)\s*:\s*(.+)$/.exec(line);
    if (m && !m[2].startsWith("{") && !m[2].startsWith("[") && m[2] !== ">-" && m[2] !== "|") take(m[2]);
  }
  return [...out];
}

/** As linhas que o operador conferiu e aceitou como texto da própria ferramenta: `arquivo<TAB>frase`. PURA. */
export function parseAccepted(raw) {
  const out = new Set();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf("\t");
    if (at > 0) out.add(`${t.slice(0, at).trim()}\t${t.slice(at + 1).trim()}`);
  }
  return out;
}

function acceptedFromConfig(env = process.env) {
  const file = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agileharness", "oss-derivation-accepted");
  try {
    return parseAccepted(fs.readFileSync(file, "utf8"));
  } catch {
    return new Set();
  }
}

function sourcesFromConfig(env = process.env) {
  const raw = env.AH_OSS_PRIVATE_SOURCES?.trim();
  if (raw) return raw.split(":").filter(Boolean);
  const file = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agileharness", "oss-private-sources");
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function main(argv) {
  const opt = { window: 6, names: false, all: false, json: false, requireSources: false, sources: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--names") opt.names = true;
    else if (a === "--all") opt.all = true;
    else if (a === "--json") opt.json = true;
    else if (a === "--require-sources") opt.requireSources = true;
    else if (a === "--window") opt.window = Number(argv[(i += 1)]);
    else if (a === "--sources") opt.sources = String(argv[(i += 1)] ?? "").split(":").filter(Boolean);
    else {
      console.error(`derivation-check: argumento desconhecido: ${a}`);
      return 2;
    }
  }
  if (!Number.isInteger(opt.window) || opt.window < 4 || opt.window > 12) {
    console.error("derivation-check: --window tem de ser um inteiro de 4 a 12");
    return 2;
  }
  const sources = (opt.sources ?? sourcesFromConfig()).filter((d) => fs.existsSync(d));
  if (!sources.length) {
    if (opt.requireSources) {
      console.error("derivation-check: nenhuma fonte privada declarada (oss-private-sources) e --require-sources exige uma — sem fonte, a medição não aconteceu.");
      return 2;
    }
    console.log("derivation-check: nenhuma fonte privada declarada (oss-private-sources) — nada a cruzar.");
    return 0;
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const tracked = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter((f) => f && TEXT_EXT.test(f));
  const files = tracked.map((f) => [f, read(path.join(repo, f))]);
  // O que a própria árvore pública distribui para dentro do alvo (o molde do board, as skills) aparece nas fontes porque
  // a ferramenta o pôs lá: sai do índice pelo NOME do arquivo relativo, quando o conteúdo é o mesmo.
  const shipped = new Map(files.filter(([f]) => f.startsWith("storymap/") || f.startsWith(".claude/")).map(([f, t]) => [f.split("/").slice(-2).join("/"), t]));
  const exclude = (file) => {
    const key = file.split(path.sep).slice(-2).join("/");
    return shipped.has(key) && shipped.get(key) === read(file);
  };
  const index = indexPrivate(sources, opt.window, exclude);
  const crossed = crossCheck(files, index, opt.window);
  const accepted = acceptedFromConfig();
  const findings = crossed.findings.filter((f) => !accepted.has(`${f.file}\t${f.shingle}`));
  const own = [...crossed.own, ...crossed.findings.filter((f) => accepted.has(`${f.file}\t${f.shingle}`))];

  const nameHits = [];
  if (opt.names) {
    const names = new Set();
    for (const root of sources) for (const f of walk(root, (p) => /(^|\/)board\.ya?ml$/.test(p) && !exclude(p))) for (const n of declaredNames(read(f))) names.add(n);
    // Um nome que a própria ferramenta usa — no molde, nos boards de demonstração ou no código de execução (os rótulos
    // das fases, por exemplo) — não é de produto nenhum: o board privado é que o herdou.
    const ownText = files.filter(([f]) => f.startsWith("storymap/boards/") || !EXAMPLE_PATH.test(f)).map(([, t]) => t.toLowerCase()).join("\n");
    for (const name of names) {
      const needle = name.toLowerCase();
      if (ownText.includes(needle)) continue;
      for (const [rel, text] of files) {
        if (!EXAMPLE_PATH.test(rel)) continue;
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0) nameHits.push({ file: rel, line: text.slice(0, at).split("\n").length, name });
      }
    }
  }

  if (opt.json) {
    console.log(JSON.stringify({ sources: sources.length, window: opt.window, findings, own: opt.all ? own : own.length, names: nameHits }, null, 2));
  } else {
    console.log(`derivation-check: ${index.size} frase(s) das fontes privadas × ${files.length} arquivo(s) versionado(s) (janela de ${opt.window} palavras).`);
    const byFile = new Map();
    for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
    for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ✗ ${file} — ${list.length} linha(s) com frase copiada`);
      for (const f of list.slice(0, 5)) console.log(`      ${f.line}: «${f.shingle}» ← ${f.source}`);
      if (list.length > 5) console.log(`      … e mais ${list.length - 5}`);
    }
    for (const h of nameHits) console.log(`  ✗ ${h.file}:${h.line} — nome declarado num board das fontes: «${h.name}»`);
    if (opt.all) for (const f of own) console.log(`  · ${f.file}:${f.line} — texto da própria ferramenta («${f.shingle}»)`);
    const total = findings.length + nameHits.length;
    console.log(
      total
        ? `✗ ${findings.length} linha(s) com frase copiada${nameHits.length ? ` e ${nameHits.length} nome(s) declarado(s)` : ""} — reescreva do zero (trocar substantivos não é inventar).`
        : `✓ nenhuma frase das fontes privadas em exemplo, fixture, skill ou documento (${own.length} são texto da própria ferramenta).`,
    );
  }
  return findings.length + nameHits.length ? 3 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
