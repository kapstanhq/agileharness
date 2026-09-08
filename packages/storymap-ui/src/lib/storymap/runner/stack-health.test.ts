import { describe, expect, it } from "vitest";
import { probeStackHealth, QA_STACK_TARGET, type StackHealthDeps } from "./stack-health";
import { createRequire } from "node:module";
import path from "node:path";
import { soDoUmbrella } from "@/lib/storymap/oss-tree";

/** fetch fake that returns a Response with the given status. */
function fetchOk(status = 200): typeof fetch {
  return (async () => new Response("ok", { status })) as unknown as typeof fetch;
}
/** fetch fake that rejects (network down / connection refused). */
function fetchReject(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}
function deps(over: Partial<StackHealthDeps> = {}): StackHealthDeps {
  return {
    fetch: fetchOk(),
    isActive: async () => true,
    ...over,
  };
}

describe("probeStackHealth", () => {
  it("is healthy when systemd active, http ok and no seeded probe", async () => {
    const r = await probeStackHealth({ unit: "storymap", url: "http://127.0.0.1:3008/" }, deps());
    expect(r).toEqual({ systemd: true, http: true, seeded: true, healthy: true });
  });

  it("treats a missing unit as systemd:true (no systemctl call)", async () => {
    let called = false;
    const r = await probeStackHealth(
      { url: "http://127.0.0.1:3008/" },
      deps({ isActive: async () => { called = true; return false; } }),
    );
    expect(called).toBe(false);
    expect(r.systemd).toBe(true);
    expect(r.healthy).toBe(true);
  });

  it("is unhealthy when systemd is down", async () => {
    const r = await probeStackHealth(
      { unit: "storymap", url: "http://127.0.0.1:3008/" },
      deps({ isActive: async () => false }),
    );
    expect(r.systemd).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.detail).toBeTruthy();
  });

  it("is unhealthy when http GET fails (non-ok status)", async () => {
    const r = await probeStackHealth(
      { unit: "storymap", url: "http://127.0.0.1:3008/" },
      deps({ fetch: fetchOk(503) }),
    );
    expect(r.http).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.detail).toBeTruthy();
  });

  it("returns healthy:false (never throws) when the http fetch is REJECTED", async () => {
    const r = await probeStackHealth(
      { unit: "storymap", url: "http://127.0.0.1:3008/" },
      deps({ fetch: fetchReject() }),
    );
    expect(r.http).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.detail).toBeTruthy();
  });

  it("seeded:true only after a successful seeded probe GET", async () => {
    const r = await probeStackHealth(
      { unit: "storymap", url: "http://127.0.0.1:3008/", seededProbeUrl: "http://127.0.0.1:3008/api/seeded" },
      deps(),
    );
    expect(r.seeded).toBe(true);
    expect(r.healthy).toBe(true);
  });

  it("is unhealthy when the seeded probe is missing (fetch rejected)", async () => {
    // http root is ok, but the seeded endpoint is down.
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response("ok", { status: 200 }); // root
      throw new Error("ECONNREFUSED"); // seeded probe
    }) as unknown as typeof fetch;
    const r = await probeStackHealth(
      { unit: "storymap", url: "http://127.0.0.1:3008/", seededProbeUrl: "http://127.0.0.1:3008/api/seeded" },
      deps({ fetch: fetchImpl }),
    );
    expect(r.http).toBe(true);
    expect(r.seeded).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.detail).toBeTruthy();
  });

  it("is unhealthy when the seeded probe returns a non-ok status", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response("x", { status: n === 1 ? 200 : 500 });
    }) as unknown as typeof fetch;
    const r = await probeStackHealth(
      { unit: "storymap", url: "http://127.0.0.1:3008/", seededProbeUrl: "http://127.0.0.1:3008/api/seeded" },
      deps({ fetch: fetchImpl }),
    );
    expect(r.seeded).toBe(false);
    expect(r.healthy).toBe(false);
  });

  it("never throws even when isActive rejects", async () => {
    const r = await probeStackHealth(
      { unit: "storymap", url: "http://127.0.0.1:3008/" },
      deps({ isActive: async () => { throw new Error("systemctl blew up"); } }),
    );
    expect(r.systemd).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.detail).toBeTruthy();
  });
});

describe("QA_STACK_TARGET (ADR-063 Fase 1b contract mirror)", () => {
  // `skipIf` NO LUGAR DO `return` ANTECIPADO. O arquivo que este caso lê é infra do DONO e não viaja
  // na extração: na árvore extraída o corpo saía sem asserção nenhuma, e "passou" e "não mediu nada"
  // eram a mesma linha verde — no repositório onde a suíte é o CI de estreia. Com
  // `expect.requireAssertions` a omissão passou a reprovar, que é o instrumento funcionando: ele não
  // sabe distinguir ausência deliberada de ausência esquecida, e a diferença tem de estar escrita.
  it.skipIf(!soDoUmbrella("scripts/ops/qa-stack/contract.json"))(
    "stays in sync with scripts/ops/qa-stack/contract.json (the stable contract)",
    () => {
    // `scripts/ops/**` é operação do ecossistema do dono e a régua o exclui inteiro. Este espelho
    // existe para os DOIS lados não divergirem NESTA casa; no artefato só viaja o lado do motor, e
    // é ele que os casos de parse continuam cobrindo. Ausência no umbrella = regressão ⇒ lança.
    // The preset is a MIRROR of the repo contract — if either side drifts,
    // harness-qa's pre-boot gate probes the wrong stack. Repo root: this file
    // lives at packages/storymap-ui/src/lib/storymap/runner/.
    const req = createRequire(import.meta.url);
    const contract = req(
      path.resolve(__dirname, "../../../../../..", "scripts/ops/qa-stack/contract.json"),
    );
    expect(QA_STACK_TARGET.unit).toBe("qa-emulator.service");
    expect(QA_STACK_TARGET.url).toBe(`http://127.0.0.1:${contract.ports.emulatorHub}/emulators`);
    expect(QA_STACK_TARGET.seededProbeUrl).toBe(
      `http://127.0.0.1:${contract.ports.firestore}/v1/projects/${contract.project}/databases/(default)/documents/profiles/seed-active-001`,
    );
    },
  );

  it("probes healthy against a live-shaped stack (unit active, hub 200, seed doc 200)", async () => {
    const r = await probeStackHealth(QA_STACK_TARGET, deps());
    expect(r.healthy).toBe(true);
  });

  it("reports seeded:false when the seed doc 404s (stack up, unseeded)", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) =>
      new Response("x", { status: String(url).includes("/documents/profiles/") ? 404 : 200 })) as unknown as typeof fetch;
    const r = await probeStackHealth(QA_STACK_TARGET, deps({ fetch: fetchImpl }));
    expect(r.http).toBe(true);
    expect(r.seeded).toBe(false);
    expect(r.healthy).toBe(false);
  });
});
