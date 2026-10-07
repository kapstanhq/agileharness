// AS FAIXAS DE TELA pela ALTURA, além da largura — PURO (lido pelo tailwind.config.ts, pelo CSS e pelos componentes).
//
// O desenho do computador (o compositor do Jido de duas linhas com 56px de degradê, o trecho do fluxo de 150px em cima
// de cada raia) foi feito para uma tela alta. Num notebook de 1366×~600 úteis ele comia quase metade da altura: a barra
// do topo, a 2ª barra, o fluxo e o compositor deixavam uma tira estreita para os cards, e o degradê tapava os da
// raia No ar. A regra é pela ALTURA porque a largura ali é de computador — o problema não aparece no celular (que já
// tem o compositor compacto) nem num monitor alto.
//
// Três faixas que PARTICIONAM toda tela (o teste prova que cada tamanho cai em exatamente uma):
//   • celular  — abaixo de `md` (768px de largura), em qualquer altura: o comportamento de sempre;
//   • baixa    — computador com menos de 800px de altura: o compositor vira o de UMA fileira (o do celular), o fluxo
//                compacta (~100px) e as raias reservam embaixo só a altura do compositor;
//   • alta     — computador com 800px ou mais: o desenho inteiro, como antes.
// No Tailwind as duas de computador são as variantes `tall:` e `short:` (plugin no tailwind.config.ts); excludentes
// entre si, nenhuma depende da ordem em que o CSS sai.

/** A menor altura (px) em que o computador recebe o desenho inteiro. */
export const TALL_MIN_HEIGHT = 800;

/** Computador ALTO — o desenho de sempre (variante `tall:`). */
export const TALL_DESKTOP_MEDIA = `(min-width: 768px) and (min-height: ${TALL_MIN_HEIGHT}px)`;

/** Computador BAIXO — a tela de notebook (variante `short:`). */
export const SHORT_DESKTOP_MEDIA = `(min-width: 768px) and (max-height: ${TALL_MIN_HEIGHT - 1}px)`;

/** O compositor do Jido é o COMPACTO (uma fileira) no celular E no computador baixo. */
export const COMPACT_COMPOSER_QUERY = `(max-width: 767px), (max-height: ${TALL_MIN_HEIGHT - 1}px)`;

/** As variantes que o tailwind.config.ts registra: nome → media query. */
export const VIEWPORT_VARIANTS: Readonly<Record<"tall" | "short", string>> = {
  tall: TALL_DESKTOP_MEDIA,
  short: SHORT_DESKTOP_MEDIA,
};
