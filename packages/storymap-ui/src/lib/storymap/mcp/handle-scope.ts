// O ESCOPO DE UM HANDLE DE PAPEL — o que uma credencial cunhada pelo serviço pode ESCREVER, decidido no servidor.
//
// O conjunto de tools por papel (toolsets.ts) só estreita a LISTA que o cliente vê; quem lê o próprio `.mcp.json` e chama
// sem o cabeçalho tem a superfície inteira do nível. A cerca de verdade é o HANDLE que autenticou a chamada
// (`McpActor.credentialLabel`): o serviço o cunha por execução (`createMcpHandle({ level, label })`) e o revoga ao fim.
//
// O handle da ÂNCORA (fase 7 — runner/anchor-spawn.ts, skill `harness-anchor`) liga cards às funcionalidades do PRD e
// só pode isso: `update_card` aceita apenas `{ feature }` e as outras tools de escrita recusam, exceto `ask_question` e
// `propose_change`. PURO.

import type { RiskClass } from "@/lib/storymap/types";
import type { McpActor } from "./actor";

/** O prefixo do rótulo do handle da âncora — o servidor reconhece o papel por ele. */
export const ANCHOR_HANDLE_LABEL_PREFIX = "anchor:";

/** O rótulo do handle de uma execução da âncora no board. PURA. */
export function anchorHandleLabel(board: string): string {
  return `${ANCHOR_HANDLE_LABEL_PREFIX}${board}`;
}

/**
 * A chamada veio de um handle que só pode escrever `feature` (o da âncora)? Lê o RÓTULO DA CREDENCIAL — nunca o
 * rótulo que o cliente declara de si. Sem ator (fora de uma requisição MCP) ⇒ false. PURA.
 */
export function isFeatureOnlyHandle(ctx: Pick<McpActor, "credentialLabel"> | null | undefined): boolean {
  return !!ctx?.credentialLabel?.trim().startsWith(ANCHOR_HANDLE_LABEL_PREFIX);
}

/** O board do handle da âncora (o que vem depois do prefixo do rótulo), ou null fora dele. PURA. */
export function anchorHandleBoard(ctx: Pick<McpActor, "credentialLabel"> | null | undefined): string | null {
  if (!isFeatureOnlyHandle(ctx)) return null;
  return ctx?.credentialLabel?.trim().slice(ANCHOR_HANDLE_LABEL_PREFIX.length) || null;
}

/**
 * O handle da âncora vale só para o SEU board: a recusa quando a chamada nomeia outro (`board`), ou null. Sem board na
 * chamada (ou fora de um handle da âncora) ⇒ null. PURA.
 */
export function featureOnlyBoardRefusal(tool: string, actor: Pick<McpActor, "credentialLabel"> | null | undefined, board: unknown): string | null {
  const own = anchorHandleBoard(actor);
  if (!own || typeof board !== "string" || !board || board === own) return null;
  return `${tool}: esta credencial só vale para o board ${own}.`;
}

/** As tools de ESCRITA que o handle da âncora pode chamar (`update_card` só com `{ feature }` — a tool confere). */
export const FEATURE_ONLY_WRITE_TOOLS: ReadonlySet<string> = new Set(["update_card", "ask_question", "propose_change"]);

/**
 * A recusa de uma tool para um handle só-funcionalidade, ou null quando pode. Outro board (`board`) nunca pode; leitura
 * (`cls: "read"`) no board dele sempre pode; de
 * escrita, só {@link FEATURE_ONLY_WRITE_TOOLS}. Fora de um handle da âncora ⇒ null (nada muda). PURA — a guarda de cada
 * chamada (register.ts) e as tools de card (tools.ts) usam a mesma régua.
 */
export function featureOnlyToolRefusal(tool: string, cls: RiskClass, actor: Pick<McpActor, "credentialLabel"> | null | undefined, board?: unknown): string | null {
  if (!isFeatureOnlyHandle(actor)) return null;
  const elsewhere = featureOnlyBoardRefusal(tool, actor, board);
  if (elsewhere) return elsewhere;
  if (cls === "read" || FEATURE_ONLY_WRITE_TOOLS.has(tool)) return null;
  return `${tool}: esta credencial só liga cards às funcionalidades do PRD (update_card com { feature }, ask_question, propose_change).`;
}

/**
 * Os campos de `update_card` que um handle só-funcionalidade tentou escrever além de `feature` (vazio ⇒ pode). Conta só o
 * que veio definido (os ids `board`/`cardId` não são escrita). PURA.
 */
export function featureOnlyFieldsRefused(input: Record<string, unknown>): string[] {
  return Object.keys(input).filter((k) => k !== "board" && k !== "cardId" && k !== "feature" && input[k] !== undefined);
}

/**
 * A âncora ligando um card à funcionalidade (`update_card` só com `{ feature }`) passa SEM a aprovação da matriz do
 * board — decisão do dono (07/10): «pendurar o card numa funcionalidade é organização; livre, sem aprovação». As outras
 * tools que o handle pode (`ask_question`, `propose_change`) seguem a regra do board. PURA.
 */
export function featureAnchorSkipsApproval(
  tool: string,
  actor: Pick<McpActor, "credentialLabel"> | null | undefined,
  args: Record<string, unknown> | null | undefined,
): boolean {
  if (!isFeatureOnlyHandle(actor) || tool !== "update_card" || !args) return false;
  return args.feature !== undefined && featureOnlyFieldsRefused(args).length === 0;
}
