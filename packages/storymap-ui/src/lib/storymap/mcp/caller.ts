// QUEM está chamando uma tool — o rótulo que o agente declara de si. PURO.
//
// POR QUE EXISTE: todo agente da frota entra pelo MESMO token escopado, então a trilha de auditoria só
// sabia dizer «a credencial X». O diário do board ia além e dizia «Executei `set_board_autorun` sozinho» na voz do
// copiloto — para uma ação que tinha sido de uma sessão de orquestração. O dono lia o copiloto assumindo o que ele não
// fez, e não havia como saber qual condutor tinha pedido o quê.
//
// O rótulo viaja num cabeçalho que a PRÓPRIA ferramenta escreve na configuração de MCP de cada agente que ela abre
// (sessão, tick do copiloto, conversa do copiloto). Um agente de fora pode se nomear com `external:<nome>`.
//
// É ATRIBUIÇÃO, NUNCA AUTORIZAÇÃO: quem tem o token pode declarar o rótulo que quiser. Nada decide por ele — o nível do
// token e a matriz de risco do board seguem sendo a única régua do que a chamada pode fazer.

/** O cabeçalho em que o agente se nomeia. */
export const MCP_CALLER_HEADER = "x-agileharness-caller";

export type McpCallerKind =
  /** uma sessão da frota (condutor ou sessão de trabalho) — `id` é o sessionId do registro. */
  | "session"
  /** o tick autônomo do copiloto de um board — `id` é o board. */
  | "copilot-tick"
  /** a conversa do copiloto de um board — `id` é o board. */
  | "copilot-chat"
  /** um agente aberto fora da ferramenta que se nomeou — `id` é o nome que ele deu. */
  | "external";

export interface McpCaller {
  kind: McpCallerKind;
  id: string;
}

const KINDS: readonly McpCallerKind[] = ["session", "copilot-tick", "copilot-chat", "external"];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** `session:abc123` — o valor do cabeçalho. PURA. */
export function callerTag(c: McpCaller): string {
  return `${c.kind}:${c.id}`;
}

/** O rótulo declarado, ou null quando ausente ou fora do formato (nunca lança, nunca aceita texto livre). PURA. */
export function parseCallerTag(raw: string | null | undefined): McpCaller | null {
  const text = raw?.trim();
  if (!text || text.length > 96) return null;
  const at = text.indexOf(":");
  if (at <= 0) return null;
  const kind = text.slice(0, at) as McpCallerKind;
  const id = text.slice(at + 1);
  if (!KINDS.includes(kind) || !ID.test(id)) return null;
  return { kind, id };
}

/** O rótulo é o do copiloto (o tick ou a conversa)? Só ele fala no diário em primeira pessoa. PURA. */
export function isCopilotCaller(c: McpCaller | null | undefined): boolean {
  return c?.kind === "copilot-tick" || c?.kind === "copilot-chat";
}

/** O que o registro de sessões sabe de quem chamou (o chamador `session`). */
export interface CallerSessionFacts {
  driver?: string | null;
  cardId?: string | null;
  name?: string | null;
}

/**
 * A ATRIBUIÇÃO em formato estável, para a trilha e para o pedido de aprovação: `copilot:<board>`,
 * `conductor:<cardId>`, `session:<nome ou id>`, `external:<nome>`. `session` = o que o registro diz daquela sessão
 * (null = não está mais no registro). Sem rótulo declarado devolve null — quem chama cai no formato da credencial. PURA.
 */
export function callerAttribution(c: McpCaller | null | undefined, session?: CallerSessionFacts | null): string | null {
  if (!c) return null;
  if (isCopilotCaller(c)) return `copilot:${c.id}`;
  if (c.kind === "external") return `external:${c.id}`;
  if (session?.driver === "conductor" && session.cardId) return `conductor:${session.cardId}`;
  return `session:${session?.name?.trim() || c.id}`;
}

/**
 * QUEM, em palavras, a partir da atribuição gravada — «O Jido», «O condutor do card story-x», «Uma sessão de agente
 * (nome)», «Um agente de fora (nome)». Null quando a atribuição não é deste formato (o chamador usa as palavras da
 * credencial). PURA, segura no cliente.
 */
export function callerWords(attribution: string | null | undefined): string | null {
  const who = attribution?.trim();
  if (!who) return null;
  const at = who.indexOf(":");
  if (at <= 0) return null;
  const kind = who.slice(0, at);
  const id = who.slice(at + 1);
  if (!id) return null;
  if (kind === "copilot") return "O Jido";
  if (kind === "conductor") return `O condutor do card ${id}`;
  // o id cru da sessão (um uuid que a ferramenta cunhou) não diz nada a quem lê: só «uma sessão de trabalho»
  if (kind === "session") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? "Uma sessão de trabalho" : `Uma sessão de agente (${id})`;
  if (kind === "external") return `Um agente de fora (${id})`;
  return null;
}

/** «O condutor…» → «ao condutor…», «Uma sessão…» → «a uma sessão…», «Um agente…» → «a um agente…». PURA. */
export function toWhomWords(words: string): string {
  if (words.startsWith("O ")) return `ao ${words.slice(2)}`;
  if (words.startsWith("A ")) return `à ${words.slice(2)}`;
  return `a ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}
