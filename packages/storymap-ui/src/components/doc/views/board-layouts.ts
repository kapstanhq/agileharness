// 🪟 LAYOUTS de quadro — Camada 3 pura, e o arquivo que PROVA o desacoplamento.
//
// Um layout é um REFINAMENTO OPCIONAL: ele diz como um docType específico gosta de se arrumar num
// quadro. `boardLayoutFor` devolvendo `null` não é um erro nem um caso degradado — é o caminho
// normal de qualquer documento que ainda não ganhou (ou nunca vai ganhar) um arranjo próprio: o
// quadro cai no fluxo automático e continua servindo.
//
// TESTE DO APAGAMENTO, na prática: apague este arquivo inteiro. O Business Model Canvas continua abrindo no
// quadro — só perde a grade clássica de Osterwalder e cai no fluxo automático. Nada fica órfão, porque nada do
// CONTEÚDO dependia daqui. Foi para isto que as strings de grid saíram do registro de blocos.
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
 * O Business Model Canvas clássico (Osterwalder): na linha de cima, cinco colunas — Parcerias | Atividades sobre
 * Recursos | Proposta de valor | Relacionamento sobre Canais | Segmentos —, com Parcerias, Proposta e Segmentos
 * ocupando as duas linhas; embaixo, duas metades — Custos | Receitas. A grade tem 10 trilhas para as metades de
 * baixo caberem sem meia coluna. Abaixo de `lg` nada é posicionado: o quadro vira LISTA na ordem do schema, que é a
 * ordem de preenchimento (segmentos → proposta → canais → … → custos).
 */
const BMC_LAYOUT: BoardLayout = {
  docType: "business-model-canvas",
  // linhas pelo CONTEÚDO (auto) e cada célula do tamanho dela (`self-start`): com linhas iguais (`1fr`) uma Proposta
  // de valor longa esticava as células curtas ao lado (Parcerias, Relacionamento) em centenas de px de cartão vazio
  container: "lg:grid-cols-10 lg:grid-rows-[auto_auto_auto]",
  cells: {
    keyPartners: "lg:col-start-1 lg:col-span-2 lg:row-start-1 lg:row-span-2 lg:self-start",
    keyActivities: "lg:col-start-3 lg:col-span-2 lg:row-start-1 lg:self-start",
    keyResources: "lg:col-start-3 lg:col-span-2 lg:row-start-2 lg:self-start",
    valuePropositions: "lg:col-start-5 lg:col-span-2 lg:row-start-1 lg:row-span-2 lg:self-start",
    customerRelationships: "lg:col-start-7 lg:col-span-2 lg:row-start-1 lg:self-start",
    channels: "lg:col-start-7 lg:col-span-2 lg:row-start-2 lg:self-start",
    customerSegments: "lg:col-start-9 lg:col-span-2 lg:row-start-1 lg:row-span-2 lg:self-start",
    costStructure: "lg:col-start-1 lg:col-span-5 lg:row-start-3 lg:self-start",
    revenueStreams: "lg:col-start-6 lg:col-span-5 lg:row-start-3 lg:self-start",
  },
  // sem `compact`: os nove blocos leem os itens do MESMO jeito (nota) — três blocos em texto miúdo ao lado de seis em
  // cartão pareciam outro tipo de conteúdo, e não eram
};

const LAYOUTS: readonly BoardLayout[] = [BMC_LAYOUT];

/** O arranjo declarado deste docType, ou `null` — e `null` é um caminho de primeira classe. */
export function boardLayoutFor(docType: string): BoardLayout | null {
  return LAYOUTS.find((l) => l.docType === docType) ?? null;
}

/** O arranjo automático: colunas que se acomodam, cada seção ocupando uma célula. */
export const AUTO_BOARD_CONTAINER = "sm:grid-cols-2 xl:grid-cols-3";
