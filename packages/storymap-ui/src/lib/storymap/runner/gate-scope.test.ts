import { describe, expect, it } from "vitest";
import { resolveGateUnits, type GateScopeSpec, type GateUnit } from "./gate-scope";

const FALLBACK: GateUnit = { cwd: "packages/storymap-ui", command: "vitest run", label: "packages/storymap-ui" };

const spec = (packages: Record<string, string>, maxUnits?: number): GateScopeSpec => ({ packages, maxUnits });

describe("resolveGateUnits — o escopo ACOMPANHA o delta, nunca o enfraquece", () => {
  it("sem config: tudo cai no fallback — byte-equivalente ao comportamento de hoje", () => {
    const d = resolveGateUnits(["packages/acmeapp/src/a.ts"], FALLBACK, undefined);
    expect(d.units).toEqual([FALLBACK]);
    expect(d.reason).toContain("não configurado");
  });

  it("delta vazio: fallback", () => {
    const d = resolveGateUnits([], FALLBACK, spec({ "packages/acmeapp": "bun test" }));
    expect(d.units).toEqual([FALLBACK]);
  });

  it("um pacote configurado tocado: roda a suíte DELE, não a do harness", () => {
    const d = resolveGateUnits(
      ["packages/acmeapp/src/a.ts", "packages/acmeapp/src/b.ts"],
      FALLBACK,
      spec({ "packages/acmeapp": "bun test" }),
    );
    expect(d.units).toEqual([{ cwd: "packages/acmeapp", command: "bun test", label: "packages/acmeapp" }]);
  });

  it("dois pacotes configurados: uma unidade cada, na ordem determinística do MAPA", () => {
    const d = resolveGateUnits(
      ["packages/nimbus/x.ts", "packages/acmeapp/y.ts"],
      FALLBACK,
      spec({ "packages/acmeapp": "bun test", "packages/nimbus": "vitest run" }),
    );
    expect(d.units.map((u) => u.cwd)).toEqual(["packages/acmeapp", "packages/nimbus"]);
  });

  it("pacote configurado NÃO tocado não entra", () => {
    const d = resolveGateUnits(["packages/acmeapp/a.ts"], FALLBACK, spec({ "packages/acmeapp": "bun test", "packages/nimbus": "vitest run" }));
    expect(d.units).toHaveLength(1);
  });

  it("um arquivo FORA de todo pacote mapeado puxa o fallback junto (fail-safe do D15)", () => {
    const d = resolveGateUnits(
      ["packages/acmeapp/a.ts", "scripts/deploy/build.mjs"],
      FALLBACK,
      spec({ "packages/acmeapp": "bun test" }),
    );
    expect(d.units.map((u) => u.cwd)).toEqual(["packages/acmeapp", "packages/storymap-ui"]);
    expect(d.reason).toContain("fora do mapa");
  });

  it("o fallback não é duplicado quando ele mesmo é um pacote mapeado e tocado", () => {
    const d = resolveGateUnits(
      ["packages/storymap-ui/a.ts", "README.md"],
      FALLBACK,
      spec({ "packages/storymap-ui": "vitest run" }),
    );
    expect(d.units).toHaveLength(1);
    expect(d.units[0].cwd).toBe("packages/storymap-ui");
  });

  it("acima do teto de unidades, COLAPSA no fallback e diz por quê — o slot serial não se multiplica", () => {
    const d = resolveGateUnits(
      ["packages/a/x", "packages/b/x", "packages/c/x", "packages/d/x"],
      FALLBACK,
      spec({ "packages/a": "t", "packages/b": "t", "packages/c": "t", "packages/d": "t" }, 3),
    );
    expect(d.units).toEqual([FALLBACK]);
    expect(d.reason).toContain("acima do teto");
  });

  it("casa por prefixo de diretório, não por substring — `packages/acme` não reivindica `packages/acmeapp`", () => {
    const d = resolveGateUnits(["packages/acmeapp/a.ts"], FALLBACK, spec({ "packages/acme": "bun test" }));
    expect(d.units).toEqual([FALLBACK]);
  });

  it("uma barra final na chave do mapa não muda o casamento", () => {
    const d = resolveGateUnits(["packages/acmeapp/a.ts"], FALLBACK, spec({ "packages/acmeapp/": "bun test" }));
    expect(d.units[0].cwd).toBe("packages/acmeapp/");
  });
});
