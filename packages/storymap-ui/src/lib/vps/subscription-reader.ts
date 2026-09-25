// subscription-reader — a ÚNICA ida ao `/stats` do proxy de uso (a janela real da assinatura + a economia do
// proxy). Saiu de `metrics.ts` para ter DOIS leitores sem duplicar a regra: o MetricsHub (o mostrador, que
// também roda o ccusage e lê /proc a cada poll) e o governador de capacidade (runner/capacity-service.ts), que
// só precisa da janela — e não pode pagar o spawn do ccusage a cada decisão de admissão.
//
// SERVER-ONLY (fetch com timeout). O parse é puro e mora em subscription.ts.

import { parseHeadroomStats } from "./subscription";
import type { HeadroomSavings, UsageWindow } from "./types";

/** Valores de `AGILEHARNESS_HEADROOM_URL` que desligam o proxy — a mesma régua de runner/headroom.ts. */
const OFF_VALUES = /^(0|off|false|none|disabled)$/i;

/** A porta convencional do proxy, usada só quando nenhuma URL foi declarada (o mostrador sempre a tentou). */
const CONVENTIONAL_BASE = "http://127.0.0.1:8787";

/**
 * A URL do `/stats`, ou null quando o proxy foi DESLIGADO por env (`off`/`0`/`false`/`none`/`disabled`).
 * Sem declaração, tenta a porta convencional: uma porta muda ou que responde outra coisa resulta em leitura
 * nula (o parse recusa o que não reconhece), nunca num número inventado.
 */
export function headroomStatsUrl(env: Record<string, string | undefined> = process.env): string | null {
  const declared = env.AGILEHARNESS_HEADROOM_URL?.trim();
  if (declared && OFF_VALUES.test(declared)) return null;
  const base = (declared || CONVENTIONAL_BASE).replace(/\/+$/, "");
  return `${base}/stats`;
}

/**
 * Busca e interpreta o `/stats`. Um proxy quebrado/ausente NUNCA pode travar quem pergunta: timeout curto e
 * `{usage: null, headroom: null}` em qualquer falha. NUNCA lança.
 */
export async function readHeadroomStats(
  url: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ usage: UsageWindow | null; headroom: HeadroomSavings | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 1500);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return { usage: null, headroom: null };
    const { usage, savings } = parseHeadroomStats(await res.text());
    return { usage, headroom: savings };
  } catch {
    return { usage: null, headroom: null };
  } finally {
    clearTimeout(timer);
  }
}
