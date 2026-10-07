// 📋 PRD v1 — o formato ANTIGO do PRD (20 seções, metade delas técnica), mantido SÓ como fonte da
// migração (`migrations.ts` → `migratePrdV1`). Nenhuma tela, tool ou prompt lê por este schema: um
// `docs/prd.md` sem `format: 2` é lido por aqui UMA vez e projetado no PRD v2 + `docs/contexto.md`.
//
// Por que o PRD mudou: ele misturava o documento de NEGÓCIO (problema, público, proposta) com o
// contexto que só os agentes usam (decisões, requisitos, riscos, glossário). O dono lia um documento
// longo para achar as cinco coisas que decide; o agente lia um documento longo para achar as cinco
// que obedece. Agora são dois: `prd.md` (do dono) e `contexto.md` (dos agentes).
//
// Não edite as seções daqui: elas são o formato que existe em disco nos boards antigos, e mudar um
// rótulo faria a migração deixar de reconhecer o que o autor escreveu.

import { z } from "zod";
import type { DocSchema, SectionRule } from "../doc-schema";

import { PRD_DOC_TYPE } from "./prd";

/**
 * O que a MÁQUINA lê no cabeçalho. Mínimo de propósito: um campo declarado aqui sem ninguém que o
 * leia é capacidade sem produtor — parece funcionalidade e nunca dispara. `passthrough` deixa o
 * autor guardar o que quiser sem que a validação recuse o documento dele.
 */
export const PrdV1FrontmatterSchema = z
  .object({
    doc: z.literal(PRD_DOC_TYPE).optional(),
  })
  .passthrough();

const top = (
  key: string,
  label: string,
  content: SectionRule["content"],
  hint: string,
  extra: Partial<SectionRule> = {},
): SectionRule => ({ key, label, level: 2, locked: true, required: false, content, hint, ...extra });

const sub = (
  key: string,
  parent: string,
  label: string,
  content: SectionRule["content"],
  hint: string,
  extra: Partial<SectionRule> = {},
): SectionRule => ({
  key,
  parent,
  label,
  level: 3,
  locked: true,
  required: false,
  content,
  hint,
  ...extra,
});

/** As seções que sustentam o resto: sem elas o documento não orienta ninguém, humano ou agente. */
const REQUIRED = { required: true } as const;

export const PRD_V1_SCHEMA: DocSchema = {
  docType: PRD_DOC_TYPE,
  title: { kind: "fixed", text: "PRD" },
  frontmatter: PrdV1FrontmatterSchema,
  allowFreeTail: false,
  sections: [
    top(
      "resumo",
      "Resumo executivo",
      "prose",
      "O que estamos construindo, para quem e por que AGORA — em um parágrafo que alguém entenda sem ler o resto.",
      REQUIRED,
    ),

    top(
      "problema",
      "Problema",
      "groups",
      "As dores, ditas do ponto de vista de quem as sente — não a falta da sua solução. Aprofunda o «Problema» do Lean Canvas.",
      { ...REQUIRED, max: 5 },
    ),

    top(
      "publico",
      "Público",
      "groups",
      'Um `###` por segmento. Para cada um: o job-to-be-done, quando ele decide e com que informação na mão. Aprofunda os «Segmentos de clientes» do Lean Canvas.',
      REQUIRED,
    ),
    sub(
      "alternativas",
      "publico",
      "Alternativas hoje",
      "items",
      "Como esse público resolve a dor sem você: concorrente, planilha, gambiarra, ou não resolver.",
    ),

    top(
      "posicionamento",
      "Posicionamento",
      "prose",
      "Para [segmento], o [produto] é o [categoria] que [benefício] — ao contrário de [alternativa], que [limite]. Uma frase, verificável.",
      REQUIRED,
    ),

    top(
      "objetivos",
      "Objetivos e métricas",
      "prose",
      "O enquadramento em uma ou duas frases; os números vivem nas três subseções abaixo.",
      REQUIRED,
    ),
    sub(
      "metricaNegocio",
      "objetivos",
      "Métrica de negócio",
      "items",
      "O resultado do resultado (lagging): receita, retenção, valor de vida do cliente. Idealmente UM.",
      { max: 2 },
    ),
    sub(
      "resultadoAlvo",
      "objetivos",
      "Resultado-alvo",
      "items",
      "O comportamento que o produto persegue AGORA e que move a métrica de negócio. É o vértice ao qual as stories sobem.",
      { max: 3 },
    ),
    sub(
      "sinaisLideres",
      "objetivos",
      "Sinais-líderes",
      "items",
      "O que se mexe ANTES da métrica de negócio — o que diz em uma semana se o caminho está certo.",
    ),

    top(
      "escopo",
      "Escopo",
      "groups",
      "Três `###`: «Nesta versão» (o mínimo que entrega o resultado-alvo), «Fora, por ora» e «Nunca». O que fica de fora vale tanto quanto o que entra.",
      REQUIRED,
    ),

    top(
      "solucao",
      "Solução",
      "groups",
      "As capacidades que resolvem cada problema, agrupadas por arco de uso. O mínimo, em poucas palavras — não a lista de telas.",
    ),

    top(
      "jornadas",
      "Jornadas",
      "items",
      "Os percursos de ponta a ponta, um por linha, na ordem em que a pessoa os vive. É daqui que sai o backbone do mapa.",
    ),

    top(
      "requisitos",
      "Requisitos",
      "groups",
      "Dois `###`: «Funcionais» (o que o sistema faz) e «Não-funcionais» (desempenho, acessibilidade, privacidade, custo, limites).",
    ),

    top(
      "decisoes",
      "Decisões já tomadas",
      "items",
      "O que NÃO está mais em aberto: biblioteca, formato, nome, integração, abordagem. Um agente que não sabe que a decisão foi tomada toma a dele.",
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
      "Três `###`: «Receita», «Custo» e «Preço a testar». Aprofunda «Fontes de receita» e «Estrutura de custos» do Lean Canvas.",
    ),

    top(
      "lancamento",
      "Lançamento",
      "items",
      "Como isto chega ao público: canais, marcos, o que precisa estar pronto em cada um. Aprofunda os «Canais» do Lean Canvas.",
    ),

    top(
      "prontoQuando",
      "Pronto quando",
      "items",
      "Os critérios de verificação do PRODUTO — cada um observável por alguém de fora. «Funciona» não é critério.",
    ),

    top(
      "glossario",
      "Glossário",
      "items",
      "Os termos do domínio no formato `**termo** — significado`. É o vocabulário que os agentes vão adotar ao escrever card e código.",
    ),
  ],
};
