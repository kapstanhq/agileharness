// 🪟 LAYOUTS de quadro — Camada 3 pura, e o arquivo que PROVA o desacoplamento.
//
// Um layout é um REFINAMENTO OPCIONAL: ele diz como um docType específico gosta de se arrumar num
// quadro. `boardLayoutFor` devolvendo `null` não é um erro nem um caso degradado — é o caminho
// normal de qualquer documento que ainda não ganhou (ou nunca vai ganhar) um arranjo próprio: o
// quadro cai no fluxo automático e continua servindo.
//
// TESTE DO APAGAMENTO, na prática: apague este arquivo inteiro. O Lean Canvas continua abrindo em
// documento, markdown, tabela e quadro — só perde as 5 colunas do arranjo clássico. Nada fica
// órfão, porque nada do CONTEÚDO dependia daqui. Foi para isto que as strings de grid saíram do
// registro de blocos.
//
// ⚠️ As classes são LITERAIS de propósito: o Tailwind varre texto de fonte, então uma
// `lg:col-start-${n}` computada nunca seria gerada.
//
// O que NÃO está aqui e não voltará: a ordem empilhada (`order-N`). Ela existia porque a ordem
// visual do grid (2,4,8,3,9,5,1,7,6) discordava da ordem de preenchimento que o método ensina — e
// no celular a leitura saía sem sentido. Sob markdown-como-fonte o DOCUMENTO já está na ordem de
// preenchimento, então empilhar é só... não posicionar. O problema deixou de existir junto com a
// duplicação que o causava.

export interface BoardLayout {
  docType: string;
  /** classes do contêiner do grid (o número de colunas é decisão desta camada). */
  container: string;
  /** sectionKey → classes de célula. Chave ausente ⇒ a seção entra no fluxo automático. */
  cells: Record<string, string>;
  /** seções cujos itens se leem como uma linha compacta em vez de uma nota inteira. */
  compact?: readonly string[];
}

/**
 * O Lean Canvas clássico (Ash Maurya): 5 colunas, três blocos altos (problema, proposta de valor e
 * segmentos ocupam duas linhas) e a faixa larga de custos/receita embaixo.
 */
const LEAN_CANVAS_LAYOUT: BoardLayout = {
  docType: "lean-canvas",
  container: "lg:grid-cols-5 lg:grid-rows-[repeat(2,minmax(0,1fr))_auto]",
  cells: {
    problem: "lg:col-start-1 lg:row-start-1 lg:row-span-2",
    solution: "lg:col-start-2 lg:row-start-1",
    keyMetrics: "lg:col-start-2 lg:row-start-2",
    uniqueValueProposition: "lg:col-start-3 lg:row-start-1 lg:row-span-2",
    unfairAdvantage: "lg:col-start-4 lg:row-start-1",
    channels: "lg:col-start-4 lg:row-start-2",
    customerSegments: "lg:col-start-5 lg:row-start-1 lg:row-span-2",
    costStructure: "lg:col-start-1 lg:col-span-3 lg:row-start-3",
    revenueStreams: "lg:col-start-4 lg:col-span-2 lg:row-start-3",
  },
  compact: ["keyMetrics", "channels", "unfairAdvantage", "costStructure", "revenueStreams"],
};

const LAYOUTS: readonly BoardLayout[] = [LEAN_CANVAS_LAYOUT];

/** O arranjo declarado deste docType, ou `null` — e `null` é um caminho de primeira classe. */
export function boardLayoutFor(docType: string): BoardLayout | null {
  return LAYOUTS.find((l) => l.docType === docType) ?? null;
}

/** O arranjo automático: colunas que se acomodam, cada seção ocupando uma célula. */
export const AUTO_BOARD_CONTAINER = "sm:grid-cols-2 xl:grid-cols-3";
