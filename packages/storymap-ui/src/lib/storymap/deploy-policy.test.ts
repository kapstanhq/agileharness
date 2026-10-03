// A política de deploy DECLARADA: forma das chaves novas do bloco `deploy:` e a resolução «não declarado = vazio».
import { describe, expect, it, vi } from "vitest";
import { coerceArgvTemplate, coerceDeployPolicy, deployPolicyOf, expandArgvTemplate, expandPathTemplate } from "./deploy-policy";
import { coerceRunnerSettings } from "./runner/config";

const warns = () => {
  const lines: string[] = [];
  return { lines, warn: (m: string) => lines.push(m) };
};

describe("coerceArgvTemplate — comando só como lista de palavras", () => {
  it("aceita um argv com o placeholder permitido", () => {
    const { warn, lines } = warns();
    expect(coerceArgvTemplate(["shipit", "--yes", "publish", "{target}"], ["target"], "deploy.legacy.command", warn)).toEqual(["shipit", "--yes", "publish", "{target}"]);
    expect(lines).toEqual([]);
  });

  it("descarta o comando inteiro (com aviso) em vez de aceitá-lo pela metade", () => {
    const bad: unknown[] = [
      "shipit publish {target}", // texto, não lista
      [],
      ["./shipit", "x"], // primeira palavra com `/`
      ["shipit", "{pkg}"], // placeholder desconhecido
      ["shipit", "{file}"], // placeholder de outro tipo
      ["shipit", "a\nb"], // controle
      ["shipit", ""],
      ["shipit", 3],
      ["shipit", "x".repeat(201)],
      Array.from({ length: 33 }, () => "w"),
    ];
    for (const raw of bad) {
      const { warn, lines } = warns();
      expect(coerceArgvTemplate(raw, ["target"], "deploy.legacy.command", warn)).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("deploy.legacy.command");
      expect(lines[0]).not.toContain("\n");
    }
  });

  it("`required` exige o placeholder (uma prova sem {file} não prova nada)", () => {
    const { warn } = warns();
    expect(coerceArgvTemplate(["recorder", "x"], ["file"], "p", warn, ["file"])).toBeUndefined();
    expect(coerceArgvTemplate(["recorder", "{file}"], ["file"], "p", warn, ["file"])).toEqual(["recorder", "{file}"]);
  });

  it("ausente não é erro nem aviso", () => {
    const { warn, lines } = warns();
    expect(coerceArgvTemplate(undefined, ["target"], "p", warn)).toBeUndefined();
    expect(lines).toEqual([]);
  });
});

describe("coerceDeployPolicy — as chaves novas do bloco `deploy:`", () => {
  const FULL = {
    launchers: ["relay", "shipit", "relay", "bash", "a/b", "", 5],
    recipeRunners: ["shipit", "python3"],
    recipes: ["roll-forward", "warm-cache", "Bad Name", "9x"],
    legacy: {
      packageRoot: "apps",
      command: ["relay", "push", "{target}", "--channel", "beta"],
      plan: ["relay", "diff", "{target}"],
      scope: ["apps/{target}/src/", "../fora/", "/abs/"],
      state: "var/releases/{target}.state",
    },
    proof: {
      record: { securityReview: ["auditlog", "{file}"], ownerApproval: ["auditlog"] },
      staleMarkers: ["superseded", "superseded", "x".repeat(81), ""],
    },
  };

  it("aceita o que tem forma e descarta o resto peça a peça", () => {
    const { warn, lines } = warns();
    expect(coerceDeployPolicy(FULL, warn, {})).toEqual({
      launchers: ["relay", "shipit"],
      recipeRunners: ["shipit"],
      recipes: ["roll-forward", "warm-cache"],
      legacy: {
        packageRoot: "apps/",
        command: ["relay", "push", "{target}", "--channel", "beta"],
        plan: ["relay", "diff", "{target}"],
        scope: ["apps/{target}/src/"],
        state: "var/releases/{target}.state",
      },
      proof: { record: { securityReview: ["auditlog", "{file}"] }, staleMarkers: ["superseded"] },
    });
    const log = lines.join("\n");
    expect(log).toMatch(/deploy\.launchers: 4 item/); // "bash", "a/b", "" e 5
    expect(log).toMatch(/deploy\.recipeRunners/);
    expect(log).toMatch(/deploy\.recipes/);
    expect(log).toMatch(/deploy\.proof\.record\.ownerApproval/);
  });

  it("um lançador que é shell/interpretador NUNCA entra, nem vindo do operador", () => {
    const { warn } = warns();
    expect(coerceDeployPolicy({ launchers: ["bash", "node", "env", "sudo", "python3"] }, warn)).toEqual({});
  });

  it("AVISO ALTO: lançador que é task runner CONHECIDO e não está em recipeRunners perde a régua da cadeia receita→argumento", () => {
    for (const runner of ["just", "task", "mise", "rake", "mask"]) {
      const { warn, lines } = warns();
      expect(coerceDeployPolicy({ launchers: [runner], recipes: ["ship-app"] }, warn, {})).toEqual({ launchers: [runner], recipes: ["ship-app"] });
      expect(lines, runner).toHaveLength(1);
      expect(lines[0]).toContain(`\`${runner}\` é um task runner conhecido`);
      expect(lines[0]).toContain(`deploy.recipeRunners: [${runner}]`);
      expect(lines[0]).not.toContain("\n");
    }
  });

  it("sem aviso quando o task runner JÁ está em recipeRunners (settings) ou no env aditivo; nem para lançador comum", () => {
    const a = warns();
    coerceDeployPolicy({ launchers: ["just"], recipeRunners: ["just"] }, a.warn, {});
    expect(a.lines).toEqual([]);
    const b = warns();
    coerceDeployPolicy({ launchers: ["just"] }, b.warn, { AGILEHARNESS_DEPLOY_RECIPE_RUNNERS: "just" });
    expect(b.lines).toEqual([]);
    const c = warns();
    coerceDeployPolicy({ launchers: ["shipit", "taskrun"] }, c.warn, {});
    expect(c.lines).toEqual([]);
  });

  it("o lançador que vem SÓ do env aditivo também é medido (o buraco é o mesmo)", () => {
    const { warn, lines } = warns();
    coerceDeployPolicy({}, warn, { AGILEHARNESS_DEPLOY_LAUNCHERS: "just shipit" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("`just`");
  });

  it("sem nada declarado é {} e não avisa", () => {
    const { warn, lines } = warns();
    expect(coerceDeployPolicy({}, warn)).toEqual({});
    expect(coerceDeployPolicy({ legacy: null, proof: undefined }, warn)).toEqual({});
    expect(lines).toEqual([]);
  });

  it("estrutura errada (lista onde é mapa, texto onde é lista) descarta a peça e avisa", () => {
    const { warn, lines } = warns();
    expect(coerceDeployPolicy({ launchers: "shipit", legacy: [], proof: "x", recipes: {} }, warn)).toEqual({});
    expect(lines).toHaveLength(4);
  });

  it("caminhos-molde: `..`, raiz absoluta e placeholder estranho caem", () => {
    const { warn } = warns();
    const out = coerceDeployPolicy({ legacy: { state: "../x/{target}.json" } }, warn);
    expect(out).toEqual({});
    expect(coerceDeployPolicy({ legacy: { state: "s/{pkg}.json" } }, warn)).toEqual({});
    expect(coerceDeployPolicy({ legacy: { state: "s/{target.json" } }, warn)).toEqual({});
  });
});

describe("deployPolicyOf — «não declarado» é vazio, nunca o default da origem", () => {
  it("sem declaração tudo é vazio", () => {
    expect(deployPolicyOf(undefined)).toEqual({ launchers: [], recipeRunners: [], recipes: [], targets: [], legacy: {}, proof: { record: {}, staleMarkers: [] } });
    expect(deployPolicyOf({ deploy: {} })).toEqual(deployPolicyOf(undefined));
  });

  it("devolve cópias (mutar o resultado não corrompe a config)", () => {
    const settings = { deploy: { launchers: ["shipit"], targets: ["mainapp"] } };
    deployPolicyOf(settings).launchers.push("x");
    expect(settings.deploy.launchers).toEqual(["shipit"]);
  });

  it("chega pelo coerceRunnerSettings junto com as chaves antigas do bloco", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = coerceRunnerSettings({
      deploy: {
        canaryCommand: "node probe.mjs",
        targets: ["mainapp", "adminapp"],
        composedFace: { target: "storefront", recipe: "ship-face", manifest: "ops/face.json", command: ["taskrun", "ship-face"] },
        launchers: ["taskrun"],
        recipes: ["ship-app"],
        legacy: { command: ["taskrun", "ship-app", "{target}"] },
      },
    });
    const p = deployPolicyOf(s);
    expect(p.targets).toEqual(["mainapp", "adminapp"]);
    expect(p.canaryCommand).toBe("node probe.mjs");
    expect(p.composedFace).toEqual({ target: "storefront", recipe: "ship-face", manifest: "ops/face.json", command: ["taskrun", "ship-face"] });
    expect(p.launchers).toEqual(["taskrun"]);
    expect(p.legacy.command).toEqual(["taskrun", "ship-app", "{target}"]);
    vi.restoreAllMocks();
  });

  it("um composedFace.command inválido derruba só ELE; a face (target/recipe/manifest) segue", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = coerceRunnerSettings({ deploy: { composedFace: { target: "storefront", recipe: "ship-face", manifest: "ops/face.json", command: "taskrun ship-face" } } });
    expect(s.deploy?.composedFace).toEqual({ target: "storefront", recipe: "ship-face", manifest: "ops/face.json" });
    vi.restoreAllMocks();
  });
});

describe("expandArgvTemplate / expandPathTemplate — nunca um comando pela metade", () => {
  it("preenche {target} e {file}", () => {
    expect(expandArgvTemplate(["taskrun", "ship-app", "{target}"], { target: "mainapp" })).toEqual(["taskrun", "ship-app", "mainapp"]);
    expect(expandArgvTemplate(["recorder", "{file}"], { file: "/tmp/run-1/verdict.json" })).toEqual(["recorder", "/tmp/run-1/verdict.json"]);
    expect(expandArgvTemplate(["taskrun", "--out=build/{target}.log"], { target: "mainapp" })).toEqual(["taskrun", "--out=build/mainapp.log"]);
  });

  it("valor ausente ou inseguro ⇒ null", () => {
    expect(expandArgvTemplate(["taskrun", "{target}"], {})).toBeNull();
    expect(expandArgvTemplate(["taskrun", "{target}"], { target: "../x" })).toBeNull();
    expect(expandArgvTemplate(["taskrun", "{target}"], { target: "a b" })).toBeNull();
    expect(expandArgvTemplate(["recorder", "{file}"], { file: "/tmp/../etc/x" })).toBeNull();
    expect(expandArgvTemplate(["recorder", "{file}"], { file: "/tmp/a b" })).toBeNull();
  });

  it("caminho-molde só aceita alvo em forma de slug", () => {
    expect(expandPathTemplate("var/releases/{target}.state", "mainapp")).toBe("var/releases/mainapp.state");
    expect(expandPathTemplate("var/releases/{target}.state", "../x")).toBeNull();
  });
});
