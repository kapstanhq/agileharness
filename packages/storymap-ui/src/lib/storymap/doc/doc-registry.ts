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

import type { BoardConfig } from "../types";
import type { DocSchema } from "./doc-schema";
import type { SchemaDoc } from "./schema-codec";
import { LEAN_CANVAS_SCHEMA } from "./schemas/lean-canvas";
import { projectLegacyLeanCanvas } from "./schemas/lean-canvas-legacy";
import { PRD_SCHEMA } from "./schemas/prd";
import { projectLegacyPrd } from "./schemas/prd-legacy";

/** O rótulo humano e a rota de cada documento — o que a navegação e o agente precisam citar. */
export interface DocEntry {
  schema: DocSchema;
  /** como o operador chama este documento. */
  label: string;
  /** a rota da tela dele, relativa ao board (`/board/<id>/<view>`). */
  view: string;
  /**
   * A projeção do formato LEGADO (o `board.yaml`), para a migração preguiçosa: enquanto o `.md` não
   * existir, é ela que dá o conteúdo. Fica no REGISTRO, e não em cada chamador, porque quem esquecer
   * de aplicá-la lê um documento VAZIO — e um agente que escrevesse nesse vazio gravaria por cima do
   * canvas inteiro. Uma entrada sem legado (documento nascido markdown) simplesmente a omite.
   */
  legacyProject?: (config: BoardConfig) => SchemaDoc;
}

const ENTRIES: readonly DocEntry[] = [
  // O PRD vem PRIMEIRO porque é o documento mais alto: o Lean Canvas, o backbone do mapa e as
  // personas descem dele. A ordem daqui é a que a listagem de `read_doc` mostra ao agente, e a
  // primeira linha de uma lista é lida como "comece por aqui" — que é exatamente o conselho certo.
  {
    schema: PRD_SCHEMA,
    label: "PRD",
    view: "prd",
    legacyProject: projectLegacyPrd,
  },
  {
    schema: LEAN_CANVAS_SCHEMA,
    label: "Lean Canvas",
    view: "canvas",
    legacyProject: projectLegacyLeanCanvas,
  },
] as const;

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
