// 📋 PRD — UMA INSTÂNCIA de {@link DocSchema}, nada mais. O documento MAIS ALTO do board: tudo o que
// vem depois (Lean Canvas, backbone do USM, personas, priorização, o contexto de cada run) desce
// daqui.
//
// Ele SUBSTITUI o "Posicionamento", que eram três strings soltas no `board.yaml` (`positioning`,
// `businessMetric`, `desiredOutcome`) projetadas como documento. O problema não era a projeção: era
// o conteúdo. Uma frase de posicionamento (Kotler/Keller, STP) não diz quem é o cliente em detalhe,
// que problema se resolve, o que fica FORA de escopo, nem que decisões já foram tomadas — e era essa
// linha única que todo agente herdava como norte.
//
// A ordem das seções é a ordem em que o documento se ARGUMENTA, que é também a ordem em que ele se
// preenche: por que existe (resumo, problema) → para quem (público) → o que prometemos
// (posicionamento, objetivos) → o que vamos fazer (escopo, solução, jornadas, requisitos) → o que já
// está decidido e o que ainda pode dar errado → como saberemos que ficou pronto.
//
// TRÊS SEÇÕES EXISTEM PARA O AGENTE, não para o leitor humano — e são elas que separam um PRD que
// alimenta uma equipe de um PRD que alimenta uma frota:
//
//   · `decisoes`     — o que JÁ foi decidido. Um agente que não sabe que a decisão foi tomada toma a
//                      dele, e a toma plausivelmente: escolhe uma biblioteca, um formato, um nome. O
//                      custo não aparece no run, aparece três cards depois.
//   · `jornadas`     — os percursos que viram o backbone do mapa. É a decomposição de que a captura
//                      precisa para propor activities/steps em vez de uma lista plana.
//   · `prontoQuando` — os critérios de verificação no nível do PRODUTO. "Funciona" não é critério;
//                      "esta jornada fecha sem erro para este público" é.
//
// SOBREPOSIÇÃO COM O LEAN CANVAS é deliberada e tem DIREÇÃO. Público, problema, alternativas, modelo
// de negócio e métricas aparecem nos dois — aqui em profundidade, lá comprimidos numa página. O
// `hint` de cada seção sobreposta declara o fluxo, e o fluxo é sempre o mesmo: o PRD é a fonte, o
// canvas é a destilação. Duas descrições sem direção declarada divergem em silêncio; com direção,
// uma delas é derivada e a derivação se repete.
//
// O que este arquivo NÃO tem, e por quê: largura, ordem visual, ícone, cor de seção, arranjo de
// colunas. Tudo isso é Camada 3 e mora no layout que a view importa. É o teste do APAGAMENTO, e ele
// é mecânico (doc-schema-agnostic.test.ts).

import { z } from "zod";
import type { DocSchema, SectionRule } from "../doc-schema";

export const PRD_DOC_TYPE = "prd";

/**
 * O que a MÁQUINA lê no cabeçalho. Mínimo de propósito: um campo declarado aqui sem ninguém que o
 * leia é capacidade sem produtor — parece funcionalidade e nunca dispara. `passthrough` deixa o
 * autor guardar o que quiser sem que a validação recuse o documento dele.
 */
export const PrdFrontmatterSchema = z
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

export const PRD_SCHEMA: DocSchema = {
  docType: PRD_DOC_TYPE,
  title: { kind: "fixed", text: "PRD" },
  frontmatter: PrdFrontmatterSchema,
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
