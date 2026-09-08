// ATAQUE — redistribuir código de terceiro NU, com o NOTICE afirmando o contrário. Cinco bundles do
// xterm.js estavam RASTREADOS em `packages/storymap-ui/public/terminal/vendor/` — logo viajam em todo
// clone, tarball e fork — com ZERO ocorrência de "copyright" dentro deles, enquanto o NOTICE dizia por
// escrito que "as dependências NÃO são redistribuídas aqui". Duas coisas erradas de uma vez: a MIT
// impõe UMA obrigação, que o aviso de copyright e o texto da permissão acompanhem CADA cópia do
// software, e foi exatamente essa que se perdeu; e o arquivo cuja função é contar isso ao leitor
// contava o oposto. Não é formalidade — é a licença descumprida no único ponto em que ela pede algo, em
// artefato já publicado, onde não há como despublicar.
//
// POR QUE NENHUM GATE VIU: `oss-license.test.ts` mede o FECHO DE DEPENDÊNCIAS e
// `scripts/security/check-licenses.mjs` mede o mesmo fecho — os dois leem o que o npm instala em
// `node_modules`, e NENHUM olha para os arquivos que o git rastreia. Código de terceiro comitado na
// árvore era ponto cego por construção: `check-licenses --pkg packages/storymap-ui` saía
// "✓ licenças aprovadas / 684 pacotes" com os cinco bundles nus ao lado dele.
//
// O QUE ESTE ARQUIVO GUARDA: os arquivos que VIAJAM. Varre `git ls-files`, separa os que carregam
// código de terceiro (caminho de vendor, minificado, ou banner de licença alheia) e exige de cada um as
// duas metades da obrigação — o aviso DENTRO do arquivo e a linha no NOTICE. As três direções de erro
// são medidas em separado porque cada uma falha sozinha: arquivo novo sem declaração, declaração sem
// arquivo, e — a que aconteceu — arquivo declarado com o aviso apagado.
//
// A cerca é PROVADA, não afirmada: os casos sintéticos abaixo montam árvores de mentira (bundle nu,
// bundle não-declarado, entrada órfã) e exigem reprovação. E o inventário do NOTICE é cruzado com a
// varredura nos DOIS sentidos: um varredor que pare de enxergar `vendor/` fica VERMELHO em vez de ficar
// verde medindo nada — o desfecho que esta casa já pagou uma vez, quando o resolvedor do
// `oss-license.test.ts` media 30 de 684 pacotes e declarava o fecho limpo.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const NOTICE = path.join(REPO_ROOT, "NOTICE");
const LICENSE = path.join(REPO_ROOT, "LICENSE");

/**
 * O pacote que o NOTICE da raiz representa.
 *
 * No repositório EXTRAÍDO (o artefato OSS) existe só ele, e a varredura cobre a árvore inteira. No
 * umbrella existem outros produtos sob `packages/`, que NÃO viajam na extração e têm licenciamento
 * próprio — varrê-los aqui faria este teste falar por um NOTICE que não é o deles.
 */
const PACOTE_DO_ARTEFATO = "storymap-ui";

// ─────────────────────────────────────────────────────────────────────────────
// A varredura: quais arquivos RASTREADOS carregam código de terceiro
// ─────────────────────────────────────────────────────────────────────────────
// Heurística honesta, não exaustiva: ela pega o que é reconhecível de fora — pasta de vendor, bundle
// minificado, banner de licença alheia. Trecho copiado à mão e sem banner nenhum ela NÃO pega, e é por
// isso que a regra escrita no NOTICE é "arquivo vendorado ganha uma linha", não "o teste adivinha".

const CAMINHO_DE_VENDOR = /(^|\/)(vendor|vendored|third[_-]party|3rdparty)(\/|$)/i;
const NOME_MINIFICADO = /\.min\.(js|mjs|css)$/i;
/** Onde um bundle publicado pode estar: código executável, não fonte com JSX de linha longa. */
const EXTENSAO_DE_BUNDLE = /\.(js|mjs|cjs|css)$/i;
const EXTENSAO_DE_TEXTO = /\.(js|mjs|cjs|jsx|ts|tsx|css|scss|html|py|sh|go|rs|java|swift|kt)$/i;
/**
 * Uma linha maior que isto num arquivo executável é bundle, não estilo de escrita. Medido na árvore:
 * o maior arquivo-fonte de `storymap-ui` tem linha de 1321 chars (uma tabela literal), e o menor
 * bundle vendorado, `addon-search.js`, tem 12110. O corte fica no vale entre os dois.
 */
const LINHA_DE_BUNDLE = 2000;
const TAMANHO_MINIMO = 2048;
/**
 * O banner de atribuição só conta no CABEÇALHO do arquivo — é onde a convenção o põe, porque ele fala
 * pelo arquivo INTEIRO (o do `xterm.css` está no byte 0, como o dos bundles).
 *
 * O corte não é estético, é o que separa atribuição de MENÇÃO: medido ao extrair o artefato OSS, ESTE
 * PRÓPRIO arquivo se autodenunciava — as árvores de mentira aqui embaixo contêm `Copyright (c)` e
 * `SPDX-License-Identifier` como texto de fixture, no meio do corpo. Varredor que confunde citação com
 * atribuição gera vermelho crônico, e vermelho crônico é gate desligado. As outras duas redes (caminho
 * de vendor e minificado) não dependem deste corte, e a regra escrita no NOTICE — vendor novo ganha uma
 * linha — continua valendo para o que nenhuma heurística alcança.
 */
const CABECALHO = 4096;

export type Motivo = "vendor" | "minificado" | "aviso-de-terceiro";

export interface Candidato {
  rel: string;
  motivo: Motivo;
  conteudo: string;
}

/** O titular do projeto, lido do apêndice preenchido da LICENSE — não escrito à mão em dois lugares. */
export function donoDoProjeto(textoDaLicense: string): string {
  const m = /^\s*Copyright\s+\d{4}\s+(.+?)\s*$/m.exec(textoDaLicense);
  return m ? m[1] : "";
}

/** Todo aviso de copyright do arquivo nomeia o dono do projeto? Então não é código de terceiro. */
function soTemCopyrightDoProjeto(conteudo: string, dono: string): boolean {
  const avisos = conteudo.match(/^.*Copyright\b.*$/gim) ?? [];
  if (avisos.length === 0) return false;
  return dono !== "" && avisos.every((linha) => linha.includes(dono));
}

function maiorLinha(texto: string): number {
  let maior = 0;
  for (const linha of texto.split("\n")) if (linha.length > maior) maior = linha.length;
  return maior;
}

export function varreCandidatos(raiz: string, relativos: string[], dono: string): Candidato[] {
  const achados: Candidato[] = [];
  for (const rel of relativos) {
    const foraDoArtefato = /^packages\/([^/]+)\//.exec(rel);
    if (foraDoArtefato && foraDoArtefato[1] !== PACOTE_DO_ARTEFATO) continue;

    const abs = path.join(raiz, rel);
    let tamanho: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      tamanho = st.size;
    } catch {
      continue;
    }

    const bytes = readFileSync(abs);
    // Binário não pode carregar aviso em comentário: fonte, ícone e imagem são declarados à mão no
    // NOTICE quando entram, e a régua deles não é esta.
    if (bytes.includes(0)) continue;
    const conteudo = bytes.toString("utf8");

    let motivo: Motivo | null = null;
    if (CAMINHO_DE_VENDOR.test(rel)) motivo = "vendor";
    else if (NOME_MINIFICADO.test(rel)) motivo = "minificado";
    else if (EXTENSAO_DE_BUNDLE.test(rel) && tamanho > TAMANHO_MINIMO && maiorLinha(conteudo) > LINHA_DE_BUNDLE) {
      motivo = "minificado";
    } else if (EXTENSAO_DE_TEXTO.test(rel) && tamanho > TAMANHO_MINIMO) {
      const cabecalho = conteudo.slice(0, CABECALHO);
      if (/@license\b|SPDX-License-Identifier|Copyright \(c\)/i.test(cabecalho) && !soTemCopyrightDoProjeto(cabecalho, dono)) {
        motivo = "aviso-de-terceiro";
      }
    }
    if (motivo) achados.push({ rel, motivo, conteudo });
  }
  return achados;
}

// ─────────────────────────────────────────────────────────────────────────────
// O inventário declarado no NOTICE
// ─────────────────────────────────────────────────────────────────────────────
// Gramática de UMA linha, legível por humano e por regex:
//   * <caminho/com/extensao> — <componente versao> — <SPDX>
// Os outros marcadores do NOTICE (os pacotes MPL, por exemplo) têm um travessão só e não têm extensão
// de arquivo no primeiro campo — não são lidos como entrada de inventário.

export interface EntradaDeclarada {
  rel: string;
  componente: string;
  spdx: string;
}

const LINHA_DE_INVENTARIO = /^\s*\*\s+([\w.@-]+(?:\/[\w.@-]+)+\.[a-z0-9]+)\s+—\s+(.+?)\s+—\s+([\w.+ ()-]+?)\s*$/gm;

export function inventarioDoNotice(texto: string): EntradaDeclarada[] {
  const entradas: EntradaDeclarada[] = [];
  for (const m of texto.matchAll(LINHA_DE_INVENTARIO)) {
    entradas.push({ rel: m[1], componente: m[2].trim(), spdx: m[3].trim() });
  }
  return entradas;
}

// ─────────────────────────────────────────────────────────────────────────────
// A obrigação de cada licença, escrita como marcador conferível
// ─────────────────────────────────────────────────────────────────────────────
// Só entram aqui as licenças cuja obrigação é PRESERVAR O AVISO — que é o que um arquivo vendorado
// pode cumprir sozinho. SPDX desconhecido cai no fail-closed lá embaixo: licença nova é decisão
// humana, não silêncio do gate.
const MARCADORES_EXIGIDOS: Record<string, RegExp[]> = {
  MIT: [/Permission is hereby granted/i, /above copyright notice and this permission notice/i],
  ISC: [/Permission to use, copy, modify/i, /copyright notice and this permission notice appear in all copies/i],
  "BSD-2-Clause": [/must retain the above copyright notice/i],
  "BSD-3-Clause": [/must retain the above copyright notice/i],
  "Apache-2.0": [/Apache License/i],
  "MPL-2.0": [/Mozilla Public License/i],
};

export interface Falha {
  rel: string;
  motivo: string;
}

export interface Relatorio {
  examinados: Candidato[];
  declarados: EntradaDeclarada[];
  semAviso: Falha[];
  naoDeclarados: string[];
  declaradosAusentes: string[];
  naoVarridos: string[];
}

export function auditar(args: { raiz: string; relativos: string[]; notice: string; dono: string }): Relatorio {
  const { raiz, relativos, notice, dono } = args;
  const examinados = varreCandidatos(raiz, relativos, dono);
  const declarados = inventarioDoNotice(notice);
  const porCaminho = new Map(declarados.map((e) => [e.rel, e]));
  const rastreados = new Set(relativos);

  const semAviso: Falha[] = [];
  const naoDeclarados: string[] = [];

  for (const c of examinados) {
    const decl = porCaminho.get(c.rel);
    if (!decl) {
      naoDeclarados.push(c.rel);
      continue;
    }
    if (!/Copyright/i.test(c.conteudo)) {
      semAviso.push({ rel: c.rel, motivo: "nenhum aviso de copyright dentro do arquivo" });
      continue;
    }
    // O nome do componente declarado tem de aparecer no arquivo. Não confere VERSÃO: o banner que o
    // upstream escreve nem sempre a traz (o `xterm.css` não traz), e exigir o que o upstream não dá
    // transformaria a régua em atrito — a versão é conferida por quem troca o bundle, não por aqui.
    const nome = decl.componente.replace(/\s+\S*\d[\w.-]*$/, "").trim();
    if (nome && !c.conteudo.includes(nome)) {
      semAviso.push({ rel: c.rel, motivo: `o arquivo não menciona o componente declarado (${nome})` });
      continue;
    }
    const marcadores = MARCADORES_EXIGIDOS[decl.spdx];
    if (!marcadores) {
      semAviso.push({ rel: c.rel, motivo: `SPDX não reconhecido no NOTICE: ${decl.spdx}` });
      continue;
    }
    const faltando = marcadores.filter((re) => !re.test(c.conteudo));
    if (faltando.length > 0) {
      semAviso.push({ rel: c.rel, motivo: `texto da licença ${decl.spdx} incompleto no arquivo` });
    }
  }

  const varridos = new Set(examinados.map((c) => c.rel));
  const declaradosAusentes = declarados.filter((e) => !rastreados.has(e.rel) || !existsSync(path.join(raiz, e.rel))).map((e) => e.rel);
  const naoVarridos = declarados.filter((e) => rastreados.has(e.rel) && !varridos.has(e.rel)).map((e) => e.rel);

  return { examinados, declarados, semAviso, naoDeclarados, declaradosAusentes, naoVarridos };
}

function arquivosRastreados(raiz: string): string[] {
  const saida = execFileSync("git", ["ls-files", "-z"], { cwd: raiz, maxBuffer: 1 << 28 }).toString("utf8");
  return saida.split("\0").filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Árvore de mentira, para provar que a cerca reprova de verdade
// ─────────────────────────────────────────────────────────────────────────────
const MIT_COMPLETA = [
  "Copyright (c) 2019, Fulano (https://exemplo.invalid)",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software and associated documentation files (the \"Software\"), to deal",
  "in the Software without restriction.",
  "",
  "The above copyright notice and this permission notice shall be included in",
  "all copies or substantial portions of the Software.",
].join("\n");

let arvores: string[] = [];
afterEach(() => {
  for (const dir of arvores) rmSync(dir, { recursive: true, force: true });
  arvores = [];
});

function arvore(arquivos: Record<string, string>): { raiz: string; relativos: string[] } {
  const raiz = mkdtempSync(path.join(tmpdir(), "ah-vendor-"));
  arvores.push(raiz);
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(raiz, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo);
  }
  return { raiz, relativos: Object.keys(arquivos) };
}

/** Um bundle plausível: grande o bastante e com linha longa, como o publicado. */
const bundle = (cabecalho: string) => `${cabecalho}\n!function(){"use strict";${"var x=1;".repeat(400)}}();\n`;
/** Banner completo do componente fictício `lib`, no formato que a régua exige de um vendor de verdade. */
const bannerMit = `/*!\n * lib 1.0.0 — vendored copy\n *\n${MIT_COMPLETA.split("\n")
  .map((l) => (l ? ` * ${l}` : " *"))
  .join("\n")}\n */`;

describe("gate de licença sobre os arquivos RASTREADOS, não só sobre node_modules", () => {
  it("[ATAQUE] bundle vendorado SEM aviso de copyright é reprovado, mesmo declarado no NOTICE", () => {
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/public/vendor/lib.js": bundle("// sem aviso nenhum"),
    });
    const r = auditar({
      raiz,
      relativos,
      notice: "  * packages/storymap-ui/public/vendor/lib.js — lib 1.0.0 — MIT\n",
      dono: "Fulano de Tal",
    });
    expect(r.examinados.map((c) => c.rel)).toEqual(["packages/storymap-ui/public/vendor/lib.js"]);
    expect(r.semAviso.map((f) => f.rel)).toEqual(["packages/storymap-ui/public/vendor/lib.js"]);
    expect(r.semAviso[0].motivo).toContain("nenhum aviso de copyright");
  });

  it("[ATAQUE] aviso de copyright SEM o texto da permissão não cumpre a MIT — reprova igual", () => {
    // O erro de quem "conserta" o achado deixando só a linha de copyright: a MIT exige as DUAS coisas
    // na mesma frase ("the above copyright notice AND this permission notice").
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/public/vendor/lib.js": bundle("/*! Copyright (c) 2019, Fulano — lib */"),
    });
    const r = auditar({
      raiz,
      relativos,
      notice: "  * packages/storymap-ui/public/vendor/lib.js — lib 1.0.0 — MIT\n",
      dono: "Fulano de Tal",
    });
    expect(r.semAviso.map((f) => f.motivo)).toEqual(["texto da licença MIT incompleto no arquivo"]);
  });

  it("[ATAQUE] vendor NOVO que ninguém declarou no NOTICE reprova — a lista não vira ficção por omissão", () => {
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/public/vendor/lib.js": bundle(bannerMit),
      "packages/storymap-ui/public/vendor/outro.js": bundle(bannerMit),
    });
    const r = auditar({
      raiz,
      relativos,
      notice: "  * packages/storymap-ui/public/vendor/lib.js — lib 1.0.0 — MIT\n",
      dono: "Fulano de Tal",
    });
    expect(r.naoDeclarados).toEqual(["packages/storymap-ui/public/vendor/outro.js"]);
    expect(r.semAviso).toEqual([]);
  });

  it("[ATAQUE] entrada do NOTICE apontando para arquivo que não existe mais reprova", () => {
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/public/vendor/lib.js": bundle(bannerMit),
    });
    const r = auditar({
      raiz,
      relativos,
      notice:
        "  * packages/storymap-ui/public/vendor/lib.js — lib 1.0.0 — MIT\n" +
        "  * packages/storymap-ui/public/vendor/fantasma.js — fantasma 2.0.0 — MIT\n",
      dono: "Fulano de Tal",
    });
    expect(r.declaradosAusentes).toEqual(["packages/storymap-ui/public/vendor/fantasma.js"]);
  });

  it("[ATAQUE] varredor cego fica VERMELHO: declarado e rastreado que a varredura não enxergou", () => {
    // O modo de falhar mais perigoso de um gate é parar de medir e continuar verde. Aqui o arquivo
    // declarado existe e é rastreado, mas não casa com nenhuma heurística (nem vendor, nem minificado,
    // nem banner) — sinal de que a régua deixou de alcançá-lo.
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/src/comum.ts": "export const x = 1;\n",
    });
    const r = auditar({
      raiz,
      relativos,
      notice: "  * packages/storymap-ui/src/comum.ts — comum 1.0.0 — MIT\n",
      dono: "Fulano de Tal",
    });
    expect(r.naoVarridos).toEqual(["packages/storymap-ui/src/comum.ts"]);
  });

  it("bundle minificado FORA de uma pasta vendor também é candidato — a rede secundária pega", () => {
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/public/algo.min.js": bundle("// nada"),
      "packages/storymap-ui/public/embutido.js": bundle("// nada"),
    });
    const r = auditar({ raiz, relativos, notice: "", dono: "Fulano de Tal" });
    expect(r.examinados.map((c) => c.rel).sort()).toEqual([
      "packages/storymap-ui/public/algo.min.js",
      "packages/storymap-ui/public/embutido.js",
    ]);
    expect(r.naoDeclarados.length).toBe(2);
  });

  it("banner de terceiro no CABEÇALHO é atribuição e é varrido, mesmo fora de vendor/", () => {
    const enche = `\n// ${"x".repeat(120)}`.repeat(30);
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/src/copiado.ts": `${bannerMit}\nexport const z = 3;${enche}\n`,
    });
    const r = auditar({ raiz, relativos, notice: "", dono: "Fulano de Tal" });
    expect(r.examinados.map((c) => c.motivo)).toEqual(["aviso-de-terceiro"]);
    expect(r.naoDeclarados).toEqual(["packages/storymap-ui/src/copiado.ts"]);
  });

  it("o mesmo texto ENTERRADO no corpo é citação, não atribuição — não vira candidato", () => {
    // O caso que se autodenunciava: um arquivo de teste com `Copyright (c)` numa fixture. Se esta régua
    // regredir para varrer o corpo inteiro, ele volta a acusar a si mesmo e o gate vira ruído.
    const enche = `\n// ${"x".repeat(120)}`.repeat(60);
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/src/fixture.ts": `export const z = 3;${enche}\nconst exemplo = "Copyright (c) 2019, Fulano";\n`,
    });
    const r = auditar({ raiz, relativos, notice: "", dono: "Fulano de Tal" });
    expect(r.examinados).toEqual([]);
    expect(r.naoDeclarados).toEqual([]);
  });

  it("par bem formado (aviso no arquivo + linha no NOTICE) passa limpo — a régua não é vermelho crônico", () => {
    const { raiz, relativos } = arvore({
      "packages/storymap-ui/public/vendor/lib.js": bundle(bannerMit),
      "packages/storymap-ui/src/proprio.ts": "// Copyright 2026 Fulano de Tal\nexport const y = 2;\n",
    });
    const r = auditar({
      raiz,
      relativos,
      notice: "  * packages/storymap-ui/public/vendor/lib.js — lib 1.0.0 — MIT\n",
      dono: "Fulano de Tal",
    });
    expect(r.examinados.map((c) => c.rel)).toEqual(["packages/storymap-ui/public/vendor/lib.js"]);
    expect(r.semAviso).toEqual([]);
    expect(r.naoDeclarados).toEqual([]);
    expect(r.declaradosAusentes).toEqual([]);
    expect(r.naoVarridos).toEqual([]);
  });

  it("outro pacote do umbrella não é varrido — o NOTICE da raiz fala pelo artefato, não pelo monorepo", () => {
    const { raiz, relativos } = arvore({
      "packages/acmeapp/web/public/vendor/alheio.js": bundle("// sem aviso"),
      "packages/storymap-ui/public/vendor/lib.js": bundle(bannerMit),
    });
    const r = auditar({
      raiz,
      relativos,
      notice: "  * packages/storymap-ui/public/vendor/lib.js — lib 1.0.0 — MIT\n",
      dono: "Fulano de Tal",
    });
    expect(r.examinados.map((c) => c.rel)).toEqual(["packages/storymap-ui/public/vendor/lib.js"]);
  });
});

describe("a gramática do inventário do NOTICE", () => {
  it("lê a linha de arquivo redistribuído e IGNORA os outros marcadores do NOTICE", () => {
    const entradas = inventarioDoNotice(
      "  * packages/x/vendor/a.js — a 1.2.3 — MIT\n" +
        "  * @blocknote/core     — BlockNote, Copyright (c) TypeCell OS and contributors\n" +
        "  * web-push            — Copyright (c) web-push contributors\n" +
        "  * packages/x/src/lib.test.ts sweeps the tracked files\n",
    );
    expect(entradas).toEqual([{ rel: "packages/x/vendor/a.js", componente: "a 1.2.3", spdx: "MIT" }]);
  });

  it("o dono do projeto sai da LICENSE, não de uma constante duplicada", () => {
    expect(donoDoProjeto("   Copyright 2026 Jonatas Salgado\n")).toBe("Jonatas Salgado");
    expect(donoDoProjeto("sem apêndice preenchido")).toBe("");
  });
});

describe("[ATAQUE] a árvore REAL: todo terceiro que viaja carrega seu aviso e está no NOTICE", () => {
  it("o instrumento mede de verdade — a árvore rastreada não é uma lista vazia", () => {
    const relativos = arquivosRastreados(REPO_ROOT);
    // Um `git ls-files` que devolvesse pouca coisa (repositório sem git, cwd errado, filtro quebrado)
    // faria toda a auditoria abaixo passar sem ter olhado para nada.
    expect(relativos.length, "git ls-files devolveu quase nada: a auditoria estaria medindo o vazio").toBeGreaterThan(100);
  });

  it("todo arquivo declarado no NOTICE existe, é rastreado, e a varredura o alcança", () => {
    const relativos = arquivosRastreados(REPO_ROOT);
    const notice = readFileSync(NOTICE, "utf8");
    const r = auditar({ raiz: REPO_ROOT, relativos, notice, dono: donoDoProjeto(readFileSync(LICENSE, "utf8")) });

    // Não-vacuidade pelo lado do NOTICE: hoje são os 6 arquivos do xterm. Se o inventário esvaziar, ou
    // o vendor saiu da árvore (e aí as linhas do NOTICE também têm de sair) ou a gramática quebrou.
    expect(r.declarados.length, "inventário de arquivos redistribuídos vazio no NOTICE").toBeGreaterThan(0);
    expect(r.declaradosAusentes, "o NOTICE promete um arquivo que não está na árvore rastreada").toEqual([]);
    expect(r.naoVarridos, "arquivo declarado que a heurística não enxerga: a régua parou de alcançá-lo").toEqual([]);
  });

  it("nenhum código de terceiro rastreado está NU nem fora do NOTICE", () => {
    const relativos = arquivosRastreados(REPO_ROOT);
    const notice = readFileSync(NOTICE, "utf8");
    const r = auditar({ raiz: REPO_ROOT, relativos, notice, dono: donoDoProjeto(readFileSync(LICENSE, "utf8")) });

    expect(r.examinados.length, "a varredura não achou NENHUM arquivo de terceiro: instrumento cego").toBeGreaterThan(0);
    expect(
      r.semAviso.map((f) => `${f.rel}: ${f.motivo}`).sort(),
      "arquivo de terceiro redistribuído sem o aviso que a licença dele exige — é a licença descumprida, não um detalhe de estilo",
    ).toEqual([]);
    expect(
      r.naoDeclarados.sort(),
      "arquivo de terceiro na árvore sem linha no NOTICE: acrescente a linha `caminho — componente versão — SPDX`",
    ).toEqual([]);
  });
});
