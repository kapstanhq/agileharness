// F5.2 — the per-CALL guard: given a SCOPED agent's tool call (the autonomous tick, token `write`), decide
// whether it may run, must escalate to a human approval, or is refused outright — by the board's riskMatrix.
// defineTool (register.ts) wraps EVERY tool handler with this; it runs at CALL time (the handler is cached
// forever, so the policy MUST be re-read per call, never closed over). A `full` operator token or an internal
// (no-actor) call short-circuits to allow BEFORE any IO — so the human/paired chat is never gated, and the
// only surface this touches is a scoped token that, today, is only ever used by the (still-gated) tick.
//
// Contract: returns null ⇒ ALLOW (the real handler runs). Returns a CallToolResult ⇒ the guard's own reply:
//   - `ask`   → a PENDING result carrying the ApprovalRequest id + a hint to use wait_for_approval and re-try.
//   - `never` → an isError refusal (irreversible action a human must own).
// Every decision is written to the agent-actions audit ledger (fire-and-forget).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RiskClass, RiskDisposition } from "@/lib/storymap/types";
import { currentMcpActor } from "./actor";
import { resolveToolScope } from "./scope";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { readBoardConfig } from "@/lib/storymap/repo";
import { defaultDisposition, dispositionFor } from "@/lib/storymap/runner/orchestrator-policy";
import { createApprovalRequest, consumeGrant, findMatchingGrant } from "@/lib/storymap/approvals";
import { appendAgentAction } from "@/lib/storymap/runner/agent-actions";
import { appendCopilotActivity } from "@/lib/storymap/copilot/activity";
import {
  applyAction,
  rateWithinLimit,
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
 * The guard. `cls` is passed in (computed by defineTool via riskClassForTool) to avoid a register↔guard import
 * cycle. Returns null to ALLOW, or the guard's own CallToolResult to intercept.
 */
export async function guardToolCall(name: string, cls: RiskClass, args: unknown): Promise<CallToolResult | null> {
  const actor = currentMcpActor();
  if (!actor || actor.level === "full") return null; // operator token / internal call → never gated
  if (cls === "read") return null; // reads are always safe

  // ADR-065 + scope.ts: `board` is the SCOPE, not merely an argument — derivado da sessão/run/lote quando a
  // chamada não o nomeia. A resposta tem TRÊS valores (board / repo / unscoped) e cada um tem uma matriz dona;
  // tratar `repo` como "sem board" era o defeito que deixava `reconcile_stage` inalcançável (ver scope.ts).
  const scope = await resolveToolScope(name, args);
  if (scope.kind === "repo") return guardRepoScoped(name, cls, args, actor.tokenEnv);
  const board = scope.kind === "board" ? scope.board : undefined;
  // WS-12 (D16) — the `cardId` rides on EVERY audit line (not just the escalation path below): it is the ONLY
  // deterministic evidence of WHICH card a run actually tried. The per-item anti-noop streak is attributed from
  // this ledger (noop-attribution.ts) — never from the item's presence on the board, never from the LLM's own
  // account of what it did. A tool with no card arg (resolve_merge → runId) simply leaves it undefined.
  const auditBase = { actor: actor.tokenEnv, board, cardId: cardIdOf(args), tool: name, cls } as const;

  // 1) An existing human GRANT for this EXACT call (tool + byte-identical args)? Consume it atomically and run.
  if (board) {
    const grant = await findMatchingGrant(board, name, args).catch(() => null);
    if (grant && (await consumeGrant(board, grant.id, name, args).catch(() => false))) {
      void appendAgentAction({ ...auditBase, disposition: "auto", outcome: "grant-consumed", approvalId: grant.id });
      return null;
    }
  }

  // 2) Resolve the disposition from the board's riskMatrix (re-read per call — never cached).
  const policy = board ? (await readBoardConfig(board).catch(() => null))?.orchestrator ?? null : null;
  let disp = board ? dispositionFor(policy, cls) : defaultDisposition(cls);

  // 3) auto → rate-limit check (anti-runaway). Over the hourly cap ⇒ degrade to ask.
  if (disp === "auto" && board) {
    const now = Date.now();
    const st = await readOrchestratorState(board);
    if (!rateWithinLimit(st, policy?.maxActionsPerHour, now)) {
      disp = "ask";
    } else {
      await writeOrchestratorState(board, applyAction(st, now)).catch(() => {});
    }
  }

  // O ledger (agent-actions) é a trilha de AUDITORIA; o diário (activity) é o que o operador LÊ no chat. As
  // duas escritas andam juntas em cada desfecho: sem o diário, uma ação autônoma — ou uma recusa — acontecia
  // sem nenhuma superfície onde o humano a visse.
  const card = cardIdOf(args);
  const where = board ? `${board}${card ? `/${card}` : ""}` : undefined;

  if (disp === "auto") {
    void appendAgentAction({ ...auditBase, disposition: "auto", outcome: "executed" });
    if (board) void appendCopilotActivity(board, { kind: "acted", text: `Executei \`${name}\` sozinho (${cls}).`, detail: where });
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
    const req = await createApprovalRequest({ board, cardId: cardIdOf(args), tool: name, args, riskClass: cls, requestedBy: "run:orch" });
    void appendAgentAction({ ...auditBase, disposition: "ask", outcome: "pending", approvalId: req.id });
    void appendCopilotActivity(board, {
      kind: "asked",
      text: `Parei e pedi sua aprovação para \`${name}\` (${cls}).`,
      detail: where,
    });
    return pending(req.id, name, cls);
  }

  // never — an irreversible action a human always owns.
  void appendAgentAction({ ...auditBase, disposition: "never", outcome: "refused" });
  if (board) {
    void appendCopilotActivity(board, {
      kind: "refused",
      text: `Recusei \`${name}\` (${cls}): ação irreversível é sempre sua.`,
      detail: where,
    });
  }
  return denial(`A ação "${name}" (${cls}) é irreversível e SEMPRE exige decisão humana — não pode rodar por um agente autônomo. Escale ao operador.`);
}
