// Assa a logomarca "Agile·HARNESS" em PNG, para o README do repositório publicado.
//
// POR QUE UM PNG, e não o SVG que o app já desenha: metade do lockup é TEXTO numa fonte
// (Playpen Sans). Um `<svg>` com `font-family` no README depende de a fonte existir na máquina de
// quem lê — no GitHub ela não existe, e o "Agile" sairia num fallback serifado qualquer. Rasterizar
// congela o desenho certo. É a mesma razão pela qual `gen-splash.ts` usa um navegador, e por isso
// este arquivo REAPROVEITA o `playpenFaces()` de lá em vez de reimplementar a extração da fonte —
// que tem uma armadilha medida (a primeira @font-face do CSS é a de emoji, sem letra nenhuma).
//
// POR QUE DOIS ARQUIVOS: o lockup pinta em `currentColor` justamente para herdar o texto de quem o
// monta — grafite no claro, quase-branco no escuro. Um PNG não herda nada. O README resolve com
// `<picture>` + `prefers-color-scheme`, que o GitHub respeita, e para isso precisa das duas tintas.
// O ponto de junção NÃO troca: ele é cor de MARCA (#FF4F00), não tinta de tema.
//
// POR QUE `SIZE = 20` E NÃO UM NÚMERO GRANDE: o componente fixa `gap` em px ABSOLUTOS
// (`size >= 16 ? 3 : 2`) — ele foi desenhado para a barra e para o login, não para pôster. Pedir
// `size: 120` esticaria o desenho e encolheria o respiro proporcionalmente: sairia um lockup que o
// produto nunca mostra. Então ampliamos o desenho REAL pelo device-scale do Chrome, que multiplica
// tudo junto. 20 é o tamanho do login e o único múltiplo de 10 em uso — nele o grid 68×10 cai em
// 2px por unidade, escala INTEIRA, sem o meio-tom que a nota do componente descreve.
//
// PRÉ-REQUISITO: um `bun run build` recente neste pacote (a fonte sai de `.next`).
//   bun run scripts/gen-readme-logo.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_PIXELS } from "../src/components/AgileHarnessLogo";
import { playpenFaces } from "./gen-splash";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, "public");

/** O tamanho ótico do HARNESS, em px CSS. Ver a nota do topo: 20 é escala inteira. */
const SIZE = 20;
/** Quanto o Chrome multiplica tudo. 6 põe o PNG em ~1200px de largura — "bem grande" sem virar peso. */
const SCALE = 6;

/** As duas tintas de texto do app (`--fg` no claro e no escuro, `globals.css`). */
const TINTAS = [
  { nome: "logo-light.png", ink: "#37352F" }, // sobre papel
  { nome: "logo-dark.png", ink: "#ECEAE3" }, // sobre superfície escura
] as const;
const ORANGE = "#FF4F00";

// As MESMAS razões do `AgileHarnessLogo.tsx`. Não são "quase iguais": são copiadas de lá porque o
// componente é o desenho, e um lockup impresso que diverge do que o app mostra é pior que nenhum.
const agileSize = Math.round(SIZE * 1.45);
const dot = Math.round(SIZE / 4);
const dotMb = Math.round(SIZE / 3);
const svgW = SIZE * 6.8;
const gap = SIZE >= 16 ? 3 : 2;

/**
 * A página de UMA tinta. `deslocaTopo` é o transbordo SUPERIOR da tinta, medido na passada 1 e
 * aplicado na 2: ele empurra o desenho para dentro do recorte em vez de deixá-lo sangrar para
 * fora do topo da janela.
 */
function html(ink: string, font: { css: string; family: string }, deslocaTopo = 0): string {
  const rects = HARNESS_PIXELS.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
${font.css}
html,body{margin:0;padding:0;background:transparent}
body{padding-top:${deslocaTopo}px}
#lockup{display:inline-flex;align-items:flex-end;gap:${gap}px;line-height:1;color:${ink}}
#agile{font-family:"${font.family}","Playpen Sans",cursive;font-weight:500;font-size:${agileSize}px;
       line-height:.72;letter-spacing:-.09em}
#dot{width:${dot}px;height:${dot}px;background:${ORANGE};flex:none;margin-bottom:${dotMb}px}
svg{display:block;flex:none}
</style><span id="lockup"><span id="agile">Agile</span><span id="dot"></span>
<svg width="${svgW}" height="${SIZE}" viewBox="0 0 68 10"><g fill="currentColor">${rects}</g></svg></span>
<script>
// O carimbo que a passada 1 lê. Roda DEPOIS de \`document.fonts.ready\` porque a medida do lockup
// depende das métricas da fonte: medir antes devolve a largura da serifa de fallback, e a passada 2
// recortaria no lugar errado — com o desenho certo, o que é o pior modo de falha (parece bom).
//
// \`document.fonts.check\` — e NÃO \`getComputedStyle\`. A segunda devolve a família DECLARADA e
// responde "Playpen Sans" mesmo quando o Chrome desenhou a serifa: uma asserção assim JÁ passou no
// bug que este carimbo existe para pegar (2026-08-27).
document.fonts.ready.then(function () {
  var el = document.getElementById("lockup");
  var ag = document.getElementById("agile");
  var cs = getComputedStyle(ag);
  el.setAttribute("data-fonte", document.fonts.check(cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily, "Agile") ? "ok" : "fallback");

  // A CAIXA DE TINTA, e não a de LAYOUT. 'getBoundingClientRect' devolve a caixa que o CSS
  // reservou, e o lockup declara 'line-height: .72' no "Agile" de propósito (é o que o aperta
  // contra o HARNESS). Com line-height MENOR que o corpo da fonte, o glifo pinta FORA da própria
  // caixa: o descender do "g" cai abaixo dela. Medindo o layout, o recorte cortava o "g" e o
  // lockup lia "Aaile" — publicado assim, e visto por uma pessoa, não por mim.
  //
  // A tinta se mede com 'measureText': 'actualBoundingBox*' é a extensão REAL do desenho em
  // relação à linha de base, e 'fontBoundingBox*' é a caixa do corpo da fonte — a diferença
  // entre as duas é exatamente o que transborda.
  var cv = document.createElement("canvas").getContext("2d");
  cv.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
  var m = cv.measureText(ag.textContent);

  // Onde a linha de base cai DENTRO da caixa do span: o navegador centra o corpo da fonte na
  // altura de linha (half-leading), então base = (altura - corpo)/2 + ascent.
  var alturaCaixa = ag.getBoundingClientRect().height;
  var corpo = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  var base = (alturaCaixa - corpo) / 2 + m.fontBoundingBoxAscent;

  var rAg = ag.getBoundingClientRect();
  var tintaTopo = rAg.top + base - m.actualBoundingBoxAscent;
  var tintaBase = rAg.top + base + m.actualBoundingBoxDescent;

  // A união com o resto do lockup (o ponto e o SVG são retângulos: layout == tinta).
  var r = el.getBoundingClientRect();
  var topo = Math.min(r.top, tintaTopo);
  var fundo = Math.max(r.bottom, tintaBase);
  el.setAttribute("data-medida", Math.ceil(r.width) + "x" + Math.ceil(fundo - topo));
  // Quanto a tinta sobe acima da caixa do lockup — a passada 2 empurra o desenho para baixo por
  // esse tanto, senão o recorte come o topo em vez do pé.
  el.setAttribute("data-desloca", String(Math.ceil(Math.max(0, r.top - topo))));
  // As coordenadas ABSOLUTAS da tinta na página. O 'desloca' acima é o transbordo INTRÍNSECO do
  // glifo (não muda quando o elemento se move); só estas dizem se a tinta caiu DENTRO do recorte.
  el.setAttribute("data-tinta", Math.floor(topo) + "," + Math.ceil(fundo));
});
</script>`;
}

const font = playpenFaces();

/**
 * O MESMO binário e o MESMO modo do `gen-splash.ts` — headless por LINHA DE COMANDO, sem
 * `playwright`.
 *
 * MEDIDO em 2026-08-27: a primeira versão usava `playwright.chromium`, e o `tsc` do ARTEFATO
 * reprovou com `TS2307: Cannot find module 'playwright'`. Aqui o pacote vem do node_modules da
 * RAIZ do monorepo; lá o artefato regenera o lockfile a partir do `package.json` publicado, que
 * não o declara. Um gerador de ativo de marca não vale uma dependência que arrasta navegador para
 * todo mundo que clona — e o `gen-splash` já tinha resolvido isso do jeito certo.
 */
const CHROME = process.env.CHROME_BIN ?? "google-chrome";
const BASE = ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars"];

/**
 * DUAS PASSADAS, e a primeira existe por uma limitação real: `--screenshot` fotografa a JANELA,
 * não o elemento. A largura do lockup depende das métricas da Playpen Sans no "Agile" — não dá
 * para calcular fora do navegador. Então a passada 1 MEDE (o `--dump-dom` devolve o DOM depois do
 * JS rodar, e o script carimba o retângulo num atributo) e a passada 2 fotografa com a janela do
 * tamanho exato. Sem isso o PNG sai boiando num retângulo de respiro arbitrário.
 */
function medir(pagina: string): {
  w: number;
  h: number;
  desloca: number;
  tinta: { topo: number; base: number };
} {
  const dom = execFileSync(CHROME, [...BASE, "--virtual-time-budget=4000", "--dump-dom", `file://${pagina}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const m = dom.match(/data-medida="(\d+)x(\d+)"/);
  if (!m) throw new Error("a página não carimbou a medida do lockup — o JS não rodou?");
  const d = dom.match(/data-desloca="(\d+)"/);
  const t = dom.match(/data-tinta="(-?\d+),(-?\d+)"/);
  const carregou = /data-fonte="ok"/.test(dom);
  if (!carregou) {
    throw new Error(
      'a Playpen Sans NÃO carregou — o "Agile" sairia em serifa. Causas medidas: (a) documento sem ' +
        "origin `file://` não lê @font-face local; (b) `bun run build` velho ou ausente (a fonte sai de .next/static).",
    );
  }
  return {
    w: Number(m[1]),
    h: Number(m[2]),
    desloca: Number(d?.[1] ?? 0),
    tinta: { topo: Number(t?.[1] ?? 0), base: Number(t?.[2] ?? 0) },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "ah-logo-"));
try {
  for (const { nome, ink } of TINTAS) {
    const pagina = join(tmp, `${nome}.html`);
    writeFileSync(pagina, html(ink, font), "utf8");
    const { w, h, desloca } = medir(pagina);
    // A passada 2 REESCREVE a página empurrando o desenho para baixo pelo transbordo SUPERIOR
    // da tinta. Sem isto o recorte teria a altura certa e o conteúdo errado — cortaria o topo
    // do "A" em vez do pé do "g": o mesmo defeito com outro sintoma.
    if (desloca > 0) {
      writeFileSync(pagina, html(ink, font, desloca), "utf8");
      // A VERIFICAÇÃO DO ESTADO FINAL, e ela não é circular: a de cima checa a fórmula contra si
      // mesma; esta pergunta à página JÁ DESLOCADA se a tinta cabe no retângulo que vai ser
      // fotografado. É o degrau que faltava — o corte do "g" foi publicado porque nada mediu o
      // resultado, só a intenção. Tolerância de 1px: o recorte é `Math.ceil`.
      const fim = medir(pagina);
      // Tolerância de 1px nas duas pontas: as medidas saem de `Math.floor`/`Math.ceil`.
      if (fim.tinta.topo < -1 || fim.tinta.base > h + 1) {
        throw new Error(
          `a tinta escapa do recorte depois do deslocamento: topo=${fim.tinta.topo}, ` +
            `base=${fim.tinta.base}, janela=${h}px — o logo sairia cortado.`,
        );
      }
    }
    execFileSync(
      CHROME,
      [
        ...BASE,
        "--default-background-color=00000000", // alfa zero: o PNG sai com fundo transparente
        `--force-device-scale-factor=${SCALE}`,
        `--window-size=${w},${h}`,
        `--screenshot=${join(OUT, nome)}`,
        `file://${pagina}`,
      ],
      { stdio: "pipe" },
    );
    console.log(`  ${nome}  ink=${ink}  ${w}×${h} css @${SCALE}×  desloca=${desloca}px  fonte=Playpen Sans`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`logomarca gerada em ${OUT}`);
