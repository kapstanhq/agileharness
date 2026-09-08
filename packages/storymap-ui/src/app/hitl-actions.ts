"use server";

// Ação genérica que AVANÇA uma conversa HITL um turno: recebe o transcript + propósito + modo + contexto,
// chama o LLM (runClaudeJson) e devolve o próximo turno do agente. Stateless-por-chamada — o transcript
// vai/volta pelo cliente (modelo CaptureTurn). Gabarito = requestAssistedEditAction. Sem skip-permissions
// (HITL é no-tools); o `purpose` é validado contra o registry (rejeita desconhecido).

import { requireSession } from "@/lib/auth/action-guard";
import { runClaudeJson } from "@/lib/storymap/smart-capture/claude";
import { buildHitlPrompt } from "@/lib/storymap/hitl/prompt";
import { parseHitlTurn } from "@/lib/storymap/hitl/parse";
import { hitlPurposeById, resolveHitlPrompt } from "@/lib/storymap/hitl/purpose-registry";
import type { HitlAgentTurn, HitlResponseMode, HitlTranscript } from "@/lib/storymap/hitl/types";

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
function fail<T = unknown>(e: unknown): Result<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

export async function advanceHitlAction(input: {
  purpose: string;
  responseMode?: HitlResponseMode;
  transcript: HitlTranscript;
  /** contexto do consumidor já serializado em texto (dado, não instrução). */
  context?: string;
  /** board de origem — atribui a linha do helper em /processes (opcional). */
  boardId?: string;
}): Promise<Result<{ turn: HitlAgentTurn }>> {
  await requireSession("advanceHitlAction");
  try {
    // F1.7 — o Jido MIGROU para o transporte agêntico (sessão headless com tools + streaming, rota
    // /api/copilot/turn). advanceHitlAction (one-shot no-tools) NÃO atende mais o purpose "copilot" — guard
    // instrutivo p/ evitar bifurcação silenciosa se algum consumidor esquecido chamar o caminho velho. Os
    // demais purposes (smart-capture, desambiguação) continuam por aqui.
    if (input.purpose === "copilot") {
      return {
        ok: false,
        error: "O copiloto migrou para o transporte agêntico — use a rota /api/copilot/turn (useCopilotAgent), não advanceHitlAction.",
      };
    }
    const purpose = hitlPurposeById(input.purpose);
    if (!purpose) return { ok: false, error: `Propósito HITL desconhecido: ${input.purpose}` };
    const responseMode = input.responseMode ?? purpose.defaultResponseMode ?? "standard";
    const prompt = buildHitlPrompt({
      systemPrompt: resolveHitlPrompt(purpose),
      responseMode,
      doneContract: purpose.doneContract,
      context: input.context,
      transcript: input.transcript,
    });
    const raw = await runClaudeJson(prompt, {
      model: purpose.model,
      effort: purpose.effort,
      context: { label: `HITL · ${purpose.label}`, view: "hitl", board: input.boardId },
    });
    const turn = parseHitlTurn(raw);
    // 2.2 — server-side belt (defense in depth vs the prompt): a purpose WITHOUT a doneContract (an OPEN chat
    // like the copiloto) can NEVER "resolve". Drop any `done` the model still emitted so the client never flips
    // to a FALSE "✓ Resolvido — aplicado." banner + dead input. Dropping it BEFORE the validity check means a
    // turn that carried ONLY `done` now fails the guard below (→ error) instead of silently killing the chat.
    if (!purpose.doneContract && turn.done !== undefined) delete turn.done;
    if (!turn.message && !turn.options && turn.done === undefined) {
      return { ok: false, error: "O agente não devolveu um turno válido." };
    }
    return { ok: true, data: { turn } };
  } catch (e) {
    return fail(e);
  }
}
