// 📐 doc-registry — QUAIS documentos existem. O registro que o cabeçalho do `doc-model.ts` prometia
// desde a primeira versão do subsistema e que nunca tinha sido escrito: sem ele, cada tela cabeava
// project/commit na mão e as sete repetiam a mesma máquina de estados.
//
// É também o ALLOWLIST fail-closed do caminho de escrita: uma server action ou uma tool de MCP
// recebe um `docType` de FORA, e resolver isso contra um mapa fechado é o que impede um pedido de
// apontar para um schema arbitrário (ou para um caminho de arquivo montado a partir da entrada).
// `undefined` ⇒ 400, nunca um schema genérico de consolação.
//
// Adicionar um documento ao sistema = UMA entrada aqui + o schema. Nenhuma lógica nova: o I/O, a
// validação, as views disponíveis, a fonte markdown e o travamento do rótulo já vêm do contrato.
//
// PURO (o cliente importa para descobrir as views de um docType) — sem `node:fs`, sem React.

import { isDocChatOf, type McpCaller } from "../mcp/caller";
import type { BoardConfig } from "../types";
import type { DocSchema } from "./doc-schema";
import type { SchemaDoc } from "./schema-codec";
import { migrateLeanCanvasToBmc } from "./migrations";
import { BMC_DOC_TYPE, BMC_SCHEMA } from "./schemas/business-model-canvas";
import { CONTEXTO_SCHEMA } from "./schemas/contexto";
import { LEAN_CANVAS_DOC_TYPE, LEAN_CANVAS_SCHEMA } from "./schemas/lean-canvas";
import { projectLegacyLeanCanvas } from "./schemas/lean-canvas-legacy";
import { PRD_DOC_TYPE, PRD_SCHEMA } from "./schemas/prd";
import { projectLegacyPrd } from "./schemas/prd-legacy";

/** O rótulo humano e a rota de cada documento — o que a navegação e o agente precisam citar. */
export interface DocEntry {
  schema: DocSchema;
  /** como o operador chama este documento. */
  label: string;
  /**
   * a rota da tela dele, relativa ao board (`/board/<id>/<view>`). Ausente ⇒ documento SEM página
   * (o contexto dos agentes): existe para `read_doc`/`write_doc`, o motor e as skills.
   */
  view?: string;
  /**
   * A projeção do formato LEGADO (o `board.yaml`), para a migração preguiçosa: enquanto o `.md` não
   * existir, é ela que dá o conteúdo. Fica no REGISTRO, e não em cada chamador, porque quem esquecer
   * de aplicá-la lê um documento VAZIO — e um agente que escrevesse nesse vazio gravaria por cima do
   * canvas inteiro. Uma entrada sem legado (documento nascido markdown) simplesmente a omite.
   */
  legacyProject?: (config: BoardConfig) => SchemaDoc;
  /**
   * Um ARQUIVO de outro docType que é a fonte deste enquanto ele não existir (o `docs/lean-canvas.md`
   * de um board que já tinha migrado o canvas para markdown é a fonte do BMC). Vence `legacyProject`:
   * um arquivo é sempre mais novo que o `board.yaml`.
   */
  legacyFile?: { schema: DocSchema; migrate: (doc: SchemaDoc) => SchemaDoc };
}

const ENTRIES: readonly DocEntry[] = [
  // O PRD vem PRIMEIRO porque é o documento de produto: o canvas, as personas e o contexto dos
  // agentes giram em torno dele. A ordem daqui é a que a listagem de `read_doc` mostra ao agente, e a
  // primeira linha de uma lista é lida como "comece por aqui" — que é exatamente o conselho certo.
  {
    schema: PRD_SCHEMA,
    label: "PRD",
    view: "produto",
    legacyProject: projectLegacyPrd,
  },
  {
    schema: BMC_SCHEMA,
    label: "Business Model Canvas",
    view: "negocio",
    // O canvas antigo do `board.yaml` (Lean Canvas), projetado e então levado aos nove blocos.
    legacyProject: (config) => migrateLeanCanvasToBmc(projectLegacyLeanCanvas(config)),
    legacyFile: { schema: LEAN_CANVAS_SCHEMA, migrate: migrateLeanCanvasToBmc },
  },
  {
    schema: CONTEXTO_SCHEMA,
    label: "Contexto para os agentes",
  },
] as const;

/**
 * docTypes que EXISTIRAM e saíram do registro — a recusa aponta o substituto, em vez do genérico
 * "desconhecido" (um agente com instrução antiga corrige no mesmo turno).
 */
const RETIRED: Readonly<Record<string, string>> = {
  [LEAN_CANVAS_DOC_TYPE]: `O Lean Canvas foi substituído pelo Business Model Canvas: use docType "${BMC_DOC_TYPE}" (o conteúdo antigo já foi migrado para os nove blocos dele).`,
};

/** A mensagem de recusa de um docType aposentado, ou `undefined` quando ele não é um deles. */
export function retiredDocMessage(docType: string): string | undefined {
  return RETIRED[docType];
}

/** A recusa para um docType fora do registro — a do aposentado quando houver, senão a genérica. */
export function unknownDocMessage(docType: string): string {
  return retiredDocMessage(docType) ?? `Documento desconhecido: "${docType}". Os deste board: ${docTypes().join(", ")}.`;
}

const BY_TYPE = new Map(ENTRIES.map((e) => [e.schema.docType, e] as const));

/** `undefined` para um docType desconhecido — o chamador RECUSA (fail-closed). */
export function docEntry(docType: string): DocEntry | undefined {
  return BY_TYPE.get(docType);
}

export function docSchema(docType: string): DocSchema | undefined {
  return BY_TYPE.get(docType)?.schema;
}

export function listDocEntries(): readonly DocEntry[] {
  return ENTRIES;
}

/** Todos os docTypes registrados — o vocabulário que o agente pode citar. */
export function docTypes(): string[] {
  return ENTRIES.map((e) => e.schema.docType);
}

/** Quem pede a escrita — o que o servidor sabe da requisição MCP corrente (nada ⇒ o operador ou o próprio serviço). */
export interface DocWriter {
  /** token escopado (agente). false ⇒ o operador (token full) ou uma chamada interna do serviço. */
  scoped: boolean;
  /** o rótulo que o agente declarou de si (mcp/caller.ts). */
  caller?: McpCaller;
}

/**
 * A REGRA DE DONO dos documentos, no servidor (decisões do dono de 06/10) — antes ela só existia nas descrições
 * das tools, e um run headless ou o orquestrador reescreviam as personas e o BMC direto pelo `write_doc`:
 *   · `contexto` — dos agentes: livre.
 *   · `business-model-canvas` — do dono: agente nenhum escreve; PROPÕE (`propose_change artifact:"canvas"`).
 *   · `prd` · `personas` — do dono: agente nenhum escreve; PROPÕE (`propose_change artifact:"prd"`).
 *   · `prd` · as outras seções — só a conversa da PÁGINA do PRD escreve (o dono está olhando, e vê a escrita
 *     acontecer); um run, o tick ou a conversa de outra tela propõem.
 * O operador (token full) e as chamadas internas não passam por aqui. O rótulo do chamador é ATRIBUIÇÃO: isto
 * contém o engano honesto de um agente (a instrução velha, a skill que escreve onde não devia), não um portador
 * hostil do token — esse esbarra no guarda de arquivo e no Inbox. `undefined` ⇒ pode escrever. PURA.
 */
export function docWriteRefusal(input: { boardId: string; docType: string; section: string; writer: DocWriter }): string | undefined {
  const { boardId, docType, section, writer } = input;
  if (!writer.scoped) return undefined;
  if (docType === BMC_DOC_TYPE) {
    return (
      `O Business Model Canvas é do dono: um agente não escreve nele. Proponha a mudança com propose_change ` +
      `(artifact "canvas", field "${section}", after {"items":[…]} com a lista inteira do bloco) — ela vai para o Inbox e o dono aprova.`
    );
  }
  if (docType !== PRD_DOC_TYPE) return undefined;
  if (section === "personas") {
    return (
      `As personas do PRD são do dono: um agente não escreve nelas. Proponha com propose_change ` +
      `(artifact "prd", field "personas", after: o markdown da seção) — ela vai para o Inbox e o dono aprova.`
    );
  }
  if (isDocChatOf(writer.caller, boardId, docEntry(PRD_DOC_TYPE)?.view ?? "produto")) return undefined;
  return (
    `O PRD é do dono: só a conversa da página Produto, com ele olhando, escreve nele. Proponha com propose_change ` +
    `(artifact "prd", field "${section}", after: o markdown da seção). O que é técnico (decisões, requisitos, riscos) vai ` +
    `no contexto dos agentes — write_doc com docType "contexto", que é seu.`
  );
}
