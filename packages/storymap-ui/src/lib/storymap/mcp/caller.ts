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
// token e a matriz de risco do board seguem sendo a única régua do que a chamada pode fazer. A exceção são os PAPÉIS DO
// SERVIÇO (Sentinela, procurador, crítico): eles escolhem o balde do limite por hora e a voz da trilha, então só valem
// PROVADOS — a Sentinela pela credencial de papel ({@link credentialBoundCaller}); declarado sem prova, o rótulo vira um
// agente de fora ({@link demoteUnprovenServiceCaller}).

/** O cabeçalho em que o agente se nomeia. */
export const MCP_CALLER_HEADER = "x-agileharness-caller";

export type McpCallerKind =
  /** uma sessão da frota (condutor ou sessão de trabalho) — `id` é o sessionId do registro. */
  | "session"
  /** o tick autônomo do copiloto de um board — `id` é o board. */
  | "copilot-tick"
  /** a conversa do copiloto de um board — `id` é o board. */
  | "copilot-chat"
  /**
   * a conversa da PÁGINA de um documento (o compositor de Negócio/Produto/Design, propósito `doc-editor`) — `id` é
   * `<board>.<view>` (ver {@link docChatCaller}). É o Jido falando, com o dono olhando aquela página.
   */
  | "doc-chat"
  /** um agente aberto fora da ferramenta que se nomeou — `id` é o nome que ele deu. */
  | "external"
  /** um despertar da SENTINELA (runner/sentinel*.ts) — `id` é o board (ou `host`, numa causa do host). */
  | "sentinel"
  /** o PROCURADOR do dono, quando fala por MCP — `id` é o board. */
  | "proxy"
  /** um CRÍTICO lançado pelo serviço (plano, diff, entrega) — `id` é o card. */
  | "critic";

export interface McpCaller {
  kind: McpCallerKind;
  id: string;
  /**
   * a prova de sessão (mcp/session-proof.ts) que veio no cabeçalho ao lado do rótulo — só um DADO aqui; quem decide por
   * sessão verifica (runner/session-binding.ts). Ausente na atribuição.
   */
  proof?: string;
}

const KINDS: readonly McpCallerKind[] = ["session", "copilot-tick", "copilot-chat", "doc-chat", "external", "sentinel", "proxy", "critic"];
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

/**
 * Os papéis do SERVIÇO — os que o próprio serviço abre e que escolhem um balde de limite e uma voz na trilha. Um rótulo
 * declarado não PROVA nenhum deles: a Sentinela prova pela CREDENCIAL (um handle de papel, {@link credentialBoundCaller});
 * o procurador e os críticos não montam MCP nenhum; o tique antigo não existe mais. Declarado sem prova ⇒
 * {@link demoteUnprovenServiceCaller}.
 */
export const SERVICE_CALLER_KINDS: ReadonlySet<McpCallerKind> = new Set<McpCallerKind>(["sentinel", "proxy", "critic", "copilot-tick"]);

/** O prefixo do rótulo de um handle preso à Sentinela (runner/sentinel-spawn.ts o cunha por despertar). */
const SENTINEL_CREDENTIAL_PREFIX = "sentinel:";

/**
 * O chamador que a CREDENCIAL prova — não o que o cliente declara. Hoje: o handle efêmero da Sentinela (rótulo
 * `sentinel:<board>`, cunhado pelo serviço a cada despertar). Null para todo o resto. PURA.
 */
export function credentialBoundCaller(label: string | null | undefined): McpCaller | null {
  const l = label?.trim();
  if (!l?.startsWith(SENTINEL_CREDENTIAL_PREFIX)) return null;
  const id = l.slice(SENTINEL_CREDENTIAL_PREFIX.length);
  return ID.test(id) ? { kind: "sentinel", id } : { kind: "sentinel", id: "host" };
}

/**
 * Um rótulo de papel do SERVIÇO declarado sem prova vira um agente de fora com o nome do que disse ser
 * (`external:sentinel-sem-prova`): ele não escolhe o balde de limite do papel, não fala na trilha como «a Sentinela» ou
 * «o crítico», e o diário o diz como agente de fora. O mesmo para o rótulo do CHAT numa credencial que o chat nunca usa
 * (ele entra com o token do operador ou o de leitura — copilot/agent-session.ts): um agente de token escopado que se
 * diz «chat» ganharia um balde a mais. Os outros rótulos passam como estão (atribuição). PURA.
 */
export function demoteUnprovenServiceCaller(c: McpCaller, level?: string): McpCaller {
  if (SERVICE_CALLER_KINDS.has(c.kind)) return { kind: "external", id: `${c.kind}-sem-prova` };
  if ((c.kind === "copilot-chat" || c.kind === "doc-chat") && level !== undefined && level !== "full" && level !== "ro") return { kind: "external", id: `${c.kind}-sem-prova` };
  return c;
}

/** O rótulo da conversa da página `view` de um documento do board. PURA. */
export function docChatCaller(boardId: string, view: string): McpCaller {
  return { kind: "doc-chat", id: `${boardId}.${view}` };
}

/**
 * A conversa é a da página `view` DESTE board? É a pergunta de quem só aceita escrita com o dono olhando aquela página
 * (o `write_doc` no PRD). Lembre: o rótulo é ATRIBUIÇÃO — contém o engano honesto de um run, não um portador hostil
 * do token. PURA.
 */
export function isDocChatOf(c: McpCaller | null | undefined, boardId: string, view: string): boolean {
  return c?.kind === "doc-chat" && c.id === `${boardId}.${view}`;
}

/** O rótulo é o do copiloto (o tick ou uma conversa)? Só ele fala no diário em primeira pessoa. PURA. */
export function isCopilotCaller(c: McpCaller | null | undefined): boolean {
  return c?.kind === "copilot-tick" || c?.kind === "copilot-chat" || c?.kind === "doc-chat";
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
  // a conversa de página é o Jido do board: a atribuição fica `copilot:<board>` (a página não muda quem fala)
  if (c.kind === "doc-chat") return `copilot:${c.id.slice(0, c.id.lastIndexOf(".") > 0 ? c.id.lastIndexOf(".") : c.id.length)}`;
  if (isCopilotCaller(c)) return `copilot:${c.id}`;
  if (c.kind === "external") return `external:${c.id}`;
  // os papéis do serviço: a atribuição é o PAPEL (a trilha agrupa por ele; o id fica no rótulo do diário)
  if (c.kind === "sentinel") return "sentinel";
  if (c.kind === "proxy") return "proxy";
  if (c.kind === "critic") return "critic";
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
  // os papéis sem id (actor.ts ActorRole)
  if (who === "sentinel") return "A Sentinela";
  if (who === "chat") return "O Jido (chat)";
  if (who === "proxy") return "O procurador";
  if (who === "critic") return "O crítico";
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
