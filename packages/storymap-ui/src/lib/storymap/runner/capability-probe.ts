// CAPABILITY PROBE — the "prove" half of the capability contract (declare → PROVE → degrade).
//
// WHY THIS EXISTS. The engine used to existence-filter a step's MCP mount FILE and treat "the JSON is on
// disk" as "the capability works". The `chrome-devtools` incident is what that costs: the mount existed,
// the server handshook fine, and EVERY tool call failed for want of a Chrome binary the host never had.
// Two `harness-qa` runs burned 89 turns / US$5.98 / 12min — booting a dev stack and seeding an emulator —
// to discover it, then left the card wedged behind a `blocker` finding that no card-level fix could
// clear. A file existing is not evidence. A probe is.
//
// SHAPE. The decision core is PURE (freshness, selection, messaging) and unit-tested without touching a
// process or the disk; the shell (spawn + cache file) is thin and injectable. Same split as scheduler.ts
// (pure `isVpsOverloaded` + injected readers) and journal.ts (pure decide + `diskJournalStore`).
//
// FAIL-OPEN, DELIBERATELY. Every error path here yields "assume available" (a probe that cannot RUN is
// not evidence of absence). A broken probe layer must never be able to stall a pipeline — the failure it
// guards against is expensive, but stalling every card is worse. The only thing that blocks a spawn is an
// explicit, non-zero probe verdict.
//
// SECURITY. `probe` is a shell command read from board.yaml — the same trust level as the code in this
// repo (board.yaml already decides which skill runs with which permissions). It is a CONSTANT from config:
// no card, run or user data is ever interpolated into it, so there is no injection surface from board
// content. It runs with a hard timeout and is killed by process GROUP so a probe that spawns children
// (`npx` → node → chrome) can never leak them.

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runnerStateDir } from "@/lib/storymap/paths";
import { DEFAULT_PROBE_TIMEOUT_MS } from "@/lib/storymap/types";
import type { CapabilityProvider } from "@/lib/storymap/toolkit";

/** Read a positive-ms env override, else the default. A malformed/absent value is NOT configuration.
 *  Exported for tests — the TTL constants below resolve at module load, so the RULE is what is testable. */
export function ttlFromEnv(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** How long a SUCCESSFUL probe is trusted before re-proving. Long: a host that has Chrome keeps having
 *  Chrome, and the point of the cache is that the hot dispatch path pays ~0. */
export const PROBE_TTL_OK_MS = ttlFromEnv("AGILEHARNESS_PROBE_TTL_OK_MS", 30 * 60_000);
/**
 * How long a FAILED probe is trusted. Deliberately much shorter than the success TTL: the operator's fix
 * (install the binary, plug the mount) must take effect quickly, without a service restart.
 *
 * Overridable because the trade-off is HOST-SPECIFIC, and this host makes it concrete: the chrome-devtools
 * probe takes ~26s to fail (it downloads/starts the server before discovering there is no browser), so a
 * 5-minute TTL charges every QA dispatch up to 26s for a provider the operator may have knowingly given up
 * on. Raising it trades fix-detection latency for dispatch latency — an operator decision, not ours.
 */
export const PROBE_TTL_FAIL_MS = ttlFromEnv("AGILEHARNESS_PROBE_TTL_FAIL_MS", 5 * 60_000);

/** One provider's verdict on one host at one moment. */
export interface ProbeVerdict {
  /** the toolConfig id that was probed. */
  id: string;
  /** the capability it claims to provide. */
  capability: string;
  ok: boolean;
  /** short operator-facing reason (exit code + stderr tail, or `timeout`). */
  detail: string;
  /** epoch ms the probe settled. */
  at: number;
  durationMs: number;
  /** true when the verdict came from cache rather than a fresh execution (telemetry/debug only). */
  cached?: boolean;
}

/** The resolution of ONE required capability against its provider chain. */
export interface CapabilityResolution {
  /** the toolConfig id the step declared as required (the chain's head). */
  tool: string;
  capability: string;
  /** the provider that PROVED itself — null when every provider in the chain failed. */
  active: CapabilityProvider | null;
  /** verdicts gathered, primary-first — the evidence behind `active`. */
  verdicts: ProbeVerdict[];
}

// ── PURE CORE ────────────────────────────────────────────────────────────────────────────────────────

/** Cache key for a provider on a host. The PROBE COMMAND is part of the key on purpose: editing the probe
 *  in board.yaml must invalidate its cached verdict, or a fix would appear not to work. Hostname is in
 *  the key so a state dir that is ever shared/copied between machines cannot answer for the wrong host. */
export function probeCacheKey(hostname: string, id: string, probe: string): string {
  return `${hostname}:${id}:${createHash("sha256").update(probe).digest("hex").slice(0, 16)}`;
}

/** Is a cached verdict still trustworthy? Successes are trusted for {@link PROBE_TTL_OK_MS}, failures for
 *  the much shorter {@link PROBE_TTL_FAIL_MS} (so an operator fix is picked up fast). A verdict from the
 *  FUTURE (clock skew, a restored state dir) is treated as stale — never trusted forward. PURE. */
export function isVerdictFresh(v: Pick<ProbeVerdict, "ok" | "at">, now: number, ttl = { ok: PROBE_TTL_OK_MS, fail: PROBE_TTL_FAIL_MS }): boolean {
  const age = now - v.at;
  if (age < 0) return false;
  return age < (v.ok ? ttl.ok : ttl.fail);
}

/**
 * O detalhe de um provedor recusado por TOPOLOGIA, não por medição. Constante para que a mensagem ao
 * operador seja a mesma em toda parte e para que um teste possa ancorar nela sem copiar prosa.
 */
export const DETALHE_FORA_DA_JAULA =
  "fora da jaula do run — trabalha no netns do host e não alcança o que o run sobe numa chamada Bash (declarado, não sondado)";

/**
 * Este provedor é incompatível com um run CONTIDO? PURA.
 *
 * A pergunta que um probe responde é "isto funciona NESTE HOST?". Alcançabilidade não é propriedade do
 * host — é da CHAMADA, e um probe jamais poderia medi-la, porque ele próprio roda em algum lugar (aqui: o
 * processo do serviço, no host) e só reportaria sobre a TOPOLOGIA DELE. Por isso a fonte é uma DECLARAÇÃO
 * no board, não uma sonda.
 *
 * O caso concreto, medido num único run, no mesmo instante e contra a MESMA URL: o MCP chrome-devtools
 * navegou até um servidor do host com sucesso enquanto um `curl` pela tool Bash devolveu rc=7. O servidor
 * MCP é filho do processo do CLI, e a contenção embrulha as chamadas Bash — não o CLI. (O proxy do ASRT
 * dentro da jaula é EGRESSO por domínio; pôr `127.0.0.1` em `allowedDomains` não abre ingresso nenhum.)
 *
 * A direção do erro é deliberada. Recusar um provedor num run que no fim não era contido custa uma
 * DEGRADAÇÃO para o fallback — que funciona. Aceitá-lo num run que era contido custa o defeito que isto
 * existe para matar: o run varre, não enxerga nada, e o card volta vazio parecendo verde.
 */
export function providerIncompatibleWithContainment(
  p: Pick<CapabilityProvider, "outsideRunSandbox">,
  runWillBeContained: boolean,
): boolean {
  return runWillBeContained && p.outsideRunSandbox === true;
}

/** Pick the ACTIVE provider: the first in chain order whose verdict is `ok`. Providers with no verdict are
 *  skipped (unknown ≠ working). Returns null when none proved out. PURE. */
export function selectActive(providers: readonly CapabilityProvider[], verdicts: readonly ProbeVerdict[]): CapabilityProvider | null {
  const okIds = new Set(verdicts.filter((v) => v.ok).map((v) => v.id));
  return providers.find((p) => okIds.has(p.id)) ?? null;
}

/** The operator-facing explanation of an unavailable capability: what was tried, and what each try said.
 *  Deliberately concrete — "chrome-devtools: exit 1 (Could not find Chrome)" tells the operator what to
 *  install; "browser unavailable" tells them nothing. PURE. */
export function describeUnavailable(capability: string, verdicts: readonly ProbeVerdict[]): string {
  const tried = verdicts.length
    ? verdicts.map((v) => `${v.id}: ${v.detail}`).join(" · ")
    : "nenhum provedor com probe declarado";
  return `capacidade "${capability}" indisponível neste host — provedores testados: ${tried}`;
}

/** Turn a raw probe execution into a verdict. PURE — the shell hands it the facts. Non-zero exit, a signal
 *  kill (timeout) and a spawn error are all `ok: false`; only a clean exit 0 is availability. */
export function verdictFrom(
  provider: CapabilityProvider,
  raw: { code: number | null; signal: string | null; stderr: string; timedOut: boolean },
  at: number,
  durationMs: number,
): ProbeVerdict {
  const tail = raw.stderr.trim().split("\n").slice(-1)[0]?.slice(0, 160) ?? "";
  const detail = raw.timedOut
    ? `timeout após ${durationMs}ms`
    : raw.code === 0
      ? "ok"
      : `exit ${raw.code ?? `sinal ${raw.signal}`}${tail ? ` (${tail})` : ""}`;
  return {
    id: provider.id,
    capability: provider.capability,
    ok: !raw.timedOut && raw.code === 0,
    detail,
    at,
    durationMs,
  };
}

// ── PERSISTED CACHE ──────────────────────────────────────────────────────────────────────────────────

const VerdictSchema = z.object({
  id: z.string(),
  capability: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  at: z.number(),
  durationMs: z.number(),
});
const CacheSchema = z.record(z.string(), VerdictSchema);

export function capabilityCachePath(): string {
  return path.join(runnerStateDir(), "capabilities.json");
}

/** Read the verdict cache. Per-entry safeParse (same discipline as telemetry/journal): one corrupt entry
 *  never discards the rest, and an unreadable file yields `{}` (probe everything — fail-open). */
export async function readProbeCache(file = capabilityCachePath()): Promise<Record<string, ProbeVerdict>> {
  try {
    // ONE read, ONE parse: the whole-file schema is tried first (the common case), and only the already
    // parsed value is re-walked per entry when it fails. The earlier version read and parsed the file a
    // second time on that path — wasted IO on exactly the degraded case that most needs to stay cheap.
    const raw: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    const parsed = CacheSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, ProbeVerdict> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const one = VerdictSchema.safeParse(v);
      if (one.success) out[k] = one.data;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the cache atomically (tmp + rename). Best-effort: a write failure only costs a re-probe. */
export async function writeProbeCache(cache: Record<string, ProbeVerdict>, file = capabilityCachePath()): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await fsp.rename(tmp, file);
  } catch (err) {
    console.error("[capability-probe] cache write falhou (segue sem cache):", err instanceof Error ? err.message : err);
  }
}

// ── SHELL ────────────────────────────────────────────────────────────────────────────────────────────

/** Injectable probe executor (DI, like scheduler's resource readers) so tests never spawn a process. */
export type ProbeExecutor = (
  command: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; signal: string | null; stderr: string; timedOut: boolean }>;

/**
 * Default executor: run the probe through a shell in its own process GROUP, kill the WHOLE group on
 * timeout. The group matters — a probe like `npx chrome-devtools-mcp` spawns node which spawns chrome;
 * killing only the shell would orphan them and slowly poison the very load average the scheduler reads.
 */
export const defaultProbeExecutor: ProbeExecutor = (command, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stderr?.on("data", (d) => {
      // Bounded: a chatty probe must not balloon memory. The tail is what diagnoses, anyway.
      stderr = (stderr + String(d)).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stderr: `spawn falhou: ${err.message}`, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, timedOut });
    });
  });

export interface ResolveOptions {
  repoRoot: string;
  exec?: ProbeExecutor;
  now?: () => number;
  hostname?: string;
  cacheFile?: string;
  /** skip the cache entirely (an operator-forced re-probe). */
  fresh?: boolean;
  /**
   * O run que esta resolução autoriza vai rodar CONTIDO (cada chamada Bash com netns próprio)? Recusa,
   * ANTES de sondar, todo provedor declarado `outsideRunSandbox`. Omitido ⇒ false, que preserva
   * exatamente o comportamento anterior — nenhum board sem a declaração muda de resolução.
   */
  contained?: boolean;
}

/**
 * Resolve ONE required capability: walk its provider chain in order, using a cached verdict when fresh,
 * probing when not, and STOPPING at the first provider that proves out (a working primary never pays for
 * probing its fallbacks). Returns the active provider plus every verdict gathered.
 *
 * Providers with no `probe` are skipped — unprovable is not the same as working. (The board lint refuses
 * a REQUIRED capability whose whole chain is unprovable, so this only skips optional stragglers.)
 */
export async function resolveCapability(
  tool: string,
  capability: string,
  providers: readonly CapabilityProvider[],
  opts: ResolveOptions,
): Promise<CapabilityResolution> {
  const exec = opts.exec ?? defaultProbeExecutor;
  const now = opts.now ?? Date.now;
  const hostname = opts.hostname ?? os.hostname();
  const cacheFile = opts.cacheFile ?? capabilityCachePath();
  const cache = opts.fresh ? {} : await readProbeCache(cacheFile);
  const verdicts: ProbeVerdict[] = [];
  let dirty = false;

  for (const p of providers) {
    // TOPOLOGIA ANTES DE SONDA. Um provedor que trabalha fora da jaula é recusado AQUI, antes de gastar
    // um probe nele — e o veredito sintético NÃO vai para o cache de propósito: o cache guarda o que foi
    // MEDIDO neste host, e esta recusa não é uma medição, é uma consequência da topologia deste run. Se
    // ela entrasse no cache, um run não-contido depois receberia a recusa de um run contido de antes (a
    // chave do cache é hostname+id+probe, e postura não entra nela). Fica no `verdicts` porque o operador
    // precisa VER o primário perdendo a cadeia sem que nenhum probe tenha rodado — e é isso que faz o
    // `describeUnavailable` dizer o motivo certo em vez de "nenhum provedor com probe declarado".
    if (providerIncompatibleWithContainment(p, opts.contained === true)) {
      verdicts.push({ id: p.id, capability: p.capability, ok: false, detail: DETALHE_FORA_DA_JAULA, at: now(), durationMs: 0 });
      console.warn(`[capability-probe] ${p.id} (${capability}): RECUSADO — ${DETALHE_FORA_DA_JAULA}`);
      continue;
    }
    if (!p.probe) continue;
    const key = probeCacheKey(hostname, p.id, p.probe);
    const cached = cache[key];
    if (cached && isVerdictFresh(cached, now())) {
      verdicts.push({ ...cached, cached: true });
      if (cached.ok) break;
      continue;
    }
    const startedAt = now();
    const raw = await exec(p.probe, { cwd: opts.repoRoot, timeoutMs: p.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS });
    const verdict = verdictFrom(p, raw, startedAt, now() - startedAt);
    verdicts.push(verdict);
    cache[key] = { id: verdict.id, capability: verdict.capability, ok: verdict.ok, detail: verdict.detail, at: verdict.at, durationMs: verdict.durationMs };
    dirty = true;
    console.warn(
      `[capability-probe] ${p.id} (${capability}): ${verdict.ok ? "OK" : "INDISPONÍVEL"} — ${verdict.detail} (${verdict.durationMs}ms)`,
    );
    if (verdict.ok) break;
  }

  if (dirty && !opts.fresh) await writeProbeCache(cache, cacheFile);
  return { tool, capability, active: selectActive(providers, verdicts), verdicts };
}

/** Resolve every required capability of a step. Sequential by design: probes are rare (cached) and a
 *  parallel burst of `npx`/browser launches is exactly the load spike the scheduler is trying to avoid. */
export async function resolveCapabilities(
  required: readonly { tool: string; capability: string; providers: CapabilityProvider[] }[],
  opts: ResolveOptions,
): Promise<CapabilityResolution[]> {
  const out: CapabilityResolution[] = [];
  for (const r of required) out.push(await resolveCapability(r.tool, r.capability, r.providers, opts));
  return out;
}
