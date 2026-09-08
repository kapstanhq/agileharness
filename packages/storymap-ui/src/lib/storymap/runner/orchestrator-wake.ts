// orchestrator-wake.ts — o Jido autônomo ACORDA POR EVENTO, não só pelo relógio.
//
// PROBLEMA: o tick periódico (30min) é o único gatilho. Um card trava às 14:01 e o Jido só descobre às
// 14:30 — e um evento que chegue 10s depois de um tick espera um ciclo inteiro. O operador vê um copiloto lerdo.
//
// FONTE DOS EVENTOS: o barramento de notificações que JÁ EXISTE (lib/notifications). O watcher assiste
// `storymap/boards/**` no nível do FILESYSTEM, então enxerga QUALQUER escritor — a server action da UI, o
// autorun headless, um agente editando o .md direto — e já anexa a `demand` dominante do card (pergunta,
// blocker, review, gate) em cada evento. Pendurar o Jido ali (copilot-wake-channel) é o caminho barato:
// um channel novo, zero watcher novo. O que o barramento NÃO vê (run morto, conflito do merge train — que
// vivem na telemetria/registry, não em arquivos de board) entra pelo `onIdle` do engine.
//
// SEGURANÇA POR CONSTRUÇÃO: o wake NÃO decide nada — ele só faz o tick acontecer ANTES. Quem decide spawnar é
// runOrchestratorTick, com TODOS os gates de sempre (mode autonomous, tick global armado, lease de humano, run
// em voo, budget, hasWork = cockpit ACIONÁVEL, backoff anti-noop). Um evento que não gera trabalho acionável
// custa ZERO token: o gate hasWork corta antes do spawn.
//
// RAILS: debounce (uma rajada de escritas = UM wake) + cooldown (intervalo mínimo entre dois runs acordados
// por evento). O cooldown NÃO descarta o wake — ele o REAGENDA para o fim do cooldown, senão um evento que
// chega logo após um tick seria perdido em silêncio.

import type { AgileHarnessEvent } from "@/lib/notifications/event";
import { loadRunnerConfig } from "./config";
import { listBoards, readBoardConfig } from "@/lib/storymap/repo";
import { readOrchestratorState } from "./orchestrator-state";
import { clearPendingWake, setPendingWake } from "./orchestrator-clock";
import { runBoardTickNow } from "./orchestrator-run";
import { appendCopilotActivity } from "@/lib/storymap/copilot/activity";

/** Defaults quando settings.orchestrator.wake está ausente (espelham DEFAULTS em config.ts). */
export const WAKE_DEFAULTS = { enabled: true, debounceSeconds: 45, cooldownMinutes: 5 } as const;

/**
 * O evento merece acordar o Jido? Devolve o MOTIVO (texto curto que vai no prompt do run e na UI) ou null.
 *
 * Regra: acordamos por trabalho POTENCIALMENTE acionável, não por qualquer escrita.
 *  - `card.updated` SÓ com uma `demand` anexada (pergunta/blocker/review/gate) — é exatamente "issue nova",
 *    "finding escalado", "item que caiu na fila de decisão". Um update sem demanda (harness-enrich preenchendo
 *    campos) NÃO acorda ninguém: seria um spawn por keystroke de agente.
 *  - `card.moved` sempre — um card mudando de coluna é o sinal de progresso/travamento do pipeline.
 *  - `card.created` sempre — um bug/ideia entrando (report_issue → card de triagem) é o caso que o operador
 *    mais quer que o Jido veja cedo.
 *  - `board.updated` NUNCA — o próprio toggle de modo grava board.yaml; acordar aqui seria um laço
 *    (ligar auto → board.yaml muda → wake → ...). O tick imediato do toggle já cobre esse caso.
 *  - `card.deleted` NUNCA — não há o que fazer sobre um card que sumiu.
 * PURA.
 */
export function wakeReasonForEvent(e: AgileHarnessEvent): string | null {
  const card = e.title ? `"${e.title}"` : (e.cardId ?? "card");
  if (e.demand) return `${e.demand.label} em ${card}`;
  switch (e.type) {
    case "card.moved":
      return `${card} foi movido para ${e.toStatusName ?? e.toStatus ?? "outra coluna"}`;
    case "card.created":
      return `${card} entrou no board`;
    default:
      return null; // card.updated sem demanda, card.deleted, board.updated
  }
}

export interface WakeTiming {
  /** epoch ms em que o wake deve disparar. */
  dueAt: number;
  /** true quando o cooldown empurrou o wake p/ frente (a UI pode explicar a espera). */
  throttled: boolean;
}

/**
 * QUANDO este wake deve disparar: no mínimo `debounceMs` (coalescer a rajada) e nunca antes de
 * `lastTickAt + cooldownMs` (não empilhar runs). Um wake já em voo (`pendingAt`) NÃO é adiado — mantemos o
 * horário mais CEDO, senão uma chuva de eventos empurraria o wake indefinidamente (starvation). PURA.
 */
export function wakeTiming(input: {
  now: number;
  debounceMs: number;
  cooldownMs: number;
  /** epoch ms do último tick que rodou (0/undefined = nunca rodou). */
  lastTickAt?: number;
  /** epoch ms de um wake JÁ agendado p/ este board, se houver. */
  pendingAt?: number;
}): WakeTiming {
  const { now, debounceMs, cooldownMs, lastTickAt, pendingAt } = input;
  const afterDebounce = now + Math.max(0, debounceMs);
  const afterCooldown = lastTickAt ? lastTickAt + Math.max(0, cooldownMs) : 0;
  const dueAt = Math.max(afterDebounce, afterCooldown);
  const throttled = afterCooldown > afterDebounce;
  if (pendingAt !== undefined && pendingAt <= dueAt) return { dueAt: pendingAt, throttled };
  return { dueAt, throttled };
}

// ── Scheduler (IO) ────────────────────────────────────────────────────────────
// Timers globalThis-pinned pelo mesmo motivo do clock: bundles de rota diferentes veriam Maps diferentes e o
// debounce viraria "um timer por bundle" (spawns duplicados).

interface WakeState {
  timers: Map<string, { handle: ReturnType<typeof setTimeout>; dueAt: number; reason: string }>;
}
const KEY = Symbol.for("storymap.orchestrator.wake");
const store = globalThis as unknown as { [KEY]?: WakeState };
function wakes(): WakeState {
  return (store[KEY] ??= { timers: new Map() });
}

function wakeSettings(): { enabled: boolean; debounceMs: number; cooldownMs: number } {
  const w = loadRunnerConfig().orchestrator?.wake ?? WAKE_DEFAULTS;
  return {
    enabled: w.enabled !== false,
    debounceMs: Math.max(0, (w.debounceSeconds ?? WAKE_DEFAULTS.debounceSeconds) * 1_000),
    cooldownMs: Math.max(0, (w.cooldownMinutes ?? WAKE_DEFAULTS.cooldownMinutes) * 60_000),
  };
}

/**
 * Agenda um wake para `board` (debounce + cooldown). Fire-and-forget: NUNCA lança, nunca bloqueia o caller
 * (um channel de notificação / o onIdle do engine). Sai cedo — sem custo — quando o Jido está desligado,
 * o wake está desligado, ou o board não é `autonomous`.
 */
export async function scheduleBoardWake(board: string, reason: string): Promise<void> {
  try {
    const cfg = loadRunnerConfig().orchestrator;
    const { enabled, debounceMs, cooldownMs } = wakeSettings();
    if (!enabled || cfg?.enabled !== true) return; // copiloto/wake desarmado ⇒ nada a fazer
    const mode = (await readBoardConfig(board)).orchestrator?.mode ?? "off";
    if (mode !== "autonomous") return; // só o modo autônomo acorda sozinho (off/paired = o humano dirige)

    const st = wakes();
    const existing = st.timers.get(board);
    const state = await readOrchestratorState(board);
    const lastTickAt = state.lastTickAt ? new Date(state.lastTickAt).getTime() : undefined;
    const { dueAt } = wakeTiming({
      now: Date.now(),
      debounceMs,
      cooldownMs,
      lastTickAt: Number.isFinite(lastTickAt) ? lastTickAt : undefined,
      pendingAt: existing?.dueAt,
    });

    // Um wake já agendado p/ esta janela: mantém o timer (o horário mais cedo vence) e só registra o motivo
    // mais recente. Re-armar aqui seria o bug clássico do debounce: uma rajada contínua adia o wake p/ sempre.
    if (existing && existing.dueAt <= dueAt) {
      existing.reason = reason;
      setPendingWake({ board, reason, dueAt: existing.dueAt });
      return;
    }
    if (existing) clearTimeout(existing.handle);

    // o operador vê no chat que um evento chegou e que o Jido vai OLHAR o board (e por quê) — antes, o
    // intervalo entre "algo aconteceu" e "o Jido falou" era um silêncio sem explicação.
    //
    // `scheduled`, não `woke`: aqui NADA rodou ainda — só marcamos um horário. O tick que nascer daqui pode
    // muito bem PULAR (sem trabalho, sem budget, em backoff), e aí este evento é tudo que existiu. Vendido
    // como `woke` ("acordei e disparei"), ele fazia um board parado parecer um board trabalhando. E o texto
    // segue a mesma régua: promete OLHAR, que é o que de fato vai acontecer — não agir.
    void appendCopilotActivity(board, {
      kind: "scheduled",
      text: `Vi um evento e agendei uma olhada no board: ${reason}.`,
      detail: `em ${Math.max(1, Math.round((dueAt - Date.now()) / 1000))}s`,
    });

    const delay = Math.max(0, dueAt - Date.now());
    const handle = setTimeout(() => {
      const cur = wakes().timers.get(board);
      wakes().timers.delete(board);
      clearPendingWake(board);
      void runBoardTickNow(board, cur?.reason ?? reason).catch(() => {});
    }, delay);
    handle.unref?.(); // um wake pendente nunca segura o processo vivo
    st.timers.set(board, { handle, dueAt, reason });
    setPendingWake({ board, reason, dueAt });
  } catch (err) {
    console.error(`[orchestrator-wake ${board}] falhou:`, err instanceof Error ? err.message : err);
  }
}

/** Acorda TODOS os boards autônomos (o `onIdle` do engine: um run acabou — pode ter travado ou gerado
 *  trabalho, e isso NÃO passa pelo watcher de arquivos). Best-effort. */
export async function wakeAutonomousBoards(reason: string): Promise<void> {
  try {
    if (loadRunnerConfig().orchestrator?.enabled !== true) return;
    for (const b of await listBoards()) {
      const mode = (await readBoardConfig(b.id).catch(() => null))?.orchestrator?.mode ?? "off";
      if (mode === "autonomous") await scheduleBoardWake(b.id, reason);
    }
  } catch (err) {
    console.error("[orchestrator-wake] varredura falhou:", err instanceof Error ? err.message : err);
  }
}

/** Só p/ teste: cancela os wakes em voo. */
export function resetWakes(): void {
  for (const [board, t] of wakes().timers) {
    clearTimeout(t.handle);
    clearPendingWake(board);
  }
  wakes().timers.clear();
}
