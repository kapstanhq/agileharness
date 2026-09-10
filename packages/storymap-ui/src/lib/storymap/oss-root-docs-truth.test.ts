import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ROOT_MARKERS, findRepoRoot } from "@/lib/storymap/paths";

// OS QUATRO DOCUMENTOS DA RAIZ DO ARTEFATO — o que o visitante do repositório público lê antes de
// qualquer código. Este guarda nasceu cobrindo UM deles (`oss-readme-truth.test.ts`, onda 3) e o
// defeito reapareceu no vizinho na semana seguinte: o README foi corrigido para a porta 3008 e o
// CONTRIBUTING continuou mandando abrir `http://127.0.0.1:3000` — a MESMA afirmação errada, no
// arquivo ao lado, porque o guarda media um arquivo e não uma CLASSE.
//
// A régua não mudou: cada afirmação verificável é DERIVADA do código, nunca repetida aqui. O que
// mudou é o alcance — a propriedade vale para todo documento que a extração realoca para a raiz
// (`oss/extract.sh`, PISO_ARQUIVOS), e acrescentar um quinto documento lá o traz para cá sozinho.

const PKG = process.cwd();

/** Os documentos que viram a RAIZ do repositório publicado, nas duas árvores. */
const DOCS_DA_RAIZ = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md"] as const;

function caminhoDoDoc(nome: string): string {
  const noUmbrella = path.resolve(PKG, "../../oss", nome);
  if (existsSync(noUmbrella)) return noUmbrella;
  return path.join(findRepoRoot(), nome); // no artefato ele JÁ é a raiz
}

const DOCS: { nome: string; caminho: string; texto: string }[] = DOCS_DA_RAIZ.map((nome) => {
  const caminho = caminhoDoDoc(nome);
  return { nome, caminho, texto: existsSync(caminho) ? readFileSync(caminho, "utf8") : "" };
});

const README = DOCS.find((d) => d.nome === "README.md")!;

/** O README dos DADOS — viaja no piso e é o primeiro arquivo que a maioria das skills lê. */
const README_DADOS = path.join(findRepoRoot(), "storymap", "README.md");

/** A porta default, LIDA do servidor — a única fonte que qualquer documento pode citar. */
function portaDefaultDoCodigo(): number {
  const src = readFileSync(path.join(PKG, "src/server/main.ts"), "utf8");
  const m = src.match(/const port = Number\([^)]*\)\s*\|\|\s*(\d+)/);
  if (!m) throw new Error("não achei a porta default em src/server/main.ts — o extrator quebrou, e um guarda que não lê nada fica verde de graça");
  return Number(m[1]);
}

describe("os documentos da RAIZ do artefato dizem a verdade sobre o código", () => {
  it("NÃO-VACUIDADE: os quatro existem e foram lidos", () => {
    const vazios = DOCS.filter((d) => d.texto.length < 500).map((d) => d.nome);
    expect(vazios.join(", "), "documento da raiz publicada ausente ou vazio — um guarda que lê string vazia fica verde de graça").toBe("");
    expect(DOCS).toHaveLength(4);
  });

  it("[CLASSE] nenhum deles cita uma porta de loopback que não seja a default do servidor", () => {
    const porta = portaDefaultDoCodigo();
    expect(porta).toBeGreaterThan(0);
    const errados = DOCS.flatMap((d) =>
      [...new Set([...d.texto.matchAll(/127\.0\.0\.1:(\d+)|localhost:(\d+)/g)].map((m) => Number(m[1] ?? m[2])))]
        .filter((p) => p !== porta)
        .map((p) => `${d.nome}:${p}`),
    );
    expect(
      errados.join(", "),
      `porta de loopback num documento da raiz que não é a ${porta} do servidor — foi exatamente assim que ` +
        `o 3000 sobreviveu no CONTRIBUTING depois de morrer no README`,
    ).toBe("");
  });

  it("o README cita a porta default que o servidor REALMENTE escuta", () => {
    const porta = portaDefaultDoCodigo();
    expect(README.texto, `o README precisa citar a porta ${porta}`).toContain(`127.0.0.1:${porta}`);
  });

  it("o README nomeia TODOS os marcadores de raiz que a resolução aceita", () => {
    const ausentes = ROOT_MARKERS.filter((m) => !README.texto.includes(m));
    expect(
      ausentes.join(", "),
      "marcador que a ferramenta aceita e o README não menciona — quem baixou o ZIP precisa saber por " +
        "que a pasta extraída é encontrada mesmo sem `.git`",
    ).toBe("");
    expect(ROOT_MARKERS.length).toBeGreaterThanOrEqual(3);
  });

  it("[ATAQUE] nenhum deles manda `STORYMAP_TARGET=$PWD` — é uma armadilha em todo cwd que não seja a raiz", () => {
    const culpados = DOCS.filter((d) => d.texto.includes("STORYMAP_TARGET=$PWD")).map((d) => d.nome);
    expect(culpados.join(", ")).toBe("");
  });

  it("[CLASSE] quem promete contenção por run também nomeia o pré-requisito que a faz subir", () => {
    // Debian/Ubuntu não trazem `bubblewrap`/`socat`, e sem eles a contenção não sobe — o run de
    // autonomia plena é REBAIXADO. Prometer a trava sem dizer o que instalar produz a pior falha
    // possível: o operador acredita que está contido e não está.
    // BILÍNGUE de propósito. A propriedade é sobre a PROMESSA, não sobre o idioma em que ela foi
    // escrita: o README passou a inglês (o artefato é global) e as três irmãs ainda estão em
    // português, então uma régua monolíngue passaria a medir só metade do conjunto — e o pior é
    // que ela ficaria VERDE, porque `promete.length > 0` continuaria satisfeito pelas irmãs
    // enquanto o documento MAIS LIDO saía da amostra sem ninguém notar.
    const PROMESSA = /jaula por run|contenção por run|per-run containment|per-run jail|runs are contained/i;
    const promete = DOCS.filter((d) => PROMESSA.test(d.texto));
    expect(promete.length, "nenhum documento promete contenção — o guarda ficaria vacuamente verde").toBeGreaterThan(0);
    const semPreRequisito = promete.filter((d) => !d.texto.includes("bubblewrap")).map((d) => d.nome);
    expect(
      semPreRequisito.join(", "),
      "documento que promete a jaula e não nomeia `bubblewrap` — a promessa vale só depois do apt install",
    ).toBe("");
  });

  it("[CLASSE] toda IMAGEM citada por um documento da raiz existe na árvore", () => {
    // O README público é uma galeria: dezoito capturas, e a lista muda toda vez que a interface muda.
    // Uma captura RENOMEADA ou REMOVIDA deixa o README apontando para o vazio, e o sintoma só aparece no
    // navegador de quem clonou. A régua é a ÁRVORE RASTREADA, não o disco: uma captura só em disco é
    // invisível para quem clona. `git add -f` é o conserto.
    const REL = /!\[[^\]]*\]\(([^)\s]+)\)|\b(?:src|srcset)="([^"\s]+)"/g;
    const IMAGEM = /\.(png|jpe?g|svg|gif|webp)$/i;
    const raiz = findRepoRoot();
    const resolve = (ref: string): string => ref;

    const rastreados = new Set(
      execFileSync("git", ["ls-files", "-z"], { cwd: raiz, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\0")
        .filter(Boolean),
    );
    expect(rastreados.size, "`git ls-files` não devolveu nada — sem árvore não há o que medir").toBeGreaterThan(100);

    const quebradas: string[] = [];
    let medidas = 0;
    for (const doc of DOCS) {
      for (const m of doc.texto.matchAll(REL)) {
        const bruto = (m[1] ?? m[2] ?? "").trim();
        if (!bruto || /^(https?:|data:|#)/.test(bruto) || !IMAGEM.test(bruto)) continue;
        medidas++;
        const alvo = resolve(bruto.replace(/^\.\//, ""));
        if (rastreados.has(alvo)) continue;
        const emDisco = existsSync(path.join(raiz, alvo));
        quebradas.push(
          `${doc.nome} → ${bruto}${emDisco ? "  (EXISTE em disco e NÃO é rastreada — `git add -f`)" : "  (não existe)"}`,
        );
      }
    }

    // NÃO-VACUIDADE: um casamento que parasse de funcionar passaria calado com a galeria inteira rota.
    expect(medidas, "nenhuma imagem foi medida — o casamento parou de funcionar").toBeGreaterThan(10);
    expect(quebradas.join("\n"), "imagem citada por documento público que não existe na árvore").toBe("");
  });

  it("[CLASSE] nenhum documento que viaja afirma que a ferramenta é dev-only ou nunca deployada", () => {
    // As duas afirmações são falsas — ela roda como serviço supervisionado, e é assim que o autorun
    // funciona. `oss-docs-truth.test.ts` já proíbe a frase no `package.json`; aqui ela é proibida na
    // prosa, que é onde ela estava viva (`storymap/README.md`, lido primeiro por 19 das 23 skills).
    const alvos = [...DOCS.map((d) => ({ nome: d.nome, texto: d.texto }))];
    if (existsSync(README_DADOS)) alvos.push({ nome: "storymap/README.md", texto: readFileSync(README_DADOS, "utf8") });
    expect(alvos.length, "nada para medir").toBeGreaterThan(4);
    const culpados = alvos.filter((a) => /dev-only|nunca deployada|never deployed/i.test(a.texto)).map((a) => a.nome);
    expect(culpados.join(", "), "a ferramenta É deployada — é o modo em que o autorun existe").toBe("");
  });
});
