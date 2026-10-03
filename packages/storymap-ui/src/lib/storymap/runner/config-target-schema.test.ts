// O ESQUEMA COMPLETO DO ALVO (lote D) carregado como o serviço o carrega: YAML → coerceRunnerSettings.
//
// Dois exemplos, ambos INVENTADOS (uma oficina de bicicletas; nada de um alvo real):
//   1. o exemplo COMENTADO de storymap/settings.yaml (a documentação), extraído por marcadores e descomentado — se a forma
//      de uma chave mudar e o exemplo não, esta suíte quebra: a documentação não envelhece em silêncio;
//   2. uma hostil, para provar que o carregamento inteiro NÃO cai e que o resto do bloco segue.
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coerceRunnerSettings, readFileSettings, stagingBootRefusal } from "./config";

// O arquivo de settings que `readFileSettings` lê, trocável por caso (o resto do módulo `paths` fica intacto).
const settingsFile = vi.hoisted(() => ({ path: "" }));
vi.mock("../paths", async (importOriginal) => ({ ...(await importOriginal<typeof import("../paths")>()), settingsPath: () => settingsFile.path }));
import { deployPolicyOf } from "../deploy-policy";
import { currencyOf, layoutOf, qaOf, reviewLensesOf } from "../target-profile";
import { vpsOf } from "../vps-settings";
import { resolveCurrency } from "../currency";

const here = dirname(fileURLToPath(import.meta.url));

function exemploDoSettings(): string {
  const raw = readFileSync(join(here, "../../../../../../storymap/settings.yaml"), "utf8");
  const [, depois] = raw.split("# >>> exemplo\n");
  const [bloco] = (depois ?? "").split("# <<< exemplo");
  return bloco
    .split("\n")
    .map((l) => l.replace(/^# ?/, ""))
    .join("\n");
}

describe("o exemplo documentado em storymap/settings.yaml carrega SEM nenhum descarte", () => {
  let avisos: string[];
  beforeEach(() => {
    avisos = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void avisos.push(a.map(String).join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  it("todas as chaves sobrevivem à coerção, com a forma esperada", () => {
    const texto = exemploDoSettings();
    expect(texto).toContain("target:");
    const s = coerceRunnerSettings(yaml.load(texto));
    expect(avisos).toEqual([]);

    // target: o perfil clássico + as quatro peças novas
    expect(s.target?.checks).toEqual({
      test: "make test PKG={pkg}",
      testUnit: "make test-unit PKG={pkg}",
      typecheck: "make typecheck",
      validate: "make validate",
    });
    expect(s.target?.dev).toEqual({ up: "make dev PKG={pkg}", down: "make dev-stop" });
    expect(s.target?.docs).toEqual({ conventions: "{package}/CONTRIBUTING.md", testing: "docs/testing.md" });
    expect(currencyOf(s.target)).toEqual({ code: "EUR", locale: "pt-PT" });
    expect(resolveCurrency(s.target, {})).toEqual({ code: "EUR", locale: "pt-PT", source: "target" });
    expect(reviewLensesOf(s.target).map((l) => l.id)).toEqual(["security", "testing", "perf", "general", "design", "brakes"]);
    expect(reviewLensesOf(s.target).find((l) => l.id === "security")?.agent).toBe("lock-reviewer");
    expect(reviewLensesOf(s.target).find((l) => l.id === "brakes")).toMatchObject({ name: "Freios", declared: true, mandatoryWhen: "o diff toca o cabo ou a pinça do freio" });
    expect(layoutOf(s)).toEqual({ workspaces: ["shops/*", "shops/*/web"], packages: ["shops/*"], stagingBranch: "release", codePrefixes: ["shops/"] });
    const qa = qaOf(s.target);
    expect(qa.ports).toEqual([7101, 7102]);
    expect(qa.health.map((h) => h.name)).toEqual(["broker", "store"]);
    expect(qa.seeded?.url).toBe("http://127.0.0.1:7102/docs/sentinel");
    expect(qa.failureClasses).toEqual([
      { pattern: "fakebus[\\s\\S]{0,60}stalled", class: "infra" },
      { pattern: "assertion", class: "test" },
    ]);

    // vps + autorun
    expect(vpsOf(s)).toEqual({ weeklyTokenLimit: 400_000_000, headroomUrl: "http://127.0.0.1:9100" });
    expect(s.autorun.maxBudgetUSD).toEqual({ "harness-do": 20, "harness-review": 12 });
    expect(s.autorun.staging).toMatchObject({ enabled: true, branch: "release", codePrefixes: ["shops/"], declared: { branch: true, codePrefixes: true } });

    // deploy: as chaves antigas e as novas, juntas
    const d = deployPolicyOf(s);
    expect(d).toMatchObject({
      canaryCommand: "node probe.mjs",
      targets: ["storefront", "workshop"],
      launchers: ["taskrun"],
      recipeRunners: ["taskrun"],
      recipes: ["ship-app", "plan-app"],
      legacy: {
        packageRoot: "shops/",
        command: ["taskrun", "--yes", "ship-app", "{target}"],
        plan: ["taskrun", "plan-app", "{target}"],
        scope: ["shops/{target}/"],
        state: "ops/state/{target}.json",
      },
      composedFace: { target: "storefront-site", recipe: "ship-face", manifest: "ops/face.json", command: ["taskrun", "--yes", "ship-face"] },
      proof: { record: { securityReview: ["recorder", "verdict", "{file}"], ownerApproval: ["recorder", "approve", "{file}"] }, staleMarkers: ["outro assunto"] },
    });
  });
});

describe("um settings hostil e parcial não derruba o resto", () => {
  beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  const HOSTIL = `
autorun:
  maxConcurrent: 2
  staging: { enabled: false }
target:
  checks: { test: "make test", "ruim nome": "x" }
  currency: { code: xxq }
  layout: { workspaces: ["a/**"] }
  qa: { ports: [0], health: [{ name: x, url: "http://evil.example:80/" }], failureClasses: [{ pattern: "(a+)+", class: infra }] }
  reviewLenses: { "Bad Id": { name: n, description: d } }
vps: { weeklyTokenLimit: lots, headroomUrl: "http://elsewhere.example:1" }
deploy:
  targets: [storefront]
  launchers: [bash]
  legacy: { command: "taskrun ship {target}" }
`;

  it("o perfil válido sobrevive e o declarado-inválido some inteiro (nunca meio aplicado)", () => {
    const s = coerceRunnerSettings(yaml.load(HOSTIL));
    expect(s.autorun.maxConcurrent).toBe(2);
    expect(s.target).toEqual({ checks: { test: "make test" }, dev: {}, docs: {} });
    expect(currencyOf(s.target)).toBeUndefined();
    expect(qaOf(s.target).declared).toBe(false);
    expect(layoutOf(s)).toEqual({});
    expect(vpsOf(s)).toEqual({});
    expect(deployPolicyOf(s)).toMatchObject({ targets: ["storefront"], launchers: [], legacy: {} });
  });

  it("um staging sem chave declarada não finge ter declarado nada", () => {
    const s = coerceRunnerSettings(yaml.load(HOSTIL));
    expect(s.autorun.staging?.declared).toBeUndefined();
    expect(layoutOf(s).codePrefixes).toBeUndefined();
  });

  it("staging.codePrefixes NÃO tem default: indeclarado é ausente (≠ [] explícito), e o default do código também não o traz", () => {
    expect(coerceRunnerSettings(yaml.load("autorun: { staging: { enabled: true, branch: integracao } }")).autorun.staging).not.toHaveProperty("codePrefixes");
    expect(coerceRunnerSettings(yaml.load("autorun: { staging: { enabled: true, codePrefixes: [] } }")).autorun.staging?.codePrefixes).toEqual([]);
    expect(coerceRunnerSettings(yaml.load("autorun: { staging: { enabled: true, codePrefixes: [src/, lib/] } }")).autorun.staging?.codePrefixes).toEqual(["src/", "lib/"]);
    // um valor que não é lista é tratado como NÃO declarado (nunca vira «nada é código» por engano)
    expect(coerceRunnerSettings(yaml.load("autorun: { staging: { enabled: true, codePrefixes: src/ } }")).autorun.staging).not.toHaveProperty("codePrefixes");
    expect(coerceRunnerSettings(undefined).autorun.staging).not.toHaveProperty("codePrefixes");
  });

  it("o aviso de descarte sai UMA vez por leitura do arquivo (não duas)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    coerceRunnerSettings(yaml.load(HOSTIL));
    const doTarget = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("settings target:"));
    expect(doTarget).toHaveLength(1);
  });
});

describe("readFileSettings — YAML ilegível continua fail-open, mas avisa", () => {
  afterEach(() => vi.restoreAllMocks());

  it("devolve os defaults e escreve UMA linha por versão do arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-settings-"));
    settingsFile.path = join(dir, "settings.yaml");
    writeFileSync(settingsFile.path, "autorun: { enabled: [unclosed\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ilegiveis = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("ilegível"));

    const a = readFileSettings();
    const b = readFileSettings();
    expect(a.autorun.maxConcurrent).toBe(2); // o default: o fail-open não mudou
    expect(b).toBe(a);
    expect(ilegiveis()).toHaveLength(1);
    expect(ilegiveis()[0]).toMatch(/configuração INTEIRA caiu nos defaults/);

    // uma NOVA versão do arquivo (mtime diferente) avisa de novo
    writeFileSync(settingsFile.path, "autorun: { enabled: [still broken\n");
    utimesSync(settingsFile.path, new Date(), new Date(Date.now() + 5_000));
    readFileSettings();
    expect(ilegiveis()).toHaveLength(2);

    // e voltando a ser legível, carrega normalmente
    writeFileSync(settingsFile.path, "autorun: { maxConcurrent: 7 }\nvps: { weeklyTokenLimit: 1000 }\n");
    utimesSync(settingsFile.path, new Date(), new Date(Date.now() + 10_000));
    expect(readFileSettings().autorun.maxConcurrent).toBe(7);
    expect(readFileSettings().vps).toEqual({ weeklyTokenLimit: 1000 });
  });
});


describe("o settings.yaml da PRÓPRIA ferramenta declara o que a ferramenta não supõe", () => {
  // Sem estas declarações o merge train da ferramenta congelaria (gate recusando todo delta fora do mapa de pacotes) ou nem
  // subiria (staging ligado sem régua de código). Lê o arquivo REAL do repositório, como o serviço lê.
  const real = () => coerceRunnerSettings(yaml.load(readFileSync(join(here, "../../../../../../storymap/settings.yaml"), "utf8")));

  it("mergeGate.scope.fallback: o delta com código fora do mapa cai na suíte do pacote da ferramenta, não numa recusa", () => {
    const scope = real().autorun.mergeGate?.scope;
    expect(scope?.fallback).toMatchObject({ cwd: "packages/storymap-ui", command: "vitest run" });
  });

  it("staging ligado COM a régua de código declarada: o boot não recusa", () => {
    const st = real().autorun.staging;
    expect(st?.enabled).toBe(true);
    expect(st?.codePrefixes?.length ?? 0).toBeGreaterThan(0);
    expect(stagingBootRefusal(st)).toBeNull();
  });
});

describe("o train recusa subir com o staging ligado e a régua de código indeclarada (recusa de boot)", () => {
  afterEach(() => vi.restoreAllMocks());
  const KEY = Symbol.for("storymap.runner.mergeQueue");
  const comArquivo = (conteudo: string, deslocamento: number) => {
    const dir = mkdtempSync(join(tmpdir(), "ah-staging-"));
    settingsFile.path = join(dir, "settings.yaml");
    writeFileSync(settingsFile.path, conteudo);
    utimesSync(settingsFile.path, new Date(), new Date(Date.now() + deslocamento));
  };

  it("getMergeQueue LANÇA nomeando autorun.staging.codePrefixes quando o arquivo liga o staging sem declará-lo", async () => {
    delete (globalThis as Record<symbol, unknown>)[KEY];
    comArquivo("autorun: { staging: { enabled: true, branch: stage } }\n", 20_000);
    const { getMergeQueue } = await import("./merge-queue");
    expect(() => getMergeQueue()).toThrow(/autorun\.staging\.codePrefixes/);
    // e nada ficou memorizado: depois de declarar, o train sobe
    expect((globalThis as Record<symbol, unknown>)[KEY]).toBeUndefined();
  });

  it("com a régua declarada (ou o staging desligado) a recusa não se aplica", async () => {
    // Outra falha de montagem do train (p.ex. um host sem o CLI do Claude) não é o assunto aqui: só a frase da recusa.
    const recusa = (): string => {
      try {
        getMergeQueue();
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    delete (globalThis as Record<symbol, unknown>)[KEY];
    comArquivo("autorun: { staging: { enabled: true, codePrefixes: [src/] } }\n", 30_000);
    const { getMergeQueue } = await import("./merge-queue");
    expect(recusa()).not.toMatch(/codePrefixes/);
    delete (globalThis as Record<symbol, unknown>)[KEY];
    comArquivo("autorun: { staging: { enabled: true, codePrefixes: [] } }\n", 35_000);
    expect(recusa()).not.toMatch(/codePrefixes/);
    delete (globalThis as Record<symbol, unknown>)[KEY];
    comArquivo("autorun: { staging: { enabled: false } }\n", 40_000);
    expect(recusa()).not.toMatch(/codePrefixes/);
    delete (globalThis as Record<symbol, unknown>)[KEY];
  });
});
