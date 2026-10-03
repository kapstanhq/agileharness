#!/usr/bin/env node
// SBOM do fecho REAL de um pacote — CycloneDX 1.6.
//
// Por que CycloneDX e não SPDX: este projeto PRECISA publicar VEX (a disposição dos advisories de pacote
// não-executado — sem ela o primeiro `npm audit` de quem clonar mostra 45 advisories e a conclusão é
// "projeto abandonado"). CycloneDX carrega `vulnerabilities[].analysis` — o VEX — no MESMO documento e no
// MESMO esquema do inventário, com identidade por `purl`/`bom-ref`; SPDX exigiria um segundo documento num
// formato separado, e dois artefatos que precisam concordar entre si sempre divergem. Um artefato só, com
// identidade única, é menos superfície para o adotante manter certa. Grype/Trivy/Dependency-Track consomem
// este arquivo direto.
//
// Uso:
//   node scripts/security/generate-sbom.mjs [--pkg packages/storymap-ui] [--root .] [--out sbom.json]
//   node scripts/security/generate-sbom.mjs --summary     # resumo compacto (fecho, escopos, divergência)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lerLockfile, medirFecho, medirInstaladosNoTopo } from "./lib/dep-closure.mjs";

const RAIZ_PADRAO = fileURLToPath(new URL("../../", import.meta.url));

function args(argv) {
  const o = { pkg: "packages/storymap-ui", root: RAIZ_PADRAO, out: null, summary: false, lockfile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pkg") o.pkg = argv[++i];
    else if (a === "--root") o.root = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--lockfile") o.lockfile = argv[++i];
    else if (a === "--summary") o.summary = true;
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

/** CycloneDX aceita id SPDX simples OU expressão — misturar os dois campos invalida o documento. */
function licencasCycloneDX(expressao) {
  if (!expressao) return undefined;
  return /[()]|\s(OR|AND|WITH)\s/.test(expressao) ? [{ expression: expressao }] : [{ license: { id: expressao } }];
}

export function montarSbom({ repoRoot, pkgRel, lockfileNome }) {
  const raiz = path.resolve(repoRoot);
  const pkgDir = path.resolve(raiz, pkgRel);
  const { alvo, componentes, arestas, missing } = medirFecho({ repoRoot: raiz, pkgDir });

  const lock = lerLockfile(raiz, lockfileNome);
  // `null` quando não havia lockfile: o relatório DIZ que não conferiu em vez de reportar zero divergências.
  const drift = lock
    ? [...componentes.values()]
        .filter((c) => !c.firstParty && !lock.chaves.has(c.key))
        .map((c) => c.key)
        .sort()
    : null;

  // Segundo escopo, obrigatoriamente separado do fecho: o que está instalado e NENHUM manifesto declara.
  // O fecho parte dos manifestos, então ele é estruturalmente incapaz de ver o intruso — e o lockfile
  // também não o tem. Sem esta medição os dois scanners concordam em não ver o pacote que está no disco.
  const instalados = lock ? medirInstaladosNoTopo({ repoRoot: raiz, pkgDir }) : null;
  const installDrift = instalados
    ? [...instalados.keys()].filter((k) => !lock.chaves.has(k)).sort()
    : null;

  const lista = [...componentes.values()].sort((a, b) => a.key.localeCompare(b.key));
  const runtime = lista.filter((c) => c.scope === "required").length;

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      // Sem timestamp: um SBOM que muda de bytes a cada execução não pode ser comparado commit-a-commit,
      // e é a comparação que revela dependência nova entrando no fecho.
      component: {
        type: "application",
        "bom-ref": alvo.ref,
        name: alvo.nome,
        version: alvo.versao,
        purl: alvo.ref,
      },
      properties: [
        { name: "agileharness:closure.source", value: "installed-tree" },
        { name: "agileharness:closure.total", value: String(lista.length) },
        { name: "agileharness:closure.runtime", value: String(runtime) },
        { name: "agileharness:closure.devOnly", value: String(lista.length - runtime) },
        {
          name: "agileharness:lockfile.compared",
          value: lock ? lock.arquivo : "none",
        },
        { name: "agileharness:lockfile.drift", value: drift === null ? "unknown" : String(drift.length) },
        {
          name: "agileharness:install.undeclaredDrift",
          value: installDrift === null ? "unknown" : String(installDrift.length),
        },
      ],
    },
    components: lista.map((c) => ({
      type: "library",
      "bom-ref": c.ref,
      name: c.name,
      version: c.version,
      purl: c.purl,
      scope: c.scope,
      ...(licencasCycloneDX(c.license) ? { licenses: licencasCycloneDX(c.license) } : {}),
      properties: [
        { name: "agileharness:firstParty", value: String(c.firstParty) },
        // Marca o pacote que está no disco e NÃO no lockfile: é exatamente o que um SCA de lockfile ignora.
        ...(drift && drift.includes(c.key) ? [{ name: "agileharness:lockfile.present", value: "false" }] : []),
      ],
    })),
    dependencies: [...arestas.entries()]
      .map(([ref, deps]) => ({ ref, dependsOn: [...deps].sort() }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
  };

  return {
    bom,
    resumo: {
      target: `${alvo.nome}@${alvo.versao}`,
      total: lista.length,
      runtime,
      devOnly: lista.length - runtime,
      missing,
      lockfileCompared: lock ? lock.arquivo : false,
      lockfileDrift: drift,
      installDrift,
      components: lista.map((c) => ({
        name: c.name,
        version: c.version,
        scope: c.scope,
        license: c.license,
        firstParty: c.firstParty,
      })),
    },
  };
}

function main() {
  const o = args(process.argv.slice(2));
  if (o.help) {
    process.stdout.write(
      "uso: generate-sbom.mjs [--pkg <rel>] [--root <dir>] [--out <arquivo>] [--summary] [--lockfile <nome>]\n",
    );
    return 0;
  }
  const { bom, resumo } = montarSbom({ repoRoot: o.root, pkgRel: o.pkg, lockfileNome: o.lockfile });
  const saida = JSON.stringify(o.summary ? resumo : bom, null, 2);
  if (o.out) {
    mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    writeFileSync(o.out, `${saida}\n`, "utf8");
    process.stderr.write(`SBOM: ${resumo.total} componentes (${resumo.runtime} runtime) → ${o.out}\n`);
  } else {
    process.stdout.write(`${saida}\n`);
  }
  // Divergência árvore × lockfile NÃO reprova aqui: quem decide é o gate de SCA (audit-deps), que sabe se
  // o pacote divergente tem advisory. Este alvo produz inventário; reprovar inventário confunde os papéis.
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
