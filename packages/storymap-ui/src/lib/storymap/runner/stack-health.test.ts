import { describe, expect, it } from "vitest";
import { probeQaHealth, probeStackHealth, type StackHealthDeps } from "./stack-health";

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

// A stack do alvo vem DECLARADA (`target.qa.health`/`seeded`), nunca de uma constante da ferramenta. Os nomes,
// portas e caminhos abaixo são INVENTADOS (uma oficina de bicicletas com um «barramento» fictício).
describe("probeQaHealth — as sondas que o alvo declarou", () => {
  const health = [
    { name: "entrada", url: "http://127.0.0.1:7101/" },
    { name: "estoque", url: "http://127.0.0.1:7102/" },
  ];
  const byUrl = (down: string[]): typeof fetch =>
    (async (url: RequestInfo | URL) => new Response("x", { status: down.some((d) => String(url).includes(d)) ? 503 : 200 })) as unknown as typeof fetch;

  it("sem nenhuma sonda declarada: não supõe porta e diz o que declarar", async () => {
    const r = await probeQaHealth({}, { fetch: fetchOk() });
    expect(r.declared).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.detail).toMatch(/target\.qa\.health/);
    expect(r.detail).toMatch(/settings\.yaml/);
  });

  it("saudável quando todas as URLs declaradas respondem 2xx (e seeded ausente conta como ok)", async () => {
    const r = await probeQaHealth({ health }, { fetch: fetchOk() });
    expect(r).toMatchObject({ declared: true, healthy: true, seeded: true });
    expect(r.components).toEqual([{ name: "entrada", ok: true }, { name: "estoque", ok: true }]);
    expect(r.detail).toBeUndefined();
  });

  it("o detalhe lista SÓ os componentes que falharam, pelo nome declarado", async () => {
    const r = await probeQaHealth({ health }, { fetch: byUrl([":7102"]) });
    expect(r.healthy).toBe(false);
    expect(r.detail).toBe('"estoque" não respondeu');
  });

  it("a sonda seeded: 404 = stack de pé mas sem dados; rejeição de fetch nunca lança", async () => {
    const seeded = { url: "http://127.0.0.1:7102/pedidos/amostra-01" };
    const semDados = (async (url: RequestInfo | URL) => new Response("x", { status: String(url).includes("/pedidos/") ? 404 : 200 })) as unknown as typeof fetch;
    const r = await probeQaHealth({ health, seeded }, { fetch: semDados });
    expect(r.seeded).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.detail).toMatch(/seeded/);
    const caiu = await probeQaHealth({ health, seeded }, { fetch: fetchReject() });
    expect(caiu.healthy).toBe(false);
    expect(caiu.components.every((c) => !c.ok)).toBe(true);
  });
});
