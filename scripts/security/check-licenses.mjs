#!/usr/bin/env node
// Gate de LICENÇA: recusa dependência copyleft-FORTE nova no caminho de distribuição.
//
// O dano que ele evita não é técnico, é de licenciamento — e é praticamente irreversível: uma GPL/AGPL/SSPL
// no fecho de runtime de um projeto publicado sob licença permissiva obriga o projeto inteiro a se
// relicenciar (ou a estar em violação). Código já publicado sob a licença errada não volta atrás.
//
// A dificuldade real é não ser ingênuo em NENHUMA das cinco direções (cada uma com teste de ataque em
// `packages/storymap-ui/src/lib/storymap/supply-chain/license-gate.test.ts`):
//
//   1. FORMA LEGADA — quem declara por `licenses: [{type}]` escapa de um gate que lê só `license`.
//   2. SEM LICENÇA — pacote sem campo nenhum NÃO é permissivo: sem concessão explícita o default legal é
//      todos-os-direitos-reservados, situação PIOR que copyleft. Bloqueia (fail-closed).
//   3. SUBSTRING — `LGPL` (copyleft fraco, por linkagem) e `MPL` (por arquivo) contêm/parecem "GPL" e NÃO
//      obrigam o consumidor a se relicenciar. Bloqueá-las inventa um problema jurídico inexistente, faz o
//      gate nascer vermelho, e gate vermelho é gate desligado. Idem `(MIT OR GPL-2.0)`: numa DISJUNÇÃO você
//      escolhe o lado permissivo. Já `AND` obriga a cumprir as duas — bloqueia.
//   4. RUG-PULL — o baseline é chaveado por (nome, TERMO da licença). Chavear só por nome faria o
//      relicenciamento (MIT → BUSL/SSPL, o padrão Redis/Elastic/Terraform) entrar coberto pelo
//      reconhecimento do termo antigo.
//   5. ESCOPO — copyleft-forte só em devDependency não é distribuída, então não contamina o artefato:
//      REPORTA, não reprova. Reprovar por ferramenta de build é o caminho curto para o gate ser desligado.
//
// Uso:
//   node scripts/security/check-licenses.mjs [--pkg packages/storymap-ui] [--json] [--baseline <arquivo>]
// Saída: 0 aprovado · 2 REPROVADO · 1 erro de uso.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { medirFecho } from "./lib/dep-closure.mjs";

const RAIZ_PADRAO = fileURLToPath(new URL("../../", import.meta.url));
const BASELINE_PADRAO = "scripts/security/license-baseline.json";

/**
 * Copyleft FORTE: a licença alcança a obra derivada inteira, então distribuir junto obriga o consumidor a
 * adotar os mesmos termos. É a família que precisa de decisão humana antes de entrar.
 *
 * Deliberadamente FORA: LGPL (fraco — linkagem), MPL/EPL/CDDL (por arquivo), e as permissivas. Elas viajam
 * num projeto permissivo sem contaminá-lo, e incluí-las só produziria vermelho crônico.
 */
const COPYLEFT_FORTE = [
  /^AGPL-/i,
  /^GPL-/i,
  /^SSPL-/i,
  /^OSL-/i,
  /^EUPL-/i,
  /^CPAL-/i,
  /^RPL-/i,
  /^BUSL-/i, // não é OSI, mas restringe uso de forma incompatível com "permissivo"
  /^Elastic-/i,
  /^CC-BY-NC/i,
  /^CC-BY-SA/i,
];

const forte = (id) => COPYLEFT_FORTE.some((re) => re.test(id.trim()));

/**
 * Decide sobre uma expressão SPDX.
 *
 * A regra que importa: numa DISJUNÇÃO (`OR`) basta um lado aceitável — quem consome escolhe. Numa
 * CONJUNÇÃO (`AND`) todos os termos incidem. Tratar as duas igual é o erro que gera falso-positivo em
 * `(MIT OR GPL-2.0)`, um padrão comum e legítimo.
 */
export function avaliarExpressao(expressao) {
  if (!expressao || !String(expressao).trim()) return { ok: false, reason: "o pacote não declara licença" };
  const texto = String(expressao).trim();
  const nu = texto.replace(/^\(+|\)+$/g, "").trim();

  // `WITH` (exceção, ex. `GPL-2.0-only WITH Classpath-exception-2.0`) não é tratado como permissivo
  // automaticamente: exceção é caso a caso e cai no baseline, com motivo escrito.
  if (/\sOR\s/i.test(nu)) {
    const lados = nu.split(/\sOR\s/i);
    const bons = lados.filter((l) => avaliarExpressao(l).ok);
    return bons.length
      ? { ok: true }
      : { ok: false, reason: `todos os lados da disjunção são copyleft-forte: ${texto}` };
  }
  if (/\sAND\s/i.test(nu)) {
    const lados = nu.split(/\sAND\s/i);
    const ruins = lados.filter((l) => !avaliarExpressao(l).ok);
    return ruins.length
      ? { ok: false, reason: `conjunção obriga a cumprir termo copyleft-forte: ${ruins.join(" AND ")}` }
      : { ok: true };
  }
  const id = nu.split(/\sWITH\s/i)[0].trim();
  return forte(id) ? { ok: false, reason: `copyleft-forte: ${id}` } : { ok: true };
}

function args(argv) {
  const o = { pkg: "packages/storymap-ui", root: RAIZ_PADRAO, json: false, baseline: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pkg") o.pkg = argv[++i];
    else if (a === "--root") o.root = argv[++i];
    else if (a === "--baseline") o.baseline = argv[++i];
    else if (a === "--json") o.json = true;
  }
  return o;
}

export function verificar({ repoRoot, pkgRel, baseline }) {
  const raiz = path.resolve(repoRoot);
  const { componentes } = medirFecho({ repoRoot: raiz, pkgDir: path.resolve(raiz, pkgRel) });

  // Chave (nome, termo): reconhecer o pacote sem reconhecer o TERMO deixaria o rug-pull passar.
  const reconhecido = new Set((baseline?.entries ?? []).map((e) => `${e.name}\u0000${String(e.license).trim()}`));

  const blocking = [];
  const devOnlyCopyleft = [];
  const acknowledged = [];
  let scanned = 0;

  for (const c of [...componentes.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    if (c.firstParty) continue; // código do próprio repositório: a licença dele é a do projeto
    scanned++;
    const veredito = avaliarExpressao(c.license);
    if (veredito.ok) continue;

    const registro = { name: c.name, version: c.version, license: c.license ?? null, reason: veredito.reason };
    if (reconhecido.has(`${c.name}\u0000${String(c.license ?? "").trim()}`)) {
      acknowledged.push(registro);
      continue;
    }
    // Só o escopo de runtime é DISTRIBUÍDO — é ele que contamina o artefato.
    if (c.scope === "required") blocking.push(registro);
    else devOnlyCopyleft.push(registro);
  }

  return { scanned, blocking, devOnlyCopyleft, acknowledged, ok: blocking.length === 0 };
}

function main() {
  const o = args(process.argv.slice(2));
  const raiz = path.resolve(o.root);
  let baseline = null;
  const bFile = path.resolve(o.baseline ?? path.join(raiz, BASELINE_PADRAO));
  try {
    baseline = JSON.parse(readFileSync(bFile, "utf8"));
  } catch {
    baseline = { entries: [] }; // sem baseline = nada reconhecido; o gate simplesmente é mais estrito
  }

  const r = verificar({ repoRoot: raiz, pkgRel: o.pkg, baseline });

  // ── PISO DE NÃO-VACUIDADE ────────────────────────────────────────────────────────────────────
  // Sem isto, um fecho VAZIO produzia "✓ licenças aprovadas / 0 pacotes de terceiros" e exit 0.
  // Medido em 2026-08-06 num worktree sem `bun install`: veredito verde sobre ZERO pacote lido.
  //
  // Por que aqui e não só no teste: `oss/ci/workflows/ci.yml:43` invoca este script COMO PASSO
  // PRÓPRIO, antes do typecheck e da suíte — e o piso `toBeGreaterThan(300)` mora no teste, que roda
  // depois e noutro passo. Ou seja, o portão publicado podia dizer VERDE tendo medido NADA, no eixo
  // que esta casa marcou como sem desfazer (licença de terceiro num artefato já distribuído).
  //
  // O gêmeo desta falha foi consertado uma camada abaixo no mesmo dia: o resolvedor privado do
  // `oss-license.test.ts` media 30 de 684 pacotes no layout isolado do bun e declarava o fecho
  // limpo. Fechar a instância e deixar a classe viva uma camada acima é o padrão que a memória
  // desta casa registra — este bloco existe para não repeti-lo aqui.
  //
  // O piso NÃO é constante: `PISO_MINIMO` seria calibragem que apodrece com o grafo. A âncora é a
  // premissa mais fraca que ainda discrimina — um pacote real tem dependências de terceiro; zero
  // significa que o instrumento não leu, não que a árvore é limpa.
  if (r.scanned === 0) {
    process.stderr.write(
      "✗ INSTRUMENTO QUEBRADO: o fecho de dependências foi lido como VAZIO (0 pacotes de terceiros).\n" +
        "  Um gate de licença sobre fecho vazio fica verde medindo NADA — é pior que gate nenhum,\n" +
        "  porque compra confiança sem entregar cobertura.\n" +
        "  Causa provável: `bun install` não rodou nesta árvore, ou o layout de node_modules mudou\n" +
        "  (o layout ISOLADO do bun põe os diretos como symlink; resolva por realpath).\n" +
        `  raiz medida: ${raiz}\n  pacote: ${o.pkg}\n`,
    );
    return 2;
  }

  if (o.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    const l = [r.ok ? "✓ licenças aprovadas" : "✗ licenças REPROVADAS", `  ${r.scanned} pacotes de terceiros`];
    for (const b of r.blocking) l.push(`  BLOQUEIA  ${b.name}@${b.version} — ${b.reason}`);
    for (const b of r.devOnlyCopyleft) l.push(`  dev-only  ${b.name}@${b.version} — ${b.reason} (não distribuído)`);
    for (const b of r.acknowledged) l.push(`  baseline  ${b.name}@${b.version} — ${b.license}`);
    process.stderr.write(`${l.join("\n")}\n`);
  }
  return r.ok ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
