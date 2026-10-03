// O EXEMPLO PUBLICADO do gate por unidade (storymap/settings.yaml, comentado) é CONTRATO: quem adota copia e
// descomenta. Um exemplo que não parseia, ou que o coerce derruba em silêncio, ensina o formato errado — a
// mesma classe de mentira de configuração que `config-dead-knobs.test.ts` guarda para as chaves vivas.
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { settingsPath } from "@/lib/storymap/paths";
import { coerceGateScope, coerceGateUnitMap } from "./config";
import { resolveDataUnits, resolveGateUnits, unitAcceptsAffected, unitReporter } from "./gate-scope";

/** O bloco `# <chave>:` comentado do mergeGate, descomentado. */
function exemploComentado(chave = "scope"): unknown {
  const linhas = readFileSync(settingsPath(), "utf8").split("\n");
  const ini = linhas.findIndex((l) => new RegExp(`^\\s*# ${chave}:\\s*$`).test(l));
  expect(ini, `o settings.yaml publicado perdeu o exemplo \`# ${chave}:\` do gate`).toBeGreaterThan(-1);
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
    expect(Object.keys(scope.packages ?? {})).toEqual(["apps/portal", "libs/pricing", "services/ledger"]);
    expect(Object.keys(scope.units ?? {})).toEqual(["tests/contract"]);
    expect(scope.packages?.["services/ledger"]).toMatchObject({ reporter: "exit-code", network: "allow" });
    expect(scope.units?.["tests/contract"]).toMatchObject({ reporter: "junit-xml", junitPath: ".gate/contract.xml" });
    expect(scope.maxUnits).toBe(5);
    expect(scope.fallback).toMatchObject({ cwd: "libs/core" });
  });

  it("um schema dentro de uma lib dispara a lib E o contrato (gatilho), na ordem do mapa e com o cwd declarado", () => {
    const fallback = { cwd: "libs/core", command: "bunx vitest run", label: "libs/core" };
    const d = resolveGateUnits(["libs/pricing/schema/order.json", "libs/pricing/src/tax.ts"], fallback, scope);
    expect(d.units.map((u) => u.label)).toEqual(["libs/pricing", "tests/contract"]);
    expect(d.units.find((u) => u.label === "libs/pricing")!.cwd).toBe("libs/pricing");
    expect(d.units.find((u) => u.label === "tests/contract")!.cwd).toBe(".");
  });

  it("só o serviço em Go e o app saem do mapa; só o vitest-json aceita seleção por afetados", () => {
    const fallback = { cwd: "libs/core", command: "x", label: "libs/core" };
    const d = resolveGateUnits(["services/ledger/main.go", "apps/portal/src/Cart.tsx"], fallback, scope);
    expect(d.units.map((u) => u.label)).toEqual(["apps/portal", "services/ledger"]);
    const go = d.units.find((u) => u.label === "services/ledger")!;
    const portal = d.units.find((u) => u.label === "apps/portal")!;
    expect(unitReporter(go)).toBe("exit-code");
    expect(go.network).toBe("allow");
    expect(unitAcceptsAffected(go)).toBe(false);
    expect(portal.command).toBe("bunx vitest run");
    expect(unitAcceptsAffected(portal)).toBe(true);
  });

  it("o pacote de tipos compartilhados dispara a lib, mas um arquivo sem dono ainda puxa o fallback", () => {
    const fallback = { cwd: "libs/core", command: "bunx vitest run", label: "libs/core" };
    const d = resolveGateUnits(["libs/shared-types/index.ts"], fallback, scope);
    expect(d.units.map((u) => u.label)).toEqual(["libs/pricing", "libs/core"]);
  });
});

describe("o exemplo de `dataUnits` do settings.yaml publicado — parseia e cada unidade chega ao motor como foi declarada", () => {
  // O teste lê o QUE o exemplo declara (chaves, reporter, cwd) em vez de fixar nomes de unidade: o exemplo é do
  // operador que adota, e renomeá-lo ou enxugá-lo não deve exigir mexer aqui — o contrato é «nenhuma unidade some,
  // nenhuma troca de reporter em silêncio».
  const raw = (exemploComentado("dataUnits") as { dataUnits: Record<string, unknown> }).dataUnits;
  const units = coerceGateUnitMap(raw, "mergeGate.dataUnits");
  const declaredReporter = (key: string) => {
    const entry = raw[key];
    return entry && typeof entry === "object" && "reporter" in entry ? String((entry as { reporter: unknown }).reporter) : "vitest-json";
  };
  // uma chave sem barra é um ARQUIVO da raiz (casa exato); as demais são diretórios (casam por prefixo)
  const probeFor = (key: string) => (key.includes("/") ? `${key}/__probe__.mjs` : key);

  it("nenhuma unidade declarada some no coerce, na ordem do arquivo, cada uma com o reporter que declara", () => {
    expect(Object.keys(raw).length).toBeGreaterThan(0);
    expect(Object.keys(units)).toEqual(Object.keys(raw));
    for (const key of Object.keys(raw)) {
      expect(unitReporter(units[key] as never), key).toBe(declaredReporter(key));
    }
  });

  it("um arquivo sob cada prefixo declarado chega à unidade certa; a seleção por afetados só vale para vitest-json", () => {
    const keys = Object.keys(raw);
    const d = resolveDataUnits([...keys.map(probeFor), "storymap/boards/x/cards/c.md"], units);
    expect(d.units.map((u) => u.label)).toEqual(keys);
    for (const u of d.units) expect(unitAcceptsAffected(u), u.label).toBe(declaredReporter(u.label) === "vitest-json");
    // um card sozinho não dispara unidade nenhuma — o board-data segue sem gate, como hoje
    expect(resolveDataUnits(["storymap/boards/x/cards/c.md"], units).units).toEqual([]);
  });
});
