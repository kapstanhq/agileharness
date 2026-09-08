// Pure, dependency-injected stack-health probe (ADR-063).
//
// Generalises the `service_health` MCP tool (mcp/dev-tools.ts): `systemctl
// is-active <unit>` + a node `fetch` GET (NEVER curl — curl trips the
// Cloudflare WAF). Kept side-effect-free so it can be shared by two callers:
//   1. the harness-qa fail-fast pre-boot gate (verify the stack is up before a run),
//   2. a future persistent-stack service (ADR-063 item 1b).
//
// Contract: NEVER throws. Every failure (systemd down, http error, rejected
// fetch, seeded endpoint missing) resolves to a StackHealth with healthy:false
// and a short `detail`. Zero real IO lives in this module — `fetch` and
// `isActive` are injected.

export interface StackHealth {
  /** systemd unit is active (true when no unit is targeted). */
  systemd: boolean;
  /** the stack answered a successful GET on `url`. */
  http: boolean;
  /** the seeded-data probe succeeded (true when no `seededProbeUrl` is set). */
  seeded: boolean;
  /** systemd && http && seeded. */
  healthy: boolean;
  /** short human-readable reason when unhealthy. */
  detail?: string;
}

export interface StackTarget {
  /** systemd unit to check via `isActive`; omit to skip the systemd gate. */
  unit?: string;
  /** root URL to GET for the http liveness check. */
  url: string;
  /** optional endpoint that only answers OK once the stack is seeded. */
  seededProbeUrl?: string;
}

export interface StackHealthDeps {
  /** node global fetch (localhost direct — never curl / never the WAF). */
  fetch: typeof fetch;
  /** `systemctl is-active <unit>` → true/false, injected (never spawns here). */
  isActive: (unit: string) => Promise<boolean>;
}

/**
 * The persistent QA stack's StackTarget (ADR-063 Fase 1b) — MIRRORS
 * `scripts/ops/qa-stack/contract.json` (the stable ports/seed/token contract;
 * keep both in sync). `qa-emulator.service` is health-GATED at start
 * (wait-ready.mjs blocks "started" until hub+auth+firestore+seed), so for the
 * harness-qa fail-fast pre-boot gate `probeStackHealth(QA_STACK_TARGET, …)` being
 * healthy means: CONNECT to the running stack — do NOT cold-boot one.
 *  - url: the emulator hub's /emulators endpoint (200 + suite listing);
 *  - seededProbeUrl: the minimal preset's deterministic profile doc —
 *    Firestore REST answers 200 when seeded, 404 when not (a bare collection
 *    GET answers 200 even when EMPTY, useless as a seed signal).
 */
export const QA_STACK_TARGET: StackTarget = {
  unit: "qa-emulator.service",
  url: "http://127.0.0.1:4400/emulators",
  // O id do projeto e o doc-sentinela são do ALVO, não da ferramenta: um alvo que mantém um stack
  // persistente declara a sua sonda por env (AGILEHARNESS_QA_SEED_PROBE_URL). Sem declaração a sonda
  // aponta para um projeto que não existe e responde "não seedado" — e o pré-boot do harness-qa sobe
  // o próprio stack, que é o caminho seguro. (Antes o id de um projeto real estava aqui, literal.)
  seededProbeUrl:
    process.env.AGILEHARNESS_QA_SEED_PROBE_URL ??
    "http://127.0.0.1:8080/v1/projects/demo-project/databases/(default)/documents/profiles/seed-active-001",
};

const HTTP_TIMEOUT_MS = 5_000;

/**
 * Best-effort GET — resolves true only on a successful (`res.ok`) response.
 * Any network error, timeout or non-ok status resolves false. Never throws.
 */
async function probeGet(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: ctrl.signal, redirect: "manual" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a stack target's health. Pure aside from the injected `fetch` /
 * `isActive`. Guarantees a resolved StackHealth for every input — no throw.
 */
export async function probeStackHealth(
  target: StackTarget,
  deps: StackHealthDeps,
): Promise<StackHealth> {
  // systemd: no unit → nothing to gate on. A rejected isActive counts as down.
  let systemd: boolean;
  if (!target.unit) {
    systemd = true;
  } else {
    try {
      systemd = await deps.isActive(target.unit);
    } catch {
      systemd = false;
    }
  }

  const http = await probeGet(target.url, deps.fetch);
  const seeded = target.seededProbeUrl ? await probeGet(target.seededProbeUrl, deps.fetch) : true;
  const healthy = systemd && http && seeded;

  const detail = healthy
    ? undefined
    : [
        !systemd && (target.unit ? `systemd unit "${target.unit}" not active` : "systemd down"),
        !http && `http GET ${target.url} failed`,
        !seeded && `seeded probe ${target.seededProbeUrl} failed`,
      ]
        .filter(Boolean)
        .join("; ");

  return { systemd, http, seeded, healthy, ...(detail ? { detail } : {}) };
}
