// O CONJUNTO DE TOOLS POR PAPEL — o que cada tipo de sessão MONTA do servidor MCP, por baixo do nível do token.
//
// Por que existe. MEDIDO (123 sessões de condutor): o servidor monta ~140 tools para o token `orch`; só 31 delas aparecem
// em 5 ou mais sessões, e as outras ~110 nunca são chamadas por um condutor. O ganho de contexto é MENOR do que parece:
// o condutor nasce com `ToolSearch` (session-spawn.ts `CONDUCTOR_TOOLS`), e com ela os schemas MCP já são ADIADOS — o 1º
// turno medido custa ~7,6k com as 140 (CLI 2.1.289). O que o recorte corta de verdade é a LISTA de nomes adiados (uma
// linha por tool) e a chance de o agente achar, por busca, uma tool que não é do papel dele — não ~55k de schemas. Não
// há medição 40 × 140 publicada aqui: não cite um número de economia sem medir. O recorte acontece no MESMO ponto único
// que já filtra por nível (`defineTool` em register.ts): uma tool fora do conjunto simplesmente não é registrada.
//
// NÃO É CONTENÇÃO. A autoridade continua vindo do TOKEN (`levelAllows`): o conjunto só ESTREITA o que o nível já permite,
// nunca alarga. Por isso ele pode viajar num cabeçalho que o próprio cliente declara (o arquivo de MCP que o serviço
// escreve para a sessão): um cliente que mentisse o papel só conseguiria MENOS tools, e um que o omitisse fica com a
// superfície inteira do nível — o comportamento de antes. Um condutor que leia o próprio `.mcp.json` e chame o servidor
// SEM o cabeçalho tem a superfície inteira do `orch`: a cerca real é o token e a matriz de risco, nunca este arquivo.
// Papel desconhecido ⇒ ignorado (a superfície do nível).
//
// Três papéis declaram conjunto: o CONDUTOR (session-spawn.ts), a SENTINELA (sentinel-spawn.ts) e a ÂNCORA (fase 7,
// runner/anchor-spawn.ts). Os críticos lançados
// pelo serviço (runner/critics-spawn.ts) não montam MCP nenhum — não têm conjunto porque não têm servidor. O chat do board
// tem a superfície inteira do token dele por decisão do dono (fase 6: poderes amplos, auditados pela guarda).

/** O cabeçalho que a sessão manda ao servidor MCP para pedir a superfície do seu papel. */
export const MCP_TOOLSET_HEADER = "x-agileharness-toolset";

export type McpToolset = "conductor" | "sentinel" | "anchor";

/**
 * O CONDUTOR — as 31 tools que aparecem em 5 ou mais das 123 sessões medidas (ordem: da mais usada para a menos), mais
 * as que a skill do condutor manda chamar em caminhos raros (verificado por teste contra o texto da skill: toda tool que
 * a skill cita está aqui ou na lista do que a skill PROÍBE). Fora, de propósito: as saídas do operador (`approve_qa`,
 * `approve_review`), publicação e deploy, `answer_question` (ele nunca responde as próprias perguntas), as tools de shell
 * (`claude_*`, `run_task` — o token `orch` já não as monta) e a administração de board.
 */
export const CONDUCTOR_TOOLSET: readonly string[] = [
  // medidas (≥ 5 sessões)
  "get_card",
  "list_claims",
  "update_card",
  "release_claim",
  "worktree_discard",
  "move_card",
  "report_progress",
  "set_tasks",
  "runner_status",
  "list_statuses",
  "set_card_driver",
  "worktree_submit",
  "wait_for_submit",
  "worktree_refresh",
  "record_cost_projection",
  "write_sidecar",
  "add_finding",
  "record_decision",
  "triage_finding",
  "wait_for_any",
  "create_card",
  "ask_question",
  "report_issue",
  "suggest_work",
  "set_card_links",
  "read_doc",
  "list_cards",
  "request_extra_cycle",
  "get_styleguide",
  "get_card_wireframes",
  "choose_wireframe",
  // os caminhos raros que a skill prescreve
  "target_profile",
  "get_vocabulary",
  "board_autonomy",
  "claim_card",
  "worktree_open",
  "request_budget",
  "wait_for_approval",
  "design_feedback",
  "claude_sessions",
  // leitura do PRÓPRIO plano: ele mora em main (write_sidecar kind plans) e o VERIFICAR o entrega ao verificador — depois
  // de uma reciclagem, ou com o worktree atrás de main, esta é a volta pelo MCP.
  "get_card_plan",
  // fase 7 — o LOTE de correções/manutenções da mesma funcionalidade (skill: ref/batch.md).
  "claim_batch",
  "batch_drop",
];

/**
 * A ÂNCORA (fase 7 — runner/anchor-spawn.ts, skill `harness-anchor`): liga cards às funcionalidades do PRD. Lê o
 * vocabulário e os cards, grava SÓ `feature` (a cerca é o handle — mcp/handle-scope.ts `isFeatureOnlyHandle`, checado
 * no servidor), faz UMA pergunta agrupada por execução e propõe funcionalidade nova ao PRD por `propose_change`.
 */
export const ANCHOR_TOOLSET: readonly string[] = [
  "get_vocabulary",
  "list_cards",
  "get_card",
  "update_card",
  "propose_change",
  "ask_question",
];

/**
 * A SENTINELA — cuida da MÁQUINA (runner/sentinel.ts): lê o estado de execuções, fila de integração, saúde e publicação, e
 * no modo conserto (Máxima, token `orch`) solta reserva, cancela/reenfileira execução, resolve integração e registra o que
 * achou. Fora, de propósito: mexer em card de história (`update_card`, `move_card`), responder pergunta, decidir triagem ou
 * entrega, publicar, e as tools de terminal — a skill dela diz o mesmo, e o recorte faz a busca não as achar.
 */
export const SENTINEL_TOOLSET: readonly string[] = [
  // leitura do estado
  "list_boards",
  "list_cards",
  "get_card",
  "list_statuses",
  "runner_status",
  "list_claims",
  "list_system_decisions",
  "ah_health",
  "card_console",
  "board_pace",
  "board_autonomy",
  "claude_sessions",
  "deploy_status",
  "publish_status",
  "worktree_list",
  "intake_stats",
  "target_profile",
  // o conserto da máquina (o nível do token e a matriz de risco do board decidem o que de fato passa)
  "release_claim",
  "cancel_run",
  "enqueue",
  "resolve_merge",
  "worktree_discard",
  "reconcile_stage",
  // o registro do que achou
  "add_finding",
  "report_issue",
  "record_decision",
];

const TOOLSETS: Record<McpToolset, ReadonlySet<string>> = {
  conductor: new Set(CONDUCTOR_TOOLSET),
  sentinel: new Set(SENTINEL_TOOLSET),
  anchor: new Set(ANCHOR_TOOLSET),
};

/** As tools de um papel (cópia). PURA. */
export function toolsetTools(toolset: McpToolset): string[] {
  return [...TOOLSETS[toolset]];
}

/** O papel declarado no cabeçalho, ou undefined (ausente, vazio ou desconhecido ⇒ sem filtro de papel). PURA. */
export function parseToolset(raw: string | null | undefined): McpToolset | undefined {
  const v = raw?.trim().toLowerCase();
  return v && Object.prototype.hasOwnProperty.call(TOOLSETS, v) ? (v as McpToolset) : undefined;
}

/** A tool entra na superfície deste papel? Sem papel ⇒ sim (a superfície inteira do nível). PURA. */
export function toolsetAllows(toolset: McpToolset | undefined, name: string): boolean {
  return !toolset || TOOLSETS[toolset].has(name);
}
