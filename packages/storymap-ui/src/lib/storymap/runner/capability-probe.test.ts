import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DETALHE_FORA_DA_JAULA,
  PROBE_TTL_FAIL_MS,
  PROBE_TTL_OK_MS,
  describeUnavailable,
  providerIncompatibleWithContainment,
  isVerdictFresh,
  probeCacheKey,
  readProbeCache,
  resolveCapability,
  selectActive,
  ttlFromEnv,
  verdictFrom,
  writeProbeCache,
  type ProbeExecutor,
  type ProbeVerdict,
} from "./capability-probe";
import type { CapabilityProvider } from "@/lib/storymap/toolkit";

// The behaviours under test are the ones whose absence produced the incident: a probe verdict must be
// EARNED (a handshake is not a pass), a failure must expire fast enough that fixing the host works
// without a restart, and no error path may ever be able to stall a spawn.

const primary: CapabilityProvider = { id: "browser", capability: "browser", probe: "primary-cmd", mcp: "a.json" };
const fallback: CapabilityProvider = { id: "browser-script", capability: "browser", probe: "fallback-cmd" };

const ok = { code: 0, signal: null, stderr: "", timedOut: false };
const fail = { code: 1, signal: null, stderr: "boom\nCould not find Chrome", timedOut: false };

/** An executor scripted per command, recording call order so "did we stop early?" is assertable. */
function scriptedExec(byCommand: Record<string, typeof ok>, calls: string[] = []): { exec: ProbeExecutor; calls: string[] } {
  const exec: ProbeExecutor = async (command) => {
    calls.push(command);
    return byCommand[command] ?? fail;
  };
  return { exec, calls };
}

/** Os diretórios temporários criados aqui — para que o `afterAll` os APAGUE. Sem isto cada teste deixava
 *  um `/tmp/cap-probe-XXXXXX` para trás; em 2026-08-05 havia 10.359 deles só deste prefixo. */
const tmpDirs: string[] = [];

async function tmpCache(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-probe-"));
  tmpDirs.push(dir);
  return path.join(dir, "capabilities.json");
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

describe("verdictFrom — what counts as proof", () => {
  it("only a clean exit 0 is availability", () => {
    expect(verdictFrom(primary, ok, 1000, 5).ok).toBe(true);
    expect(verdictFrom(primary, fail, 1000, 5).ok).toBe(false);
  });

  it("a TIMEOUT is a failure, never a pass (a hung probe proves nothing)", () => {
    const v = verdictFrom(primary, { code: 0, signal: null, stderr: "", timedOut: true }, 1000, 90_000);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("timeout");
  });

  it("carries the stderr tail so the operator learns WHAT to install", () => {
    expect(verdictFrom(primary, fail, 1000, 5).detail).toContain("Could not find Chrome");
  });
});

describe("isVerdictFresh — TTL asymmetry", () => {
  it("trusts a success for the long TTL", () => {
    expect(isVerdictFresh({ ok: true, at: 0 }, PROBE_TTL_OK_MS - 1)).toBe(true);
    expect(isVerdictFresh({ ok: true, at: 0 }, PROBE_TTL_OK_MS + 1)).toBe(false);
  });

  it("expires a FAILURE much sooner — the operator's fix must land without a restart", () => {
    expect(isVerdictFresh({ ok: false, at: 0 }, PROBE_TTL_FAIL_MS - 1)).toBe(true);
    expect(isVerdictFresh({ ok: false, at: 0 }, PROBE_TTL_FAIL_MS + 1)).toBe(false);
    expect(PROBE_TTL_FAIL_MS).toBeLessThan(PROBE_TTL_OK_MS);
  });

  it("never trusts a verdict from the FUTURE (clock skew / a restored state dir)", () => {
    expect(isVerdictFresh({ ok: true, at: 10_000 }, 0)).toBe(false);
  });
});

describe("selectActive", () => {
  it("picks the first OK provider in chain order", () => {
    const verdicts: ProbeVerdict[] = [
      { id: "browser", capability: "browser", ok: false, detail: "x", at: 0, durationMs: 1 },
      { id: "browser-script", capability: "browser", ok: true, detail: "ok", at: 0, durationMs: 1 },
    ];
    expect(selectActive([primary, fallback], verdicts)?.id).toBe("browser-script");
  });

  it("a provider with NO verdict is not selected (unknown is not working)", () => {
    expect(selectActive([primary, fallback], [])).toBeNull();
  });
});

describe("probeCacheKey", () => {
  it("changes when the PROBE COMMAND changes — editing a probe must invalidate its verdict", () => {
    expect(probeCacheKey("h", "browser", "cmd-a")).not.toBe(probeCacheKey("h", "browser", "cmd-b"));
  });

  it("changes with the HOST — one state dir must never answer for another machine", () => {
    expect(probeCacheKey("host-a", "browser", "cmd")).not.toBe(probeCacheKey("host-b", "browser", "cmd"));
  });
});

describe("resolveCapability", () => {
  const opts = (over: Record<string, unknown> = {}) => ({ repoRoot: "/repo", hostname: "h", now: () => 1_000, ...over });

  it("stops at the primary when it proves out (a working primary never pays for its fallbacks)", async () => {
    const { exec, calls } = scriptedExec({ "primary-cmd": ok });
    const r = await resolveCapability("browser", "browser", [primary, fallback], { ...opts({ cacheFile: await tmpCache() }), exec });
    expect(r.active?.id).toBe("browser");
    expect(calls).toEqual(["primary-cmd"]);
  });

  it("DEGRADES to the fallback when the primary fails — the incident's shape, now survivable", async () => {
    const { exec, calls } = scriptedExec({ "primary-cmd": fail, "fallback-cmd": ok });
    const r = await resolveCapability("browser", "browser", [primary, fallback], { ...opts({ cacheFile: await tmpCache() }), exec });
    expect(r.active?.id).toBe("browser-script");
    expect(calls).toEqual(["primary-cmd", "fallback-cmd"]);
  });

  it("returns active=null when the WHOLE chain fails (the only thing that may block a spawn)", async () => {
    const { exec } = scriptedExec({});
    const r = await resolveCapability("browser", "browser", [primary, fallback], { ...opts({ cacheFile: await tmpCache() }), exec });
    expect(r.active).toBeNull();
    expect(r.verdicts).toHaveLength(2);
  });

  it("skips a provider with NO probe — unprovable is not the same as working", async () => {
    const unprovable: CapabilityProvider = { id: "hopeful", capability: "browser", mcp: "z.json" };
    const { exec, calls } = scriptedExec({ "fallback-cmd": ok });
    const r = await resolveCapability("browser", "browser", [unprovable, fallback], { ...opts({ cacheFile: await tmpCache() }), exec });
    expect(r.active?.id).toBe("browser-script");
    expect(calls).toEqual(["fallback-cmd"]);
  });

  it("reuses a FRESH cached verdict instead of re-probing (the hot dispatch path pays ~0)", async () => {
    const cacheFile = await tmpCache();
    const key = probeCacheKey("h", "browser", "primary-cmd");
    await writeProbeCache({ [key]: { id: "browser", capability: "browser", ok: true, detail: "ok", at: 900, durationMs: 3 } }, cacheFile);
    const { exec, calls } = scriptedExec({ "primary-cmd": ok });
    const r = await resolveCapability("browser", "browser", [primary], { ...opts({ cacheFile }), exec });
    expect(calls).toEqual([]); // no execution at all
    expect(r.active?.id).toBe("browser");
    expect(r.verdicts[0].cached).toBe(true);
  });

  it("RE-PROBES a stale failure, so a host fixed 6 minutes ago is picked up", async () => {
    const cacheFile = await tmpCache();
    const key = probeCacheKey("h", "browser", "primary-cmd");
    await writeProbeCache({ [key]: { id: "browser", capability: "browser", ok: false, detail: "sem chrome", at: 0, durationMs: 3 } }, cacheFile);
    const { exec, calls } = scriptedExec({ "primary-cmd": ok });
    const r = await resolveCapability("browser", "browser", [primary], { ...opts({ cacheFile, now: () => PROBE_TTL_FAIL_MS + 1 }), exec });
    expect(calls).toEqual(["primary-cmd"]);
    expect(r.active?.id).toBe("browser");
  });

  it("persists fresh verdicts so the NEXT dispatch reads them", async () => {
    const cacheFile = await tmpCache();
    const { exec } = scriptedExec({ "primary-cmd": ok });
    await resolveCapability("browser", "browser", [primary], { ...opts({ cacheFile }), exec });
    const persisted = await readProbeCache(cacheFile);
    expect(persisted[probeCacheKey("h", "browser", "primary-cmd")]?.ok).toBe(true);
  });

  it("`fresh: true` ignores the cache AND does not write it back (an operator-forced re-test)", async () => {
    const cacheFile = await tmpCache();
    const key = probeCacheKey("h", "browser", "primary-cmd");
    await writeProbeCache({ [key]: { id: "browser", capability: "browser", ok: true, detail: "ok", at: 900, durationMs: 3 } }, cacheFile);
    const { exec, calls } = scriptedExec({ "primary-cmd": fail });
    const r = await resolveCapability("browser", "browser", [primary], { ...opts({ cacheFile, fresh: true }), exec });
    expect(calls).toEqual(["primary-cmd"]);
    expect(r.active).toBeNull();
    expect((await readProbeCache(cacheFile))[key]?.ok).toBe(true); // untouched
  });
});

describe("readProbeCache — corruption tolerance", () => {
  it("an unreadable/absent file yields {} (probe everything — fail-open)", async () => {
    expect(await readProbeCache(path.join(tmpdir(), "does-not-exist-cap.json"))).toEqual({});
  });

  it("one corrupt ENTRY never discards the healthy ones", async () => {
    const file = await tmpCache();
    await writeFile(
      file,
      JSON.stringify({
        good: { id: "browser", capability: "browser", ok: true, detail: "ok", at: 1, durationMs: 2 },
        bad: { id: 42 },
      }),
      "utf8",
    );
    const cache = await readProbeCache(file);
    expect(Object.keys(cache)).toEqual(["good"]);
  });

  it("a totally malformed file yields {} rather than throwing into the dispatch path", async () => {
    const file = await tmpCache();
    await writeFile(file, "{{{not json", "utf8");
    expect(await readProbeCache(file)).toEqual({});
  });

  it("valid JSON that is NOT an object (array/scalar) yields {} — never throws walking entries", async () => {
    for (const body of ["[1,2,3]", '"texto"', "42", "null"]) {
      const file = await tmpCache();
      await writeFile(file, body, "utf8");
      expect(await readProbeCache(file)).toEqual({});
    }
  });
});

describe("writeProbeCache", () => {
  it("writes atomically and leaves no temp file behind", async () => {
    const file = await tmpCache();
    await writeProbeCache({ k: { id: "a", capability: "browser", ok: true, detail: "ok", at: 1, durationMs: 1 } }, file);
    expect(JSON.parse(await readFile(file, "utf8")).k.ok).toBe(true);
  });
});

describe("describeUnavailable", () => {
  it("names every provider tried and WHY each failed — a diagnosis, not a label", () => {
    const msg = describeUnavailable("browser", [
      { id: "browser", capability: "browser", ok: false, detail: "exit 1 (Could not find Chrome)", at: 0, durationMs: 1 },
      { id: "browser-script", capability: "browser", ok: false, detail: "exit 1 (playwright ausente)", at: 0, durationMs: 1 },
    ]);
    expect(msg).toContain("browser: exit 1 (Could not find Chrome)");
    expect(msg).toContain("browser-script: exit 1 (playwright ausente)");
  });
});

describe("ttlFromEnv — o TTL do probe é operável sem tocar no código", () => {
  // Existe porque a troca é HOST-específica: o probe do provedor primário leva ~26s para falhar neste
  // host, e um TTL de falha curto cobra isso de cada dispatch de QA por um provedor que o operador já
  // sabe que não roda ali. Subir o TTL troca latência-de-detecção-do-conserto por latência-de-dispatch.
  it("usa o override quando ele é um número positivo", () => {
    expect(ttlFromEnv("X", 1000, { X: "60000" })).toBe(60_000);
  });

  it("ignora valores que NÃO são configuração (ausente, vazio, zero, negativo, lixo)", () => {
    for (const v of [undefined, "", "0", "-5", "abc"]) {
      expect(ttlFromEnv("X", 1000, v === undefined ? {} : { X: v })).toBe(1000);
    }
  });

  it("trunca fracionários (ms inteiros)", () => {
    expect(ttlFromEnv("X", 1000, { X: "1500.9" })).toBe(1500);
  });
});

// ── TOPOLOGIA: o provedor que trabalha FORA da jaula do run ───────────────────────────────────────────
//
// O defeito que estes testes trancam foi MEDIDO, não imaginado. O provedor `browser` (chrome-devtools MCP)
// tem seu servidor como filho do processo do CLI; a contenção do SO embrulha as chamadas Bash, não o CLI.
// Resultado medido: npx, chrome-devtools-mcp e toda a árvore do Chrome em net:[4026531840] — o netns do
// pid 1 —, e navegar para um servidor dentro de `bwrap --unshare-net` devolve net::ERR_CONNECTION_REFUSED
// enquanto o MESMO servidor no host responde. Sob contenção esse provedor não enxerga as telas que o run
// acabou de construir, e o probe dele passa verde porque navega para uma URL que não depende de rede.
//
// Nenhum probe melhor consertaria isso — a alcançabilidade não é propriedade do HOST, é da CHAMADA. Por
// isso a recusa vem de uma DECLARAÇÃO no board e acontece ANTES de sondar.
describe("contenção: um provedor fora da jaula perde a cadeia sem gastar probe", () => {
  const foraDaJaula: CapabilityProvider = { ...primary, outsideRunSandbox: true };

  it("PAR DISCRIMINANTE — contido escolhe o fallback; NÃO-contido escolhe o primário", async () => {
    // O par é a prova. Um teste que só verificasse "contido → fallback" passaria idêntico se o filtro não
    // existisse e o primário tivesse falhado por outro motivo. É preciso que o MESMO cenário, mudando
    // APENAS o `contained`, produza o outro resultado — só assim o `contained` é o que está sendo medido.
    const roteiro = { "primary-cmd": ok, "fallback-cmd": ok };

    const s1 = scriptedExec(roteiro);
    const contido = await resolveCapability("browser", "browser", [foraDaJaula, fallback], {
      repoRoot: "/repo", exec: s1.exec, now: () => 1000, cacheFile: await tmpCache(), contained: true,
    });
    expect(contido.active?.id).toBe("browser-script");
    expect(s1.calls).not.toContain("primary-cmd"); // recusado ANTES de sondar: nem o custo do probe se paga

    const s2 = scriptedExec(roteiro);
    const solto = await resolveCapability("browser", "browser", [foraDaJaula, fallback], {
      repoRoot: "/repo", exec: s2.exec, now: () => 1000, cacheFile: await tmpCache(), contained: false,
    });
    expect(solto.active?.id).toBe("browser"); // o primário volta a ganhar, e o probe dele roda
    expect(s2.calls).toContain("primary-cmd");
  });

  it("a recusa NÃO vai para o cache — ela não é uma medição deste host", async () => {
    // A chave do cache é hostname+id+probe: a postura não entra nela. Se a recusa fosse gravada, um run
    // NÃO-contido depois receberia a recusa de um run contido de antes, e o primário morreria para sempre
    // por um motivo que não valia mais. Este é o modo de falha que o `continue` sem escrita evita.
    const cacheFile = await tmpCache();
    const { exec } = scriptedExec({ "fallback-cmd": ok });
    await resolveCapability("browser", "browser", [foraDaJaula, fallback], {
      repoRoot: "/repo", exec, now: () => 1000, cacheFile, contained: true,
    });
    const cache = await readProbeCache(cacheFile);
    const chaves = Object.keys(cache);
    expect(chaves.some((k) => k.includes(":browser:"))).toBe(false); // nada gravado para o recusado
    expect(chaves.some((k) => k.includes(":browser-script:"))).toBe(true); // o que FOI medido, sim
  });

  it("o veredito sintético fica visível — o operador vê o primário perder sem probe nenhum", async () => {
    const r = await resolveCapability("browser", "browser", [foraDaJaula, fallback], {
      repoRoot: "/repo", exec: scriptedExec({ "fallback-cmd": ok }).exec, now: () => 1000,
      cacheFile: await tmpCache(), contained: true,
    });
    const recusado = r.verdicts.find((v) => v.id === "browser");
    expect(recusado?.ok).toBe(false);
    expect(recusado?.detail).toBe(DETALHE_FORA_DA_JAULA);
    // E a mensagem ao operador diz o MOTIVO, em vez do "nenhum provedor com probe declarado" que sairia
    // se o provedor tivesse sido simplesmente omitido da lista.
    expect(describeUnavailable("browser", r.verdicts)).toContain("fora da jaula do run");
  });

  it("uma cadeia INTEIRA fora da jaula fica sem provedor ativo, e diz por quê", async () => {
    // Não é um caso teórico: é o que acontece com um board cujo único provedor de uma capacidade roda no
    // host. A resposta honesta é bloquear ANTES do spawn — que é a razão de o contrato existir — e não
    // deixar o run descobrir gastando turnos.
    const r = await resolveCapability("browser", "browser", [foraDaJaula], {
      repoRoot: "/repo", exec: scriptedExec({}).exec, now: () => 1000, cacheFile: await tmpCache(), contained: true,
    });
    expect(r.active).toBeNull();
    expect(describeUnavailable("browser", r.verdicts)).toContain("fora da jaula do run");
  });

  it("sem a declaração, contenção não muda NADA (aditivo: board legado resolve igual)", async () => {
    const { exec, calls } = scriptedExec({ "primary-cmd": ok });
    const r = await resolveCapability("browser", "browser", [primary, fallback], {
      repoRoot: "/repo", exec, now: () => 1000, cacheFile: await tmpCache(), contained: true,
    });
    expect(r.active?.id).toBe("browser");
    expect(calls).toEqual(["primary-cmd"]);
  });

  it("o predicado é PURO e só liga com os DOIS lados verdadeiros", () => {
    expect(providerIncompatibleWithContainment({ outsideRunSandbox: true }, true)).toBe(true);
    expect(providerIncompatibleWithContainment({ outsideRunSandbox: true }, false)).toBe(false);
    expect(providerIncompatibleWithContainment({ outsideRunSandbox: false }, true)).toBe(false);
    expect(providerIncompatibleWithContainment({}, true)).toBe(false);
  });
});
