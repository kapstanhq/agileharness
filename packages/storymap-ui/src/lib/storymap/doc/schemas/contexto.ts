// 🧩 Contexto para os agentes — UMA INSTÂNCIA de {@link DocSchema}. O documento companheiro do PRD
// (`docs/contexto.md`): tudo o que um agente precisa para não re-decidir, não inventar e saber quando
// parou — e que o dono não precisa ler para decidir o produto.
//
// Nasceu da separação do PRD v1 (ver `prd.ts`): as seções técnicas e operacionais saíram de lá e vêm
// para cá, pela migração `migratePrdV1`. Não tem página na navegação: é lido e escrito por
// `read_doc`/`write_doc` (escrita livre dos agentes; uma mudança que toque classe do dono — dinheiro,
// marca, dados de pessoas — vai ao Inbox como pergunta), e é lido pelo motor e pelas skills.
//
// Todas as seções são OPCIONAIS: um board novo tem um contexto vazio, e isso é um estado válido.
// `outros` recebe o que não coube em nenhuma — inclusive as seções desconhecidas de um PRD antigo,
// cada uma como um `###` com o rótulo de origem.

import { z } from "zod";
import type { DocSchema, SectionRule } from "../doc-schema";

export const CONTEXTO_DOC_TYPE = "contexto";

export const ContextoFrontmatterSchema = z
  .object({
    doc: z.literal(CONTEXTO_DOC_TYPE).optional(),
  })
  .passthrough();

const top = (key: string, label: string, content: SectionRule["content"], hint: string): SectionRule => ({
  key,
  label,
  level: 2,
  locked: true,
  required: false,
  content,
  hint,
});

export const CONTEXTO_SCHEMA: DocSchema = {
  docType: CONTEXTO_DOC_TYPE,
  title: { kind: "fixed", text: "Contexto para os agentes" },
  frontmatter: ContextoFrontmatterSchema,
  allowFreeTail: false,
  sections: [
    top(
      "decisoes",
      "Decisões já tomadas",
      "items",
      "O que NÃO está mais em aberto: biblioteca, formato, nome, integração, abordagem. Um agente que não sabe que a decisão foi tomada toma a dele.",
    ),
    top(
      "prontoQuando",
      "Pronto quando",
      "items",
      "Os critérios de verificação do PRODUTO — cada um observável por alguém de fora. «Funciona» não é critério.",
    ),
    top(
      "requisitos",
      "Requisitos",
      "groups",
      "Dois `###`: «Funcionais» (o que o sistema faz) e «Não-funcionais» (desempenho, acessibilidade, privacidade, custo, limites).",
    ),
    top(
      "restricoes",
      "Restrições e premissas",
      "items",
      "O que amarra (prazo, orçamento, sistema legado, regra do setor) e o que estamos ASSUMINDO ser verdade sem ter conferido.",
    ),
    top(
      "riscos",
      "Riscos e perguntas em aberto",
      "checklist",
      "Marque o que já foi resolvido. Comece pela premissa que, sendo falsa, cancela o resto.",
    ),
    top(
      "modeloNegocio",
      "Modelo de negócio",
      "groups",
      "O detalhe que o Business Model Canvas resume: «Receita», «Custo» e «Preço a testar».",
    ),
    top(
      "lancamento",
      "Lançamento",
      "items",
      "Como isto chega ao público: canais, marcos, o que precisa estar pronto em cada um.",
    ),
    top(
      "glossario",
      "Glossário",
      "items",
      "Os termos do domínio no formato `**termo** — significado`. É o vocabulário que os agentes adotam ao escrever card e código.",
    ),
    top(
      "outros",
      "Outras notas",
      "groups",
      "O que não coube nas seções acima — um `###` por assunto.",
    ),
  ],
};
