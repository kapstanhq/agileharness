// F5.2 — the per-CALL guard: given a SCOPED agent's tool call (the autonomous tick, token `write`), decide
// whether it may run, must escalate to a human approval, or is refused outright — by the board's riskMatrix.
// defineTool (register.ts) wraps EVERY tool handler with this; it runs at CALL time (the handler is cached
// forever, so the policy MUST be re-read per call, never closed over). A `full` operator token or an internal
// (no-actor) call short-circuits to allow BEFORE any policy IO — so the human/paired chat is never gated (the chat's
// calls are only RECORDED, fire-and-forget: copilot/chat-audit.ts), and the
// only surface this touches is a scoped token that, today, is only ever used by the (still-gated) tick.
//
// Contract: returns null ⇒ ALLOW (the real handler runs). Returns a CallToolResult ⇒ the guard's own reply:
//   - `ask`   → a PENDING result carrying the ApprovalRequest id + a hint to use wait_for_approval and re-try.
//   - `never` → an isError refusal (irreversible action a human must own).
// Every decision is written to the agent-actions audit ledger (fire-and-forget).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RiskClass, RiskDisposition } from "@/lib/storymap/types";
import { actorRole, currentMcpActor, mcpActorAttribution, noteResolvedRole, roleKindOf, type ActorRole, type McpActor } from "./actor";
import { callerWords, isCopilotCaller, toWhomWords } from "./caller";
import { resolveToolScope } from "./scope";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { readBoardConfig } from "@/lib/storymap/repo";
import { defaultDisposition, dispositionFor } from "@/lib/storymap/runner/orchestrator-policy";
import { clampByProfile } from "@/lib/storymap/autonomy-profile";
import { createApprovalRequest, consumeGrant, findMatchingGrant } from "@/lib/storymap/approvals";
import { appendAgentAction } from "@/lib/storymap/runner/agent-actions";
import { appendCopilotActivity } from "@/lib/storymap/copilot/activity";
import { recordChatMcpCall } from "@/lib/storymap/copilot/chat-audit";
import {
  applyActionForRole,
  rateWithinLimitForRole,
  readOrchestratorState,
  writeOrchestratorState,
} from "@/lib/storymap/runner/orchestrator-state";

function cardIdOf(args: unknown): string | undefined {
  const c = (args as Record<string, unknown> | null | undefined)?.cardId;
  return typeof c === "string" && c.trim() ? c.trim() : undefined;
}
function denial(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
/** A pending-approval reply — NOT isError: it's a structured "wait for the human, then re-try" the agent parses. */
function pending(approvalId: string, tool: string, cls: RiskClass): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          pendingApproval: approvalId,
          tool,
          riskClass: cls,
          hint: `esta ação (${cls}) exige aprovação humana. Chame wait_for_approval com id "${approvalId}" (timeout curto); se concedida, RE-CHAME a mesma tool com os MESMOS args. Se rejeitada/expirar, registre e siga — não fique em spin-wait.`,
        }),
      },
    ],
  };
}

/**
 * B4 — a resposta do FREIO de ritmo: não é erro nem pedido de aprovação. O agente
 * lê que bateu o limite de ações automáticas por hora do board e a hora em que pode tentar de novo. Antes o limite
 * rebaixava `auto` para `ask` e abria um pedido de aprovação por ação — o dono via «Jido pede: move_card» em série e
 * decidia à mão o que a matriz dele já autorizava.
 */
function throttled(tool: string, cls: RiskClass, retryAfter: string, maxPerHour: number, roleKind?: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          throttled: true,
          tool,
          riskClass: cls,
          retryAfter,
          ...(roleKind ? { role: roleKind } : {}),
          hint: `limite de ${maxPerHour} ações automáticas por hora ${roleKind ? `do papel «${roleKind}» ` : ""}neste board atingido — nada rodou e nada foi pedido ao humano. Tente de novo a partir de ${retryAfter} (com os MESMOS args, se ainda fizer sentido).`,
        }),
      },
    ],
  };
}

/** O início da PRÓXIMA hora-balde do limitador (orchestrator-state `hourKey`, em UTC) — quando o contador zera. */
function nextHourStart(now: number): string {
  return new Date((Math.floor(now / 3_600_000) + 1) * 3_600_000).toISOString();
}

/**
 * O ramo de ESCOPO REPO: a ação não é de board nenhum (a branch `stage`, a suíte, o serviço, o shell da caixa),
 * então quem a governa é `settings.yaml orchestrator.riskMatrix` — a mesma semântica da matriz de board, na
 * porta certa. O clamp de `NEVER_AUTO_RISK_CLASSES` continua valendo dentro de `dispositionFor`, então
 * `run-free`/`destructive` seguem humano-only mesmo que o settings.yaml diga `auto`.
 *
 * `ask` aqui RECUSA em vez de abrir uma aprovação — e isso é deliberado, não uma lacuna: as aprovações são
 * listadas por BOARD (`listApprovalRequests(boardId)`, no chat do Jido daquele board), então uma aprovação
 * de escopo repo não teria NENHUMA superfície onde o operador a visse. Criar uma seria exatamente o defeito
 * que este trabalho existe para eliminar: uma capacidade anunciada e inalcançável. A recusa, em compensação,
 * nomeia a alavanca REAL — o operador declara a classe no settings.yaml, ou executa a ação ele mesmo.
 */
async function guardRepoScoped(
  name: string,
  cls: RiskClass,
  args: unknown,
  tokenEnv: string | undefined,
): Promise<CallToolResult | null> {
  const audit = { actor: tokenEnv, board: undefined, cardId: cardIdOf(args), tool: name, cls } as const;
  let matrix: Partial<Record<RiskClass, RiskDisposition>> | undefined;
  try {
    matrix = loadRunnerConfig().orchestrator?.riskMatrix;
  } catch {
    matrix = undefined; // leitura de config falhou ⇒ default conservador, nunca fail-open
  }
  const disp = dispositionFor({ mode: "autonomous", riskMatrix: matrix }, cls);

  if (disp === "auto") {
    void appendAgentAction({ ...audit, disposition: "auto", outcome: "executed", note: "escopo repo" });
    return null;
  }
  if (disp === "ask") {
    void appendAgentAction({ ...audit, disposition: "ask", outcome: "refused", note: "escopo repo sem matriz" });
    return denial(
      `A ação "${name}" (${cls}) é de escopo REPO — não pertence a nenhum board, então nenhuma matriz de ` +
        `board a governa e não há Inbox onde uma aprovação apareceria. Hoje ela exige um humano. Para que ` +
        `o orquestrador possa executá-la sozinho, o operador declara a classe em ` +
        `\`storymap/settings.yaml\` → \`orchestrator.riskMatrix.${cls}: auto\` (exige restart do serviço). ` +
        `Enquanto isso não existir, peça ao operador — ou execute por um caminho que ele já autorize.`,
    );
  }
  void appendAgentAction({ ...audit, disposition: "never", outcome: "refused", note: "escopo repo" });
  return denial(
    `A ação "${name}" (${cls}) é irreversível/aberta e SEMPRE exige decisão humana — não pode rodar por um ` +
      `agente autônomo, em nenhum escopo. Escale ao operador.`,
  );
}

/**
 * Quem chamou, para a trilha e para o diário. `attribution` = o rótulo estável quando o agente se nomeou (a sessão é
 * resolvida no registro: condutor de qual card); `copilot` = é o copiloto falando (primeira pessoa no diário);
 * `words` = como dizer quem foi. Sem rótulo declarado, é «um agente» — nunca o copiloto por omissão. Nunca lança.
 */
async function callerOf(actor: McpActor): Promise<{ attribution: string | null; copilot: boolean; words: string; role: ActorRole }> {
  const caller = actor.caller;
  if (!caller) return { attribution: null, copilot: false, words: "Um agente", role: actorRole(actor, null) };
  let session: { driver?: string | null; cardId?: string | null; name?: string | null } | null = null;
  if (caller.kind === "session") {
    try {
      const { allSessions } = await import("@/lib/storymap/runner/session-worktree");
      const row = (await allSessions()).find((s) => s.sessionId === caller.id);
      session = row ? { driver: row.driver ?? null, cardId: row.cardId ?? null, name: row.tmuxSession ?? null } : null;
    } catch {
      session = null; // sem o registro, a sessão é dita pelo id dela
    }
  }
  const attribution = mcpActorAttribution(actor, session);
  return { attribution, copilot: isCopilotCaller(caller), words: callerWords(attribution) ?? "Um agente", role: actorRole(actor, session) };
}

/** As tools que só FREIAM um board (pausar, desacelerar): o guard as audita e nunca as retém. */
export const BRAKE_TOOLS: ReadonlySet<string> = new Set(["pause_board"]);

/**
 * The guard. `cls` is passed in (computed by defineTool via riskClassForTool) to avoid a register↔guard import
 * cycle. Returns null to ALLOW, or the guard's own CallToolResult to intercept.
 */
/** As tools que CRUZAM boards (o `board` é a origem; `toBoard`, o destino): a matriz mais estrita das duas governa. */
export const CROSS_BOARD_TOOLS: ReadonlySet<string> = new Set(["transfer_card"]);

const DISPOSITION_RANK: Record<RiskDisposition, number> = { auto: 0, ask: 1, never: 2 };
/** A disposição mais estrita de duas. PURA. */
export function stricterDisposition(a: RiskDisposition, b: RiskDisposition): RiskDisposition {
  return DISPOSITION_RANK[b] > DISPOSITION_RANK[a] ? b : a;
}

export async function guardToolCall(name: string, cls: RiskClass, args: unknown): Promise<CallToolResult | null> {
  const actor = currentMcpActor();
  if (!actor) return null; // internal call → never gated
  if (actor.level === "full") {
    // operator token → never gated. Mas a CONVERSA do Jido (fase 6: a central de comando do dono, com este token) deixa
    // registro de toda ação — antes ela saía daqui sem uma linha na trilha (copilot/chat-audit.ts).
    recordChatMcpCall(actor, name, cls, args);
    return null;
  }
  if (cls === "read") return null; // reads are always safe

  // scope.ts: `board` is the SCOPE, not merely an argument — derivado da sessão/run/lote quando a
  // chamada não o nomeia. A resposta tem TRÊS valores (board / repo / unscoped) e cada um tem uma matriz dona;
  // tratar `repo` como "sem board" era o defeito que deixava `reconcile_stage` inalcançável (ver scope.ts).
  const scope = await resolveToolScope(name, args);
  if (scope.kind === "repo") return guardRepoScoped(name, cls, args, actor.tokenEnv);
  const board = scope.kind === "board" ? scope.board : undefined;
  // WS-12 (D16) — the `cardId` rides on EVERY audit line (not just the escalation path below): it is the ONLY
  // deterministic evidence of WHICH card a run actually tried. The per-item anti-noop streak is attributed from
  // this ledger (noop-attribution.ts) — never from the item's presence on the board, never from the LLM's own
  // account of what it did. A tool with no card arg (resolve_merge → runId) simply leaves it undefined.
  // QUEM chamou (mcp/caller.ts): a atribuição entra em toda linha da trilha, e decide a VOZ do diário — só o copiloto
  // fala em primeira pessoa; a ação de outro agente é dita como dele (antes o diário dizia «Executei…» por todo mundo).
  const who = await callerOf(actor);
  // Fase 6 — o PAPEL (mcp/actor.ts): fica no ator, para as escritas SÍNCRONAS desta requisição (o salto de status do
  // move_card grava `conductor:<card>`, não `run:orch`), entra em toda linha da trilha e escolhe o balde do limite.
  noteResolvedRole(actor, who.role);
  const roleKind = roleKindOf(who.role);
  const auditBase = { actor: actor.tokenEnv, ...(who.attribution ? { caller: who.attribution } : {}), role: who.role, board, cardId: cardIdOf(args), tool: name, cls } as const;

  // 0) O FREIO nunca é freado. Pausar ou desacelerar um board (runner/board-pace.ts) é o sentido seguro, e a hora em que
  //    o limite de ações do board estourou — ou em que a matriz dele pede aprovação para escrever — é exatamente a hora
  //    em que um agente precisa conseguir parar. Fica na trilha de auditoria; não conta no limite nem pede aprovação.
  if (BRAKE_TOOLS.has(name)) {
    void appendAgentAction({ ...auditBase, disposition: "auto", outcome: "executed", note: "freio do board — nunca retido" });
    return null;
  }

  // 1) An existing human GRANT for this EXACT call (tool + byte-identical args)? Consume it atomically and run.
  if (board) {
    const grant = await findMatchingGrant(board, name, args).catch(() => null);
    if (grant && (await consumeGrant(board, grant.id, name, args).catch(() => false))) {
      void appendAgentAction({ ...auditBase, disposition: "auto", outcome: "grant-consumed", approvalId: grant.id });
      return null;
    }
  }

  // 2) Resolve the disposition from the board's riskMatrix (re-read per call — never cached).
  const boardCfg = board ? await readBoardConfig(board).catch(() => null) : null;
  const policy = boardCfg?.orchestrator ?? null;
  // O PERFIL de autonomia (autonomy-profile.ts) só APERTA a matriz: com a caixa de deploy desligada no bloco explícito,
  // `deploy` nunca resolve `auto`, mesmo com a matriz editada à mão depois do painel.
  let disp = board ? clampByProfile(boardCfg, cls, dispositionFor(policy, cls)) : defaultDisposition(cls);
  // Uma ação que CRUZA boards (mudar um card de board) responde à matriz MAIS ESTRITA dos dois: a do board de destino
  // também governa o que entra nele. Destino ilegível ⇒ a disposição padrão da classe (conservadora).
  const toBoard = CROSS_BOARD_TOOLS.has(name) ? (args as Record<string, unknown> | null | undefined)?.toBoard : undefined;
  if (board && typeof toBoard === "string" && toBoard.trim() && toBoard !== board) {
    const toCfg = await readBoardConfig(toBoard.trim()).catch(() => null);
    const toPolicy = toCfg?.orchestrator ?? null;
    disp = stricterDisposition(disp, toPolicy ? clampByProfile(toCfg, cls, dispositionFor(toPolicy, cls)) : defaultDisposition(cls));
  }

  // O ledger (agent-actions) é a trilha de AUDITORIA; o diário (activity) é o que o operador LÊ no chat. As
  // duas escritas andam juntas em cada desfecho: sem o diário, uma ação autônoma — ou uma recusa — acontecia
  // sem nenhuma superfície onde o humano a visse.
  const card = cardIdOf(args);
  const where = board ? `${board}${card ? `/${card}` : ""}` : undefined;

  // 3) auto → rate-limit check (anti-runaway). B4: over the hourly cap ⇒ THROTTLE (retry-after to the agent), never
  //    an approval request — um freio de ritmo não é uma decisão do dono. Fase 6: o balde é do PAPEL — condutores,
  //    Sentinela, procurador, crítico e agentes de fora não dividem mais um limite só (o teto é o do board, por papel).
  if (disp === "auto" && board) {
    const now = Date.now();
    const st = await readOrchestratorState(board);
    const max = policy?.maxActionsPerHour;
    if (!rateWithinLimitForRole(st, roleKind, max, now)) {
      const retryAfter = nextHourStart(now);
      void appendAgentAction({ ...auditBase, disposition: "auto", outcome: "throttled", retryAfter, note: `limite de ${max} ações/hora do papel ${roleKind}; tentar de novo a partir de ${retryAfter}` });
      void appendCopilotActivity(board, {
        kind: "refused",
        text: `${who.copilot ? "Adiei" : `${who.words} pediu`} \`${name}\` (${cls})${who.copilot ? "" : " e eu adiei"}: o limite de ${max} ações automáticas por hora deste papel foi atingido. Nada foi pedido a você; dá para tentar de novo a partir de ${retryAfter}.`,
        detail: where,
      });
      return throttled(name, cls, retryAfter, max ?? 0, roleKind);
    }
    await writeOrchestratorState(board, applyActionForRole(st, roleKind, now)).catch(() => {});
  }

  if (disp === "auto") {
    void appendAgentAction({ ...auditBase, disposition: "auto", outcome: "executed" });
    if (board) void appendCopilotActivity(board, { kind: "acted", text: who.copilot ? `Executei \`${name}\` sozinho (${cls}).` : `${who.words} executou \`${name}\` (${cls}).`, detail: where });
    return null;
  }

  if (disp === "ask") {
    if (!board) {
      // No board to scope an approval to — refuse rather than run an ungoverned action.
      void appendAgentAction({ ...auditBase, disposition: "ask", outcome: "refused", note: "sem board p/ escopar aprovação" });
      // `unscoped` = a tool É de board, mas ESTA chamada não identifica um (sessionId/runId desconhecido, ou um
      // lote que cruza boards). Diferente do escopo repo, aqui o conselho É seguível — por isso ele sobrevive.
      return denial(
        `A ação "${name}" (${cls}) exige aprovação humana, mas esta chamada não identifica o board que a ` +
          `governa. Refaça nomeando o board (ou, num lote que cruza boards, divida-o: um lote por board).`,
      );
    }
    const req = await createApprovalRequest({
      board,
      cardId: cardIdOf(args),
      tool: name,
      args,
      riskClass: cls,
      reason: "risk-matrix",
      requestedBy: who.attribution ?? mcpActorAttribution(actor),
    });
    void appendAgentAction({ ...auditBase, disposition: "ask", outcome: "pending", approvalId: req.id });
    void appendCopilotActivity(board, {
      kind: "asked",
      text: who.copilot ? `Parei e pedi sua aprovação para \`${name}\` (${cls}).` : `${who.words} pediu \`${name}\` (${cls}): parei e pedi sua aprovação.`,
      detail: where,
    });
    return pending(req.id, name, cls);
  }

  // never — an irreversible action a human always owns.
  void appendAgentAction({ ...auditBase, disposition: "never", outcome: "refused" });
  if (board) {
    void appendCopilotActivity(board, {
      kind: "refused",
      text: `Recusei \`${name}\` (${cls})${who.copilot ? "" : ` ${toWhomWords(who.words)}`}: ação irreversível é sempre sua.`,
      detail: where,
    });
  }
  return denial(`A ação "${name}" (${cls}) é irreversível e SEMPRE exige decisão humana — não pode rodar por um agente autônomo. Escale ao operador.`);
}
