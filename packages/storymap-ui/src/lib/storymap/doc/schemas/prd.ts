// 📋 PRD — UMA INSTÂNCIA de {@link DocSchema}, nada mais. O documento de PRODUTO do board, escrito
// pelo dono e em linguagem de negócio: o que é, para quem, por quê, o que faz e o que fica de fora.
//
// FORMATO 2 (`format: 2` no cabeçalho). O formato 1 tinha vinte seções e misturava o documento do
// dono com o contexto que só os agentes usam (decisões, requisitos, riscos, glossário…). Os dois
// leitores perdiam: o dono atravessava um documento técnico para achar o que decide; o agente
// atravessava um documento de negócio para achar o que obedece. Agora são dois arquivos:
//
//   · `docs/prd.md`      — ESTE: sete seções, sem tecnologia. Só o dono muda (agente propõe por
//                          `propose_change artifact:"prd"`). É o que o digest leva a todo prompt.
//   · `docs/contexto.md` — o contexto para os agentes (`contexto.ts`): decisões já tomadas, pronto
//                          quando, requisitos, restrições, riscos… Os agentes leem e mantêm.
//
// A migração do formato 1 (`migrations.ts` → `migratePrdV1`) é sem perda: cada bloco antigo tem
// destino declarado, e o que não tem lugar aqui vai para o contexto.
//
// A ordem das seções é a ordem em que o documento se ARGUMENTA: a dor → quem a sente → o que
// prometemos → o que o produto faz → como a pessoa usa → como saberemos que deu certo → o que não
// faremos. Sem largura, cor nem ícone (Camada 3 — o teste do APAGAMENTO, doc-schema-agnostic.test.ts).

import { z } from "zod";
import type { DocSchema, SectionRule } from "../doc-schema";

export const PRD_DOC_TYPE = "prd";

/** A versão do formato que este schema descreve — o que separa um `prd.md` novo de um a migrar. */
export const PRD_FORMAT = 2;

/**
 * O que a MÁQUINA lê no cabeçalho: o tipo e o FORMATO. `format` é o que a migração consulta para não
 * reprocessar um documento já migrado; a gravação o carimba sempre (`writeSchemaDoc`). `passthrough`
 * deixa o autor guardar o que quiser sem que a validação recuse o documento dele.
 */
export const PrdFrontmatterSchema = z
  .object({
    doc: z.literal(PRD_DOC_TYPE).optional(),
    format: z.literal(PRD_FORMAT).optional(),
  })
  .passthrough();

/** O grupo de «Personas» que guarda como o público resolve a dor hoje — não é uma persona. */
export const PRD_ALTERNATIVES_GROUP = "Como resolvem hoje";

/**
 * Os grupos de ESCOPO que a própria ferramenta escreveu na seção «Funcionalidades» (fase 7): «Nesta versão» (o modelo
 * do formato 1) e «Escopo» (a migração 1→2, migrations.ts). São baldes de versão, não funcionalidades — a projeção das
 * funcionalidades do PRD (prd-features.ts) os pula pelo nome.
 */
export const PRD_SCOPE_GROUPS: readonly string[] = ["Nesta versão", "Escopo"];

const top = (key: string, label: string, content: SectionRule["content"], hint: string): SectionRule => ({
  key,
  label,
  level: 2,
  locked: true,
  // "o heading existe": o esqueleto nasce com as sete. Seção VAZIA não recusa o salvamento.
  required: true,
  content,
  hint,
});

const NEGOCIO = "Documento de negócio: nada de tecnologia, arquitetura ou biblioteca — isso vai no contexto dos agentes.";

export const PRD_SCHEMA: DocSchema = {
  docType: PRD_DOC_TYPE,
  title: { kind: "fixed", text: "PRD" },
  frontmatter: PrdFrontmatterSchema,
  allowFreeTail: false,
  sections: [
    top(
      "problema",
      "Problema",
      "groups",
      "As dores, ditas do ponto de vista de quem as sente — não a falta da sua solução. Um `###` por tema quando houver mais de um.",
    ),
    top(
      "personas",
      "Personas",
      "groups",
      `Um \`###\` por persona (o nome dela) e, abaixo, o que ela quer resolver, quando decide e o que a faz desistir. O grupo «${PRD_ALTERNATIVES_GROUP}» guarda as alternativas que elas usam hoje.`,
    ),
    top(
      "propostaValor",
      "Proposta de valor",
      "prose",
      `O que a pessoa ganha ao escolher o produto, e por que ele e não a alternativa — em um ou dois parágrafos. ${NEGOCIO}`,
    ),
    top(
      "funcionalidades",
      "Funcionalidades",
      "groups",
      `Um \`###\` por funcionalidade (o nome dela) e, abaixo, o que ela faz, do ponto de vista de quem usa; escopo e versões ficam fora desta seção. ${NEGOCIO}`,
    ),
    top(
      "fluxoUso",
      "Fluxo de uso",
      // `groups` e não `items`: uma jornada só é uma lista de passos (item solto antes do primeiro
      // grupo é legítimo); duas ou mais ganham um `###` cada — sem virar aviso de forma.
      "groups",
      "Os passos da jornada principal, na ordem em que a pessoa os vive — um por linha. Mais de uma jornada: um `###` por jornada.",
    ),
    top(
      "metricasSucesso",
      "Métricas de sucesso",
      "items",
      "Como saberemos que deu certo: o resultado que o produto persegue agora e o número de negócio que ele move. Um por linha.",
    ),
    top(
      "foraEscopo",
      "Fora do escopo",
      "items",
      "O que NÃO faremos (por ora ou nunca) e por quê — dizer o que fica de fora corta tanto trabalho quanto dizer o que entra.",
    ),
  ],
};
