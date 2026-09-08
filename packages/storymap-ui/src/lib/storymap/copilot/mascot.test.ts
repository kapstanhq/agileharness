import { describe, expect, it } from "vitest";
import { EXPRESSIONS, type MoodId } from "./face";
// A régua do design, transcrita e COMPARTILHADA com mascot-icons.test.ts — uma prancha, uma cópia.
import { PRANCHA, emCelulas } from "./prancha.fixture";
import {
  ARMS,
  AXIS,
  BODY,
  GRID,
  HEAD,
  MASCOT,
  MICRO,
  MICRO_GRID,
  MIN_FEATURE,
  RESTING,
  SIZE_PX,
  microPath,
  silhouettePath,
  type MascotArt,
  type Pixel,
} from "./mascot";

const ALL_MOODS = Object.keys(EXPRESSIONS) as MoodId[];
/** Toda arte do módulo — os humores E a cara de repouso (que não é humor, mas desenha igual). */
const ALL_ART: [string, MascotArt][] = [
  ...ALL_MOODS.map((m): [string, MascotArt] => [m, MASCOT[m]]),
  ["RESTING", RESTING],
];

/** Todo retângulo de uma arte, com um rótulo de onde ele veio (para a mensagem de falha ser útil). */
function everyRect(art: MascotArt): [string, Pixel][] {
  const [armL, armR] = ARMS[art.arms];
  return [
    ...art.cuts.map((p, i): [string, Pixel] => [`cut#${i}`, p]),
    ...(art.ink ?? []).flatMap((glyph, i) => glyph.map((p, j): [string, Pixel] => [`ink#${i}.${j}`, p])),
    ...(art.blinkEyes ?? []).map((p, i): [string, Pixel] => [`blinkEye#${i}`, p]),
    ...(art.lips ? ([["lips", art.lips]] as [string, Pixel][]) : []),
    [`arm:${art.arms}:L`, armL],
    [`arm:${art.arms}:R`, armR],
  ];
}

/** A regra da grade: coordenada INTEIRA, área positiva, tudo dentro da viewBox. Meio pixel é o defeito. */
function onGrid([x, y, w, h]: Pixel): boolean {
  return (
    [x, y, w, h].every(Number.isInteger) && w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= GRID && y + h <= GRID
  );
}

function contains(outer: Pixel, inner: Pixel): boolean {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[0] + inner[2] <= outer[0] + outer[2] &&
    inner[1] + inner[3] <= outer[1] + outer[3]
  );
}

/** Comprimento da sobreposição de dois intervalos [a, a+al) e [b, b+bl). */
function overlap1D(a: number, al: number, b: number, bl: number): number {
  return Math.min(a + al, b + bl) - Math.max(a, b);
}

/** As duas peças se sobrepõem OU encostam por uma ARESTA de comprimento positivo? Encostar de quina
 *  (diagonal) é permitido — é o degrau que desenha a curva do sorriso. Encostar de aresta, não: dois
 *  furos colados leem como UM furo maior, que foi exatamente o sorriso virando cigarro no topnav. */
function touchesOrOverlaps(a: Pixel, b: Pixel): boolean {
  const dx = overlap1D(a[0], a[2], b[0], b[2]);
  const dy = overlap1D(a[1], a[3], b[1], b[3]);
  if (dx > 0 && dy > 0) return true; // sobreposição de área
  if (dx === 0 && dy > 0) return true; // encostadas lado a lado
  if (dy === 0 && dx > 0) return true; // encostadas uma sobre a outra
  return false;
}

/** O espelho de uma peça no eixo do corpo. */
function mirrored([x, y, w, h]: Pixel): Pixel {
  return [GRID - x - w, y, w, h];
}

function sameRect(a: Pixel, b: Pixel): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

describe("MASCOT — o desenho de cada humor", () => {
  it("é exaustivo: todo humor de EXPRESSIONS tem uma entrada de arte", () => {
    for (const mood of ALL_MOODS) expect(MASCOT[mood], mood).toBeDefined();
    // e não sobra arte para humor que não existe (mapa 1:1 com o vocabulário de humores).
    expect(Object.keys(MASCOT).sort()).toEqual([...ALL_MOODS].sort());
  });

  it("todo humor tem pelo menos os olhos (cuts nunca vazio) e uma pose de braço válida", () => {
    for (const mood of ALL_MOODS) {
      const art = MASCOT[mood];
      expect(art.cuts.length, `${mood}: cuts`).toBeGreaterThan(0);
      expect(ARMS[art.arms], `${mood}: pose ${art.arms}`).toBeDefined();
    }
  });

  it("a pálpebra da piscada cobre um OLHO real (todo blinkEyes é um recorte existente)", () => {
    for (const [name, art] of ALL_ART) {
      for (const lid of art.blinkEyes ?? []) {
        expect(art.cuts.some((c) => sameRect(c, lid)), `${name}: pálpebra ${lid} sem olho por baixo`).toBe(true);
      }
    }
  });

  it("o lábio da fala cobre a BOCA (lips é um recorte existente) — e só o `falando` fala", () => {
    for (const [name, art] of ALL_ART) {
      if (!art.lips) continue;
      const l = art.lips;
      expect(art.cuts.some((c) => sameRect(c, l)), `${name}: lábio ${l} sem boca por baixo`).toBe(true);
    }
    expect(MASCOT.falando.lips, "só o falando tem lábio animado").toBeDefined();
  });

  it("os humores travados NÃO piscam (surpreso/erro/pânico/dormindo/glitch)", () => {
    for (const mood of ["surpreso", "erro", "panico", "dormindo", "glitch"] as const) {
      expect(MASCOT[mood].blinkEyes, `${mood} não deve piscar`).toBeUndefined();
    }
  });

  it("os humores em movimento declaram animação (dormindo flutua, pânico/glitch tremem)", () => {
    expect(MASCOT.dormindo.anim).toBe("float");
    expect(MASCOT.panico.anim).toBe("shake");
    expect(MASCOT.glitch.anim).toBe("shake");
    expect(MASCOT.pensativo.anim).toBe("pulse");
  });

  it("cada GLIFO de tinta é uma peça só — nada de um `z` se desmanchando no ar", () => {
    // O agrupamento existe por causa de um defeito real: com a lista de tinta plana, cada retângulo
    // recebia o seu `animation-delay` e as três barras de um `z` subiam em tempos diferentes — o
    // glifo se desmanchava no ar. O que trava aqui:
    //
    //  · o `dormindo` tem DOIS glifos (os dois z), não seis peças soltas — é o caso que gerou o
    //    modelo, e é o que voltaria a quebrar se alguém "achatasse" a lista de novo;
    //  · nenhum glifo é vazio, e todo glifo cabe numa caixa PEQUENA. A régua não é "as peças se
    //    tocam" (o `!` é barra + ponto, separados de propósito — é isso que faz dele um `!`), é
    //    "estão perto o bastante para o olho ler como uma coisa só". Duas peças em cantos opostos
    //    da moldura animando juntas seriam dois glifos fingindo ser um.
    const CAIXA_MAX = 12; // células — o maior glifo real (o `!`) mede 2×10
    let multi = 0;
    for (const [name, art] of ALL_ART) {
      for (const [i, glyph] of (art.ink ?? []).entries()) {
        expect(glyph.length, `${name}: glifo #${i} vazio`).toBeGreaterThan(0);
        if (glyph.length > 1) multi++;
        const x = Math.min(...glyph.map((p) => p[0]));
        const y = Math.min(...glyph.map((p) => p[1]));
        const w = Math.max(...glyph.map((p) => p[0] + p[2])) - x;
        const h = Math.max(...glyph.map((p) => p[1] + p[3])) - y;
        expect(Math.max(w, h), `${name}: glifo #${i} mede ${w}×${h} — grande demais para ser UMA coisa`)
          .toBeLessThanOrEqual(CAIXA_MAX);
      }
    }
    expect(MASCOT.dormindo.ink, "os dois z do sono").toHaveLength(2);
    for (const z of MASCOT.dormindo.ink!) expect(z, "um z são três barras").toHaveLength(3);
    expect(multi, "nenhum glifo com mais de uma peça — o agrupamento virou código morto").toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A GRADE — o contrato que faz o mascote continuar nítido quando encolhe.
//
// A arte antiga vivia numa viewBox de 100 com detalhes de 4 unidades: a 38px de lado isso dava 1,5px
// de device pixel por detalhe, o navegador arredondava cada aresta por conta própria e o desenho se
// desmanchava (covinha fundida na boca, olhos de larguras diferentes, recorte cinza em vez de furo).
// Estes testes travam as DUAS metades da correção — arte em célula inteira, tamanho múltiplo da grade.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("a grade — por que o Jido não borra mais no tamanho pequeno", () => {
  it("toda peça de toda arte cai em CÉLULA INTEIRA dentro da viewBox", () => {
    for (const p of BODY) expect(onGrid(p), `body ${p}`).toBe(true);
    for (const pose of Object.keys(ARMS) as (keyof typeof ARMS)[]) {
      const [l, r] = ARMS[pose];
      expect(onGrid(l), `braço E ${pose}`).toBe(true);
      expect(onGrid(r), `braço D ${pose}`).toBe(true);
    }
    for (const [name, art] of ALL_ART) {
      for (const [where, p] of everyRect(art)) {
        expect(onGrid(p), `${name}: ${where} = ${JSON.stringify(p)} fora da grade`).toBe(true);
      }
    }
  });

  it("nenhuma peça é menor que a MENOR PEÇA da prancha (4 unidades = 2 células)", () => {
    // O piso que sobrou depois que a grade virou a do design. Antes a regra era "todo tamanho é
    // múltiplo da grade", e ela morreu com a grade de 20: com 50 células, ser múltiplo obrigaria
    // degraus de 50px, e o topnav (40px) é quem dá a altura da barra do app inteiro. O que PROTEGE o
    // desenho no lugar dela é este piso — a menor peça continua sendo a menor peça da prancha, e a
    // aresta fracionária vira meio-tom simétrico porque não usamos `crispEdges` (ver mascot.ts).
    for (const [name, art] of ALL_ART) {
      for (const [where, [, , w, h]] of everyRect(art)) {
        expect(Math.min(w, h), `${name}: ${where} tem lado < ${MIN_FEATURE} células`).toBeGreaterThanOrEqual(
          MIN_FEATURE,
        );
      }
    }
    for (const p of BODY) expect(Math.min(p[2], p[3]), `body ${p}`).toBeGreaterThanOrEqual(MIN_FEATURE);
  });

  it("a escada de tamanho cresce, e no menor degrau a menor peça ainda tem pixel", () => {
    const ladder = [SIZE_PX.xs, SIZE_PX.sm, SIZE_PX.md, SIZE_PX.lg];
    expect(ladder, "degrau que não cresce é degrau que não existe").toEqual([...ladder].sort((a, b) => a - b));
    expect(new Set(ladder).size).toBe(ladder.length);
    // 1,5px CSS (3 device px num retina) é o piso abaixo do qual a peça deixa de ser peça e vira
    // sujeira. A 40px / 50 células, 2 células dão 1,6px — passa, com pouca folga e de propósito.
    const menorPeca = MIN_FEATURE * (SIZE_PX.xs / GRID);
    expect(menorPeca, `no xs a menor peça mede ${menorPeca}px`).toBeGreaterThanOrEqual(1.5);
    // e os degraus ACIMA do topnav caem em célula inteira — lá não há layout amarrando o tamanho.
    for (const size of ["sm", "md", "lg"] as const) {
      expect(SIZE_PX[size] % GRID, `${size}: ${SIZE_PX[size]}px não é múltiplo de ${GRID}`).toBe(0);
    }
  });

  it("a anatomia é a da prancha do design, unidade por unidade", () => {
    // A trava contra o desenho voltar a ser "redesenhado no olho": a conversão prancha→código é
    // `célula = unidade / 2`, literal, e é isso que este teste prova. Um valor diferente aqui não é
    // ajuste fino, é outro bicho (foi o defeito de 2026-08-03).
    expect(BODY[0], "antena").toEqual(emCelulas(PRANCHA.card3a.antena));
    expect(BODY[1], "corpo/cabeça").toEqual(emCelulas(PRANCHA.card3a.corpo));
    expect(BODY[2], "perna esquerda").toEqual(emCelulas(PRANCHA.card3a.pernaE));
    expect(BODY[3], "perna direita").toEqual(emCelulas(PRANCHA.card3a.pernaD));
    expect(ARMS.neutro[0], "braço esquerdo").toEqual(emCelulas(PRANCHA.card3a.bracoE));
    expect(ARMS.neutro[1], "braço direito").toEqual(emCelulas(PRANCHA.card3a.bracoD));
    expect(RESTING.cuts[0], "olho esquerdo").toEqual(emCelulas(PRANCHA.card3a.olhoE));
    expect(RESTING.cuts[1], "olho direito").toEqual(emCelulas(PRANCHA.card3a.olhoD));
    // e o desenho inteiro ocupa 84×64 unidades da prancha (42×32 células) — a caixa que o
    // enquadramento dos ícones usa para chegar aos 67% do card 5a.
    const todas = [...BODY, ...ARMS.neutro];
    const w = Math.max(...todas.map((p) => p[0] + p[2])) - Math.min(...todas.map((p) => p[0]));
    const h = Math.max(...todas.map((p) => p[1] + p[3])) - Math.min(...todas.map((p) => p[1]));
    expect([w, h], "caixa do desenho, em células").toEqual([42, 32]);
  });

  it("a arte MICRO é o card 5d, célula por célula", () => {
    expect(MICRO.solids, "as seis peças do 5d, na ordem da prancha").toEqual([
      PRANCHA.card5d.antena,
      PRANCHA.card5d.bracoE,
      PRANCHA.card5d.bracoD,
      PRANCHA.card5d.corpo,
      PRANCHA.card5d.pernaE,
      PRANCHA.card5d.pernaD,
    ]);
    expect(MICRO.cuts, "os olhos de 2×3 do 5d").toEqual([PRANCHA.card5d.olhoE, PRANCHA.card5d.olhoD]);
  });

  it("as poses de braço vêm dos cards que as mostram (3b · 3h · 3l)", () => {
    // `aceno` (3b): o braço DIREITO ergue; o esquerdo fica onde o neutro o deixou.
    expect(ARMS.aceno[0], "aceno · braço esquerdo = o neutro").toEqual(ARMS.neutro[0]);
    expect(ARMS.aceno[1], "aceno · braço direito erguido").toEqual(emCelulas(PRANCHA.card3b.bracoDErguido));
    // `festa` (3h) e `baixo` (3l): os dois braços sobem / caem juntos, espelhados no eixo.
    expect(ARMS.festa[0], "festa · esquerdo").toEqual(emCelulas(PRANCHA.card3h.bracoE));
    expect(ARMS.baixo[0], "baixo · esquerdo").toEqual(emCelulas(PRANCHA.card3l.bracoE));
  });

  it("todo recorte cabe DENTRO do bloco da cabeça — furo fora dela é furo invisível", () => {
    for (const [name, art] of ALL_ART) {
      for (const [i, cut] of art.cuts.entries()) {
        expect(contains(HEAD, cut), `${name}: cut#${i} ${JSON.stringify(cut)} escapa da cabeça`).toBe(true);
      }
    }
  });

  it("nenhum recorte ENCOSTA no outro por aresta — só de quina (a escadinha do sorriso)", () => {
    // Dois furos colados de aresta viram UM furo maior. Foi assim que a covinha esquerda fundiu com a
    // barra da boca e o sorriso virou um traço torto com um toco pendurado do lado direito.
    for (const [name, art] of ALL_ART) {
      for (let i = 0; i < art.cuts.length; i++) {
        for (let j = i + 1; j < art.cuts.length; j++) {
          const [a, b] = [art.cuts[i], art.cuts[j]];
          expect(
            touchesOrOverlaps(a, b),
            `${name}: cut#${i} ${JSON.stringify(a)} e cut#${j} ${JSON.stringify(b)} se fundem`,
          ).toBe(false);
        }
      }
    }
  });

  it("os glifos externos ficam FORA da silhueta — tinta sobre tinta é tinta invisível", () => {
    for (const [name, art] of ALL_ART) {
      const [armL, armR] = ARMS[art.arms];
      for (const [i, ink] of (art.ink ?? []).flat().entries()) {
        for (const [where, solid] of [...BODY.map((p, k) => [`body#${k}`, p] as const), ["armL", armL] as const, ["armR", armR] as const]) {
          const dx = overlap1D(ink[0], ink[2], solid[0], solid[2]);
          const dy = overlap1D(ink[1], ink[3], solid[1], solid[3]);
          expect(dx > 0 && dy > 0, `${name}: ink#${i} ${JSON.stringify(ink)} sumindo dentro de ${where}`).toBe(false);
        }
      }
    }
  });

  it("o corpo e as poses de braço são SIMÉTRICOS no eixo — menos o aceno, onde a assimetria é o gesto", () => {
    // antena e cabeça centradas no eixo; os pés são um par espelhado.
    for (const p of [BODY[0], BODY[1]]) expect(p[0] + p[2] / 2, `${p} descentrado`).toBe(AXIS);
    expect(mirrored(BODY[2])).toEqual(BODY[3]);
    for (const pose of Object.keys(ARMS) as (keyof typeof ARMS)[]) {
      const [l, r] = ARMS[pose];
      if (pose === "aceno") {
        expect(sameRect(mirrored(l), r), "o aceno é assimétrico de propósito").toBe(false);
        continue;
      }
      expect(mirrored(l), `braços de ${pose} desalinhados`).toEqual(r);
    }
  });

  it("os olhos de cada humor são um par espelhado — menos onde a assimetria é o desenho", () => {
    // `piscando` (um olho fechado) e `glitch` (olho com defeito) são assimétricos POR DESIGN.
    const assimetricos = new Set<string>(["piscando", "glitch"]);
    for (const [name, art] of ALL_ART) {
      if (assimetricos.has(name)) continue;
      // os olhos são os recortes da metade de CIMA da cabeça (a boca fica abaixo).
      const eyes = art.cuts.filter((c) => c[1] < HEAD[1] + HEAD[3] / 2);
      const left = eyes.filter((c) => c[0] + c[2] / 2 < AXIS);
      const right = eyes.filter((c) => c[0] + c[2] / 2 > AXIS);
      expect(left.length, `${name}: sem olho à esquerda`).toBeGreaterThan(0);
      expect(right.length, `${name}: olhos desbalanceados`).toBe(left.length);
      for (const l of left) {
        expect(right.some((rr) => sameRect(mirrored(l), rr)), `${name}: olho ${l} sem espelho`).toBe(true);
      }
    }
  });
});

// A trava contra `shape-rendering: crispEdges` voltar mora em `components/pixel-art-rendering.test.ts`
// — ela vale para TODA pixel-art do app (mascote e wordmark), não só para este rosto.

describe("silhouettePath — a silhueta e os furos num caminho só", () => {
  it("desenha corpo + braços no sentido horário e os recortes no INVERTIDO (o furo do `nonzero`)", () => {
    const art = MASCOT.feliz;
    const d = silhouettePath(art);
    // Horário começa por H (vai para a direita); anti-horário começa por V (desce). É a única diferença
    // entre pintar e furar, então é ela que o teste olha.
    const cw = d.match(/M[-\d. ]+H/g) ?? [];
    const ccw = d.match(/M[-\d. ]+V/g) ?? [];
    expect(cw).toHaveLength(BODY.length + 2); // corpo + os dois braços
    expect(ccw).toHaveLength(art.cuts.length); // um furo por recorte
  });

  it("toda arte produz um caminho fechado por subcaminho (nenhum `M` sem `Z`)", () => {
    for (const [name, art] of ALL_ART) {
      const d = silhouettePath(art);
      const starts = (d.match(/M/g) ?? []).length;
      const closes = (d.match(/Z/g) ?? []).length;
      expect(closes, `${name}: subcaminho aberto`).toBe(starts);
      expect(d, `${name}: caminho vazio`).not.toBe("");
    }
  });

  it("a pose de braço muda o caminho — o corpo não", () => {
    const neutro = silhouettePath({ arms: "neutro", cuts: [...RESTING.cuts] });
    const festa = silhouettePath({ arms: "festa", cuts: [...RESTING.cuts] });
    expect(neutro).not.toBe(festa);
  });
});

describe("RESTING — a cara neutra da marca (tela de login)", () => {
  // O `piscando` que a tela usava antes é uma PISCADELA: olho direito fechado em linha + sorriso.
  // Como gesto dirigido, ele lia como reação a algo que o operador ainda nem tinha feito.
  it("tem DOIS olhos abertos, iguais e simétricos — nada de wink", () => {
    expect(RESTING.cuts).toHaveLength(2);
    const [left, right] = RESTING.cuts;
    expect(left[2]).toBe(right[2]); // mesma largura
    expect(left[3]).toBe(right[3]); // mesma altura  → nenhum dos dois está "fechado"
    expect(left[1]).toBe(right[1]); // mesma linha
    expect(mirrored(left)).toEqual(right); // simétricos no eixo do corpo
  });

  it("NÃO tem boca — sem sorriso", () => {
    // Toda boca do mapa vive na metade de baixo da cabeça; olho nenhum passa daí.
    for (const [, y] of RESTING.cuts) expect(y).toBeLessThan(HEAD[1] + HEAD[3] / 2);
    expect(RESTING.lips).toBeUndefined();
  });

  it("pisca os DOIS olhos, naturalmente, e não tem glifo nem tremor", () => {
    expect(RESTING.blinkEyes).toHaveLength(2);
    expect(RESTING.blinkEyes).toEqual(RESTING.cuts);
    expect(RESTING.ink).toBeUndefined();
    expect(RESTING.anim).toBeUndefined();
    expect(RESTING.arms).toBe("neutro");
  });

  it("fica FORA do vocabulário de humor — não é um estado do copiloto", () => {
    // Um humor que `deriveMood` nunca produz seria entrada de vocabulário sem produtor nenhum.
    for (const mood of ALL_MOODS) expect(MASCOT[mood]).not.toBe(RESTING);
    expect(Object.values(MASCOT)).not.toContain(RESTING);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// MICRO — o card 5d: a resposta do DESIGN para o tamanho pequeno.
//
// A prancha do ícone é explícita: "de 32px para baixo as pernas e a antena colapsam; por isso existe
// o 5d, redesenhado na grade de 16". O que existia aqui antes era outra resposta — recortar um BUSTO
// da arte grande —, e ela custava as pernas do bicho justamente na superfície mais vista (a aba).
// Estes testes travam o que faz a micro ser a micro: corpo INTEIRO, grade de 16, simetria, e a
// aritmética que garante pixel cheio em 16/32/48.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("MICRO — o mascote redesenhado na grade de 16 (favicon)", () => {
  const microMirror = ([x, y, w, h]: Pixel): Pixel => [MICRO_GRID - x - w, y, w, h];
  const todas = [...MICRO.solids, ...MICRO.cuts];

  it("é o card 5d, peça por peça — corpo INTEIRO, não um busto", () => {
    expect(MICRO.solids, "antena · 2 braços · corpo · 2 pernas").toHaveLength(6);
    expect(MICRO.solids).toEqual([
      [7, 3, 2, 2], // antena
      [1, 7, 2, 2], // braço esquerdo
      [13, 7, 2, 2], // braço direito
      [3, 5, 10, 7], // corpo
      [5, 12, 2, 2], // perna esquerda
      [9, 12, 2, 2], // perna direita
    ]);
    expect(MICRO.cuts, "dois olhos de 2×3, como manda o 5d").toEqual([
      [5, 7, 2, 3],
      [9, 7, 2, 3],
    ]);
  });

  it("cai em célula inteira dentro da grade de 16", () => {
    for (const p of todas) {
      expect(p.every(Number.isInteger), `${p} fracionário`).toBe(true);
      expect(p[0] >= 0 && p[1] >= 0, `${p} fora pela origem`).toBe(true);
      expect(p[0] + p[2] <= MICRO_GRID && p[1] + p[3] <= MICRO_GRID, `${p} estoura a grade`).toBe(true);
    }
  });

  it("é simétrica no eixo, e os olhos são FUROS dentro do corpo que não se fundem", () => {
    const [antena, bracoL, bracoR, corpo, pernaL, pernaR] = MICRO.solids;
    expect(antena[0] + antena[2] / 2, "antena descentrada").toBe(MICRO_GRID / 2);
    expect(corpo[0] + corpo[2] / 2, "corpo descentrado").toBe(MICRO_GRID / 2);
    expect(microMirror(bracoL)).toEqual(bracoR);
    expect(microMirror(pernaL)).toEqual(pernaR);
    const [olhoL, olhoR] = MICRO.cuts;
    expect(microMirror(olhoL)).toEqual(olhoR);
    for (const olho of MICRO.cuts) {
      expect(contains(corpo, olho), `olho ${olho} fora do corpo é furo invisível`).toBe(true);
    }
    // um vão de 2 células entre eles: colados de aresta virariam UMA faixa preta, não dois olhos.
    expect(touchesOrOverlaps(olhoL, olhoR), "olhos fundidos").toBe(false);
  });

  it("fecha em pixel CHEIO nos três tamanhos de aba (16 · 32 · 48)", () => {
    for (const size of [16, 32, 48]) {
      expect(size % MICRO_GRID, `${size}px não é múltiplo de ${MICRO_GRID}`).toBe(0);
      expect(size / MICRO_GRID, `${size}px dá menos de 1px por célula`).toBeGreaterThanOrEqual(1);
    }
  });

  it("vira um caminho fechado com os furos no sentido invertido, como a arte grande", () => {
    const d = microPath();
    expect((d.match(/M[-\d. ]+H/g) ?? []).length, "peças sólidas no horário").toBe(MICRO.solids.length);
    expect((d.match(/M[-\d. ]+V/g) ?? []).length, "furos no anti-horário").toBe(MICRO.cuts.length);
    expect((d.match(/Z/g) ?? []).length, "subcaminho aberto").toBe((d.match(/M/g) ?? []).length);
  });
});
