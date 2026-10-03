#!/usr/bin/env node
// publication-gate — o que NÃO pode ir para um repositório público: contexto PRIVADO nas linhas que vão ser publicadas.
//
// POR QUE EXISTE: o AgileHarness é uma ferramenta GENÉRICA e open source, mas nasceu dentro de um monorepo de
// produto e ficou várias versões sem publicar. Quando o operador perguntou por quê, a medição mostrou o que
// o lint de hoje não vê: o `agnostic-lint` barra nome de produto no CÓDIGO, não em comentário nem em teste, e o diff
// pendente carregava centenas de linhas de contexto privado (ids de cards reais, nomes dos produtos, o nome do dono, caminhos
// absolutos de uma máquina). Publicar isso vaza a operação privada e faz a ferramenta parecer feita para UM produto.
//
// O QUE ELE FAZ, em duas medidas:
//   • a CATRACA — as linhas ADICIONADAS entre uma base (o que já é público, `origin/main`) e o HEAD passam por TODAS as
//     regras, inclusive as de FORMA (um id com cara de card, um caminho no diretório de usuário de uma máquina). São
//     heurísticas: pegam o que quem publica ainda não declarou, e por isso só valem para o que é novo;
//   • a ÁRVORE (`--tree`) — TODAS as linhas do HEAD passam pelas regras EXATAS: os termos privados do operador (que
//     incluem os ids reais dos cards dele), e-mail e host de máquina. Nada do que está publicado pode carregá-los, seja
//     novo ou antigo. Um teste que nega `~/.ssh` de um usuário qualquer cita um caminho de máquina sem vazar ninguém — por
//     isso a forma de caminho e a forma de id ficam fora desta medida.
// Duas fontes de regra:
//   • GENÉRICAS (aqui no repositório, sem nenhum nome privado): id de card (`<tipo>-<6 caracteres>`), caminho absoluto no
//     diretório de usuário de uma máquina, e-mail, IP e host de máquina;
//   • TERMOS PRIVADOS do operador — os nomes dos produtos, do dono, dos serviços: ficam FORA do repositório, num arquivo
//     que só a máquina de quem publica tem (`$AH_OSS_PRIVATE_TERMS`, ou `~/.config/agileharness/oss-private-terms`), uma
//     linha por termo (`#` comenta; `/regex/i` vale como regex). Se o código do gate trouxesse a lista, a lista seria o
//     próprio vazamento. Em modo de publicação (`--require-terms`) a falta do arquivo REPROVA (fail-closed).
// Uma linha que PRECISA citar o termo (um exemplo da própria documentação) leva `oss-allow: <motivo>` nela ou na anterior.
//
// Id de EXEMPLO: `<tipo>-ex0000` (quatro dígitos) é o espaço reservado para ids de fixture e de casos citados em comentário —
// tem a forma de um id real (mesmo comprimento), e a regra de forma o aceita.
//
// Uso:  node scripts/oss/publication-gate.mjs [--base <ref>] [--tree] [--require-terms] [--json]
//       node scripts/oss/publication-gate.mjs --text <arquivo> [--require-terms]   (um texto avulso — a mensagem de um commit)
// Saída: 0 limpo · 1 achados · 2 uso/configuração (inclusive termos ausentes com --require-terms).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Regras que valem para QUALQUER instalação — nenhuma cita um nome privado. */
export const GENERIC_RULES = [
  {
    id: "card-id",
    re: /\b(?:story|step|act|idea)-[a-z0-9]{6}\b/,
    why: "identificador de um card de board privado",
    addedOnly: true,
    // Passa o id de EXEMPLO (`-ex0000`) e o nome que é um módulo do próprio código, não um card (há arquivo com esse nome).
    allow: (match, ctx) => /-ex\d{4}$/.test(match) || !!ctx?.knownNames?.has(match),
  },
  {
    id: "home-path",
    // O diretório de um USUÁRIO com nome: revela quem opera a máquina. `/root/…` não entra — é o mesmo em qualquer host, e
    // uma ferramenta de host o cita o tempo todo (negar `~/.ssh` de root é um teste, não um vazamento); o nome privado
    // DENTRO de um caminho é pego pelos termos do operador.
    re: /(?<![\w.-])\/(?:home|Users)\/(?!(?:user|usuario|me|op|ah|dev|app|runner|node|ubuntu|alice|bob|maria)\/)[A-Za-z0-9._-]+\/[^\s'"`)>]*/,
    why: "diretório de um usuário de uma máquina",
    addedOnly: true,
  },
  {
    id: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/,
    why: "endereço de e-mail",
    // Passam: remetentes de serviço, os domínios RESERVADOS para exemplo (RFC 2606/6761: `example.*`, `.test`, `.invalid`,
    // `.example`, `.localhost`, `.local`), versão de pacote (`nome@1.2`) e unidade de systemd com instância (`nome@1.service`).
    // Um domínio só «com cara de falso» (`exemplo.com`, `t.dev`) é registrável — não passa.
    allow: /(?:noreply@(?:anthropic\.com|github\.com)|git@github\.com|@example\.(?:com|org|net|test)\b|@[\w.-]+\.(?:test|invalid|example|localhost|local)$|[\w-]@\d+\.\d+|@[\w.-]*\.(?:service|timer|socket|target)$)/i,
  },
  {
    id: "machine-host",
    re: /\b[\w.-]*sslip\.io\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/,
    why: "host ou IP de uma máquina",
    // Passam: loopback, redes privadas (RFC 1918 — não identificam máquina nenhuma na internet), máscaras e as faixas
    // reservadas para documentação (RFC 5737).
    allow: /^(?:127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|255\.255\.255\.\d+|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/,
  },
];

const PRAGMA = /oss-allow:\s*\S/;

/**
 * Lê os termos privados (um por linha; `#` comenta). Um termo simples casa a palavra inteira, sem diferenciar caixa; `/regex/flags`
 * vale como está escrito (sem `i`, diferencia caixa — para uma marca que também é palavra comum). Devolve null quando o
 * arquivo não existe.
 */
export function loadPrivateTerms(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const terms = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const rx = /^\/(.+)\/([a-z]*)$/.exec(line);
    try {
      terms.push({ id: "private-term", re: rx ? new RegExp(rx[1], rx[2]) : new RegExp(`\\b${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), why: "nome privado declarado pelo operador (oss-private-terms)", term: line });
    } catch {
      /* regex inválida no arquivo do operador: ignora a linha (o gate não pode quebrar por ela) */
    }
  }
  return terms;
}

/**
 * As linhas ADICIONADAS de um diff `-U0`: [{ file, line, text }]. PURA. Ignora binário, o arquivo removido e os caminhos
 * excluídos (lockfiles, patches, imagens).
 */
export function addedLines(diffText, { exclude = [] } = {}) {
  const out = [];
  let file = null;
  let skip = false;
  let line = 0;
  const excluded = (f) => exclude.some((rx) => rx.test(f));
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const f = raw.slice(4).trim();
      file = f === "/dev/null" ? null : f.replace(/^b\//, "");
      skip = !file || excluded(file);
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(raw);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (!skip && file) out.push({ file, line, text: raw.slice(1) });
      line += 1;
    }
  }
  return out;
}

/**
 * Os achados sobre as linhas adicionadas. PURA. Uma linha com `oss-allow:` (nela ou na anterior) é liberada; `ctx.knownNames`
 * são os nomes de arquivo do repositório (sem extensão), que uma regra pode aceitar.
 */
export function scanAdded(lines, rules, ctx = {}) {
  const findings = [];
  const prev = new Map();
  for (const l of lines) {
    const before = prev.get(l.file);
    prev.set(l.file, l.text);
    if (PRAGMA.test(l.text) || (before !== undefined && PRAGMA.test(before))) continue;
    // Uma sequência de escape colada no termo (`"\nfulano"` dentro de uma string) esconde a fronteira de palavra: o `n`
    // do `\n` e a primeira letra do termo viram uma palavra só. A medida lê a linha com os escapes abertos em espaço.
    const probe = l.text.replace(/\\[ntrbfv]/g, "  ");
    for (const r of rules) {
      const m = r.re.exec(probe);
      if (!m) continue;
      if (r.allow && (typeof r.allow === "function" ? r.allow(m[0], ctx) : r.allow.test(m[0]))) continue;
      findings.push({ file: l.file, line: l.line, rule: r.id, match: m[0], why: r.why, text: l.text.trim().slice(0, 160) });
    }
  }
  return findings;
}

/**
 * Caminhos que não carregam texto da ferramenta: dependências travadas, patches de terceiros, binários e o teste DESTE gate —
 * ele precisa de entradas que as regras reprovam (um id, um caminho, um e-mail) para provar que reprovam.
 */
export const DEFAULT_EXCLUDES = [
  /(^|\/)bun\.lockb?$/,
  /(^|\/)package-lock\.json$/,
  /^patches\//,
  /\.(?:png|jpe?g|gif|webp|ico|woff2?|pdf)$/i,
  /(^|\/)__snapshots__\//,
  /(^|\/)publication-gate\.test\.ts$/,
  /^(?:LICENSE|NOTICE)$/, // o titular do copyright é público por definição
];

/** A árvore vazia do git: o diff contra ela devolve TODAS as linhas do HEAD como adicionadas. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Nomes de arquivo (sem extensão) rastreados pelo git. */
function trackedNames() {
  try {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0");
    return new Set(files.map((f) => path.basename(f).replace(/\.[^.]*$/, "")).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Onde ficam os termos privados do operador: `$AH_OSS_PRIVATE_TERMS`, ou o arquivo de configuração do usuário. */
export function defaultTermsFile(env = process.env) {
  return env.AH_OSS_PRIVATE_TERMS || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agileharness", "oss-private-terms");
}

function main(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = get("--base") || "origin/main";
  const requireTerms = argv.includes("--require-terms");
  const json = argv.includes("--json");
  const termsFile = get("--terms") || defaultTermsFile();
  const terms = loadPrivateTerms(termsFile);
  if (terms === null && requireTerms) {
    console.error(`✗ publication-gate: faltam os termos privados (${termsFile}). Declare os nomes dos seus produtos, do dono e dos serviços — um por linha — para o gate mantê-los fora do repositório público.`);
    return 2;
  }
  const textFile = get("--text");
  if (textFile) {
    let body;
    try {
      body = fs.readFileSync(textFile, "utf8");
    } catch (err) {
      console.error(`✗ publication-gate: não consegui ler ${textFile} (${err instanceof Error ? err.message.split("\n")[0] : err})`);
      return 2;
    }
    const textLines = body.split("\n").map((text, i) => ({ file: path.basename(textFile), line: i + 1, text }));
    const textFindings = scanAdded(textLines, [...GENERIC_RULES, ...(terms ?? [])], { knownNames: new Set() });
    for (const f of textFindings) console.error(`  ✗ ${f.file}:${f.line} [${f.rule}] «${f.match}» — ${f.why}\n      ${f.text}`);
    console.error(textFindings.length ? `✗ ${textFindings.length} achado(s) no texto.` : "✓ o texto não carrega contexto privado.");
    return textFindings.length ? 1 : 0;
  }
  const readDiff = (from) => execFileSync("git", ["diff", "-U0", "--no-color", "--no-ext-diff", `${from}..HEAD`], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  let diff;
  try {
    diff = readDiff(base);
  } catch (err) {
    console.error(`✗ publication-gate: não consegui ler o diff ${base}..HEAD (${err instanceof Error ? err.message.split("\n")[0] : err})`);
    return 2;
  }
  const rules = [...GENERIC_RULES, ...(terms ?? [])];
  const lines = addedLines(diff, { exclude: DEFAULT_EXCLUDES });
  const findings = scanAdded(lines, rules, { knownNames: trackedNames() });
  let treeLines = 0;
  if (argv.includes("--tree")) {
    // A árvore inteira, pelas regras exatas. O que já saiu na catraca (a mesma linha, a mesma regra) não é contado duas vezes.
    const all = addedLines(readDiff(EMPTY_TREE), { exclude: DEFAULT_EXCLUDES });
    treeLines = all.length;
    const seen = new Set(findings.map((f) => `${f.file}:${f.line}:${f.rule}`));
    for (const f of scanAdded(all, rules.filter((r) => !r.addedOnly))) if (!seen.has(`${f.file}:${f.line}:${f.rule}`)) findings.push({ ...f, scope: "tree" });
    // O NOME do arquivo também é publicado: um termo privado num caminho vaza igual a um numa linha.
    const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
    for (const f of scanAdded(paths.map((p) => ({ file: p, line: 0, text: p })), rules.filter((r) => !r.addedOnly))) findings.push({ ...f, scope: "tree", why: `${f.why} (no NOME do arquivo)` });
  }
  if (json) console.log(JSON.stringify({ base, scanned: lines.length, treeScanned: treeLines, termsLoaded: terms ? terms.length : 0, findings }, null, 1));
  else {
    console.error(`publication-gate: ${lines.length} linha(s) adicionada(s) desde ${base}${treeLines ? ` + a árvore inteira (${treeLines} linhas)` : ""}; ${terms ? `${terms.length} termo(s) privado(s)` : "SEM arquivo de termos privados (só as regras genéricas)"}.`);
    const byRule = new Map();
    for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
    if (!findings.length) console.error(treeLines ? "✓ nenhuma linha — nova ou antiga — carrega contexto privado." : "✓ nenhuma linha nova carrega contexto privado.");
    else {
      for (const f of findings.slice(0, 200)) console.error(`  ✗ ${f.file}:${f.line} [${f.rule}${f.scope === "tree" ? " · legado" : ""}] «${f.match}» — ${f.why}\n      ${f.text}`);
      if (findings.length > 200) console.error(`  … e mais ${findings.length - 200}`);
      console.error(`✗ ${findings.length} achado(s): ${[...byRule].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
      console.error("  Reescreva em termos genéricos (o caso real vira «um card», «o produto», um id de fixture). Quando a linha PRECISA do termo, `oss-allow: <motivo>`.");
    }
  }
  return findings.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
