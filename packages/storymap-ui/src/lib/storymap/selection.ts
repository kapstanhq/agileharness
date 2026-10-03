// Seleção PLANA + fan-out de LOTE para ações sobre cards reais (ideias irmãs no HUB da captura
// e na bancada). Distinto da cascata parent-closed de smart-capture/proposal-tree (que opera sobre a
// hierarquia de UMA proposta): aqui as entidades são raízes inertes, então um Set<id> plano basta —
// generalizar o cascadeSelect para isto seria over-engineering. PURO (sem React/IO).

/** Toggle de um id num Set (retorna um NOVO Set). */
export function toggleId(sel: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(sel);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export interface BatchOutcome {
  okIds: string[];
  failed: { id: string; error: string }[];
}

/**
 * Fan-out de uma ação por id com CAP de concorrência (pool de workers), agregando sucessos/falhas no shape
 * Result ({ok,error}). Falhas individuais (gate/in-flight/etc.) NÃO derrubam o lote — voltam em `failed`.
 * `onProgress` reporta conforme cada um resolve, para alimentar uma barra "N/M". Idempotente quando a ação
 * é (o engine do AgileHarness trata re-disparo como no-op via in-flight lock). O cap evita um pico de N spawns
 * de uma vez quando o humano seleciona muitas ideias (default 5; `opts.concurrency` ajusta).
 */
export async function runBatch(
  ids: string[],
  runOne: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>,
  onProgress?: (done: number, total: number) => void,
  opts?: { concurrency?: number },
): Promise<BatchOutcome> {
  const okIds: string[] = [];
  const failed: { id: string; error: string }[] = [];
  let done = 0;
  let cursor = 0;
  const concurrency = Math.max(1, opts?.concurrency ?? 5);
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const r = await runOne(id);
        if (r.ok) okIds.push(id);
        else failed.push({ id, error: r.error });
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) });
      } finally {
        done++;
        onProgress?.(done, ids.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length || 1) }, worker));
  return { okIds, failed };
}
