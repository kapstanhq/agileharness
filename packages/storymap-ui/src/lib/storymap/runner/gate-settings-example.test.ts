// O EXEMPLO PUBLICADO do gate por unidade (storymap/settings.yaml, comentado) é CONTRATO: quem adota copia e
// descomenta. Um exemplo que não parseia, ou que o coerce derruba em silêncio, ensina o formato errado — a
// mesma classe de mentira de configuração que `config-dead-knobs.test.ts` guarda para as chaves vivas.
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { settingsPath } from "@/lib/storymap/paths";
import { coerceGateScope } from "./config";
import { resolveGateUnits, unitAcceptsAffected, unitReporter } from "./gate-scope";

/** O bloco `# scope:` comentado do mergeGate, descomentado. */
function exemploComentado(): unknown {
  const linhas = readFileSync(settingsPath(), "utf8").split("\n");
  const ini = linhas.findIndex((l) => /^\s*# scope:\s*$/.test(l));
  expect(ini, "o settings.yaml publicado perdeu o exemplo `# scope:` do gate por unidade").toBeGreaterThan(-1);
  const indent = linhas[ini].indexOf("#");
  const bloco: string[] = [];
  for (let i = ini; i < linhas.length; i++) {
    const l = linhas[i];
    if (l.trim() === "#") break; // a linha "#" vazia fecha o exemplo
    if (!l.slice(indent).startsWith("#")) break;
    bloco.push(l.slice(indent + 2));
  }
  return yaml.load(bloco.join("\n"));
}

describe("o exemplo monorepo do settings.yaml publicado — parseia e chega ao motor inteiro", () => {
  const scope = coerceGateScope((exemploComentado() as { scope: Record<string, unknown> }).scope);

  it("as quatro unidades sobrevivem ao coerce, cada uma com o reporter que declara", () => {
    expect(Object.keys(scope.packages ?? {})).toEqual(["packages/shop/web", "packages/shop/api", "services/recommender"]);
    expect(Object.keys(scope.units ?? {})).toEqual(["tests/architecture"]);
    expect(scope.packages?.["services/recommender"]).toMatchObject({ reporter: "junit-xml", junitPath: ".gate/junit.xml", network: "deny" });
    expect(scope.fallback).toMatchObject({ cwd: "packages/shared" });
  });

  it("uma mudança num web dispara a unidade do web E o lint de arquitetura (gatilho), na ordem do mapa", () => {
    const fallback = { cwd: "packages/shared", command: "bunx vitest run", label: "packages/shared" };
    const d = resolveGateUnits(["packages/shop/web/src/Cart.tsx"], fallback, scope);
    expect(d.units.map((u) => u.label)).toEqual(["packages/shop/web", "tests/architecture"]);
    const arch = d.units.find((u) => u.label === "tests/architecture")!;
    expect(arch.cwd).toBe(".");
  });

  it("a unidade pytest nunca aceita seleção por afetados; a vitest com config própria aceita", () => {
    const fallback = { cwd: "packages/shared", command: "x", label: "packages/shared" };
    const d = resolveGateUnits(["services/recommender/app.py", "packages/shop/api/src/a.ts"], fallback, scope);
    const py = d.units.find((u) => u.label === "services/recommender")!;
    const api = d.units.find((u) => u.label === "packages/shop/api")!;
    expect(unitReporter(py)).toBe("junit-xml");
    expect(unitAcceptsAffected(py)).toBe(false);
    expect(api.command).toBe("bunx vitest run --config vitest.unit.config.ts");
    expect(unitAcceptsAffected(api)).toBe(true);
  });
});
