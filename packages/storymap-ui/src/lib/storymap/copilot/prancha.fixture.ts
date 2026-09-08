// A PRANCHA DO CLAUDE DESIGN, TRANSCRITA — a fonte primária do mascote, dentro do repositório.
//
// Projeto `4eaf94b6-a8db-48e4-b18c-bec26494b6d1`, documentos "Mascote AgileHarness" (cards 3a/3b/3h/3l)
// e "Ícone App AgileHarness" (cards 5a/5c/5d). Os números abaixo são copiados VERBATIM de lá.
//
// POR QUE ELES VIVEM NO REPOSITÓRIO: quem for conferir a fidelidade do desenho pode não ter acesso à
// prancha (o conector do Claude Design é opcional, e uma revisão independente de 2026-08-03 travou
// exatamente nisso — teve de dar a nota apoiada em "acreditar nos comentários"). Com a transcrição
// versionada, a checagem vira aritmética: `célula = unidade / 2` na arte mestra, 1:1 na micro.
//
// POR QUE ELES VIVEM NUM ARQUIVO PRÓPRIO, e não dentro de um teste: são consumidos por DOIS testes —
// `mascot.test.ts` (a anatomia e as poses) e `mascot-icons.test.ts` (o enquadramento dos ícones). A
// primeira versão desta transcrição morava dentro do `mascot.test.ts` e o enquadramento acabou
// duplicado como literais soltos no outro arquivo: **duas transcrições da mesma prancha**, que é a
// forma exata de deriva que este módulo existe para impedir no desenho. Uma prancha, uma cópia.
//
// Se a prancha mudar, mude AQUI primeiro e deixe os testes apontarem o que na arte ficou para trás.
//
// ⚠️ Isto é FIXTURE, não código de produção: nada em `src/` importa daqui, e não deve. A arte viva é
// `mascot.ts`; este arquivo é a régua contra a qual ela é medida.

/** Um retângulo da prancha: `[x, y, largura, altura]`, nas unidades do card de origem. */
export type PranchaRect = readonly [x: number, y: number, w: number, h: number];

export const PRANCHA = {
  /**
   * Card 3a — "neutro": a anatomia FIXA, numa viewBox de 100. É a base de todos os humores; só
   * olhos, boca, braços e glifos mudam de card para card.
   */
  card3a: {
    antena: [44, 16, 12, 12] as PranchaRect,
    bracoE: [8, 36, 12, 12] as PranchaRect,
    bracoD: [80, 36, 12, 12] as PranchaRect,
    corpo: [20, 28, 60, 38] as PranchaRect,
    pernaE: [30, 66, 12, 14] as PranchaRect,
    pernaD: [58, 66, 12, 14] as PranchaRect,
    olhoE: [34, 40, 8, 12] as PranchaRect,
    olhoD: [58, 40, 8, 12] as PranchaRect,
  },
  /** Card 3b — "olá": só o braço DIREITO sai do lugar; a assimetria é o gesto. */
  card3b: { bracoDErguido: [82, 20, 12, 12] as PranchaRect },
  /** Card 3h — "comemorando": os dois braços erguidos. */
  card3h: { bracoE: [6, 22, 12, 12] as PranchaRect },
  /** Card 3l — "triste": os dois braços caídos. */
  card3l: { bracoE: [8, 44, 12, 12] as PranchaRect },
  /**
   * Card 5d — o favicon REDESENHADO numa grade de 16 ("de 32px para baixo as pernas e a antena
   * colapsam; por isso existe o 5d"). Aqui a conversão é 1:1 — a grade da prancha já é a nossa.
   */
  card5d: {
    antena: [7, 3, 2, 2] as PranchaRect,
    bracoE: [1, 7, 2, 2] as PranchaRect,
    bracoD: [13, 7, 2, 2] as PranchaRect,
    corpo: [3, 5, 10, 7] as PranchaRect,
    pernaE: [5, 12, 2, 2] as PranchaRect,
    pernaD: [9, 12, 2, 2] as PranchaRect,
    olhoE: [5, 7, 2, 3] as PranchaRect,
    olhoD: [9, 7, 2, 3] as PranchaRect,
  },
  /**
   * Cards 5a e 5c — o ENQUADRAMENTO do ícone, em fração da largura da moldura. O 5a diz "o mascote
   * ocupa 67% da largura no quadrado cheio"; o 5c, "52% na versão maskable, que é o mínimo seguro
   * para o recorte circular do Android".
   */
  enquadramento: { quadradoCheio: 0.67, maskable: 0.52 },
} as const;

/** A conversão da arte MESTRA: 1 célula = 2 unidades da prancha de 100. Literal, sem arredondamento. */
export function emCelulas([x, y, w, h]: PranchaRect): PranchaRect {
  return [x / 2, y / 2, w / 2, h / 2];
}
