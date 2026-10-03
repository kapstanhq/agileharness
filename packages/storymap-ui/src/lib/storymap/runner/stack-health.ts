// Pure, dependency-injected stack-health probe.
//
// Generalises the `service_health` MCP tool (mcp/dev-tools.ts): `systemctl
// is-active <unit>` + a node `fetch` GET (NEVER curl — curl trips the
// Cloudflare WAF). Kept side-effect-free: `fetch` and `isActive` are injected.
//
// NÃO há alvo de stack embutido aqui. As URLs que provam «a stack do alvo está de pé» são DECLARADAS por ele em
// `storymap/settings.yaml → target.qa.health` (e `target.qa.seeded` para a sonda «dados semeados») — ver
// target-profile.ts. {@link probeQaHealth} as sonda; sem declaração responde dizendo o que declarar, nunca supõe
// uma porta. ⚠️ A sonda roda no namespace de rede do SERVIÇO: uma stack que o agente sobe dentro da jaula do run
// não é visível dali (use as mesmas URLs no loop de prontidão da própria chamada de Bash).
//
// Contract: NEVER throws. Every failure (systemd down, http error, rejected
// fetch, seeded endpoint missing) resolves to a StackHealth with healthy:false
// and a short `detail`. Zero real IO lives in this module.

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

/** O que {@link probeQaHealth} devolve. */
export interface QaHealth {
  /** o alvo declarou ao menos uma sonda (`target.qa.health` ou `target.qa.seeded`)? */
  declared: boolean;
  /** cada sonda de `health`, pelo NOME declarado. */
  components: { name: string; ok: boolean }[];
  /** a sonda «seedado» respondeu 2xx (true quando o alvo não declarou nenhuma). */
  seeded: boolean;
  /** declared && todas as sondas ok. */
  healthy: boolean;
  /** por que não está saudável: só os componentes que FALHARAM, ou a instrução do que declarar. */
  detail?: string;
}

/**
 * Sonda a stack que o alvo declarou (`target.qa.health` + `target.qa.seeded`, já validadas como loopback com porta
 * pelo coerce). As URLs são buscadas em paralelo; só as que falharam entram no `detail`. NUNCA lança. Sem sonda
 * declarada devolve `declared:false` com a instrução — não há porta «convencional» a tentar.
 */
export async function probeQaHealth(
  qa: { health?: readonly { name: string; url: string }[]; seeded?: { url: string } },
  deps: Pick<StackHealthDeps, "fetch">,
): Promise<QaHealth> {
  const health = qa.health ?? [];
  if (!health.length && !qa.seeded) {
    return {
      declared: false,
      components: [],
      seeded: true,
      healthy: false,
      detail: "o alvo não declarou sondas de saúde — declare target.qa.health em storymap/settings.yaml (name + url de loopback com porta)",
    };
  }
  const [components, seeded] = await Promise.all([
    Promise.all(health.map(async (h) => ({ name: h.name, ok: await probeGet(h.url, deps.fetch) }))),
    qa.seeded ? probeGet(qa.seeded.url, deps.fetch) : Promise.resolve(true),
  ]);
  const failed = [...components.filter((c) => !c.ok).map((c) => `"${c.name}" não respondeu`), ...(seeded ? [] : ["sonda de dados semeados (seeded) falhou"])];
  const healthy = failed.length === 0;
  return { declared: true, components, seeded, healthy, ...(healthy ? {} : { detail: failed.join("; ") }) };
}
