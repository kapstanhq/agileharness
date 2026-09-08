// "O pipeline está OCIOSO?" — UMA régua, para todo mundo que precisa esperar o sistema aquietar.
//
// A pergunta já era feita antes desta função existir, mas INLINE no wiring do recovery sweep
// (instrumentation.ts). Isso custou caro: quando `liveRunIds()` passou a devolver as 100 entradas
// TERMINAIS da merge-queue, o `isIdle` virou permanentemente `false` e o sweep pulou TODO tick por
// semanas — sem uma linha de log. Um predicado que decide se subsistemas inteiros rodam não pode
// morar dentro do bootstrap de um deles, sem teste e sem nome.
//
// Duas fontes, porque são dois escritores diferentes na MESMA árvore de trabalho:
//   - o ENGINE (runs em voo / na fila) — um restart mataria o run;
//   - o MERGE TRAIN (entradas vivas) — ele mexe na árvore de `main` que a publicação também mexe.
// Entrada PARQUEADA (conflict/failed esperando humano) não conta como viva: ela pode ficar ali por
// dias, e tratá-la como "ocupado" congelaria para sempre quem espera ociosidade.
//
// Pure sobre as sondas injetadas — zero import de engine/queue, então testável sem subir nada.

/** As duas sondas. Injetadas (não importadas) para o módulo continuar puro e o teste não subir engine. */
export interface PipelineIdleProbes {
  /** o engine tem run em voo ou na fila? */
  hasInFlight: () => boolean;
  /** ids das entradas VIVAS do merge train (parked não entra). */
  liveMergeEntries: () => Promise<string[]>;
}

export interface IdleVerdict {
  idle: boolean;
  /** POR QUE não está ocioso, em texto de operador. `null` quando ocioso. */
  blockedBy: string | null;
}

export interface PipelineIdleOpts {
  /**
   * O que fazer quando uma SONDA falha (git fora do ar, arquivo ilegível).
   *
   * `"busy"` (default) = fail-CLOSED: na dúvida, não está ocioso. É o certo para quem vai AGIR de
   * forma destrutiva com base na resposta — publicar reinicia o serviço, e reiniciar no escuro
   * derruba run em voo. A dúvida tem de custar espera, nunca risco.
   *
   * `"idle"` = fail-OPEN: mantém o comportamento histórico do recovery sweep, cujo trabalho é
   * IDEMPOTENTE e barato — rodar recuperação a mais não quebra nada, e não rodar deixa run órfão.
   */
  onProbeError?: "busy" | "idle";
}

/**
 * Responde se o pipeline está parado, NOMEANDO o bloqueador. O nome não é cosmético: "merge train com
 * 100 entradas vivas" num board sem run rodando é absurdo à primeira leitura — teria exposto o bug
 * acima no primeiro dia, em vez de semanas depois e por acaso.
 */
export async function pipelineIdle(
  probes: PipelineIdleProbes,
  opts: PipelineIdleOpts = {},
): Promise<IdleVerdict> {
  const onProbeError = opts.onProbeError ?? "busy";

  let inFlight: boolean;
  try {
    inFlight = probes.hasInFlight();
  } catch (err) {
    return probeFailed("engine", err, onProbeError);
  }
  if (inFlight) return { idle: false, blockedBy: "um run está em voo/na fila" };

  let live: string[];
  try {
    live = await probes.liveMergeEntries();
  } catch (err) {
    return probeFailed("merge train", err, onProbeError);
  }
  if (live.length > 0) {
    const head = live.slice(0, 3).join(", ");
    return {
      idle: false,
      blockedBy: `merge train com ${live.length} entrada(s) viva(s): ${head}${live.length > 3 ? "…" : ""}`,
    };
  }

  return { idle: true, blockedBy: null };
}

function probeFailed(which: string, err: unknown, policy: "busy" | "idle"): IdleVerdict {
  const why = err instanceof Error ? err.message : String(err);
  if (policy === "idle") return { idle: true, blockedBy: null };
  return { idle: false, blockedBy: `não deu para ler o estado do ${which} (${why}) — assumindo ocupado` };
}
