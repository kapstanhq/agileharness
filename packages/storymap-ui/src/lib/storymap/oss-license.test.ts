// ATAQUE 1 — publicar SEM licença. Um repositório público sem `LICENSE` fica em default de copyright:
// ninguém tem permissão de usar, forkar ou redistribuir, e **nenhum PR externo pode ser mergeado** —
// sob a convenção inbound=outbound a contribuição de entrada se soma à licença de SAÍDA, e não há
// licença de saída. O artefato publicado seria um dump que ninguém pode tocar legalmente, e o dono
// descobriria isso pelo primeiro contribuidor que abrisse um PR. `package.json:license` dizia
// "UNLICENSED" e não existia arquivo nenhum (story-a3331a).
//
// ATAQUE 2 — o mais silencioso: uma dependência **copyleft-forte** (GPL/AGPL/SSPL/LGPL) ou de licença
// **não-OSI** (Hippocratic, Commons Clause, BUSL, Elastic) entra no fecho que a ferramenta publica, e
// o snapshot Apache-2.0 passa a ser uma **violação de licença** — descoberta por terceiros, depois de
// público, quando não há como despublicar. O card pedia esse gate como uma varredura MANUAL de uma vez
// só; uma varredura de uma vez só protege o dia da publicação e nada depois dele. Aqui ele é medido no
// FECHO REAL do disco, em cada rodada da suíte: um `bun add` de dep copyleft fica vermelho na hora.
//
// ATAQUE 3 — reter o benefício e apagar a obrigação: os pacotes **MPL-2.0** do fecho (BlockNote e
// web-push) exigem que os avisos de licença sejam mantidos (MPL-2.0 §3.2/§3.4). Um NOTICE que não os
// nomeia é redistribuição em violação, mesmo com a LICENSE certa. E o gate tem de acompanhar o fecho:
// dep MPL-2.0 nova sem entrada no NOTICE reprova.
//
// Por que Apache-2.0 e não MIT (decisão do dono, registrada aqui porque é o que o texto tem de
// sustentar): (a) §3 outorga patente EXPLÍCITA — relevante para software que executa código autônomo
// e pode virar base de produto, onde o silêncio do MIT sobre patente é risco real; (b) §5 resolve
// inbound=outbound sem exigir CLA, então o projeto aceita PR de terceiro sem papelada.
//
// O detector NÃO é teatro: os casos sintéticos abaixo plantam dep AGPL/Hippocratic numa árvore de
// mentira e exigem reprovação, e plantam dual-license (BSD OR GPL) exigindo aprovação. Um detector
// quebrado — ou um fecho que parou de resolver e virou lista vazia — fica vermelho por construção.
//
// DIVISÃO DE TRABALHO (para ninguém ler isto como uma segunda verdade sobre licença de dependência):
// o gate de CI que reprova dep copyleft nova a cada PR, com baseline por (nome, TERMO) e distinção
// runtime × devDependency, é da frente supply-chain (`scripts/security/check-licenses.mjs`). O que
// ESTE arquivo guarda é o ARTEFATO de licença — a LICENSE e o NOTICE existirem, estarem íntegros, e
// o NOTICE continuar VERDADEIRO diante do fecho que ele descreve. A varredura de copyleft aqui não
// concorre com aquele gate: ela verifica a afirmação que o próprio NOTICE faz por escrito. Um NOTICE
// que afirma "nenhum copyleft-forte no fecho" e não é conferido é pior que nenhum NOTICE.
//
// E há uma terceira frente, que NÃO mora aqui: os arquivos de terceiro COMITADOS na árvore (os bundles
// do xterm em `public/terminal/vendor/`). Este arquivo e o `check-licenses.mjs` leem os dois o mesmo
// `node_modules`, então nenhum dos dois enxergava código de terceiro que viaja DENTRO do repositório —
// foi assim que cinco bundles MIT rodaram sem aviso de copyright nenhum enquanto o NOTICE afirmava que
// nada era redistribuído. Quem guarda essa frente é `vendored-notice.test.ts`, varrendo `git ls-files`.
// Se você veio aqui procurar onde se declara um vendor novo, é lá — e no NOTICE.
//
// Decisão registrada em docs/plans/agileharness-oss/08-extracao-licenca-e-ci.md (fecha WS-H.4).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// `arvore` colide com o construtor de árvore-de-mentira deste arquivo — o alias é para não
// sombrear o discriminador de árvore, que é outra coisa.

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const LICENSE = path.join(REPO_ROOT, "LICENSE");
const NOTICE = path.join(REPO_ROOT, "NOTICE");
const PKG_REL = "packages/storymap-ui";

// ─────────────────────────────────────────────────────────────────────────────
// O fecho publicado: o que este pacote realmente RESOLVE no disco
// ─────────────────────────────────────────────────────────────────────────────
// Medido na ÁRVORE (subindo os `node_modules` como o Node sobe), não no lockfile: o que decide a
// obrigação de licença é o código que executa, e o lockfile não é o disco. Só `dependencies` (+ os
// opcionais e os peers não-opcionais) — devDependency não vai para o artefato que roda.

interface Manifesto {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: Array<{ type?: string } | string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface Pacote {
  nome: string;
  versao: string;
  spdx: string;
}

function leManifesto(dir: string): Manifesto | null {
  const p = path.join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Manifesto;
  } catch {
    return null;
  }
}

function spdxDe(m: Manifesto): string {
  if (typeof m.license === "string") return m.license;
  if (m.license && typeof m.license === "object" && m.license.type) return m.license.type;
  if (Array.isArray(m.licenses)) {
    return m.licenses.map((l) => (typeof l === "string" ? l : l.type ?? "")).join(" AND ");
  }
  // Ausência de campo é DECLARADA, nunca silenciada: um pacote sem licença é tão bloqueante quanto um
  // pacote GPL — não há permissão nenhuma para redistribuí-lo.
  return "(sem campo license)";
}

/** Resolução ao estilo do Node: sobe os `node_modules` a partir de `deDir` até a raiz. */
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * As RAÍZES DE INSTALAÇÃO em que a subida pode andar — a mesma noção que
 * `scripts/security/lib/dep-closure.mjs` já documenta, e pela mesma razão.
 *
 * Um `node_modules` alheio ACIMA do repositório não pode injetar componente fantasma no fecho; mas
 * limitar a subida ao `raiz` LÓGICO faz o fecho parar nas dependências diretas. As duas coisas ao
 * mesmo tempo exigem enumerar as raízes reais em vez de comparar com uma só.
 */
function raizesDeInstalacao(raiz: string, pkgDir: string): string[] {
  const r = new Set<string>([real(raiz)]);
  for (const base of [raiz, pkgDir]) {
    const nm = path.join(base, "node_modules");
    if (existsSync(nm)) r.add(path.dirname(real(nm)));
  }
  return [...r];
}

/**
 * Resolve `nome` a partir de `deDir` subindo os `node_modules` como o Node sobe — pelo caminho REAL.
 *
 * ⚠ ESTA FUNÇÃO JÁ FICOU VERDE MEDINDO 30 DE 684. O bug, medido no repositório extraído em
 * 2026-08-06: o bun instala em layout ISOLADO (`node_modules/.bun/<nome>@<hash>/node_modules/`) e
 * `packages/storymap-ui/node_modules/<dep>` é um SYMLINK para lá. Subir pelo caminho LÓGICO a partir
 * do symlink nunca entra no diretório onde as TRANSITIVAS moram: o fecho parava nas ~30 dependências
 * diretas e o gate de copyleft declarava "limpo" um fecho que ele não tinha lido. Era verde por não
 * medir — exatamente o desfecho que o piso `toBeGreaterThan(300)` abaixo existe para tornar visível,
 * e foi ele quem pegou.
 *
 * Duas correções, as duas necessárias:
 *   1. partir do `realpath` (entra no `.bun/<nome>@<hash>/node_modules/`);
 *   2. não concatenar `node_modules` quando já se está DENTRO de um (`.bun/x/node_modules` viraria
 *      `.bun/x/node_modules/node_modules`, que não existe, e a subida pularia o nível certo).
 *
 * No layout HOISTED (este monorepo) o realpath de um diretório real é ele mesmo: o comportamento
 * anterior é preservado byte a byte, e é por isso que o teste seguia verde aqui enquanto o repo
 * extraído media o vazio.
 */
function resolveDep(deDir: string, nome: string, raizes: string[]): string | null {
  let atual = real(deDir);
  const dentro = (p: string) => raizes.some((r) => p === r || p.startsWith(r + path.sep));
  for (;;) {
    const base = path.basename(atual) === "node_modules" ? atual : path.join(atual, "node_modules");
    const cand = path.join(base, nome);
    if (existsSync(path.join(cand, "package.json"))) return cand;
    const pai = path.dirname(atual);
    if (pai === atual || !dentro(pai)) return null;
    atual = pai;
  }
}

/**
 * O que o pacote-alvo arrasta para o artefato que roda, e o que declarou e não está no disco.
 *
 * `substituidos` são os pacotes que a PUBLICAÇÃO troca por um stub sem dependências (ver
 * `substituicoesDaPublicacao` em `oss-tree.ts`). Eles não entram no fecho e não descem: o stub não tem
 * dependência nenhuma, então some com ele tudo que SÓ ele alcançava. Vazio por default — e vazio
 * SEMPRE no artefato, onde o override já está aplicado e o disco é o fecho publicado.
 */
function fechoPublicado(
  raiz: string,
  pkgRel: string,
  substituidos: ReadonlySet<string> = new Set(),
): { pacotes: Map<string, Pacote>; ausentes: Map<string, boolean> } {
  const pkgDir = path.join(raiz, pkgRel);
  const alvo = leManifesto(pkgDir);
  if (!alvo) throw new Error(`manifesto ausente em ${pkgDir}`);
  const raizes = raizesDeInstalacao(raiz, pkgDir);

  const pacotes = new Map<string, Pacote>();
  /** nome → era opcional? (dep opcional ausente é normal: binário de outra plataforma) */
  const ausentes = new Map<string, boolean>();

  const fila: Array<{ deDir: string; nome: string; opcional: boolean }> = [];
  const enfileira = (deDir: string, m: Manifesto) => {
    for (const nome of Object.keys(m.dependencies ?? {})) fila.push({ deDir, nome, opcional: false });
    for (const nome of Object.keys(m.optionalDependencies ?? {})) fila.push({ deDir, nome, opcional: true });
    for (const nome of Object.keys(m.peerDependencies ?? {})) {
      const opcional = m.peerDependenciesMeta?.[nome]?.optional === true;
      fila.push({ deDir, nome, opcional });
    }
  };
  enfileira(pkgDir, alvo);

  const visitados = new Set<string>();
  while (fila.length > 0) {
    const { deDir, nome, opcional } = fila.shift()!;
    // A publicação substitui este pacote por um stub: ele não viaja, e nada que dependa só dele viaja.
    // Não é "ausente" (isso seria fecho não medido) — é fecho que não existe do outro lado.
    if (substituidos.has(nome)) continue;
    const dir = resolveDep(deDir, nome, raizes);
    if (!dir) {
      // Só reporta ausência quando ninguém mais resolveu o pacote (outro pai pode ter resolvido).
      if (!ausentes.has(nome)) ausentes.set(nome, opcional);
      else if (!opcional) ausentes.set(nome, false);
      continue;
    }
    // Dedup pelo caminho REAL: no layout isolado o mesmo pacote é alcançável por vários symlinks, e
    // um `visitados` keyed pelo caminho lógico re-caminharia a mesma subárvore uma vez por aresta.
    const chave = real(dir);
    if (visitados.has(chave)) continue;
    visitados.add(chave);
    const m = leManifesto(dir);
    if (!m) continue;
    const versao = m.version ?? "?";
    pacotes.set(`${m.name ?? nome}@${versao}`, { nome: m.name ?? nome, versao, spdx: spdxDe(m) });
    enfileira(dir, m);
  }
  for (const nome of pacotes.keys()) ausentes.delete(nome.split("@").slice(0, -1).join("@"));
  return { pacotes, ausentes };
}

// ─────────────────────────────────────────────────────────────────────────────
// A régua de licença
// ─────────────────────────────────────────────────────────────────────────────
// PERMISSIVA: pode ser redistribuída sob Apache-2.0 sem obrigação além do aviso de copyright.
const PERMISSIVAS = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "Apache 2.0",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Zlib",
  "WTFPL",
]);
// ATRIBUIÇÃO: compatível com Apache-2.0, mas o copyleft é por ARQUIVO e exige manter os avisos —
// tem de aparecer no NOTICE.
const ATRIBUICAO = new Set(["MPL-2.0", "MPL-1.1", "EPL-2.0", "CDDL-1.0"]);

type Veredito = "permissiva" | "atribuicao" | "proibida";

/**
 * Classifica UM identificador SPDX simples. Não entende expressão — quem quebra `OR`/`AND` é
 * `classificaExpressao`.
 */
function classificaSimples(id: string): Veredito {
  const limpo = id.trim().replace(/^\(|\)$/g, "").trim();
  if (PERMISSIVAS.has(limpo)) return "permissiva";
  if (ATRIBUICAO.has(limpo)) return "atribuicao";
  // Tudo que não está declarado acima é PROIBIDO por default (fail-closed): licença nova e
  // desconhecida no fecho publicado é uma decisão humana, não um silêncio do gate. É o que pega
  // GPL/AGPL/SSPL/LGPL, as não-OSI (Hippocratic, Commons Clause, BUSL, Elastic) e a ausência de campo.
  return "proibida";
}

/**
 * Classifica a expressão SPDX inteira. `A OR B` deixa a ESCOLHA com o redistribuidor (é assim que
 * `node-forge`, "BSD-3-Clause OR GPL-2.0", é legítimo num projeto Apache: elege-se o BSD). `A AND B`
 * impõe as duas, então a pior manda.
 */
function classificaExpressao(expr: string): Veredito {
  const ordem: Record<Veredito, number> = { permissiva: 0, atribuicao: 1, proibida: 2 };
  const pior = (vs: Veredito[]) => vs.reduce((a, b) => (ordem[b] > ordem[a] ? b : a), "permissiva" as Veredito);
  const melhor = (vs: Veredito[]) => vs.reduce((a, b) => (ordem[b] < ordem[a] ? b : a), "proibida" as Veredito);

  const alternativas = expr.split(/\s+OR\s+/i);
  if (alternativas.length > 1) return melhor(alternativas.map(classificaExpressao));
  const conjuntos = expr.split(/\s+AND\s+/i);
  if (conjuntos.length > 1) return pior(conjuntos.map(classificaExpressao));
  return classificaSimples(expr);
}

// ─────────────────────────────────────────────────────────────────────────────
// Árvore de mentira, para provar que o detector reprova de verdade
// ─────────────────────────────────────────────────────────────────────────────
let arvores: string[] = [];
afterEach(() => {
  for (const dir of arvores) rmSync(dir, { recursive: true, force: true });
  arvores = [];
});

function arvore(alvo: Manifesto, instalados: Record<string, Manifesto>): string {
  const raiz = mkdtempSync(path.join(tmpdir(), "ah-licenca-"));
  arvores.push(raiz);
  const pkgDir = path.join(raiz, PKG_REL);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(alvo));
  for (const [nome, m] of Object.entries(instalados)) {
    const d = path.join(raiz, "node_modules", nome);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "package.json"), JSON.stringify(m));
  }
  return raiz;
}

// ─────────────────────────────────────────────────
// O fecho como ele está INSTALADO AQUI é o fecho publicado
// ─────────────────────────────────────────────────
// Não há extração a simular desde a issue #1: o override que remove um pacote do fecho vive nos
// `overrides` do package.json desta raiz e o disco já o reflete. A medição sobre a árvore real é
// integral; as árvores de mentira abaixo chamam `fechoPublicado` cru.
/** Os overrides `npm:` do package.json da raiz — o que a publicação troca por um stub. */
function substituicoesDoManifesto(): Map<string, string> {
  const raiz = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { overrides?: Record<string, string> };
  return new Map(Object.entries(raiz.overrides ?? {}).filter(([, v]) => v.startsWith("npm:")));
}
const SUBSTITUIDOS = (): ReadonlySet<string> => new Set<string>();
const fechoDoArtefato = () => fechoPublicado(REPO_ROOT, PKG_REL, SUBSTITUIDOS());

// O conjunto REVISADO: um override `npm:` é um buraco na medição de licença (o pacote real deixa de
// ser medido), então ele não pode crescer sozinho. Um override novo reprova aqui até alguém escrevê-lo
// nesta linha — de propósito.
const SUBSTITUICOES_REVISADAS = ["sharp"];

describe("LICENSE Apache-2.0 aplicada antes do primeiro push público (story-a3331a)", () => {
  it("[ATAQUE] o repositório NÃO vai a público sem LICENSE — o arquivo existe na raiz", () => {
    expect(
      existsSync(LICENSE),
      "sem LICENSE o repositório público fica em default de copyright: uso não autorizado e nenhum PR externo mergeável",
    ).toBe(true);
  });

  it("é a Apache-2.0 ÍNTEGRA, não um resumo nem um link", () => {
    const txt = readFileSync(LICENSE, "utf8");
    // Um "resumo da licença" não é a licença: a §4(a) obriga entregar uma CÓPIA do texto a cada
    // destinatário. Estes marcadores são as âncoras do texto oficial, incluindo o fim das cláusulas.
    expect(txt).toContain("Apache License");
    expect(txt).toContain("Version 2.0, January 2004");
    expect(txt).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(txt).toContain("END OF TERMS AND CONDITIONS");
    expect(txt.split("\n").length).toBeGreaterThan(150);
  });

  it("a outorga de PATENTE (§3) viaja no texto — é o motivo declarado de escolher Apache sobre MIT", () => {
    const txt = readFileSync(LICENSE, "utf8");
    expect(txt).toContain("3. Grant of Patent License");
    expect(txt).toMatch(/irrevocable\s+\(except as stated in this section\) patent license/);
    // A cláusula de retaliação é parte do valor: quem processa por patente perde a licença.
    expect(txt).toMatch(/institute patent litigation[\s\S]*shall terminate/);
  });

  it("a §5 viaja — é ela que fecha inbound=outbound SEM exigir CLA de quem contribui", () => {
    const txt = readFileSync(LICENSE, "utf8");
    expect(txt).toContain("5. Submission of Contributions");
    expect(txt).toMatch(/any Contribution intentionally submitted for inclusion in the Work[\s\S]*under the terms and conditions of\s+this License, without any additional terms or conditions/);
  });

  it("o apêndice está PREENCHIDO — nenhum placeholder do template sobrou", () => {
    const txt = readFileSync(LICENSE, "utf8");
    // Publicar com "[yyyy] [name of copyright owner]" deixa a titularidade indefinida no arquivo que
    // outorga a licença — o erro clássico de quem copia o template e não lê o apêndice.
    expect(txt).not.toContain("[yyyy]");
    expect(txt).not.toContain("[name of copyright owner]");
    expect(txt).not.toContain("{yyyy}");
    expect(txt).toMatch(/Copyright\s+20\d\d\s+\S/);
  });
});

describe("gate de copyleft sobre o fecho REALMENTE publicado (story-a3331a)", () => {
  it("o fecho é medido de verdade — um fecho vazio não passa como 'limpo'", () => {
    const { pacotes, ausentes } = fechoDoArtefato();
    // Ordem de grandeza medida: 375 pacotes no fecho de produção. Se a resolução parar de subir os
    // node_modules, o fecho vira uma lista curta e FALSAMENTE limpa — o pior desfecho possível para
    // um gate de licença, porque ele fica verde exatamente quando parou de medir.
    expect(pacotes.size).toBeGreaterThan(300);
    for (const esperado of ["next", "react", "@blocknote/core", "web-push"]) {
      expect([...pacotes.values()].map((p) => p.nome)).toContain(esperado);
    }
    // Dependência DECLARADA e ausente do disco só é aceitável quando OPCIONAL (binário de outra
    // plataforma). Uma não-opcional ausente é fecho que não foi medido — não se afirma nada sobre ela.
    const naoOpcionaisAusentes = [...ausentes.entries()].filter(([, opcional]) => !opcional).map(([n]) => n);
    expect(naoOpcionaisAusentes, "dep não-opcional ausente do disco: o gate não pode afirmar a licença dela").toEqual([]);
  });

  it("os overrides `npm:` do manifesto são EXATAMENTE os revisados — override novo exige revisão", () => {
    const nomes = [...substituicoesDoManifesto().keys()].sort();
    expect(
      nomes,
      "mudou o conjunto de pacotes que o package.json troca por stub. Cada nome aí deixa de ser medido pelo " +
        "gate de licença, então isto é revisão e não detalhe: confirme o motivo no `overrides` da raiz e " +
        "escreva o nome novo em SUBSTITUICOES_REVISADAS.",
    ).toEqual(SUBSTITUICOES_REVISADAS);
  });
  it("[ATAQUE] enquanto o `sharp` viajar como STUB, ninguém pode importar `next/image`", () => {
    // A ÚNICA precondição do override, virada trava. O `sharp` é apontado para um stub porque o
    // otimizador de imagem é a única coisa que ele serve e este produto não usa `next/image` em lugar
    // nenhum. No dia em que alguém importar, o otimizador falha EM RUNTIME, no artefato publicado, com
    // um erro que não nomeia o override — o pior formato possível: longe daqui, tarde, e sem pista.
    //
    // A resposta mora nos `overrides` do package.json da raiz — o único lugar, desde a issue #1.
    const doExtrator = false;
    const raiz = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      overrides?: Record<string, string>;
    };
    const doArtefato = (raiz.overrides ?? {}).sharp?.startsWith("npm:") === true;

    if (!doExtrator && !doArtefato) {
      // Não é pulo silencioso: sem substituição a proibição perde a razão de ser, e QUEM a tirou tem de
      // ter confirmado que o otimizador voltou a funcionar. O caso declara isso em vez de sumir.
      expect(
        SUBSTITUICOES_REVISADAS,
        "o `sharp` deixou de ser substituído em toda parte — remova também esta proibição (e confirme " +
          "que o otimizador de imagem voltou a ter binário)",
      ).not.toContain("sharp");
      return;
    }

    const raizSrc = path.join(REPO_ROOT, PKG_REL, "src");
    const arquivos: string[] = [];
    const desce = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) desce(abs);
        else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) arquivos.push(abs);
      }
    };
    desce(raizSrc);
    // Varre o DISCO e não `git grep`: um arquivo novo ainda não rastreado importaria `next/image` e
    // passaria batido — e é justamente no arquivo novo que isso entra.
    expect(arquivos.length, "não varri arquivo nenhum — a trava ficaria verde por não medir").toBeGreaterThan(50);

    // Só o ESPECIFICADOR, entre aspas. `_next/image` do matcher do middleware e o `next/image-optimizable`
    // dos comentários `eslint-disable` NÃO são importações, e proibi-los seria a trava mentindo.
    const usos = arquivos
      .filter((f) => /["']next\/image["']/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f))
      .sort();
    expect(
      usos,
      "`next/image` importado enquanto o `sharp` viaja como stub: no artefato publicado o otimizador " +
        "não tem binário e falha em runtime. Ou remova o import, ou remova o override do package.json da raiz " +
        "(`DA_EXTRACAO`) — e aí reabra a questão da LGPL que ele mantém fora do fecho.",
    ).toEqual([]);
  });

  it("[ATAQUE] nenhuma licença copyleft-forte ou não-OSI no fecho publicado", () => {
    const { pacotes } = fechoDoArtefato();
    const proibidos = [...pacotes.entries()]
      .filter(([, p]) => classificaExpressao(p.spdx) === "proibida")
      .map(([chave, p]) => `${chave} → ${p.spdx}`)
      .sort();
    expect(
      proibidos,
      "dep copyleft-forte/não-OSI no fecho torna o snapshot Apache-2.0 uma violação de licença",
    ).toEqual([]);
  });

  it("o detector reprova de verdade: AGPL e Hippocratic PLANTADAS no fecho ficam vermelhas", () => {
    const raiz = arvore(
      { name: "alvo", version: "1.0.0", dependencies: { limpa: "^1", venenosa: "^1" } },
      {
        limpa: { name: "limpa", version: "1.0.0", license: "MIT", dependencies: { fundo: "^1" } },
        venenosa: { name: "venenosa", version: "2.0.0", license: "Hippocratic-2.1" },
        // A copyleft-forte entra por TRANSITIVA — o caminho que ninguém revisa.
        fundo: { name: "fundo", version: "3.0.0", license: "AGPL-3.0-only" },
      },
    );
    const { pacotes } = fechoPublicado(raiz, PKG_REL);
    const proibidos = [...pacotes.values()].filter((p) => classificaExpressao(p.spdx) === "proibida").map((p) => p.nome);
    expect(proibidos.sort()).toEqual(["fundo", "venenosa"]);
  });

  it("a substituição derruba o EXCLUSIVO e preserva o COMPARTILHADO — o mecanismo, numa árvore controlada", () => {
    // A prova que a árvore real não pode dar sem se comparar consigo mesma. Aqui o compartilhado é
    // plantado de propósito: `comum` é alcançável por `substituido` E por `outro`. Se a substituição
    // fosse um filtro sobre o RESULTADO — em vez de um corte na travessia —, ela levaria `comum` junto,
    // e o gate deixaria de medir um pacote que VIAJA. É esse o bug que este caso existe para pegar.
    const raiz = arvore(
      { name: "alvo", version: "1.0.0", dependencies: { substituido: "^1", outro: "^1" } },
      {
        substituido: {
          name: "substituido",
          version: "1.0.0",
          license: "MIT",
          dependencies: { comum: "^1" },
          // Copyleft por baixo do substituído: é ela que a substituição existe para tirar do fecho.
          optionalDependencies: { exclusivo: "^1" },
        },
        outro: { name: "outro", version: "1.0.0", license: "MIT", dependencies: { comum: "^1" } },
        comum: { name: "comum", version: "1.0.0", license: "MIT" },
        exclusivo: { name: "exclusivo", version: "1.0.0", license: "LGPL-3.0-or-later" },
      },
    );

    const sem = [...fechoPublicado(raiz, PKG_REL).pacotes.values()].map((pkg) => pkg.nome).sort();
    expect(sem).toEqual(["comum", "exclusivo", "outro", "substituido"]);

    const com = [...fechoPublicado(raiz, PKG_REL, new Set(["substituido"])).pacotes.values()]
      .map((pkg) => pkg.nome)
      .sort();
    expect(com, "a substituição levou junto um pacote que outro caminho ainda alcança").toEqual(["comum", "outro"]);

    // E o `ausentes` não pode acusar o substituído: ele não está faltando do disco, ele não existe do
    // outro lado. Confundir as duas coisas faria o piso de "fecho medido de verdade" reprovar por um
    // pacote que a publicação remove de propósito.
    expect([...fechoPublicado(raiz, PKG_REL, new Set(["substituido"])).ausentes.keys()]).not.toContain("substituido");
  });

  it("dual-license com opção permissiva é APROVADA (elege-se a permissiva) — `AND` com GPL não é", () => {
    // `node-forge` é "(BSD-3-Clause OR GPL-2.0)": um projeto Apache elege o BSD e está em regra.
    // Tratar `OR` como contaminação reprovaria pacotes legítimos e o gate seria desligado por atrito —
    // é assim que gates morrem. Já `AND` impõe as duas licenças: a pior manda.
    expect(classificaExpressao("(BSD-3-Clause OR GPL-2.0)")).toBe("permissiva");
    expect(classificaExpressao("MIT OR Apache-2.0")).toBe("permissiva");
    expect(classificaExpressao("MIT AND GPL-3.0-only")).toBe("proibida");
    expect(classificaExpressao("LGPL-3.0-or-later")).toBe("proibida");
    expect(classificaExpressao("SSPL-1.0")).toBe("proibida");
    expect(classificaExpressao("(sem campo license)")).toBe("proibida");
    expect(classificaExpressao("MPL-2.0")).toBe("atribuicao");
  });
});

describe("NOTICE atribui os MPL-2.0 que a ferramenta redistribui (story-a3331a)", () => {
  it("[ATAQUE] o NOTICE existe — a Apache-2.0 §4(d) o torna parte da redistribuição", () => {
    expect(existsSync(NOTICE), "sem NOTICE não há onde a atribuição de terceiros sobreviver ao fork").toBe(true);
  });

  it("[ATAQUE] TODO pacote de licença-por-arquivo do fecho é NOMEADO no NOTICE", () => {
    const { pacotes } = fechoDoArtefato();
    const texto = readFileSync(NOTICE, "utf8");
    const exigemAtribuicao = [...new Set(
      [...pacotes.values()].filter((p) => classificaExpressao(p.spdx) === "atribuicao").map((p) => p.nome),
    )].sort();

    // Não-vacuidade: hoje são 4 (BlockNote core/mantine/react + web-push). Se a lista esvaziar, ou o
    // fecho parou de ser medido ou as deps saíram — nos dois casos alguém confere, não fica verde à toa.
    expect(exigemAtribuicao.length).toBeGreaterThan(0);
    const faltando = exigemAtribuicao.filter((nome) => !texto.includes(nome));
    expect(
      faltando,
      "MPL-2.0 §3.2/§3.4 exigem manter os avisos: dep de licença-por-arquivo sem entrada no NOTICE é redistribuição em violação",
    ).toEqual([]);
    // A licença de cada um tem de estar dita, não só o nome — quem lê o NOTICE precisa saber o regime.
    expect(texto).toContain("MPL-2.0");
  });

  it("o NOTICE aponta para onde o texto de terceiros vive — nome solto não cumpre a obrigação", () => {
    const texto = readFileSync(NOTICE, "utf8");
    // Sem a URL do texto original, o destinatário do fork não tem como obter a licença que o NOTICE cita.
    expect(texto).toContain("https://mozilla.org/MPL/2.0/");
    expect(texto).toMatch(/Apache License,? Version 2\.0/);
  });
});

// ── a licença no manifesto DO PACOTE ─────────────────────────────────────────────────────────────
//
// A injeção cobria só o `package.json` da RAIZ. O pacote — que É o AgileHarness, e é o que qualquer
// gerador de SBOM descreve como o componente publicado — saía sem `license`, enquanto o CONTRIBUTING
// promete que pacote sem licença reprova. O valor tem de ser o MESMO derivado do arquivo LICENSE que
// viajou: um `"license"` digitado à mão que não corresponda ao arquivo é pior que ausente.
describe("a licença está declarada no manifesto do PACOTE, não só no da raiz", () => {
  it("o `license` do pacote é o MESMO SPDX derivado do arquivo LICENSE da raiz", () => {
    const raiz = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { license?: string };
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, PKG_REL, "package.json"), "utf8")) as { license?: string };
    expect(raiz.license).toBe("Apache-2.0");
    expect(pkg.license, "pacote sem licença no manifesto — é o que o CONTRIBUTING promete reprovar").toBe(raiz.license);
  });
});
