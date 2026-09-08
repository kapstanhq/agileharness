#!/usr/bin/env node
// Consulta de advisories do fecho: OSV (querybatch + detalhe) + EPSS + catálogo CISA KEV.
//
// Este script é o ÚNICO ponto desta cadeia que fala com a rede. É deliberado: o gate que decide
// aprovar/reprovar (`vex-gate.mjs`) consome o relatório daqui como ARQUIVO, então o gate é testável offline
// e determinístico. Gate que depende de rede falha por indisponibilidade e ensina o time a re-rodar até
// passar verde — que é como um gate morre.
//
// Uso:
//   node scripts/security/osv-query.mjs [--pkg packages/storymap-ui] [--out .artifacts/reports/osv.json]
//   node scripts/security/osv-query.mjs --offline --in <relatorio>   # só re-imprime o resumo
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { montarSbom } from "./generate-sbom.mjs";

const RAIZ_PADRAO = fileURLToPath(new URL("../../", import.meta.url));
const OSV = "https://api.osv.dev";
const EPSS = "https://api.first.org/data/v1/epss";
const KEV = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

/** A API aceita lotes; 200 é o tamanho que a auditoria usou sem lote falhado. */
const LOTE = 200;

function args(argv) {
  const o = { pkg: "packages/storymap-ui", root: RAIZ_PADRAO, out: null, in: null, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pkg") o.pkg = argv[++i];
    else if (a === "--root") o.root = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--in") o.in = argv[++i];
    else if (a === "--offline") o.offline = true;
  }
  return o;
}

async function postJson(url, corpo) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

/** GHSA carrega a severidade nominal em `database_specific`; o resto se deriva do escore CVSS. */
function severidadeDe(vuln) {
  const nominal = vuln?.database_specific?.severity;
  if (typeof nominal === "string") return nominal.toUpperCase();
  const cvss = (vuln?.severity ?? []).find((s) => typeof s?.score === "string");
  if (!cvss) return "UNKNOWN";
  const m = /\/?(\d+\.\d+)$/.exec(cvss.score);
  const n = m ? Number(m[1]) : NaN;
  if (Number.isNaN(n)) return "UNKNOWN";
  if (n >= 9) return "CRITICAL";
  if (n >= 7) return "HIGH";
  if (n >= 4) return "MODERATE";
  return "LOW";
}

function cvesDe(vuln) {
  return [vuln.id, ...(vuln.aliases ?? [])].filter((id) => /^CVE-/.test(id));
}

export async function consultar({ repoRoot, pkgRel }) {
  const { resumo } = montarSbom({ repoRoot, pkgRel });
  // Primeira-parte fora: pacote privado do monorepo não tem advisory público, e consultá-lo por
  // `pkg:npm/<nome>` pode CASAR com um pacote homônimo do registry — um falso-positivo com cara de real.
  const alvos = resumo.components.filter((c) => !c.firstParty);

  const vulnsPorPacote = new Map();
  const lotesFalhados = [];
  for (let i = 0; i < alvos.length; i += LOTE) {
    const fatia = alvos.slice(i, i + LOTE);
    const queries = fatia.map((c) => ({ package: { name: c.name, ecosystem: "npm" }, version: c.version }));
    try {
      const r = await postJson(`${OSV}/v1/querybatch`, { queries });
      (r.results ?? []).forEach((res, k) => {
        const ids = (res?.vulns ?? []).map((v) => v.id);
        if (ids.length) vulnsPorPacote.set(`${fatia[k].name}@${fatia[k].version}`, ids);
      });
    } catch (e) {
      // Lote falhado é REPORTADO, nunca engolido: silenciá-lo produz um relatório curto que parece limpo.
      lotesFalhados.push({ from: i, size: fatia.length, error: String(e.message ?? e) });
    }
  }

  const ids = [...new Set([...vulnsPorPacote.values()].flat())].sort();
  const detalhes = new Map();
  for (const id of ids) {
    try {
      detalhes.set(id, await getJson(`${OSV}/v1/vulns/${encodeURIComponent(id)}`));
    } catch (e) {
      detalhes.set(id, { id, _erro: String(e.message ?? e) });
    }
  }

  // KEV e EPSS são enriquecimento: se caírem, o relatório sai sem eles e DIZ que saiu sem eles.
  let kev = null;
  try {
    const cat = await getJson(KEV);
    kev = new Set((cat.vulnerabilities ?? []).map((v) => v.cveID));
  } catch {
    kev = null;
  }

  const cves = [...new Set([...detalhes.values()].flatMap((v) => cvesDe(v)))];
  const epss = new Map();
  if (cves.length) {
    for (let i = 0; i < cves.length; i += 100) {
      try {
        const r = await getJson(`${EPSS}?cve=${cves.slice(i, i + 100).join(",")}`);
        for (const d of r.data ?? []) epss.set(d.cve, Number(d.epss));
      } catch {
        /* enriquecimento indisponível — segue sem */
      }
    }
  }

  const advisories = ids.map((id) => {
    const v = detalhes.get(id) ?? { id };
    const seus = cvesDe(v);
    const afetados = [...vulnsPorPacote.entries()]
      .filter(([, lista]) => lista.includes(id))
      .map(([chave]) => chave)
      .sort();
    return {
      id,
      aliases: v.aliases ?? [],
      severity: severidadeDe(v),
      summary: v.summary ?? "",
      // Trecho do texto do advisory: é sobre ele que a evidência `platform_not_applicable` do VEX é
      // re-verificada. Sem isso, uma disposição "só afeta Windows" não teria como ser contestada quando o
      // advisory fosse reescrito — e disposição que ninguém contesta é mute com nome bonito.
      detailsExcerpt: String(v.details ?? "").slice(0, 4000),
      components: afetados,
      kev: kev ? seus.some((c) => kev.has(c)) : null,
      epss: seus.map((c) => epss.get(c)).filter((n) => typeof n === "number" && !Number.isNaN(n)).sort((a, b) => b - a)[0] ?? null,
    };
  });

  return {
    target: resumo.target,
    closure: { total: resumo.total, runtime: resumo.runtime, devOnly: resumo.devOnly },
    vulnerableComponents: [...vulnsPorPacote.keys()].sort(),
    advisories,
    failedBatches: lotesFalhados,
    kevCatalogAvailable: kev !== null,
    // Divergências viajam no relatório: o gate precisa poder reprovar por elas sem re-medir a árvore.
    lockfileDrift: resumo.lockfileDrift,
    installDrift: resumo.installDrift,
  };
}

function imprimirResumo(rel) {
  const porSev = new Map();
  for (const a of rel.advisories) porSev.set(a.severity, (porSev.get(a.severity) ?? 0) + 1);
  const linhas = [
    `alvo:                 ${rel.target}`,
    `fecho:                ${rel.closure.total} (${rel.closure.runtime} runtime / ${rel.closure.devOnly} dev-only)`,
    `componentes vulneráveis: ${rel.vulnerableComponents.length}`,
    `advisories:           ${rel.advisories.length} (${[...porSev].map(([s, n]) => `${n} ${s}`).join(" / ")})`,
    `CISA KEV:             ${rel.kevCatalogAvailable ? rel.advisories.filter((a) => a.kev).length : "catálogo indisponível"}`,
    `pacotes MAL-:         ${rel.advisories.filter((a) => a.id.startsWith("MAL-")).length}`,
    `lotes falhados:       ${rel.failedBatches.length}`,
    `divergência fecho×lockfile:      ${rel.lockfileDrift === null ? "não conferido" : rel.lockfileDrift.length}`,
    `divergência instalado×lockfile:  ${rel.installDrift === null ? "não conferido" : rel.installDrift.length}`,
  ];
  process.stderr.write(`${linhas.join("\n")}\n`);
}

async function main() {
  const o = args(process.argv.slice(2));
  const rel = o.offline
    ? JSON.parse(readFileSync(o.in, "utf8"))
    : await consultar({ repoRoot: o.root, pkgRel: o.pkg });
  imprimirResumo(rel);
  const saida = `${JSON.stringify(rel, null, 2)}\n`;
  if (o.out) {
    mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    writeFileSync(o.out, saida, "utf8");
  } else {
    process.stdout.write(saida);
  }
  // Não decide nada: quem reprova é o `vex-gate.mjs`. Um script que consulta E reprova acaba com o gate
  // desligado no dia em que a rede oscilar.
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      process.stderr.write(`osv-query: ${e?.stack ?? e}\n`);
      process.exit(1);
    },
  );
}
