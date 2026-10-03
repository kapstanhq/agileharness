// subscription-reader — a ÚNICA ida ao `/stats` do proxy de uso (a janela real da assinatura + a economia do
// proxy). Saiu de `metrics.ts` para ter DOIS leitores sem duplicar a regra: o MetricsHub (o mostrador, que
// também roda o ccusage e lê /proc a cada poll) e o governador de capacidade (runner/capacity-service.ts), que
// só precisa da janela — e não pode pagar o spawn do ccusage a cada decisão de admissão.
//
// SERVER-ONLY (fetch com timeout). O parse é puro e mora em subscription.ts.

import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { vpsOf } from "@/lib/storymap/vps-settings";
import { parseHeadroomStats } from "./subscription";
import type { HeadroomSavings, UsageWindow } from "./types";

/** Valores de `AGILEHARNESS_HEADROOM_URL` que desligam o proxy — a mesma régua de runner/headroom.ts. */
const OFF_VALUES = /^(0|off|false|none|disabled)$/i;

/**
 * A URL do `/stats`, ou null quando NÃO HÁ medidor: o proxy foi DESLIGADO por env (`off`/`0`/`false`/`none`/`disabled`)
 * ou ninguém declarou onde ele está. Precedência: `AGILEHARNESS_HEADROOM_URL` > `declared` (`vps.headroomUrl` do
 * settings.yaml) > nada.
 *
 * NÃO há porta «convencional» a tentar. Um endereço de loopback não identifica quem atende nele: a mesma porta pode
 * ser outra coisa na máquina de quem instala, e um medidor lendo outro serviço entrega um número que parece certo.
 * Sem declaração o medidor não existe e o governador de capacidade fica inerte (e DIZ isso no log, uma vez).
 */
export function headroomStatsUrl(env: Record<string, string | undefined> = process.env, declared?: string | null): string | null {
  const fromEnv = env.AGILEHARNESS_HEADROOM_URL?.trim();
  if (fromEnv && OFF_VALUES.test(fromEnv)) return null;
  const base = (fromEnv || declared?.trim() || "").replace(/\/+$/, "");
  return base ? `${base}/stats` : null;
}

/** O `vps.headroomUrl` que o alvo declarou no settings.yaml (relido por mtime), ou undefined. Nunca lança. */
export function declaredHeadroomUrl(): string | undefined {
  try {
    return vpsOf(loadRunnerConfig()).headroomUrl;
  } catch {
    return undefined;
  }
}

/** A URL do `/stats` desta instalação: env > settings > nenhuma. É a que o mostrador e o governador usam. */
export function meterStatsUrl(env: Record<string, string | undefined> = process.env): string | null {
  return headroomStatsUrl(env, declaredHeadroomUrl());
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
