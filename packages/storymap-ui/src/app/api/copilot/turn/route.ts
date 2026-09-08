// SSE do turno do Jido agêntico (F1.2). POST {boardId, text, sessionId?, model?, effort?} →
// text/event-stream de eventos CopilotSseEvent (init/tool/frame/final/error). Spawna o processo MAIS PODEROSO
// do sistema (token MCP full + Bash nativo + --dangerously-skip-permissions) via runCopilotTurn.
//
// AUTH [CRÍTICO — não regredir]: esta rota é segura SÓ porque cai no catch-all `basic_auth` do Caddy (behind
// TLS). `/api/copilot/*` DEVE permanecer sob o catch-all — NUNCA adicionar um matcher dedicado fora do auth
// (só `/api/usm/*` fica fora do basic_auth, por design). Mesma fronteira de confiança do board.

import {
  boardScope,
  viewScope,
  runCopilotTurn,
  reserveCopilotTurnSlot,
  resumeScopeMismatch,
} from "@/lib/storymap/copilot/agent-session";
import { chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import { serializeSse, type CopilotSseEvent } from "@/lib/storymap/copilot/protocol";
import { leaseHeldByTick, readOrchestratorState } from "@/lib/storymap/runner/orchestrator-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]+$/i;

/**
 * Recusa com `reason` LEGÍVEL POR MÁQUINA — o contrato que a FILA do chat consome para decidir entre ESPERAR e
 * FALHAR (ver `copilot/outbox.ts`). Dois 409 diferentes moram aqui: "o board está ocupado agora" (transitório —
 * a fila espera e reenvia sozinha) e "a sessão é de outro board" (permanente — re-tentar nunca resolveria).
 * Sem o campo, o cliente teria de adivinhar pelo TEXTO do erro, que é copy: muda sem aviso e não é contrato.
 */
function reject(status: number, reason: string, error: string): Response {
  return Response.json({ ok: false, error, reason }, { status });
}

export async function POST(request: Request): Promise<Response> {
  let body: { boardId?: unknown; text?: unknown; sessionId?: unknown; model?: unknown; effort?: unknown; view?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const boardId = String(body.boardId ?? "");
  if (!SLUG_RE.test(boardId)) return Response.json({ ok: false, error: "invalid boardId" }, { status: 400 });
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return Response.json({ ok: false, error: "empty text" }, { status: 400 });
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
  const model = typeof body.model === "string" ? body.model : undefined;
  const effort = typeof body.effort === "string" ? body.effort : undefined;
  // `view` presente ⇒ a conversa é a daquela TELA (ver copilot/chat-surfaces): raia e persona próprias.
  // Ausente ⇒ o chat do board, exatamente como antes.
  const view = typeof body.view === "string" && body.view.trim() ? body.view.trim() : undefined;
  if (view && !SLUG_RE.test(view)) return Response.json({ ok: false, error: "invalid view" }, { status: 400 });
  // Fail-CLOSED: uma tela sem entrada no registro NÃO ganha um chat genérico por acidente. Cada conversa que
  // existe é uma decisão declarada (persona, poder, rótulo) — não um efeito colateral de digitar um nome novo.
  const chat = view ? chatSurfaceFor(view) : undefined;
  if (view && !chat) return Response.json({ ok: false, error: `sem chat para a tela «${view}»` }, { status: 400 });

  // A raia. Mesmo endpoint, chaves diferentes: é a CHAVE que mantém as conversas independentes, não o caminho
  // da URL — e reusar a rota mantém uma só implementação de streaming, fila e cancelamento.
  const scope = view ? viewScope(boardId, view) : boardScope(boardId);
  const purposeId = chat?.purposeId;
  // Binding sessão↔raia: um --resume cuja raia guardada ≠ a do request é REJEITADO (evita vazar contexto).
  // É o 409 PERMANENTE: esperar não muda nada (o cliente precisa de "Nova conversa"), por isso o reason próprio.
  if (sessionId && resumeScopeMismatch(sessionId, scope)) {
    return reject(409, "session-board-mismatch", "sessão atrelada a outra conversa");
  }
  // req5 — a sessão do board é COMPARTILHADA com o tick autônomo (WS2A: o tick resume a mesma sessão). Um ciclo
  // autônomo em voo (tickLease vivo) está escrevendo nessa sessão → NÃO deixamos um turno pareado escrever em
  // paralelo (corromperia o transcript). Bloqueia (não mata o run — decisão do operador): ele aguarda o ciclo
  // terminar ou o cancela em Processos. Checado ANTES da reserva (é await) para que nenhum caminho de recusa
  // precise devolver um slot reservado.
  // …e SÓ ela: o tick resume a sessão do CHAT do board. A conversa de uma tela tem sessão própria, então
  // esperar o ciclo autônomo terminar seria pedir ao operador que parasse de pensar porque o board está
  // trabalhando — que é justamente o acoplamento que as raias desfazem.
  if (!view && leaseHeldByTick(await readOrchestratorState(boardId), Date.now())) {
    return reject(409, "autonomous-tick", "o Jido autônomo está agindo neste board agora");
  }
  // 3.4 — 1 turno em voo por BOARD (um board = um chat). Cobre o resume (mesma sessão em voo) E o fresh (sem
  // sessionId): dois turnos "fresh" concorrentes no mesmo board — duplo-clique, aba dupla — passavam ambos e
  // cunhavam sessões diferentes (dois copilotos escrevendo o mesmo board). A porta é a RESERVA (síncrona), não um
  // simples check: o registro do turno vivo só nasce depois do setup do spawn, e essa janela era atravessável por
  // um segundo POST — ver reserveCopilotTurnSlot. Liberada no `finally` do stream, quando o turno termina.
  const slot = reserveCopilotTurnSlot(scope);
  if (!slot.ok) {
    return reject(409, "turn-in-flight", "já há um turno em andamento neste board");
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (ev: CopilotSseEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(serializeSse(ev)));
        } catch {
          closed = true;
        }
      };
      // Item 1 — o turno SOBREVIVE a uma desconexão do cliente (fechar aba/navegador / refresh): NÃO matamos o
      // processo aqui. O child roda até concluir no servidor e cai no transcript durável → reabrir HIDRATA o
      // resultado (mesma recuperação do #3). Só o cancelamento EXPLÍCITO (botão → rota /api/copilot/cancel)
      // mata o processo. O `send` acima já degrada para no-op quando o controller fecha (enqueue lança → closed).
      // Um turno abandonado é encerrado pelo watchdog de 600s em runCopilotTurn (WS-3): ele mata o GRUPO de
      // processos (SIGTERM→SIGKILL, alcança netos de tool pendurados) e libera o registro de turno-vivo (o 409)
      // via finish() — mesmo que o `close` do stdio nunca venha por causa de um neto que herdou o pipe.
      try {
        const { done } = await runCopilotTurn({ boardId, scope, purposeId, prompt: text, sessionId, model, effort }, send);
        await done;
      } catch (e) {
        send({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        closed = true;
        // Devolve o slot do board (o 409 abre). Aqui e SÓ aqui: liberar antes do fim do processo reabriria a
        // porta para um segundo `claude` na mesma sessão — inclusive para a própria fila do cliente, que
        // re-tenta em segundos. Um cancel explícito settla o turno na hora, então isto roda logo em seguida.
        slot.release();
        try {
          controller.close();
        } catch {
          /* já fechado */
        }
      }
    },
    cancel() {
      // Item 1 — desconexão do stream (consumer sumiu: aba fechada/refresh) NÃO mata o turno; ele conclui no
      // servidor e é recuperável pelo transcript. O kill vem SÓ do cancelamento explícito (rota /cancel).
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // desliga o buffering de proxies (Caddy/ttyd) — os eventos chegam ao vivo, não em bloco no fim.
      "X-Accel-Buffering": "no",
    },
  });
}
