import { describe, expect, it } from "vitest";
import { coerceHeadroom } from "./repo";
import { resolveHeadroomUrl } from "./runner/headroom";

// `headroom:` do board: a URL é declarada, nunca suposta. Portas inventadas (7111).
describe("coerceHeadroom — enabled sem proxyUrl não inventa a porta de nenhum sidecar", () => {
  it("enabled: true SEM proxyUrl: tráfego direto, e UM aviso diz o que declarar", () => {
    const avisos: string[] = [];
    const cfg = coerceHeadroom({ enabled: true }, (m) => avisos.push(m));
    expect(cfg).toEqual({ enabled: true, proxyUrl: "" });
    expect(resolveHeadroomUrl({ headroom: cfg }, {})).toBeNull();
    // o aviso é UMA vez por processo (a config do board é relida o tempo todo)
    coerceHeadroom({ enabled: true }, (m) => avisos.push(m));
    expect(avisos.length).toBeLessThanOrEqual(1);
    if (avisos.length) expect(avisos[0]).toMatch(/headroom\.proxyUrl/);
  });

  it("com proxyUrl declarado usa o declarado, como veio", () => {
    const cfg = coerceHeadroom({ enabled: true, proxyUrl: " http://127.0.0.1:7111 " }, () => {});
    expect(cfg).toEqual({ enabled: true, proxyUrl: "http://127.0.0.1:7111" });
    expect(resolveHeadroomUrl({ headroom: cfg }, {})).toBe("http://127.0.0.1:7111");
  });

  it("enabled: false é o opt-out; ausente = nada (tráfego direto)", () => {
    expect(resolveHeadroomUrl({ headroom: coerceHeadroom({ enabled: false, proxyUrl: "http://127.0.0.1:7111" }, () => {}) }, {})).toBeNull();
    expect(coerceHeadroom(undefined, () => {})).toBeUndefined();
    expect(coerceHeadroom("lixo", () => {})).toBeUndefined();
  });
});
