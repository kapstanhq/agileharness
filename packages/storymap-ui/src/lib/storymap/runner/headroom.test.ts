import { beforeEach, describe, expect, it } from "vitest";
import {
  HEADROOM_SUGGESTED_URL,
  applyHeadroomEnv,
  buildAgentSpawnEnv,
  headroomUrlIfKnownAlive,
  probeHeadroom,
  probeHeadroomCached,
  resetHeadroomProbeCache,
  resolveHeadroomUrl,
} from "./headroom";

beforeEach(() => resetHeadroomProbeCache());

describe("resolveHeadroomUrl — declarado, nunca assumido (auditoria de extração, 2026-08-19)", () => {
  it("[ATAQUE] sem declaração NENHUMA, o tráfego vai DIRETO — não para um endereço embutido", () => {
    // O defeito que este caso fecha: o default era `127.0.0.1:8787`, a porta do sidecar da máquina
    // onde a ferramenta nasceu, que não viaja com ela. Na máquina de quem instala, esse endereço ou
    // não responde (fail-open cobre) ou responde POR SER OUTRA COISA — e a sonda considera vivo
    // qualquer resposta que não seja erro de rede. Todo o tráfego de LLM dos agentes atravessaria um
    // serviço de terceiro, em silêncio. Um endereço de loopback não é identidade.
    expect(resolveHeadroomUrl(undefined, {})).toBeNull();
    expect(resolveHeadroomUrl(null, {})).toBeNull();
    expect(resolveHeadroomUrl({ headroom: undefined }, {})).toBeNull();
  });

  it("a URL sugerida continua exportada — como sugestão de documentação, não como caminho tomado", () => {
    // A constante existe para o `.env.example` e para os testes; nenhuma decisão a escolhe sozinha.
    expect(HEADROOM_SUGGESTED_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(resolveHeadroomUrl(undefined, {})).not.toBe(HEADROOM_SUGGESTED_URL);
  });

  it("board com enabled:false é o opt-out declarativo", () => {
    expect(resolveHeadroomUrl({ headroom: { enabled: false, proxyUrl: "http://x" } }, {})).toBeNull();
  });

  it("usa o proxyUrl do board quando ele fixa um alvo", () => {
    expect(resolveHeadroomUrl({ headroom: { enabled: true, proxyUrl: "http://host:9000" } }, {})).toBe("http://host:9000");
  });

  it("board que LIGA mas não nomeia URL não vira endereço nenhum — ligar não é declarar", () => {
    expect(resolveHeadroomUrl({ headroom: { enabled: true, proxyUrl: "" } }, {})).toBeNull();
  });

  it("ENV STORYMAP_HEADROOM_URL vence qualquer config de board", () => {
    expect(
      resolveHeadroomUrl(
        { headroom: { enabled: true, proxyUrl: "http://from-board" } },
        { STORYMAP_HEADROOM_URL: "http://from-env" },
      ),
    ).toBe("http://from-env");
  });

  it("ENV off/0/false desliga — inclusive contra o default", () => {
    for (const off of ["off", "0", "false", "none", "disabled", "OFF"]) {
      expect(resolveHeadroomUrl({ headroom: { enabled: true, proxyUrl: "http://b" } }, { STORYMAP_HEADROOM_URL: off })).toBeNull();
      expect(resolveHeadroomUrl(null, { STORYMAP_HEADROOM_URL: off })).toBeNull();
    }
  });
});

describe("probeHeadroom", () => {
  it("returns true when fetch resolves with any response", async () => {
    const fakeFetch = (async () => new Response("ok")) as unknown as typeof fetch;
    expect(await probeHeadroom("http://x", 50, fakeFetch)).toBe(true);
  });

  it("returns false when fetch throws", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeHeadroom("http://x", 50, fakeFetch)).toBe(false);
  });

  it("returns false when the request times out", async () => {
    const fakeFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await probeHeadroom("http://x", 10, fakeFetch)).toBe(false);
  });
});

describe("probeHeadroomCached — uma rajada de spawns paga UMA sonda", () => {
  it("memoiza dentro da janela e re-sonda depois dela", async () => {
    let calls = 0;
    const probe = (async () => {
      calls++;
      return true;
    }) as unknown as typeof probeHeadroom;
    let clock = 1_000;
    const now = () => clock;

    await Promise.all([
      probeHeadroomCached("http://p", { probe, now, ttlMs: 100 }),
      probeHeadroomCached("http://p", { probe, now, ttlMs: 100 }),
      probeHeadroomCached("http://p", { probe, now, ttlMs: 100 }),
    ]);
    expect(calls).toBe(1);

    clock += 101;
    await probeHeadroomCached("http://p", { probe, now, ttlMs: 100 });
    expect(calls).toBe(2);
  });

  it("uma sonda que estoura vira false, nunca uma rejeição em cache", async () => {
    const probe = (async () => {
      throw new Error("boom");
    }) as unknown as typeof probeHeadroom;
    await expect(probeHeadroomCached("http://p", { probe })).resolves.toBe(false);
  });
});

describe("applyHeadroomEnv — fail-open é contrato", () => {
  it("injeta ANTHROPIC_BASE_URL quando o proxy responde", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const probe = (async () => true) as unknown as typeof probeHeadroom;
    const r = await applyHeadroomEnv(env, { url: "http://p", probe });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://p");
    expect(r).toEqual({ applied: true, url: "http://p" });
  });

  it("NÃO injeta quando o proxy está fora do ar — o filho vai direto", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const probe = (async () => false) as unknown as typeof probeHeadroom;
    const r = await applyHeadroomEnv(env, { url: "http://p", probe });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(r).toEqual({ applied: false, url: "http://p" });
  });

  it("url null (opt-out) não sonda nem injeta", async () => {
    const env = {} as NodeJS.ProcessEnv;
    let probed = false;
    const probe = (async () => {
      probed = true;
      return true;
    }) as unknown as typeof probeHeadroom;
    const r = await applyHeadroomEnv(env, { url: null, probe });
    expect(probed).toBe(false);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(r).toEqual({ applied: false, url: null });
  });
});

describe("headroomUrlIfKnownAlive — o espelho síncrono do spawn site que não pode await", () => {
  it("é null antes de qualquer sonda (não sei ⇒ vai direto)", () => {
    expect(headroomUrlIfKnownAlive("http://p")).toBeNull();
  });

  it("devolve a URL depois de uma sonda que a viu viva, e null quando morta", async () => {
    const alive = (async () => true) as unknown as typeof probeHeadroom;
    await probeHeadroomCached("http://p", { probe: alive });
    expect(headroomUrlIfKnownAlive("http://p")).toBe("http://p");

    resetHeadroomProbeCache();
    const dead = (async () => false) as unknown as typeof probeHeadroom;
    await probeHeadroomCached("http://p", { probe: dead });
    expect(headroomUrlIfKnownAlive("http://p")).toBeNull();
  });

  it("um desfecho velho expira — nunca roteia com base em informação vencida", async () => {
    const alive = (async () => true) as unknown as typeof probeHeadroom;
    await probeHeadroomCached("http://p", { probe: alive, now: () => 1_000 });
    expect(headroomUrlIfKnownAlive("http://p", { now: () => 1_050, ttlMs: 100 })).toBe("http://p");
    expect(headroomUrlIfKnownAlive("http://p", { now: () => 5_000, ttlMs: 100 })).toBeNull();
  });
});

describe("buildAgentSpawnEnv — o chokepoint: higiene ⊕ headroom", () => {
  it("sanea o env do serviço E roteia, num passo só", async () => {
    const probe = (async () => true) as unknown as typeof probeHeadroom;
    const env = await buildAgentSpawnEnv(
      { PATH: "/repo/node_modules/.bin:/usr/bin", __NEXT_PROCESSED_ENV: "true", NODE_ENV: "production", FOO: "bar" } as NodeJS.ProcessEnv,
      { url: "http://p", probe },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://p");
    expect(env.__NEXT_PROCESSED_ENV).toBeUndefined(); // higiene de sanitizeSpawnEnv preservada
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
  });

  it("proxy morto ⇒ env saneado sem roteamento (o spawn acontece igual)", async () => {
    const probe = (async () => false) as unknown as typeof probeHeadroom;
    const env = await buildAgentSpawnEnv({ FOO: "bar" } as unknown as NodeJS.ProcessEnv, { url: "http://p", probe });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.FOO).toBe("bar");
  });
});
