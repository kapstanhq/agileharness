"use server";

// As server actions do RITMO DO BOARD — o botão de pausar / devagar / normal do cabeçalho.
//
// São a ponte, e nada mais: a regra de quem pode mudar, o que a pausa segura e o que a retomada devolve moram em
// `lib/storymap/runner/board-pace*.ts`, e a tool MCP (pause_board / resume_board) passa pelas MESMAS funções. Quem
// chega por aqui com sessão no navegador é o DONO; um agente escopado que chame a action é tratado como agente.

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/action-guard";
import { isScopedActor } from "@/lib/storymap/mcp/actor";
import { setBoardAutorun } from "@/lib/storymap/board-registry";
import { boardPaceViewNow, changeBoardPaceNow } from "@/lib/storymap/runner/board-pace-actions";
import { paceLabel, type BoardPaceView, type PaceLevel, type PauseMode } from "@/lib/storymap/runner/board-pace";
import { appendAgentAction } from "@/lib/storymap/runner/agent-actions";

type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** O ritmo do board agora (quem pôs, até quando, quantos cards esperam, a sugestão pela cota). */
export async function getBoardPaceAction(boardId: string): Promise<Result<BoardPaceView>> {
  await requireSession("getBoardPaceAction");
  const view = await boardPaceViewNow(boardId);
  return view ? { ok: true, data: view } : { ok: false, error: "Este board não existe ou não pôde ser lido." };
}

/** A frase que o botão mostra depois da mudança — o que de fato aconteceu, em palavras. */
function outcomeWords(level: PaceLevel, o: { changed: boolean; stopped: number; parked: number; released: number; rewritten: boolean }): string {
  if (!o.changed) return `O board já estava em «${paceLabel(level)}».`;
  const parts: string[] = [`Board em «${paceLabel(level)}».`];
  if (o.stopped) parts.push(`${o.stopped} ${o.stopped === 1 ? "trabalho automático saiu" : "trabalhos automáticos saíram"} do caminho e ${o.stopped === 1 ? "volta" : "voltam"} na retomada.`);
  if (o.parked) parts.push(`${o.parked} ${o.parked === 1 ? "sessão está guardando" : "sessões estão guardando"} o trabalho para encerrar.`);
  if (o.released) parts.push(`${o.released} ${o.released === 1 ? "card voltou" : "cards voltaram"} a andar.`);
  if (o.rewritten) parts.push("O registro de ritmo estava ilegível e foi regravado: os outros boards voltaram ao ritmo normal.");
  return parts.join(" ");
}

/**
 * Muda o ritmo do board. `arm` é o gesto à parte de LIGAR um board que nunca foi armado (o botão pede confirmação
 * antes de mandá-lo): sem ele, um board desarmado não é acelerado por aqui.
 */
export async function setBoardPaceAction(input: {
  boardId: string;
  level: PaceLevel;
  reason?: string;
  mode?: PauseMode;
  forMinutes?: number;
  arm?: boolean;
}): Promise<Result<{ pace: BoardPaceView; message: string }>> {
  await requireSession("setBoardPaceAction");
  try {
    const agent = isScopedActor();
    const before = await boardPaceViewNow(input.boardId);
    if (!before) return { ok: false, error: "Este board não existe ou não pôde ser lido." };
    if (before.source === "disarmed" && input.level !== "paused") {
      if (agent) return { ok: false, error: "Só o dono liga um board desarmado por aqui." };
      if (!input.arm) return { ok: false, error: "Este board está desligado. Confirme que quer ligá-lo: a partir daí os passos automáticos dele disparam agentes sozinhos." };
      const armed = await setBoardAutorun(input.boardId, true);
      if (!armed.ok) return { ok: false, error: armed.error };
    }
    const res = await changeBoardPaceNow({
      board: input.boardId,
      level: input.level,
      reason: input.reason,
      mode: input.mode,
      forMinutes: input.forMinutes,
      by: agent ? { kind: "agent" } : { kind: "owner" },
    });
    if (!res.ok) return { ok: false, error: res.error };
    if (!agent) {
      // a trilha de auditoria das ações do dono (fail-open: nunca quebra o clique)
      void appendAgentAction({
        actor: "human:board-header",
        board: input.boardId,
        tool: "setBoardPaceAction",
        cls: input.level === "paused" ? "write-board" : "run",
        disposition: "auto",
        outcome: "executed",
        note: [`ritmo=${input.level}`, input.mode ? `modo=${input.mode}` : null, input.forMinutes ? `prazo=${input.forMinutes}min` : null].filter(Boolean).join(" · "),
      });
    }
    revalidatePath(`/board/${input.boardId}`);
    const pace = (await boardPaceViewNow(input.boardId)) ?? before;
    return { ok: true, data: { pace, message: outcomeWords(pace.level, res) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
