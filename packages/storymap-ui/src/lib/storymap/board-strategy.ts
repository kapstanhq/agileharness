// 🧭 De ONDE vem o norte de um board — a única resposta, para os cinco lugares que perguntam.
//
// Antes eram três strings lidas direto do `board.yaml` em cinco arquivos diferentes, e as cinco
// leituras já tinham divergido: `priority-context` e `priority-assess` carregavam a MESMA função
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
import { sectionItems, sectionContent } from "./doc/schema-codec";
import { serializeDocMd } from "./doc/md-codec";
import { PRD_DOC_TYPE } from "./doc/schemas/prd";
import type { BoardConfig } from "./types";

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
 * SÓ o Resultado-alvo do PRD — o vértice ao qual as stories sobem, para a tira acima do mapa.
 *
 * Separado do digest de propósito: a tira mostra UMA frase, e passar o digest inteiro a obrigaria a
 * recortar por rótulo — um parser de texto sobre algo que já é estrutura. `null` quando a seção está
 * vazia, para a tira poder dizer "ainda não declarado" em vez de mostrar uma linha em branco.
 */
export async function boardDesiredOutcome(boardId: string, config?: BoardConfig): Promise<string | null> {
  const loaded = await loadDoc(boardId, PRD_DOC_TYPE, config).catch(() => undefined);
  if (!loaded) return null;
  const itens = sectionItems(loaded.doc, "resultadoAlvo")
    .map((i) => i.text.trim())
    .filter(Boolean);
  return itens.length ? itens.join(" · ") : null;
}

/**
 * A SEMENTE do backbone: o recorte do PRD que descreve O QUE construir — jornadas, o escopo desta
 * versão e as capacidades da solução.
 *
 * Por que um recorte e não o documento inteiro: a captura propõe activities/steps/stories a partir
 * de texto livre, e mandar as dezesseis seções faria o modelo cunhar card para «Modelo de negócio» e
 * «Glossário» — que descrevem o produto, não o trabalho. O norte já viaja por outro canal (o digest
 * entra no prompt da captura como «Norte do produto»), então repeti-lo aqui só somaria ruído.
 *
 * O «Fora, por ora» do escopo entra DE PROPÓSITO: dizer o que não fazer é o que impede a captura de
 * propor exatamente aquilo — e essa é a proposta que o operador mais gasta tempo recusando à mão.
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
    ["Jornadas (o percurso de ponta a ponta — é daqui que sai o backbone)", md("jornadas")],
    ["Escopo", md("escopo")],
    ["Solução (as capacidades)", md("solucao")],
  ].filter(([, corpo]) => corpo);

  if (!partes.length) return "";
  return [
    "Transforme o recorte abaixo do PRD deste produto em backbone e stories.",
    "",
    ...partes.flatMap(([titulo, corpo]) => [`## ${titulo}`, "", corpo, ""]),
  ].join("\n").trim();
}
