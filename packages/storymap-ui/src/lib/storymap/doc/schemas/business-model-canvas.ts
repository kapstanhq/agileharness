// 🟦 Business Model Canvas (Osterwalder) — UMA INSTÂNCIA de {@link DocSchema}, nada mais. É o
// documento do grupo Negócio e SUBSTITUI o Lean Canvas (que fica só como fonte da migração:
// `migrations.ts` → `migrateLeanCanvasToBmc`).
//
// Por que o BMC e não o Lean Canvas: o Lean Canvas é a ferramenta de quem ainda procura o problema
// (problema, solução, métricas, vantagem injusta). O board já tem um PRD que diz o problema e a
// solução em profundidade; o que faltava era o OUTRO lado do negócio — com quem se faz, com que
// recursos, como se mantém o cliente. Esses quatro blocos (parcerias, atividades, recursos,
// relacionamento) não existiam em lugar nenhum.
//
// A ordem das seções é a ordem de PREENCHIMENTO do método (do cliente para dentro: segmentos →
// proposta → canais → relacionamento → receitas, depois a infraestrutura → custos). A ordem VISUAL da
// grade clássica é outra e vive no layout do quadro (`components/doc/views/board-layouts.ts`). É o
// teste do APAGAMENTO (doc-schema-agnostic.test.ts): sem célula, cor nem ícone aqui.
//
// `required: true` em todos os blocos quer dizer só "o HEADING existe" — o esqueleto nasce com os
// nove. Um bloco VAZIO não recusa o salvamento (vazio não é violação; `min` não é declarado), então
// um board novo salva o canvas preenchido pela metade, que é como ele é escrito na vida real.

import { z } from "zod";
import type { DocSchema, SectionRule } from "../doc-schema";

export const BMC_DOC_TYPE = "business-model-canvas";

/** O primeiro item desta seção é o hero do documento — a mesma regra derivada do Lean Canvas. */
export const BMC_HERO_SECTION = "valuePropositions";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Os segmentos coloridos do cabeçalho — os MESMOS do Lean Canvas (a migração os leva sem tradução). */
export const BmcFrontmatterSchema = z
  .object({
    doc: z.literal(BMC_DOC_TYPE).optional(),
    tags: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          color: z.string().regex(HEX, "cor precisa ser hexadecimal (#rgb ou #rrggbb)").optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

const block = (key: string, label: string, hint: string): SectionRule => ({
  key,
  label,
  level: 2,
  locked: true,
  required: true,
  content: "groups",
  hint,
});

export const BMC_SCHEMA: DocSchema = {
  docType: BMC_DOC_TYPE,
  title: { kind: "fixed", text: "Business Model Canvas" },
  frontmatter: BmcFrontmatterSchema,
  allowFreeTail: false,
  sections: [
    block(
      "customerSegments",
      "Segmentos de clientes",
      "Para quem o produto cria valor: um item por grupo de pessoas com a mesma necessidade. O mais importante primeiro.",
    ),
    block(
      "valuePropositions",
      "Proposta de valor",
      "O que a pessoa ganha (ou deixa de sofrer) ao escolher o produto. O primeiro item é a frase principal.",
    ),
    block(
      "channels",
      "Canais",
      "Como cada segmento fica sabendo, compra, recebe e pede ajuda.",
    ),
    block(
      "customerRelationships",
      "Relacionamento com clientes",
      "Que tipo de relação se mantém com cada segmento: atendimento pessoal, autosserviço, comunidade…",
    ),
    block(
      "revenueStreams",
      "Fontes de receita",
      "Pelo que cada segmento paga, e como: venda, assinatura, comissão. Um preço a testar vale mais que uma faixa vaga.",
    ),
    block(
      "keyResources",
      "Recursos-chave",
      "O que precisa existir para a proposta funcionar: pessoas, dados, marca, acervo — e o que é difícil de copiar.",
    ),
    block(
      "keyActivities",
      "Atividades-chave",
      "O que é preciso FAZER bem, todo dia, para entregar a proposta de valor.",
    ),
    block(
      "keyPartners",
      "Parcerias-chave",
      "Quem faz parte do trabalho por fora: fornecedores, parceiros, quem traz cliente.",
    ),
    block(
      "costStructure",
      "Estrutura de custos",
      "Os custos mais altos, fixos e variáveis, e qual atividade ou recurso gera cada um.",
    ),
  ],
};

/** As chaves dos nove blocos, na ordem de preenchimento — o `field` de `propose_change artifact:"canvas"`. */
export const BMC_BLOCK_KEYS: readonly string[] = BMC_SCHEMA.sections.map((s) => s.key);
