// 🟨 Lean Canvas (Ash Maurya) — UMA INSTÂNCIA de {@link DocSchema}, nada mais.
//
// O que este arquivo NÃO tem, e por quê: célula de grid, ícone, cor, estilo de item, largura,
// "post-it". Tudo isso é Camada 3 e mora em `components/doc/views/board-layouts/lean-canvas.ts`,
// que SÓ a view de quadro importa. Apague aquele arquivo e este continua descrevendo um documento
// perfeitamente válido — é o teste do APAGAMENTO, e ele é mecânico (doc-schema-agnostic.test.ts).
//
// A ordem das seções aqui é a ordem de PREENCHIMENTO do método (segmentos primeiro, vantagem
// injusta por último — medium.com/lean-stack/what-is-the-right-fill-order-for-a-lean-canvas), que
// é também a ordem em que o documento se lê. A ordem VISUAL do quadro de 5 colunas é outra coisa,
// e por isso vive no layout.
//
// Os três refinamentos que o modelo antigo carregava e que sumiram por serem redundantes sob
// markdown-como-fonte:
//   · `itemId`   — existia só para o diff por bloco casar item com item. Sem diff, posição basta.
//   · `group`    — virou o que sempre foi: um `###` autoral dentro da seção (`content: "groups"`).
//   · `highlight`— derivado, não campo: o hero do canvas é o PRIMEIRO item da proposta de valor.

import { z } from "zod";
import type { DocSchema, SectionRule } from "../doc-schema";

export const LEAN_CANVAS_DOC_TYPE = "lean-canvas";

/** O primeiro item desta seção é o hero do documento — regra derivada, sem sintaxe própria. */
export const LEAN_CANVAS_HERO_SECTION = "uniqueValueProposition";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Os segmentos declarados no cabeçalho — o que a máquina lê (a cor pinta, o id casa). */
export const LeanCanvasFrontmatterSchema = z
  .object({
    doc: z.literal(LEAN_CANVAS_DOC_TYPE).optional(),
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

const block = (
  key: string,
  label: string,
  hint: string,
  extra: Partial<SectionRule> = {},
): SectionRule => ({
  key,
  label,
  level: 2,
  locked: true,
  required: true,
  content: "groups",
  hint,
  ...extra,
});

const sub = (key: string, parent: string, label: string, hint: string): SectionRule => ({
  key,
  parent,
  label,
  level: 3,
  locked: true,
  required: false,
  content: "items",
  hint,
});

export const LEAN_CANVAS_SCHEMA: DocSchema = {
  docType: LEAN_CANVAS_DOC_TYPE,
  title: { kind: "fixed", text: "Lean Canvas" },
  frontmatter: LeanCanvasFrontmatterSchema,
  allowFreeTail: false,
  sections: [
    block("customerSegments", "Segmentos de clientes", "Para quem é: os públicos-alvo e usuários."),
    sub(
      "earlyAdopters",
      "customerSegments",
      "Early adopters",
      "O cliente ideal — quem sente a dor mais aguda hoje.",
    ),

    block("problem", "Problema", "As 3 principais dores do cliente, ditas do ponto de vista dele.", {
      max: 3,
    }),
    sub(
      "existingAlternatives",
      "problem",
      "Alternativas existentes",
      "Como o cliente resolve essas dores hoje (concorrentes, gambiarras, fazer na mão).",
    ),

    block(
      "uniqueValueProposition",
      "Proposta de valor única",
      "Uma frase clara do BENEFÍCIO que torna o produto diferente e desejável — não a lista de funcionalidades.",
    ),
    sub(
      "highLevelConcept",
      "uniqueValueProposition",
      "Conceito de alto nível",
      'A analogia "X para Y" (ex.: "YouTube = Flickr de vídeos").',
    ),

    block("solution", "Solução", "O mínimo que resolve cada problema — em poucas palavras.", { max: 3 }),
    block("channels", "Canais", "Os caminhos até o cliente."),
    block(
      "revenueStreams",
      "Fontes de receita",
      "Como o produto ganha dinheiro (um modelo e uma faixa de preço a testar).",
    ),
    block("costStructure", "Estrutura de custos", "Os custos fixos e variáveis."),
    block(
      "keyMetrics",
      "Métricas-chave",
      "Os poucos números que dizem se o negócio vai bem (idealmente um).",
    ),
    block(
      "unfairAdvantage",
      "Vantagem injusta",
      'O que não pode ser copiado nem comprado. Se ainda não tiver, escreva "nenhuma ainda".',
    ),
  ],
};
