// O CORPO do Jido — o mascote pixel-art do AgileHarness, em dados PUROS.
//
// A REGRA DO SISTEMA (a mesma do design): o CORPO nunca muda; a expressão vive nos OLHOS (recortes),
// na BOCA (opcional), nos BRAÇOS (sobem/descem na grade) e em pequenos GLIFOS externos (z, !, ✦, ondas)
// sempre na cor do mascote. Aqui isso vira um contrato declarativo: **adicionar um humor = adicionar UMA
// entrada** em `MASCOT`. Nada de lógica — o componente (components/copilot/CopilotFace.tsx) desenha o que
// este módulo descreve, e o motor de HUMOR (lib/storymap/copilot/face.ts, `deriveMood`) decide QUAL humor.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A GRADE É A DO DESIGN — 1 célula = 2 unidades da prancha de 100. Nem uma a mais.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// A arte canônica vive na prancha do Claude Design ("Mascote AgileHarness", cards 3a–3o; "Ícone App
// AgileHarness", cards 5a–5g), autorada numa viewBox de 100. O maior divisor comum de TODAS as
// coordenadas da anatomia fixa é **2** — logo a menor grade que representa o desenho SEM arredondar
// nada é de **50 células**, e é essa que este módulo usa. A conversão é literal: `célula = unidade / 2`.
//
//   antena  [44,16,12,12] → [22, 8, 6, 6]      corpo  [20,28,60,38] → [10,14,30,19]
//   braços  [ 8,36,12,12] → [ 4,18, 6, 6]      pernas [30,66,12,14] → [15,33, 6, 7]
//   olhos   [34,40, 8,12] → [17,20, 4, 6]
//
// Por que isso importa e não é preciosismo: a grade ANTERIOR era de 20 células, o que obriga a dividir
// a prancha por 5 — e 44/5, 38/5, 66/5 não são inteiros. O desenho tinha de ser REDESENHADO no olho, e
// o resultado era outro bicho: antena mais estreita e mais alta, corpo mais alto, braços mais finos,
// olhos maiores e mais juntos, vão entre as pernas 25% maior. Cada peça errava pouco; juntas, erravam a
// identidade. Foi o defeito relatado em 2026-08-03 ("o ícone está totalmente desconfigurado"). Numa
// grade de 50 não sobra decisão de desenho para tomar: a prancha manda, o código transcreve.
//
// **Não volte a mexer nestes números para "caber" num tamanho.** Se um tamanho não serve, mude o
// TAMANHO (`SIZE_PX`) ou use a arte MICRO lá embaixo — a anatomia é a assinatura da marca.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DUAS ARTES, como na prancha: a MESTRA (50 células) e a MICRO (16 células).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// A prancha do ícone diz, com todas as letras, que abaixo de 32px "as pernas e a antena colapsam; por
// isso existe o 5d, redesenhado na grade de 16". Ou seja: a resposta do design para o tamanho pequeno
// NÃO é encolher a mestra nem cortar um busto — é uma SEGUNDA arte, autorada onde cada pixel do desenho
// é um pixel da tela. As duas convivem aqui:
//
//   - `MASCOT` / `RESTING` (50 células) — a arte com humor. Serve o app (topnav, chat, login) e os
//     ícones grandes (≥180px), onde há pixel de sobra para a anatomia inteira.
//   - `MICRO` (16 células) — o mesmo bicho redesenhado para a aba do navegador (16/32/48px). Sem humor
//     de propósito: um favicon é IDENTIDADE, não estado de agente.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// O QUE A GRADE **NÃO** GARANTE — e por que isso está OK.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Uma célula só cai num número inteiro de pixels quando o tamanho é múltiplo de `GRID` (50). Dos quatro
// degraus, três são (`sm`/`md`/`lg`); o `xs` = 40px NÃO é, e continua 40 de propósito: é ele quem dá a
// altura da barra de topo, e crescer a barra do app inteiro para agradar a aritmética seria trocar um
// problema real por um imaginário. O que sustenta essa escolha:
//
//  1. A prancha renderiza a mestra a 48, 60, 104 e 120px — nenhum múltiplo de 100 — e é assim que o
//     design foi aprovado. 40px está dentro do regime que ela sanciona (o corte é em 32).
//  2. Nada aqui usa `shape-rendering: crispEdges` (ver a nota 1b em `CopilotFace.tsx`): sem ele, uma
//     célula fracionária vira meio-tom SIMÉTRICO — levemente suave, nunca torto. É o oposto do defeito
//     antigo, em que cada aresta arredondava por conta própria e peças iguais saíam diferentes.
//  3. Onde o pixel é ASSADO e não há como recuperá-lo depois — os PNG de favicon/PWA — a célula inteira
//     é obrigatória por construção (`scripts/gen-icons.ts` recusa alvo fracionário) e o tamanho pequeno
//     usa a `MICRO`, que fecha exato em 16/32/48.
//
// A menor peça de qualquer arte é de **2 células** (as 4 unidades da prancha): a 40px isso são 1,6px CSS
// — 3,2 pixels de tela num retina. O teste (`mascot.test.ts`) trava esse piso.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Os recortes deixaram de ser `<mask>` e são SUBCAMINHOS de sentido invertido dentro de UM `<path>`
// (`silhouettePath`): furo de geometria, numa rasterização só, sem buffer intermediário e sem cinza.
// Por que "recorte" e não "olho branco": o mascote mora sobre superfícies claras E escuras (tema), então
// o olho é um BURACO que revela o fundo do painel, seja ele qual for. A mesma arte serve aos dois temas.
//
// E por que NÃO existe `<text>` no desenho: o `!` e o `z` eram glifos de fonte mono. Fonte é justamente
// o que o rosto ASCII original tinha de errado — o desenho mudava com o leitor. Agora eles são
// retângulos como todo o resto: o Jido inteiro fala UMA língua (a célula), sem depender de fonte nenhuma.

import type { MoodId } from "@/lib/storymap/copilot/face";

/** Um retângulo da grade: `[x, y, largura, altura]` em CÉLULAS inteiras (0..GRID). */
export type Pixel = readonly [x: number, y: number, w: number, h: number];

/** A pose dos braços — a única parte da silhueta que se move (o design: "braços sobem/descem na grade"). */
export type ArmPose = "neutro" | "aceno" | "baixo" | "festa";

/** A animação de grupo (simples, só transform/opacity → barata e congelável por `prefers-reduced-motion`):
 *  `pulse` pisca os glifos (pontos de pensar, ondas, ✦), `float` faz os `z` subirem, `shake` treme o corpo. */
export type MascotAnim = "none" | "pulse" | "float" | "shake";

/**
 * Um GLIFO externo — as peças que se movem JUNTAS.
 *
 * Existe por causa de um defeito de animação concreto: os `z` do sono são TRÊS barras (topo,
 * diagonal, base) e a lista de tinta era plana, então cada peça recebia um `animation-delay`
 * próprio. Resultado: enquanto o `z` subia, as três barras estavam em alturas e opacidades
 * diferentes — o glifo se desmanchava no ar em vez de flutuar. Agrupar diz ao desenho o que é UMA
 * coisa. Onde o glifo é um ponto só (os pontos de pensar, os ✦, as ondas), o grupo tem uma peça e
 * nada muda; a defasagem entre GRUPOS continua sendo o que dá o efeito de cascata.
 */
export type InkGlyph = readonly Pixel[];

/**
 * A ARTE de um humor. Tudo opcional exceto olhos+braços, e tudo declarativo:
 * - `arms`   — a pose (sempre explícita para o desenho ser óbvio na leitura).
 * - `cuts`   — os RECORTES subtraídos da silhueta (olhos + boca). Viram buracos de verdade no `<path>`.
 * - `ink`    — os GLIFOS externos, pintados na cor do mascote POR CIMA (não recortados): z, !, ✦,
 *              ondas. Uma lista de GRUPOS: cada grupo anima como uma peça só (ver `InkGlyph`).
 * - `blinkEyes` — os retângulos que uma "pálpebra" (na cor do corpo) cobre na piscada periódica. Ausente ⇒
 *                 este humor NÃO pisca (olho arregalado/morto/fechado não pisca).
 * - `lips`   — uma região de boca sobre a qual um "lábio" animado abre/fecha (o humor `falando`).
 * - `anim`   — a animação de grupo dos `ink` (ou do corpo, no caso de `shake`).
 */
export interface MascotArt {
  readonly arms: ArmPose;
  readonly cuts: readonly Pixel[];
  readonly ink?: readonly InkGlyph[];
  readonly blinkEyes?: readonly Pixel[];
  readonly lips?: Pixel;
  readonly anim?: MascotAnim;
}

/** O lado da grade MESTRA, em CÉLULAS. É a viewBox do SVG. 1 célula = 2 unidades da prancha de 100. */
export const GRID = 50;

/** O eixo de simetria do corpo. Todo par esquerdo/direito espelha aqui (o teste cobra). */
export const AXIS = GRID / 2;

/** A menor peça que qualquer arte pode ter, em células — as 4 unidades da prancha. Abaixo disso o
 *  detalhe some no degrau pequeno, que é o defeito que a grade existe para impedir. */
export const MIN_FEATURE = 2;

/** Os degraus de tamanho do rosto, em px. */
export type FaceSize = "xs" | "sm" | "md" | "lg";

/**
 * A ESCADA. Três dos quatro degraus são múltiplos de `GRID` (célula inteira: 1, 2 e 3px). O `xs` é a
 * exceção deliberada, explicada no topo: ele dá a altura da barra de topo, e o design sanciona a arte
 * mestra até ~40px.
 */
export const SIZE_PX: Record<FaceSize, number> = {
  // O topnav é a casa do mascote: ali ele é o rosto do agente (o item mais destacado da barra) e o alvo
  // de mouse do balão de fala que pende dele — não um ícone entre ícones. É TAMBÉM o tamanho do mascote
  // que escreve no chat (JidoCursor): quem escreve é o mesmo que está na barra, no mesmo tamanho.
  xs: 40, // topnav + o mascote que escreve  → 0,8px por célula (ver a nota 2 no topo)
  sm: 50, // inline, ao lado de texto        → 1px
  md: 100, // a marca no login / rosto grande → 2px
  lg: 150, // espera de um painel inteiro     → 3px
};

// ─────────────────────────────────────────────────────────────────────────────
// ANATOMIA FIXA — transcrita da prancha (card 3a). NUNCA muda: é o que dá identidade.
// A silhueta ocupa y 8..40 e x 4..46; as margens que sobram são onde os `ink` (z, !, ✦) respiram.
// ─────────────────────────────────────────────────────────────────────────────

/** A silhueta imutável: nó da antena, tronco/cabeça e as duas pernas. Os braços vêm de `ARMS` (movem). */
export const BODY: readonly Pixel[] = [
  [22, 8, 6, 6], // antena — o nó no topo, centrado no eixo   (prancha: 44,16,12,12)
  [10, 14, 30, 19], // cabeça/corpo — onde TODO recorte cabe     (prancha: 20,28,60,38)
  [15, 33, 6, 7], // perna esquerda                            (prancha: 30,66,12,14)
  [29, 33, 6, 7], // perna direita                             (prancha: 58,66,12,14)
];

/** O bloco da cabeça — a moldura que todo recorte respeita (um olho fora dela é um furo invisível). */
export const HEAD: Pixel = BODY[1];

/** A linha que separa OLHO de BOCA: recorte acima dela é olho, abaixo é boca. Vale para o teste de
 *  simetria (a boca do `piscando` não deve ser cobrada como olho) e para a leitura do desenho. */
export const BROW_LINE = HEAD[1] + HEAD[3] / 2;

/** As poses de braço, todas da prancha. Cada uma são os DOIS braços (esquerdo, direito), espelhados no
 *  eixo — exceto o `aceno` (card 3b), onde a assimetria É o gesto: o direito ergue para dizer "olá". */
export const ARMS: Record<ArmPose, readonly [Pixel, Pixel]> = {
  neutro: [
    [4, 18, 6, 6],
    [40, 18, 6, 6],
  ],
  aceno: [
    [4, 18, 6, 6],
    [41, 10, 6, 6], // direito ERGUIDO — o "olá" (prancha 3b: 82,20,12,12)
  ],
  baixo: [
    [4, 22, 6, 6],
    [40, 22, 6, 6], // os dois CAÍDOS — o desânimo (prancha 3l: 8/80,44)
  ],
  festa: [
    [3, 11, 6, 6],
    [41, 11, 6, 6], // os dois ERGUIDOS — a comemoração (prancha 3h: 6/82,22)
  ],
};

// atalho para deixar o mapa abaixo legível (a arte é dado, não código).
const r = (x: number, y: number, w: number, h: number): Pixel => [x, y, w, h];

// ── O vocabulário de rosto, reusado pelos humores ────────────────────────────
// Os olhos padrão são 4×6 células (retrato), em x 17..21 / 29..33 — espelhados no eixo. A boca fica
// DUAS células abaixo do olho: encostar olho e boca funde as duas peças num borrão só quando encolhe.

/** Olhos neutros — o card 3a, literal. */
const EYES: readonly [Pixel, Pixel] = [r(17, 20, 4, 6), r(29, 20, 4, 6)];
/** Olhos ERGUIDOS (pensar / comemorar / acenar). A prancha ergue 5 unidades; 2 células é o mesmo gesto
 *  sem sair da grade — e mantém o x dos olhos neutros, como o próprio card 3b faz. */
const EYES_UP: readonly [Pixel, Pixel] = [r(17, 18, 4, 6), r(29, 18, 4, 6)];

/** O sorriso do card 3i: cantos ERGUIDOS + a barra. Os cantos tocam a barra só pela QUINA — é a
 *  escadinha que lê como curva (e que virava mingau na grade fracionária). */
const SMILE: readonly Pixel[] = [r(19, 27, 2, 2), r(29, 27, 2, 2), r(21, 29, 8, 2)];
/** O MESMO sorriso duas células acima — o card 3h (comemorando), onde a boca sobe com os braços. */
const SMILE_UP: readonly Pixel[] = [r(19, 25, 2, 2), r(29, 25, 2, 2), r(21, 27, 8, 2)];
/** A boca reta e curta do card 3n (focado): concentração sem emoção. */
const FLAT_MOUTH: Pixel = r(21, 29, 8, 2);

/** O `!` externo (pânico/erro) — barra + ponto, à DIREITA da cabeça e acima da linha do braço. Na
 *  prancha ele é um glifo de fonte (`<text>`); aqui é retângulo, como todo o resto do desenho. */
const BANG: readonly InkGlyph[] = [[r(42, 6, 2, 6), r(42, 14, 2, 2)]];

/** Os olhos em `×` do card 3d — cinco peças de 2×2 formando a cruz, espelhadas no eixo. */
const X_EYES: readonly Pixel[] = [
  r(16, 18, 2, 2), r(20, 18, 2, 2), r(18, 20, 2, 2), r(16, 22, 2, 2), r(20, 22, 2, 2),
  r(32, 18, 2, 2), r(28, 18, 2, 2), r(30, 20, 2, 2), r(32, 22, 2, 2), r(28, 22, 2, 2),
];

// ─────────────────────────────────────────────────────────────────────────────
// O MAPA HUMOR → ARTE. Exaustivo por `MoodId` (o teste trava). Adicionar humor = adicionar UMA entrada.
// A coluna da direita diz de qual card da prancha cada um foi transcrito.
// ─────────────────────────────────────────────────────────────────────────────

export const MASCOT: Record<MoodId, MascotArt> = {
  // repouso amigável: olhos calmos + sorriso (card 3i). A piscada universal já o mantém vivo.
  feliz: {
    arms: "neutro",
    cuts: [...EYES, ...SMILE],
    blinkEyes: EYES,
  },

  // respondendo (cuspindo texto): olhos calmos + a boca ABRE e FECHA (o `lips` animado por cima do
  // recorte). A prancha não tem "falando"; a boca é a do card 3n alta o bastante (4 células) para o
  // lábio fechar em DOIS passos inteiros — 0, 2 e 4 células, sem meia célula no meio do caminho.
  falando: {
    arms: "neutro",
    cuts: [...EYES, r(21, 28, 8, 4)],
    blinkEyes: EYES,
    lips: r(21, 28, 8, 4),
  },

  // pensando (card 3c): olhos erguidos + os pontos do balão de pensamento pulsando.
  pensativo: {
    arms: "neutro",
    cuts: [...EYES_UP],
    ink: [[r(42, 8, 3, 3)], [r(46, 4, 2, 2)]],
    blinkEyes: EYES_UP,
    anim: "pulse",
  },

  // trabalhando/programando (card 3d): olhos `×` concentrados + a boca de TRÊS pontinhos, em 19, 24
  // e 29 — o do meio exatamente no eixo. (Histórico: numa grade de 20 os três exigiriam meia célula
  // para centrar e por isso viravam uma barra; a grade do design os acomoda inteiros.)
  codigo: {
    arms: "neutro",
    cuts: [...X_EYES, r(19, 28, 2, 2), r(24, 28, 2, 2), r(29, 28, 2, 2)],
  },

  // esperando VOCÊ (card 3j): olhos grandes + boca redonda. Travado — NÃO pisca.
  surpreso: {
    arms: "neutro",
    cuts: [r(16, 19, 6, 7), r(28, 19, 6, 7), r(23, 28, 4, 4)],
  },

  // pedindo confirmação de algo IRREVERSÍVEL: os olhos do surpreso + um `!` + o corpo TREME.
  panico: {
    arms: "neutro",
    cuts: [r(16, 19, 6, 7), r(28, 19, 6, 7), r(23, 28, 4, 4)],
    ink: BANG,
    anim: "shake",
  },

  // erro/turno morto (card 3m): olhos em `×` + `!`. Estático — sem piscar.
  erro: {
    arms: "neutro",
    cuts: [...X_EYES],
    ink: BANG,
  },

  // instável (retry da API / conexão caída): olhos assimétricos + boca torta, e o corpo TREME (o
  // "glitch"). Aqui a assimetria é INTENCIONAL — é ela que faz o desenho parecer com defeito.
  glitch: {
    arms: "neutro",
    cuts: [r(17, 20, 4, 6), r(29, 22, 4, 4), r(19, 29, 7, 2)],
    anim: "shake",
  },

  // satisfeito / você aprovou (card 3h): braços ERGUIDOS + sorriso alto + ✦ cintilando.
  amoroso: {
    arms: "festa",
    cuts: [...EYES_UP, ...SMILE_UP],
    ink: [[r(6, 4, 3, 3)], [r(41, 4, 3, 3)], [r(13, 1, 2, 2)], [r(35, 1, 2, 2)]],
    blinkEyes: EYES_UP,
    anim: "pulse",
  },

  // agindo sozinho no board (o tick autônomo) — card 3f (ouvindo): olhos calmos, boca reta e as
  // "ondas" de atividade saindo da antena.
  conectado: {
    arms: "neutro",
    cuts: [...EYES, FLAT_MOUTH],
    ink: [[r(18, 5, 2, 2)], [r(15, 2, 2, 2)], [r(30, 5, 2, 2)], [r(33, 2, 2, 2)]],
    blinkEyes: EYES,
    anim: "pulse",
  },

  // cansado / você rejeitou (card 3l): braços CAÍDOS + olhos baixos + boca PARA BAIXO.
  //
  // ⚠️ DESVIO CONSCIENTE da prancha, o único deste mapa. No card 3l a boca do "triste" repete o arco do
  // "feliz" duas unidades abaixo — mas canto ACIMA da barra é um SORRISO, esteja onde estiver, e o
  // desenho lia como alguém contente de braços caídos. Aqui os cantos DESCEM: é a boca de fato
  // invertida. A prancha pede explicitamente esse retorno ("Me aponte estados a ajustar").
  triste: {
    arms: "baixo",
    cuts: [r(17, 22, 4, 5), r(29, 22, 4, 5), r(21, 29, 8, 2), r(19, 31, 2, 2), r(29, 31, 2, 2)],
    blinkEyes: [r(17, 22, 4, 5), r(29, 22, 4, 5)],
  },

  // dormindo (card 3g): olhos em linha (fechados) + os `z z` subindo. Não pisca.
  dormindo: {
    arms: "neutro",
    cuts: [r(16, 23, 6, 2), r(28, 23, 6, 2)],
    // os `z` são DESENHO (barra · diagonal · barra) e não glifo de fonte — nítidos em todo degrau.
    ink: [
      [r(42, 10, 6, 2), r(44, 12, 2, 2), r(42, 14, 6, 2)], // z grande, colado na cabeça
      [r(44, 2, 4, 2), r(45, 4, 2, 2), r(44, 6, 4, 2)], // z pequeno, subindo
    ],
    anim: "float",
  },

  // piscadela ("pronto/entendi"): olho esquerdo aberto, direito fechado, sorriso. Só o aberto pisca.
  piscando: {
    arms: "neutro",
    cuts: [r(17, 20, 4, 6), r(29, 23, 4, 2), ...SMILE],
    blinkEyes: [r(17, 20, 4, 6)],
  },
};

/**
 * O JIDO EM REPOUSO — o card 3a da prancha, literal, e de propósito NÃO um humor.
 *
 * Dois olhos calmos e simétricos, **sem boca** e **sem piscadela de um olho só**: nada de sorriso
 * (que promete simpatia que a tela não está entregando) e nada de wink (que é um gesto DIRIGIDO a
 * alguém — o `piscando` do mapa acima existe para dizer "entendi", uma resposta). Aqui ele não está
 * reagindo a nada: está parado, vivo, esperando. A única coisa que se move é a piscada periódica
 * dos DOIS olhos (`jido-blink`), que é o que separa "em repouso" de "desenho morto".
 *
 * Fica FORA de `MASCOT` porque `MoodId` é o vocabulário de ESTADO DO COPILOTO, e o teste de
 * exaustividade casa `MASCOT` com `EXPRESSIONS` exatamente por isso. É também a cara do ÍCONE
 * (`scripts/gen-icons.ts`): a aba do navegador é identidade, não estado de agente.
 */
export const RESTING: MascotArt = {
  arms: "neutro",
  cuts: [...EYES],
  blinkEyes: EYES,
};

// ─────────────────────────────────────────────────────────────────────────────
// A ARTE MICRO — o card 5d: o mesmo bicho redesenhado numa grade de 16.
// ─────────────────────────────────────────────────────────────────────────────

/** O lado da grade MICRO, em células. 16/32/48px fecham em 1, 2 e 3px por célula — exato, sempre. */
export const MICRO_GRID = 16;

/**
 * O favicon, transcrito do card 5d. "Cada pixel do desenho é um pixel da tela: olhos de 2×3, braços e
 * pernas de 2×2. Nada de meio-pixel, nada de antialias."
 *
 * Ele NÃO é a mestra encolhida nem um busto recortado: é um desenho próprio, com as mesmas seis peças
 * (antena, dois braços, corpo, duas pernas) e os dois olhos vazados, proporcionado para caber inteiro
 * numa moldura de 16. Enquadramento: a grade INTEIRA, não a caixa do desenho — é o que dá a margem de
 * 1 célula nas laterais e 3 no topo que a prancha mostra, e o que faz o quadrado preto ter presença
 * na aba (card 5e).
 */
export const MICRO: { readonly solids: readonly Pixel[]; readonly cuts: readonly Pixel[] } = {
  solids: [
    [7, 3, 2, 2], // antena
    [1, 7, 2, 2], // braço esquerdo
    [13, 7, 2, 2], // braço direito
    [3, 5, 10, 7], // corpo
    [5, 12, 2, 2], // perna esquerda
    [9, 12, 2, 2], // perna direita
  ],
  cuts: [
    [5, 7, 2, 3], // olho esquerdo
    [9, 7, 2, 3], // olho direito
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// A SILHUETA COMO UM CAMINHO SÓ — corpo, braços e furos, numa rasterização única.
// ─────────────────────────────────────────────────────────────────────────────

/** Um retângulo no sentido HORÁRIO (direita → baixo → esquerda), em coordenadas de tela (y cresce p/ baixo). */
function rectCW([x, y, w, h]: Pixel): string {
  return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
}

/** O MESMO retângulo no sentido ANTI-HORÁRIO (baixo → direita → cima). Sob a regra `nonzero`, um subcaminho
 *  de sentido invertido dentro de uma região preenchida vira BURACO — é assim que o olho revela o fundo. */
function rectCCW([x, y, w, h]: Pixel): string {
  return `M${x} ${y}V${y + h}H${x + w}V${y}Z`;
}

/**
 * O `d` de UM `<path>`: as peças sólidas no horário, os recortes no invertido.
 *
 * Antes isso era uma `<mask>` com um id gerado por instância. Duas coisas melhoram ao virar caminho: o
 * furo passa a ser GEOMETRIA (nada de buffer de máscara rasterizando com alpha parcial — a origem do
 * recorte cinza no tamanho pequeno), e some o id gerado, e com ele o risco de colisão entre as várias
 * caras da mesma tela. Usamos `nonzero` (o padrão) com o furo INVERTIDO, e não `evenodd`, de propósito:
 * sob `evenodd`, duas peças da silhueta que se sobrepusessem furariam uma à outra na interseção — o
 * oposto do que se espera de um corpo.
 */
export function pathOf(solids: readonly Pixel[], cuts: readonly Pixel[]): string {
  return solids.map(rectCW).join("") + cuts.map(rectCCW).join("");
}

/** A silhueta de um humor da arte MESTRA (corpo + a pose de braço + os recortes do rosto). */
export function silhouettePath(art: MascotArt): string {
  const [armL, armR] = ARMS[art.arms];
  return pathOf([...BODY, armL, armR], art.cuts);
}

/** A silhueta da arte MICRO (card 5d) — mesma técnica de furo, grade de 16. */
export function microPath(): string {
  return pathOf(MICRO.solids, MICRO.cuts);
}
