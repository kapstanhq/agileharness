// Headroom proxy — o roteamento do tráfego Anthropic de TODO filho Claude por um proxy local de
// compressão de contexto (github.com/chopratejas/headroom), injetando `ANTHROPIC_BASE_URL` no env
// do spawn.
//
// ── Cobertura: LIGADO POR DEFAULT, opt-out declarativo ────────────────────────────────────────
// Até 2026-07-28 a resolução era opt-in por board (`board.yaml headroom.enabled`), e só o board
// `storymap` a tinha — todo o resto do pipeline (acme/orbit/nimbus…) e TODA superfície sem
// BoardConfig em escopo (copiloto/tick, peer-review, juiz de conflito, agente de deploy) falava
// direto com a API. A cobertura medida era ZERO: o `/stats` do proxy acusava `api_requests: 0`.
// Hoje o default é LIGADO (o proxy é infra do host, não um opcional por board) e o desligamento é
// explícito, em duas portas:
//   1. ENV `STORYMAP_HEADROOM_URL` — vence tudo. Uma URL roteia para ela; `off/0/false/none/
//      disabled` desliga (kill switch de operação, sem deploy).
//   2. `board.yaml` `headroom: { enabled: true, proxyUrl: … }` — a declaração por board.
// Sem nenhuma das duas → tráfego DIRETO (`null`).
//
// ── Por que o default deixou de ser uma URL (auditoria de extração, 2026-08-19) ────────────────
// Até aqui, "sem nenhuma das duas" caía num endereço embutido — `127.0.0.1:8787`, a porta do sidecar
// da máquina onde esta ferramenta nasceu, que NÃO viaja com ela. Na máquina de quem instala, esse
// endereço ou não responde (e o fail-open cobre, sem dano) ou responde por ser OUTRA COISA — e aí
// todo o tráfego de LLM dos agentes passa a atravessar um serviço de terceiro, em silêncio, porque a
// sonda considera VIVO qualquer resposta que não seja erro de rede. Um endereço de loopback não é
// identidade: 8787 é uma porta comum.
// Hoje o endereço embutido é SUGESTÃO (documentada no `.env.example`), não caminho tomado. Quem tem o
// sidecar declara — por env, para cobrir também as superfícies sem board em escopo (copiloto/tick,
// peer-review, juiz de conflito, agente de deploy), ou por board.
//
// A camada de SHELL é irmã desta e vive fora do git: `/etc/profile.d/headroom.sh` exporta a mesma
// variável para todo shell de login (tmux, ttyd, ssh) — é o que cobre os TERMINAIS interativos,
// que nenhum código daqui spawna. As duas usam a mesma régua fail-open.
//
// ── Fail-open é contrato ──────────────────────────────────────────────────────────────────────
// Antes de injetar, sonda o proxy. Se ele estiver fora do ar, NÃO injeta e o filho fala direto com
// a API. Um sidecar quebrado nunca pode derrubar um run nem um terminal. A sonda é memoizada por
// {@link PROBE_CACHE_TTL_MS} — uma rajada de spawns paga UMA ida à rede, não N.

import type { BoardConfig } from "../types";
import { sanitizeSpawnEnv } from "./spawn-env";

export interface HeadroomConfig {
  /** opt-out por board: `false` desliga. Ausente = ligado (default do host). */
  enabled: boolean;
  /** sidecar URL — tipicamente uma porta de loopback gerida por systemd */
  proxyUrl: string;
}

export const HEADROOM_PROBE_TIMEOUT_MS = 250;
/** A porta CONVENCIONAL do sidecar — sugestão para quem for declarar, nunca um alvo assumido.
 *  Ela é o valor que o `.env.example` mostra; nenhum caminho de decisão a escolhe sozinho. */
export const HEADROOM_SUGGESTED_URL = "http://127.0.0.1:8787";
/** Janela de memoização da sonda — curta o bastante para um proxy que morre ser notado no minuto. */
export const PROBE_CACHE_TTL_MS = 30_000;

/** Valores de `STORYMAP_HEADROOM_URL` que significam "desligado". */
const OFF_VALUES = /^(0|off|false|none|disabled)$/i;

/**
 * Best-effort liveness probe — `fetch` com AbortController para que um sidecar pendurado não
 * segure o spawn além de `timeoutMs`. QUALQUER resposta não-de-rede (inclusive 404) conta como
 * vivo; só erro de rede ou timeout conta como morto.
 */
export async function probeHeadroom(
  url: string,
  timeoutMs: number = HEADROOM_PROBE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchImpl(url, { method: "GET", signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a URL do proxy para ESTE spawn, ou null quando o tráfego deve ir direto. Pura (sem
 * fetch) — a sonda é um passo separado, que o chamador só roda com um retorno não-nulo.
 *
 * Precedência: ENV (inclui o kill switch) → board (`enabled:false` desliga; `proxyUrl` fixa o
 * alvo) → NADA (tráfego direto). Ver o cabeçalho: um endereço de loopback embutido não identifica o
 * serviço que atende nele.
 */
export function resolveHeadroomUrl(
  boardConfig: Pick<BoardConfig, "headroom"> | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const envUrl = env.STORYMAP_HEADROOM_URL?.trim();
  if (envUrl) return OFF_VALUES.test(envUrl) ? null : envUrl;

  const cfg = boardConfig?.headroom;
  if (cfg?.enabled === false) return null; // opt-out explícito do board
  // `proxyUrl` declarado no board vence; sem declaração NENHUMA, o tráfego vai direto.
  return cfg?.proxyUrl?.trim() || null;
}

// ── Sonda memoizada ────────────────────────────────────────────────────────────────────────────
// Estado de módulo: chave = URL. Uma rajada de spawns (o scheduler admite vários runs no mesmo
// tick) compartilha o resultado dentro da janela, e uma sonda EM VOO é compartilhada também
// (guardamos a Promise, não só o booleano) — sem thundering herd contra o sidecar.
const probeCache = new Map<string, { at: number; result: Promise<boolean> }>();
/** Espelho SÍNCRONO do último desfecho conhecido por URL — lido por {@link headroomUrlIfKnownAlive}. */
const lastKnown = new Map<string, { at: number; alive: boolean }>();

/** Zera a memoização — para testes e para um "re-sondar agora" operacional. */
export function resetHeadroomProbeCache(): void {
  probeCache.clear();
  lastKnown.clear();
}

export async function probeHeadroomCached(
  url: string,
  deps: { probe?: typeof probeHeadroom; now?: () => number; ttlMs?: number } = {},
): Promise<boolean> {
  const probe = deps.probe ?? probeHeadroom;
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? PROBE_CACHE_TTL_MS;
  const hit = probeCache.get(url);
  const at = now();
  if (hit && at - hit.at < ttl) return hit.result;
  const result = probe(url).catch(() => false); // uma sonda que estoura nunca vira rejeição em cache
  probeCache.set(url, { at, result });
  void result.then((alive) => lastKnown.set(url, { at: now(), alive }));
  return result;
}

/**
 * A URL do proxy quando a ÚLTIMA sonda dentro da janela o viu VIVO — ou null. Existe para o único
 * spawn site SÍNCRONO (`launchDeployAgent`, cuja assinatura devolve o handle na hora e não pode
 * virar async sem arrastar a cadeia de deploy inteira). Sem desfecho recente, devolve null:
 * "não sei" é tratado como "não injeta", que é o lado seguro — o próximo spawn assíncrono aquece
 * o espelho e o seguinte já roteia.
 */
export function headroomUrlIfKnownAlive(
  url: string | null = resolveHeadroomUrl(null, process.env),
  deps: { now?: () => number; ttlMs?: number } = {},
): string | null {
  if (!url) return null;
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? PROBE_CACHE_TTL_MS;
  const hit = lastKnown.get(url);
  if (!hit || now() - hit.at >= ttl) return null;
  return hit.alive ? url : null;
}

export interface HeadroomInjection {
  /** o proxy foi injetado no env? */
  applied: boolean;
  /** a URL resolvida — presente mesmo quando `applied:false` (proxy configurado porém offline) */
  url: string | null;
}

/**
 * Injeta (ou não) `ANTHROPIC_BASE_URL` em `env`, MUTANDO o objeto recebido — a forma que os spawn
 * sites já usam (montam o env, ajustam chaves, spawnam). Devolve o desfecho para quem quiser
 * logar. Nunca lança.
 */
export async function applyHeadroomEnv(
  env: NodeJS.ProcessEnv,
  opts: {
    /** URL já resolvida pelo chamador (que tem o BoardConfig em mãos); default = resolver do ENV */
    url?: string | null;
    probe?: typeof probeHeadroom;
  } = {},
): Promise<HeadroomInjection> {
  const url = opts.url !== undefined ? opts.url : resolveHeadroomUrl(null, process.env);
  if (!url) return { applied: false, url: null };
  const alive = await probeHeadroomCached(url, { probe: opts.probe });
  if (alive) env.ANTHROPIC_BASE_URL = url;
  return { applied: alive, url };
}

/**
 * O ENV DE SPAWN de qualquer filho Claude: {@link sanitizeSpawnEnv} (higiene do env do serviço)
 * ⊕ headroom. É o chokepoint que faz "toda superfície de spawn passa pelo proxy" ser verdade por
 * construção, em vez de N call sites lembrarem de fazê-lo — o modo como a cobertura chegou a zero.
 *
 * Superfícies sem BoardConfig em escopo (copiloto/tick, peer-review, juiz de conflito, agente de
 * deploy) chamam sem `url` e caem no default do host. O engine, que TEM o board, passa a URL já
 * resolvida (`resolveHeadroomUrl(config, env)`) para o opt-out por board valer.
 */
export async function buildAgentSpawnEnv(
  source: NodeJS.ProcessEnv = process.env,
  opts: { url?: string | null; probe?: typeof probeHeadroom } = {},
): Promise<NodeJS.ProcessEnv> {
  const env = sanitizeSpawnEnv(source);
  await applyHeadroomEnv(env, opts);
  return env;
}
