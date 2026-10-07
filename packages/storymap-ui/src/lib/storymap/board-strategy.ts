// 🧭 De ONDE vem o norte de um board — a única resposta, para os cinco lugares que perguntam.
//
// Antes eram três strings lidas direto do `board.yaml` em cinco arquivos diferentes, e as cinco
// leituras já tinham divergido: duas delas (módulos já apagados) carregavam a MESMA função
// `strategyBlock` duplicada (uma com fallback, outra sem), e `smart-capture` renderizava a escada
// numa ORDEM diferente das outras duas. Nenhuma das divergências foi decidida; todas foram digitadas.
//
// Hoje o norte vem do PRD (`storymap/boards/<b>/docs/prd.md`), destilado por `prdDigest`. Este módulo
// é a casca IMPURA que faz o I/O; quem consome recebe uma STRING e continua puro — foi o que
// permitiu converter os consumidores sem tornar nenhum deles assíncrono por dentro.
//
// SERVIDOR (usa `loadDoc`, que toca disco). Um componente de cliente recebe o texto por prop, vindo
// da página que já é assíncrona — nunca importa este arquivo.

import { loadDoc } from "./doc/schema-doc-io";
import { prdDigest } from "./doc/prd-digest";
import { projectPersonas } from "./doc/prd-personas";
import { prdFeatureEntries, type PrdFeature } from "./doc/prd-features";
import { sectionItems, sectionContent, serializeSchemaDoc } from "./doc/schema-codec";
import { serializeDocMd } from "./doc/md-codec";
import { CONTEXTO_DOC_TYPE } from "./doc/schemas/contexto";
import { PRD_DOC_TYPE } from "./doc/schemas/prd";
import { readBoardConfig } from "./repo";
import type { Board, BoardConfig, Persona } from "./types";

/**
 * O norte do board, pronto para entrar num prompt. Vazio ⇒ o board não declarou norte nenhum.
 *
 * `config` é opcional só por economia: quem já o tem em mãos evita uma segunda leitura do
 * `board.yaml`. Ele importa porque é a fonte da PROJEÇÃO — enquanto o `docs/prd.md` não existir, o
 * digest sai da escada estratégica antiga, e passar `undefined` faria `loadDoc` reler o arquivo para
 * chegar exatamente ao mesmo lugar.
 */
export async function boardStrategy(boardId: string, config?: BoardConfig): Promise<string> {
  const loaded = await loadDoc(boardId, PRD_DOC_TYPE, config).catch(() => undefined);
  return prdDigest(loaded?.doc);
}

/**
 * Reexport de conveniência para o SERVIDOR. A função em si é pura e mora em `doc/prd-digest` — um
 * componente de cliente importa de lá, nunca daqui: este módulo carrega `loadDoc`, e arrastar
 * `node:fs` para o bundle do navegador reprova o `next build` (e o `tsc --noEmit` NÃO pega).
 */
export { strategyOrAbsence } from "./doc/prd-digest";

/**
 * SÓ as Métricas de sucesso do PRD — o resultado ao qual as stories sobem, numa linha.
 *
 * Separado do digest de propósito: quem mostra UMA linha não deveria recortar o digest por rótulo — um
 * parser de texto sobre algo que já é estrutura. `null` quando a seção está vazia, para quem mostra
 * poder dizer "ainda não declarado" em vez de uma linha em branco.
 */
export async function boardDesiredOutcome(boardId: string, config?: BoardConfig): Promise<string | null> {
  const loaded = await loadDoc(boardId, PRD_DOC_TYPE, config).catch(() => undefined);
  if (!loaded) return null;
  const itens = sectionItems(loaded.doc, "metricasSucesso")
    .map((i) => i.text.trim())
    .filter(Boolean);
  return itens.length ? itens.join(" · ") : null;
}

/**
 * A SEMENTE do backbone: o recorte do PRD que descreve O QUE construir — o fluxo de uso e as
 * funcionalidades.
 *
 * Por que um recorte e não o documento inteiro: a captura propõe activities/steps/stories a partir
 * de texto livre, e mandar as personas ou as métricas faria o modelo cunhar card para o que descreve
 * o produto, não o trabalho. O norte (com o «Fora do escopo») já viaja por outro canal — o digest
 * entra no prompt da captura como «Norte do produto» —, então repeti-lo aqui só somaria ruído.
 */
export async function prdBacklogSeed(boardId: string, config?: BoardConfig): Promise<string> {
  const loaded = await loadDoc(boardId, PRD_DOC_TYPE, config).catch(() => undefined);
  if (!loaded) return "";

  const md = (key: string): string => {
    const secao = sectionContent(loaded.doc, key);
    if (!secao?.blocks.length) return "";
    return serializeDocMd({ docType: PRD_DOC_TYPE, title: "", blocks: secao.blocks }, { includeTitle: false }).trim();
  };

  const partes = [
    ["Fluxo de uso (o percurso de ponta a ponta — é daqui que sai o backbone)", md("fluxoUso")],
    ["Funcionalidades", md("funcionalidades")],
  ].filter(([, corpo]) => corpo);

  if (!partes.length) return "";
  return [
    "Transforme o recorte abaixo do PRD deste produto em backbone e stories.",
    "",
    ...partes.flatMap(([titulo, corpo]) => [`## ${titulo}`, "", corpo, ""]),
  ].join("\n").trim();
}

/**
 * As PERSONAS do board — a seção «Personas» do PRD, com o `board.yaml` como piso legado (ver
 * `doc/prd-personas.ts`). É o que o vocabulário do MCP, o motor e o procurador leem no lugar de
 * `config.personas`.
 */
export async function boardPersonas(boardId: string, config?: BoardConfig): Promise<Persona[]> {
  const resolved = config ?? (await readBoardConfig(boardId).catch(() => undefined));
  const loaded = await loadDoc(boardId, PRD_DOC_TYPE, resolved).catch(() => undefined);
  return projectPersonas(loaded?.doc, resolved?.personas ?? []);
}

/**
 * As FUNCIONALIDADES do board — os `###` da seção «Funcionalidades» do PRD (ver `doc/prd-features.ts`). Vazio ⇒ o
 * board não tem funcionalidades no PRD e o agrupamento cai no modo mapa (feature-key.ts). Fase 7.
 */
export async function boardFeatures(boardId: string, config?: BoardConfig): Promise<PrdFeature[]> {
  const resolved = config ?? (await readBoardConfig(boardId).catch(() => undefined));
  const loaded = await loadDoc(boardId, PRD_DOC_TYPE, resolved).catch(() => undefined);
  return prdFeatureEntries(loaded?.doc);
}

/**
 * O `config` com as personas RESOLVIDAS (as do PRD, com o `board.yaml` como piso) — para quem mostra e escolhe
 * persona num card (o seletor, as fichas, a criação) e para a captura inteligente (o prompt e o `parseProposal`).
 * Sem isto, uma persona escrita só no PRD — a que o `get_vocabulary` devolve e os agentes põem nos cards — não podia
 * ser escolhida, sumia da ficha do card e era descartada pela captura como id desconhecido.
 * SÓ PARA LER: nunca grave o `board.yaml` a partir deste objeto (as personas do PRD vazariam para o arquivo).
 */
export async function withBoardPersonas(boardId: string, config: BoardConfig): Promise<BoardConfig> {
  return { ...config, personas: await boardPersonas(boardId, config) };
}

/** {@link withBoardPersonas} para um board inteiro — o que as páginas que abrem card passam aos componentes. */
export async function boardWithPersonas(board: Board): Promise<Board> {
  return { ...board, config: await withBoardPersonas(board.config.id, board.config) };
}

/**
 * O PRD e o contexto dos agentes, em markdown, um depois do outro — o que os juízes e o procurador
 * leem (eles leram o `prd.md` cru até o PRD ser dividido em dois). Passa por `loadDoc`, então um PRD
 * ainda no formato antigo já chega no novo. `null` quando nenhum dos dois arquivos existe: o board não
 * escreveu nada, e a projeção do `board.yaml` não é texto que justifique um bloco no prompt.
 */
export async function readPrdWithContext(boardId: string): Promise<string | null> {
  const [prd, contexto] = await Promise.all([
    loadDoc(boardId, PRD_DOC_TYPE).catch(() => undefined),
    loadDoc(boardId, CONTEXTO_DOC_TYPE).catch(() => undefined),
  ]);
  const partes: string[] = [];
  if (prd?.exists) partes.push(serializeSchemaDoc(prd.doc, prd.schema).trim());
  // o contexto entra se tiver alguma seção — inclusive o projetado de um PRD antigo ainda não migrado
  if (contexto?.doc.sections.length) partes.push(serializeSchemaDoc(contexto.doc, contexto.schema).trim());
  return partes.length ? partes.join("\n\n") : null;
}
