import { describe, expect, it } from "vitest";
import { normalizeUnitSpec, resolveDataUnits, resolveGateUnits, unitAcceptsAffected, unitReporter, type GateScopeSpec, type GateUnit } from "./gate-scope";

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
      ["packages/entreposto/x.ts", "packages/acmeapp/y.ts"],
      FALLBACK,
      spec({ "packages/acmeapp": "bun test", "packages/entreposto": "vitest run" }),
    );
    expect(d.units.map((u) => u.cwd)).toEqual(["packages/acmeapp", "packages/entreposto"]);
  });

  it("pacote configurado NÃO tocado não entra", () => {
    const d = resolveGateUnits(["packages/acmeapp/a.ts"], FALLBACK, spec({ "packages/acmeapp": "bun test", "packages/entreposto": "vitest run" }));
    expect(d.units).toHaveLength(1);
  });

  it("um arquivo FORA de todo pacote mapeado puxa o fallback junto (fail-safe do D15)", () => {
    const d = resolveGateUnits(
      ["packages/acmeapp/a.ts", "scripts/gen/build.mjs"],
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

describe("resolveGateUnits — a unidade DECLARA como é medida (gate honesto)", () => {
  it("a string legada continua sendo uma unidade vitest com o comando dado (byte-equivalente)", () => {
    const d = resolveGateUnits(["packages/acmeapp/a.ts"], FALLBACK, spec({ "packages/acmeapp": "bun test" }));
    expect(d.units).toEqual([{ cwd: "packages/acmeapp", command: "bun test", label: "packages/acmeapp" }]);
    expect(unitReporter(d.units[0])).toBe("vitest-json");
    expect(unitAcceptsAffected(d.units[0])).toBe(true);
  });

  it("a unidade-objeto carrega reporter, junitPath, network e cwd até o runner", () => {
    const d = resolveGateUnits(["services/api/app.py"], FALLBACK, {
      packages: {
        "services/api": { command: "pytest -q --junitxml=.gate/junit.xml", reporter: "junit-xml", junitPath: ".gate/junit.xml", network: "allow" },
      },
    });
    expect(d.units).toEqual([
      {
        cwd: "services/api",
        command: "pytest -q --junitxml=.gate/junit.xml",
        label: "services/api",
        reporter: "junit-xml",
        junitPath: ".gate/junit.xml",
        network: "allow",
      },
    ]);
    // junit nunca aceita seleção por afetados: o gate não sabe derivar "o que o delta afeta" num pytest
    expect(unitAcceptsAffected(d.units[0])).toBe(false);
  });

  it("uma unidade vitest pode RECUSAR a seleção por afetados", () => {
    expect(unitAcceptsAffected({ reporter: "vitest-json", affected: false })).toBe(false);
    expect(unitAcceptsAffected({ reporter: "exit-code" })).toBe(false);
    expect(unitAcceptsAffected({})).toBe(true);
  });

  it("`units` aceita prefixos FORA de packages/ (checks/layout), com cwd próprio", () => {
    const d = resolveGateUnits(["checks/layout/rules.test.ts"], FALLBACK, {
      units: { "checks/layout": { command: "bunx vitest run --config checks/layout/vitest.config.ts", cwd: "." } },
    });
    expect(d.units.map((u) => [u.label, u.cwd])).toEqual([["checks/layout", "."]]);
  });

  it("um GATILHO dispara a unidade sem ela ser dona do caminho — e o arquivo continua puxando o fallback (regra 3)", () => {
    const d = resolveGateUnits(["apps/biblioteca/ui/Catalogo.tsx"], FALLBACK, {
      units: {
        "checks/layout": { command: "bunx vitest run --config checks/layout/vitest.config.ts", cwd: ".", triggers: ["apps/*/ui/**"] },
      },
    });
    expect(d.units.map((u) => u.label)).toEqual(["checks/layout", FALLBACK.label]);
    expect(d.reason).toContain("gatilho apps/*/ui/**");
    expect(d.reason).toContain("fora do mapa");
  });

  it("[NÃO-VACUIDADE] sem o arquivo casado, o gatilho NÃO dispara", () => {
    const d = resolveGateUnits(["apps/biblioteca/api/emprestimo.ts"], FALLBACK, {
      packages: { "apps/biblioteca/api": "bunx vitest run" },
      units: { "checks/layout": { command: "lint", cwd: ".", triggers: ["apps/*/ui/**"] } },
    });
    expect(d.units.map((u) => u.label)).toEqual(["apps/biblioteca/api"]);
  });

  it("ordem determinística: packages, depois units — e o teto conta as unidades disparadas por gatilho", () => {
    const d = resolveGateUnits(["apps/b/ui/x.tsx", "apps/a/y.ts"], FALLBACK, {
      packages: { "apps/a": "t", "apps/b": "t" },
      units: { "checks/layout": { command: "lint", cwd: ".", triggers: ["apps/*/ui/**"] } },
      maxUnits: 2,
    });
    expect(d.units).toEqual([FALLBACK]);
    expect(d.reason).toContain("acima do teto");
  });

  it("uma entrada sem comando é ignorada (não vira unidade vazia)", () => {
    const d = resolveGateUnits(["packages/acmeapp/a.ts"], FALLBACK, {
      packages: { "packages/acmeapp": "   ", "packages/other": { command: "" } as never },
    });
    expect(d.units).toEqual([FALLBACK]);
    expect(normalizeUnitSpec("  ")).toBeNull();
  });
});

describe("resolveDataUnits — a metade que aterrissa em main, medida pelo que o operador DECLAROU", () => {
  const DATA = {
    "content/build": { command: "bunx vitest run content/build/__tests__", cwd: "." },
    "ci/checks": { command: "node --test", reporter: "junit-xml" as const, junitPath: "report.xml" },
    Makefile: { command: "make -n all", reporter: "exit-code" as const, cwd: "." },
  };

  it("sem declaração, ou sem prefixo declarado no delta: NENHUMA unidade — o board-data segue como hoje", () => {
    expect(resolveDataUnits(["content/build/a.js"], undefined).units).toEqual([]);
    expect(resolveDataUnits(["storymap/boards/x/cards/c.md", "docs/a.md", "ops/other/z.sh"], DATA).units).toEqual([]);
  });

  it("SEM fallback: um arquivo fora do mapa não puxa suíte nenhuma (senão todo board-data rodaria uma)", () => {
    const d = resolveDataUnits(["ci/checks/x.mjs", "storymap/boards/x/cards/c.md"], DATA);
    expect(d.units.map((u) => u.label)).toEqual(["ci/checks"]);
  });

  it("casa por PREFIXO de diretório e por arquivo exato; na ordem do MAPA, com a forma declarada", () => {
    const d = resolveDataUnits(["Makefile", "content/build/lib/x.js", "ci/checks/y.mjs"], DATA);
    expect(d.units.map((u) => [u.label, u.cwd, u.reporter ?? "vitest-json"])).toEqual([
      ["content/build", ".", "vitest-json"],
      ["ci/checks", "ci/checks", "junit-xml"],
      ["Makefile", ".", "exit-code"],
    ]);
    // `content/builder` NÃO está sob `content/build`
    expect(resolveDataUnits(["content/builder/a.js"], DATA).units).toEqual([]);
  });

  it("um gatilho declarado também dispara — e o motivo diz qual", () => {
    const d = resolveDataUnits(["content/site.config.json"], {
      "content/build": { command: "bunx vitest run", triggers: ["content/site.*"] },
    });
    expect(d.units.map((u) => u.label)).toEqual(["content/build"]);
    expect(d.reason).toContain("gatilho content/site.*");
  });

  it("a string solta é a unidade legada (vitest-json); uma entrada sem comando é ignorada", () => {
    const d = resolveDataUnits(["ops/gc/a.mjs", "ci/checks/b.mjs"], { "ops/gc": "bunx vitest run", "ci/checks": "  " });
    expect(d.units).toEqual([{ cwd: "ops/gc", command: "bunx vitest run", label: "ops/gc" }]);
  });
});
