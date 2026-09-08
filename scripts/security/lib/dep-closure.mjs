// Fecho de dependências medido na ÁRVORE (`node_modules`), não no lockfile.
//
// Por que a árvore e não o lockfile: quase todo scanner popular (`npm audit`, Dependabot, os plugins de CI
// de prateleira) lê o lockfile. Quem consegue escrever em `node_modules` — um `postinstall` de transitiva,
// um `bun add` interrompido, um tarball trocado num registry espelhado — planta código que EXECUTA e não
// aparece em relatório nenhum. Neste checkout são 28 pacotes instalados e ausentes do `bun.lock`. Medir a
// árvore fecha esse ponto cego; comparar árvore × lockfile o TRANSFORMA em achado.
//
// A resolução aqui imita a do Node de propósito (sobe os `node_modules` a partir de quem importa, aninhado
// vencendo hoisted). Uma resolução aproximada reportaria a versão ERRADA, e então o SCA consulta a versão
// errada: o advisory da versão que realmente executa não é encontrado e o relatório fica verde com código
// vulnerável no disco. É a falha mais silenciosa desta cadeia.
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Só `dependencies` NÃO-opcional falta de verdade: `optionalDependencies` não instalada é normal
 *  (binário por plataforma), e devDependency de TRANSITIVA o gerenciador nem instala. */
const ARESTAS_RUNTIME = ["dependencies", "optionalDependencies"];

/** Lê um package.json tolerando ausência/lixo — pacote com manifesto ilegível não pode derrubar o gate,
 *  mas também não pode virar componente fantasma: devolve null e o chamador o trata como ausente. */
function lerManifesto(arquivo) {
  try {
    return JSON.parse(readFileSync(arquivo, "utf8"));
  } catch {
    return null;
  }
}

/**
 * As RAÍZES DE INSTALAÇÃO que a subida pode percorrer.
 *
 * Não é o `repoRoot` e ponto: num worktree o `node_modules` é um SYMLINK para a árvore do serviço vivo, e o
 * bun ainda resolve cada pacote para `<raiz>/node_modules/.bun/<nome>@<hash>/node_modules/<nome>`. Ou seja:
 * o caminho REAL de quase todo o fecho fica FORA do repoRoot lógico. Limitar a subida ao repoRoot fazia o
 * fecho parar nas dependências diretas (38 componentes de 744 medidos) — um SBOM curto e falsamente limpo,
 * que é pior que nenhum: ele afirma um inventário completo que não é.
 *
 * A subida é limitada a estas raízes (nunca ao sistema de arquivos inteiro) para que um `node_modules`
 * alheio, acima do repositório, não injete componente fantasma no inventário.
 */
function raizesDeInstalacao(repoRoot, pkgDir) {
  const raizes = new Set();
  const adiciona = (p) => {
    try {
      raizes.add(realpathSync(p));
    } catch {
      raizes.add(path.resolve(p));
    }
  };
  adiciona(repoRoot);
  for (const base of [repoRoot, pkgDir]) {
    const nm = path.join(base, "node_modules");
    try {
      raizes.add(path.dirname(realpathSync(nm)));
    } catch {
      /* sem node_modules aqui — nada a acrescentar */
    }
  }
  return [...raizes];
}

/**
 * Resolve `nome` a partir de `deDir` subindo os `node_modules` como o Node sobe.
 * Devolve { dir, real, manifesto } ou null.
 */
function resolverPacote(nome, deDir, raizes) {
  let atual = path.resolve(deDir);
  const dentro = (p) => raizes.some((r) => p === r || p.startsWith(r + path.sep));
  for (;;) {
    const base = path.basename(atual) === "node_modules" ? atual : path.join(atual, "node_modules");
    const dir = path.join(base, nome);
    const manifesto = lerManifesto(path.join(dir, "package.json"));
    if (manifesto) {
      let real = dir;
      try {
        real = realpathSync(dir);
      } catch {
        /* dir existe (o manifesto foi lido); sem realpath usamos o caminho lógico */
      }
      return { dir, real, manifesto };
    }
    const pai = path.dirname(atual);
    if (atual === pai) return null;
    if (!dentro(pai)) return null;
    atual = pai;
  }
}

/** Normaliza o campo de licença nas TRÊS formas que existem no ecossistema (string SPDX, objeto legado
 *  `{type}` e array legado `licenses[]`). Ler só `license` é o furo que deixa um pacote copyleft passar
 *  declarando pela forma antiga. `null` = NÃO DECLARADA (que o gate trata como desconhecida, não como ok). */
export function normalizarLicenca(manifesto) {
  const bruto = manifesto?.license ?? manifesto?.licence;
  const ids = [];
  if (typeof bruto === "string" && bruto.trim()) ids.push(bruto.trim());
  else if (bruto && typeof bruto === "object" && typeof bruto.type === "string") ids.push(bruto.type.trim());
  const legado = manifesto?.licenses ?? manifesto?.licences;
  if (Array.isArray(legado)) {
    for (const l of legado) {
      if (typeof l === "string" && l.trim()) ids.push(l.trim());
      else if (l && typeof l === "object" && typeof l.type === "string") ids.push(l.type.trim());
    }
  }
  if (!ids.length) return null;
  // Um array legado com N entradas é, na prática, disjunção (escolha uma) — a forma canônica é a expressão.
  return ids.length === 1 ? ids[0] : `(${ids.join(" OR ")})`;
}

/** purl npm com o escopo percent-encoded, como a spec exige (`@escopo/a` → `%40escopo/a`). */
export function purlDe(nome, versao) {
  const [escopo, resto] = nome.startsWith("@") ? nome.slice(1).split("/") : [null, nome];
  const caminho = escopo ? `%40${encodeURIComponent(escopo)}/${encodeURIComponent(resto)}` : encodeURIComponent(resto);
  return `pkg:npm/${caminho}@${versao}`;
}

/**
 * Caminha o fecho instalado a partir de um pacote-alvo.
 *
 * @param {{ repoRoot: string, pkgDir: string }} opts pkgDir ABSOLUTO (o pacote cujo fecho se mede).
 * @returns {{ alvo, componentes: Map<string, object>, arestas: Map<string, Set<string>>, missing: string[] }}
 */
export function medirFecho({ repoRoot, pkgDir }) {
  const alvoManifesto = lerManifesto(path.join(pkgDir, "package.json"));
  if (!alvoManifesto) throw new Error(`pacote-alvo sem package.json legível: ${pkgDir}`);

  const componentes = new Map(); // chave `nome@versao` → componente
  const arestas = new Map(); // bom-ref de quem depende → Set<bom-ref>
  const missing = new Set();
  const visitados = new Map(); // realpath → chave

  const raizes = raizesDeInstalacao(repoRoot, pkgDir);

  const alvo = {
    nome: alvoManifesto.name ?? path.basename(pkgDir),
    versao: alvoManifesto.version ?? "0.0.0",
  };
  alvo.ref = purlDe(alvo.nome, alvo.versao);

  /** Fila BFS. `escopo` propaga: o que só é alcançável por aresta de dev NÃO é runtime. */
  const fila = [];

  function enfileirarDeps(manifesto, deDir, deRef, escopo, incluirDev) {
    const grupos = incluirDev ? [...ARESTAS_RUNTIME, "devDependencies"] : ARESTAS_RUNTIME;
    for (const grupo of grupos) {
      const deps = manifesto?.[grupo];
      if (!deps || typeof deps !== "object") continue;
      for (const nome of Object.keys(deps)) {
        // Aresta de dev (do ALVO) e optionalDependencies nascem `optional`; runtime herda o escopo de quem
        // depende — um pacote só alcançável por dev jamais é promovido a runtime.
        const escopoAresta =
          grupo === "devDependencies" || grupo === "optionalDependencies" ? "optional" : escopo;
        fila.push({
          nome,
          deDir,
          deRef,
          escopo: escopoAresta,
          obrigatoria: grupo === "dependencies",
        });
      }
    }
    // Peer NÃO-opcional é exigido em tempo de execução e o bun o instala: se resolve, faz parte do fecho.
    // Peer que não resolve NÃO é `missing` — quem consome é que deveria prover.
    const peers = manifesto?.peerDependencies;
    const meta = manifesto?.peerDependenciesMeta ?? {};
    if (peers && typeof peers === "object") {
      for (const nome of Object.keys(peers)) {
        if (meta?.[nome]?.optional) continue;
        fila.push({ nome, deDir, deRef, escopo, obrigatoria: false, peer: true });
      }
    }
  }

  enfileirarDeps(alvoManifesto, pkgDir, alvo.ref, "required", true);

  while (fila.length) {
    const item = fila.shift();
    const achado = resolverPacote(item.nome, item.deDir, raizes);
    if (!achado) {
      if (item.obrigatoria) missing.add(item.nome);
      continue;
    }
    const nome = achado.manifesto.name ?? item.nome;
    const versao = achado.manifesto.version ?? "0.0.0";
    const chave = `${nome}@${versao}`;
    const ref = purlDe(nome, versao);

    if (!arestas.has(item.deRef)) arestas.set(item.deRef, new Set());
    arestas.get(item.deRef).add(ref);

    const jaVisto = visitados.get(achado.real);
    if (jaVisto) {
      // Já no fecho: só promove o escopo (alcançado também por runtime ⇒ deixa de ser dev-only).
      const c = componentes.get(jaVisto);
      if (c && item.escopo === "required") c.scope = "required";
      continue;
    }
    visitados.set(achado.real, chave);

    // Primeira-parte = pacote do próprio repo (workspace, resolvido por symlink para FORA de node_modules).
    // Não é alvo de SCA: o código é nosso, advisory de terceiro não se aplica, e um purl `pkg:npm/` de
    // pacote privado consultado na OSV só produz ruído. A régua usa as raízes de instalação, não o repoRoot
    // lógico — num worktree o realpath do workspace cai na árvore do serviço, fora do repoRoot.
    const emRaiz = raizes.some((r) => achado.real === r || achado.real.startsWith(r + path.sep));
    const emNodeModules = achado.real.split(path.sep).includes("node_modules");
    const primeiraParte = emRaiz && !emNodeModules;

    componentes.set(chave, {
      name: nome,
      version: versao,
      key: chave,
      ref,
      purl: purlDe(nome, versao),
      scope: item.escopo,
      license: normalizarLicenca(achado.manifesto),
      firstParty: primeiraParte,
      dir: path.relative(repoRoot, achado.real) || ".",
    });

    // devDependency de TRANSITIVA nunca é instalada pelo gerenciador — incluí-la produziria advisory
    // fantasma para pacote que não existe no disco, o oposto do ruído que este gate combate.
    enfileirarDeps(achado.manifesto, achado.real, ref, item.escopo, false);
  }

  return { alvo, componentes, arestas, missing: [...missing].sort() };
}

/**
 * Enumera o que está INSTALADO no topo de cada raiz de instalação — independente de quem declara.
 *
 * Por que existe, separado do fecho: o fecho parte dos manifestos, então o intruso que NENHUM manifesto
 * declara é invisível para ele — e, por não estar no lockfile, é invisível para o `npm audit` também. Ou
 * seja: os dois scanners que as pessoas realmente rodam concordam em não ver o pacote que está no disco com
 * código dentro. Medido nesta árvore: 50 pacotes no topo fora do `bun.lock`, entre eles `just-install`, que
 * este repositório já pagou para descobrir (ele sombreia o `just` do PATH). Este escopo é o lugar onde esse
 * conjunto aparece em vez de não existir em relatório nenhum.
 *
 * Pacote de WORKSPACE é excluído: ele entra por symlink e nunca consta do lockfile como versão publicada —
 * contá-lo deixaria a métrica permanentemente vermelha, e métrica sempre vermelha ninguém lê.
 */
export function medirInstaladosNoTopo({ repoRoot, pkgDir }) {
  const raizes = raizesDeInstalacao(repoRoot, pkgDir);
  const achados = new Map(); // `nome@versao` → real
  for (const raiz of raizes) {
    const nm = path.join(raiz, "node_modules");
    for (const nome of listarPacotesDe(nm)) {
      const dir = path.join(nm, nome);
      const manifesto = lerManifesto(path.join(dir, "package.json"));
      if (!manifesto?.version) continue;
      let real = dir;
      try {
        real = realpathSync(dir);
      } catch {
        /* sem realpath: trata o caminho lógico */
      }
      if (!real.split(path.sep).includes("node_modules")) continue; // workspace por symlink
      achados.set(`${manifesto.name ?? nome}@${manifesto.version}`, real);
    }
  }
  return achados;
}

function listarPacotesDe(nm) {
  const nomes = [];
  let entradas;
  try {
    entradas = readdirSync(nm, { withFileTypes: true });
  } catch {
    return nomes;
  }
  for (const e of entradas) {
    if (e.name.startsWith(".")) continue; // `.bun`, `.cache`: engrenagem do gerenciador, não pacote
    if (e.name.startsWith("@")) {
      try {
        for (const s of readdirSync(path.join(nm, e.name))) nomes.push(`${e.name}/${s}`);
      } catch {
        /* escopo ilegível */
      }
    } else {
      nomes.push(e.name);
    }
  }
  return nomes;
}

/**
 * Lê as chaves `nome@versao` de um lockfile.
 * Devolve `null` quando NÃO havia lockfile — "zero divergências" e "não conferi" são estados diferentes, e
 * confundi-los é o mesmo erro do gate que libera o que não varreu.
 */
export function lerLockfile(repoRoot, nomeArquivo) {
  const candidatos = nomeArquivo ? [nomeArquivo] : ["bun.lock", "package-lock.json"];
  for (const nome of candidatos) {
    const arquivo = path.join(repoRoot, nome);
    let texto;
    try {
      if (!statSync(arquivo).isFile()) continue;
      texto = readFileSync(arquivo, "utf8");
    } catch {
      continue;
    }
    const dados = nome.endsWith("bun.lock") ? parseBunLock(texto) : parseNpmLock(texto);
    if (dados) return { arquivo: nome, chaves: dados };
  }
  return null;
}

/** `bun.lock` é JSONC (vírgula sobrando). O scrub respeita estado de string — um `,}` DENTRO de uma
 *  string não pode ser confundido com vírgula sobrando, senão o parse quebra e o gate perde o lockfile. */
function retirarVirgulasSobrando(texto) {
  let out = "";
  let emString = false;
  let escapado = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (emString) {
      out += c;
      if (escapado) escapado = false;
      else if (c === "\\") escapado = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') {
      emString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < texto.length && /\s/.test(texto[j])) j++;
      if (texto[j] === "}" || texto[j] === "]") continue; // vírgula sobrando: descarta
    }
    out += c;
  }
  return out;
}

function parseBunLock(texto) {
  let doc;
  try {
    doc = JSON.parse(retirarVirgulasSobrando(texto));
  } catch {
    return null;
  }
  const pacotes = doc?.packages;
  if (!pacotes || typeof pacotes !== "object") return null;
  const chaves = new Set();
  for (const valor of Object.values(pacotes)) {
    const primeiro = Array.isArray(valor) ? valor[0] : valor;
    if (typeof primeiro === "string" && primeiro.includes("@")) chaves.add(primeiro);
  }
  return chaves;
}

function parseNpmLock(texto) {
  let doc;
  try {
    doc = JSON.parse(texto);
  } catch {
    return null;
  }
  const pacotes = doc?.packages;
  if (!pacotes || typeof pacotes !== "object") return null;
  const chaves = new Set();
  for (const [caminho, meta] of Object.entries(pacotes)) {
    const nome = meta?.name ?? caminho.split("node_modules/").pop();
    if (nome && meta?.version) chaves.add(`${nome}@${meta.version}`);
  }
  return chaves;
}
